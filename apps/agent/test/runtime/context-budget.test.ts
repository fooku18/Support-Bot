import { TripWire } from '@mastra/core/agent';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  ContextBudgetProcessor,
  MISSING_START_NOTE,
  OMITTED_HISTORY_NOTE,
  estimatePromptTokens,
  fitContext,
} from '../../src/mastra/runtime/context-budget.js';

type Prompt = ProcessLLMRequestArgs['prompt'];
type Message = Prompt[number];

const system: Message = { role: 'system', content: 'TRUSTED instructions' };
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const answer = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
/** One tool step: an assistant call and its result. */
const step = (id: string, result: string): Message[] => [
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'datadog_call', input: { id } }],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'datadog_call',
        output: { type: 'json', value: { rows: result } },
      },
    ],
  },
];
const total = (prompt: Prompt) => prompt.reduce((sum, m) => sum + estimatePromptTokens(m), 0);
const text = (value: Prompt | Message | undefined) => JSON.stringify(value);
/** Every tool call keeps its result and every result its call. */
function paired(prompt: Prompt) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of prompt)
    if (message.role !== 'system')
      for (const part of message.content) {
        if (part.type === 'tool-call') calls.add(part.toolCallId);
        if (part.type === 'tool-result') results.add(part.toolCallId);
      }
  return [...calls].sort().join() === [...results].sort().join();
}

/** The incident: an alert question, a long tool investigation, then "try again". */
const incident: Prompt = [
  system,
  user('OPENING investigate what caused this error: <alert link>'),
  ...step('read-alert', 'ALERT_TEXT '.repeat(900)),
  ...step('describe', 'catalog '.repeat(2500)),
  ...step('logs', 'log pattern '.repeat(1500)),
  user('CURRENT try again'),
];

describe('context budget', () => {
  it('passes a prompt that fits and starts with the user unchanged', () => {
    const prompt: Prompt = [system, user('question'), answer('reply'), user('follow-up')];
    expect(fitContext(prompt, 10_000)).toBe(prompt);
    expect(new ContextBudgetProcessor(10_000).processLLMRequest({ prompt } as never)).toEqual({});
  });

  it('marks a history window that opens on an assistant turn', () => {
    const fitted = fitContext([system, answer('earlier reply'), user('follow-up')], 10_000);
    expect(fitted.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(text(fitted.slice(1, 2))).toContain(MISSING_START_NOTE);
  });

  it('shrinks old tool results before it leaves out any turn', () => {
    const limit = 9_000;
    expect(total(incident)).toBeGreaterThan(limit);
    const fitted = fitContext(incident, limit);
    expect(total(fitted)).toBeLessThanOrEqual(limit);
    expect(text(fitted)).toContain('OPENING investigate');
    expect(text(fitted)).toContain('CURRENT try again');
    expect(text(fitted)).toContain('Tool result left out to fit the context budget');
    expect(text(fitted)).not.toContain(OMITTED_HISTORY_NOTE);
    // Oldest results shrink first; the newest result still fits as it was.
    expect(text(fitted)).not.toContain('ALERT_TEXT');
    expect(text(fitted)).toContain('log pattern');
    expect(fitted).toHaveLength(incident.length);
    expect(paired(fitted)).toBe(true);
  });

  it('leaves out older turns with a note but keeps the opening and current request', () => {
    const prompt: Prompt = [
      system,
      user('OPENING question'),
      ...Array.from({ length: 30 }, (_, i) => [
        user(`older question ${i} ` + 'x'.repeat(600)),
        answer(`older answer ${i} ` + 'y'.repeat(600)),
      ]).flat(),
      user('CURRENT question'),
    ];
    const fitted = fitContext(prompt, 2_000);
    expect(total(fitted)).toBeLessThanOrEqual(2_000);
    expect(fitted[1]).toEqual(prompt[1]);
    expect(text(fitted[2])).toContain(OMITTED_HISTORY_NOTE);
    expect(fitted.at(-1)).toEqual(prompt.at(-1));
    expect(text(fitted)).toContain('older answer 29');
    expect(text(fitted)).not.toContain('older question 0 ');
    expect(fitted.filter((m) => text(m).includes(OMITTED_HISTORY_NOTE))).toHaveLength(1);
  });

  it('never shrinks the latest tool step of a running turn', () => {
    const prompt: Prompt = [
      system,
      user('OPENING question'),
      ...step('first', 'FIRST_RESULT '.repeat(2000)),
      ...step('active', 'ACTIVE_RESULT '.repeat(2000)),
    ];
    const fitted = fitContext(prompt, 12_000);
    expect(text(fitted)).toContain('ACTIVE_RESULT');
    expect(text(fitted)).not.toContain('FIRST_RESULT');
    expect(fitted.at(-1)).toEqual(prompt.at(-1));
    expect(paired(fitted)).toBe(true);
  });

  it('refuses a current request that cannot fit on its own', () => {
    expect(() => fitContext([system, user('z'.repeat(30_000))], 1_000)).toThrow(TripWire);
  });

  it('counts a text attachment by its size and other media at a flat cost', () => {
    const file = (data: string | Uint8Array, mediaType: string): Message => ({
      role: 'user',
      content: [{ type: 'file', data, mediaType }],
    });
    const bytes = Buffer.alloc(30_000, 'x');
    expect(estimatePromptTokens(file(bytes.toString('base64'), 'text/plain'))).toBe(10_004);
    expect(estimatePromptTokens(file(new Uint8Array(bytes), 'text/plain'))).toBe(10_004);
    expect(estimatePromptTokens(file(bytes.toString('base64'), 'image/png'))).toBe(1_604);
    expect(() => fitContext([system, file(bytes.toString('base64'), 'text/plain')], 8_000)).toThrow(
      TripWire,
    );
  });
});
