import { afterEach, describe, expect, it } from 'vitest';
import {
  DATADOG_READINESS_REFRESH_MS,
  DatadogMcpProvider,
  datadogCredentialFingerprint,
  type DatadogInstanceConfig,
} from '../../src/integrations/datadog/datadog-mcp-provider.js';
import {
  CliInstanceRegistry,
  datadogCatalogReport,
  handleDatadog,
  redactRuntimeOutput,
  setInstanceRegistry,
} from '../../../tool-runtime/src/main.js';
import type { SyncedToolInstance } from '../../src/integrations/tools/tool-instances.js';
import { fakeDatadog } from './helpers/datadog-mcp.js';

const TOKEN = 'ddpat_provider-token-0123456789';
const config = (overrides: Partial<DatadogInstanceConfig> = {}): DatadogInstanceConfig => ({
  site: 'datadoghq.eu',
  toolsets: 'all',
  token: TOKEN,
  ...overrides,
});

const INSTANCE_ID = 'ti_dddddddddddddddd';
const TEAM = 'T0TEAM1';
const INSTANCE: SyncedToolInstance<'datadog'> = {
  id: INSTANCE_ID,
  teamId: TEAM,
  kind: 'datadog',
  label: 'Datadog (test)',
  host: 'datadoghq.eu',
  settings: { toolsets: 'all', denyTools: [] },
  credentialVersion: 2,
  hasCredential: true,
};

afterEach(() => {
  setInstanceRegistry(null);
});

