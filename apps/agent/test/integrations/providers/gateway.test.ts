import * as modelAddress from '../../../src/contracts/model-address.js';
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { modelFetch } from '../../../src/infrastructure/outbound.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  modelEgressHosts,
  parseModelCatalog,
  type ModelRoute,
} from '../../../src/contracts/model-catalog.js';
import { RuntimeConfigurationError } from '../../../src/infrastructure/configuration-error.js';
import { loadModelProviders } from '../../../src/integrations/providers/access.js';
import { createAnswerModel } from '../../../src/mastra/runtime/model.js';

const gateway = 'https://models.example.test';
const secret = 'synthetic-fixture-key';
const publishers = '/v1/projects/test-project/locations/global/publishers';
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }];
const options = { nativeTextDocuments: false, timeoutMs: 5000 };
function catalog(route: ModelRoute, model = 'fixture') {
  return {
    MODEL_CATALOG: JSON.stringify([{ key: 'test', route, model }]),
    MODEL_DEFAULT_KEY: 'test',
  };
}

it.each(['anthropic', 'openai'] as const)(
  'pins the %s body model and normalized endpoint',
  async (route) => {
    const prefix = 'NATIVE_' + route.toUpperCase();
    const env = {
      ...catalog(route, 'vertex_ai/claude-sonnet-4-5@20250929'),
      [prefix + '_API_KEY']: secret,
    };
    for (const [base, suffix] of [
      ['  ', ''],
      [gateway, ''],
      [gateway + '/team///', '/team'],
      [gateway + '/team/v1/', '/team'],
    ]) {
      for (const mode of route === 'anthropic' ? ['x-api-key', 'bearer'] : ['bearer']) {
        const settings = { ...env, [prefix + '_BASE_URL']: base, NATIVE_ANTHROPIC_AUTH_MODE: mode };
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(secret, { status: 302, headers: { location: 'https://elsewhere.test' } }),
          );
        const providers = loadModelProviders(settings, fetchImpl);
        const selection = providers.modelPolicy.models[0]!;
        const origin = base!.trim() ? gateway : 'https://api.' + route + '.com';
        const root = origin + suffix + '/v1';
        expect(selection.connection).toBe(base!.trim() ? route + ':' + root : route);
        expect(modelEgressHosts(providers.modelPolicy, settings)).toEqual([
          new URL(origin).hostname,
        ]);
        await expect(
          createAnswerModel(providers.bind(selection), options).doGenerate({ prompt }),
        ).rejects.toThrow('invalid_response: The model returned an empty or invalid answer');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(String(url)).toBe(root + (route === 'openai' ? '/responses' : '/messages'));
        expect(init?.redirect).toBe('error');
        expect(JSON.parse(String(init?.body)).model).toBe(selection.model);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(mode === 'bearer' ? 'Bearer ' + secret : null);
        expect(headers.get('x-api-key')).toBe(mode === 'bearer' ? null : secret);
      }
    }
    for (const id of ['../x', 'https://foo', '/x', 'x/', 'a/b/c', 'x y', 'x\n', 'a..b'])
      expect(() => parseModelCatalog(catalog(route, id).MODEL_CATALOG, 'test')).toThrow('model ID');
  },
);

it.each(['anthropic', 'openai', 'vertex-claude'] as const)(
  'rejects unsafe %s gateway URLs without reflecting input',
  (route) => {
    const prefix = 'NATIVE_' + (route === 'vertex-claude' ? 'VERTEX' : route.toUpperCase());
    for (const base of [
      'http://models.test',
      'https://models.test:0',
      'https://user:password@models.test',
      'https://models.test?',
      'https://models.test/#',
      'https://127.1',
      'https://[::1]',
      'https://169.254.169.254',
      'https://localhost',
      'https://a.localhost',
      'https://metadata.google.internal',
      'https://models.test/../secret',
      'https://models.test/%2f',
      'https://models.test\\other',
    ]) {
      const load = () =>
        loadModelProviders({
          ...catalog(route),
          [prefix + '_BASE_URL']: base,
          [prefix + '_API_KEY']: secret,
        });
      expect(load).toThrow(RuntimeConfigurationError);
      expect(load).toThrow(new RegExp('^' + prefix + '_BASE_URL must name a valid HTTPS gateway$'));
    }
  },
);

