import { testModel, testSelection } from '../model-fixture.js';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@mastra/core/storage';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';
import { createReadServiceTools } from '../../src/mastra/tools/read-services.js';
import { nativeInputMessage } from '../../src/mastra/runtime/native-inputs.js';

/** Real pinned Agent/durable wrapper/provider adapter and framework processors.
 * Replaces custom-loop timing/continuation/steering assertions for answer@1.
 * App ownership/PG restart/delivery boundaries live in durable-answer-vertical. */
describe('answer@2 native durable execution', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  async function fixture(
    contextTokens = 1024,
    instructions = 'TRUSTED current system instructions',
    studioRunIds?: string[],
  ) {
    const requests: Array<Record<string, unknown>> = [];
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
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'Native answer.' },
      });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
      send('message_stop', {});
      res.end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    let authorized = true;
    let guards = 0;
    const model = testModel(
      `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
      'fixture-token',
      testSelection('test', 'fixture'),
    );
    const runtime = createNativeRuntime({
      storage: new InMemoryStore(),
      instructions,
      model,
      ...(studioRunIds
        ? {
            modelForRun: (runId: string) => {
              studioRunIds.push(runId);
              return model;
            },
          }
        : {}),
      tools: {},
      beforeDispatch: async () => {
        guards++;
        if (!authorized) throw new Error('revoked');
      },
      contextTokens,
      outputTokens: 64,
      maxSteps: 2,
    });
    return {
      ...runtime,
      requests,
      revoke: () => {
        authorized = false;
      },
      guards: () => guards,
    };
  }
  it('uses the trusted framework run ID for each Studio model request', async () => {
    const runIds: string[] = [];
    const fixtureRuntime = await fixture(1024, 'trusted instructions', runIds);
    const first = await runNativeSegment(await fixtureRuntime.agent.stream('First Studio chat'));
    const second = await runNativeSegment(await fixtureRuntime.agent.stream('Second Studio chat'));
    expect(first.uncertain, JSON.stringify({ first, runIds })).toBe(false);
    expect(second.uncertain).toBe(false);
    expect(first.runId).not.toEqual(second.runId);
    expect(runIds).toEqual([first.runId, second.runId]);
    expect(JSON.stringify(fixtureRuntime.requests)).not.toContain(first.runId);
    expect(JSON.stringify(fixtureRuntime.requests)).not.toContain(second.runId);
    await fixtureRuntime.mastra.shutdown();
  });

  it('uses native durable wrapper with top-level clarification, no code/write tools', async () => {
    const f = await fixture();
    expect(f.agent.constructor.name).toBe('DurableAgent');
    expect(Object.keys(await f.agent.listTools())).toEqual(['ask_user']);
    const out = await runNativeSegment(await f.agent.stream('Question', { closeOnSuspend: true }));
    expect(out.text).toBe('Native answer.');
    expect(out.uncertain).toBe(false);
    expect(f.guards()).toBe(1);
    expect(JSON.stringify(f.requests)).toContain('TRUSTED current');
    expect(f.requests[0]!.max_tokens).toBeDefined();
  });
  it('checks current authority at provider dispatch and makes no retry', async () => {
    const f = await fixture();
    f.revoke();
    await expect(
      runNativeSegment(await f.agent.stream('Denied', { closeOnSuspend: true })),
    ).rejects.toThrow('revoked');
    expect(f.requests).toHaveLength(0);
    expect(f.guards()).toBe(1);
  });
  it('framework context processor refuses oversized system instructions before inference', async () => {
    const f = await fixture(32, 'SYSTEM '.repeat(300));
    const out = await runNativeSegment(await f.agent.stream('Question', { closeOnSuspend: true }));
    expect(f.requests).toHaveLength(0);
    expect(out.text).toBe('');
    expect(out.uncertain).toBe(true);
    expect(out.failure).toBe('processor_rejected');
    expect(out.receipt).toContain('fresh request');
  });
  it('refuses BOM text before the provider can silently strip its bytes', () => {
    const bytes = Buffer.from('\uFEFFDATA_FACT_BOM\r\n');
    const receipt = {
      identity: {
        installationId: 'UBOT',
        teamId: 'TTEST',
        channelId: 'CTEST',
        rootTs: '1.1',
        messageTs: '1.1',
        userId: 'UOWNER',
        authorBotId: null,
      },
      file: {
        id: 'FTEST',
        sourceTs: '1.1',
        name: 'test.md',
        mime: 'text/markdown',
        bytes: bytes.length,
        revision: 'test',
        hosted: true,
      },
      sha256: 'test',
    };
    expect(() => nativeInputMessage('Read', [{ receipt, bytes }])).toThrow('BOM');
  });
  it('framework memory supplies follow-up history and isolates both resource and thread', async () => {
    const f = await fixture();
    const stream = (prompt: string, thread: string, resource: string) =>
      f.agent.stream(prompt, { memory: { thread, resource }, closeOnSuspend: true });
    await runNativeSegment(await stream('FIRST_CONTEXT', 'thread-a', 'tenant-a'));
    await runNativeSegment(await stream('FOLLOW', 'thread-a', 'tenant-a'));
    expect(JSON.stringify(f.requests.at(-1))).toContain('FIRST_CONTEXT');
    await runNativeSegment(await stream('OTHER', 'thread-b', 'tenant-b'));
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('FIRST_CONTEXT');
  });
  it('keeps the opening request and marks left-out turns when a thread outgrows the budget', async () => {
    const f = await fixture(3000);
    const stream = (prompt: string) =>
      f.agent.stream(prompt, {
        memory: { thread: 'long', resource: 'tenant' },
        closeOnSuspend: true,
      });
    await runNativeSegment(await stream('OPENING alert question'));
    for (let i = 0; i < 4; i++)
      await runNativeSegment(await stream(`MIDDLE_${i} ` + 'detail '.repeat(1200)));
    const out = await runNativeSegment(await stream('CURRENT try again'));
    expect(out.uncertain).toBe(false);
    const last = JSON.stringify(f.requests.at(-1));
    expect(last).toContain('OPENING alert question');
    expect(last).toContain('CURRENT try again');
    expect(last).toContain('earlier messages of this conversation were left out');
    expect(last).not.toContain('MIDDLE_0');
  });
  it('does not allow a caller to choose a non-loopback Gateway or empty proxy token', async () => {
    const f = await fixture();
    const config = {
      storage: new InMemoryStore(),
      instructions: 'trusted',
      tools: {},
      beforeDispatch: async () => {},
      contextTokens: 128,
      outputTokens: 64,
      maxSteps: 2,
    };
    expect(() =>
      createNativeRuntime({
        ...config,
        model: testModel('http://127.0.0.1', 'token', {
          ...testSelection('test', 'fixture'),
          route: 'openai',
        }),
      }),
    ).toThrow();
    expect(() =>
      createNativeRuntime({
        ...config,
        model: testModel('http://127.0.0.1', '', testSelection('test', 'fixture')),
      }),
    ).toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it('bounds limits with framework configuration rather than a custom continuation engine', async () => {
    const f = await fixture();
    const output = await runNativeSegment(
      await f.agent.stream('ONE_REQUEST', {
        maxSteps: 1,
        closeOnSuspend: true,
        modelSettings: { maxOutputTokens: 20, maxRetries: 0 },
      }),
    );
    expect(output.finishReason).toBe('stop');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.max_tokens).toBe(20);
    expect(output.usage.inputTokens).toBeGreaterThan(0);
  });
  it('exposes only typed reads and leaves unqualified scoped Slack search unavailable', async () => {
    const unavailable = async () => {
      throw new Error('unavailable');
    };
    const tools = createReadServiceTools({
      enabled: new Set(['slack']),
      catalog: { gitlab: true, slackSearch: false },
      authorize: async () => {},
      services: {
        gitlab: unavailable,
        atlassian: unavailable,
        datadog: unavailable,
        datadogDescribe: unavailable,
        cloudflareGet: unavailable,
        cloudflareGraphql: unavailable,
        slackGetUser: unavailable,
        slackLookupUserByEmail: unavailable,
        slackSearchMessages: unavailable,
      },
    });
    expect(Object.keys(tools)).toContain('get_project');
    expect(Object.keys(tools)).not.toContain('create_issue');
    expect(Object.keys(tools)).not.toContain('slack_search_messages');
    expect(Object.keys(tools)).not.toContain('run_script');
  });
});
