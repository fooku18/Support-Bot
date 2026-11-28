import { testSelection } from '../model-fixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { nativeReadServices } from '../../src/application/bindings/read-services.js';
import { createReadServiceTools } from '../../src/mastra/tools/read-services.js';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';
import { nativeInstructions } from '../../src/application/instructions.js';
import { fixture, send, text } from './provider-search-fixture.js';
import type { IntakeRequest } from '../../src/contracts/dto.js';
import type { WebReader } from '../../src/integrations/web/gemini-reader.js';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { InMemoryStore } = require('@mastra/core/storage') as {
  InMemoryStore: new () => Parameters<typeof createNativeRuntime>[0]['storage'];
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const identity = { teamId: 'TTEAM', channelId: 'CCHAN', userId: 'UTEST' } as IntakeRequest;
async function setup(assigned = true, configured = true, reader?: WebReader) {
  const config = deriveCoordinatorConfig(
    compileDocument(1, {
      installations: [
        {
          teamId: 'TTEAM',
          teamName: 'Synthetic',
          botUserId: 'UBOT',
          botId: 'BBOT',
          status: 'whitelisted',
          trustedBotSender: null,
        },
      ],
      channels: [{ teamId: 'TTEAM', channelId: 'CCHAN', enabled: true }],
      blockedMembers: [],
      toolInstances: [
        {
          id: 'ti_1150000000000003',
          teamId: 'TTEAM',
          kind: 'webFetch',
          label: 'Fetch',
          host: null,
          settings: {},
          hasCredential: false,
          credentialVersion: 1,
          status: 'enabled',
        },
      ],
      channelTools: assigned
        ? [
            {
              teamId: 'TTEAM',
              channelId: 'CCHAN',
              kind: 'webFetch',
              instanceId: 'ti_1150000000000003',
            },
          ]
        : [],
    }),
    {
      modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
      admission: { global: 1, perThread: 1 },
      execution: { maxInferenceInvocations: 5 },
    },
  );
  const requests: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/readyz') {
      res.end(JSON.stringify({ instances: [] }));
      return;
    }
    expect(req.headers.authorization).toBe('Bearer synthetic-web-transport');
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.url.includes('127.0.0.1')) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'private target refused' }));
      return;
    }
    res.end(JSON.stringify({ output: '<h1>FETCH_FACT_115</h1>', evidence: 'public HTTP200' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  const binding = await nativeReadServices({
    configuration: async () => config,
    ...(reader
      ? { web: { reader } }
      : configured
        ? { web: { url, token: 'synthetic-web-transport' } }
        : {}),
  })(identity, controller.signal);
  let allowed = true;
  const tools = createReadServiceTools({
    ...binding,
    authorize: async (capability) => {
      expect(capability).toBe('webFetch');
      if (!allowed) throw new Error('fetch revoked');
    },
  });
  const execute = async (target: string, question = 'What does the page say?') =>
    tools.web_fetch!.execute!(
      { url: target, question },
      {} as Parameters<NonNullable<NonNullable<typeof tools.web_fetch>['execute']>>[1],
    );
  return {
    tools,
    binding,
    requests,
    controller,
    execute,
    revoke: () => {
      allowed = false;
    },
  };
}

it('uses actual durable discovery and the isolated fetch transport, with content-dependent answers and fresh receipts', async () => {
  const f = await setup();
  let serial = 0;
  const gateway = await fixture((res, _index, body) => {
    const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
    const retrieved = JSON.stringify((body.messages as unknown[]).at(-1)).includes(
      'FETCH_FACT_115',
    );
    if (retrieved) {
      send(res, [text('Page says FETCH_FACT_115.')]);
      return;
    }
    const name = names.includes('web_fetch') ? 'web_fetch' : 'search_tools';
    send(
      res,
      [
        {
          type: 'tool_use',
          id: `fetch-${++serial}`,
          name,
          input:
            name === 'web_fetch'
              ? { url: 'https://example.com/', question: 'What does the page say?' }
              : { query: 'web_fetch' },
        },
      ],
      'tool_use',
    );
  });
  cleanup.push(gateway.close);
  const runtime = createNativeRuntime({
    storage: new InMemoryStore(),
    model: gateway.request,
    instructions: nativeInstructions({ maxSteps: 5, timeoutMs: 120000 }),
    tools: f.tools,
    beforeDispatch: async () => {},
    contextTokens: 12000,
    outputTokens: 1000,
    maxSteps: 5,
  });
  cleanup.push(() => runtime.mastra.shutdown());
  const run = async () =>
    runNativeSegment(
      await runtime.agent.stream('Fetch the public page.', {
        memory: { thread: 'fetch-thread', resource: 'fetch-resource' },
        closeOnSuspend: true,
      }),
    );
  const first = await run();
  expect(first.uncertain).toBe(false);
  expect(first.text).toBe('Page says FETCH_FACT_115.');
  expect(first.webFetch).toHaveLength(1);
  expect(first.webFetch[0]!.bytes).toBe(Buffer.byteLength('<h1>FETCH_FACT_115</h1>'));
  expect(first.webSearch).toEqual([]);
  expect(f.requests).toEqual([
    {
      instanceId: 'ti_1150000000000003',
      teamId: 'TTEAM',
      url: 'https://example.com/',
      maxOutputBytes: 48000,
    },
  ]);
  const next = await run();
  expect(next.webFetch).toHaveLength(1);
  expect(next.webFetch[0]!.id).not.toBe(first.webFetch[0]!.id);
  expect(f.requests).toHaveLength(2);
});
it('fails closed on CLI service invocation without a transport', async () => {
  const { binding } = await setup();
  const { services } = binding;
  expect(binding.catalog.gitlab).toBe(false);
  expect([...binding.enabled]).toEqual(['webFetch']);
  await expect(services.gitlab('get_project', {})).rejects.toThrow('Unavailable');
  await expect(services.atlassian('getIssue', {})).rejects.toThrow('Unavailable');
  await expect(services.datadog('logs', {})).rejects.toThrow('Unavailable');
  await expect(services.cloudflareGet({})).rejects.toThrow('Unavailable');
  await expect(services.slackGetUser({})).rejects.toThrow('Unavailable');
});

it('omits the tool without assignment or isolated transport configuration', async () => {
  for (const [assigned, configured] of [
    [false, true],
    [true, false],
  ]) {
    const f = await setup(assigned, configured);
    expect(f.tools).not.toHaveProperty('web_fetch');
    expect(f.requests).toEqual([]);
  }
});
it('refuses credential-bearing, non-HTTP and non-web-port targets before transport, and preserves isolated private-target refusal', async () => {
  const f = await setup();
  for (const target of [
    'file:///etc/passwd',
    'https://user:password@example.com/',
    'https://example.com:9879/',
  ])
    await expect(f.execute(target)).rejects.toThrow('web_fetch requires');
  expect(f.requests).toEqual([]);
  await expect(f.execute('http://127.0.0.1/')).rejects.toThrow('private target refused');
});
it('checks current authority and cancellation before the isolated request', async () => {
  const f = await setup();
  f.revoke();
  await expect(f.execute('https://example.com/')).rejects.toThrow('fetch revoked');
  expect(f.requests).toEqual([]);
  const c = await setup();
  c.controller.abort();
  await expect(c.execute('https://example.com/')).rejects.toThrow('canceled');
  expect(c.requests).toEqual([]);
});

it('reads through the configured reader instead, with the same authority checks', async () => {
  const f = await setup(true, true, {
    baseUrl: 'https://models.example.test/v1beta',
    model: 'gemini-test',
    apiKey: 'synthetic-reader-key',
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: 'READER_FACT' }] },
              urlContextMetadata: {
                urlMetadata: [
                  {
                    retrievedUrl: 'https://example.com/',
                    urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
                  },
                ],
              },
            },
          ],
        }),
      )) as unknown as typeof fetch,
  });
  const { result } = (await f.execute('https://example.com/')) as unknown as {
    result: { ok: boolean; output: string };
  };
  expect(result.ok).toBe(true);
  expect(result.output).toContain('READER_FACT');
  // The isolated runtime is not used, and private targets never leave the process.
  expect(f.requests).toEqual([]);
  for (const target of ['http://127.0.0.1/', 'http://admin-app/', 'file:///etc/passwd'])
    await expect(f.execute(target)).rejects.toThrow('web_fetch requires');
  await expect(f.execute('https://example.com/', ' ')).rejects.toThrow('requires a question');
  f.revoke();
  await expect(f.execute('https://example.com/')).rejects.toThrow('fetch revoked');
});
