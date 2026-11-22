import { describe, expect, it } from 'vitest';
import { digest, longText, respond, type Outcome } from '../src/directives.js';

const tools = [
  { name: 'ask_user', input_schema: { type: 'object', required: ['question'] } },
  { name: 'search_tools', input_schema: { type: 'object', required: ['query'] } },
];
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const replyText = (o: Outcome) => {
  expect(o.kind).toBe('message');
  if (o.kind !== 'message') throw new Error('not a message');
  expect(o.stopReason).toBe('end_turn');
  return o.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
};
const toolUse = (o: Outcome) => {
  if (o.kind !== 'message' || o.content[0]?.type !== 'tool_use') throw new Error('no tool call');
  expect(o.stopReason).toBe('tool_use');
  return o.content[0];
};
const result = (id: string, content: unknown) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
});

describe('respond', () => {
  it('answers STUB_REPLY from the latest user message only', () => {
    const o = respond({
      messages: [user('STUB_REPLY first'), assistant('first'), user('<@U1> STUB_REPLY second')],
    });
    expect(replyText(o)).toBe('second');
    expect(o.directives).toEqual(['REPLY']);
  });

  it('follows the newest request when a cancelled one shares its user message', () => {
    const o = respond({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'STUB_HOLD 60\nSTUB_REPLY cancelled' },
            { type: 'text', text: 'STUB_REPLY served after cancel' },
          ],
        },
      ],
    });
    expect(o.kind === 'message' && o.holdSeconds).toBeFalsy();
    expect(replyText(o)).toBe('served after cancel');
  });

  it('answers STUB_OK with a request digest without a directive', () => {
    const messages = [user('hello')];
    expect(replyText(respond({ messages }))).toBe(`STUB_OK ${digest(JSON.stringify(messages))}`);
    expect(replyText(respond({ messages: [user('other')] }))).not.toBe(
      replyText(respond({ messages })),
    );
  });

  it('recalls distinct matches from earlier turns but not from the directive itself', () => {
    const o = respond({
      messages: [
        user('STUB_REPLY Booking CF-731 at 20 minutes'),
        assistant('Booking CF-731 at 20 minutes'),
        user('Correction: 45 minutes. STUB_REPLY noted'),
        assistant('noted'),
        user('CF-999 here is not recalled.\nSTUB_RECALL CF-\\d+|\\d+ minutes'),
      ],
    });
    expect(replyText(o)).toBe('STUB_RECALL CF-731; 20 minutes; 45 minutes');
  });

  it('answers STUB_NONE when the pattern is absent (another thread)', () => {
    expect(replyText(respond({ messages: [user('STUB_RECALL CF-\\d+')] }))).toBe('STUB_NONE');
  });

  it('recalls attachment documents and provenance of the latest message', () => {
    const o = respond({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'STUB_RECALL fox,\\d+|input\\.csv' },
            { type: 'text', text: 'Untrusted Slack input provenance: {"name":"input.csv"}' },
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: 'name,value\nfox,14\n' },
            },
          ],
        },
      ],
    });
    expect(replyText(o)).toBe('STUB_RECALL input.csv; fox,14');
  });

  it('refuses an invalid recall pattern with a text error', () => {
    expect(replyText(respond({ messages: [user('STUB_RECALL (unclosed')] }))).toBe(
      'STUB_ERROR STUB_RECALL pattern is invalid',
    );
  });

  it('asks with ask_user and echoes the answer after the resume', () => {
    const prompt = user('STUB_ASK Which colour?');
    const call = toolUse(respond({ messages: [prompt], tools }));
    expect(call).toMatchObject({ name: 'ask_user', input: { question: 'Which colour?' } });
    const resumed = respond({
      messages: [
        prompt,
        { role: 'assistant', content: [call] },
        result(call.id, '{"answer":"teal-42"}'),
      ],
      tools,
    });
    expect(replyText(resumed)).toBe('STUB_ASK_RESULT {"answer":"teal-42"}');
  });

  it('holds the reply for a capped number of seconds', () => {
    const o = respond({ messages: [user('STUB_HOLD 30\nSTUB_REPLY late')] });
    expect(o.kind === 'message' && o.holdSeconds).toBe(30);
    expect(replyText(o)).toBe('STUB_HELD 30\nlate');
    const capped = respond({ messages: [user('STUB_HOLD 9999')] });
    expect(capped.kind === 'message' && capped.holdSeconds).toBe(120);
    expect(replyText(respond({ messages: [user('STUB_HOLD soon')] }))).toBe(
      'STUB_ERROR STUB_HOLD needs seconds',
    );
  });

  it('answers STUB_LONG with exactly that many characters and an end marker', () => {
    for (const n of [100, 11500, 20000]) {
      const text = replyText(respond({ messages: [user(`STUB_LONG ${n}`)] }));
      expect(text).toHaveLength(n);
      expect(text.endsWith(`\nSTUB_LONG_END ${n}`)).toBe(true);
      expect(text).toBe(longText(n));
    }
    for (const bad of ['99', '20001', 'many'])
      expect(replyText(respond({ messages: [user(`STUB_LONG ${bad}`)] }))).toMatch(
        /^STUB_ERROR STUB_LONG/,
      );
  });

  it('names the request model and searches only the system prompt with STUB_SYSTEM', () => {
    const request = {
      model: 'claude-fixture-2',
      system: [{ type: 'text', text: 'Base rules.\n\nChannel prompt: STUB-PROMPT-7f3a.' }],
      messages: [
        user('earlier STUB-PROMPT-0000'),
        user('STUB_MODEL\nSTUB_SYSTEM STUB-PROMPT-[0-9a-f]+'),
      ],
    };
    expect(replyText(respond(request))).toBe(
      'STUB_MODEL claude-fixture-2\nSTUB_SYSTEM STUB-PROMPT-7f3a',
    );
    expect(
      replyText(
        respond({ system: 'No channel prompt.', messages: [user('STUB_SYSTEM STUB-PROMPT-\\w+')] }),
      ),
    ).toBe('STUB_NONE');
    // STUB_RECALL never searches the system prompt.
    expect(
      replyText(respond({ ...request, messages: [user('STUB_RECALL STUB-PROMPT-7f3a')] })),
    ).toBe('STUB_NONE');
    expect(replyText(respond({ messages: [user('STUB_SYSTEM (')] }))).toBe(
      'STUB_ERROR STUB_SYSTEM pattern is invalid',
    );
  });

  it('allows one ask directive per message', () => {
    expect(replyText(respond({ messages: [user('STUB_ASK a?\nSTUB_ASK b?')], tools }))).toBe(
      'STUB_ERROR one STUB_ASK per message',
    );
  });

  it('answers STUB_ASK without an ask_user tool with a text error', () => {
    expect(replyText(respond({ messages: [user('STUB_ASK a?')], tools: [] }))).toBe(
      'STUB_ASK_ERROR no ask_user tool',
    );
  });
});
