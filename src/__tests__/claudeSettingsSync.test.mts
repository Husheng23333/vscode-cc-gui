import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planClaudeSettingsSync } from '../bridge/services/claudeSettingsSync.ts';

function buildProvider(id: string, model: string) {
  return {
    id,
    name: `Test Provider ${id}`,
    isActive: true,
    settingsConfig: {
      model,
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-provider-key',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    },
  };
}

describe('planClaudeSettingsSync (repair-only)', () => {
  it('skips local settings mode so user/cc-switch credentials stay intact', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      { id: '__local_settings_json__', isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'sync-exempt-mode' });
  });

  it('skips CLI login mode without touching settings.json', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      { id: '__cli_login__', isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'sync-exempt-mode' });
  });

  it('skips when no provider is active', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      null,
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'sync-exempt-mode' });
  });

  it('skips managed providers that have an empty env payload', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' }, model: 'claude-opus-4-8' },
      { id: 'proxy-a', settingsConfig: { model: 'claude-opus-4-8' }, isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'empty-env-payload' });
  });

  it('skips providers without settingsConfig as a graceful no-op', () => {
    const decision = planClaudeSettingsSync(undefined, { id: 'p1', isActive: true });
    assert.deepEqual(decision, { action: 'skip', reason: 'empty-env-payload' });
  });

  it('fills in missing fields on a fresh install', () => {
    const decision = planClaudeSettingsSync(undefined, buildProvider('p1', 'claude-sonnet-4-6'));
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.model, 'claude-sonnet-4-6');
    assert.equal(decision.nextSettings.env.ANTHROPIC_API_KEY, 'sk-ant-provider-key');
    assert.equal(decision.nextSettings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal(decision.nextSettings.codemossProviderId, 'p1');
  });

  it('never overwrites existing values (genuine no-op when all fields present)', () => {
    const current = {
      model: 'user-picked-model',
      codemossProviderId: 'p1',
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-USER-KEY',
        ANTHROPIC_BASE_URL: 'https://user-proxy.example.com',
      },
    };
    const decision = planClaudeSettingsSync(current, buildProvider('p1', 'claude-sonnet-4-6'));
    assert.deepEqual(decision, { action: 'skip', reason: 'nothing-to-repair' });
    // Input settings object must not be mutated.
    assert.equal(current.model, 'user-picked-model');
    assert.equal(current.env.ANTHROPIC_API_KEY, 'sk-ant-USER-KEY');
  });

  it('repairs missing env keys only; existing env keys are kept', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_API_KEY: 'sk-USER' } },
      buildProvider('p1', 'claude-sonnet-4-6'),
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.env.ANTHROPIC_API_KEY, 'sk-USER');
    assert.equal(decision.nextSettings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  });

  it('does not overwrite an existing codemossProviderId', () => {
    const decision = planClaudeSettingsSync(
      { codemossProviderId: 'user-pinned-id' },
      buildProvider('p1', 'claude-sonnet-4-6'),
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.codemossProviderId, 'user-pinned-id');
  });

  it('preserves non-managed top-level fields (hooks, custom)', () => {
    const decision = planClaudeSettingsSync(
      { hooks: { PreToolUse: [] }, custom: 42 },
      buildProvider('p1', 'claude-sonnet-4-6'),
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.deepEqual(decision.nextSettings.hooks, { PreToolUse: [] });
    assert.equal(decision.nextSettings.custom, 42);
  });

  it('ignores non-managed fields carried by the provider settingsConfig', () => {
    const provider = buildProvider('p1', 'claude-sonnet-4-6');
    (provider.settingsConfig as any).hooks = { PreToolUse: ['x'] };
    (provider.settingsConfig as any).permissions = { allow: ['Bash(ls)'] };
    const decision = planClaudeSettingsSync(undefined, provider);
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal('hooks' in decision.nextSettings, false);
    assert.equal('permissions' in decision.nextSettings, false);
  });
});
