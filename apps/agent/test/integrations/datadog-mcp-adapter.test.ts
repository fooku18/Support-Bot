import { describe, expect, it } from 'vitest';
import {
  DatadogMcpSession,
  DatadogTransportError,
  boundDatadogOutput,
  classifyDatadogHttp,
  datadogCatalogHash,
  datadogEndpoint,
  datadogPermissionHint,
  datadogRequestUrl,
  guardedDatadogFetch,
  normalizeDatadogSite,
  normalizeDatadogToolsets,
  partitionDatadogCatalog,
} from '../../src/integrations/datadog/datadog-mcp-adapter.js';
import { DEFAULT_TOOLS, fakeDatadog } from './helpers/datadog-mcp.js';

const TOKEN = 'ddpat_test-token-0123456789';

function session(fake: ReturnType<typeof fakeDatadog>, token = TOKEN) {
  return new DatadogMcpSession({
    site: 'datadoghq.eu',
    toolsets: 'all',
    token,
    fetchImpl: fake.fetchImpl,
  });
}
const bounds = { timeoutMs: 5_000, maxOutputBytes: 10_000 };

describe('Datadog endpoint derivation', () => {
  it('derives only https://mcp.<site>/v1/mcp for commercial sites', () => {
    expect(datadogEndpoint('datadoghq.eu')).toBe('https://mcp.datadoghq.eu/v1/mcp');
    expect(datadogEndpoint('us3.datadoghq.com')).toBe('https://mcp.us3.datadoghq.com/v1/mcp');
    expect(String(datadogRequestUrl('datadoghq.com', 'core,error-tracking'))).toBe(
      'https://mcp.datadoghq.com/v1/mcp?toolsets=core%2Cerror-tracking',
    );
  });

  it('refuses hosts, paths, schemes, credentials and gov sites', () => {
    for (const site of [
      'https://datadoghq.eu',
      'datadoghq.eu/v1',
      'evil.example',
      'datadoghq.eu.evil.example',
      'user@datadoghq.eu',
      'mcp.datadoghq.eu:444',
      'a.b.datadoghq.com',
      '',
    ])
      expect(() => normalizeDatadogSite(site), site).toThrow(/DATADOG_SITE/);
    expect(() => normalizeDatadogSite('ddog-gov.com')).toThrow(/gov/);
  });

  it('validates toolsets as all or a comma list', () => {
    expect(normalizeDatadogToolsets('all')).toBe('all');
    expect(normalizeDatadogToolsets('core,apm')).toBe('core,apm');
    for (const bad of ['', 'core,', 'Core', 'core;rm', 'all,core&x=1', 'a b'])
      expect(() => normalizeDatadogToolsets(bad), bad).toThrow(/DATADOG_TOOLSETS/);
  });
});

