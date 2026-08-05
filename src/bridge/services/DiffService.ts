import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type CallWebviewJson = (webview: vscode.Webview, functionName: string, payload: unknown) => void;

interface UndoOperation {
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
}

interface UndoFileRequest {
  filePath?: string;
  status?: string;
  operations?: UndoOperation[];
}

export class DiffService {
  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly callWebviewJson: CallWebviewJson,
  ) {}

  async showDiff(content: string): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      const oldContent = data.oldContent ?? '';
      const newContent = data.newContent ?? '';
      const title = data.title ?? path.basename(filePath);

      const oldUri = await this.writeTempFile(`${filePath}.ccg-old`, oldContent);
      const newUri = await this.writeTempFile(`${filePath}.ccg-new`, newContent);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch {
      // Diff preview is best-effort; ai-bridge keeps the source file-change data.
    }
  }

  async showInteractiveDiff(content: string, webview: vscode.Webview): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      const newContents = String(data.newFileContents ?? data.newContent ?? '');
      const isNewFile = data.isNewFile === true;
      const title = data.tabName ?? `${path.basename(filePath)} (proposed)`;

      if (isNewFile) {
        const action = await vscode.window.showInformationMessage(
          `AI wants to create: ${path.basename(filePath)}`,
          'Create File',
          'Cancel',
        );
        if (action === 'Create File') {
          await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newContents, 'utf8'));
          await vscode.window.showTextDocument(vscode.Uri.file(filePath));
          webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: true }) });
        }
        return;
      }

      const originalContent = await this.readFileIfExists(filePath);
      const oldUri = await this.writeTempFile(`${filePath}.ccg-original`, originalContent);
      const newUri = await this.writeTempFile(`${filePath}.ccg-proposed`, newContents);

      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);

      const action = await vscode.window.showInformationMessage(
        `Apply changes to ${path.basename(filePath)}?`,
        'Apply',
        'Reject',
      );

      try {
        await vscode.workspace.fs.delete(oldUri);
        await vscode.workspace.fs.delete(newUri);
      } catch {
        // Ignore cleanup failures for temporary diff buffers.
      }

      if (action === 'Apply') {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newContents, 'utf8'));
        webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: true }) });
      } else {
        webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: false }) });
      }
    } catch {
      // Keep the legacy behavior: failed preview generation should not interrupt streaming.
    }
  }

  async showEditDiff(_event: string, content: string): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      const originalContent = await this.readFileIfExists(filePath);

      let newContent = originalContent;
      const edits: UndoOperation[] = Array.isArray(data.edits)
        ? data.edits
        : data.oldString !== undefined
          ? [{ oldString: data.oldString, newString: data.newString, replaceAll: data.replaceAll }]
          : [];

      for (const edit of edits) {
        const oldString = typeof edit.oldString === 'string' ? edit.oldString : '';
        const newString = typeof edit.newString === 'string' ? edit.newString : '';
        if (edit.replaceAll) {
          newContent = newContent.split(oldString).join(newString);
        } else {
          newContent = newContent.replace(oldString, newString);
        }
      }

      const title = data.title ?? `${path.basename(filePath)} (edit preview)`;
      const oldUri = await this.writeTempFile(`${filePath}.ccg-old`, originalContent);
      const newUri = await this.writeTempFile(`${filePath}.ccg-new`, newContent);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch {
      // Keep edit previews non-fatal, matching the IDEA bridge behavior.
    }
  }

  async undoFileChanges(content: string, webview: vscode.Webview): Promise<void> {
    const request = this.safeJson<UndoFileRequest>(content, {});
    const filePath = String(request.filePath ?? '');
    try {
      await this.applyUndoFileChange(request);
      this.callWebviewJson(webview, 'onUndoFileResult', { success: true, filePath });
    } catch (error) {
      this.callWebviewJson(webview, 'onUndoFileResult', {
        success: false,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async undoAllFileChanges(content: string, webview: vscode.Webview): Promise<void> {
    const request = this.safeJson<any>(content, {});
    const files = Array.isArray(request.files) ? request.files : [];
    if (files.length === 0) {
      this.callWebviewJson(webview, 'onUndoAllFileResult', { success: false, error: 'No files to undo' });
      return;
    }

    let count = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        await this.applyUndoFileChange(file);
        count += 1;
      } catch (error) {
        const filePath = String(file?.filePath ?? '');
        errors.push(`${filePath || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0 && count === 0) {
      this.callWebviewJson(webview, 'onUndoAllFileResult', { success: false, error: errors.join('; ') });
      return;
    }

    this.callWebviewJson(webview, 'onUndoAllFileResult', {
      success: true,
      count,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    });
  }

  private async applyUndoFileChange(request: UndoFileRequest): Promise<void> {
    const filePath = String(request?.filePath ?? '');
    const status = String(request?.status ?? '');
    if (!filePath) throw new Error('File path is required');
    this.assertPathInWorkspace(filePath);

    if (status === 'A') {
      const uri = vscode.Uri.file(filePath);
      try {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      } catch (error: any) {
        if (error?.code !== 'FileNotFound') throw error;
      }
      return;
    }

    if (status !== 'M') {
      throw new Error(`Unknown file status: ${status}`);
    }

    const operations = Array.isArray(request?.operations) ? request.operations : [];
    if (operations.length === 0) throw new Error('No operations to undo');

    const uri = vscode.Uri.file(filePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    let text = Buffer.from(bytes).toString('utf8');

    for (let i = operations.length - 1; i >= 0; i -= 1) {
      const op = operations[i] ?? {};
      const oldString = typeof op.oldString === 'string' ? op.oldString : '';
      const newString = typeof op.newString === 'string' ? op.newString : '';
      const replaceAll = op.replaceAll === true;
      if (!newString) continue;
      if (replaceAll) {
        text = text.split(newString).join(oldString);
      } else {
        const index = text.indexOf(newString);
        if (index >= 0) {
          text = text.slice(0, index) + oldString + text.slice(index + newString.length);
        }
      }
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }

  private assertPathInWorkspace(filePath: string): void {
    const workspacePath = path.resolve(this.getWorkspacePath() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
    if (!workspacePath) throw new Error('Workspace path is not available');
    const resolved = path.resolve(filePath);
    if (resolved !== workspacePath && !resolved.startsWith(workspacePath + path.sep)) {
      throw new Error('Invalid file path: path must be inside the workspace');
    }
  }

  private async writeTempFile(filePath: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
  }

  private async readFileIfExists(filePath: string): Promise<string> {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  private safeJson<T>(content: string, fallback: T): T {
    try {
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }
}