describe('Datadog provider configuration', () => {
  it('is always enabled for an instance and names incomplete fields without values', () => {
    const cases: Array<[Partial<DatadogInstanceConfig>, RegExp]> = [
      [{ token: '' }, /access token \(PAT or SAT with scope mcp_read\)/],
      [{ token: 'ddpat bad token' }, /access token \(malformed\)/],
      [{ token: 'ddpat_' }, /access token \(malformed\)/],
      [{ site: 'https://datadoghq.eu' }, /site \(bare site/],
      [{ site: 'ddog-gov.com' }, /gov sites are not supported/],
      [{ toolsets: 'core;x' }, /toolsets \("all" or a comma list/],
    ];
    for (const [overrides, detail] of cases) {
      const provider = new DatadogMcpProvider(config(overrides));
      expect(provider.state).toMatchObject({
        enabled: true,
        ready: false,
        status: 'missing_config',
      });
      expect(provider.state.detail).toMatch(/^the Datadog instance is incomplete: /);
      expect(provider.state.detail).toMatch(detail);
      expect(provider.state.detail).not.toContain('ddpat');
      expect(provider.state.credentialFingerprint).toBeNull();
      expect(provider.configured).toBe(false);
      expect(provider.isStale()).toBe(false);
    }
  });

  it('accepts a service access token (no ddpat_ prefix assumption) and defaults toolsets to all', () => {
    const provider = new DatadogMcpProvider(
      config({ token: 'ddsat_service-token-123', toolsets: '' }),
    );
    expect(provider.configured).toBe(true);
    expect(provider.state).toMatchObject({
      enabled: true,
      ready: false,
      status: 'error',
      detail: 'readiness has not been established yet',
      toolsets: 'all',
      endpoint: 'https://mcp.datadoghq.eu/v1/mcp',
    });
    expect(provider.secrets()).toEqual(['ddsat_service-token-123']);
  });

  it('fingerprints the token stably and rotates the fingerprint with the token', () => {
    const a = new DatadogMcpProvider(config()).state.credentialFingerprint;
    const b = new DatadogMcpProvider(config()).state.credentialFingerprint;
    const rotated = new DatadogMcpProvider(config({ token: `${TOKEN}x` })).state
      .credentialFingerprint;
    expect(a).toBe(b);
    expect(a).toBe(datadogCredentialFingerprint(TOKEN));
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(rotated).not.toBe(a);
  });
});

describe('Datadog provider readiness', () => {
  it('pins the read catalog, reports excluded writes and never exposes the token', async () => {
    const fake = fakeDatadog();
    const provider = new DatadogMcpProvider(config(), fake.fetchImpl, () => 1_000_000);
    const state = await provider.refresh();
    expect(state).toMatchObject({
      ready: true,
      status: 'ready',
      site: 'datadoghq.eu',
      serverName: 'datadog-mcp',
      serverVersion: '1.2.3',
      adapter: 'datadog-mcp-v1',
      contractVersion: 'datadog-read-v1',
      tools: ['search_datadog_logs', 'search_datadog_monitors', 'start_datadog_query_preview'],
      excludedTools: ['create_datadog_monitor', 'delete_datadog_dashboard'],
    });
    expect(state.toolCatalogHash).toMatch(/^[a-f0-9]{32}$/);
    expect(state.checkedAt).toBe(new Date(1_000_000).toISOString());
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    const catalog = provider.snapshotCatalog();
    expect(catalog.toolCatalogHash).toBe(state.toolCatalogHash);
    expect(catalog.tools.find((t) => t.name === 'search_datadog_logs')?.inputSchema).toMatchObject({
      required: ['query'],
    });
  });

  it('turns not-ready with invalid_auth on 401 and with empty_catalog when nothing is readable', async () => {
    const denied = new DatadogMcpProvider(config(), fakeDatadog({ status: 401 }).fetchImpl);
    expect(await denied.refresh()).toMatchObject({
      ready: false,
      status: 'invalid_auth',
      tools: [],
      toolCatalogHash: null,
    });
    const writesOnly = new DatadogMcpProvider(
      config(),
      fakeDatadog({
        tools: [{ name: 'create_datadog_monitor', inputSchema: { type: 'object' } }],
      }).fetchImpl,
    );
    expect(await writesOnly.refresh()).toMatchObject({ ready: false, status: 'empty_catalog' });
  });

  it('is stale for a re-probe at most every 60 s, and at once after a rejected credential', async () => {
    let now = 1_000_000;
    const fake = fakeDatadog({ call: () => 401 });
    const provider = new DatadogMcpProvider(config(), fake.fetchImpl, () => now);
    expect(provider.isStale()).toBe(true);
    await provider.refresh();
    expect(provider.isStale()).toBe(false);
    now += 30_000;
    expect(provider.isStale()).toBe(false);
    now += DATADOG_READINESS_REFRESH_MS - 30_000;
    expect(provider.isStale()).toBe(true);
    await provider.refresh();
    expect(provider.isStale()).toBe(false);
    const result = await provider.call(
      'search_datadog_logs',
      { query: 'x' },
      { timeoutMs: 5_000, maxOutputBytes: 10_000 },
    );
    expect(result.errorCategory).toBe('invalid_auth');
    expect(provider.isStale()).toBe(true);
  });
});

describe('cli-runtime /datadog', () => {
  async function ready() {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const fake = fakeDatadog({
      call: (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: `rows for ${String(args.query)} ${TOKEN}` }] };
      },
    });
    const provider = new DatadogMcpProvider(config(), fake.fetchImpl);
    const registry = new CliInstanceRegistry({
      admitted: {
        gitlab: new Set(),
        atlassian: new Set(),
        datadog: new Set(['datadoghq.eu']),
        cloudflare: new Set(),
      },
    });
    registry.install({ instance: INSTANCE, unusable: null, datadog: provider });
    setInstanceRegistry(registry);
    await provider.refresh();
    const state = provider.state;
    const binding = {
      site: state.site,
      endpoint: state.endpoint,
      adapter: state.adapter,
      contractVersion: state.contractVersion,
      toolCatalogHash: state.toolCatalogHash,
      credentialFingerprint: state.credentialFingerprint,
    };
    const request = (body: Record<string, unknown>) =>
      handleDatadog({ instanceId: INSTANCE_ID, teamId: TEAM, ...body });
    return { calls, binding, fake, registry, request };
  }

  it('serves the catalog and runs a bound read with the token redacted from the output', async () => {
    const { calls, binding, request, registry } = await ready();
    expect(datadogCatalogReport({ instanceId: INSTANCE_ID, teamId: TEAM }).tools).toHaveLength(3);
    const result = await request({
      tool: 'search_datadog_logs',
      arguments: { query: 'env:prod status:error', limit: 100 },
      binding,
    });
    expect(result.status).toBe('completed');
    expect(result.output).toContain('rows for env:prod status:error [redacted]');
    expect(result.output).not.toContain(TOKEN);
    expect(calls).toEqual([
      { name: 'search_datadog_logs', args: { query: 'env:prod status:error', limit: 100 } },
    ]);
    // The instance's readiness on /readyz never carries the token.
    const [status] = registry.statuses();
    expect(status).toMatchObject({
      instanceId: INSTANCE_ID,
      teamId: TEAM,
      kind: 'datadog',
      state: 'ready',
      credentialVersion: 2,
    });
    expect(JSON.stringify(registry.statuses())).not.toContain(TOKEN);
    expect(registry.secrets()).toEqual([TOKEN]);
  });

  it('refuses unknown, foreign and unusable instances before any upstream call', async () => {
    const { calls, binding, fake, registry } = await ready();
    const seen = fake.seen.length;
    const body = { tool: 'search_datadog_logs', arguments: { query: 'x' }, binding };
    const unknown = await handleDatadog({
      instanceId: 'ti_eeeeeeeeeeeeeeee',
      teamId: TEAM,
      ...body,
    });
    expect(unknown.refused).toBe('unknown datadog tool instance');
    const missing = await handleDatadog(body);
    expect(missing.refused).toBe('unknown datadog tool instance');
    const foreign = await handleDatadog({ instanceId: INSTANCE_ID, teamId: 'T0OTHER', ...body });
    expect(foreign.refused).toBe(`tool instance ${INSTANCE_ID} belongs to another workspace`);
    expect(datadogCatalogReport({ instanceId: INSTANCE_ID, teamId: 'T0OTHER' })).toEqual({
      tools: [],
      excludedTools: [],
      toolCatalogHash: null,
      refused: `tool instance ${INSTANCE_ID} belongs to another workspace`,
    });
    expect(datadogCatalogReport({ instanceId: 'ti_eeeeeeeeeeeeeeee', teamId: TEAM }).refused).toBe(
      'unknown datadog tool instance',
    );
    registry.install({
      instance: { ...INSTANCE, id: 'ti_ffffffffffffffff', host: 'datadoghq.com' },
      unusable: { state: 'blocked', detail: 'host not admitted: datadoghq.com' },
    });
    const blocked = await handleDatadog({
      instanceId: 'ti_ffffffffffffffff',
      teamId: TEAM,
      ...body,
    });
    expect(blocked.refused).toMatch(/is blocked: host not admitted/);
    for (const refusal of [unknown, missing, foreign, blocked])
      expect(refusal.status).toBe('not_run');
    expect(calls).toHaveLength(0);
    expect(fake.seen.length).toBe(seen);
  });

  it('refuses excluded tools, schema violations, binding mismatches and unknown fields', async () => {
    const { calls, binding, request } = await ready();
    const refusals = await Promise.all([
      request({ tool: 'create_datadog_monitor', arguments: {}, binding }),
      request({ tool: 'search_datadog_logs', arguments: { limit: 5 }, binding }),
      request({ tool: 'search_datadog_logs', arguments: { query: 'x', extra: 1 }, binding }),
      request({
        tool: 'search_datadog_logs',
        arguments: { query: 'x' },
        binding: { ...binding, toolCatalogHash: '0'.repeat(32) },
      }),
      request({
        tool: 'search_datadog_logs',
        arguments: { query: 'x' },
        binding: { ...binding, site: 'datadoghq.com' },
      }),
      request({
        tool: 'search_datadog_logs',
        arguments: { query: 'x' },
        binding: { ...binding, credentialFingerprint: '0'.repeat(16) },
      }),
      request({ tool: 'search_datadog_logs', arguments: { query: 'x' } }),
      request({ tool: 'search_datadog_logs', arguments: {}, binding, url: 'https://x' }),
      request({ tool: 'search_datadog_logs', arguments: {}, binding, site: 'datadoghq.com' }),
      request({ tool: 'search_datadog_logs', arguments: { query: 'x' }, binding, timeoutMs: 0 }),
    ]);
    for (const refusal of refusals) expect(refusal.status).toBe('not_run');
    expect(refusals[1]?.refused).toMatch(/required property 'query'/);
    expect(refusals[7]?.refused).toBe('unknown transport field');
    expect(calls).toHaveLength(0);
  });

  it('redacts Datadog token shapes generically', () => {
    expect(redactRuntimeOutput('a ddpat_abcdefgh12345 b ddsat_zyxwvuts98765')).toBe(
      'a [redacted] b [redacted]',
    );
  });
});
