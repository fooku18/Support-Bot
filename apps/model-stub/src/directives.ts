/**
 * Directive interpreter of the model stub. Pure: no I/O, no clock, no state.
 *
 * The reply depends only on the request. Directives are read from the last
 * text block that carries a directive in the latest user message that carries
 * text (a user message holding only tool results is a continuation of the
 * same turn; a cancelled request and the next one share a message). Each directive is one
 * line, `STUB_<NAME> <argument>`; several lines combine:
 *
 *   STUB_REPLY <text>          text <text>
 *   STUB_RECALL <pattern>      every distinct match of <pattern> in the rest of
 *                              the request, or STUB_NONE
 *   STUB_ASK <question>        an ask_user tool call; after the answer,
 *                              STUB_ASK_RESULT <answer text>
 *   STUB_HOLD <seconds>        delays the reply (capped)
 *   STUB_LONG <characters>     a deterministic text of exactly <characters>
 *                              characters (capped) ending in STUB_LONG_END <n>
 *   STUB_MODEL                 STUB_MODEL <the request's model ID>
 *   STUB_SYSTEM <pattern>      every distinct match of <pattern> in the system
 *                              prompt, as STUB_SYSTEM <matches>, or STUB_NONE
 *   (none)                     STUB_OK <request digest>
 *
 * "The rest of the request" is every message, with the directive text block
 * itself left out: earlier turns, attachments and documents of the latest
 * message, and tool calls and results after it. The system prompt is not
 * searched. Invalid directives are answered with STUB_ERROR text, never with a
 * guessed tool call.
 */

import { createHash } from 'node:crypto';

export const MAX_HOLD_SECONDS = 120;
/** Upper bound of STUB_LONG: above Slack's markdown block limit (12000). */
export const MAX_LONG_CHARACTERS = 20000;
const MAX_PATTERN_LENGTH = 200;
const MAX_MATCHES = 20;
const MAX_ECHO = 300;

/** The fixed synthetic credential accepted by the Messages stub. */
export const STUB_KEY = 'stub-key-2';

export type Block = Record<string, unknown> & { type?: unknown };
export interface Message {
  role?: unknown;
  content?: unknown;
}
export interface ToolDefinition {
  name?: unknown;
  input_schema?: unknown;
}
export interface MessagesRequest {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type Outcome = {
  kind: 'message';
  content: Part[];
  stopReason: 'end_turn' | 'tool_use';
  holdSeconds: number;
  directives: string[];
};

type Name = 'REPLY' | 'RECALL' | 'ASK' | 'HOLD' | 'LONG' | 'MODEL' | 'SYSTEM';
interface Directive {
  name: Name;
  argument: string;
}

export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

function blocks(message: Message): Block[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message.content)
    ? message.content.filter((b): b is Block => !!b && typeof b === 'object')
    : [];
}

/** All searchable text of a block: text, tool input, tool result and text documents. */
export function blockText(block: Block): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'tool_use':
      return JSON.stringify(block.input ?? {});
    case 'tool_result':
      return typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as Block[]).map(blockText).join('\n')
          : '';
    case 'document': {
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === 'text' && typeof source.data === 'string') return source.data;
      if (
        source?.type === 'base64' &&
        source.media_type === 'text/plain' &&
        typeof source.data === 'string'
      )
        return Buffer.from(source.data, 'base64').toString('utf8');
      if (source?.type === 'content' && Array.isArray(source.content))
        return (source.content as Block[]).map(blockText).join('\n');
      return '';
    }
    default:
      return '';
  }
}

/** The system prompt: a string or text blocks. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  return Array.isArray(system)
    ? system
        .filter((b): b is Block => !!b && typeof b === 'object')
        .map(blockText)
        .join('\n')
    : '';
}

function parseDirectives(text: string): Directive[] {
  const found: Directive[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /\bSTUB_(REPLY|RECALL|ASK|HOLD|LONG|MODEL|SYSTEM)\b[ \t]*(.*)$/.exec(line);
    if (match) found.push({ name: match[1] as Name, argument: (match[2] ?? '').trim() });
  }
  return found;
}

/** Numbered plain lines, exactly `characters` long, ending in the end marker. */
export function longText(characters: number): string {
  const end = `STUB_LONG_END ${characters}`;
  const lines: string[] = [];
  let length = 0;
  for (let n = 1; ; n += 1) {
    const line = `Line ${String(n).padStart(5, '0')} of the long stub answer.`;
    if (length + line.length + 1 + end.length > characters) break;
    lines.push(line);
    length += line.length + 1;
  }
  const body = lines.join('\n');
  const pad = characters - body.length - 1 - end.length;
  return `${body}${'.'.repeat(Math.max(0, pad))}\n${end}`;
}

function text(lines: string[], holdSeconds: number, directives: string[]): Outcome {
  return {
    kind: 'message',
    content: [{ type: 'text', text: lines.join('\n') }],
    stopReason: 'end_turn',
    holdSeconds,
    directives,
  };
}

