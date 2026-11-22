import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_READINESS_REFRESH_MS,
  CloudflareApiProvider,
} from '../../src/integrations/cloudflare/cloudflare-api-provider.js';
import {
  CLOUDFLARE_ENDPOINT,
  cloudflareCredentialFingerprint,
  cloudflareZoneSetHash,
} from '../../src/integrations/cloudflare/cloudflare-api-adapter.js';
import { ACCOUNT_ID, ZONE_A, ZONE_B, fakeCloudflare } from './helpers/cloudflare-api.js';

const TOKEN = 'cf-read-token-1234567890';

function provider(
  config: Partial<{ accountId: string | null; zones: string[] | null; token: string }> = {},
  api = fakeCloudflare(),
  now: () => number = Date.now,
) {
  return {
    api,
    provider: new CloudflareApiProvider(
      { accountId: null, zones: null, token: TOKEN, ...config },
      api.fetchImpl,
      now,
    ),
  };
}

describe('Cloudflare provider configuration', () => {
  it('reports missing or malformed settings without probing', async () => {
    const cases: Array<[Parameters<typeof provider>[0], RegExp]> = [
      [{ token: '' }, /API token \(Read permissions only\)/],
      [{ token: 'has space here' }, /API token \(malformed\)/],
      [{ accountId: 'not-hex' }, /account ID \(32 hex characters\)/],
    ];
    for (const [config, detail] of cases) {
      const { provider: p, api } = provider(config);
      expect(p.configured).toBe(false);
      expect(p.state).toMatchObject({ status: 'missing_config', ready: false });
      expect(p.state.detail).toMatch(detail);
      await p.refresh();
      expect(api.seen).toEqual([]);
    }
  });

  it('holds the token in memory only and exposes a stable fingerprint', () => {
    const { provider: p } = provider();
    expect(p.secrets()).toEqual([TOKEN]);
    expect(p.state.credentialFingerprint).toBe(cloudflareCredentialFingerprint(TOKEN));
    expect(JSON.stringify(p.state)).not.toContain(TOKEN);
    const rotated = provider({ token: `${TOKEN}-rotated` }).provider;
    expect(rotated.state.credentialFingerprint).not.toBe(p.state.credentialFingerprint);
  });
});

