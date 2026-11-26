import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';
import type { NativeRuntimeOptions } from '../../src/mastra/runtime/agent.js';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';
import { renderInlineCitations } from '../../src/mastra/runtime/citations.js';

it.each([
  'https://www.rfc-editor.org/rfc/rfc2606?utm_source=openai',
  'https://en.wikipedia.org/wiki/Mercury_(planet)',
  'https://example.org/A_(B_(C))',
])('keeps an existing provider citation as one clickable link: %s', (url) => {
  const link = `[RFC Editor](${url})`;
  const text = `🌐 Reserved Names (${link}).`;
  const characters = Array.from(text);
  const recorded: string[] = [];
  expect(
    renderInlineCitations(
      text,
      [
        {
          source: { sourceType: 'url', url: url.replaceAll('(', '%28').replaceAll(')', '%29') },
          startIndex: characters.indexOf('[') + 1,
          endIndex: characters.indexOf(']'),
        },
      ],
      (markdown) => recorded.push(markdown),
    ),
  ).toBe(text);
  expect(recorded).toEqual([link]);
});

function eventStream(events: Record<string, unknown>[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function complete() {
  return {
    type: 'response.completed',
    response: { usage: { input_tokens: 30, output_tokens: 18 } },
  };
}

describe('OpenAI Responses durable execution', () => {
  it('replays encrypted reasoning and the tool output after a cold clarification resume', async () => {
    const requests: Record<string, unknown>[] = [];
    const question = {
      type: 'function_call',
      id: 'fc_fixture',
      call_id: 'call_fixture',
      name: 'ask_user',
      arguments: JSON.stringify({ question: 'What is the color?' }),
    };
    const reasoning = {
      type: 'reasoning',
      id: 'rs_fixture',
      encrypted_content: 'synthetic-encrypted-reasoning',
    };
    const message = { type: 'message', id: 'msg_fixture' };
    const options: NativeRuntimeOptions = {
      storage: new InMemoryStore(),
      model: {
        selection: {
          key: 'gpt',
          route: 'openai',
          model: 'gpt-5',
          connection: 'openai',
          webSearch: false,
          contextTokens: 64000,
        },
        access: { connection: 'openai', apiKey: 'synthetic-openai' },
        async fetchImpl(input, init) {
          expect(String(input)).toBe('https://api.openai.com/v1/responses');
          requests.push(JSON.parse(String(init?.body)));
          const created = {
            type: 'response.created',
            response: { id: `resp_${requests.length}`, model: 'gpt-5', created_at: 1795000000 },
          };
          if (requests.length === 1)
            return eventStream([
              created,
              { type: 'response.output_item.added', output_index: 0, item: reasoning },
              {
                type: 'response.reasoning_summary_text.delta',
                item_id: reasoning.id,
                output_index: 0,
                summary_index: 0,
                delta: 'Ask for the missing value.',
              },
              { type: 'response.output_item.done', output_index: 0, item: reasoning },
              {
                type: 'response.output_item.added',
                output_index: 1,
                item: { ...question, arguments: '' },
              },
              {
                type: 'response.function_call_arguments.delta',
                output_index: 1,
                item_id: question.id,
                delta: question.arguments,
              },
              {
                type: 'response.output_item.done',
                output_index: 1,
                item: { ...question, status: 'completed' },
              },
              complete(),
            ]);
          return eventStream([
            created,
            { type: 'response.output_item.added', output_index: 0, item: message },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: message.id,
              delta: 'The color is violet.',
            },
            { type: 'response.output_item.done', output_index: 0, item: message },
            complete(),
          ]);
        },
      },
      instructions: 'Use the clarification tool when required.',
      tools: {},
      beforeDispatch: async () => {},
      contextTokens: 1024,
      outputTokens: 128,
      maxSteps: 3,
    };
    const first = createNativeRuntime(options);
    const second = createNativeRuntime(options);
    try {
      const memory = { thread: 'test-thread', resource: 'test-workspace' };
      const started = await runNativeSegment(
        await first.agent.stream('Please name the color.', { memory, closeOnSuspend: true }),
      );
      expect(started.uncertain).toBe(false);
      expect(started.suspended).toMatchObject({ toolCallId: question.call_id });
      expect(requests).toHaveLength(1);
      const resumed = await runNativeSegment(
        await second.agent.resume(started.runId, 'violet', {
          memory,
          toolCallId: question.call_id,
          closeOnSuspend: true,
        }),
      );
      expect(resumed.uncertain).toBe(false);
      expect(resumed.text).toBe('The color is violet.');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        store: false,
        input: expect.arrayContaining([
          expect.objectContaining(reasoning),
          expect.objectContaining({ type: 'function_call', call_id: question.call_id }),
          expect.objectContaining({
            type: 'function_call_output',
            call_id: question.call_id,
            output: expect.stringContaining('violet'),
          }),
        ]),
      });
      expect(requests[1]?.previous_response_id).toBeNull();
    } finally {
      await first.mastra.shutdown();
      await second.mastra.shutdown();
    }
  });
});
