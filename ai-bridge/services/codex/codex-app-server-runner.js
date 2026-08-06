/**
 * Codex app-server transport (Codex-only).
 *
 * Spawns `codex app-server --stdio` and speaks JSON-RPC to receive true
 * progressive text via `item/agentMessage/delta` notifications.
 *
 * This module is intentionally isolated from Claude/Grok/Kimi channels.
 * Callers map callbacks onto the shared bridge marker protocol
 * ([CONTENT_DELTA], [THREAD_ID], …).
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { getCodexCliEntrypoint } from '../../utils/sdk-loader.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function logDebug(...args) {
  console.error('[DEBUG][CodexAppServer]', ...args);
}

/**
 * @param {object} options
 * @param {string|Array} options.input - string prompt or [{type:'text'|'local_image',...}]
 * @param {string} [options.threadId] - resume existing thread
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.effort] - reasoning effort
 * @param {string} [options.approvalPolicy] - e.g. never | on-request | untrusted
 * @param {string} [options.sandboxMode]
 * @param {object} [options.cliEnv]
 * @param {AbortSignal} [options.signal]
 * @param {(delta: string) => void} [options.onContentDelta]
 * @param {(delta: string) => void} [options.onThinkingDelta]
 * @param {(threadId: string) => void} [options.onThreadId]
 * @param {(msg: object) => void} [options.onMessage]
 * @param {(usage: object) => void} [options.onUsage]
 * @param {(info: object) => void} [options.onItemCompleted]
 * @returns {Promise<{ threadId: string|null, finalText: string, deltaCount: number }>}
 */
