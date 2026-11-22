import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  answerFileBytes,
  answerPreview,
  LONG_ANSWER_FILE_NAME,
  LONG_ANSWER_PREVIEW_CHARS,
  longAnswerMessage,
  longAnswerNotice,
  publicationLine,
  SLACK_MARKDOWN_CHARS,
  splitLongAnswer,
} from '../../src/domain/delivery/long-answer.js';
import { deliveryMetadata, parseDeliveryMetadata } from '../../src/domain/delivery/metadata.js';

/** Numbered lines like the model stub's STUB_LONG answer (no blank lines). */
function lines(characters: number): string {
  const out: string[] = [];
  for (let n = 1; out.join('\n').length < characters; n++)
    out.push(`Line ${String(n).padStart(5, '0')} of the long answer.`);
  return out.join('\n').slice(0, characters);
}
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

describe('long answer cut', () => {
  it('leaves an answer up to the Slack markdown limit whole', () => {
    expect(splitLongAnswer('a'.repeat(SLACK_MARKDOWN_CHARS))).toBeNull();
    expect(splitLongAnswer(lines(11_500))).toBeNull();
  });

  it('previews a longer answer at a line end and attaches the exact full text', () => {
    const text = lines(16_000);
    const split = splitLongAnswer(text)!;
    expect(split.preview.length).toBeLessThanOrEqual(LONG_ANSWER_PREVIEW_CHARS);
    expect(split.preview.length).toBeGreaterThan(LONG_ANSWER_PREVIEW_CHARS / 2);
    expect(text.startsWith(split.preview)).toBe(true);
    expect(split.preview.endsWith('of the long answer.')).toBe(true);
    expect(split.preview).not.toContain('Line 00400');
    expect(split.file.name).toBe(LONG_ANSWER_FILE_NAME);
    expect(split.file.bytes).toBe(Buffer.byteLength(text));
    expect(split.file.sha256).toBe(sha(text));
    const bytes = answerFileBytes(split.file, split.preview);
    expect(bytes.toString('utf8')).toBe(text);
    expect(bytes.toString('utf8')).toContain('Line 00400 of the long answer.');
  });

  it('prefers a paragraph break outside code fences and never ends inside an open fence', () => {
    const intro = 'Summary.\n\n' + 'x'.repeat(2_000) + '\n\n';
    const fenced = intro + '```ts\n' + 'const a = 1;\n'.repeat(2_000) + '```\n';
    const preview = answerPreview(fenced);
    // The paragraph before the fence keeps more than half of the budget.
    expect(preview).toBe(intro.trimEnd());
    const onlyFence = '```ts\n' + 'const a = 1;\n'.repeat(2_000) + '```\n';
    const closed = answerPreview(onlyFence);
    expect(closed.length).toBeLessThanOrEqual(LONG_ANSWER_PREVIEW_CHARS);
    expect(closed.startsWith('```ts\nconst a = 1;')).toBe(true);
    expect(closed.endsWith('\n```')).toBe(true);
    expect(closed.match(/```/g)).toHaveLength(2);
  });

  it('cuts a text without line breaks hard and never splits a surrogate pair', () => {
    const text = 'a'.repeat(LONG_ANSWER_PREVIEW_CHARS - 1) + '😀' + 'b'.repeat(20_000);
    const preview = answerPreview(text);
    expect(preview).toBe('a'.repeat(LONG_ANSWER_PREVIEW_CHARS - 1));
  });

  it('keeps the trailing publication lines visible under the preview', () => {
    const verified = publicationLine({
      outcome: 'confirmed',
      evidence: {
        project: 'group/app',
        branch: 'support-agent/x',
        commit: 'a'.repeat(40),
        mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7',
      },
    });
    const unconfirmed = publicationLine({ outcome: 'uncertain' });
    const text = `${lines(14_000)}\n\n${verified}\n\n${unconfirmed}`;
    const split = splitLongAnswer(text)!;
    expect(split.preview.endsWith(`\n\n${verified}\n\n${unconfirmed}`)).toBe(true);
    expect(split.preview).toContain('merge_requests/7');
    expect(split.preview.length).toBeLessThan(LONG_ANSWER_PREVIEW_CHARS + 400);
    expect(answerFileBytes(split.file, split.preview).toString('utf8')).toBe(text);
  });

  it('says whether the full answer is attached', () => {
    expect(longAnswerNotice(true)).toContain('attached above as `answer.md`');
    expect(longAnswerNotice(false)).toContain('could not be attached');
    expect(longAnswerNotice(false)).toContain('Ask in this thread for the rest');
    expect(longAnswerMessage('Preview.', true)).toBe(`${longAnswerNotice(true)}\n\nPreview.`);
    expect(longAnswerMessage('x'.repeat(7_000), false).length).toBeLessThan(SLACK_MARKDOWN_CHARS);
  });

  it('refuses a transported file that does not match its identity or the limit', () => {
    const split = splitLongAnswer(lines(13_000))!;
    for (const change of [
      { name: 'other.md' },
      { sha256: '0'.repeat(64) },
      { bytes: split.file.bytes + 1 },
      { data: split.file.data + '\n' },
      { data: Buffer.from('short').toString('base64'), bytes: 5, sha256: sha('short') },
    ])
      expect(() => answerFileBytes({ ...split.file, ...change }, split.preview)).toThrow();
    expect(() => answerFileBytes(split.file, '')).toThrow();
    expect(() => answerFileBytes(split.file, 'p'.repeat(SLACK_MARKDOWN_CHARS))).toThrow();
  });
});

describe('result file metadata', () => {
  it('carries the answer file ID and hash and refuses malformed entries', () => {
    const metadata = deliveryMetadata({
      operationId: 'op-1',
      revision: 1,
      answer: true,
      resultFiles: [{ id: 'F0ANSWER', sha256: 'a'.repeat(64) }],
    });
    expect(metadata.event_payload.result_files).toEqual([
      { id: 'F0ANSWER', sha256: 'a'.repeat(64) },
    ]);
    expect(parseDeliveryMetadata(metadata)).toEqual({
      operationId: 'op-1',
      revision: 1,
      answer: true,
      resultFiles: [{ id: 'F0ANSWER', sha256: 'a'.repeat(64) }],
    });
    expect(
      deliveryMetadata({ operationId: 'op-1', revision: 1, answer: true }).event_payload,
    ).not.toHaveProperty('result_files');
    for (const bad of [
      [{ id: 'nope', sha256: 'a'.repeat(64) }],
      [{ id: 'F0ANSWER', sha256: 'short' }],
      'F0ANSWER',
    ])
      expect(
        parseDeliveryMetadata({
          event_type: 'support_agent_delivery',
          event_payload: { operation_id: 'op-1', revision: 1, answer: true, result_files: bad },
        }),
      ).toBeNull();
  });
});
