/**
 * Transient readiness failures: a transient probe failure is
 * retried, and an instance that was ready keeps its last good readiness and
 * binding through a bounded run of transient failures. Definitive failures
 * (rejected credentials) flip it at once, and a success clears the count.
 * Covers the shared helper and the Atlassian, Datadog, Cloudflare and Slack
 * providers through their injected fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  ReadinessGrace,
  isTransientReadinessCategory,
  probeWithRetry,
  type ReadinessRetryOptions,
} from '../../src/integrations/tools/readiness-grace.js';
import { AtlassianRestProvider } from '../../src/integrations/atlassian/atlassian-rest-provider.js';
import { CloudflareApiProvider } from '../../src/integrations/cloudflare/cloudflare-api-provider.js';
import { DatadogMcpProvider } from '../../src/integrations/datadog/datadog-mcp-provider.js';
import { SlackApiProvider } from '../../src/integrations/slack/slack-api-provider.js';
import { fakeCloudflare } from './helpers/cloudflare-api.js';
import { fakeDatadog } from './helpers/datadog-mcp.js';
import { BOT_TOKEN, SLACK_TEAM, fakeSlack } from './helpers/slack-api.js';

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
type Mode = 'ok' | 'down' | 'unavailable' | 'rejected';

/** Wraps a fake service: `down` throws (DNS/connect), `unavailable` answers 503, `rejected` 401. */
function switchable(
  inner: Fetch,
  rejected: () => Response = () => new Response('{}', { status: 401 }),
) {
  const state = { mode: 'ok' as Mode, calls: 0 };
  const fetchImpl: Fetch = async (input, init) => {
    state.calls += 1;
    if (state.mode === 'down') throw new TypeError('fetch failed');
    if (state.mode === 'unavailable') return new Response('{}', { status: 503 });
    if (state.mode === 'rejected') return rejected();
    return inner(input, init);
  };
  return { state, fetchImpl };
}

const RETRY: ReadinessRetryOptions = { retryDelayMs: 0 };

describe('readiness grace helper', () => {
  it('classifies network, timeout, server errors and rate limits as transient', () => {
    for (const category of ['network', 'timeout', 'upstream_error', 'rate_limit'])
      expect(isTransientReadinessCategory(category)).toBe(true);
    for (const category of [null, 'invalid_auth', 'forbidden_scope', 'zone_not_visible', 'error'])
      expect(isTransientReadinessCategory(category)).toBe(false);
  });

  it('retries transient outcomes up to the attempt limit and stops on a definitive one', async () => {
    const outcomes = ['network', 'timeout', null];
    let calls = 0;
    expect(
      await probeWithRetry(
        async () => outcomes[calls++] ?? null,
        (o) => o,
        RETRY,
      ),
    ).toBe(null);
    expect(calls).toBe(3);
    calls = 0;
    expect(
      await probeWithRetry(
        async () => (calls++ === 0 ? 'network' : 'invalid_auth'),
        (o) => o,
        RETRY,
      ),
    ).toBe('invalid_auth');
    expect(calls).toBe(2);
    calls = 0;
    expect(
      await probeWithRetry(
        async () => (calls++, 'network'),
        (o) => o,
        RETRY,
      ),
    ).toBe('network');
    expect(calls).toBe(3);
  });

  it('holds transient failures of a ready subject within the count and time bounds', () => {
    let now = 0;
    const grace = new ReadinessGrace(() => now, { graceFailures: 3, graceMs: 600_000 });
    expect(grace.hold('network', true)).toBe(true);
    expect(grace.held).toBe('network (1 of 2 tolerated)');
    expect(grace.hold('timeout', true)).toBe(true);
    expect(grace.hold('network', true)).toBe(false);
    // Recovery clears the count.
    expect(grace.hold(null, true)).toBe(false);
    expect(grace.held).toBeNull();
    expect(grace.hold('network', true)).toBe(true);
    // The time bound flips before the count does.
    now = 600_000;
    expect(grace.hold('network', true)).toBe(false);
    // Never held: a subject that was not ready, or a definitive category.
    expect(new ReadinessGrace().hold('network', false)).toBe(false);
    expect(new ReadinessGrace().hold('invalid_auth', true)).toBe(false);
  });
});

