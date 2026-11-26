import { describe, expect, it } from 'vitest';
import {
  ATLASSIAN_READINESS_REFRESH_MS,
  AtlassianRestProvider,
  credentialFingerprint,
  type AtlassianInstanceConfig,
} from '../../src/integrations/atlassian/atlassian-rest-provider.js';
import type { AtlassianFetch } from '../../src/integrations/atlassian/atlassian-rest-adapter.js';

const CLOUD = '11111111-1111-4111-8111-111111111111';
const SITE = 'example.atlassian.net';
/** One admin-managed instance: site binding from its settings, tokens from its credential. */
const CONFIG: AtlassianInstanceConfig = {
  site: SITE,
  cloudId: CLOUD,
  email: 'bot@example.com',
  tokens: { jira: 'jira-synthetic-token', confluence: 'conf-synthetic-token' },
};
const JIRA_ONLY: AtlassianInstanceConfig = { ...CONFIG, tokens: { jira: 'jira-synthetic-token' } };

/** Synthetic Atlassian: answers the readiness and read endpoints. */
function fakeAtlassian(
  overrides: { jiraBase?: string; wikiBase?: string; jiraStatus?: number; jiraBody?: string } = {},
) {
  const calls: string[] = [];
  const fetchImpl: AtlassianFetch = async (url) => {
    calls.push(url.pathname);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.pathname.startsWith('/ex/jira/') && overrides.jiraStatus)
      return new Response(overrides.jiraBody ?? '{}', { status: overrides.jiraStatus });
    if (url.pathname.endsWith('/rest/api/3/serverInfo'))
      return json({ baseUrl: overrides.jiraBase ?? `https://${SITE}` });
    if (url.pathname.endsWith('/rest/api/3/myself')) return json({ accountId: 'synthetic' });
    if (url.pathname.endsWith('/wiki/api/v2/spaces'))
      return json({ results: [], _links: { base: overrides.wikiBase ?? `https://${SITE}/wiki` } });
    if (url.pathname.endsWith('/rest/api/3/issue/ABC-1'))
      return json({ key: 'ABC-1', fields: { summary: 'Synthetic jira-synthetic-token' } });
    return json({}, 404);
  };
  return { calls, fetchImpl };
}

