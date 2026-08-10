import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexStreamingFlag, normalizeRequestedSandboxMode } from './codex-utils.js';

test('normalizeRequestedSandboxMode accepts valid Codex sandbox modes', () => {
  assert.equal(normalizeRequestedSandboxMode('read-only'), 'read-only');
  assert.equal(normalizeRequestedSandboxMode('workspace-write'), 'workspace-write');
  assert.equal(normalizeRequestedSandboxMode('danger-full-access'), 'danger-full-access');
});

test('normalizeRequestedSandboxMode trims valid request values', () => {
  assert.equal(normalizeRequestedSandboxMode('  danger-full-access  '), 'danger-full-access');
});

test('normalizeRequestedSandboxMode ignores empty and invalid values', () => {
  assert.equal(normalizeRequestedSandboxMode(''), '');
  assert.equal(normalizeRequestedSandboxMode('full-access'), '');
  assert.equal(normalizeRequestedSandboxMode(null), '');
  assert.equal(normalizeRequestedSandboxMode({}), '');
});

test('normalizeCodexStreamingFlag defaults to true when omitted', () => {
  assert.equal(normalizeCodexStreamingFlag(null), true);
  assert.equal(normalizeCodexStreamingFlag(undefined), true);
  assert.equal(normalizeCodexStreamingFlag(''), true);
});

test('normalizeCodexStreamingFlag accepts explicit true/false-like values', () => {
  assert.equal(normalizeCodexStreamingFlag(true), true);
  assert.equal(normalizeCodexStreamingFlag('true'), true);
  assert.equal(normalizeCodexStreamingFlag('1'), true);
  assert.equal(normalizeCodexStreamingFlag(false), false);
  assert.equal(normalizeCodexStreamingFlag('false'), false);
  assert.equal(normalizeCodexStreamingFlag('0'), false);
  assert.equal(normalizeCodexStreamingFlag('off'), false);
});
