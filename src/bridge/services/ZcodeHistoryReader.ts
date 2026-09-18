import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NodeDetector } from '../../nodeDetector';

const CHANNEL_SCRIPT = 'channel-manager.js';
const PROVIDER = 'zcode';
const HISTORY_TIMEOUT_MS = 50_000;
const MAX_OUTPUT_CHARS = 8_000_000;
// stderr is drained and only the tail is kept, for diagnostics on
// timeout/failure — it must never block the child process.
const MAX_STDERR_CHARS = 8_192;

export interface ZcodeSessionListResult {
  success: boolean;
  sessions: Record<string, unknown>[];
  total?: number;
  sessionCount?: number;
  error?: string;
}

interface ZcodeCommandResult {
  payload: Record<string, unknown> | null;
  error?: string;
}

// JSON object rows from the channel payload: keep only plain objects.
const isJsonObjectRow = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/**
 * Reads ZCode session history by querying the app-server through one-shot
 * channel-manager commands (`node channel-manager.js zcode listSessions |
 * getSessionMessages | deleteSession`).
 *
 * ZCode keeps its transcripts inside the desktop client's own storage — there
 * is no stable on-disk layout for the plugin to scan, so (unlike the
 * Grok/Omp readers) nothing here touches the filesystem directly. Each
 * command receives its parameters as a stdin JSON document (gated by
 * ZCODE_USE_STDIN=true) and prints a single result JSON line on stdout.
 */
export class ZcodeHistoryReader {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Sessions for one project, shaped like the other CLI readers. */
  async getSessionsForProject(projectPath: string): Promise<ZcodeSessionListResult> {
    const result = await this.runCommand('listSessions', { cwd: projectPath || '' });
    if (!result.payload) {
      return {
        success: false,
        sessions: [],
        error: result.error || 'ZCode channel-manager returned no session list',
      };
    }
    const payload = result.payload;
    return {
      success: payload.success === true,
      sessions: Array.isArray(payload.sessions) ? payload.sessions.filter(isJsonObjectRow) : [],
      total: typeof payload.total === 'number' ? payload.total : undefined,
      sessionCount: typeof payload.sessionCount === 'number' ? payload.sessionCount : undefined,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    };
  }

  /** One session's messages in the Claude-shaped JSON object list. */
  async getSessionMessages(sessionId: string, cwd: string): Promise<Record<string, unknown>[]> {
    const id = String(sessionId || '').trim();
    if (!id) {
      return [];
    }
    const result = await this.runCommand('getSessionMessages', { sessionId: id, cwd: cwd || '' });
    const payload = result.payload;
    if (!payload || payload.success !== true || !Array.isArray(payload.messages)) {
      return [];
    }
    return payload.messages.filter(isJsonObjectRow);
  }

  /** Delete one session from the ZCode store; true when the command reports success. */
  async deleteSession(sessionId: string, cwd: string): Promise<boolean> {
    const id = String(sessionId || '').trim();
    if (!id) {
      return false;
    }
    const result = await this.runCommand('deleteSession', { sessionId: id, cwd: cwd || '' });
    return result.payload?.success === true;
  }

  /**
   * Run one `zcode` channel command through a one-shot channel-manager
   * process and return its last JSON stdout object (same spawn pattern as
   * CliModelsHandler / runDshBridgeCommand).
   */
  private runCommand(command: string, stdinPayload: Record<string, unknown>): Promise<ZcodeCommandResult> {
    const node = NodeDetector.find(this.context);
    if (!node) {
      return Promise.resolve({ payload: null, error: 'Node.js executable not found' });
    }
    const bridgeDir = path.join(this.context.extensionPath, 'ai-bridge');
    const script = path.join(bridgeDir, CHANNEL_SCRIPT);
    if (!fs.existsSync(script)) {
      return Promise.resolve({ payload: null, error: 'channel-manager.js not found' });
    }

    // NOTE: executor form (not Promise.withResolvers) — the project tsconfig lib
    // is ES2020. Mirrors DshBridgeCommand.
    return new Promise<ZcodeCommandResult>((resolve) => {
      let settled = false;
      let output = '';
      let stderrTail = '';
      const child = cp.spawn(node, [script, PROVIDER, command], {
        cwd: bridgeDir,
        env: { ...process.env, ZCODE_USE_STDIN: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const finish = (result: ZcodeCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null && !child.killed) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        const tail = stderrTail.trim();
        finish({ payload: null, error: `Timed out running zcode ${command}${tail ? ` (stderr: ${tail})` : ''}` });
      }, HISTORY_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (output.length < MAX_OUTPUT_CHARS) {
          output += chunk.toString();
          if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS);
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail += chunk.toString();
        if (stderrTail.length > MAX_STDERR_CHARS) {
          stderrTail = stderrTail.slice(-MAX_STDERR_CHARS);
        }
      });
      child.on('error', (error: Error) => {
        finish({ payload: null, error: error.message });
      });
      child.on('close', () => {
        const payload = extractJsonObject(output);
        if (!payload) {
          const tail = stderrTail.trim();
          finish({ payload: null, error: `No JSON output from zcode ${command}${tail ? ` (stderr: ${tail})` : ''}` });
          return;
        }
        finish({ payload });
      });

      child.stdin?.on('error', () => { /* child gone before stdin flush */ });
      child.stdin?.write(JSON.stringify(stdinPayload) + '\n');
      child.stdin?.end();
    });
  }
}

/**
 * Extract the last well-formed JSON object from stdout lines (the channel
 * prints diagnostic lines before the result).
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (isJsonObjectRow(obj)) {
        return obj;
      }
    } catch {
      // skip non-JSON output line
    }
  }
  return null;
}
