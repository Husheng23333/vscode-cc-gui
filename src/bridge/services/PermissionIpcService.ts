import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';

const REMEMBERED_TOOL_APPROVALS_KEY = 'ccg.remembered_tool_approvals';
const STALE_PERMISSION_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;

type RememberedApproval = {
  toolName: string;
  command?: string;
  cwd?: string;
  path?: string;
};

export class PermissionIpcService implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private scanInterval?: ReturnType<typeof setInterval>;
  private readonly awaitingUser = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly log: vscode.OutputChannel;
  private readonly getWebview: () => vscode.Webview | undefined;
  private readonly globalState?: vscode.Memento;

  constructor(
    log: vscode.OutputChannel,
    getWebview: () => vscode.Webview | undefined,
    globalState?: vscode.Memento,
  ) {
    this.log = log;
    this.getWebview = getWebview;
    this.globalState = globalState;
  }

  start(): void {
    if (this.watcher) {
      return;
    }
    const dir = this.permissionIpcDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.log.appendLine(`[BRIDGE] Could not create permission dir: ${error}`);
    }

    const scan = () => {
      void this.scanToolPermissionRequestFiles(dir);
    };

    try {
      this.watcher = fs.watch(dir, () => {
        scan();
      });
      scan();
    } catch (error) {
      this.log.appendLine(`[BRIDGE] Permission dir watch failed: ${error}`);
    }

    // fs.watch is unreliable on some platforms; poll so we never miss a request file.
    this.scanInterval = setInterval(scan, 2000);
  }

  dispose(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
    this.awaitingUser.clear();
    this.completed.clear();
    try {
      this.watcher?.close();
    } catch {
      // Ignore watcher cleanup failures.
    }
    this.watcher = undefined;
  }

  handlePermissionDecision(content: string): void {
    try {
      const decision = JSON.parse(content) as {
        channelId?: string;
        allow?: boolean;
        remember?: boolean;
      };
      const requestId = decision.channelId;
      if (!requestId || typeof requestId !== 'string') {
        return;
      }

      this.awaitingUser.delete(requestId);
      this.completed.add(requestId);
      const sessionId = this.sessionIdForPermissionIpc();
      const dir = this.permissionIpcDir();
      fs.mkdirSync(dir, { recursive: true });
      const responseFile = path.join(dir, `response-${sessionId}-${requestId}.json`);
      const allow = decision.allow === true;
      fs.writeFileSync(responseFile, JSON.stringify({ allow }), 'utf8');
      if (allow && decision.remember === true) {
        this.rememberApprovalForRequest(requestId);
      }
      this.log.appendLine(`[BRIDGE] permission_decision -> ${path.basename(responseFile)} allow=${allow} remember=${decision.remember === true}`);
    } catch (error) {
      this.log.appendLine(`[BRIDGE] permission_decision failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  handleAskUserQuestionResponse(content: string): void {
    try {
      const response = JSON.parse(content) as { requestId?: string; answers?: Record<string, unknown> };
      const requestId = response.requestId;
      if (!requestId || typeof requestId !== 'string') {
        return;
      }

      this.awaitingUser.delete(requestId);
      this.completed.add(requestId);
      const sessionId = this.sessionIdForPermissionIpc();
      const dir = this.permissionIpcDir();
      fs.mkdirSync(dir, { recursive: true });
      const responseFile = path.join(dir, `ask-user-question-response-${sessionId}-${requestId}.json`);
      fs.writeFileSync(responseFile, JSON.stringify({ answers: response.answers ?? {} }), 'utf8');
      // Delete the original request file so a later re-scan (after a webview reload
      // clears the in-memory `completed` set) does not re-open an already-answered
      // dialog. Without this the request lingers on disk forever and re-pops on
      // every re-entry.
      const requestFile = path.join(dir, `ask-user-question-${sessionId}-${requestId}.json`);
      this.deleteFileQuietly(requestFile, 'answered ask-user-question request');
      this.log.appendLine(`[BRIDGE] ask_user_question_response -> ${path.basename(responseFile)}`);
    } catch (error) {
      this.log.appendLine(`[BRIDGE] ask_user_question_response failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  handlePlanApprovalResponse(content: string): void {
    try {
      const response = JSON.parse(content) as { requestId?: string; approved?: boolean; targetMode?: string; message?: string };
      const requestId = response.requestId;
      if (!requestId || typeof requestId !== 'string') {
        return;
      }

      this.awaitingUser.delete(requestId);
      this.completed.add(requestId);
      const sessionId = this.sessionIdForPermissionIpc();
      const dir = this.permissionIpcDir();
      fs.mkdirSync(dir, { recursive: true });
      const responseFile = path.join(dir, `plan-approval-response-${sessionId}-${requestId}.json`);
      fs.writeFileSync(responseFile, JSON.stringify({
        approved: response.approved === true,
        targetMode: response.targetMode || 'default',
        message: response.message,
      }), 'utf8');
      // Delete the original request file so a later re-scan (after the in-memory
      // `completed` set is cleared on webview reload) does not re-open the dialog.
      const requestFile = path.join(dir, `plan-approval-${sessionId}-${requestId}.json`);
      this.deleteFileQuietly(requestFile, 'answered plan-approval request');
      this.log.appendLine(`[BRIDGE] plan_approval_response -> ${path.basename(responseFile)} approved=${response.approved === true}`);
    } catch (error) {
      this.log.appendLine(`[BRIDGE] plan_approval_response failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Must match ai-bridge/permission-ipc.js defaults. */
  private permissionIpcDir(): string {
    return process.env.CLAUDE_PERMISSION_DIR
      ? process.env.CLAUDE_PERMISSION_DIR
      : path.join(tmpdir(), 'claude-permission');
  }

  private sessionIdForPermissionIpc(): string {
    return process.env.CLAUDE_SESSION_ID || 'default';
  }

  private scanToolPermissionRequestFiles(dir: string): void {
    const webview = this.getWebview();
    if (!webview) {
      return;
    }
    const sessionId = this.sessionIdForPermissionIpc();
    const prefix = `request-${sessionId}-`;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) {
        continue;
      }
      const data = this.readJsonFile<{ requestId?: string; toolName?: string; inputs?: Record<string, unknown> }>(path.join(dir, name));
      const requestId = data?.requestId;
      if (!requestId || typeof requestId !== 'string' || !data?.toolName) {
        continue;
      }
      if (this.isStaleRequestFile(path.join(dir, name))) {
        this.completed.add(requestId);
        this.deleteFileQuietly(path.join(dir, name), 'stale permission request');
        continue;
      }
      if (this.completed.has(requestId) || this.awaitingUser.has(requestId)) {
        continue;
      }
      if (this.isRememberedApproval(data.toolName, data.inputs ?? {})) {
        this.completed.add(requestId);
        try {
          const responseFile = path.join(dir, `response-${sessionId}-${requestId}.json`);
          fs.writeFileSync(responseFile, JSON.stringify({ allow: true }), 'utf8');
          this.deleteFileQuietly(path.join(dir, name), 'remembered permission request');
          this.log.appendLine(`[BRIDGE] auto-allowed remembered permission for ${data.toolName} (${requestId})`);
        } catch (error) {
          this.log.appendLine(`[BRIDGE] auto-allow remembered permission failed: ${error}`);
        }
        continue;
      }

      this.awaitingUser.add(requestId);
      try {
        this.postDialogRequest(webview, 'showPermissionDialog', '__pendingPermissionDialogRequests', {
          channelId: requestId,
          toolName: data.toolName,
          inputs: data.inputs ?? {},
        });
      } catch (error) {
        this.awaitingUser.delete(requestId);
        this.log.appendLine(`[BRIDGE] showPermissionDialog postMessage failed: ${error}`);
        return;
      }
      this.log.appendLine(`[BRIDGE] showPermissionDialog for ${data.toolName} (${requestId})`);
    }

    this.scanAskUserQuestionRequestFiles(dir, entries, sessionId, webview);
    this.scanPlanApprovalRequestFiles(dir, entries, sessionId, webview);
  }

  private scanAskUserQuestionRequestFiles(dir: string, entries: string[], sessionId: string, webview: vscode.Webview): void {
    const prefix = `ask-user-question-${sessionId}-`;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json') || name.startsWith(`ask-user-question-response-${sessionId}-`)) {
        continue;
      }
      const data = this.readJsonFile<{ requestId?: string; toolName?: string; questions?: unknown[] }>(path.join(dir, name));
      const requestId = data?.requestId;
      if (!requestId || typeof requestId !== 'string') {
        continue;
      }
      if (this.completed.has(requestId) || this.awaitingUser.has(requestId)) {
        continue;
      }
      // Disk-durable guard: if an answer file already exists next to the request,
      // this request was answered in a previous session — do not re-open it, and
      // clean up the orphaned request file. Survives the in-memory set being reset.
      const responseName = `ask-user-question-response-${sessionId}-${requestId}.json`;
      if (entries.includes(responseName)) {
        this.completed.add(requestId);
        this.deleteFileQuietly(path.join(dir, name), 'stale answered ask-user-question request');
        continue;
      }
      this.awaitingUser.add(requestId);
      this.postDialogRequest(webview, 'showAskUserQuestionDialog', '__pendingAskUserQuestionDialogRequests', {
        requestId,
        toolName: data?.toolName ?? 'AskUserQuestion',
        questions: data?.questions ?? [],
      });
      this.log.appendLine(`[BRIDGE] showAskUserQuestionDialog (${requestId})`);
      // v0.4.7: optional OS notification when AskUserQuestion appears (opt-in).
      this.maybeNotifyAskUserQuestion(data?.toolName ?? 'AskUserQuestion');
    }
  }

  private maybeNotifyAskUserQuestion(toolName: string): void {
    try {
      const enabled = this.globalState?.get<boolean>('ccg.ask_user_question_notification_enabled', false) === true;
      if (!enabled) return;
      void vscode.window.showInformationMessage(
        `Claude is waiting for your answer (${toolName})`,
      );
    } catch (error) {
      this.log.appendLine(`[BRIDGE] askUserQuestion notification failed: ${error}`);
    }
  }

  private scanPlanApprovalRequestFiles(dir: string, entries: string[], sessionId: string, webview: vscode.Webview): void {
    const prefix = `plan-approval-${sessionId}-`;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json') || name.startsWith(`plan-approval-response-${sessionId}-`)) {
        continue;
      }
      const data = this.readJsonFile<{ requestId?: string; toolName?: string; plan?: string; allowedPrompts?: unknown[]; timestamp?: string }>(path.join(dir, name));
      const requestId = data?.requestId;
      if (!requestId || typeof requestId !== 'string') {
        continue;
      }
      if (this.completed.has(requestId) || this.awaitingUser.has(requestId)) {
        continue;
      }
      // Disk-durable guard: skip and clean up requests already answered in a
      // previous session (their response file survives the in-memory set reset).
      const responseName = `plan-approval-response-${sessionId}-${requestId}.json`;
      if (entries.includes(responseName)) {
        this.completed.add(requestId);
        this.deleteFileQuietly(path.join(dir, name), 'stale answered plan-approval request');
        continue;
      }
      this.awaitingUser.add(requestId);
      this.postDialogRequest(webview, 'showPlanApprovalDialog', '__pendingPlanApprovalDialogRequests', {
        requestId,
        toolName: data?.toolName ?? 'ExitPlanMode',
        plan: data?.plan ?? '',
        allowedPrompts: data?.allowedPrompts ?? [],
        timestamp: data?.timestamp,
      });
      this.log.appendLine(`[BRIDGE] showPlanApprovalDialog (${requestId})`);
    }
  }

  private readJsonFile<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private rememberApprovalForRequest(requestId: string): void {
    if (!this.globalState) {
      return;
    }
    const requestFile = path.join(this.permissionIpcDir(), `request-${this.sessionIdForPermissionIpc()}-${requestId}.json`);
    const request = this.readJsonFile<{ toolName?: string; inputs?: Record<string, unknown> }>(requestFile);
    if (!request?.toolName) {
      this.log.appendLine(`[BRIDGE] remember approval skipped: request file missing for ${requestId}`);
      return;
    }

    const nextApproval = this.buildRememberedApproval(request.toolName, request.inputs ?? {});
    const existing = this.readRememberedApprovals();
    const deduped = existing.filter((item) => !this.sameRememberedApproval(item, nextApproval));
    deduped.push(nextApproval);
    void this.globalState.update(REMEMBERED_TOOL_APPROVALS_KEY, deduped);
    this.log.appendLine(`[BRIDGE] remembered permission for ${request.toolName} (${requestId})`);
    this.deleteFileQuietly(requestFile, 'approved permission request');
  }

  private readRememberedApprovals(): RememberedApproval[] {
    if (!this.globalState) {
      return [];
    }
    const raw = this.globalState.get<RememberedApproval[]>(REMEMBERED_TOOL_APPROVALS_KEY, []);
    return Array.isArray(raw) ? raw.filter((item) => item && typeof item.toolName === 'string') : [];
  }

  private buildRememberedApproval(toolName: string, inputs: Record<string, unknown>): RememberedApproval {
    return {
      toolName,
      command: this.asTrimmedString(inputs.command),
      cwd: this.asTrimmedString(inputs.cwd),
      path: this.asTrimmedString(inputs.file_path)
        || this.asTrimmedString(inputs.path)
        || this.asTrimmedString(inputs.target_file),
    };
  }

  private isRememberedApproval(toolName: string, inputs: Record<string, unknown>): boolean {
    const candidate = this.buildRememberedApproval(toolName, inputs);
    return this.readRememberedApprovals().some((item) => this.sameRememberedApproval(item, candidate));
  }

  private sameRememberedApproval(left: RememberedApproval, right: RememberedApproval): boolean {
    return left.toolName === right.toolName
      && (left.command || '') === (right.command || '')
      && (left.cwd || '') === (right.cwd || '')
      && (left.path || '') === (right.path || '');
  }

  private asTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private isStaleRequestFile(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      return (Date.now() - stats.mtimeMs) > STALE_PERMISSION_REQUEST_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private deleteFileQuietly(filePath: string, label: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.log.appendLine(`[BRIDGE] deleted ${label}: ${path.basename(filePath)}`);
      }
    } catch (error) {
      this.log.appendLine(`[BRIDGE] failed deleting ${label}: ${error}`);
    }
  }

  private postDialogRequest(
    webview: vscode.Webview,
    functionName: string,
    pendingQueueName: string,
    payload: unknown,
  ): void {
    const stringArg = JSON.stringify(JSON.stringify(payload));
    const evalContent = [
      'try{',
      'var _d=',
      stringArg,
      ';',
      `if (typeof window.${functionName}==='function'){window.${functionName}(_d);}`,
      'else{',
      `var a=window.${pendingQueueName}=window.${pendingQueueName}||[];`,
      'a.push(_d);',
      '};',
      `}catch(e){console.error('[BRIDGE] ${functionName}',e);}`,
    ].join('');
    webview.postMessage({ type: 'js_eval', content: evalContent });
  }
}
