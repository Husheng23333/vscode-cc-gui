import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeUserFacingContent,
  sanitizeUserFacingText,
  sanitizeUserMessagePayload,
} from '../bridge/services/userMessageSanitizer.ts';

describe('userMessageSanitizer', () => {
  it('strips legacy XML context prepended before the typed prompt', () => {
    const raw = [
      '<agent-instructions>',
      '我叫, 黄',
      '我老婆家 陈',
      '我孩子叫 小不点',
      '</agent-instructions>',
      '',
      '<ide-context>',
      'The following context was supplied by the IDE.',
      '</ide-context>',
      '',
      '我的女儿',
    ].join('\n');

    assert.equal(sanitizeUserFacingText(raw), '我的女儿');
  });

  it('cuts IDEA-style appended markdown context', () => {
    const raw = '你好.\n\n## Agent Role and Instructions\n\n我叫, 黄\n我老婆家 陈\n我孩子叫 小不点';
    assert.equal(sanitizeUserFacingText(raw), '你好.');
  });

  it('drops XML-only context but preserves marker-like user text at the start', () => {
    assert.equal(sanitizeUserFacingText('<ide-context>\nroot\n</ide-context>'), '');
    assert.equal(
      sanitizeUserFacingText('\n\n## Agent Role and Instructions\n\ninternal'),
      '## Agent Role and Instructions\n\ninternal',
    );
  });

  it('sanitizes text blocks without dropping images', () => {
    const content = sanitizeUserFacingContent([
      { type: 'local_image', path: '/tmp/a.png' },
      { type: 'text', text: '<ide-context>x</ide-context>\n看这个' },
    ]);

    assert.deepEqual(content, [
      { type: 'local_image', path: '/tmp/a.png' },
      { type: 'text', text: '看这个' },
    ]);
  });

  it('sanitizes user [MESSAGE] payloads at the bridge boundary', () => {
    const payload = sanitizeUserMessagePayload({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<agent-instructions>x</agent-instructions>\n我的女儿' },
        ],
      },
    });

    assert.deepEqual(payload, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '我的女儿' },
        ],
      },
    });
  });
  // Codex CLI injects <recommended_plugins> as the first user turn; it must never
  // surface as transcript text or session title (upstream bdcf21b2).
  describe('recommended_plugins injection', () => {
    it('strips the injection block and keeps the real prompt in the same message', () => {
      const raw = '<recommended_plugins>\nHere is a list of plugins...\n</recommended_plugins>\n\nWhat changed in main.ts?';
      assert.equal(sanitizeUserFacingText(raw), 'What changed in main.ts?');
    });

    it('sanitizes an injection-only message to empty', () => {
      assert.equal(
        sanitizeUserFacingText('<recommended_plugins>\nHere is a list of plugins...\n</recommended_plugins>'),
        '',
      );
    });

    it('sanitizes a truncated injection (closing tag cut off) to empty', () => {
      assert.equal(sanitizeUserFacingText('<recommended_plugins>\nHere is a list of plugi'), '');
    });

    it('strips a well-formed block mid-text while keeping surrounding user text', () => {
      assert.equal(
        sanitizeUserFacingText('before <recommended_plugins>x</recommended_plugins> after'),
        'before after',
      );
    });
  });
});
