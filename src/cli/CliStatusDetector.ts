import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CLI_TOOL_DEFINITIONS,
  type CliToolDefinition,
  type CliToolId,
  type CliToolStatus,
} from './cliTools';
import { versionManagerBinDirs } from './cliBinDirs';

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;
const VERSION_TOKEN = /(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)/;
const LOGIN_SHELL_TIMEOUT_MS = 8_000;

/**
 * Shells allowed for login-env probing: `$SHELL` is attacker-influenced, so only
 * standard system/Homebrew shell binaries may be invoked.
 */
const ALLOWED_LOGIN_SHELLS = new Set([
  '/bin/zsh', '/bin/bash', '/bin/sh',
  '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/sh',
  '/usr/local/bin/zsh', '/usr/local/bin/bash',
  '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/bash',
  '/usr/local/bin/fish', '/opt/homebrew/bin/fish',
]);

interface ProbeResult {
  ok: boolean;
  version?: string;
  resolvedPath?: string;
}

interface CachedDetection {
  result: Record<string, CliToolStatus>;
  timestampMillis: number;
}

let detectAllCache: CachedDetection | null = null;

/**
 * Detects whether headless CLI tools are installed and probes their versions.
 * Path resolution mirrors ai-bridge/utils/cli-path.js.
 */
export class CliStatusDetector {
  static detectAll(force = false): Record<string, CliToolStatus> {
    const now = Date.now();
    if (!force && detectAllCache && now - detectAllCache.timestampMillis < CACHE_TTL_MS) {
      return detectAllCache.result;
    }

    const result: Record<string, CliToolStatus> = {};
    for (const tool of CLI_TOOL_DEFINITIONS) {
      result[tool.id] = this.detect(tool);
    }
    detectAllCache = { result, timestampMillis: Date.now() };
    return result;
  }

