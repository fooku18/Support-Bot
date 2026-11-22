/** retained results and Slack previews are distinct values. */
export const FULL_ANSWER_CHARS = 64_000;
export const RESULT_PREVIEW_CHARS = 3_000;
export const INCOMPLETE_RESULT_HEADER =
  '> INCOMPLETE RESULT: output_limit. Available output follows.';

export function retainAnswer(
  text: string,
  incomplete = false,
): {
  text: string;
  incomplete: boolean;
} {
  const clean = text.trim();
  const partial = incomplete || clean.length > FULL_ANSWER_CHARS;
  if (!partial) return { text: clean, incomplete: false };
  const prefix = `${INCOMPLETE_RESULT_HEADER}\n\n`;
  const body = clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
  // Do not leave half of a UTF-16 surrogate pair at the boundary.
  const retained = body.slice(0, FULL_ANSWER_CHARS - prefix.length).replace(/[\uD800-\uDBFF]$/, '');
  return { text: prefix + retained, incomplete: true };
}

/** A preview ends at a paragraph outside a fenced block, never inside code. */
export function resultPreview(text: string, budget = RESULT_PREVIEW_CHARS): string {
  const max = Math.max(100, Math.min(RESULT_PREVIEW_CHARS, budget));
  if (text.length <= max) return text;
  let fence: string | null = null;
  let offset = 0;
  let boundary = 0;
  for (const line of text.split('\n')) {
    if (offset + line.length + 1 > max) break;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    if (line.trim() === '' && fence === null) boundary = offset;
    offset += line.length + 1;
  }
  return boundary > 0
    ? text.slice(0, boundary).trimEnd()
    : 'The result is available as a downloadable file.';
}

export function wantsMarkdownReport(prompt: string): boolean {
  return /\b(downloadable|download|export|attach)\b[\s\S]{0,80}\b(report|markdown|\.md)\b|\b(report|markdown)\b[\s\S]{0,80}\b(download|export|attach)\b/i.test(
    prompt,
  );
}
