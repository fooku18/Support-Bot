/**
 * GENERATED verbatim from apps/agent/src/contracts/slack-message-content.ts — do
 * not hand-edit. Regenerate with:
 *
 *   npm run generate:protocol
 */

/**
 * Flattens one Slack message into the plain text the model reads. Shared
 * source: the adapter's thread context and the runner's Slack
 * message search read the same mirror, generated into each package's
 * `src/generated/slack-message-content.ts` by `npm run generate:protocol`.
 *
 * Alert and integration bots (Opsgenie, Datadog, GitLab, n8n, …) put their
 * payload into `attachments` and `blocks`; Slack's `text` is empty or a short
 * fallback for them. The content is the union of `text`, the attachments and
 * the blocks, in that order. A segment that repeats content already kept
 * (Slack mirrors a person's `text` in a `rich_text` block) is dropped; the
 * comparison ignores markup, punctuation and case. Link unfurls (previews of
 * URLs posted in the message) are noise, not thread content, and are skipped.
 * The result is capped per message.
 */

/** Per-message cap on the flattened content (UTF-8 bytes, marker included). */
export const MAX_MESSAGE_CONTENT_BYTES = 16 * 1024;
/**
 * Cap for this app's own answers: up to 11 900 characters, so an
 * answer of multi-byte characters is read back whole, not `[truncated]`.
 */
export const MAX_OWN_ANSWER_BYTES = 48 * 1024;
export const TRUNCATED_MARKER = '[truncated]';

/** Segments at least this long (comparison key) also match inside a kept segment. */
const MIN_CONTAINED_KEY = 20;

type Json = Record<string, unknown>;

export interface SlackMessageParts {
  text?: unknown;
  attachments?: unknown;
  blocks?: unknown;
}

export function flattenMessageContent(
  message: SlackMessageParts,
  maxBytes = MAX_MESSAGE_CONTENT_BYTES,
): string {
  const segments: Segment[] = [];
  const text = asString(message.text);
  if (text !== null) segments.push(mrkdwnSegment(text));
  for (const attachment of asArray(message.attachments)) {
    if (!isRecord(attachment) || isUnfurl(attachment)) continue;
    segments.push(...attachmentSegments(attachment));
  }
  segments.push(...blockSegments(message.blocks));
  return capContent(dedupe(segments).join('\n'), maxBytes);
}

/**
 * This app's own answer as the model reads it on a later fresh session: the
 * blocks (they keep the answer's line breaks, lists and code blocks; Slack's
 * `text` fallback collapses them). This app's `text` is derived from the
 * same answer, and for a long answer it is only a preview, so it is
 * read only when the blocks carry no answer. Comparing it with Slack's
 * rich-text rendering is not reliable (emoji names, code fence languages),
 * and an unmatched preview would add up to 3 900 characters to the answer.
 * The footer context line (check mark, model, notices) is agent-authored,
 * not part of the answer, and is skipped. Capped at the own-answer cap.
 *
 * @public
 */
export function flattenOwnAnswer(message: SlackMessageParts): string {
  const blocks = asArray(message.blocks).filter(
    (block) => !(isRecord(block) && block.type === 'context'),
  );
  const answer = dedupe(blockSegments(blocks));
  const text = asString(message.text);
  if (answer.length === 0 && text !== null) answer.push(...dedupe([mrkdwnSegment(text)]));
  return capContent(answer.join('\n'), MAX_OWN_ANSWER_BYTES);
}

interface Segment {
  display: string;
  key: string;
}

/** `comparable` is the text in the same readable form the blocks render to. */
function segment(display: string, comparable: string = display): Segment {
  return { display: display.trim(), key: comparisonKey(comparable) };
}

function dedupe(segments: Segment[]): string[] {
  const kept: Segment[] = [];
  for (const candidate of segments) {
    if (candidate.display.length === 0 || candidate.key.length === 0) continue;
    const repeated = kept.some(
      (previous) =>
        previous.key === candidate.key ||
        (candidate.key.length >= MIN_CONTAINED_KEY && previous.key.includes(candidate.key)),
    );
    if (!repeated) kept.push(candidate);
  }
  return kept.map((entry) => entry.display);
}