  static detect(tool: CliToolDefinition): CliToolStatus {
    try {
      if (tool.id === 'zcode') {
        return this.detectZcodeAppBundle(tool);
      }
      for (const candidate of this.candidatesFor(tool)) {
        const probe = this.probe(candidate);
        if (probe.ok) {
          return {
            id: tool.id,
            name: tool.displayName,
            binaryName: tool.binaryName,
            installed: true,
            version: probe.version,
            path: probe.resolvedPath ?? candidate,
          };
        }
      }
      // Last resort: the user's login shell. VS Code launched from Finder/launchd
      // runs with a minimal PATH, so CLIs installed via nvm/fnm/mise/asdf or
      // custom prefixes only become visible once login rc files are sourced.
      for (const binary of this.binariesFor(tool)) {
        const fromShell = this.whichViaLoginShell(binary);
        if (!fromShell) continue;
        const probe = this.probe(fromShell);
        if (probe.ok) {
          return {
            id: tool.id,
            name: tool.displayName,
            binaryName: tool.binaryName,
            installed: true,
            version: probe.version,
            path: probe.resolvedPath ?? fromShell,
          };
        }
      }
      return {
        id: tool.id,
        name: tool.displayName,
        binaryName: tool.binaryName,
        installed: false,
      };
    } catch (error) {
      return {
        id: tool.id,
        name: tool.displayName,
        binaryName: tool.binaryName,
        installed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private static candidatesFor(tool: CliToolDefinition): string[] {
    const candidates = new Set<string>();
    const binaries = this.binariesFor(tool);
    const extensions = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
    const home = os.homedir();

    for (const envKey of tool.envKeys) {
      const value = process.env[envKey]?.trim();
      if (value) candidates.add(value);
    }

    for (const rel of tool.homeBinDirs) {
      for (const ext of extensions) {
        for (const binary of binaries) {
          const full = path.join(home, rel, binary + ext);
          if (this.pathExists(full)) candidates.add(full);
        }
      }
    }

    // Shared install locations
    const sharedDirs: string[] = [];
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      sharedDirs.push(path.join(appData, 'npm'));
      if (tool.id === 'omp') {
        // OMP Windows native installer: %LOCALAPPDATA%\omp\omp(.cmd/.bat/.exe).
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        sharedDirs.push(path.join(localAppData, 'omp'));
      }
    } else {
      sharedDirs.push(
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.yarn', 'bin'),
        path.join(home, 'Library', 'pnpm'),
        path.join(home, '.local', 'share', 'pnpm'),
        path.join(home, '.local', 'bin'),
        // Version managers (nvm/fnm/mise/asdf/hermes/nvmd): npm CLIs installed
        // under per-version dirs are invisible on a sparse IDE PATH.
        ...versionManagerBinDirs(home),
      );
    }
    for (const dir of sharedDirs) {
      for (const ext of extensions) {
        for (const binary of binaries) {
          const full = path.join(dir, binary + ext);
          if (this.pathExists(full)) candidates.add(full);
        }
      }
    }

    for (const ext of extensions) {
      for (const binary of binaries) {
        candidates.add(binary + ext);
      }
    }

    return Array.from(candidates);
  }

  private static probe(candidate: string): ProbeResult {
    for (const flag of ['--version', '-v']) {
      const result = this.run([candidate, flag], this.probePathPrependDir(candidate));
      if (result.exitCode === 0 && result.stdout?.trim()) {
        return {
          ok: true,
          version: this.extractVersion(result.stdout) ?? 'unknown',
          resolvedPath: this.resolveWhichLike(candidate) ?? candidate,
        };
      }
      if (result.combined?.trim() && result.exitCode === 0) {
        const version = this.extractVersion(result.combined);
        if (version && version !== 'unknown') {
          return {
            ok: true,
            version,
            resolvedPath: this.resolveWhichLike(candidate) ?? candidate,
          };
        }
      }
    }
    return { ok: false };
  }

  private static run(command: string[], prependPathDir?: string): { exitCode: number; stdout: string; combined: string } {
    try {
      const [bin, ...args] = command;
      const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
      // npm `-g` shims use a `#!/usr/bin/env node` shebang: when the CLI lives
      // in a version-manager bin dir, its sibling `node` is not on the IDE's
      // sparse PATH and the probe dies with exit 127. Put the candidate's own
      // directory first so the shebang resolves (upstream 06fca499).
      const env = prependPathDir
        ? { ...process.env, PATH: `${prependPathDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
        : process.env;
      const stdout = cp.execFileSync(bin, args, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell,
        env: env,
      });
      return {
        exitCode: 0,
        stdout: String(stdout ?? ''),
        combined: String(stdout ?? ''),
      };
    } catch (error: any) {
      const stdout = String(error?.stdout ?? '');
      const stderr = String(error?.stderr ?? '');
      return {
        exitCode: typeof error?.status === 'number' ? error.status : 1,
        stdout,
        combined: `${stdout}\n${stderr}`.trim(),
      };
    }
  }

  private static extractVersion(text: string): string | undefined {
    const match = String(text || '').match(VERSION_TOKEN);
    return match?.[1];
  }

  private static resolveWhichLike(candidate: string): string | null {
    if (path.isAbsolute(candidate) && this.pathExists(candidate)) {
      return candidate;
    }
    try {
      const lookup = process.platform === 'win32' ? `where ${candidate}` : `which ${candidate}`;
      const output = cp.execSync(lookup, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
      const first = String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return first || null;
    } catch {
      return null;
    }
  }

  private static pathExists(candidate: string): boolean {
    try {
      return !!candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }
  private static binariesFor(tool: CliToolDefinition): string[] {
    return tool.altBinaryName ? [tool.binaryName, tool.altBinaryName] : [tool.binaryName];
  }

  /** Parent dir of an absolute candidate, for probe PATH prepend; else undefined. */
  private static probePathPrependDir(candidate: string): string | undefined {
    return path.isAbsolute(candidate) ? path.dirname(candidate) : undefined;
  }

  /**
   * Resolve a binary through the user's login shell (non-Windows only). Returns
   * an absolute path or null. Ported from ai-bridge/utils/cli-path.js
   * whichViaLoginShell (allowlisted shells, `-l -i` for nvm/fnm/mise rc files).
   */
  private static whichViaLoginShell(binaryName: string): string | null {
    if (process.platform === 'win32') return null;
    if (!/^[a-z0-9._-]+$/i.test(String(binaryName || ''))) return null;
    let shell = process.env.SHELL || '';
    if (!ALLOWED_LOGIN_SHELLS.has(shell)) {
      shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => this.pathExists(candidate)) || '';
    }
    if (!shell) return null;
    const fish = shell.endsWith('fish');
    const args = fish
      ? ['-c', `command -v ${binaryName}`]
      : ['-l', '-i', '-c', `command -v ${binaryName}`];
    try {
      const output = cp.execFileSync(shell, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
        timeout: LOGIN_SHELL_TIMEOUT_MS,
      });
      const first = String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && first.startsWith('/') && this.pathExists(first)) return first;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * ZCode ships no PATH binary: the app-server entry (zcode.cjs) is bundled
   * inside the desktop client, so detection means locating that file at the
   * well-known install locations (env override first). The resolved file path
   * plays the role of the "binary" in the status payload. Mirrors
   * ai-bridge/services/zcode/zcode-config.js resolveZcodeCliPath.
   */
  private static detectZcodeAppBundle(tool: CliToolDefinition): CliToolStatus {
    const candidates: string[] = [];
    for (const envKey of tool.envKeys) {
      const value = process.env[envKey]?.trim();
      if (value) candidates.push(value);
    }
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA;
      if (local) candidates.push(path.join(local, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
      const pf = process.env['ProgramFiles'];
      if (pf) candidates.push(path.join(pf, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
      const pf86 = process.env['ProgramFiles(x86)'];
      if (pf86) candidates.push(path.join(pf86, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
    } else {
      candidates.push('/opt/ZCode/app/resources/glm/zcode.cjs');
    }
    for (const candidate of candidates) {
      if (this.pathExists(candidate)) {
        return {
          id: tool.id,
          name: tool.displayName,
          binaryName: tool.binaryName,
          installed: true,
          version: 'unknown',
          path: candidate,
        };
      }
    }
    return { id: tool.id, name: tool.displayName, binaryName: tool.binaryName, installed: false };
  }
}

export type { CliToolId };
