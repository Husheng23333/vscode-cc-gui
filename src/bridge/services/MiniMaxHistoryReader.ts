import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MiniMaxSessionInfo {
  sessionId: string;
  title: string;
  messageCount: number;
  lastTimestamp: number;
  firstTimestamp: number;
  cwd: string;
  fileSize: number;
  provider: 'minimax';
}

const MAX_TITLE_CHARS = 80;
const MAX_TOOL_RESULT_CHARS = 20_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

type JsonObj = Record<string, unknown>;

/**
 * Reads MiniMax Code (mcode) session history from its on-disk v2 layout.
 *
 * Layout (mcode 0.2.x):
 *   ~/.minimax/v2/sessions/YYYY/MM/DD/<HH-mm-ss-ms>-session_<base64>/
 * containing snapshot.json (record + displayMessages) plus display.jsonl
 * (event log fallback).
 *
 * snapshot.json shape:
 *   {
 *     "record": { "sessionId": "mvs_...", "workspaceDir": "...", "title": "...",
 *                 "createdAtMs": 1, "updatedAtMs": 2, "effectiveModel": "..." },
 *     "displayMessages": [
 *       { "msg_id": "umsg_1", "role": "user", "msg_content": "...", "timestamp": 1 },
 *       { "msg_id": "...", "role": "assistant", "msg_content": "...",
 *         "thinking_content": "...",
 *         "tool_calls": [{ "tool_name": "bash", "tool_call_id": "...",
 *                          "tool_call_status": 2, "tool_call_args": "{...}",
 *                          "tool_call_result_data": "{...}" }] }
 *     ]
 *   }
 *
 * Ported from jetbrains-cc-gui's MiniMaxHistoryReader.java. Path matching is
 * case-insensitive and normalizes `\` → `/` so Windows project paths match
 * sessions written by the MiniMax CLI. Message rows use the same GUI envelope
 * shape as OmpHistoryReader so the webview renders them unchanged.
 */
export class MiniMaxHistoryReader {
  private readonly minimaxHome: string;
  private readonly sessionsRoot: string;

  constructor(minimaxHome?: string) {
    this.minimaxHome = minimaxHome ?? MiniMaxHistoryReader.defaultMiniMaxHome();
    this.sessionsRoot = path.join(this.minimaxHome, 'v2', 'sessions');
  }

  private static defaultMiniMaxHome(): string {
    const override = (process.env.MINIMAX_CODE_HOME?.trim() || process.env.MINIMAX_HOME?.trim());
    if (override) return override;
    return path.join(os.homedir(), '.minimax');
  }

