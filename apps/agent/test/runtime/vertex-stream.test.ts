import { JWT } from 'google-auth-library';
import { InMemoryStore } from '@mastra/core/storage';
import { expect, it } from 'vitest';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { nativeInputMessage } from '../../src/mastra/runtime/native-inputs.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';
import type { NativeInputReceipt } from '../../src/domain/files/native-inputs.js';

const question = { question: 'What detail should I check?' };
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64 = image.toString('base64');

function claudeEvents() {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [],
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'ask_user', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(question) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ];
}

function geminiEvents() {
  return [
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'ask_user', args: question } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
    },
  ];
}

it.each([
  { route: 'vertex-claude', model: 'claude-sonnet@20250514', operation: ':streamRawPredict' },
  { route: 'vertex-gemini', model: 'gemini-2.5-pro', operation: ':streamGenerateContent?alt=sse' },
] as const)(
  'streams a $route tool call with an inline image through Mastra',
  async ({ route, model, operation }) => {
    const claude = route === 'vertex-claude';
    const publisher = claude ? 'anthropic' : 'google';
    const authClient = new JWT();
    authClient.setCredentials({ access_token: 'fixture-vertex-token' });
    const requests: Record<string, unknown>[] = [];
    const runtime = createNativeRuntime({
      storage: new InMemoryStore(),
      model: {
        selection: { key: 'vertex', route, model, connection: 'vertex-fixture', webSearch: false },
        access: {
          connection: 'vertex',
          authClient,
          project: 'fixture-project',
          location: 'global',
          host: 'aiplatform.googleapis.com',
        },
        async fetchImpl(input, init) {
          expect(String(input)).toBe(
            `https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/${publisher}/models/${model}${operation}`,
          );
          expect(new Headers(init?.headers).get('authorization')).toBe(
            'Bearer fixture-vertex-token',
          );
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            (claude ? claudeEvents() : geminiEvents())
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          );
        },
      },
      nativeInputs: true,
      instructions: 'Ask the user if the image is ambiguous.',
      tools: {},
      beforeDispatch: async () => {},
      contextTokens: 1024,
      outputTokens: 128,
      maxSteps: 2,
    });
    try {
      const receipt = { file: { mime: 'image/png' } } as NativeInputReceipt;
      const prompt = nativeInputMessage('Read the image.', [{ receipt, bytes: image }], route);
      const result = await runNativeSegment(
        await runtime.agent.stream(prompt, { closeOnSuspend: true }),
      );
      expect(result.uncertain).toBe(false);
      expect(result.suspended).toMatchObject({ toolName: 'ask_user' });
      expect(requests).toHaveLength(1);
      if (claude) {
        expect(requests[0]).toMatchObject({
          messages: [
            {
              content: expect.arrayContaining([
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: base64 },
                },
              ]),
            },
          ],
          tools: expect.arrayContaining([expect.objectContaining({ name: 'ask_user' })]),
        });
      } else {
        expect(requests[0]).toMatchObject({
          contents: [
            {
              parts: expect.arrayContaining([
                { inlineData: { mimeType: 'image/png', data: base64 } },
              ]),
            },
          ],
          tools: expect.arrayContaining([
            expect.objectContaining({
              functionDeclarations: expect.arrayContaining([
                expect.objectContaining({ name: 'ask_user' }),
              ]),
            }),
          ]),
        });
      }
    } finally {
      await runtime.mastra.shutdown();
    }
  },
);
