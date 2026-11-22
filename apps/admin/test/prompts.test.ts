import { describe, expect, it } from 'vitest';
import {
  ChannelPromptError,
  MAX_CHANNEL_PROMPT_CHARS,
  normalizeChannelPrompt,
  promptAuditDetail,
} from '../src/prompts.js';

describe('normalizeChannelPrompt', () => {
  it('clears on null, undefined and whitespace', () => {
    expect(normalizeChannelPrompt(null)).toBeNull();
    expect(normalizeChannelPrompt(undefined)).toBeNull();
    expect(normalizeChannelPrompt('')).toBeNull();
    expect(normalizeChannelPrompt(' \n\t \r\n ')).toBeNull();
  });

  it('trims and normalizes line endings, keeping tabs and newlines', () => {
    expect(normalizeChannelPrompt('  Use tabs:\r\n\tyes\rno  \n')).toBe('Use tabs:\n\tyes\nno');
  });

  it('accepts exactly the bound and refuses one character more', () => {
    const max = 'x'.repeat(MAX_CHANNEL_PROMPT_CHARS);
    expect(normalizeChannelPrompt(max)).toBe(max);
    expect(normalizeChannelPrompt(`  ${max}  `)).toBe(max);
    expect(() => normalizeChannelPrompt(`${max}x`)).toThrow(ChannelPromptError);
  });

  it('refuses control characters and non-strings', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u000bb']) {
      expect(() => normalizeChannelPrompt(bad)).toThrow(/control characters/);
    }
    for (const bad of [7, true, {}, ['text']]) {
      expect(() => normalizeChannelPrompt(bad)).toThrow(/string or null/);
    }
  });
});

describe('promptAuditDetail', () => {
  it('records size, hash and text', () => {
    expect(promptAuditDetail(null)).toEqual({ chars: 0, sha256: null, text: null });
    expect(promptAuditDetail('abc')).toEqual({
      chars: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      text: 'abc',
    });
  });
});