describe('Cloudflare provider', () => {
  const make = () => {
    const api = switchable(fakeCloudflare().fetchImpl);
    const provider = new CloudflareApiProvider(
      { accountId: null, zones: null, token: 'cf-read-token-1234567890' },
      api.fetchImpl,
      Date.now,
      RETRY,
    );
    return { api, provider };
  };

  it('keeps the last good zones through one failed probe (DNS failure on every retry)', async () => {
    const { api, provider } = make();
    const good = structuredClone(await provider.refresh());
    expect(good.ready).toBe(true);
    api.state.mode = 'down';
    api.state.calls = 0;
    const held = await provider.refresh();
    expect(api.state.calls).toBe(3);
    expect(held).toMatchObject({ ready: true, status: 'ready', zoneSetHash: good.zoneSetHash });
    expect(held.zones).toEqual(good.zones);
    expect(held.detail).toContain('the last probe failed transiently: network (1 of 2 tolerated)');
    expect(provider.grace.held).toBe('network (1 of 2 tolerated)');
    // Recovery clears the note and the count.
    api.state.mode = 'ok';
    const recovered = await provider.refresh();
    expect(recovered.detail).not.toContain('transiently');
    expect(provider.grace.held).toBeNull();
  });

  it('flips after repeated transient failures and at once on a rejected token', async () => {
    const { api, provider } = make();
    await provider.refresh();
    api.state.mode = 'unavailable';
    expect((await provider.refresh()).ready).toBe(true);
    expect((await provider.refresh()).ready).toBe(true);
    const flipped = await provider.refresh();
    expect(flipped).toMatchObject({ ready: false, status: 'upstream_error', zoneSetHash: null });
    expect(flipped.zones).toEqual([]);

    const fresh = make();
    await fresh.provider.refresh();
    fresh.api.state.mode = 'rejected';
    fresh.api.state.calls = 0;
    const rejected = await fresh.provider.refresh();
    expect(rejected).toMatchObject({ ready: false, status: 'invalid_auth' });
    expect(fresh.api.state.calls).toBe(1);
  });

  it('a transient failure on the first probe is retried, then reported not ready', async () => {
    const { api, provider } = make();
    api.state.mode = 'down';
    const state = await provider.refresh();
    expect(api.state.calls).toBe(3);
    expect(state).toMatchObject({ ready: false, status: 'network' });
  });
});

describe('Slack provider', () => {
  const make = () => {
    const api = switchable(
      fakeSlack({ scopes: 'users:read,users:read.email' }).fetchImpl,
      () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }),
    );
    const provider = new SlackApiProvider(
      { teamId: SLACK_TEAM, token: BOT_TOKEN },
      api.fetchImpl,
      Date.now,
      RETRY,
    );
    return { api, provider };
  };

  it('keeps readiness through a transient failure and flips at once on a revoked token', async () => {
    const { api, provider } = make();
    const good = structuredClone(await provider.refresh());
    expect(good.ready).toBe(true);
    api.state.mode = 'down';
    const held = await provider.refresh();
    expect(held).toMatchObject({ ready: true, botUserId: good.botUserId, scopes: good.scopes });
    expect(held.detail).toContain('the last probe failed transiently: network');
    api.state.mode = 'rejected';
    expect(await provider.refresh()).toMatchObject({ ready: false, status: 'invalid_auth' });
  });
});

describe('Datadog provider', () => {
  const make = () => {
    const api = switchable(fakeDatadog().fetchImpl);
    const provider = new DatadogMcpProvider(
      { site: 'datadoghq.eu', toolsets: 'all', token: 'ddpat_provider-token-0123456789' },
      api.fetchImpl,
      Date.now,
      RETRY,
    );
    return { api, provider };
  };

  it('keeps the pinned catalog through a transient failure and flips on a rejected token', async () => {
    const { api, provider } = make();
    const good = structuredClone(await provider.refresh());
    expect(good.ready).toBe(true);
    api.state.mode = 'down';
    const held = await provider.refresh();
    expect(held).toMatchObject({ ready: true, toolCatalogHash: good.toolCatalogHash });
    expect(held.tools).toEqual(good.tools);
    expect(provider.snapshotCatalog().tools.length).toBeGreaterThan(0);
    expect(held.detail).toContain('the last probe failed transiently: network');
    api.state.mode = 'rejected';
    const rejected = await provider.refresh();
    expect(rejected).toMatchObject({ ready: false, status: 'invalid_auth', toolCatalogHash: null });
  });
});

describe('Atlassian provider', () => {
  const SITE = 'example.atlassian.net';
  const inner: Fetch = async (url) => {
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.pathname.endsWith('/rest/api/3/serverInfo'))
      return json({ baseUrl: `https://${SITE}` });
    if (url.pathname.endsWith('/rest/api/3/myself')) return json({ accountId: 'synthetic' });
    if (url.pathname.endsWith('/wiki/api/v2/spaces'))
      return json({ results: [], _links: { base: `https://${SITE}/wiki` } });
    return new Response('{}', { status: 404 });
  };
  const make = () => {
    const api = switchable(inner);
    const provider = new AtlassianRestProvider(
      {
        site: SITE,
        cloudId: '11111111-1111-4111-8111-111111111111',
        email: 'bot@example.com',
        tokens: { jira: 'jira-synthetic-token', confluence: 'conf-synthetic-token' },
      },
      api.fetchImpl,
      Date.now,
      RETRY,
    );
    return { api, provider };
  };

  it('keeps every ready product through transient failures, then flips', async () => {
    const { api, provider } = make();
    const good = structuredClone(await provider.refresh());
    expect(good.ready).toBe(true);
    api.state.mode = 'down';
    const held = await provider.refresh();
    expect(held).toMatchObject({ ready: true, status: 'ready', operations: good.operations });
    expect(held.products).toEqual({ jira: 'ready', confluence: 'ready' });
    expect(held.detail).toContain('jira: network (1 of 2 tolerated)');
    await provider.refresh();
    const flipped = await provider.refresh();
    expect(flipped).toMatchObject({ ready: false, operations: [] });
    expect(flipped.products).toEqual({ jira: 'network', confluence: 'network' });
  });

  it('flips at once when Atlassian rejects the credential', async () => {
    const { api, provider } = make();
    await provider.refresh();
    api.state.mode = 'rejected';
    const state = await provider.refresh();
    expect(state).toMatchObject({ ready: false, status: 'invalid_auth' });
  });
});
