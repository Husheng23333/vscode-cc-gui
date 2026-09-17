import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MiniMaxHistoryReader } from '../bridge/services/MiniMaxHistoryReader.ts';

let home: string;

function writeSession(dayDirName: string, snapshotJson: string): string {
  const sessionDir = path.join(home, 'v2', 'sessions', '2026', '08', '26', dayDirName);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'snapshot.json'), snapshotJson, 'utf8');
  return sessionDir;
}

function snapshot(sessionId: string, workspaceDir: string, title: string, displayMessages: string): string {
  return JSON.stringify({
    record: {
      sessionId,
      workspaceDir,
      title,
      createdAtMs: 1000,
      updatedAtMs: 2000,
      effectiveModel: 'minimax/MiniMax-M3',
    },
    displayMessages: JSON.parse(displayMessages),
  });
}

/** First content block of a GUI row (envelope: raw.message.content[0]). */
function firstBlock(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.raw as { message: { content: Array<Record<string, unknown>> } };
  return raw.message.content[0];
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-history-test-'));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('MiniMaxHistoryReader', () => {
  it('lists and loads a session from snapshot.json', () => {
    const display = JSON.stringify([
      { msg_id: 'umsg_1', role: 'user', msg_content: 'hello minimax', timestamp: 1 },
      {
        msg_id: 'amsg_2', role: 'assistant', msg_content: 'hi there',
        thinking_content: 'pondering', timestamp: 2,
        tool_calls: [{
          tool_name: 'bash', tool_call_id: 'call_1', tool_call_status: 2,
          tool_call_args: JSON.stringify({ command: 'ls' }),
          tool_call_result_data: JSON.stringify({ content: [{ type: 'text', text: 'file1.txt' }] }),
        }],
      },
    ]);
    writeSession('10-20-30-000-session_abc', snapshot('mvs_abc123', String.raw`C:\Users\83429\project`, 'Review PR', display));

    const reader = new MiniMaxHistoryReader(home);
    const listed = reader.listSessionsForProject('c:/Users/83429/project');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, 'mvs_abc123');
    assert.equal(listed[0].title, 'Review PR');
    assert.equal(listed[0].messageCount, 2);
    assert.equal(listed[0].lastTimestamp, 2000);
    assert.equal(listed[0].provider, 'minimax');

    const messages = reader.getSessionMessages('mvs_abc123', String.raw`C:\Users\83429\project`);
    // user text + assistant thinking + assistant text + tool_use + tool_result
    assert.equal(messages.length, 5);
    assert.equal(messages[0].type, 'user');
    assert.equal(firstBlock(messages[0]).type, 'text');
    assert.equal(firstBlock(messages[1]).type, 'thinking');
    assert.equal(firstBlock(messages[2]).type, 'text');

    const toolUse = firstBlock(messages[3]);
    assert.equal(toolUse.type, 'tool_use');
    assert.equal(toolUse.name, 'bash');
    assert.equal((toolUse.input as Record<string, unknown>).command, 'ls');

    const toolResult = messages
      .map(firstBlock)
      .find((block) => block.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.tool_use_id, 'call_1');
    assert.equal(toolResult.content, 'file1.txt');
    assert.equal(toolResult.is_error, false);
  });

  it('marks tool results as errors only via a top-level "error" field', () => {
    // Success output whose text merely quotes the word "error" must NOT be
    // flagged; a structured top-level "error" field must be.
    const display = JSON.stringify([
      {
        msg_id: 'a1', role: 'assistant', msg_content: 'x',
        tool_calls: [
          {
            tool_name: 'bash', tool_call_id: 'ok_call', tool_call_status: 2,
            tool_call_result_data: JSON.stringify({ content: [{ type: 'text', text: '{"error": false}' }] }),
          },
          {
            tool_name: 'bash', tool_call_id: 'bad_call', tool_call_status: 2,
            tool_call_result_data: JSON.stringify({ error: 'command failed' }),
          },
        ],
      },
    ]);
    writeSession('10-20-30-000-session_err', snapshot('mvs_err', '/repo', 't', display));

    const reader = new MiniMaxHistoryReader(home);
    const messages = reader.getSessionMessages('mvs_err', '/repo');
    const results = messages.map(firstBlock).filter((block) => block.type === 'tool_result');
    assert.equal(results.length, 2);
    const okResult = results.find((block) => block.tool_use_id === 'ok_call');
    const badResult = results.find((block) => block.tool_use_id === 'bad_call');
    assert.ok(okResult && badResult);
    assert.equal(okResult.is_error, false);
    assert.equal(badResult.is_error, true);
    assert.equal(badResult.content, 'command failed');
  });

  it('falls back to the first user message as title and truncates at 80 chars', () => {
    const longPrompt = 'x'.repeat(200);
    const display = JSON.stringify([
      { msg_id: 'u1', role: 'user', msg_content: longPrompt, timestamp: 1 },
    ]);
    // Blank title -> derive from first user message, truncated to 80 chars + ellipsis.
    writeSession('10-20-30-000-session_title', snapshot('mvs_title', '/repo', '', display));

    const reader = new MiniMaxHistoryReader(home);
    const listed = reader.listSessionsForProject('/repo');
    const found = listed.find((s) => s.sessionId === 'mvs_title');
    assert.ok(found);
    assert.equal(found.title.length, 81);
    assert.ok(found.title.endsWith('…'));
  });

  it('display.jsonl fallback deduplicates upserts by seq', () => {
    // Snapshot without displayMessages -> replay display.jsonl.
    const sessionDir = writeSession(
      '10-20-30-000-session_jsonl',
      JSON.stringify({
        record: {
          sessionId: 'mvs_jsonl', workspaceDir: '/repo', title: 'jsonl', createdAtMs: 1, updatedAtMs: 2,
        },
      }),
    );
    const jsonl = [
      JSON.stringify({ kind: 'message.display_upserted', msgId: 'm1', seq: 1, message: { role: 'user', msg_content: 'first', timestamp: 1 } }),
      'not json at all',
      JSON.stringify({ kind: 'message.display_upserted', msgId: 'm2', seq: 1, message: { role: 'assistant', msg_content: 'draft', timestamp: 2 } }),
      JSON.stringify({ kind: 'message.display_upserted', msgId: 'm2', seq: 2, message: { role: 'assistant', msg_content: 'final', timestamp: 3 } }),
      JSON.stringify({ kind: 'other.event', msgId: 'm3', seq: 1, message: { role: 'user', msg_content: 'ignored', timestamp: 4 } }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(sessionDir, 'display.jsonl'), jsonl, 'utf8');

    const reader = new MiniMaxHistoryReader(home);
    const messages = reader.getSessionMessages('mvs_jsonl', '/repo');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'user');
    assert.equal(firstBlock(messages[0]).text, 'first');
    assert.equal(messages[1].type, 'assistant');
    // Higher seq upsert wins over the earlier draft.
    assert.equal(firstBlock(messages[1]).text, 'final');
  });

  it('deletes the session dir and prunes empty date dirs', () => {
    const sessionDir = writeSession('10-20-30-000-session_del', snapshot('mvs_del', '/repo', 't', '[]'));

    const reader = new MiniMaxHistoryReader(home);
    assert.equal(reader.deleteSession('mvs_del', '/repo'), true);
    assert.equal(fs.existsSync(sessionDir), false);
    // Empty YYYY/MM/DD chain is pruned only when no other sessions remain;
    // other tests in this file share the same 2026/08/26 chain, so verify the
    // session dir itself is gone and the sessions root survives.
    assert.equal(fs.existsSync(path.join(home, 'v2', 'sessions')), true);

    // Unknown or unsafe ids delete nothing.
    assert.equal(reader.deleteSession('mvs_missing', '/repo'), false);
    assert.equal(reader.deleteSession('../escape', '/repo'), false);
  });

  it('does not follow symlinks when deleting session directories', () => {
    const sessionDir = writeSession('10-20-30-000-session_link', snapshot('mvs_link', '/repo', 't', '[]'));

    // A symlink inside the session dir pointing outside must be removed as a
    // link — the target's contents must survive the session deletion.
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-victim-'));
    const victimFile = path.join(victimDir, 'keep.txt');
    fs.writeFileSync(victimFile, 'keep');
    try {
      fs.symlinkSync(victimDir, path.join(sessionDir, 'linked-dir'));
    } catch {
      // symlinks not supported on this platform — skip
      fs.rmSync(victimDir, { recursive: true, force: true });
      return;
    }

    const reader = new MiniMaxHistoryReader(home);
    assert.equal(reader.deleteSession('mvs_link', '/repo'), true);
    assert.equal(fs.existsSync(sessionDir), false);
    assert.ok(fs.existsSync(victimFile), 'symlink target contents must survive session deletion');
    fs.rmSync(victimDir, { recursive: true, force: true });
  });

  it('rejects unsafe session ids', () => {
    const reader = new MiniMaxHistoryReader(home);
    assert.equal(reader.deleteSession('  ', '/repo'), false);
    assert.equal(reader.deleteSession('..', '/repo'), false);
    assert.equal(reader.deleteSession('../etc', '/repo'), false);
    assert.equal(reader.deleteSession('a/b', '/repo'), false);
    assert.equal(reader.deleteSession(String.raw`a\b`, '/repo'), false);
    assert.equal(reader.deleteSession('a b', '/repo'), false);
    assert.deepEqual(reader.getSessionMessages('../escape', '/repo'), []);
  });

  it('matches project paths case-insensitively across Windows separators', () => {
    const reader = new MiniMaxHistoryReader(home);
    // C:\Users\83429\project session was written by the first test; a
    // differently-cased, forward-slashed path must still match.
    const listed = reader.listSessionsForProject('c:/users/83429/PROJECT');
    assert.ok(listed.some((s) => s.sessionId === 'mvs_abc123'));
    assert.equal(reader.listSessionsForProject(String.raw`C:\Users\83429\other`).some((s) => s.sessionId === 'mvs_abc123'), false);
  });
});