  getSessionsForProject(projectPath: string): {
    success: boolean;
    sessions: MiniMaxSessionInfo[];
    sessionCount: number;
    totalMessages: number;
    provider: 'minimax';
    error?: string;
  } {
    try {
      const sessions = this.listSessionsForProject(projectPath);
      return {
        success: true,
        sessions,
        sessionCount: sessions.length,
        totalMessages: sessions.reduce((sum, s) => sum + s.messageCount, 0),
        provider: 'minimax',
      };
    } catch (error) {
      return {
        success: false,
        sessions: [],
        sessionCount: 0,
        totalMessages: 0,
        provider: 'minimax',
        error: `Failed to read MiniMax sessions: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  listSessionsForProject(projectPath: string): MiniMaxSessionInfo[] {
    const all = this.listAllSessions();
    if (!projectPath || !projectPath.trim()) return all;
    const filtered = all.filter((session) => session.cwd && pathsMatch(session.cwd, projectPath));
    filtered.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    return filtered;
  }

  listAllSessions(): MiniMaxSessionInfo[] {
    const sessions: MiniMaxSessionInfo[] = [];
    if (!this.isDirectory(this.sessionsRoot)) return sessions;
    // v2/sessions/YYYY/MM/DD/<session-dir>
    for (const year of this.listDirs(this.sessionsRoot)) {
      for (const month of this.listDirs(year)) {
        for (const day of this.listDirs(month)) {
          for (const sessionDir of this.listDirs(day)) {
            const info = this.readSessionSummary(sessionDir);
            if (info) sessions.push(info);
          }
        }
      }
    }
    sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    return sessions;
  }

  private readSessionSummary(sessionDir: string): MiniMaxSessionInfo | null {
    try {
      const snapshotPath = path.join(sessionDir, 'snapshot.json');
      if (!this.isFile(snapshotPath)) return null;
      const snapshot = parseJsonObject(fs.readFileSync(snapshotPath, 'utf8'));
      const record = snapshot?.record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
      const sessionId = text(record, 'sessionId');
      if (!sessionId || !sessionId.trim()) return null;

      const displayMessages = snapshot && Array.isArray(snapshot.displayMessages)
        ? snapshot.displayMessages
        : null;
      const firstTimestamp = longVal(record, 'createdAtMs', 0);
      let lastTimestamp = longVal(record, 'updatedAtMs', firstTimestamp);
      if (lastTimestamp <= 0) {
        lastTimestamp = this.fileMtime(snapshotPath);
      }

      let fileSize = this.fileSize(snapshotPath);
      const displayPath = path.join(sessionDir, 'display.jsonl');
      if (this.isFile(displayPath)) {
        fileSize += this.fileSize(displayPath);
      }

      return {
        sessionId,
        cwd: text(record, 'workspaceDir') ?? '',
        title: truncate(firstNonBlank(text(record, 'title'), deriveTitleFromSnapshot(snapshot)) ?? '', MAX_TITLE_CHARS),
        messageCount: displayMessages ? displayMessages.length : 0,
        lastTimestamp,
        firstTimestamp,
        fileSize,
        provider: 'minimax',
      };
    } catch {
      return null;
    }
  }

  /**
   * Loads one session's messages as GUI rows (same envelope as OmpHistoryReader).
   */
  getSessionMessages(sessionId: string, cwd?: string): Array<Record<string, unknown>> {
    const sessionDir = this.resolveSessionDir(sessionId, cwd);
    if (!sessionDir) return [];

    // Preferred source: snapshot.json displayMessages.
    const snapshotPath = path.join(sessionDir, 'snapshot.json');
    if (this.isFile(snapshotPath)) {
      try {
        const snapshot = parseJsonObject(fs.readFileSync(snapshotPath, 'utf8'));
        if (snapshot && Array.isArray(snapshot.displayMessages) && snapshot.displayMessages.length > 0) {
          return buildMessages(snapshot.displayMessages);
        }
      } catch {
        // fall back to display.jsonl below
      }
    }

    // Fallback: replay display.jsonl events, deduplicating upserts by msg_id.
    const displayPath = path.join(sessionDir, 'display.jsonl');
    if (this.isFile(displayPath)) {
      try {
        return this.parseDisplayJsonl(displayPath);
      } catch {
        return [];
      }
    }
    return [];
  }

  deleteSession(sessionId: string, projectPath?: string): boolean {
    const sessionDir = this.resolveSessionDir(sessionId, projectPath);
    if (!sessionDir) return false;
    try {
      deleteRecursively(sessionDir);
      pruneEmptyDirs(path.dirname(sessionDir), 3);
      return true;
    } catch {
      return false;
    }
  }

  private resolveSessionDir(sessionId: string, cwd?: string): string | null {
    if (!isSafeSessionId(sessionId)) return null;
    const wanted = sessionId.trim();
    if (!this.isDirectory(this.sessionsRoot)) return null;
    // Session dirs are dated mcode-internal names; match by the sessionId
    // inside snapshot.json instead of guessing the dir naming scheme.
    let best: string | null = null;
    for (const year of this.listDirs(this.sessionsRoot)) {
      for (const month of this.listDirs(year)) {
        for (const day of this.listDirs(month)) {
          for (const sessionDir of this.listDirs(day)) {
            // Read snapshot.json once per dir — the record carries both the
            // id and the workspace.
            const record = readSessionRecord(sessionDir);
            if (!record || text(record, 'sessionId') !== wanted) continue;
            // Prefer a session whose workspace matches cwd.
            if (cwd && cwd.trim()) {
              const ws = text(record, 'workspaceDir');
              if (ws && pathsMatch(ws, cwd)) return sessionDir;
            }
            if (!best) best = sessionDir;
          }
        }
      }
    }
    return best;
  }

  /**
   * Fallback parser for display.jsonl: keeps the latest display_upserted
   * event per msg_id (upserts may re-emit updated tool results).
   */
  private parseDisplayJsonl(displayPath: string): Array<Record<string, unknown>> {
    // Map: insertion order keeps first-seen (file) order for messages sharing
    // a timestamp (Array.prototype.sort is stable).
    const latestById = new Map<string, JsonObj>();
    const seqById = new Map<string, number>();
    for (const line of fs.readFileSync(displayPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obj = parseJsonObject(trimmed);
      if (!obj) continue;
      if (text(obj, 'kind') !== 'message.display_upserted') continue;
      const msgId = text(obj, 'msgId');
      if (!msgId || !msgId.trim()) continue;
      const seq = longVal(obj, 'seq', -1);
      const prev = seqById.get(msgId);
      if (prev === undefined || seq >= prev) {
        seqById.set(msgId, seq);
        const message = obj.message;
        if (message && typeof message === 'object' && !Array.isArray(message)) {
          latestById.set(msgId, message as JsonObj);
        }
      }
    }
    const ordered = Array.from(latestById.values())
      .sort((a, b) => longVal(a, 'timestamp', 0) - longVal(b, 'timestamp', 0));
    return buildMessages(ordered);
  }

  private listDirs(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  }

  private isDirectory(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  private isFile(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  private fileSize(file: string): number {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  private fileMtime(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}

function deriveTitleFromSnapshot(snapshot: JsonObj | null): string {
  const messages = snapshot && Array.isArray(snapshot.displayMessages)
    ? snapshot.displayMessages
    : null;
  if (!messages) return '';
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (text(msg, 'role') === 'user') {
      const content = text(msg, 'msg_content');
      if (content && content.trim()) return content;
    }
  }
  return '';
}

/**
 * Reads the record object from a session's snapshot.json, or null when the
 * snapshot is missing or malformed.
 */
function readSessionRecord(sessionDir: string): JsonObj | null {
  try {
    const snapshotPath = path.join(sessionDir, 'snapshot.json');
    if (!fs.statSync(snapshotPath).isFile()) return null;
    const record = parseJsonObject(fs.readFileSync(snapshotPath, 'utf8'))?.record;
    return record && typeof record === 'object' && !Array.isArray(record) ? record as JsonObj : null;
  } catch {
    return null;
  }
}

/**
 * Converts mcode displayMessages into GUI rows:
 * user text, assistant thinking / text, tool_use, and tool_result.
 */
function buildMessages(displayMessages: unknown[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let counter = 0;
  for (const msg of displayMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = text(msg, 'role');
    if (role === 'user') {
      const content = text(msg, 'msg_content');
      if (!content || !content.trim()) continue;
      counter += 1;
      messages.push(buildUserTextMessage(content, `minimax-user-${counter}`));
    } else if (role === 'assistant') {
      const thinking = text(msg, 'thinking_content');
      if (thinking && thinking.trim()) {
        counter += 1;
        messages.push(buildAssistantThinkingMessage(thinking, `minimax-think-${counter}`));
      }
      const content = text(msg, 'msg_content');
      if (content && content.trim()) {
        counter += 1;
        messages.push(buildAssistantTextMessage(content, `minimax-text-${counter}`));
      }
      const toolCalls = (msg as JsonObj).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!call || typeof call !== 'object') continue;
          let callId = firstNonBlank(text(call, 'tool_call_id'), text(call, 'toolCallId'));
          if (!callId || !callId.trim()) {
            counter += 1;
            callId = `minimax-tool-${counter}`;
          }
          const name = firstNonBlank(text(call, 'tool_name'), text(call, 'toolName'))?.trim() || 'tool';
          const input = parseJsonObject(text(call, 'tool_call_args')) ?? {};
          messages.push(buildToolUseMessage(callId, name, input));

          const resultData = firstNonBlank(text(call, 'tool_call_result_data'), text(call, 'toolCallResultData'));
          const resultText = extractToolResultText(resultData);
          if (resultText.trim()) {
            messages.push(buildToolResultMessage(
              callId,
              truncate(resultText, MAX_TOOL_RESULT_CHARS),
              isErrorResult(resultData),
            ));
          }
        }
      }
    }
  }
  return messages;
}

function pruneEmptyDirs(dir: string | null, depth: number): void {
  if (!dir || depth <= 0) return;
  try {
    if (fs.readdirSync(dir).length > 0) return;
    fs.rmdirSync(dir);
    pruneEmptyDirs(path.dirname(dir), depth - 1);
  } catch {
    // ignore
  }
}

function deleteRecursively(root: string): void {
  // lstat + explicit unlink: a (crafted) symlink inside a session dir must be
  // deleted as a link, never recursed into — otherwise the contents of the
  // directory it points at would be wiped along with the session.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(root)) {
      deleteRecursively(path.join(root, child));
    }
    fs.rmdirSync(root);
  } else {
    fs.unlinkSync(root);
  }
}

// ------------------------------------------------------------------
// Message builders (GUI envelope, same shape as OmpHistoryReader)
// ------------------------------------------------------------------

/**
 * Frontend history/chat rendering expects Claude-style rows:
 *   { type, content, raw: { uuid?, message: { role, content: blocks } }, timestamp? }
 */
function buildGuiMessage(
  type: 'user' | 'assistant',
  role: 'user' | 'assistant',
  contentBlocks: unknown[],
  textContent: string,
  uuid: string,
) {
  return {
    type,
    content: textContent,
    raw: {
      uuid,
      message: {
        role,
        content: contentBlocks,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function buildUserTextMessage(body: string, uuid: string) {
  return buildGuiMessage('user', 'user', [{ type: 'text', text: body }], body, uuid);
}

function buildAssistantTextMessage(body: string, uuid: string) {
  return buildGuiMessage('assistant', 'assistant', [{ type: 'text', text: body }], body, uuid);
}

function buildAssistantThinkingMessage(body: string, uuid: string) {
  return buildGuiMessage(
    'assistant',
    'assistant',
    [{ type: 'thinking', thinking: body }],
    body,
    uuid,
  );
}

function buildToolUseMessage(id: string, name: string, input: unknown) {
  return buildGuiMessage(
    'assistant',
    'assistant',
    [{ type: 'tool_use', id, name, input: input && typeof input === 'object' ? input : {} }],
    '',
    id,
  );
}

function buildToolResultMessage(toolUseId: string, content: string, isError: boolean) {
  // Same display marker as live tool inserts so shouldShowMessage hides
  // standalone tool_result rows (results attach to the tool card via raw).
  return buildGuiMessage(
    'user',
    'user',
    [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }],
    '[tool_result]',
    toolUseId,
  );
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

/**
 * mcode tool results are JSON strings like
 * `{"content":[{"type":"text","text":"..."}]}`.
 */
function extractToolResultText(resultData: string | null): string {
  if (!resultData || !resultData.trim()) return '';
  const obj = parseJsonObject(resultData);
  if (!obj) return resultData;
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const el of obj.content as unknown[]) {
      if (el == null) continue;
      if (typeof el !== 'object') {
        parts.push(String(el));
        continue;
      }
      const t = text(el, 'text');
      if (t) parts.push(t);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if ('error' in obj && obj.error != null) {
    return typeof obj.error === 'object' ? JSON.stringify(obj.error) : String(obj.error);
  }
  return JSON.stringify(obj);
}

/**
 * Structured error check: only a non-null top-level "error" field marks the
 * result as failed. A raw substring match would false-positive on tool output
 * that merely quotes JSON containing the word "error".
 */
function isErrorResult(resultData: string | null): boolean {
  const obj = parseJsonObject(resultData);
  return obj != null && 'error' in obj && obj.error != null;
}

function parseJsonObject(raw: string | null): JsonObj | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // JSON.parse output is untyped; the object shape check is the validation.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObj : null;
  } catch {
    return null;
  }
}

function isSafeSessionId(sessionId: string): boolean {
  const id = String(sessionId ?? '').trim();
  if (!id) return false;
  if (id === '.' || id.includes('..') || id.includes('/') || id.includes('\\')) return false;
  return SESSION_ID_PATTERN.test(id);
}

function text(obj: unknown, field: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const value = (obj as JsonObj)[field];
  if (value == null) return null;
  try {
    return String(value);
  } catch {
    return null;
  }
}

function longVal(obj: unknown, field: string, fallback: number): number {
  if (!obj || typeof obj !== 'object') return fallback;
  const value = (obj as JsonObj)[field];
  if (value == null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function firstNonBlank(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value != null && value.trim()) return value;
  }
  return null;
}

function truncate(value: string, maxChars: number): string {
  if (value == null) return '';
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** Ported from jetbrains-cc-gui's HistoryPathMatcher (case-insensitive, bidirectional). */
function normalizePath(value: string): string {
  let p = String(value ?? '').trim().replace(/\\/g, '/');
  if (p.length >= 2 && p[1] === ':') {
    p = p[0].toLowerCase() + p.slice(1);
  }
  while (p.endsWith('/') && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}

function stripPrivatePrefix(value: string): string {
  return value.startsWith('/private/') ? value.slice('/private'.length) : value;
}

function pathsMatch(sessionCwd: string, projectPath: string): boolean {
  const a = normalizePath(sessionCwd).toLowerCase();
  const b = normalizePath(projectPath).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  // macOS /tmp vs /private/tmp
  const a2 = stripPrivatePrefix(a);
  const b2 = stripPrivatePrefix(b);
  if (a2 === b2) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
    || a2.startsWith(`${b2}/`) || b2.startsWith(`${a2}/`);
}
