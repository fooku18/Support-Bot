import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JWT } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTEXT_TOKENS, parseModelCatalog } from '../../../src/contracts/model-catalog.js';
import {
  loadModelProviders,
  type ModelBinding,
} from '../../../src/integrations/providers/access.js';
import { guardedModelFetch } from '../../../src/integrations/providers/transport.js';
import { createAnswerModel } from '../../../src/mastra/runtime/model.js';
import { testSelection } from '../../model-fixture.js';

const sleep = vi.hoisted(() => vi.fn(async (_ms: number, ..._rest: unknown[]) => undefined));
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }));

const options = { nativeTextDocuments: false, timeoutMs: 5000 };
const prompt = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'Synthetic input' }] },
];
const tool = {
  type: 'function' as const,
  name: 'lookup',
  description: 'Read a fixture',
  inputSchema: {
    type: 'object' as const,
    properties: { value: { type: 'string' as const } },
    required: ['value'],
  },
};

describe('provider catalog', () => {
  const entry = { key: 'primary', route: 'vertex-claude', model: 'claude-sonnet@20250514' };
  it('validates IDs and defaults, and rejects ambiguous configuration', () => {
    expect(parseModelCatalog(JSON.stringify([entry]), 'primary')).toEqual({
      defaultKey: 'primary',
      models: [{ ...entry, webSearch: false, contextTokens: DEFAULT_CONTEXT_TOKENS }],
    });
    expect(
      parseModelCatalog(JSON.stringify([{ ...entry, contextTokens: 150_000 }]), 'primary')
        .models[0],
    ).toMatchObject({ contextTokens: 150_000 });
    for (const catalog of [
      [entry, entry],
      [{ ...entry, route: 'gateway' }],
      [{ ...entry, model: '../traversal' }],
      [{ ...entry, model: 'https://example.test/model' }],
      [{ ...entry, model: '' }],
      [{ ...entry, key: 'default' }],
      [{ ...entry, baseURL: 'https://example.test' }],
      [{ ...entry, route: 'vertex-gemini', model: 'gemini-test', webSearch: true }],
      [{ ...entry, webSearch: 'true' }],
      [{ ...entry, contextTokens: 7_999 }],
      [{ ...entry, contextTokens: 1_000_001 }],
      [{ ...entry, contextTokens: 64_000.5 }],
      [{ ...entry, contextTokens: '64000' }],
    ])
      expect(() => parseModelCatalog(JSON.stringify(catalog), 'primary')).toThrow('MODEL_CATALOG');
    expect(() => parseModelCatalog(JSON.stringify([entry]), 'absent')).toThrow('MODEL_DEFAULT_KEY');
  });

  it.each(['anthropic', 'openai'])(
    'binds direct %s keys and refuses ambiguous sources',
    (route) => {
      const name = 'NATIVE_' + route.toUpperCase() + '_API_KEY';
      const env = {
        MODEL_CATALOG: JSON.stringify([{ key: 'primary', route, model: 'fixture' }]),
        MODEL_DEFAULT_KEY: 'primary',
        [name]: 'synthetic-key',
      };
      const providers = loadModelProviders(env);
      expect(providers.bind(providers.modelPolicy.models[0]!).access).toEqual({
        connection: route,
        baseURL: `https://api.${route}.com/v1`,
        apiKey: 'synthetic-key',
      });
      expect(() => loadModelProviders({ ...env, [name + '_FILE']: '/synthetic/key' })).toThrow(
        'only one',
      );
    },
  );

  it('requires active credentials and projects the catalog without reading them in stub mode', () => {
    const env = {
      MODEL_CATALOG: JSON.stringify([entry]),
      MODEL_DEFAULT_KEY: 'primary',
      NATIVE_VERTEX_PROJECT: 'fixture-project',
      NATIVE_VERTEX_LOCATION: 'global',
    };
    expect(() => loadModelProviders(env)).toThrow('NATIVE_VERTEX_CREDENTIALS_FILE');
    const { modelPolicy, bind } = loadModelProviders({ ...env, NATIVE_MODEL_STUB: '1' });
    const selection = modelPolicy.models[0]!;
    expect(selection).toEqual({
      ...entry,
      route: 'anthropic',
      webSearch: false,
      connection: 'synthetic-messages',
      contextTokens: DEFAULT_CONTEXT_TOKENS,
    });
    expect(bind(selection).access).toMatchObject({ origin: 'http://model-stub:9877' });
    expect(() => bind({ ...selection, model: 'another' })).toThrow('model binding refused');
  });
});