describe('Atlassian REST provider', () => {
  it('reports an incomplete instance by field name without leaking values', () => {
    const provider = new AtlassianRestProvider({
      site: 'https://evil.example',
      cloudId: 'not-a-uuid',
      email: 'no-at-sign',
      tokens: { jira: 'jira token with spaces' },
    });
    expect(provider.state).toMatchObject({
      enabled: true,
      status: 'missing_config',
      ready: false,
      site: null,
      cloudId: null,
    });
    expect(provider.state.detail).toMatch(/^the Atlassian instance is incomplete: /);
    expect(provider.state.detail).toMatch(/site \(bare \*\.atlassian\.net hostname\)/);
    expect(provider.state.detail).toMatch(/cloud ID \(site UUID\)/);
    expect(provider.state.detail).toMatch(/email/);
    expect(provider.state.detail).toMatch(/jira token \(malformed\)/);
    expect(provider.state.detail).toMatch(/a Jira and\/or Confluence token/);
    expect(provider.state.detail).not.toContain('evil.example');
    expect(provider.state.detail).not.toContain('jira token with spaces');
    expect(provider.configured).toBe(false);
    expect(provider.secrets()).toEqual([]);
    expect(provider.isStale()).toBe(false);
    const noTokens = new AtlassianRestProvider({ ...CONFIG, tokens: {} });
    expect(noTokens.state.status).toBe('missing_config');
    expect(noTokens.state.products).toEqual({
      jira: 'not_configured',
      confluence: 'not_configured',
    });
  });

  it('starts configured but not ready (pending products, no probe yet)', () => {
    const provider = new AtlassianRestProvider(JIRA_ONLY);
    expect(provider.configured).toBe(true);
    expect(provider.state).toMatchObject({
      enabled: true,
      ready: false,
      status: 'error',
      detail: 'readiness has not been established yet',
      site: SITE,
      cloudId: CLOUD,
      products: { jira: 'pending', confluence: 'not_configured' },
    });
    expect(provider.isStale()).toBe(true);
  });

  it('becomes ready per product with operations and stable fingerprints', async () => {
    const { calls, fetchImpl } = fakeAtlassian();
    const provider = new AtlassianRestProvider(CONFIG, fetchImpl);
    const state = await provider.refresh();
    expect(state).toMatchObject({
      ready: true,
      status: 'ready',
      site: SITE,
      cloudId: CLOUD,
      adapter: 'atlassian-rest-v1',
      contractVersion: 'atlassian-read-v4',
      products: { jira: 'ready', confluence: 'ready' },
    });
    expect(state.operations).toHaveLength(7);
    expect(calls).toEqual([
      `/ex/jira/${CLOUD}/rest/api/3/serverInfo`,
      `/ex/jira/${CLOUD}/rest/api/3/myself`,
      `/ex/confluence/${CLOUD}/wiki/api/v2/spaces`,
    ]);
    expect(state.credentialFingerprints).toEqual({
      jira: credentialFingerprint('jira', 'jira-synthetic-token'),
      confluence: credentialFingerprint('confluence', 'conf-synthetic-token'),
    });
    expect(state.credentialFingerprints.jira).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(state)).not.toContain('synthetic-token');
    // A restart keeps the binding; a rotation changes only that product's fingerprint.
    const restarted = await new AtlassianRestProvider(CONFIG, fetchImpl).refresh();
    expect(restarted.credentialFingerprints).toEqual(state.credentialFingerprints);
    const rotated = new AtlassianRestProvider(
      { ...CONFIG, tokens: { ...CONFIG.tokens, jira: 'jira-rotated-token' } },
      fetchImpl,
    ).state.credentialFingerprints;
    expect(rotated.jira).not.toBe(state.credentialFingerprints.jira);
    expect(rotated.confluence).toBe(state.credentialFingerprints.confluence);
  });

  it('refuses a cloud ID that belongs to another site', async () => {
    const jira = await new AtlassianRestProvider(
      CONFIG,
      fakeAtlassian({ jiraBase: 'https://other.atlassian.net' }).fetchImpl,
    ).refresh();
    expect(jira.products.jira).toBe('site_mismatch');
    expect(jira.operations).toEqual(['getConfluencePage', 'searchConfluencePages']);
    const both = await new AtlassianRestProvider(
      CONFIG,
      fakeAtlassian({
        jiraBase: 'https://other.atlassian.net',
        wikiBase: 'https://other.atlassian.net/wiki',
      }).fetchImpl,
    ).refresh();
    expect(both).toMatchObject({ ready: false, status: 'site_mismatch', operations: [] });
  });

  it('keeps a product without a token unavailable', async () => {
    const state = await new AtlassianRestProvider(
      { ...CONFIG, tokens: { jira: 'jira-synthetic-token', confluence: '' } },
      fakeAtlassian().fetchImpl,
    ).refresh();
    expect(state.products).toEqual({ jira: 'ready', confluence: 'not_configured' });
    expect(state.credentialFingerprints).toEqual({
      jira: credentialFingerprint('jira', 'jira-synthetic-token'),
    });
    expect(state.operations).not.toContain('getConfluencePage');
  });

  it('classifies an expired token and a missing scope at readiness', async () => {
    const expired = await new AtlassianRestProvider(
      JIRA_ONLY,
      fakeAtlassian({ jiraStatus: 401, jiraBody: '{"message":"Unauthorized"}' }).fetchImpl,
    ).refresh();
    expect(expired).toMatchObject({ ready: false, status: 'invalid_auth' });
    const scope = await new AtlassianRestProvider(
      CONFIG,
      fakeAtlassian({
        jiraStatus: 401,
        jiraBody: '{"message":"Unauthorized; scope does not match"}',
      }).fetchImpl,
    ).refresh();
    expect(scope.products.jira).toBe('insufficient_scope');
    expect(scope.ready).toBe(true);
    expect(scope.detail).toMatch(/jira: insufficient_scope/);
  });

  it('re-probes at bounded frequency and turns not-ready when a token is revoked', async () => {
    let now = 1_000_000;
    let revoked = false;
    const good = fakeAtlassian().fetchImpl;
    const fetchImpl: AtlassianFetch = async (url, init) =>
      revoked ? new Response('{"message":"Unauthorized"}', { status: 401 }) : good(url, init);
    const provider = new AtlassianRestProvider(JIRA_ONLY, fetchImpl, () => now);
    await provider.refresh();
    expect(provider.state.ready).toBe(true);
    expect(provider.state.checkedAt).toBe(new Date(now).toISOString());
    revoked = true;
    // Fresh readiness is not stale; the registry re-probes only stale providers.
    expect(provider.isStale()).toBe(false);
    now += ATLASSIAN_READINESS_REFRESH_MS - 1;
    expect(provider.isStale()).toBe(false);
    now += 1;
    expect(provider.isStale()).toBe(true);
    const probing = provider.refresh();
    // Not stale while a probe is in flight (no concurrent duplicate probes).
    expect(provider.isStale()).toBe(false);
    await probing;
    expect(provider.isStale()).toBe(false);
    expect(provider.state).toMatchObject({ ready: false, status: 'invalid_auth', operations: [] });
  });

  it('reads through the product route and lists every token form for redaction', async () => {
    const provider = new AtlassianRestProvider(CONFIG, fakeAtlassian().fetchImpl);
    await provider.refresh();
    const result = await provider.read({ kind: 'getJiraIssue', issueKey: 'ABC-1' }, 5000, 10000);
    expect(result.status).toBe('completed');
    const secrets = provider.secrets();
    expect(secrets).toHaveLength(6);
    for (const token of ['jira-synthetic-token', 'conf-synthetic-token']) {
      expect(secrets).toContain(token);
      expect(secrets).toContain(Buffer.from(token).toString('base64'));
      expect(secrets).toContain(Buffer.from(`bot@example.com:${token}`).toString('base64'));
    }
  });

  it('reads an upstream body larger than the model output bound and bounds the projection', async () => {
    const base = fakeAtlassian().fetchImpl;
    const storage = `<p>${'synthetic page text '.repeat(6000)}</p>`;
    const fetchImpl: AtlassianFetch = async (url, init) =>
      url.pathname.endsWith('/wiki/api/v2/pages/12345')
        ? new Response(
            JSON.stringify({
              id: '12345',
              title: 'Big page',
              status: 'current',
              spaceId: '99',
              body: { storage: { value: storage, representation: 'storage' } },
            }),
            { status: 200 },
          )
        : base(url, init);
    const provider = new AtlassianRestProvider(CONFIG, fetchImpl);
    await provider.refresh();
    const result = await provider.read({ kind: 'getConfluencePage', pageId: '12345' }, 5000, 48000);
    expect(result.status).toBe('completed');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(12000);
    expect(result.output).toContain('Big page');
  });
});