it('rejects incomplete or conflicting gateway settings before accessing credentials', () => {
  const base = { NATIVE_VERTEX_BASE_URL: gateway + publishers };
  const key = { NATIVE_VERTEX_API_KEY: secret };
  for (const settings of [
    base,
    key,
    { NATIVE_VERTEX_AUTH_MODE: 'bearer' },
    { ...base, ...key, NATIVE_VERTEX_AUTH_MODE: 'invalid' },
    ...[
      '/projects/foo',
      '/locations/global',
      '/publishers/google',
      '/publishers/anthropic',
      '/projects/foo/publishers',
    ].map((path) => ({ ...key, NATIVE_VERTEX_BASE_URL: gateway + path })),
    {
      ...key,
      NATIVE_VERTEX_BASE_URL: gateway + '/publishers',
      NATIVE_VERTEX_PROJECT: 'test-project',
    },
    {
      ...key,
      NATIVE_VERTEX_BASE_URL: gateway + '/v1/publishers',
      NATIVE_VERTEX_LOCATION: 'global',
    },
    {
      ...key,
      NATIVE_VERTEX_BASE_URL: gateway + publishers.replace('v1', 'v1beta1'),
      NATIVE_VERTEX_PROJECT: 'other-project',
    },
    {
      ...key,
      NATIVE_VERTEX_BASE_URL:
        gateway + publishers.replace('v1', 'v1beta1').replace('test-project', 'bad'),
    },
    { ...base, ...key, NATIVE_VERTEX_CREDENTIALS: secret },
    { ...base, ...key, NATIVE_VERTEX_CREDENTIALS_FILE: '/absent' },
    { ...base, ...key, NATIVE_VERTEX_API_KEY_FILE: '/absent' },
    { ...base, ...key, NATIVE_VERTEX_LOCATION: 'us-east1' },
    { ...key, NATIVE_VERTEX_BASE_URL: gateway },
    { ...key, NATIVE_VERTEX_BASE_URL: gateway + publishers + '/google' },
  ]) {
    expect(() => loadModelProviders({ ...catalog('vertex-gemini'), ...settings })).toThrow(
      RuntimeConfigurationError,
    );
  }
  expect(() =>
    loadModelProviders({
      ...catalog('anthropic'),
      NATIVE_ANTHROPIC_AUTH_MODE: 'unknown',
      NATIVE_ANTHROPIC_API_KEY: secret,
    }),
  ).toThrow(RuntimeConfigurationError);
});

it.each(['vertex-claude', 'vertex-gemini'] as const)(
  'dispatches %s generation and streaming to the synthetic gateway',
  async (route) => {
    const claude = route === 'vertex-claude';
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      req.resume();
      if (req.headers.authorization !== 'Bearer ' + secret) {
        res.writeHead(401).end();
        return;
      }
      const message = {
        id: 'msg_fixture',
        model: 'fixture',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const candidate = {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      };
      if (req.url?.includes(':stream')) {
        const events = claude
          ? [
              { type: 'message_start', message: { ...message, content: [] } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_stop' },
            ]
          : [candidate];
        res
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
      } else
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(claude ? message : candidate));
    });
    const directory = mkdtempSync(join(tmpdir(), 'gateway-key-'));
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing fixture port');
      const file = join(directory, 'key');
      writeFileSync(file, secret);
      const env = {
        ...catalog(route),
        ...(claude
          ? {
              NATIVE_VERTEX_BASE_URL: gateway + '/team' + publishers + '/',
              NATIVE_VERTEX_API_KEY_FILE: file,
            }
          : {
              NATIVE_VERTEX_BASE_URL: gateway + '/team/v1',
              NATIVE_VERTEX_API_KEY: secret,
              NATIVE_VERTEX_PROJECT: 'test-project',
              NATIVE_VERTEX_LOCATION: 'global',
            }),
      };
      const providers = loadModelProviders(env, (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe(gateway);
        expect(init?.redirect).toBe('error');
        return fetch('http://127.0.0.1:' + address.port + url.pathname + url.search, init);
      });
      const selection = providers.modelPolicy.models[0]!;
      expect(selection.connection).toBe('vertex:' + gateway + '/team' + publishers);
      expect(modelEgressHosts(providers.modelPolicy, env)).toEqual(['models.example.test']);
      const model = createAnswerModel(providers.bind(selection), options);
      expect((await model.doGenerate({ prompt })).content).toMatchObject([
        { type: 'text', text: 'ok' },
      ]);
      const reader = (await model.doStream({ prompt })).stream.getReader();
      const output: string[] = [];
      for (let part = await reader.read(); !part.done; part = await reader.read())
        if (part.value.type === 'text-delta') output.push(part.value.delta);
      expect(output.join('')).toBe('ok');
      const target =
        '/team' + publishers + (claude ? '/anthropic' : '/google') + '/models/fixture:';
      expect(paths).toEqual([
        target + (claude ? 'rawPredict' : 'generateContent'),
        target + (claude ? 'streamRawPredict' : 'streamGenerateContent?alt=sse'),
      ]);
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('checks resolved model addresses on direct connections while admitting private cluster IPs', async () => {
  expect(modelAddress.refusedModelAddress('10.96.0.12')).toBe(false);
  expect(modelAddress.refusedModelAddress('fd00::12')).toBe(false);
  for (const address of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.2',
    'fe80::1',
    '169.254.169.254',
    'fd00:ec2::254',
  ])
    expect(modelAddress.refusedModelAddress(address)).toBe(true);
  await expect(modelFetch('https://localhost')).rejects.toMatchObject({
    cause: { message: 'Model destination refused' },
  });
});

