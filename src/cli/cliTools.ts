/**
 * Headless CLI tools shown under Settings → Provider Management → CLI.
 * Detection only — the plugin never auto-installs these binaries.
 */

export type CliToolId = 'grok' | 'kimi' | 'opencode' | 'pi' | 'omp' | 'dsh' | 'zcode' | 'minimax';

export const CLI_ONLY_PROVIDERS = new Set<string>(['grok', 'kimi', 'opencode', 'pi', 'omp', 'dsh', 'zcode', 'minimax']);

export function isCliOnlyProvider(providerId: string | null | undefined): boolean {
  return !!providerId && CLI_ONLY_PROVIDERS.has(providerId);
}

export function isRuntimeProvider(providerId: string | null | undefined): boolean {
  return providerId === 'claude' || providerId === 'codex' || isCliOnlyProvider(providerId);
}

/** Providers with a first-class history reader (local files or, for DSH, host RPC; ZCode queries its app-server live). */
export const HISTORY_SUPPORTED_PROVIDERS = new Set<string>(['claude', 'codex', 'grok', 'omp', 'dsh', 'zcode', 'minimax']);

/**
 * True when the history panel can list/load sessions for this runtime.
 * Kimi / OpenCode / PI chat works, but they have no local history index yet —
 * they must not fall through to Claude/Codex session stores. DSH history is
 * served by the persistent `dsh web` host over RPC (never local files); OMP
 * history is read from `~/.omp/agent/sessions/` (PI-fork jsonl layout).
 */
export function hasLocalHistorySupport(providerId: string | null | undefined): boolean {
  return !!providerId && HISTORY_SUPPORTED_PROVIDERS.has(providerId);
}

export interface CliToolStatus {
  id: CliToolId;
  name: string;
  binaryName: string;
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface CliToolDefinition {
  id: CliToolId;
  displayName: string;
  binaryName: string;
  /** Secondary command name to probe when the primary one is not found
   *  (e.g. MiniMax Code: `minimax` from the official installer, `mcode` from npm). */
  altBinaryName?: string;
  envKeys: string[];
  homeBinDirs: string[];
}

export const CLI_TOOL_DEFINITIONS: CliToolDefinition[] = [
  {
    id: 'grok',
    displayName: 'Grok CLI',
    binaryName: 'grok',
    envKeys: ['GROK_BIN', 'GROK_PATH', 'GROK_CLI_PATH'],
    homeBinDirs: ['.grok/bin', '.local/bin'],
  },
  {
    id: 'kimi',
    displayName: 'Kimi CLI',
    binaryName: 'kimi',
    envKeys: ['KIMI_BIN', 'KIMI_PATH', 'KIMI_CLI_PATH', 'KIMI_CODE_BIN'],
    homeBinDirs: ['.kimi-code/bin', '.kimi/bin', '.moonshot/bin', '.local/bin'],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeBinDirs: ['.opencode/bin', '.local/share/opencode/bin', '.local/bin'],
  },
  {
    id: 'pi',
    displayName: 'PI CLI',
    binaryName: 'pi',
    envKeys: ['PI_BIN', 'PI_PATH', 'PI_CLI_PATH'],
    homeBinDirs: ['.pi/bin', '.local/bin'],
  },
  {
    id: 'omp',
    displayName: 'OMP CLI',
    binaryName: 'omp',
    envKeys: ['OMP_BIN', 'OMP_PATH', 'OMP_CLI_PATH'],
    homeBinDirs: ['.omp/bin', '.local/bin'],
  },
  {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    binaryName: 'dsh',
    envKeys: ['DSH_BIN', 'DSH_PATH', 'DSH_CLI_PATH'],
    // Hermes (the DSH-native installer) keeps node + dsh together.
    homeBinDirs: ['.hermes/node/bin', '.dsh/bin', '.local/bin'],
  },
  {
    id: 'zcode',
    displayName: 'ZCode',
    // No PATH binary: the app-server entry (zcode.cjs) lives inside the
    // desktop app bundle; CliStatusDetector probes the bundle locations.
    binaryName: 'zcode',
    envKeys: ['ZCODE_CLI_PATH', 'ZCODE_PATH'],
    homeBinDirs: [],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax Code',
    binaryName: 'minimax',
    // Official installer exposes `minimax`; npm global installs expose `mcode`.
    altBinaryName: 'mcode',
    envKeys: ['MINIMAX_BIN', 'MINIMAX_PATH', 'MINIMAX_CLI_PATH', 'MCODE_BIN'],
    homeBinDirs: ['.minimax/bin', '.minimax-code', '.local/bin'],
  },
];

export function getCliToolDefinition(id: string): CliToolDefinition | undefined {
  return CLI_TOOL_DEFINITIONS.find((tool) => tool.id === id);
}
