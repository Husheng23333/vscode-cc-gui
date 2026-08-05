import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GrokSessionInfo {
  sessionId: string;
  title: string;
  messageCount: number;
  lastTimestamp: number;
  firstTimestamp: number;
  cwd: string;
  fileSize: number;
  provider: 'grok';
}

/**
 * Reads Grok CLI history from ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/.
 */
export class GrokHistoryReader {
  private readonly sessionsRoot: string;

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = sessionsRoot ?? this.defaultSessionsRoot();
  }

  getSessionsForProject(projectPath: string): {
    success: boolean;
    sessions: GrokSessionInfo[];
    sessionCount: number;
    totalMessages: number;
    error?: string;
  } {
    try {
      const sessions = this.listSessionsForProject(projectPath);
      return {
        success: true,
        sessions,
        sessionCount: sessions.length,
        totalMessages: sessions.reduce((sum, s) => sum + s.messageCount, 0),
      };
    } catch (error) {
      return {
        success: false,
        sessions: [],
        sessionCount: 0,
        totalMessages: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listSessionsForProject(projectPath: string): GrokSessionInfo[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const encoded = this.encodeCwd(projectPath);
    const canon = this.encodeCwd(this.canonicalizePath(projectPath));
    const dirs = new Set([encoded, canon].filter(Boolean));
    const sessions: GrokSessionInfo[] = [];

    for (const dir of dirs) {
      const cwdDir = path.join(this.sessionsRoot, dir);
      if (!fs.existsSync(cwdDir) || !fs.statSync(cwdDir).isDirectory()) continue;
      for (const entry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const info = this.readSessionSummary(path.join(cwdDir, entry.name), projectPath);
        if (info) sessions.push(info);
      }
    }

    // Fallback: scan all if no exact cwd match
    if (sessions.length === 0) {
      return this.listAllSessions().filter((s) => {
        if (!projectPath) return true;
        return s.cwd === projectPath || this.canonicalizePath(s.cwd) === this.canonicalizePath(projectPath);
      });
    }

    return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  listAllSessions(): GrokSessionInfo[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const sessions: GrokSessionInfo[] = [];
    for (const cwdEntry of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory()) continue;
      const cwdDir = path.join(this.sessionsRoot, cwdEntry.name);
      const cwd = this.decodeCwd(cwdEntry.name);
      for (const sessionEntry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
        if (!sessionEntry.isDirectory()) continue;
        const info = this.readSessionSummary(path.join(cwdDir, sessionEntry.name), cwd);
        if (info) sessions.push(info);
      }
    }
    return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  getSessionMessages(sessionId: string, cwd?: string): Array<Record<string, unknown>> {
    const sessionDir = this.resolveSessionDir(sessionId, cwd);
    if (!sessionDir) return [];
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    if (!fs.existsSync(chatPath)) return [];
    return this.parseChatHistoryToMessages(chatPath);
  }

  deleteSession(sessionId: string, projectPath?: string): boolean {
    if (!this.isValidSessionId(sessionId)) return false;
    let sessionDir = this.resolveSessionDir(sessionId, projectPath);
    if (!sessionDir) sessionDir = this.findSessionDirById(sessionId) ?? undefined;
    if (!sessionDir || !fs.existsSync(sessionDir)) return false;
    this.deleteRecursively(sessionDir);
    const parent = path.dirname(sessionDir);
    try {
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch { /* ignore */ }
    return true;
  }

  private readSessionSummary(sessionDir: string, cwd: string): GrokSessionInfo | null {
    const sessionId = path.basename(sessionDir);
    if (!this.isValidSessionId(sessionId)) return null;
    const summaryPath = path.join(sessionDir, 'summary.json');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    if (!fs.existsSync(chatPath) && !fs.existsSync(summaryPath)) return null;

    let title = sessionId.slice(0, 8);
    let messageCount = 0;
    let firstTimestamp = this.fileMtime(summaryPath) || this.fileMtime(chatPath) || Date.now();
    let lastTimestamp = firstTimestamp;
    let fileSize = 0;

    try {
      if (fs.existsSync(chatPath)) fileSize = fs.statSync(chatPath).size;
    } catch { /* ignore */ }

    if (fs.existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        title = summary.generated_title || summary.session_summary || title;
        messageCount = Number(summary.num_chat_messages ?? summary.num_messages ?? 0) || 0;
        const created = this.parseTime(summary.created_at);
        const updated = this.parseTime(summary.updated_at);
        if (created) firstTimestamp = created;
        if (updated) lastTimestamp = updated;
      } catch { /* ignore */ }
    }

    if (messageCount === 0 && fs.existsSync(chatPath)) {
      try {
        const lines = fs.readFileSync(chatPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
        messageCount = lines.length;
        lastTimestamp = this.fileMtime(chatPath) || lastTimestamp;
      } catch { /* ignore */ }
    }

    return {
      sessionId,
      title: String(title || sessionId.slice(0, 8)),
      messageCount,
      lastTimestamp,
      firstTimestamp,
      cwd,
      fileSize,
      provider: 'grok',
    };
  }

  private parseChatHistoryToMessages(chatPath: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    let counter = 0;
    const raw = fs.readFileSync(chatPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"type"')) continue;
      let value: any;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const type = typeof value?.type === 'string' ? value.type : '';
      if (type === 'user') {
        if (value.synthetic_reason) continue;
        const rawText = this.extractContentText(value.content);
        if (this.isRuntimeContextUserText(rawText)) continue;
        const display = this.stripUserQueryWrapper(rawText);
        if (!display) continue;
        counter += 1;
        messages.push(this.buildUserTextMessage(display, `grok-user-${counter}`));
      } else if (type === 'assistant') {
        const text = this.extractContentText(value.content);
        if (text.trim()) {
          counter += 1;
          messages.push(this.buildAssistantTextMessage(text, `grok-assistant-${counter}`));
        }
        const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
        for (const call of toolCalls) {
          if (!call || typeof call !== 'object') continue;
          const toolName = this.resolveToolName(call);
          const toolId = typeof call.id === 'string' ? call.id : `tool-${counter}`;
          const input = this.resolveToolInput(call);
          counter += 1;
          messages.push(this.buildToolUseMessage(toolId, toolName, input, `grok-tool-use-${counter}`));
        }
      } else if (type === 'tool_result' || type === 'function_call_output') {
        const toolUseId = typeof value.tool_call_id === 'string'
          ? value.tool_call_id
          : (typeof value.tool_use_id === 'string' ? value.tool_use_id : `tool-${counter}`);
        const content = this.extractContentText(value.content ?? value.output ?? value.result);
        counter += 1;
        messages.push(this.buildToolResultMessage(toolUseId, content, Boolean(value.is_error), `grok-tool-result-${counter}`));
      } else if (type === 'reasoning') {
        const text = this.extractReasoningSummary(value.summary);
        if (!text.trim()) continue;
        counter += 1;
        messages.push(this.buildAssistantThinkingMessage(text, `grok-reasoning-${counter}`));
      }
    }
    return messages;
  }

  private buildUserTextMessage(text: string, uuid: string) {
    return {
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }

  private buildAssistantTextMessage(text: string, uuid: string) {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    };
  }

  private buildAssistantThinkingMessage(text: string, uuid: string) {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
    };
  }

  private buildToolUseMessage(id: string, name: string, input: unknown, uuid: string) {
    return {
      type: 'assistant',
      uuid,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input: input && typeof input === 'object' ? input : {} }],
      },
    };
  }

  private buildToolResultMessage(toolUseId: string, content: string, isError: boolean, uuid: string) {
    return {
      type: 'user',
      uuid,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }],
      },
    };
  }

  private extractContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'string') return block;
          if (block && typeof block === 'object') {
            const obj = block as Record<string, unknown>;
            if (typeof obj.text === 'string') return obj.text;
            if (typeof obj.content === 'string') return obj.content;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      const obj = content as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
    }
    return content == null ? '' : String(content);
  }

  private extractReasoningSummary(summary: unknown): string {
    if (typeof summary === 'string') return summary;
    if (Array.isArray(summary)) {
      return summary
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
            return (item as any).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  private resolveToolName(call: any): string {
    return (
      call?.function?.name
      || call?.name
      || call?.tool_name
      || 'tool'
    );
  }

  private resolveToolInput(call: any): unknown {
    const args = call?.function?.arguments ?? call?.arguments ?? call?.input;
    if (typeof args === 'string') {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return args && typeof args === 'object' ? args : {};
  }

  private stripUserQueryWrapper(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/i);
    return match ? match[1].trim() : trimmed;
  }

  private isRuntimeContextUserText(text: string): boolean {
    return /<ide_selection>|<opened_file>|<workspace_path>/i.test(text);
  }

  private resolveSessionDir(sessionId: string, cwd?: string): string | undefined {
    if (!this.isValidSessionId(sessionId)) return undefined;
    if (cwd) {
      for (const encoded of [this.encodeCwd(cwd), this.encodeCwd(this.canonicalizePath(cwd))]) {
        const direct = path.join(this.sessionsRoot, encoded, sessionId);
        if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
      }
    }
    return this.findSessionDirById(sessionId) ?? undefined;
  }

  private findSessionDirById(sessionId: string): string | null {
    if (!fs.existsSync(this.sessionsRoot)) return null;
    for (const cwdEntry of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory()) continue;
      const candidate = path.join(this.sessionsRoot, cwdEntry.name, sessionId);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
    return null;
  }

  private isValidSessionId(sessionId: string): boolean {
    if (!sessionId || typeof sessionId !== 'string') return false;
    const trimmed = sessionId.trim();
    return !!trimmed && !trimmed.includes('/') && !trimmed.includes('\\') && !trimmed.includes('..');
  }

  private encodeCwd(cwd: string): string {
    return encodeURIComponent(cwd || '').replace(/%2F/gi, '%2F');
  }

  private decodeCwd(encoded: string): string {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  private canonicalizePath(input: string): string {
    try {
      return fs.realpathSync(input);
    } catch {
      return input;
    }
  }

  private fileMtime(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private parseTime(value: unknown): number {
    if (typeof value !== 'string' || !value.trim()) return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  private deleteRecursively(target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
  }

  private defaultSessionsRoot(): string {
    const home = process.env.GROK_HOME?.trim() || path.join(os.homedir(), '.grok');
    return path.join(home, 'sessions');
  }
}
