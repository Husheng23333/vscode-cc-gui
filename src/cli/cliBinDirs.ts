/**
 * Common user-level CLI install dirs, ported from ai-bridge/utils/cli-path.js
 * (versionManagerBinDirs / commonCliBinDirs). IDEs launched from Finder/launchd
 * get a sparse PATH, so npm CLIs installed under version-manager dirs or tool
 * shims are invisible unless these locations are scanned directly.
 *
 * Shared by CliStatusDetector (binary probing) and bridge.ts (daemon env PATH).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Numeric-descending compare for names like `v22.22.3` / `24.11.1`. */
function compareVersionNamesDesc(a: string, b: string): number {
  const pa = a.split(/\D+/).filter(Boolean).map(Number);
  const pb = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Directory names under `root` that look like versions, newest first. */
function listVersionDirsDesc(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => /\d/.test(name))
    .sort(compareVersionNamesDesc);
}

/**
 * Node version-manager global bin dirs. Each dir also contains its own `node`,
 * so adding these to a spawn PATH lets `#!/usr/bin/env node` npm shims launch.
 * Newest versions first. Windows managers install onto PATH directly — skipped.
 */
export function versionManagerBinDirs(home: string = os.homedir()): string[] {
  const dirs: string[] = [];
  if (!home) return dirs;
  if (process.platform === 'win32') return dirs;
  // Static single-node managers (bin dir sits next to the managed node).
  dirs.push(
    path.join(home, '.hermes', 'node', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.nvmd', 'bin'),
  );
  // Per-version managers: one global bin dir per installed node version.
  const versionedRoots: Array<{ root: string; binSub: string[] }> = [
    { root: path.join(home, '.nvm', 'versions', 'node'), binSub: ['bin'] },
    { root: path.join(home, '.local', 'share', 'fnm', 'node-versions'), binSub: ['installation', 'bin'] },
    { root: path.join(home, '.local', 'share', 'mise', 'installs', 'node'), binSub: ['bin'] },
    { root: path.join(home, '.asdf', 'installs', 'nodejs'), binSub: ['bin'] },
  ];
  for (const { root, binSub } of versionedRoots) {
    for (const version of listVersionDirsDesc(root)) {
      dirs.push(path.join(root, version, ...binSub));
    }
  }
  return dirs;
}

/**
 * Common user-level CLI install dirs (IDE PATH is often sparse / no login
 * shell). Used both for binary resolution and spawn PATH enrichment.
 */
export function commonCliBinDirs(home: string = os.homedir()): string[] {
  const dirs: string[] = [];
  if (!home) return dirs;
  dirs.push(
    path.join(home, '.kimi-code', 'bin'),
    path.join(home, '.kimi', 'bin'),
    path.join(home, '.moonshot', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'share', 'opencode', 'bin'),
    path.join(home, '.grok', 'bin'),
    path.join(home, '.pi', 'bin'),
    path.join(home, '.omp', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.minimax', 'bin'),
    path.join(home, '.minimax-code'),
    path.join(home, '.claude', 'bin'),
    path.join(home, '.yarn', 'bin'),
    // pnpm global installs (PNPM_HOME defaults per platform)
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
  );
  // Version-manager dirs carry both the npm-installed CLI shims and the `node`
  // those `#!/usr/bin/env node` shims need at spawn time.
  dirs.push(...versionManagerBinDirs(home));
  if (process.platform === 'win32') {
    // npm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Roaming\npm).
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'npm'));
    // OMP Windows native installer (e.g. C:\Users\<user>\AppData\Local\omp).
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(path.join(localAppData, 'omp'));
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    dirs.push(path.join(programFiles, 'nodejs'));
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) dirs.push(path.join(programFilesX86, 'nodejs'));
  }
  return dirs;
}