describe('guarded Datadog fetch', () => {
  const endpoint = 'https://mcp.datadoghq.eu/v1/mcp';

  it('attaches the bearer token only to the pinned endpoint and never follows redirects', async () => {
    const fake = fakeDatadog();
    const guarded = guardedDatadogFetch(endpoint, TOKEN, { fetchImpl: fake.fetchImpl });
    await guarded(`${endpoint}?toolsets=all`, { method: 'POST', body: '{}' });
    expect(fake.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fake.seen[0]?.redirect).toBe('manual');
    for (const url of [
      'https://mcp.datadoghq.com/v1/mcp',
      'https://mcp.datadoghq.eu/v2/mcp',
      'http://mcp.datadoghq.eu/v1/mcp',
      'https://user:pw@mcp.datadoghq.eu/v1/mcp',
      'https://evil.example/v1/mcp',
    ])
      await expect(guarded(url, { method: 'POST' }), url).rejects.toThrow(/pinned MCP endpoint/);
    expect(fake.seen).toHaveLength(1);
  });

  it('answers GET locally with 405 (no standing stream) and refuses other methods', async () => {
    const fake = fakeDatadog();
    const guarded = guardedDatadogFetch(endpoint, TOKEN, { fetchImpl: fake.fetchImpl });
    expect((await guarded(endpoint, { method: 'GET' })).status).toBe(405);
    await expect(guarded(endpoint, { method: 'PUT' })).rejects.toThrow(/method/);
    expect(fake.seen).toHaveLength(0);
  });

  it('classifies 3xx, 401, 403, 404 and 429 without exposing the body', async () => {
    const cases: Array<[number, string]> = [
      [302, 'redirect_refused'],
      [401, 'invalid_auth'],
      [403, 'forbidden_scope'],
      [404, 'session_lost'],
      [429, 'rate_limit'],
      [500, 'upstream_error'],
    ];
    for (const [status, category] of cases) {
      const guarded = guardedDatadogFetch(endpoint, TOKEN, {
        fetchImpl: async () => new Response('secret upstream detail', { status }),
      });
      const err = await guarded(endpoint, { method: 'POST' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatadogTransportError);
      expect((err as DatadogTransportError).category).toBe(category);
      expect(String((err as Error).message)).not.toContain('secret');
    }
    expect(classifyDatadogHttp(200)).toBeNull();
  });

  it('caps response bodies', async () => {
    const guarded = guardedDatadogFetch(endpoint, TOKEN, {
      maxBytes: 16,
      fetchImpl: async () => new Response('x'.repeat(64), { status: 200 }),
    });
    const response = await guarded(endpoint, { method: 'POST' });
    await expect(response.text()).rejects.toThrow(/output_limit/);
  });
});

describe('Datadog catalog partition', () => {
  it('excludes unannotated and write-annotated mutating tools, keeps read-only-annotated ones', () => {
    const catalog = partitionDatadogCatalog([
      ...DEFAULT_TOOLS,
      { name: 'execute_code', inputSchema: { type: 'object' } },
      { name: 'Bad Name', inputSchema: { type: 'object' } },
      { name: 'get_thing', inputSchema: { type: 'array' } },
      { name: 'search_datadog_logs', inputSchema: { type: 'object' } },
    ]);
    expect(catalog.tools.map((t) => t.name)).toEqual([
      'search_datadog_logs',
      'search_datadog_monitors',
      'start_datadog_query_preview',
    ]);
    expect(catalog.excludedTools).toEqual([
      'Bad?Name',
      'create_datadog_monitor',
      'delete_datadog_dashboard',
      'execute_code',
      'get_thing',
      'search_datadog_logs',
    ]);
  });

  it('hashes the catalog stably and changes with a schema change', () => {
    const a = partitionDatadogCatalog(DEFAULT_TOOLS);
    const b = partitionDatadogCatalog([...DEFAULT_TOOLS].reverse());
    expect(datadogCatalogHash(a)).toBe(datadogCatalogHash(b));
    const changed = partitionDatadogCatalog(
      DEFAULT_TOOLS.map((t) =>
        t.name === 'search_datadog_logs'
          ? { ...t, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
          : t,
      ),
    );
    expect(datadogCatalogHash(changed)).not.toBe(datadogCatalogHash(a));
    expect(datadogCatalogHash(a)).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('Datadog MCP session', () => {
  it('initializes once, lists every page and sends the token on every request', async () => {
    const fake = fakeDatadog();
    const s = session(fake);
    const tools = await s.listTools(5_000);
    expect(tools).toHaveLength(DEFAULT_TOOLS.length);
    expect(s.info).toMatchObject({ serverName: 'datadog-mcp', serverVersion: '1.2.3' });
    expect(s.info.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fake.seen.length).toBeGreaterThan(3);
    for (const request of fake.seen) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url).toBe('https://mcp.datadoghq.eu/v1/mcp?toolsets=all');
    }
    await s.listTools(5_000);
    expect(fake.sessions()).toBe(1);
  });

  it('calls a tool and bounds the output with a truncation marker', async () => {
    const fake = fakeDatadog({
      call: () => ({ content: [{ type: 'text', text: 'L'.repeat(5_000) }] }),
    });
    const result = await session(fake).callTool(
      'search_datadog_logs',
      { query: 'env:prod' },
      { timeoutMs: 5_000, maxOutputBytes: 1_000 },
    );
    expect(result.status).toBe('completed');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1_000);
    expect(result.output).toContain('[truncated: Datadog result exceeded the output limit]');
  });

  it('re-initializes once after session loss', async () => {
    const fake = fakeDatadog();
    const s = session(fake);
    await s.listTools(5_000);
    fake.expireSession();
    const result = await s.callTool('search_datadog_logs', { query: 'x' }, bounds);
    expect(result.status).toBe('completed');
    expect(fake.sessions()).toBe(2);
  });

  it('classifies 401, 403 and 429 without upstream text and re-inits after auth failures', async () => {
    for (const [status, category] of [
      [401, 'invalid_auth'],
      [403, 'forbidden_scope'],
      [429, 'rate_limit'],
    ] as const) {
      const fake = fakeDatadog({ call: () => status });
      const s = session(fake);
      const result = await s.callTool('search_datadog_logs', { query: 'x' }, bounds);
      expect(result).toMatchObject({ status: 'failed', errorCategory: category });
      expect(result.output).not.toContain('secret');
      await s.callTool('search_datadog_logs', { query: 'x' }, bounds);
      // 429 keeps the session (no retry); auth failures re-initialize it.
      expect(fake.sessions()).toBe(category === 'rate_limit' ? 1 : 2);
    }
  });

  it('fails initialize with invalid_auth on a rejected token', async () => {
    const fake = fakeDatadog({ status: 401 });
    const err = await session(fake)
      .listTools(5_000)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const { classifyDatadogError } = await import(
      '../../src/integrations/datadog/datadog-mcp-adapter.js'
    );
    expect(classifyDatadogError(err)).toBe('invalid_auth');
  });

  it('times out a slow call', async () => {
    const fake = fakeDatadog({
      call: (_name, _args, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    const s = session(fake);
    await s.listTools(5_000);
    const result = await s.callTool(
      'search_datadog_logs',
      { query: 'x' },
      { timeoutMs: 100, maxOutputBytes: 1_000 },
    );
    expect(result).toMatchObject({ status: 'timed_out', errorCategory: 'timeout' });
  });

  it('maps an isError write refusal to forbidden_scope and keeps plain tool errors', async () => {
    const fake = fakeDatadog({
      call: (name) =>
        name === 'create_datadog_notebook'
          ? {
              isError: true,
              content: [{ type: 'text', text: 'Forbidden: missing scope mcp_write' }],
            }
          : { isError: true, content: [{ type: 'text', text: 'invalid query syntax near "("' }] },
    });
    const s = session(fake);
    expect(await s.callTool('create_datadog_notebook', {}, bounds)).toMatchObject({
      status: 'failed',
      errorCategory: 'forbidden_scope',
    });
    const tool = await s.callTool('search_datadog_logs', { query: '(' }, bounds);
    expect(tool).toMatchObject({ status: 'failed', errorCategory: 'tool_error' });
    expect(tool.output).toContain('invalid query syntax');
  });

  it('names the missing Datadog permission of a JSON-RPC refusal and keeps the session', async () => {
    const fake = fakeDatadog();
    const refusing: typeof fake.fetchImpl = async (input, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (body?.method === 'tools/call')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: 0,
            message:
              'tool not available: user lacks required permissions: this Tool requires all of [logs_read_data, logs_read_index_data]',
          },
        });
      return fake.fetchImpl(input, init);
    };
    const s = new DatadogMcpSession({
      site: 'datadoghq.eu',
      toolsets: 'all',
      token: TOKEN,
      fetchImpl: refusing,
    });
    const result = await s.callTool('search_datadog_logs', { query: 'x' }, bounds);
    expect(result).toMatchObject({ status: 'failed', errorCategory: 'forbidden_scope' });
    expect(result.output).toContain(
      'Missing Datadog permission(s) on the token: logs_read_data, logs_read_index_data',
    );
    await s.callTool('search_datadog_logs', { query: 'x' }, bounds);
    expect(fake.sessions()).toBe(1);
  });

  it('never suggests adding a write scope when Datadog refuses a write', () => {
    const hint = datadogPermissionHint(
      'this Tool requires AND of: [dashboards_read dashboards_write]',
    );
    expect(hint).toContain('read-only by design');
    expect(hint).not.toContain('dashboards_write');
    expect(datadogPermissionHint('this Tool requires at least one of [monitors_read]')).toContain(
      'Missing Datadog permission(s) on the token: monitors_read',
    );
  });

  it('classifies an isError permission or policy refusal as forbidden_scope', async () => {
    const fake = fakeDatadog({
      call: (name) => ({
        isError: true,
        content: [
          {
            type: 'text',
            text:
              name === 'delete_datadog_dashboard'
                ? 'requires AND of: [dashboards_read dashboards_write]'
                : 'MCP request blocked',
          },
        ],
      }),
    });
    const s = session(fake);
    const write = await s.callTool('delete_datadog_dashboard', {}, bounds);
    expect(write).toMatchObject({ errorCategory: 'forbidden_scope' });
    expect(write.output).toContain('read-only by design');
    const blocked = await s.callTool('search_datadog_services', {}, bounds);
    expect(blocked).toMatchObject({ errorCategory: 'forbidden_scope' });
    expect(blocked.output).toContain('blocked this MCP tool');
  });

  it('bounds tiny limits sensibly', () => {
    expect(boundDatadogOutput('short', 1_000)).toEqual({ output: 'short', truncated: false });
  });
});