/** The reply for one Messages API request. */
export function respond(request: MessagesRequest): Outcome {
  const messages = (Array.isArray(request.messages) ? request.messages : []) as Message[];
  const tools = (Array.isArray(request.tools) ? request.tools : []) as ToolDefinition[];
  // The directive message: the latest user message that carries text.
  let at = -1;
  let directiveBlock: Block | undefined;
  for (let i = messages.length - 1; i >= 0 && at < 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const candidate = blocks(message).filter((b) => b.type === 'text');
    if (candidate.length) {
      at = i;
      // The last directive block: after a cancelled turn, the cancelled request
      // and the new one arrive as one user message, and the new one comes last.
      directiveBlock =
        candidate.findLast((b) => /\bSTUB_[A-Z]+\b/.test(blockText(b))) ?? candidate[0];
    }
  }
  const directives = directiveBlock ? parseDirectives(blockText(directiveBlock)) : [];
  const names = directives.map((d) => d.name);
  const corpus = messages
    .flatMap((m) => blocks(m).filter((b) => b !== directiveBlock))
    .map(blockText)
    .filter(Boolean)
    .join('\n');
  // Calls and results after the directive message belong to this turn.
  const after = messages.slice(at + 1).flatMap(blocks);
  const calls = after.filter((b) => b.type === 'tool_use');
  const resultOf = (name: string): Block | undefined => {
    const ids = calls.filter((c) => c.name === name).map((c) => c.id);
    return after.filter((b) => b.type === 'tool_result' && ids.includes(b.tool_use_id)).at(-1);
  };
  let holdSeconds = 0;
  const callId = (name: string, input: unknown): string =>
    `toolu_stub_${digest(`${at}:${calls.length}:${name}:${JSON.stringify(input)}`)}`;
  const toolCall = (name: string, input: Record<string, unknown>): Outcome => ({
    kind: 'message',
    content: [{ type: 'tool_use', id: callId(name, input), name, input }],
    stopReason: 'tool_use',
    holdSeconds,
    directives: names,
  });

  if (!directives.length) return text([`STUB_OK ${digest(JSON.stringify(messages))}`], 0, names);

  const lines: string[] = [];
  if (directives.filter((d) => d.name === 'ASK').length > 1)
    return text(['STUB_ERROR one STUB_ASK per message'], 0, names);
  for (const d of directives) {
    if (d.name !== 'HOLD') continue;
    const seconds = Number(d.argument);
    if (!/^\d+(\.\d+)?$/.test(d.argument) || !Number.isFinite(seconds))
      return text(['STUB_ERROR STUB_HOLD needs seconds'], 0, names);
    holdSeconds = Math.min(MAX_HOLD_SECONDS, holdSeconds + seconds);
    lines.push(`STUB_HELD ${Math.min(MAX_HOLD_SECONDS, seconds)}`);
  }
  for (const d of directives) {
    if (d.name === 'ASK') {
      if (!d.argument) return text(['STUB_ERROR STUB_ASK needs a question'], holdSeconds, names);
      const result = resultOf('ask_user');
      if (result) {
        const answer = blockText(result).replace(/\s+/g, ' ').trim().slice(0, MAX_ECHO);
        lines.push(`STUB_ASK_RESULT ${answer}`);
        continue;
      }
      if (!tools.some((t) => t.name === 'ask_user'))
        return text(['STUB_ASK_ERROR no ask_user tool'], holdSeconds, names);
      return toolCall('ask_user', { question: d.argument.slice(0, MAX_ECHO) });
    }
    if (d.name === 'REPLY') lines.push(d.argument.slice(0, 2000) || 'STUB_EMPTY');
    if (d.name === 'LONG') {
      const characters = Number(d.argument);
      if (!/^\d+$/.test(d.argument) || characters < 100 || characters > MAX_LONG_CHARACTERS)
        return text(
          [`STUB_ERROR STUB_LONG needs 100 to ${MAX_LONG_CHARACTERS} characters`],
          holdSeconds,
          names,
        );
      lines.push(longText(characters));
    }
    if (d.name === 'MODEL')
      lines.push(
        `STUB_MODEL ${typeof request.model === 'string' ? request.model.slice(0, MAX_ECHO) : 'none'}`,
      );
    if (d.name === 'RECALL' || d.name === 'SYSTEM') {
      if (!d.argument || d.argument.length > MAX_PATTERN_LENGTH)
        return text([`STUB_ERROR STUB_${d.name} needs a short pattern`], holdSeconds, names);
      let pattern: RegExp;
      try {
        pattern = new RegExp(d.argument, 'g');
      } catch {
        return text([`STUB_ERROR STUB_${d.name} pattern is invalid`], holdSeconds, names);
      }
      const seen: string[] = [];
      for (const m of (d.name === 'RECALL' ? corpus : systemText(request.system)).matchAll(
        pattern,
      )) {
        const value = m[0].slice(0, MAX_ECHO);
        if (value && !seen.includes(value)) seen.push(value);
        if (seen.length >= MAX_MATCHES) break;
      }
      lines.push(seen.length ? `STUB_${d.name} ${seen.join('; ')}` : 'STUB_NONE');
    }
  }
  return text(lines.length ? lines : ['STUB_EMPTY'], holdSeconds, names);
}
