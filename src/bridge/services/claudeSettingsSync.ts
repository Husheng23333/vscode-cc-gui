/**
 * Helpers for syncing Claude provider config into ~/.claude/settings.json.
 * Extracted so the repair-only ("fill in the blanks") rules can be unit-tested.
 *
 * Repair-only contract (aligned with the JetBrains plugin's
 * ClaudeSettingsManager.repairMissingProviderFields):
 * - Only ADD provider-managed fields that are missing from settings.json;
 *   never overwrite a value the user already has. env keys are judged
 *   independently (a user-set env key is never touched).
 * - Top-level non-managed fields (hooks, permissions, custom) are preserved.
 * - Local settings / CLI login / disabled modes never touch settings.json.
 * - A provider with a missing or empty settingsConfig.env payload is skipped
 *   entirely: incomplete state must not touch settings.json, not even additively.
 */

/**
 * Provider-managed top-level fields — only these may be added by the repair
 * pass. Everything else in settings.json (hooks, permissions, mcpServers, …)
 * is user-owned and always preserved.
 */
export const CLAUDE_PROVIDER_MANAGED_FIELDS = [
  'env',
  'model',
  'alwaysThinkingEnabled',
  'codemossProviderId',
  'ccSwitchProviderId',
  'maxContextLengthTokens',
  'temperature',
  'topP',
  'topK',
] as const;

export type ClaudeSettingsSyncDecision =
  | { action: 'skip'; reason: string }
  | { action: 'write'; nextSettings: Record<string, any> };

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decide whether / how to repair settings.json for the active Claude provider.
 * Returns skip when the mode is exempt (local settings / CLI login / disabled /
 * no active provider), when the provider carries no usable env payload, or when
 * there is nothing missing to fill in.
 */
export function planClaudeSettingsSync(
  currentSettings: Record<string, any> | null | undefined,
  active: any | null | undefined,
): ClaudeSettingsSyncDecision {
  if (
    !active ||
    active.id === '__local_settings_json__' ||
    active.id === '__cli_login__' ||
    active.id === '__disabled__'
  ) {
    return { action: 'skip', reason: 'sync-exempt-mode' };
  }

  const settingsConfig = isPlainObject(active?.settingsConfig) ? active.settingsConfig : null;
  const envPayload = settingsConfig && isPlainObject(settingsConfig.env)
    ? (settingsConfig.env as Record<string, unknown>)
    : null;
  if (!envPayload || Object.keys(envPayload).length === 0) {
    // Missing settingsConfig or empty env = incomplete state (e.g. a failed
    // cc-switch read); must not touch settings.json, not even additively.
    return { action: 'skip', reason: 'empty-env-payload' };
  }

  const settings: Record<string, any> = isPlainObject(currentSettings)
    ? { ...currentSettings }
    : {};
  let changed = false;

  // 1. Fill in missing top-level provider-managed fields; never overwrite an
  //    existing value (env is merged key-by-key below).
  for (const key of CLAUDE_PROVIDER_MANAGED_FIELDS) {
    if (key === 'env') {
      continue;
    }
    const value = settingsConfig![key];
    if (value === null || value === undefined) {
      continue;
    }
    if (key in settings) {
      continue;
    }
    settings[key] = value;
    changed = true;
  }

  // 2. env: add only the keys the user does not already have. An existing
  //    non-object env is corrupt but user-owned — leave it untouched.
  if (!('env' in settings)) {
    settings.env = { ...envPayload };
    changed = true;
  } else if (isPlainObject(settings.env)) {
    const env = { ...settings.env };
    for (const [envKey, envValue] of Object.entries(envPayload)) {
      if (envValue === null || envValue === undefined) {
        continue;
      }
      if (envKey in env) {
        continue;
      }
      env[envKey] = envValue;
      changed = true;
    }
    settings.env = env;
  }

  // 3. codemossProviderId is only set when missing — switching providers must
  //    keep using the explicit switch path.
  if (typeof active.id === 'string' && active.id) {
    if (!('codemossProviderId' in settings) || settings.codemossProviderId === null) {
      settings.codemossProviderId = active.id;
      changed = true;
    }
  }

  if (!changed) {
    return { action: 'skip', reason: 'nothing-to-repair' };
  }
  return { action: 'write', nextSettings: settings };
}
