import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export class NodeDetector {
  static find(context: vscode.ExtensionContext): string | undefined {
    // 1. User config
    const config = vscode.workspace.getConfiguration('ccGui');
    const customPath = config.get<string>('nodePath');
    if (customPath && fs.existsSync(customPath)) return customPath;

    // 2. Common locations
    const candidates = [
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/bin/node',
      process.execPath, // VSCode's own node
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // 3. PATH lookup
    try {
      const result = cp.execSync('which node', { encoding: 'utf8' }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* ignore */ }

    return undefined;
  }

  static findNpm(context: vscode.ExtensionContext): string | undefined {
    // 1. Derive from node path — npm always co-located with node
    const nodePath = NodeDetector.find(context);
    if (nodePath) {
      const npmPath = path.join(path.dirname(nodePath), 'npm');
      if (fs.existsSync(npmPath)) return npmPath;
    }

    // 2. Common fixed locations
    const candidates = [
      '/usr/local/bin/npm',
      '/usr/bin/npm',
      '/opt/homebrew/bin/npm',
      '/opt/homebrew/opt/node/bin/npm',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // 3. Login shell lookup — resolves nvm/fnm managed npm
    try {
      const loginShell = process.env.SHELL || '/bin/zsh';
      const result = cp.execSync(`${loginShell} -l -c 'which npm 2>/dev/null'`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* ignore */ }

    return undefined;
  }
}
