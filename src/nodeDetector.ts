import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import {
  getCommonNodeCandidates,
  getCommonNpmCandidates,
  getNpmCandidatesFromNodePath,
  isLikelyNodeExecutable,
} from './nodeDetectorUtils';

export class NodeDetector {
  static find(context: vscode.ExtensionContext): string | undefined {
    // 1. User config
    const config = vscode.workspace.getConfiguration('ccGui');
    const customPath = config.get<string>('nodePath');
    if (customPath && fs.existsSync(customPath) && isLikelyNodeExecutable(customPath)) return customPath;

    // 2. Common locations
    const candidates = [
      ...getCommonNodeCandidates(process.platform, process.env),
      ...(isLikelyNodeExecutable(process.execPath) ? [process.execPath] : []),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c) && isLikelyNodeExecutable(c)) return c;
    }

    // 3. PATH lookup
    try {
      const lookup = process.platform === 'win32' ? 'where node' : 'which node';
      const result = cp.execSync(lookup, { encoding: 'utf8' }).trim();
      const first = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && fs.existsSync(first) && isLikelyNodeExecutable(first)) return first;
    } catch { /* ignore */ }

    return undefined;
  }

  static findNpm(context: vscode.ExtensionContext): string | undefined {
    // 1. Derive from node path - npm is usually co-located with node
    const nodePath = NodeDetector.find(context);
    if (nodePath) {
      for (const npmPath of getNpmCandidatesFromNodePath(nodePath, process.platform)) {
        if (fs.existsSync(npmPath)) return npmPath;
      }
    }

    // 2. Common fixed locations
    const candidates = getCommonNpmCandidates(process.platform, process.env);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // 3. PATH lookup
    try {
      const lookup = process.platform === 'win32' ? 'where npm' : 'which npm';
      const result = cp.execSync(lookup, { encoding: 'utf8', timeout: 5000 }).trim();
      const first = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch { /* ignore */ }

    return undefined;
  }
}