it('sends a stateless Responses request and renders a URL annotation from the provider', async () => {
  const source = 'https://example.test/source';
  const response = {
    id: 'resp_fixture',
    model: 'gpt-5',
    created_at: 1795000000,
    status: 'completed',
    usage: { input_tokens: 7, output_tokens: 3 },
    output: [
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: { type: 'search', query: 'fixture', sources: [{ type: 'url', url: source }] },
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Read the source.',
            annotations: [
              { type: 'url_citation', start_index: 9, end_index: 15, url: source, title: 'Source' },
            ],
          },
        ],
      },
    ],
  };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const authorizeSearch = vi.fn();
  const model = createAnswerModel(
    {
      selection: {
        key: 'gpt',
        route: 'openai',
        model: 'gpt-5',
        connection: 'openai',
        webSearch: true,
        contextTokens: 64000,
      },
      access: { connection: 'openai', apiKey: 'synthetic-openai' },
      async fetchImpl(input, init) {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return Response.json(response);
      },
    },
    { ...options, authorizeSearch },
  );
  const result = await model.doGenerate({
    prompt,
    tools: [
      tool,
      {
        type: 'provider',
        id: 'openai.web_search',
        name: 'web_search',
        args: { externalWebAccess: true },
      },
    ],
  });
  expect(calls).toMatchObject([
    {
      url: 'https://api.openai.com/v1/responses',
      body: {
        store: false,
        max_tool_calls: 1,
        include: expect.arrayContaining([
          'reasoning.encrypted_content',
          'web_search_call.action.sources',
        ]),
        tools: expect.arrayContaining([
          expect.objectContaining({ type: 'function', name: 'lookup' }),
          { type: 'web_search', external_web_access: true },
        ]),
      },
    },
  ]);
  expect(authorizeSearch).toHaveBeenCalledTimes(1);
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: 'Read the [source](https://example.test/source).',
      }),
      expect.objectContaining({ type: 'tool-result', toolName: 'web_search' }),
    ]),
  );
});