export async function runCodexAppServerTurn(options = {}) {
  const {
    input,
    threadId: resumeThreadId = '',
    cwd,
    model,
    effort,
    approvalPolicy = 'never',
    sandboxMode,
    cliEnv,
    signal,
    onContentDelta,
    onThinkingDelta,
    onThreadId,
    onMessage,
    onUsage,
    onItemCompleted,
  } = options;

  const { wrapperPath } = getCodexCliEntrypoint();
  const env = { ...(cliEnv || process.env) };

  const child = spawn(process.execPath, [wrapperPath, 'app-server', '--stdio'], {
    env,
    cwd: typeof cwd === 'string' && cwd.trim() ? cwd : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  const pending = new Map();
  let closed = false;
  let currentThreadId = null;
  let finalText = '';
  let deltaCount = 0;
  let turnCompleted = false;
  let turnFailedError = null;

  const killChild = () => {
    if (closed) return;
    closed = true;
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      // ignore
    }
  };

  const onAbort = () => {
    // Best-effort interrupt then kill
    if (currentThreadId) {
      try {
        const id = nextId++;
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'turn/interrupt',
            params: { threadId: currentThreadId },
          }) + '\n',
        );
      } catch {
        // ignore
      }
    }
    killChild();
    for (const [, p] of pending) {
      p.reject(new Error('Aborted'));
    }
    pending.clear();
  };

  if (signal) {
    if (signal.aborted) {
      killChild();
      throw new Error('Aborted');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  function sendRequest(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    if (!child.stdin.writable) {
      return Promise.reject(new Error('app-server stdin not writable'));
    }
    child.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`app-server timeout: ${method}`));
        }
      }, DEFAULT_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
    });
  }

  function sendNotification(method, params = {}) {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  function replyServerRequest(id, result) {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function autoApproveServerRequest(msg) {
    // Server-to-client requests use the same envelope with method + id.
    const method = msg.method || '';
    if (
      method.includes('Approval') ||
      method.includes('requestApproval') ||
      method === 'applyPatchApproval' ||
      method === 'execCommandApproval' ||
      method.endsWith('/requestApproval')
    ) {
      replyServerRequest(msg.id, { decision: 'approved' });
      logDebug('auto-approved server request', method);
      return true;
    }
    if (method === 'currentTime/read') {
      replyServerRequest(msg.id, { iso8601: new Date().toISOString() });
      return true;
    }
    // Unknown reverse request: deny carefully with empty error to unblock
    if (msg.id != null && msg.method) {
      logDebug('unhandled server request, rejecting', method);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `Unhandled server request: ${method}` },
        }) + '\n',
      );
      return true;
    }
    return false;
  }

  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      // Keep stderr out of protocol stdout; optional debug
      const text = chunk.toString();
      if (text.includes('ERROR') || text.includes('error')) {
        logDebug('stderr', text.slice(0, 300));
      }
    });
  }

  child.on('error', (err) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const lineHandler = (line) => {
    if (!line || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logDebug('non-json line', line.slice(0, 120));
      return;
    }

    // Response to our request
    if (msg.id != null && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Server → client request (approval etc.)
    if (msg.id != null && msg.method && msg.result === undefined && msg.error === undefined) {
      autoApproveServerRequest(msg);
      return;
    }

    // Notifications
    if (!msg.method) return;
    const method = msg.method;
    const params = msg.params || {};

    if (method === 'thread/started') {
      const tid = params.thread?.id || params.threadId || params.id;
      if (tid) {
        currentThreadId = tid;
        onThreadId?.(tid);
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        deltaCount += 1;
        finalText += delta;
        onContentDelta?.(delta);
      }
      return;
    }

    if (
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) onThinkingDelta?.(delta);
      return;
    }

    if (method === 'item/completed') {
      const item = params.item;
      onItemCompleted?.(item);
      if (item?.type === 'agentMessage' || item?.type === 'agent_message') {
        const text = item.text || item.message || finalText;
        if (typeof text === 'string' && text.trim()) {
          finalText = text;
          onMessage?.({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text }] },
          });
        }
      }
      return;
    }

    if (method === 'turn/completed') {
      turnCompleted = true;
      const usage = params.turn?.usage || params.usage;
      if (usage && typeof usage === 'object') {
        onUsage?.(usage);
      }
      return;
    }

    if (method === 'error' || method === 'turn/failed') {
      const message = params.message || params.error?.message || JSON.stringify(params);
      turnFailedError = new Error(message);
      turnCompleted = true;
    }
  };

  rl.on('line', lineHandler);

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve({ code, sig }));
  });

  try {
    await sendRequest('initialize', {
      clientInfo: { name: 'vscode-cc-gui', version: '0.0.2' },
      capabilities: { experimentalApi: true },
    });
    sendNotification('initialized', {});

    const isResume = typeof resumeThreadId === 'string' && resumeThreadId.trim() !== '';
    if (isResume) {
      const resumed = await sendRequest('thread/resume', {
        threadId: resumeThreadId.trim(),
      });
      currentThreadId =
        resumed?.thread?.id || resumed?.threadId || resumeThreadId.trim();
      onThreadId?.(currentThreadId);
    } else {
      const startParams = {
        cwd: cwd || null,
        approvalPolicy: approvalPolicy || 'never',
      };
      if (model) startParams.model = model;
      // Prefer sandbox via config override when provided
      if (sandboxMode) {
        startParams.config = {
          sandbox_mode: sandboxMode,
        };
      }
      const started = await sendRequest('thread/start', startParams);
      currentThreadId =
        started?.thread?.id || started?.threadId || started?.id || currentThreadId;
      if (currentThreadId) onThreadId?.(currentThreadId);
    }

    if (!currentThreadId) {
      throw new Error('app-server did not return a thread id');
    }

    const userInput = normalizeUserInput(input);
    const turnParams = {
      threadId: currentThreadId,
      input: userInput,
    };
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
    if (cwd) turnParams.cwd = cwd;
    if (approvalPolicy) turnParams.approvalPolicy = approvalPolicy;

    await sendRequest('turn/start', turnParams);

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (!turnCompleted && Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Aborted');
      await new Promise((r) => setTimeout(r, 50));
    }

    if (turnFailedError) throw turnFailedError;
    if (!turnCompleted) throw new Error('app-server turn timed out');

    return {
      threadId: currentThreadId,
      finalText,
      deltaCount,
    };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    rl.close();
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    killChild();
    await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }
}

function normalizeUserInput(input) {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }
  if (!Array.isArray(input)) {
    return [{ type: 'text', text: String(input ?? '') }];
  }
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text });
    } else if (item.type === 'local_image' && typeof item.path === 'string') {
      out.push({ type: 'localImage', path: item.path });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}
