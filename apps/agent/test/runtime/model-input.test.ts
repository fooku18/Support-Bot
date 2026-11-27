import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@mastra/core/storage';
import { testModel, testSelection } from '../model-fixture.js';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';
import { createReadServiceTools } from '../../src/mastra/tools/read-services.js';
import type { BrokerToolResult } from '../../src/integrations/tools/runtime-client.js';

type Body = Record<string, unknown> & { messages: { content: unknown }[] };

const records = Array.from({ length: 40 }, (_, i) => ({
  key: `PEX-${1000 + i}`,
  summary: `Checkout button misaligned on PDP variant ${i}`,
  status: 'Done',
}));
const output = JSON.stringify({ issues: records });

describe('model input of the native answer agent', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  async function run(
    tool: string,
    input: object,
    gitlab: () => Promise<BrokerToolResult>,
    { studio = false, followUp = false } = {},
  ) {
    const requests: Body[] = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', {
        message: {
          id: 'fixture',
          role: 'assistant',
          type: 'message',
          model: 'fixture',
          content: [],
          usage: { input_tokens: 9, output_tokens: 0 },
        },
      });
      if (requests.length <= 2) {
        const [name, args] =
          requests.length === 1 ? ['search_tools', { query: tool }] : [tool, input];
        send('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_${requests.length}`, name, input: {} },
        });
        send('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
        });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
      }
      send('message_stop', {});
      res.end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const unavailable = async (): Promise<never> => {
      throw new Error('unavailable');
    };
    const tools = createReadServiceTools({
      enabled: new Set(['atlassian']),
      catalog: {
        gitlab: true,
        slackSearch: false,
        atlassianOperations: ['searchJiraIssuesUsingJql'],
      },
      authorize: async () => {},
      services: {
        gitlab,
        atlassian: async () => ({
          ok: true,
          output,
          operationId: 'native-read',
          data: JSON.parse(output),
        }),
        datadog: unavailable,
        datadogDescribe: unavailable,
        cloudflareGet: unavailable,
        cloudflareGraphql: unavailable,
        slackGetUser: unavailable,
        slackLookupUserByEmail: unavailable,
        slackSearchMessages: unavailable,
      },
    });
    const model = testModel(
      `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
      'fixture-token',
      testSelection('test', 'fixture'),
    );
    const runtime = createNativeRuntime({
      storage: new InMemoryStore(),
      instructions: 'system',
      model,
      ...(studio ? { modelForRun: () => model } : {}),
      tools,
      beforeDispatch: async () => {},
      contextTokens: 200_000,
      outputTokens: 64,
      maxSteps: 3,
    });
    const memory = { memory: { thread: 'thread', resource: 'tenant' } };
    const out = await runNativeSegment(await runtime.agent.stream('find it', memory));
    if (followUp) await runNativeSegment(await runtime.agent.stream('and then?', memory));
    await runtime.mastra.shutdown();
    expect(requests).toHaveLength(followUp ? 4 : 3);
    const blocks = requests
      .at(-1)!
      .messages.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [],
      );
    const result = blocks.filter((b) => b.type === 'tool_result').at(-1)!;
    return { out, requests, result };
  }

  const gitlabOk = async (): Promise<BrokerToolResult> => ({
    ok: true,
    output: `ok (search @ code/x)\n${output}`,
    operationId: 'native-read',
    data: JSON.parse(output),
  });

  it.each([
    ['search', { scope: 'issues', search: 'checkout' }, `ok (search @ code/x)\n${output}`],
    ['searchJiraIssuesUsingJql', { jql: 'project = PEX' }, `ok (native-read):\n${output}`],
  ])('passes the %s result to the model as its text once', async (tool, input, text) => {
    const { result } = await run(tool, input, gitlabOk);
    expect(String(result.content).length).toBe(text.length);
    expect(result.content).toBe(text);
    expect(String(result.content).split('PEX-1000').length - 1).toBe(1);
    expect(result.is_error).toBeUndefined();
  });

  it('replays a read result from memory as its text once', async () => {
    const text = (await gitlabOk()).output;
    const { result } = await run('search', { scope: 'issues', search: 'checkout' }, gitlabOk, {
      followUp: true,
    });
    expect(String(result.content).length).toBe(text.length);
    expect(result.content).toBe(text);
    expect(String(result.content).split('PEX-1000').length - 1).toBe(1);
    expect(result.is_error).toBeUndefined();
  });

  it('shows a failed read to the model as its failure text', async () => {
    const { result } = await run('search', { scope: 'issues', search: 'checkout' }, async () => ({
      ok: false,
      output: 'failed (search @ code/x): [refused] scope denied',
      operationId: 'native-read',
    }));
    expect(result.content).toBe('failed (search @ code/x): [refused] scope denied');
  });

  it('shows invalid tool arguments to the model instead of failing the run', async () => {
    const { out, result } = await run('search', { scope: 'nope', search: 'checkout' }, gitlabOk);
    expect(out.uncertain).toBe(false);
    expect(String(result.content)).toContain('scope');
    expect(String(result.content)).not.toContain('PEX-1000');
  });

  it.each([false, true])('asks Anthropic to cache the prompt (studio %s)', async (studio) => {
    const { requests } = await run('search', { scope: 'issues', search: 'checkout' }, gitlabOk, {
      studio,
    });
    for (const request of requests) expect(request.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(requests)).not.toContain('supportAgent');
  });
});
