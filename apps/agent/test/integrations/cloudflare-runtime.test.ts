/**
 * Isolated tool runtime: admin-managed Cloudflare instances (admission via
 * CLOUDFLARE_HOSTS, readiness, the /cloudflare route's binding and request
 * checks, redaction).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliInstanceRegistry,
  admittedHostsFromEnv,
  handleCloudflare,
  redactRuntimeOutput,
  setInstanceRegistry,
} from '../../../tool-runtime/src/main.js';
import {
  CLOUDFLARE_ENDPOINT,
  cloudflareCredentialFingerprint,
  cloudflareZoneSetHash,
} from '../../src/integrations/cloudflare/cloudflare-api-adapter.js';
import type {
  SyncedToolInstance,
  ToolInstanceStatusReport,
} from '../../src/integrations/tools/tool-instances.js';
import { ACCOUNT_ID, ZONE_A, ZONE_B, fakeCloudflare } from './helpers/cloudflare-api.js';

const TEAM = 'T0TEAM1';
const CLOUDFLARE_ID = 'ti_0000000000000005';
const TOKEN = 'cf-held-token-1234567890';

function cloudflareInstance(
  overrides: Partial<SyncedToolInstance<'cloudflare'>> = {},
): SyncedToolInstance<'cloudflare'> {
  return {
    id: CLOUDFLARE_ID,
    teamId: TEAM,
    kind: 'cloudflare',
    label: 'Cloudflare (test)',
    host: 'api.cloudflare.com',
    settings: { accountId: null, zones: null },
    credentialVersion: 1,
    hasCredential: true,
    ...overrides,
  };
}

function harness(api = fakeCloudflare(), admitted = ['api.cloudflare.com']) {
  const reports: ToolInstanceStatusReport[] = [];
  const secretCalls: string[] = [];
  const registry = new CliInstanceRegistry({
    admitted: {
      gitlab: new Set(),
      atlassian: new Set(),
      datadog: new Set(),
      cloudflare: new Set(admitted),
    },
    secret: async (instanceId) => {
      secretCalls.push(instanceId);
      return { credential: TOKEN, credentialVersion: 2 };
    },
    report: async (statuses) => {
      reports.push(...statuses);
    },
    cloudflareFetch: api.fetchImpl,
  });
  setInstanceRegistry(registry);
  return { registry, reports, secretCalls, api };
}

const BINDING = {
  endpoint: CLOUDFLARE_ENDPOINT,
  adapter: 'cloudflare-api-v1',
  contractVersion: 'cloudflare-read-v1',
  accountId: null,
  zoneSetHash: cloudflareZoneSetHash([ZONE_A, ZONE_B]),
  credentialFingerprint: cloudflareCredentialFingerprint(TOKEN),
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: CLOUDFLARE_ID,
    teamId: TEAM,
    operation: 'graphql',
    request: {
      query: `{ viewer { zones(filter: {zoneTag: "${ZONE_A.id}"}) { httpRequestsAdaptiveGroups(limit: 24) { count } } } }`,
    },
    binding: BINDING,
    timeoutMs: 10_000,
    maxOutputBytes: 50_000,
    ...overrides,
  };
}

afterEach(() => {
  setInstanceRegistry(null);
});

describe('cli-runtime Cloudflare admission and readiness', () => {
  it('reads CLOUDFLARE_HOSTS as the static allowlist', () => {
    expect([
      ...admittedHostsFromEnv({ CLOUDFLARE_HOSTS: 'api.cloudflare.com' }).cloudflare,
    ]).toEqual(['api.cloudflare.com']);
    expect(admittedHostsFromEnv({}).cloudflare.size).toBe(0);
  });

  it('blocks an instance while api.cloudflare.com is not admitted: no secret, no probe', async () => {
    const h = harness(fakeCloudflare(), []);
    await h.registry.apply(new Map([[CLOUDFLARE_ID, cloudflareInstance()]]));
    expect(h.secretCalls).toEqual([]);
    expect(h.api.seen).toEqual([]);
    expect(h.reports).toEqual([
      {
        instanceId: CLOUDFLARE_ID,
        state: 'blocked',
        detail:
          'host not admitted: api.cloudflare.com is not in CLOUDFLARE_HOSTS (operator egress allowlist)',
        credentialVersion: 1,
        toolsCount: null,
      },
    ]);
    const refused = await handleCloudflare(request());
    expect(refused).toMatchObject({ status: 'not_run' });
    expect(refused.refused).toMatch(/is blocked: host not admitted/);
  });

  it('probes an admitted instance and reports sanitized readiness with the zone snapshot', async () => {
    const h = harness();
    await h.registry.apply(new Map([[CLOUDFLARE_ID, cloudflareInstance()]]));
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    expect(h.reports[0]).toEqual({
      instanceId: CLOUDFLARE_ID,
      state: 'ready',
      detail: 'read-only API access to 2 zones',
      credentialVersion: 2,
      toolsCount: null,
    });
    const [status] = h.registry.statuses();
    expect(status).toMatchObject({ kind: 'cloudflare', state: 'ready', credentialVersion: 2 });
    expect(status?.cloudflare).toMatchObject({
      endpoint: CLOUDFLARE_ENDPOINT,
      zoneSetHash: BINDING.zoneSetHash,
      credentialFingerprint: BINDING.credentialFingerprint,
      zones: [
        { id: ZONE_A.id, name: ZONE_A.name, status: 'active', plan: 'Enterprise Website' },
        { id: ZONE_B.id, name: ZONE_B.name, status: 'active', plan: 'Enterprise Website' },
      ],
    });
    expect(h.api.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(h.registry.statuses())).not.toContain(TOKEN);
    expect(JSON.stringify(h.reports)).not.toContain(TOKEN);
    expect(redactRuntimeOutput(`leak ${TOKEN} end`)).toBe('leak [redacted] end');
  });
});

describe('cli-runtime /cloudflare route', () => {
  async function ready(
    api = fakeCloudflare(),
    settings = { accountId: null, zones: null } as {
      accountId: string | null;
      zones: string[] | null;
    },
  ) {
    const h = harness(api);
    await h.registry.apply(new Map([[CLOUDFLARE_ID, cloudflareInstance({ settings })]]));
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    return h;
  }

  it('runs a validated GraphQL query and a REST GET with the held token', async () => {
    const h = await ready(
      fakeCloudflare({
        graphql: () => ({
          data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ count: 3 }] }] } },
          errors: null,
        }),
        get: () => ({ success: true, result: { plan: { name: 'Enterprise' }, echo: TOKEN } }),
      }),
    );
    const graphql = await handleCloudflare(request());
    expect(graphql).toMatchObject({ status: 'completed' });
    expect(graphql.output).toContain('"count":3');
    const post = h.api.seen.at(-1)!;
    expect(post).toMatchObject({ method: 'POST', authorization: `Bearer ${TOKEN}` });
    expect(post.url.toString()).toBe(`${CLOUDFLARE_ENDPOINT}/graphql`);
    const get = await handleCloudflare(
      request({ operation: 'get', request: { path: `/zones/${ZONE_A.id}` } }),
    );
    expect(get.status).toBe('completed');
    // Output is redacted before it leaves the runtime.
    expect(get.output).toContain('[redacted]');
    expect(get.output).not.toContain(TOKEN);
  });

  it('refuses a foreign workspace, a binding mismatch, unknown fields and bad bounds', async () => {
    await ready();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ teamId: 'T0OTHER' }, /belongs to another workspace/],
      [{ instanceId: 'ti_000000000000000f' }, /unknown cloudflare tool instance/],
      [{ operation: 'post' }, /unknown Cloudflare operation/],
      [{ binding: { ...BINDING, zoneSetHash: 'f'.repeat(32) } }, /binding mismatch/],
      [{ binding: { ...BINDING, credentialFingerprint: '0'.repeat(16) } }, /binding mismatch/],
      [{ binding: { ...BINDING, accountId: ACCOUNT_ID } }, /binding mismatch/],
      [{ binding: { ...BINDING, endpoint: 'https://evil.example/client/v4' } }, /binding mismatch/],
      [{ binding: { ...BINDING, extra: 1 } }, /binding mismatch/],
      [{ binding: null }, /binding mismatch/],
      [{ method: 'DELETE' }, /unknown transport field/],
      [{ timeoutMs: 0 }, /invalid execution bounds/],
      [{ maxOutputBytes: 300_000 }, /invalid execution bounds/],
    ];
    for (const [overrides, message] of cases) {
      const result = await handleCloudflare(request(overrides));
      expect(result.status, JSON.stringify(overrides)).toBe('not_run');
      expect(result.refused).toMatch(message);
    }
  });

  it('re-validates the request: no mutation, no foreign zone, no path outside the allowlist', async () => {
    const h = await ready(fakeCloudflare(), { accountId: null, zones: ['cloud.example.com'] });
    const binding = { ...BINDING, zoneSetHash: cloudflareZoneSetHash([ZONE_A]) };
    const before = h.api.seen.length;
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ request: { query: 'mutation { purgeCache }' } }, /mutation refused/],
      [
        {
          request: {
            query: `{ viewer { zones(filter: {zoneTag: "${ZONE_B.id}"}) { x { count } } } }`,
          },
        },
        /not one of the zones/,
      ],
      [{ operation: 'get', request: { path: `/zones/${ZONE_B.id}` } }, /not one of the zones/],
      [{ operation: 'get', request: { path: '/zones' } }, /selected zones only/],
      [{ operation: 'get', request: { path: '/user' } }, /path must be/],
      [{ operation: 'get', request: { path: `/zones/${ZONE_A.id}/logpush/jobs` } }, /Logpush/],
    ];
    for (const [overrides, message] of refused) {
      const result = await handleCloudflare(request({ binding, ...overrides }));
      expect(result.status, JSON.stringify(overrides)).toBe('not_run');
      expect(result.refused).toMatch(message);
    }
    expect(h.api.seen.length).toBe(before);
  });
});
