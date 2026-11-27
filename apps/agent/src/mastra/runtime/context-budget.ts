import { TripWire } from '@mastra/core/agent';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

type Prompt = ProcessLLMRequestArgs['prompt'];
type PromptMessage = Prompt[number];
type ToolMessage = Extract<PromptMessage, { role: 'tool' }>;
type ToolResultOutput = ToolMessage['content'][number]['output'];
type FilePart = Extract<
  Extract<PromptMessage, { role: 'user' }>['content'][number],
  { type: 'file' }
>;

/** Deliberately high: JSON tool output tokenizes densely, and over-counting is the safe side. */
const CHARS_PER_TOKEN = 3;
const MESSAGE_TOKENS = 4;
/** Flat cost of an image or other non-text file part; its base64 length says nothing about tokens. */
const MEDIA_TOKENS = 1600;

/** Replaces the turns left out of a request, so the model knows history is missing. */
export const OMITTED_HISTORY_NOTE =
  '[Context note: earlier messages of this conversation were left out here to fit the context budget. They may contain details the user already gave. If something you need is missing, say so or ask.]';
/** Opens a request whose history starts with an assistant turn. */
export const MISSING_START_NOTE =
  '[Context note: the start of this conversation is not shown. Earlier messages may contain details the user already gave.]';

export const omittedToolResult = (tokens: number) =>
  `[Tool result left out to fit the context budget (about ${tokens} tokens). Call the tool again if you need it.]`;

const textTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

function fileTokens({ data, mediaType }: FilePart) {
  if (!mediaType.startsWith('text/') || data instanceof URL) return MEDIA_TOKENS;
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'base64') : data.byteLength;
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

function resultTokens(output: ToolResultOutput) {
  if (output.type === 'content')
    return output.value.reduce(
      (sum, entry) => sum + (entry.type === 'text' ? textTokens(entry.text) : MEDIA_TOKENS),
      0,
    );
  if (output.type === 'text' || output.type === 'error-text') return textTokens(output.value);
  return textTokens(JSON.stringify(output.value ?? null));
}

/** Estimated tokens of one provider prompt message. */
export function estimatePromptTokens(message: PromptMessage): number {
  if (message.role === 'system') return MESSAGE_TOKENS + textTokens(message.content);
  let tokens = MESSAGE_TOKENS;
  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'reasoning') tokens += textTokens(part.text);
    else if (part.type === 'file') tokens += fileTokens(part);
    else if (part.type === 'tool-call')
      tokens += textTokens(
        part.toolName + (typeof part.input === 'string' ? part.input : JSON.stringify(part.input)),
      );
    else if (part.type === 'tool-result')
      tokens += textTokens(part.toolName) + resultTokens(part.output);
  }
  return tokens;
}

interface Group {
  messages: PromptMessage[];
  tokens: number;
  role: PromptMessage['role'];
  dropped: boolean;
}

/** A tool call and its results stay together: providers reject one without the other. */
function groupPrompt(prompt: Prompt): Group[] {
  const groups: Group[] = [];
  for (let index = 0; index < prompt.length; index++) {
    const messages = [prompt[index]!];
    const calls = new Set<string>();
    if (messages[0]!.role === 'assistant')
      for (const part of messages[0]!.content)
        if (part.type === 'tool-call') calls.add(part.toolCallId);
    while (calls.size && prompt[index + 1]?.role === 'tool') {
      const next = prompt[index + 1] as ToolMessage;
      if (!next.content.some((part) => calls.has(part.toolCallId))) break;
      messages.push(next);
      index++;
    }
    groups.push({
      messages,
      role: messages[0]!.role,
      tokens: messages.reduce((sum, message) => sum + estimatePromptTokens(message), 0),
      dropped: false,
    });
  }
  return groups;
}

function shrinkToolResults(messages: PromptMessage[]): PromptMessage[] {
  return messages.map((message) =>
    message.role === 'tool'
      ? {
          ...message,
          content: message.content.map((part) => ({
            ...part,
            output: { type: 'text' as const, value: omittedToolResult(resultTokens(part.output)) },
          })),
        }
      : message,
  );
}

const note = (text: string): PromptMessage => ({ role: 'user', content: [{ type: 'text', text }] });

/**
 * Fits a provider prompt into `limit` estimated tokens without losing what the
 * user asked. The opening request of the history window, the current request
 * and the latest turn are kept. Old tool results shrink to a short receipt
 * first, oldest first; only then are whole older turns left out. A note marks
 * each left-out range, and a history that opens on an assistant turn gets one
 * in front, so the model never reads a gap as an empty user message.
 */
export function fitContext(prompt: Prompt, limit: number): Prompt {
  const groups = groupPrompt(prompt);
  const turns = groups.filter((group) => group.role !== 'system');
  if (!turns.length) return prompt;
  let total = groups.reduce((sum, group) => sum + group.tokens, 0);
  const opening = turns[0]!.role === 'user' ? turns[0] : undefined;
  const current = turns.findLast((group) => group.role === 'user');
  const latest = turns.at(-1)!;
  const pinned = new Set([opening, current, latest]);
  if (total <= limit && opening) return prompt;

  for (const group of turns) {
    if (total <= limit) break;
    if (group === latest || !group.messages.some((message) => message.role === 'tool')) continue;
    const messages = shrinkToolResults(group.messages);
    const tokens = messages.reduce((sum, message) => sum + estimatePromptTokens(message), 0);
    if (tokens >= group.tokens) continue;
    total -= group.tokens - tokens;
    Object.assign(group, { messages, tokens });
  }
  for (const group of turns) {
    if (total <= limit) break;
    if (pinned.has(group)) continue;
    group.dropped = true;
    total -= group.tokens;
  }
  if (total > limit && opening && opening !== current) {
    opening.dropped = true;
    total -= opening.tokens;
  }
  if (total > limit)
    throw new TripWire(
      'The current request does not fit the context budget',
      { retry: false, metadata: { limit } },
      'context-budget',
    );

  const fitted: PromptMessage[] = [];
  let open = true;
  for (const group of groups) {
    if (group.dropped) {
      if (open) fitted.push(note(OMITTED_HISTORY_NOTE));
      open = false;
      continue;
    }
    open = true;
    fitted.push(...group.messages);
  }
  const first = fitted.findIndex((message) => message.role !== 'system');
  if (fitted[first]?.role === 'assistant') fitted.splice(first, 0, note(MISSING_START_NOTE));
  return fitted;
}

/** Prompt-stage input budget; stored messages and memory keep everything. */
export class ContextBudgetProcessor implements Processor<'context-budget'> {
  readonly id = 'context-budget';
  readonly name = 'Context budget';
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid context budget');
  }
  processLLMRequest({ prompt }: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const fitted = fitContext(prompt, this.limit);
    return fitted === prompt ? {} : { prompt: fitted };
  }
}
