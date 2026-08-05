import * as vscode from 'vscode';
import { BridgeServer } from './bridge';

export interface QuickFixCommandArgs {
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

export class ClaudeQuickFixProvider implements vscode.CodeActionProvider {
  constructor(private readonly bridge: BridgeServer) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (context.diagnostics.length === 0) return [];

    return context.diagnostics.map(diag => {
      const action = new vscode.CodeAction(
        `Fix with Claude: ${diag.message.slice(0, 60)}${diag.message.length > 60 ? '...' : ''}`,
        vscode.CodeActionKind.QuickFix
      );
      action.command = {
        command: 'ccGui.quickFixWithClaude',
        title: 'Fix with Claude',
        arguments: [{ uri: document.uri, diagnostic: diag } satisfies QuickFixCommandArgs],
      };
      action.diagnostics = [diag];
      return action;
    });
  }
}