/** Letters and digits only, lower-cased: markup, bullets and spacing never make a repeat look new. */
function comparisonKey(value: string): string {
  return unescapeEntities(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function unescapeEntities(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Slack mrkdwn text (`text`, attachments, mrkdwn text objects) arrives with
 * `<`, `>` and `&` escaped; the model reads them decoded. Rich-text blocks
 * already arrive decoded and never pass through here.
 */
function mrkdwnSegment(value: string): Segment {
  return segment(unescapeEntities(value), normalizeMrkdwn(value));
}

/**
 * Slack mrkdwn as the rich-text renderer below prints it: `<url|label>` as
 * `label (url)`, `<url>` as `url`, mentions as `<@U…>` / `<#C…>`.
 */
function normalizeMrkdwn(value: string): string {
  return value.replace(/<([^<>]+)>/g, (_match, inner: string) => {
    const [target = '', label] = inner.split('|', 2);
    if (target.startsWith('@')) return `<${target}>`;
    if (target.startsWith('#')) return `<${target}>`;
    if (target.startsWith('!')) return `<${target}>`;
    return formatLink(target, label);
  });
}

function formatLink(url: string, label: string | undefined | null): string {
  return label !== undefined && label !== null && label.length > 0 && label !== url
    ? `${label} (${url})`
    : url;
}

function isUnfurl(attachment: Json): boolean {
  return (
    asString(attachment.from_url) !== null ||
    attachment.is_msg_unfurl === true ||
    attachment.is_app_unfurl === true
  );
}

function attachmentSegments(attachment: Json): Segment[] {
  const segments: Segment[] = [];
  const pretext = asString(attachment.pretext);
  if (pretext !== null) segments.push(mrkdwnSegment(pretext));
  const title = asString(attachment.title);
  if (title !== null) {
    const link = asString(attachment.title_link);
    segments.push(segment(link === null ? title : formatLink(link, title)));
  }
  const text = asString(attachment.text);
  if (text !== null) segments.push(mrkdwnSegment(text));
  for (const field of asArray(attachment.fields)) {
    if (!isRecord(field)) continue;
    const fieldTitle = asString(field.title);
    const value = asString(field.value);
    const line = [fieldTitle, value].filter((part) => part !== null).join(': ');
    if (line.length === 0) continue;
    segments.push(mrkdwnSegment(line));
  }
  // Apps that use attachments only for the colour bar put blocks inside them.
  segments.push(...blockSegments(attachment.blocks));
  const footer = asString(attachment.footer);
  if (footer !== null) segments.push(mrkdwnSegment(footer));
  if (segments.length === 0) {
    const fallback = asString(attachment.fallback);
    if (fallback !== null) return [mrkdwnSegment(fallback)];
  }
  return segments;
}

function blockSegments(blocks: unknown): Segment[] {
  const segments: Segment[] = [];
  for (const block of asArray(blocks)) {
    if (!isRecord(block)) continue;
    switch (block.type) {
      case 'header': {
        const text = textObject(block.text);
        if (text !== null) segments.push(mrkdwnSegment(text));
        break;
      }
      case 'section': {
        const text = textObject(block.text);
        if (text !== null) segments.push(mrkdwnSegment(text));
        for (const field of asArray(block.fields)) {
          const value = textObject(field);
          if (value !== null) segments.push(mrkdwnSegment(value));
        }
        break;
      }
      case 'context': {
        const parts = asArray(block.elements)
          .map((element) => textObject(element))
          .filter((value): value is string => value !== null);
        if (parts.length > 0) {
          const line = parts.join(' ');
          segments.push(mrkdwnSegment(line));
        }
        break;
      }
      case 'rich_text': {
        const text = richTextBlock(block.elements);
        if (text.trim().length > 0) segments.push(segment(text));
        break;
      }
      case 'markdown': {
        // Standard Markdown as this app posts its answers (raw, not escaped).
        const text = asString(block.text);
        if (text !== null) segments.push(segment(text));
        break;
      }
      case 'image': {
        const alt = asString(block.alt_text);
        if (alt !== null) segments.push(segment(alt));
        break;
      }
      case 'data_visualization': {
        const title = asString(block.title);
        if (title !== null) segments.push(segment(`[Chart: ${title}]`));
        break;
      }
      default:
        break;
    }
  }
  return segments;
}

/** A Slack text object (`plain_text` / `mrkdwn`); null for anything else. */
function textObject(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'plain_text' && value.type !== 'mrkdwn') return null;
  return asString(value.text);
}

function richTextBlock(elements: unknown): string {
  return asArray(elements)
    .map((element) => richTextContainer(element, 0))
    .filter((line) => line.length > 0)
    .join('\n');
}

function richTextContainer(element: unknown, depth: number): string {
  if (!isRecord(element) || depth > 8) return '';
  switch (element.type) {
    case 'rich_text_section':
      return richTextInline(element.elements);
    case 'rich_text_preformatted':
      return richTextInline(element.elements);
    case 'rich_text_quote':
      return richTextInline(element.elements)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'rich_text_list': {
      const ordered = element.style === 'ordered';
      const offset = typeof element.offset === 'number' ? element.offset : 0;
      const indent = '  '.repeat(typeof element.indent === 'number' ? element.indent : 0);
      return asArray(element.elements)
        .map((item, index) => {
          const bullet = ordered ? `${offset + index + 1}.` : '-';
          return `${indent}${bullet} ${richTextContainer(item, depth + 1)}`;
        })
        .join('\n');
    }
    default:
      return '';
  }
}

function richTextInline(elements: unknown): string {
  return asArray(elements)
    .map((element) => {
      if (!isRecord(element)) return '';
      switch (element.type) {
        case 'text':
          // Whitespace-only runs separate the elements around them.
          return typeof element.text === 'string' ? element.text : '';
        case 'link':
          return formatLink(asString(element.url) ?? '', asString(element.text));
        case 'user':
          return `<@${asString(element.user_id) ?? ''}>`;
        case 'channel':
          return `<#${asString(element.channel_id) ?? ''}>`;
        case 'usergroup':
          return `<!subteam^${asString(element.usergroup_id) ?? ''}>`;
        case 'broadcast':
          return `<!${asString(element.range) ?? ''}>`;
        case 'emoji':
          return `:${asString(element.name) ?? ''}:`;
        case 'date':
          return asString(element.fallback) ?? String(element.timestamp ?? '');
        default:
          return '';
      }
    })
    .join('');
}

function capContent(content: string, maxBytes = MAX_MESSAGE_CONTENT_BYTES): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  const suffix = `\n${TRUNCATED_MARKER}`;
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    end += char.length;
  }
  return `${content.slice(0, end)}${suffix}`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
