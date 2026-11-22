/**
 * Channel system prompts: standing instructions admins write per workspace
 * (default) and per channel (override). The runner appends the effective
 * text after its fixed system prompt. The agent applies the same bound and
 * character rule when it validates the compiled document.
 */

import { createHash } from 'node:crypto';

/** Upper bound in UTF-16 code units (the browser's `maxlength` unit). Same bound as the agent. */
export const MAX_CHANNEL_PROMPT_CHARS = 4_000;

/** Control characters other than `\n` and `\t` (C0, DEL and C1). */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export class ChannelPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelPromptError';
  }
}

/**
 * Normalizes a prompt from a form or API body: null, undefined or
 * whitespace-only clears the value (null); otherwise line endings become
 * `\n`, the text is trimmed and must be at most
 * `MAX_CHANNEL_PROMPT_CHARS` characters without control characters other
 * than `\n` and `\t`.
 */
export function normalizeChannelPrompt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ChannelPromptError('text must be a string or null');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) return null;
  if (text.length > MAX_CHANNEL_PROMPT_CHARS)
    throw new ChannelPromptError(
      `the prompt must be at most ${MAX_CHANNEL_PROMPT_CHARS} characters (got ${text.length})`,
    );
  if (DISALLOWED_CONTROL.test(text))
    throw new ChannelPromptError('the prompt must not contain control characters');
  return text;
}

/** The audit detail of a prompt change: size, hash and the full text (D8). */
export function promptAuditDetail(text: string | null): Record<string, unknown> {
  return text === null
    ? { chars: 0, sha256: null, text: null }
    : { chars: text.length, sha256: createHash('sha256').update(text).digest('hex'), text };
}
