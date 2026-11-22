import { createHash } from 'node:crypto';

/**
 * Long answers. Slack shows at most 12,000 characters in the markdown blocks
 * of one message. A longer answer is delivered as a preview, and the full
 * answer is attached in the same thread as `answer.md`. The agent builds the
 * preview and the file; the Slack adapter uploads the file, then posts the
 * notice and the preview. The retained delivery text stays the full answer.
 */
export const SLACK_MARKDOWN_CHARS = 12_000;
export const LONG_ANSWER_PREVIEW_CHARS = 3_000;
export const LONG_ANSWER_FILE_NAME = 'answer.md';
export const LONG_ANSWER_FILE_BYTES = 2 * 1024 ** 2;
/** Room the notice and its separator take in front of the preview. */
const NOTICE_ROOM = 400;
/** Kept application status paragraphs (publication lines) may use at most this much. */
const TAIL_CHARS = 4_000;

/** Application-owned status paragraphs appended after a coding answer. The
 * preview keeps them, so a long answer still shows its merge request link. */
export const PUBLICATION_CONFIRMED_PREFIX = 'Verified publication: ';
export const PUBLICATION_UNCONFIRMED_LINE =
  'Publication outcome unconfirmed. Do not retry; operator reconciliation required.';

export function publicationLine(p: {
  outcome: string;
  evidence?: { project: string; branch: string; commit: string; mrUrl: string } | null;
}): string {
  return p.outcome === 'confirmed' && p.evidence
    ? `${PUBLICATION_CONFIRMED_PREFIX}${p.evidence.project} branch ${p.evidence.branch}, commit ${p.evidence.commit}, MR ${p.evidence.mrUrl}.`
    : PUBLICATION_UNCONFIRMED_LINE;
}

/** The full answer as a thread file (the same bytes as the retained text). */
export interface NativeAnswerFile {
  name: string;
  sha256: string;
  bytes: number;
  data: string;
}

/** The adapter's report of an answer file: confirmed in the thread, or not attached. */
export type AnswerFileReceipt =
  | { attached: true; fileId: string; permalink: string; sha256: string; bytes: number }
  | { attached: false };

/** The notice in front of the preview. `attached` is false when the upload
 * failed or could not be confirmed; the file is then never retried. */
export function longAnswerNotice(attached: boolean): string {
  return attached
    ? `This answer is longer than one Slack message. The full answer is attached above as \`${LONG_ANSWER_FILE_NAME}\`. A preview follows.`
    : 'This answer is longer than one Slack message, and the file with the full answer could not be attached. A preview follows. Ask in this thread for the rest.';
}

/** The posted message: notice, then preview. */
export function longAnswerMessage(preview: string, attached: boolean): string {
  return `${longAnswerNotice(attached)}\n\n${preview}`;
}

/**
 * The head of `text`, at most `max` characters. It ends at a paragraph break
 * outside a code fence when that keeps at least half of the budget, else at
 * the end of a line outside a fence. Inside a long fence it ends at a line and
 * closes the fence. Only a text without usable line breaks is cut hard.
 */
export function answerPreview(text: string, max = LONG_ANSWER_PREVIEW_CHARS): string {
  const budget = Math.max(100, Math.floor(max));
  if (text.length <= budget) return text;
  let fence: string | null = null;
  let offset = 0;
  let paragraph = 0;
  let outside = 0;
  let inside: { end: number; fence: string } | null = null;
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    if (end > budget) break;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    if (fence === null) {
      if (line.trim() === '') paragraph = offset;
      outside = end;
    } else if (end + fence.length + 1 <= budget) {
      inside = { end, fence };
    }
    offset = end + 1;
  }
  const half = budget / 2;
  if (paragraph >= half) return text.slice(0, paragraph).trimEnd();
  if (outside >= half) return text.slice(0, outside).trimEnd();
  if (inside && inside.end >= half)
    return `${text.slice(0, inside.end).trimEnd()}\n${inside.fence}`;
  const best = Math.max(paragraph, outside);
  if (best > 0) return text.slice(0, best).trimEnd();
  // No usable line break: cut hard, never inside a surrogate pair.
  return text.slice(0, budget).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * Splits an answer above the Slack limit into a preview and the full answer
 * file, or returns null when the answer fits. Trailing publication paragraphs
 * stay visible under the preview.
 */
export function splitLongAnswer(text: string): { preview: string; file: NativeAnswerFile } | null {
  if (text.length <= SLACK_MARKDOWN_CHARS) return null;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > LONG_ANSWER_FILE_BYTES) throw new Error('answer exceeds the file bound');
  const paragraphs = text.split('\n\n');
  let start = paragraphs.length;
  while (
    start > 1 &&
    (paragraphs[start - 1]!.startsWith(PUBLICATION_CONFIRMED_PREFIX) ||
      paragraphs[start - 1] === PUBLICATION_UNCONFIRMED_LINE)
  )
    start--;
  const tail = paragraphs.slice(start).join('\n\n');
  const kept = tail.length <= TAIL_CHARS ? tail : '';
  const body = kept ? paragraphs.slice(0, start).join('\n\n') : text;
  const preview = [answerPreview(body), kept].filter(Boolean).join('\n\n');
  if (preview.length + NOTICE_ROOM > SLACK_MARKDOWN_CHARS) throw new Error('preview bound');
  return {
    preview,
    file: {
      name: LONG_ANSWER_FILE_NAME,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      data: bytes.toString('base64'),
    },
  };
}

/** Exact bytes of a transported answer file; throws on any mismatch. */
export function answerFileBytes(file: NativeAnswerFile, preview: string): Buffer {
  if (
    !file ||
    file.name !== LONG_ANSWER_FILE_NAME ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 1 ||
    file.bytes > LONG_ANSWER_FILE_BYTES ||
    typeof file.data !== 'string' ||
    file.data.length > Math.ceil(LONG_ANSWER_FILE_BYTES / 3) * 4 ||
    typeof preview !== 'string' ||
    !preview.trim() ||
    preview.length + NOTICE_ROOM > SLACK_MARKDOWN_CHARS
  )
    throw new Error('invalid answer file');
  const bytes = Buffer.from(file.data, 'base64');
  if (
    bytes.length !== file.bytes ||
    bytes.toString('base64') !== file.data ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256 ||
    bytes.toString('utf8').length <= SLACK_MARKDOWN_CHARS
  )
    throw new Error('answer file identity mismatch');
  return bytes;
}