describe('Cloudflare readiness', () => {
  it('lists every visible zone and binds the zone set hash', async () => {
    const { provider: p, api } = provider();
    const state = await p.refresh();
    expect(state).toMatchObject({
      tool: 'cloudflare',
      ready: true,
      status: 'ready',
      endpoint: CLOUDFLARE_ENDPOINT,
      adapter: 'cloudflare-api-v1',
      contractVersion: 'cloudflare-read-v1',
      accountId: null,
      restrictedZones: false,
      zoneSetHash: cloudflareZoneSetHash([ZONE_A, ZONE_B]),
    });
    expect(state.zones).toEqual([
      { ...ZONE_A, status: 'active', plan: 'Enterprise Website' },
      { ...ZONE_B, status: 'active', plan: 'Enterprise Website' },
    ]);
    expect(state.detail).toBe('read-only API access to 2 zones');
    expect(
      api.seen.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`),
    ).toEqual(['GET /client/v4/zones?page=1&per_page=50']);
    expect(api.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(p.scope()).toEqual({
      accountId: null,
      zoneIds: [ZONE_A.id, ZONE_B.id],
      restrictedZones: false,
    });
  });

  it('checks the account, limits zones to it and paginates up to 200 zones', async () => {
    const many = Array.from({ length: 230 }, (_, index) => ({
      id: index.toString(16).padStart(32, '0'),
      name: `z${String(index).padStart(3, '0')}.example.com`,
    }));
    const { provider: p, api } = provider(
      { accountId: ACCOUNT_ID },
      fakeCloudflare({ zones: many }),
    );
    const state = await p.refresh();
    expect(state.ready).toBe(true);
    expect(state.zones).toHaveLength(200);
    expect(state.detail).toBe(
      'read-only API access to 200 zones (the first 200 the token can see) and the configured account',
    );
    expect(api.seen[0]!.url.pathname).toBe(`/client/v4/accounts/${ACCOUNT_ID}`);
    expect(api.seen.slice(1).map((request) => request.url.searchParams.get('page'))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(api.seen[1]!.url.searchParams.get('account.id')).toBe(ACCOUNT_ID);
  });

  it('resolves configured zone names and reports names the token cannot see', async () => {
    const { provider: p } = provider({ zones: ['shop.example.com'] });
    const state = await p.refresh();
    expect(state.ready).toBe(true);
    expect(state.restrictedZones).toBe(true);
    expect(state.zones.map((zone) => zone.name)).toEqual(['shop.example.com']);
    expect(state.zoneSetHash).toBe(cloudflareZoneSetHash([ZONE_B]));
    expect(p.scope()).toEqual({ accountId: null, zoneIds: [ZONE_B.id], restrictedZones: true });

    const missing = provider({ zones: ['shop.example.com', 'gone.example.com'] }).provider;
    const failed = await missing.refresh();
    expect(failed).toMatchObject({
      ready: false,
      status: 'zone_not_visible',
      zones: [],
      zoneSetHash: null,
    });
    expect(failed.detail).toBe(
      'zone not visible to the token: gone.example.com (see docs/cloudflare.md troubleshooting)',
    );
  });

  it('classifies an invalid token, a missing account and an empty zone list', async () => {
    const invalid = provider(
      {},
      fakeCloudflare({ status: 403, errorCode: 9109, errorMessage: 'Invalid access token' }),
    ).provider;
    expect(await invalid.refresh()).toMatchObject({ ready: false, status: 'invalid_auth' });
    const account = provider(
      { accountId: ACCOUNT_ID },
      fakeCloudflare({ accountStatus: 403 }),
    ).provider;
    expect(await account.refresh()).toMatchObject({ ready: false, status: 'account_not_visible' });
    const empty = provider({}, fakeCloudflare({ zones: [] })).provider;
    expect(await empty.refresh()).toMatchObject({ ready: false, status: 'no_zones' });
    const broken = provider(
      {},
      fakeCloudflare({ zones: [{ id: 'not-an-id', name: 'x.example.com' }] }),
    ).provider;
    expect(await broken.refresh()).toMatchObject({ ready: false, status: 'invalid_shape' });
  });

  it('turns stale after the refresh interval and at once after a rejected token', async () => {
    let now = 1_000_000;
    let status: number | undefined = undefined;
    const api = fakeCloudflare();
    const fetchImpl: typeof api.fetchImpl = async (input, init) =>
      status === undefined
        ? api.fetchImpl(input, init)
        : Response.json(
            { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
            { status },
          );
    const p = new CloudflareApiProvider(
      { accountId: null, zones: null, token: TOKEN },
      fetchImpl,
      () => now,
    );
    await p.refresh();
    expect(p.isStale()).toBe(false);
    now += CLOUDFLARE_READINESS_REFRESH_MS;
    expect(p.isStale()).toBe(true);
    await p.refresh();
    status = 403;
    const result = await p.call(
      'get',
      { path: `/zones/${ZONE_A.id}` },
      {
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
      },
    );
    expect(result).toMatchObject({ status: 'failed', errorCategory: 'invalid_auth' });
    expect(p.isStale()).toBe(true);
  });
});

describe('Cloudflare provider calls', () => {
  it('re-validates against the snapshot and returns bounded results', async () => {
    const { provider: p, api } = provider({ zones: ['cloud.example.com'] });
    expect(
      await p.call('get', { path: '/zones' }, { timeoutMs: 1_000, maxOutputBytes: 10_000 }),
    ).toMatchObject({ status: 'not_run', refused: expect.stringMatching(/not ready/) });
    await p.refresh();
    const before = api.seen.length;
    const refused = await p.call(
      'get',
      { path: `/zones/${ZONE_B.id}` },
      { timeoutMs: 1_000, maxOutputBytes: 10_000 },
    );
    expect(refused).toMatchObject({
      status: 'not_run',
      refused: 'zone ID is not one of the zones this channel exposes',
    });
    expect(
      await p.call(
        'graphql',
        { query: 'mutation { x }' },
        { timeoutMs: 1_000, maxOutputBytes: 10_000 },
      ),
    ).toMatchObject({ status: 'not_run', refused: expect.stringMatching(/mutation refused/) });
    expect(api.seen.length).toBe(before);
    const ok = await p.call(
      'graphql',
      {
        query: `{ viewer { zones(filter: {zoneTag: "${ZONE_A.id}"}) { httpRequestsAdaptiveGroups(limit: 2) { count } } } }`,
      },
      { timeoutMs: 1_000, maxOutputBytes: 10_000 },
    );
    expect(ok).toMatchObject({ status: 'completed' });
    expect(ok.output).toContain('httpRequestsAdaptiveGroups');
    const get = await p.call(
      'get',
      { path: `/zones/${ZONE_A.id}`, query: { per_page: 1000 } },
      { timeoutMs: 1_000, maxOutputBytes: 10_000 },
    );
    expect(get.status).toBe('completed');
    expect(api.seen.at(-1)!.url.searchParams.get('per_page')).toBe('100');
  });
});