it('sends exactly one configured credential with ambient SDK credentials present', async () => {
  const ambient = 'ambient-synthetic-sentinel';
  try {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'GOOGLE_VERTEX_API_KEY',
    ])
      vi.stubEnv(name, ambient);
    for (const route of ['anthropic', 'openai', 'vertex-claude', 'vertex-gemini'] as const) {
      const vertex = route.startsWith('vertex-');
      const prefix = 'NATIVE_' + (vertex ? 'VERTEX' : route.toUpperCase());
      const modes = vertex
        ? ['bearer', 'x-goog-api-key', 'x-api-key']
        : route === 'anthropic'
          ? ['x-api-key', 'bearer']
          : ['bearer'];
      for (const mode of modes) {
        const base = vertex
          ? gateway +
            (mode === 'bearer'
              ? publishers.replace('v1', 'v1beta1')
              : mode === 'x-api-key'
                ? '/vertex/publishers'
                : '/vertex/v1/publishers')
          : gateway;
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 401 }));
        const providers = loadModelProviders(
          {
            ...catalog(route),
            [prefix + '_API_KEY']: secret,
            [prefix + '_BASE_URL']: base,
            ...(route !== 'openai' && { [prefix + '_AUTH_MODE']: mode }),
          },
          fetchImpl,
        );
        const selection = providers.modelPolicy.models[0]!;
        const model = createAnswerModel(providers.bind(selection), options);
        await expect(model.doGenerate({ prompt })).rejects.toThrow('provider_auth');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [input, init] = fetchImpl.mock.calls[0]!;
        const endpoint = {
          anthropic: '/v1/messages',
          openai: '/v1/responses',
          'vertex-claude': '/anthropic/models/fixture:rawPredict',
          'vertex-gemini': '/google/models/fixture:generateContent',
        }[route];
        expect(String(input)).toBe(base + endpoint);
        const headers = new Headers(init?.headers);
        const credentials = [...headers].filter(([name]) =>
          ['authorization', 'x-goog-api-key', 'x-api-key'].includes(name),
        );
        expect(credentials).toEqual([
          mode === 'bearer' ? ['authorization', 'Bearer ' + secret] : [mode, secret],
        ]);
        expect(JSON.stringify([...headers]) + String(input) + String(init?.body)).not.toContain(
          ambient,
        );
      }
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it('completes checked model fetches with single-address and all-address DNS callbacks', async () => {
  const server = createServer((_req, res) => res.setHeader('connection', 'close').end('fixture'));
  const originalFamily = getDefaultAutoSelectFamily();
  // Permit only this local fixture at the address-policy boundary. Node still
  // performs DNS lookup, socket connection and HTTP dispatch through undici.
  const check = vi
    .spyOn(modelAddress, 'refusedModelAddress')
    .mockImplementation((address) => !['127.0.0.1', '::1'].includes(address));
  try {
    server.listen(0);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture port');
    for (const all of [false, true]) {
      setDefaultAutoSelectFamily(all);
      check.mockClear();
      const response = await modelFetch('http://localhost:' + address.port);
      expect(await response.text()).toBe('fixture');
      expect(check).toHaveBeenCalled();
    }
  } finally {
    check.mockRestore();
    setDefaultAutoSelectFamily(originalFamily);
    server.close();
  }
});