function writeVertexFixture(directory: string) {
  const file = join(directory, 'vertex');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(
    file,
    JSON.stringify({
      type: 'service_account',
      client_email: 'fixture@test-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      private_key_id: 'a'.repeat(40),
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  );
  return file;
}

it('uses one explicit Vertex service account for both wire formats and refreshes its token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'support-model-fixture-'));
  try {
    const file = writeVertexFixture(directory);
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      authorization: string | null;
    }> = [];
    let exchanges = 0;
    const fixtures = [
      { key: 'claude', model: 'claude-sonnet@20250514', route: 'vertex-claude' },
      { key: 'gemini', model: 'gemini-2.5-pro', route: 'vertex-gemini' },
    ];
    const providers = loadModelProviders(
      {
        MODEL_CATALOG: JSON.stringify(fixtures),
        MODEL_DEFAULT_KEY: 'claude',
        NATIVE_VERTEX_PROJECT: 'fixture-project',
        NATIVE_VERTEX_LOCATION: 'europe-west1',
        NATIVE_VERTEX_CREDENTIALS: readFileSync(file, 'utf8'),
      },
      async (input, init) => {
        expect(init?.redirect).toBe('error');
        const url = String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          exchanges++;
          expect(String(init?.body)).toContain('grant_type=');
          return Response.json({
            token_type: 'Bearer',
            access_token: `fixture-${exchanges}`,
            expires_in: 1,
          });
        }
        calls.push({
          url,
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (url.endsWith(':rawPredict'))
          return Response.json({
            id: 'msg_fixture',
            type: 'message',
            model: 'claude-sonnet',
            role: 'assistant',
            content: [{ type: 'text', text: 'Claude synthetic' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 3 },
          });
        return Response.json({
          candidates: [
            {
              content: { parts: [{ text: 'Gemini synthetic' }], role: 'model' },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
        });
      },
    );
    for (const selection of providers.modelPolicy.models) {
      const model = createAnswerModel(providers.bind(selection), options);
      const result = await model.doGenerate({ prompt, tools: [tool] });
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/synthetic$/) }),
      ]);
    }
    expect(exchanges).toBe(2);
    expect(calls).toMatchObject([
      {
        url: 'https://europe-west1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/europe-west1/publishers/anthropic/models/claude-sonnet@20250514:rawPredict',
        authorization: 'Bearer fixture-1',
        body: {
          anthropic_version: 'vertex-2023-10-16',
          tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        },
      },
      {
        url: 'https://europe-west1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/europe-west1/publishers/google/models/gemini-2.5-pro:generateContent',
        authorization: 'Bearer fixture-2',
        body: { tools: [{ functionDeclarations: [{ name: 'lookup' }] }] },
      },
    ]);
    expect(calls[0]?.body).not.toHaveProperty('model');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('does not retry failed OAuth and cancels only the caller waiting for a shared refresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'support-model-fixture-'));
  try {
    const file = writeVertexFixture(directory);
    let signalReady!: (signal: AbortSignal) => void;
    let sendToken!: (response: Response) => void;
    const tokenStarted = new Promise<AbortSignal>((resolve) => {
      signalReady = resolve;
    });
    const tokenResponse = new Promise<Response>((resolve) => {
      sendToken = resolve;
    });
    let exchanges = 0;
    let dispatches = 0;
    const providers = loadModelProviders(
      {
        MODEL_CATALOG: JSON.stringify([
          { key: 'gemini', model: 'gemini-2.5-pro', route: 'vertex-gemini' },
        ]),
        MODEL_DEFAULT_KEY: 'gemini',
        NATIVE_VERTEX_PROJECT: 'fixture-project',
        NATIVE_VERTEX_LOCATION: 'global',
        NATIVE_VERTEX_CREDENTIALS_FILE: file,
      },
      async (input, init) => {
        if (String(input) === 'https://oauth2.googleapis.com/token') {
          exchanges++;
          if (exchanges === 1) return new Response(null, { status: 503 });
          signalReady(init!.signal!);
          return tokenResponse;
        }
        dispatches++;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-shared');
        return Response.json({
          candidates: [
            {
              content: { parts: [{ text: 'Still running' }], role: 'model' },
              finishReason: 'STOP',
            },
          ],
        });
      },
    );
    const model = createAnswerModel(providers.bind(providers.modelPolicy.models[0]!), options);
    await expect(model.doGenerate({ prompt })).rejects.toThrow('provider_auth');
    expect(exchanges).toBe(1);
    expect(dispatches).toBe(0);
    const cancelled = new AbortController();
    const first = expect(
      model.doGenerate({ prompt, abortSignal: cancelled.signal }),
    ).rejects.toThrow('timeout');
    const refreshSignal = await tokenStarted;
    const second = model.doGenerate({ prompt });
    cancelled.abort();
    await first;
    expect(refreshSignal.aborted).toBe(false);
    expect(dispatches).toBe(0);
    sendToken(
      Response.json({ access_token: 'fixture-shared', token_type: 'Bearer', expires_in: 3600 }),
    );
    await expect(second).resolves.toMatchObject({
      content: [expect.objectContaining({ text: 'Still running' })],
    });
    expect(exchanges).toBe(2);
    expect(dispatches).toBe(1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('accounts once for success, failure and cancellation and refuses unexpected dispatches first', async () => {
  const selection = testSelection('claude', 'claude-fixture', true);
  const recordRequest = vi.fn();
  const beforeDispatch = vi.fn();
  const authorizeSearch = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>();
  const binding: ModelBinding = {
    selection,
    access: { connection: 'anthropic', apiKey: 'synthetic-anthropic' },
    fetchImpl,
    accounting: {
      sink: { recordRequest, recordRun: vi.fn() },
      run: {
        instance: 'fixture',
        teamId: 'TTEAM',
        channelId: 'CTEST',
        rootTs: '1716234567.1',
        requesterUserId: 'UOWNER',
        runId: 'fixture-run',
        runSeq: 1,
        attempt: 1,
        model: selection,
        mode: 'answer',
      },
    },
  };
  const endpoint = 'https://api.anthropic.com/v1/messages';
  const dispatch = guardedModelFetch({
    ...options,
    binding,
    endpoint: (url) => url.href === endpoint,
    beforeDispatch,
    authorizeSearch,
  });
  const body = JSON.stringify({
    model: selection.model,
    tools: [{ type: 'web_search_20250305', max_uses: 1 }],
  });
  await expect(
    dispatch('https://elsewhere.test/v1/messages', { method: 'POST', body }),
  ).rejects.toThrow();
  authorizeSearch.mockRejectedValueOnce(new Error('revoked'));
  await expect(dispatch(endpoint, { method: 'POST', body })).rejects.toThrow('revoked');
  expect(fetchImpl).not.toHaveBeenCalled();
  fetchImpl.mockResolvedValueOnce(Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }));
  await (await dispatch(endpoint, { method: 'POST', body })).json();
  fetchImpl.mockResolvedValueOnce(new Response('private provider detail', { status: 429 }));
  await expect(dispatch(endpoint, { method: 'POST', body })).rejects.toThrow(
    'Model provider request failed',
  );
  const abort = new AbortController();
  fetchImpl.mockResolvedValueOnce(
    new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
  );
  const stream = await dispatch(endpoint, { method: 'POST', body, signal: abort.signal });
  abort.abort();
  await stream.body?.cancel();
  expect(fetchImpl.mock.calls.map(([, init]) => init?.redirect)).toEqual([
    'error',
    'error',
    'error',
  ]);
  expect(recordRequest.mock.calls.map(([, observation]) => observation)).toMatchObject([
    { status: 200, outcome: 'completed', inputTokens: 7, outputTokens: 3 },
    { status: 429, outcome: 'failed' },
    { status: 200, outcome: 'interrupted' },
  ]);
});

describe('connection failures before a response', () => {
  const endpoint = 'https://api.anthropic.com/v1/messages';
  const socketClosed = (code = 'UND_ERR_SOCKET') =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed https://private.test/detail'), { code }),
    });
  function setup(timeoutMs = options.timeoutMs) {
    const selection = testSelection('claude', 'claude-fixture', true);
    const recordRequest = vi.fn();
    const beforeDispatch = vi.fn();
    const authorizeSearch = vi.fn();
    const warn = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    const dispatch = guardedModelFetch({
      ...options,
      timeoutMs,
      endpoint: (url) => url.href === endpoint,
      beforeDispatch,
      authorizeSearch,
      log: { info: vi.fn(), warn, error: vi.fn() },
      binding: {
        selection,
        access: { connection: 'anthropic', apiKey: 'synthetic-anthropic' },
        fetchImpl,
        accounting: {
          sink: { recordRequest, recordRun: vi.fn() },
          run: {
            instance: 'fixture',
            teamId: 'TTEAM',
            channelId: 'CTEST',
            rootTs: '1716234567.1',
            requesterUserId: 'UOWNER',
            runId: 'fixture-run',
            runSeq: 1,
            attempt: 1,
            model: selection,
            mode: 'answer',
          },
        },
      },
    });
    const body = JSON.stringify({
      model: selection.model,
      tools: [{ type: 'web_search_20250305', max_uses: 1 }],
    });
    const send = () => dispatch(endpoint, { method: 'POST', body });
    const rows = () => recordRequest.mock.calls.map(([, observation]) => observation);
    return { fetchImpl, beforeDispatch, authorizeSearch, warn, send, rows };
  }

  it('reconnects once, re-authorizes the dispatch and accounts both attempts', async () => {
    const { fetchImpl, beforeDispatch, authorizeSearch, warn, send, rows } = setup();
    fetchImpl
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValueOnce(Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }));
    await (await send()).json();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledTimes(2);
    expect(authorizeSearch).toHaveBeenCalledTimes(2);
    expect(rows()).toMatchObject([
      { status: 0, outcome: 'failed' },
      { status: 200, outcome: 'completed', inputTokens: 7, outputTokens: 3 },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    const line = warn.mock.calls[0]![0] as string;
    expect(line).toMatch(
      /^model dispatch failed run_id=fixture-run attempt=1 status=0 error=TypeError code=UND_ERR_SOCKET elapsed_ms=\d+ reconnect=true$/,
    );
    expect(line).not.toContain('private.test');
  });

  it('rides out a burst of resets and gives up after three reconnects', async () => {
    const burst = setup();
    burst.fetchImpl
      .mockRejectedValueOnce(socketClosed('ECONNRESET'))
      .mockRejectedValueOnce(socketClosed('ECONNRESET'))
      .mockRejectedValueOnce(socketClosed('ECONNRESET'))
      .mockResolvedValueOnce(Response.json({ usage: { input_tokens: 7, output_tokens: 3 } }));
    sleep.mockClear();
    await (await burst.send()).json();
    expect(burst.fetchImpl).toHaveBeenCalledTimes(4);
    expect(burst.beforeDispatch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 1000, 3000]);

    const first = setup();
    for (let i = 0; i < 4; i++) first.fetchImpl.mockRejectedValueOnce(socketClosed('ECONNRESET'));
    sleep.mockClear();
    await expect(first.send()).rejects.toThrow('Model provider request failed');
    expect(first.fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(first.warn.mock.calls[2]![0]).toContain('attempt=3 status=0');
    expect(first.warn.mock.calls[2]![0]).toContain('reconnect=true');
    expect(first.warn.mock.calls[3]![0]).toContain('attempt=4 status=0');
    expect(first.warn.mock.calls[3]![0]).toContain('reconnect=false');
  });

  it('times out when the deadline passes during re-authorization', async () => {
    const late = setup(20);
    late.fetchImpl.mockRejectedValueOnce(socketClosed());
    late.beforeDispatch
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await expect(late.send()).rejects.toThrow('Model inference timed out');
    expect(late.fetchImpl).toHaveBeenCalledOnce();
    expect(late.rows()).toHaveLength(1);
  });

  it('does not reconnect unknown failures', async () => {
    const second = setup();
    second.fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(second.send()).rejects.toThrow('Model provider request failed');
    expect(second.fetchImpl).toHaveBeenCalledOnce();
    expect(second.warn.mock.calls[0]![0]).toContain('code=unknown');
    expect(second.warn.mock.calls[0]![0]).toContain('reconnect=false');
  });

  it('logs HTTP failures without reconnecting and stops when authority is revoked', async () => {
    const http = setup();
    http.fetchImpl.mockResolvedValueOnce(new Response('private provider detail', { status: 503 }));
    await expect(http.send()).rejects.toThrow('Model provider request failed');
    expect(http.fetchImpl).toHaveBeenCalledOnce();
    expect(http.warn.mock.calls[0]![0]).toMatch(/attempt=1 status=503 redirected=false/);

    const revoked = setup();
    revoked.fetchImpl.mockRejectedValueOnce(socketClosed());
    revoked.beforeDispatch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(revoked.send()).rejects.toThrow('revoked');
    expect(revoked.fetchImpl).toHaveBeenCalledOnce();
  });
});

it('refuses unsupported hosted tools and missing search caps before dispatch', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const base = { ...options, endpoint: () => true, authorizeSearch: vi.fn() };
  const anthropic = guardedModelFetch({
    ...base,
    binding: {
      selection: testSelection('claude', 'claude-fixture', true),
      access: { connection: 'anthropic', apiKey: 'synthetic-anthropic' },
      fetchImpl,
    },
  });
  const openai = guardedModelFetch({
    ...base,
    binding: {
      selection: {
        key: 'gpt',
        route: 'openai',
        model: 'gpt-5',
        connection: 'openai',
        webSearch: true,
        contextTokens: 64000,
      },
      access: { connection: 'openai', apiKey: 'synthetic-openai' },
      fetchImpl,
    },
  });
  const gemini = guardedModelFetch({
    ...base,
    binding: {
      selection: {
        key: 'gemini',
        route: 'vertex-gemini',
        model: 'gemini-test',
        connection: 'vertex-fixture',
        webSearch: false,
        contextTokens: 64000,
      },
      access: {
        connection: 'vertex',
        project: 'fixture-project',
        location: 'global',
        host: 'aiplatform.googleapis.com',
        authClient: new JWT(),
      },
      fetchImpl,
    },
  });
  for (const [dispatch, body] of [
    [anthropic, { model: 'claude-fixture', tools: [{ type: 'web_search_20250305' }] }],
    [anthropic, { model: 'claude-fixture', tools: [{ type: 'web_fetch_20250910' }] }],
    [openai, { model: 'gpt-5', store: false, tools: [{ type: 'web_search' }] }],
    [
      openai,
      { model: 'gpt-5', store: false, max_tool_calls: 1, tools: [{ type: 'code_interpreter' }] },
    ],
    [gemini, { tools: [{ googleSearch: {} }] }],
    [gemini, { tools: [{ functionDeclarations: [], urlContext: {} }] }],
  ] as const)
    await expect(
      dispatch('https://fixture.test', { method: 'POST', body: JSON.stringify(body) }),
    ).rejects.toThrow('authorization_denied');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('renders one provider annotation in the streamed GPT answer and records that link', async () => {
  const url = 'https://example.org/A_(B_(C))';
  const link = `[Source](${url})`;
  const text = `Read (${link}).`;
  const item = { type: 'message', id: 'msg_fixture' };
  const citations: string[] = [];
  const streamedEvents = [
    {
      type: 'response.created',
      response: { id: 'resp_stream', model: 'gpt-5', created_at: 1795000000 },
    },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, delta: text },
    {
      type: 'response.output_text.annotation.added',
      annotation: {
        type: 'url_citation',
        url,
        title: 'Source',
        start_index: 7,
        end_index: 13,
      },
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 10 } } },
  ];
  const model = createAnswerModel(
    {
      selection: {
        key: 'gpt',
        route: 'openai',
        model: 'gpt-5',
        connection: 'openai',
        webSearch: true,
        contextTokens: 64000,
      },
      access: { connection: 'openai', apiKey: 'synthetic-openai' },
      onCitation: (markdown) => citations.push(markdown),
      fetchImpl: async () =>
        new Response(streamedEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    },
    { ...options, authorizeSearch: async () => {} },
  );
  const result = await model.doStream({
    prompt,
    tools: [{ type: 'provider', id: 'openai.web_search', name: 'web_search', args: {} }],
  });
  const reader = result.stream.getReader();
  const output: string[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (part.value.type === 'text-delta') output.push(part.value.delta);
  }
  expect(output.join('')).toBe(text);
  expect(citations).toEqual([link]);
});
