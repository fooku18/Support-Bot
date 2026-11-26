import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAuthorizationPolicy } from '../../agent/src/domain/authorization/policy.js';
import { createApp } from '../src/app.js';
import { hashPassword, newApiToken, tokenHash } from '../src/auth.js';
import type { CompiledDocument } from '../src/compile.js';
import type { AdminConfig } from '../src/config.js';
import { ATLASSIAN_READ_OPERATIONS } from '../src/generated/tool-kinds.js';
import { SlackApi } from '../src/slack.js';
import { AdminStore } from '../src/store.js';

const INTERNAL = 'internal-token-internal-token-internal-token';
const BOT_TOKEN = 'xoxb-fake-team-token';

interface Fake {
  url: string;
  calls: string[];
  memberChannels: Set<string>;
  /** Methods answering 429 (with this Retry-After) for their next N calls. */
  rateLimits: Map<string, { remaining: number; retryAfter: string }>;
  close(): Promise<void>;
}

async function listen(
  handler: http.RequestListener,
): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function fakeSlack(): Promise<Fake> {
  const calls: string[] = [];
  const memberChannels = new Set(['C0GENERAL']);
  const rateLimits = new Map<string, { remaining: number; retryAfter: string }>();
  const channels: Record<string, { id: string; name: string; is_private: boolean }> = {
    C0GENERAL: { id: 'C0GENERAL', name: 'general', is_private: false },
    C0OTHER: { id: 'C0OTHER', name: '<script>x</script>', is_private: false },
  };
  const users: Record<string, Record<string, unknown>> = {
    U0ALICE: { id: 'U0ALICE', name: 'alice', profile: { display_name: 'Alice' } },
    U0BOB: { id: 'U0BOB', name: 'bob', profile: { display_name: 'Bob' } },
    U0GONE: { id: 'U0GONE', name: 'gone', deleted: true },
  };
  const { url, server } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop() ?? '';
    calls.push(method);
    const auth = req.headers.authorization ?? '';
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const params = new URLSearchParams(raw);
    const reply = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const limit = rateLimits.get(method);
    if (limit !== undefined && limit.remaining > 0) {
      limit.remaining -= 1;
      res.writeHead(429, { 'retry-after': limit.retryAfter });
      res.end();
      return;
    }
    if (method === 'oauth.v2.access') {
      const expected = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`;
      if (auth !== expected) return reply({ ok: false, error: 'invalid_client' });
      return reply({
        ok: true,
        access_token: BOT_TOKEN,
        token_type: 'bot',
        scope: 'app_mentions:read,chat:write',
        bot_user_id: 'U0BOTUSER',
        team: { id: 'T0TEAM1', name: 'Team <One>' },
        authed_user: { id: 'U0INSTALLER' },
      });
    }
    if (auth !== `Bearer ${BOT_TOKEN}`) return reply({ ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') {
      return reply({ ok: true, team_id: 'T0TEAM1', user_id: 'U0BOTUSER', bot_id: 'B0BOT' });
    }
    if (method === 'users.conversations') {
      return reply({ ok: true, channels: [...memberChannels].map((id) => channels[id]) });
    }
    if (method === 'conversations.info') {
      const channel = channels[params.get('channel') ?? ''];
      if (channel === undefined) return reply({ ok: false, error: 'channel_not_found' });
      return reply({
        ok: true,
        channel: { ...channel, is_member: memberChannels.has(channel.id) },
      });
    }
    if (method === 'users.list') {
      return reply({ ok: true, members: Object.values(users) });
    }
    if (method === 'users.info') {
      const user = users[params.get('user') ?? ''];
      return reply(
        user === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, user },
      );
    }
    reply({ ok: false, error: 'unknown_method' });
  });
  return {
    url: `${url}/api/`,
    calls,
    memberChannels,
    rateLimits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('admin app', () => {
  let slack: Fake;
  let store: AdminStore;
  let base: string;
  let server: http.Server;
  let apiToken: string;

  beforeEach(async () => {
    slack = await fakeSlack();
    const config: AdminConfig = {
      publicUrl: 'https://admin.example.test',
      internalToken: INTERNAL,
      storeKey: Buffer.alloc(32, 1),
      sessionKey: Buffer.alloc(32, 2),
      slackClientId: 'client-id',
      slackClientSecret: 'client-secret',
      slackApiUrl: slack.url,
      egressProxyUrl: undefined,
      port: 0,
      host: '127.0.0.1',
      database: { path: ':memory:' },
      models: { keys: ['sonnet', 'opus'], defaultKey: 'sonnet' },
      studioUrl: null,
      costRetentionDays: 400,
    };
    store = await AdminStore.open({ path: ':memory:' }, config.storeKey);
    apiToken = newApiToken();
    await store.createApiToken('test', 'harness', tokenHash(apiToken));
    const started = await listen(
      createApp({
        config,
        store,
        slack: new SlackApi({ apiUrl: slack.url }),
        log: () => undefined,
      }),
    );
    base = started.url;
    server = started.server;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await slack.close();
    await store.close();
  });

  const call = async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'x-forwarded-proto': 'https',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const api = async (path: string, method = 'GET', body?: unknown): Promise<Response> =>
    await call(`/api${path}`, { method, body, headers: { authorization: `Bearer ${apiToken}` } });
  const internalConfig = (etag?: string): Promise<Response> =>
    fetch(`${base}/internal/config`, {
      headers: {
        authorization: `Bearer ${INTERNAL}`,
        ...(etag === undefined ? {} : { 'if-none-match': etag }),
      },
    });

  async function pair(): Promise<void> {
    const { url } = (await (await api('/installations/authorize', 'POST')).json()) as {
      url: string;
    };
    const authorize = new URL(url);
    expect(authorize.origin).toBe('https://slack.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://admin.example.test/slack/oauth/callback',
    );
    expect(authorize.searchParams.get('scope')).toContain('users:read');
    const state = authorize.searchParams.get('state') ?? '';
    const callback = await call(
      `/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('Team &lt;One&gt;');
    // Single use.
    const replay = await call(`/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(400);
  }

  it('serves a deny-all document before anything is configured, with ETag revalidation', async () => {
    const first = await internalConfig();
    expect(first.status).toBe(200);
    const document = (await first.json()) as CompiledDocument;
    expect(document.version).toBe(1);
    expect(document.installations).toEqual([]);
    parseAuthorizationPolicy(JSON.stringify(document.authorizationPolicy));
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toBe(`"${document.hash}"`);
    expect((await internalConfig(etag)).status).toBe(304);
    expect((await internalConfig('"other"')).status).toBe(200);
  });

  it('guards the internal API with its bearer token and refuses proxied requests', async () => {
    expect((await fetch(`${base}/internal/config`)).status).toBe(401);
    const proxied = await fetch(`${base}/internal/config`, {
      headers: { authorization: `Bearer ${INTERNAL}`, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(proxied.status).toBe(404);
  });

  it('requires HTTPS through the proxy for everything but health and internal routes', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/login`)).status).toBe(403);
    expect((await call('/login')).status).toBe(200);
    expect((await call('/workspaces')).headers.get('location')).toBe('/login');
    expect((await call('/api/installations')).status).toBe(401);
  });

  it('pairs a workspace as pending, whitelists it, and hands the token to the adapter only then', async () => {
    await pair();
    let installations = (await (await api('/installations')).json()) as {
      installations: Array<Record<string, unknown>>;
    };
    expect(installations.installations[0]).toMatchObject({
      teamId: 'T0TEAM1',
      status: 'pending',
      botUserId: 'U0BOTUSER',
      botId: 'B0BOT',
      paired: true,
    });
    expect(JSON.stringify(installations)).not.toContain(BOT_TOKEN);
    const tokenUrl = `${base}/internal/installations/T0TEAM1/token`;
    const headers = { authorization: `Bearer ${INTERNAL}` };
    expect((await fetch(tokenUrl, { headers })).status).toBe(404);
    // Not served, but the adapter may post the "not enabled" notice.
    const noticeUrl = `${base}/internal/installations/T0TEAM1/notice-token`;
    const noticeToken = await fetch(noticeUrl, { headers });
    expect(noticeToken.status).toBe(200);
    expect(await noticeToken.json()).toMatchObject({
      status: 'pending',
      botUserId: 'U0BOTUSER',
      botToken: BOT_TOKEN,
    });
    let document = (await (await internalConfig()).json()) as CompiledDocument;
    expect(document.installations).toEqual([]);

    const whitelisted = await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
    expect(whitelisted.status).toBe(200);
    document = (await (await internalConfig()).json()) as CompiledDocument;
    expect(document.installations).toEqual([
      {
        teamId: 'T0TEAM1',
        teamName: 'Team <One>',
        botUserId: 'U0BOTUSER',
        botId: 'B0BOT',
        trustedBotSender: null,
        installedAt: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(document)).not.toContain(BOT_TOKEN);
    const token = (await (await fetch(tokenUrl, { headers })).json()) as { botToken: string };
    expect(
      (await fetch(`${base}/internal/installations/T0TEAM1/notice-token`, { headers })).status,
    ).toBe(404);
    expect(token.botToken).toBe(BOT_TOKEN);
    // Stored encrypted, never in clear text.
    const stored = (await store.get('SELECT bot_token_enc FROM installations')) as {
      bot_token_enc: string;
    };
    expect(stored.bot_token_enc).not.toContain(BOT_TOKEN);

    installations = (await (await api('/installations')).json()) as typeof installations;
    expect(installations.installations[0]?.status).toBe('whitelisted');
    const audit = (await (await api('/audit')).json()) as { entries: Array<{ action: string }> };
    expect(audit.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'installation.paired',
        'installation.status',
        'installation.token.read',
      ]),
    );
  });

  it('enables only channels the bot is in and compiles the people of a channel into the policy', async () => {
    await pair();
    await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
    const refused = await api('/installations/T0TEAM1/channels/C0OTHER', 'PUT', { enabled: true });
    expect(refused.status).toBe(409);
    expect(
      (await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true })).status,
    ).toBe(200);
    const added = await api(
      '/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE',
      'PUT',
      {
        displayName: 'Alice',
      },
    );
    expect(added.status).toBe(200);
    const { configVersion } = (await added.json()) as { configVersion: number };
    const document = (await (await internalConfig()).json()) as CompiledDocument;
    expect(document.version).toBe(configVersion);
    const policy = parseAuthorizationPolicy(JSON.stringify(document.authorizationPolicy));
    expect(policy.policyId).toBe(`admin-v${configVersion}`);
    expect(policy.bindings).toEqual([
      { workspace: 'T0TEAM1', channels: ['C0GENERAL'], users: ['*'], roles: ['user'] },
    ]);
    expect(Object.keys(policy.roles)).toEqual(['user']);
    const listed = await api('/installations/T0TEAM1/channels/C0GENERAL/blocked-members');
    expect(await listed.json()).toEqual({
      blockedMembers: [
        { teamId: 'T0TEAM1', channelId: 'C0GENERAL', userId: 'U0ALICE', displayName: 'Alice' },
      ],
    });
    // Adding again keeps the person; an empty name keeps the stored one.
    expect(
      (await api('/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE', 'PUT', {}))
        .status,
    ).toBe(200);
    expect(await store.listBlockedMembers('T0TEAM1', 'C0GENERAL')).toEqual([
      { teamId: 'T0TEAM1', channelId: 'C0GENERAL', userId: 'U0ALICE', displayName: 'Alice' },
    ]);
    expect(
      (
        await api('/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE', 'PUT', {
          displayName: 7,
        })
      ).status,
    ).toBe(400);
    // The retired routes are gone.
    expect((await api('/installations/T0TEAM1/channels/C0GENERAL/members')).status).toBe(404);
    expect(
      (await api('/members/T0TEAM1/C0GENERAL/U0ALICE', 'PATCH', { role: 'member' })).status,
    ).toBe(404);

    for (const method of ['GET', 'PUT', 'DELETE'])
      expect(
        (await api('/installations/T0TEAM1/channels/C0GENERAL/users/U0ALICE', method)).status,
      ).toBe(404);
    // Unblocking removes the deny; disabling a scope preserves stored blocks.
    const removed = await api(
      '/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE',
      'DELETE',
    );
    expect(removed.status).toBe(200);
    let current = (await (await internalConfig()).json()) as CompiledDocument;
    expect(JSON.stringify(current.authorizationPolicy)).not.toContain('U0ALICE');
    expect(
      (await store.listAudit(10))
        .map((entry) => entry.action)
        .filter((action) => action.startsWith('channel.member.')),
    ).toEqual(['channel.member.unblock', 'channel.member.block', 'channel.member.block']);
    await api('/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE', 'PUT');
    await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: false });
    current = (await (await internalConfig()).json()) as CompiledDocument;
    expect(JSON.stringify(current.authorizationPolicy)).toContain('U0ALICE');
    // Disabling the workspace drops it from the document.
    await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
    await api('/installations/T0TEAM1', 'PATCH', { status: 'disabled' });
    current = (await (await internalConfig()).json()) as CompiledDocument;
    expect(current.installations).toEqual([]);
    expect(JSON.stringify(current.authorizationPolicy)).toContain('U0ALICE');
  });

  it('refuses user IDs the agent cannot load and never stores a document the agent would refuse', async () => {
    await pair();
    await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
    await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
    const before = (await (await internalConfig()).json()) as CompiledDocument;
    const grid = await api(
      '/installations/T0TEAM1/channels/C0GENERAL/blocked-members/X0INVALID',
      'PUT',
    );
    expect(grid.status).toBe(400);
    expect(((await grid.json()) as { error: string }).error).toContain('starting with U or W');
    // Even past the route check, the store rolls back what the agent refuses.
    await store.run(
      "INSERT INTO blocked_members (team_id, channel_id, user_id, display_name, updated_at) VALUES ('T0TEAM1', 'C0GENERAL', 'X0INVALID', '', 0)",
    );
    const next = await api(
      '/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE',
      'PUT',
    );
    expect(next.status).toBe(409);
    expect(((await next.json()) as { error: string }).error).toContain('the agent would refuse');
    const after = (await (await internalConfig()).json()) as CompiledDocument;
    expect(after.version).toBe(before.version);
    expect(
      (await store.listBlockedMembers('T0TEAM1', 'C0GENERAL')).map((row) => row.userId),
    ).toEqual(['X0INVALID']);
  });

  it('applies a status and trusted sender change together or not at all', async () => {
    await pair();
    const refused = await api('/installations/T0TEAM1', 'PATCH', {
      status: 'whitelisted',
      trustedBotSender: { botId: 'B0BOT', userId: 'U0SENDER', channelId: 'C0GENERAL' },
    });
    expect(refused.status).toBe(400);
    expect((await store.installation('T0TEAM1'))?.status).toBe('pending');
    const sender = { botId: 'B0SENDER', userId: 'U0SENDER', channelId: 'C0GENERAL' };
    const both = await api('/installations/T0TEAM1', 'PATCH', {
      status: 'whitelisted',
      trustedBotSender: sender,
    });
    expect(both.status).toBe(200);
    expect(await store.installation('T0TEAM1')).toMatchObject({
      status: 'whitelisted',
      trustedBotSender: sender,
    });
    const audit = (await store.listAudit(5)).map((entry) => entry.action);
    expect(audit[0]).toBe('installation.update');
  });

  it('holds the login lock against parallel attempts and bounds the audit rows', async () => {
    await store.createAdmin('cli', 'carol', await hashPassword('correct horse battery'));
    const attempt = (password: string) =>
      fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'x-forwarded-proto': 'https',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ name: 'carol', password }).toString(),
      });
    await Promise.all(Array.from({ length: 40 }, () => attempt('wrong password!!')));
    const actions = (await store.listAudit(200)).map((entry) => entry.action);
    expect(actions.filter((action) => action === 'admin.login.failed').length).toBeLessThanOrEqual(
      5,
    );
    expect(actions.filter((action) => action === 'admin.login.locked').length).toBeLessThanOrEqual(
      1,
    );
    // Further attempts while locked write nothing new.
    for (let index = 0; index < 5; index += 1) await attempt('wrong password!!');
    const after = (await store.listAudit(200)).map((entry) => entry.action);
    expect(after.filter((action) => action === 'admin.login.failed').length).toBeLessThanOrEqual(5);
    expect(after.filter((action) => action === 'admin.login.locked')).toHaveLength(1);
    const locked = await attempt('correct horse battery');
    expect(locked.status).toBe(401);
    expect(await locked.text()).toContain('Too many failed sign-ins');
  });

  it('validates the trusted bot sender and records events from unknown teams as pending', async () => {
    await pair();
    const self = await api('/installations/T0TEAM1', 'PATCH', {
      trustedBotSender: { botId: 'B0BOT', userId: 'U0SENDER', channelId: 'C0GENERAL' },
    });
    expect(self.status).toBe(400);
    const sender = { botId: 'B0SENDER', userId: 'U0SENDER', channelId: 'C0GENERAL' };
    expect(
      (await api('/installations/T0TEAM1', 'PATCH', { trustedBotSender: sender })).status,
    ).toBe(200);
    const seen = await fetch(`${base}/internal/installations/seen`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: 'T0STRANGER' }),
    });
    expect(seen.status).toBe(204);
    const installations = (await (await api('/installations')).json()) as {
      installations: Array<{ teamId: string; status: string; paired: boolean }>;
    };
    expect(installations.installations.find((row) => row.teamId === 'T0STRANGER')).toMatchObject({
      status: 'pending',
      paired: false,
    });
    // An unpaired team cannot be whitelisted.
    expect(
      (await api('/installations/T0STRANGER', 'PATCH', { status: 'whitelisted' })).status,
    ).toBe(409);
  });

  it('signs admins in with a session cookie, checks CSRF, escapes Slack names and locks after failures', async () => {
    await store.createAdmin('cli', 'alice', await hashPassword('correct horse battery'));
    await pair();
    const form = (body: Record<string, string>, cookie?: string): RequestInit => ({
      method: 'POST',
      redirect: 'manual',
      headers: {
        'x-forwarded-proto': 'https',
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams(body).toString(),
    });
    const bad = await fetch(`${base}/login`, form({ name: 'alice', password: 'wrong password!' }));
    expect(bad.status).toBe(401);
    const ok = await fetch(
      `${base}/login`,
      form({ name: 'alice', password: 'correct horse battery' }),
    );
    expect(ok.status).toBe(303);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const cookie = setCookie.split(';')[0] as string;
    const workspaces = await call('/workspaces', { headers: { cookie } });
    const body = await workspaces.text();
    expect(body).toContain('Team &lt;One&gt;');
    expect(body).not.toContain('Team <One>');
    const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
    await store.setChannel('test', {
      teamId: 'T0TEAM1',
      channelId: 'C0GENERAL',
      name: 'general',
      isPrivate: false,
      botMember: true,
      enabled: true,
    });
    for (const userId of ['U0ALICE', 'U0BOB']) {
      await store.blockMember('test', {
        teamId: 'T0TEAM1',
        channelId: 'C0GENERAL',
        userId,
        displayName: userId,
      });
    }
    slack.memberChannels.add('C0OTHER');
    const channels = await (
      await call('/workspaces/T0TEAM1/channels', { headers: { cookie } })
    ).text();
    expect(channels).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(channels).not.toContain('<script>x</script>');
    // The channel list counts each channel's people (not only the people page).
    expect(channels).toContain('Blocked members (2)');
    expect(channels).toContain('Waiting for workspace');

    const forged = await fetch(
      `${base}/workspaces/T0TEAM1/status`,
      form({ status: 'whitelisted', csrf: 'forged' }, cookie),
    );
    expect(forged.status).toBe(403);
    const whitelist = await fetch(
      `${base}/workspaces/T0TEAM1/status`,
      form({ status: 'whitelisted', csrf }, cookie),
    );
    expect(whitelist.status).toBe(303);
    expect((await store.installation('T0TEAM1'))?.status).toBe('whitelisted');
    const audit = (await store.listAudit(20)).find(
      (entry) => entry.action === 'installation.status',
    );
    expect(audit?.actor).toBe('alice');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fetch(`${base}/login`, form({ name: 'alice', password: 'wrong password!' }));
    }
    const locked = await fetch(
      `${base}/login`,
      form({ name: 'alice', password: 'correct horse battery' }),
    );
    expect(locked.status).toBe(401);
    expect(await locked.text()).toContain('Too many failed sign-ins');
  });

  describe('tool instances', () => {
    const GITLAB_SECRET = 'glpat-secret-value-0001';
    const JIRA_SECRET = 'jira-secret-token-0001';
    const CONFLUENCE_SECRET = 'confluence-secret-token-0001';
    const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
    const internalGet = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${base}/internal${path}`, {
        headers: { authorization: `Bearer ${INTERNAL}`, ...headers },
      });
    const report = (body: unknown): Promise<Response> =>
      fetch(`${base}/internal/tool-instances/status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const currentDocument = async (): Promise<CompiledDocument> =>
      (await (await internalConfig()).json()) as CompiledDocument;
    type View = {
      id: string;
      hasCredential: boolean;
      credentialVersion: number;
      ready: boolean;
      detail: string | null;
      readiness: { state: string; current: boolean } | null;
      assignedTo: string[];
    };

    async function setup(): Promise<{ gitlab: View; atlassian: View }> {
      await pair();
      await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
      await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
      await api('/installations/T0TEAM1/channels/C0GENERAL/blocked-members/U0ALICE', 'PUT');
      const gitlab = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'gitlab',
        label: 'GitLab (example)',
        host: 'gitlab.example.com',
        credential: GITLAB_SECRET,
      });
      expect(gitlab.status).toBe(201);
      const atlassian = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'atlassian',
        label: 'Jira (example)',
        host: 'example.atlassian.net',
        settings: { cloudId: CLOUD_ID, email: 'owner@example.com' },
        credential: { jira: JIRA_SECRET, confluence: CONFLUENCE_SECRET },
      });
      expect(atlassian.status).toBe(201);
      return {
        gitlab: ((await gitlab.json()) as { instance: View }).instance,
        atlassian: ((await atlassian.json()) as { instance: View }).instance,
      };
    }

    function expectNoSecret(text: string): void {
      for (const secret of [GITLAB_SECRET, JIRA_SECRET, CONFLUENCE_SECRET])
        expect(text).not.toContain(secret);
    }

    it('keeps credentials write-only in the API, the audit log and the database', async () => {
      const { gitlab, atlassian } = await setup();
      expect(gitlab).toMatchObject({
        hasCredential: true,
        credentialVersion: 1,
        readiness: null,
        ready: false,
        detail: 'waiting for runtime readiness',
      });
      expect(gitlab.id).toMatch(/^ti_[a-f0-9]{16}$/);
      expect(atlassian).toMatchObject({ hasCredential: true, credentialVersion: 1 });
      const invalid = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'gitlab',
        label: 'bad',
        host: 'https://gitlab.example.com',
      });
      expect(invalid.status).toBe(400);
      expect(
        (await api('/installations/T0TEAM1/tools', 'POST', { kind: 'unknown', label: 'x' })).status,
      ).toBe(400);
      const replaced = await api(`/installations/T0TEAM1/tools/${gitlab.id}`, 'PUT', {
        credential: 'glpat-secret-value-0002',
      });
      expect(replaced.status).toBe(200);
      const replacedText = await replaced.text();
      expect(replacedText).not.toContain('glpat-secret-value-0002');
      expect((JSON.parse(replacedText) as { instance: View }).instance.credentialVersion).toBe(2);

      const listed = await (await api('/installations/T0TEAM1/tools')).text();
      expectNoSecret(listed);
      expect(listed).not.toContain('glpat-secret-value-0002');
      expect(listed).toContain(CLOUD_ID);
      const audit = await (await api('/audit?limit=1000')).text();
      expectNoSecret(audit);
      expect(audit).not.toContain('glpat-secret-value-0002');
      expect(audit).toContain('"credentialChanged":true');
      expectNoSecret(JSON.stringify(await currentDocument()));
      const stored = await store.all('SELECT credential_enc FROM tool_instances ORDER BY id');
      for (const row of stored) expect(row.credential_enc).toMatch(/^v1:/);
      expectNoSecret(JSON.stringify(stored));
      expect((await store.toolSecret(atlassian.id))?.credential).toBe(
        JSON.stringify({ jira: JIRA_SECRET, confluence: CONFLUENCE_SECRET }),
      );
      // A ciphertext is bound to its instance (AAD): a swapped one does not decrypt.
      const atlassianCipher = String(
        (await store.get('SELECT credential_enc FROM tool_instances WHERE id = ?', atlassian.id))
          ?.credential_enc,
      );
      await store.run(
        'UPDATE tool_instances SET credential_enc = ? WHERE id = ?',
        atlassianCipher,
        gitlab.id,
      );
      await expect(store.toolSecret(gitlab.id)).rejects.toThrow();
    });

    it('serves enabled instances of whitelisted workspaces to the runtimes with ETag revalidation', async () => {
      const { gitlab, atlassian } = await setup();
      const first = await internalGet('/tool-instances');
      expect(first.status).toBe(200);
      const text = await first.text();
      expectNoSecret(text);
      const body = JSON.parse(text) as {
        configVersion: number;
        instances: Array<Record<string, unknown>>;
      };
      expect(body.instances.map((row) => row.id).sort()).toEqual([gitlab.id, atlassian.id].sort());
      expect(body.instances.find((row) => row.id === atlassian.id)).toMatchObject({
        teamId: 'T0TEAM1',
        kind: 'atlassian',
        host: 'example.atlassian.net',
        settings: { cloudId: CLOUD_ID, email: 'owner@example.com', operations: null },
        credentialVersion: 1,
        hasCredential: true,
      });
      const etag = first.headers.get('etag') ?? '';
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      expect((await internalGet('/tool-instances', { 'if-none-match': etag })).status).toBe(304);
      await api(`/installations/T0TEAM1/tools/${gitlab.id}`, 'PUT', { status: 'disabled' });
      const changed = await internalGet('/tool-instances', { 'if-none-match': etag });
      expect(changed.status).toBe(200);
      const after = (await changed.json()) as { instances: Array<{ id: string }> };
      expect(after.instances.map((row) => row.id)).toEqual([atlassian.id]);
      await api('/installations/T0TEAM1', 'PATCH', { status: 'disabled' });
      const none = (await (await internalGet('/tool-instances')).json()) as {
        instances: unknown[];
      };
      expect(none.instances).toEqual([]);
      // Proxied or unauthenticated callers get nothing.
      expect((await fetch(`${base}/internal/tool-instances`)).status).toBe(401);
    });

    it('audits every internal secret read and refuses unusable instances', async () => {
      const { gitlab } = await setup();
      const read = await internalGet(`/tool-instances/${gitlab.id}/secret`, {
        'x-support-agent-caller': 'runner',
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({
        id: gitlab.id,
        kind: 'gitlab',
        teamId: 'T0TEAM1',
        credentialVersion: 1,
        credential: GITLAB_SECRET,
      });
      // Each caller reads only the kinds it serves; unknown callers read nothing.
      for (const caller of ['someone', 'web-runtime', '']) {
        const refused = await internalGet(
          `/tool-instances/${gitlab.id}/secret`,
          caller === '' ? {} : { 'x-support-agent-caller': caller },
        );
        expect(refused.status, caller).toBe(403);
        expect(await refused.text()).not.toContain(GITLAB_SECRET);
      }
      expect(
        (
          await internalGet(`/tool-instances/${gitlab.id}/secret`, {
            'x-support-agent-caller': 'cli-runtime',
          })
        ).status,
      ).toBe(200);
      const reads = (await store.listAudit(50)).filter((row) => row.action === 'tool.secret.read');
      expect(reads.map((row) => [row.actor, row.target, row.detail])).toEqual([
        ['cli-runtime', gitlab.id, { credentialVersion: 1 }],
        ['runner', gitlab.id, { credentialVersion: 1 }],
      ]);
      expect(
        (await store.listAudit(50)).filter((row) => row.action === 'tool.secret.refused'),
      ).toHaveLength(3);
      expect((await internalGet('/tool-instances/ti_0000000000000000/secret')).status).toBe(404);
      const files = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'files',
        label: 'Files',
      });
      const filesId = ((await files.json()) as { instance: View }).instance.id;
      expect((await internalGet(`/tool-instances/${filesId}/secret`)).status).toBe(404);
      await api(`/installations/T0TEAM1/tools/${gitlab.id}`, 'PUT', { status: 'disabled' });
      expect((await internalGet(`/tool-instances/${gitlab.id}/secret`)).status).toBe(404);
      await api(`/installations/T0TEAM1/tools/${gitlab.id}`, 'PUT', { status: 'enabled' });
      await api('/installations/T0TEAM1', 'PATCH', { status: 'pending' });
      expect((await internalGet(`/tool-instances/${gitlab.id}/secret`)).status).toBe(404);
      expect(
        (await store.listAudit(50)).filter((row) => row.action === 'tool.secret.read'),
      ).toHaveLength(2);
    });

    it("serves a slack instance the workspace's bot token, versioned by the install", async () => {
      await setup();
      const created = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'slack',
        label: 'Slack users',
      });
      expect(created.status).toBe(201);
      const slackView = ((await created.json()) as { instance: View & { settings: unknown } })
        .instance;
      const installedAt = (await store.installation('T0TEAM1'))!.installedAt!;
      expect(slackView).toMatchObject({
        hasCredential: true,
        credentialVersion: installedAt,
        settings: {},
      });
      // It takes no credential of its own.
      const refusedCreate = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'slack',
        label: 'Slack 2',
        credential: 'xoxb-other-token-0001',
      });
      expect(refusedCreate.status).toBe(400);
      expect(await refusedCreate.text()).toContain("uses the workspace's bot token");
      const refusedPut = await api(`/installations/T0TEAM1/tools/${slackView.id}`, 'PUT', {
        credential: 'xoxb-other-token-0001',
      });
      expect(refusedPut.status).toBe(400);
      // Whitelisted with a token: the cli-runtime reads it, audited.
      const read = await internalGet(`/tool-instances/${slackView.id}/secret`, {
        'x-support-agent-caller': 'cli-runtime',
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({
        id: slackView.id,
        kind: 'slack',
        teamId: 'T0TEAM1',
        credentialVersion: installedAt,
        credential: BOT_TOKEN,
      });
      expect(
        (await store.listAudit(50)).filter(
          (row) => row.action === 'tool.secret.read' && row.target === slackView.id,
        ),
      ).toHaveLength(1);
      // The runner never reads it.
      expect(
        (
          await internalGet(`/tool-instances/${slackView.id}/secret`, {
            'x-support-agent-caller': 'runner',
          })
        ).status,
      ).toBe(403);
      const listed = (await (await internalGet('/tool-instances')).json()) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(listed.instances.find((row) => row.id === slackView.id)).toEqual({
        id: slackView.id,
        teamId: 'T0TEAM1',
        kind: 'slack',
        label: 'Slack users',
        host: 'slack.com',
        settings: {},
        credentialVersion: installedAt,
        hasCredential: true,
      });
      // The document carries the instance, never the token.
      await api(`/installations/T0TEAM1/channels/C0GENERAL/tools/slack`, 'PUT', {
        instanceId: slackView.id,
      });
      const document = await currentDocument();
      expect(JSON.stringify(document)).not.toContain(BOT_TOKEN);
      expect(
        document.toolAssignments?.[0]?.tools.find((tool) => tool.kind === 'slack'),
      ).toMatchObject({ credentialVersion: installedAt, ready: false });
      // A reinstall rotates the token and bumps the version.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pair();
      const reinstalledAt = (await store.installation('T0TEAM1'))!.installedAt!;
      expect(reinstalledAt).toBeGreaterThan(installedAt);
      expect((await store.toolInstance(slackView.id))?.credentialVersion).toBe(reinstalledAt);
      expect(
        (await currentDocument()).toolAssignments?.[0]?.tools.find((tool) => tool.kind === 'slack')
          ?.credentialVersion,
      ).toBe(reinstalledAt);
      // Pending or disabled workspaces serve no token.
      for (const status of ['pending', 'disabled']) {
        await api('/installations/T0TEAM1', 'PATCH', { status });
        const refused = await internalGet(`/tool-instances/${slackView.id}/secret`, {
          'x-support-agent-caller': 'cli-runtime',
        });
        expect(refused.status, status).toBe(404);
        expect(await refused.text()).toContain('no whitelisted installation');
        expect((await store.toolInstance(slackView.id))?.hasCredential).toBe(false);
      }
    });

    it('reports a slack instance without a stored bot token as having no credential', async () => {
      await setup();
      const created = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'slack',
        label: 'Slack users',
      });
      const id = ((await created.json()) as { instance: View }).instance.id;
      (store as unknown as { run(sql: string, ...args: unknown[]): void }).run(
        'UPDATE installations SET bot_token_enc = NULL WHERE team_id = ?',
        'T0TEAM1',
      );
      expect(await store.toolInstance(id)).toMatchObject({ hasCredential: false });
      expect(
        (
          await internalGet(`/tool-instances/${id}/secret`, {
            'x-support-agent-caller': 'cli-runtime',
          })
        ).status,
      ).toBe(404);
    });

    it('assigns one instance per kind, refuses cross-team and deletes only unassigned instances', async () => {
      const { gitlab, atlassian } = await setup();
      const assigned = await api('/installations/T0TEAM1/channels/C0GENERAL/tools/gitlab', 'PUT', {
        instanceId: gitlab.id,
      });
      expect(assigned.status).toBe(200);
      const view = (await assigned.json()) as {
        configVersion: number;
        tools: Array<{ kind: string; instanceId: string; ready: boolean; detail: string | null }>;
        compiled: { tools: Array<{ instanceId: string }> } | null;
      };
      expect(view.tools).toEqual([
        {
          kind: 'gitlab',
          instanceId: gitlab.id,
          label: 'GitLab (example)',
          ready: false,
          detail: 'waiting for runtime readiness',
        },
      ]);
      expect(view.compiled?.tools.map((row) => row.instanceId)).toEqual([gitlab.id]);
      const document = await currentDocument();
      expect(document.version).toBe(view.configVersion);
      const policy = parseAuthorizationPolicy(JSON.stringify(document.authorizationPolicy));
      expect(policy.bindings).toEqual([
        { workspace: 'T0TEAM1', channels: ['C0GENERAL'], users: ['*'], roles: ['user-gl'] },
      ]);

      // A second GitLab instance replaces the first (D3).
      const second = await api('/installations/T0TEAM1/tools', 'POST', {
        kind: 'gitlab',
        label: 'GitLab (other)',
        host: 'gitlab.other.example',
      });
      const secondId = ((await second.json()) as { instance: View }).instance.id;
      await api('/installations/T0TEAM1/channels/C0GENERAL/tools/gitlab', 'PUT', {
        instanceId: secondId,
      });
      expect(await store.listChannelTools('T0TEAM1', 'C0GENERAL')).toEqual([
        { teamId: 'T0TEAM1', channelId: 'C0GENERAL', kind: 'gitlab', instanceId: secondId },
      ]);
      // Kind mismatch, unknown channel, disabled instance.
      expect(
        (
          await api('/installations/T0TEAM1/channels/C0GENERAL/tools/datadog', 'PUT', {
            instanceId: atlassian.id,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await api('/installations/T0TEAM1/channels/C0NOPE/tools/gitlab', 'PUT', {
            instanceId: gitlab.id,
          })
        ).status,
      ).toBe(404);
      await api(`/installations/T0TEAM1/tools/${gitlab.id}`, 'PUT', { status: 'disabled' });
      expect(
        (
          await api('/installations/T0TEAM1/channels/C0GENERAL/tools/gitlab', 'PUT', {
            instanceId: gitlab.id,
          })
        ).status,
      ).toBe(409);
      // Another workspace's instance cannot be assigned or edited through this one.
      await store.recordSeen('T0OTHER');
      const foreign = (
        await store.createToolInstance('test', 'T0OTHER', {
          kind: 'files',
          label: 'Other',
        })
      ).instance;
      expect(
        (
          await api('/installations/T0TEAM1/channels/C0GENERAL/tools/files', 'PUT', {
            instanceId: foreign.id,
          })
        ).status,
      ).toBe(404);
      expect(
        (await api(`/installations/T0TEAM1/tools/${foreign.id}`, 'PUT', { label: 'x' })).status,
      ).toBe(404);
      expect(await store.listChannelTools('T0TEAM1', 'C0GENERAL')).toHaveLength(1);

      // Delete is refused while assigned, allowed after unassigning.
      const refused = await api(`/installations/T0TEAM1/tools/${secondId}`, 'DELETE');
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain('C0GENERAL');
      await api('/installations/T0TEAM1/channels/C0GENERAL/tools/gitlab', 'DELETE');
      expect((await api(`/installations/T0TEAM1/tools/${secondId}`, 'DELETE')).status).toBe(200);
      expect(await store.toolInstance(secondId)).toBeNull();

      expect((await api('/run-limits')).status).toBe(404);
      expect((await api('/run-limits', 'PUT', { runLimits: null })).status).toBe(404);
      expect(await store.currentDocument()).not.toHaveProperty('runLimits');

      // Removing the workspace removes its instances and assignments.
      await api('/installations/T0TEAM1', 'DELETE');
      expect(await store.listToolInstances('T0TEAM1')).toEqual([]);
      expect(await store.listChannelTools('T0TEAM1')).toEqual([]);
    });

    it('recompiles on readiness changes only and ignores stale or unknown reports', async () => {
      const { gitlab } = await setup();
      await api('/installations/T0TEAM1/channels/C0GENERAL/tools/gitlab', 'PUT', {
        instanceId: gitlab.id,
      });
      const before = await currentDocument();
      const ready = {
        reporter: 'cli-runtime',
        statuses: [
          { instanceId: gitlab.id, state: 'ready', toolsCount: null, credentialVersion: 1 },
          { instanceId: 'ti_00000000000000aa', state: 'ready', credentialVersion: 1 },
        ],
      };
      expect((await report(ready)).status).toBe(204);
      const readyDoc = await currentDocument();
      expect(readyDoc.version).toBe(before.version + 1);
      expect(readyDoc.toolAssignments[0]?.tools[0]).toMatchObject({ ready: true, detail: null });
      const statusRows = async () =>
        (await store.listAudit(100)).filter((row) => row.action === 'tool.status');
      expect(await statusRows()).toHaveLength(1);
      expect((await statusRows())[0]).toMatchObject({ actor: 'cli-runtime', target: gitlab.id });
      // A repeat refreshes the time only.
      expect((await report(ready)).status).toBe(204);
      expect((await currentDocument()).version).toBe(readyDoc.version);
      expect(await statusRows()).toHaveLength(1);
      // A stale probe (older credential version) is ignored.
      await report({
        reporter: 'cli-runtime',
        statuses: [{ instanceId: gitlab.id, state: 'error', detail: 'old', credentialVersion: 0 }],
      });
      expect((await currentDocument()).version).toBe(readyDoc.version);
      // An error recompiles, with a sanitized, bounded detail.
      await report({
        reporter: 'cli-runtime',
        statuses: [
          {
            instanceId: gitlab.id,
            state: 'error',
            detail: `token rejected\u0000\n(401) ${'x'.repeat(400)}`,
            credentialVersion: 1,
          },
        ],
      });
      const errorDoc = await currentDocument();
      expect(errorDoc.version).toBe(readyDoc.version + 1);
      const detail = errorDoc.toolAssignments[0]?.tools[0]?.detail ?? '';
      expect(detail.startsWith('token rejected (401) x')).toBe(true);
      expect(detail).toHaveLength(200);
      const tools = (await (await api('/installations/T0TEAM1/tools')).json()) as {
        instances: View[];
      };
      expect(tools.instances.find((row) => row.id === gitlab.id)?.readiness).toMatchObject({
        state: 'error',
        current: true,
      });
      expect(tools.instances.find((row) => row.id === gitlab.id)).toMatchObject({
        ready: false,
        detail: errorDoc.toolAssignments[0]?.tools[0]?.detail,
      });
      // A new credential drops readiness until the runtime probes it again.
      await api(`/installations/T0TEAM1/tools/${gitlab.id}`, 'PUT', {
        credential: 'glpat-secret-value-0003',
      });
      expect((await currentDocument()).toolAssignments[0]?.tools[0]).toMatchObject({
        ready: false,
        detail: 'waiting for runtime readiness',
        credentialVersion: 2,
      });
      expect(await store.toolStatus(gitlab.id)).toBeNull();
      // Bad reports are refused.
      expect((await report({ reporter: 'agent', statuses: [] })).status).toBe(400);
      expect(
        (
          await report({
            reporter: 'web-runtime',
            statuses: [{ instanceId: gitlab.id, state: 'fine', credentialVersion: 2 }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await report({
            reporter: 'web-runtime',
            statuses: Array.from({ length: 257 }, () => ready.statuses[0]),
          })
        ).status,
      ).toBe(400);
    });

    it('manages instances and channel tools through the UI without ever showing a credential', async () => {
      const { gitlab, atlassian } = await setup();
      await store.createAdmin('cli', 'alice', await hashPassword('correct horse battery'));
      const form = (path: string, body: Record<string, string>, cookie: string) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'x-forwarded-proto': 'https',
            'content-type': 'application/x-www-form-urlencoded',
            cookie,
          },
          body: new URLSearchParams(body).toString(),
        });
      const signedIn = await form(
        '/login',
        { name: 'alice', password: 'correct horse battery' },
        '',
      );
      const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] as string;
      const page = async (path: string): Promise<string> =>
        await (await call(path, { headers: { cookie } })).text();
      let tools = await page('/workspaces/T0TEAM1/tools');
      expectNoSecret(tools);
      expect(tools).toContain('GitLab (example)');
      expect(tools).toContain('Set (v1)');
      expect(tools).toContain('Waiting for runtime');
      expect(await page('/workspaces')).toContain('/workspaces/T0TEAM1/tools');
      expect(await page('/workspaces/T0TEAM1/channels')).toContain(
        '/workspaces/T0TEAM1/channels/C0GENERAL/tools',
      );
      const csrf = /name="csrf" value="([^"]+)"/.exec(tools)?.[1] ?? '';

      const created = await form(
        '/workspaces/T0TEAM1/tools',
        {
          csrf,
          kind: 'datadog',
          label: 'Datadog',
          host: 'datadoghq.eu',
          toolsets: 'all',
          denyTools: 'a_b, c_d',
          credential: 'dd-secret-token-0001',
        },
        cookie,
      );
      expect(created.status).toBe(303);
      const datadog = (await store.listToolInstances('T0TEAM1')).find(
        (row) => row.kind === 'datadog',
      );
      expect(datadog).toMatchObject({
        host: 'datadoghq.eu',
        settings: { toolsets: 'all', denyTools: ['a_b', 'c_d'] },
        hasCredential: true,
      });
      await form(
        '/workspaces/T0TEAM1/tools',
        {
          csrf,
          kind: 'cloudflare',
          label: 'Cloudflare',
          accountId: '',
          zones: 'shop.example.com\r\ncloud.example.com\r\n',
          credential: 'cf-secret-token-0001',
        },
        cookie,
      );
      expect(
        (await store.listToolInstances('T0TEAM1')).find((row) => row.kind === 'cloudflare'),
      ).toMatchObject({
        host: 'api.cloudflare.com',
        settings: { accountId: null, zones: ['cloud.example.com', 'shop.example.com'] },
        hasCredential: true,
      });
      expect(await page('/workspaces/T0TEAM1/tools')).not.toContain('cf-secret-token-0001');
      // A validation error comes back as a notice, not a stored instance.
      await form(
        '/workspaces/T0TEAM1/tools',
        { csrf, kind: 'gitlab', label: 'Bad', host: 'not a host' },
        cookie,
      );
      tools = await page('/workspaces/T0TEAM1/tools');
      expect(tools).toContain('host must be');
      expect(tools).not.toContain('dd-secret-token-0001');
      // Edit without a credential keeps it.
      await form(
        `/workspaces/T0TEAM1/tools/${gitlab.id}`,
        { csrf, label: 'GitLab (renamed)', host: 'gitlab.example.com', credential: '' },
        cookie,
      );
      expect(await store.toolInstance(gitlab.id)).toMatchObject({
        label: 'GitLab (renamed)',
        credentialVersion: 1,
      });
      const rotated = await form(
        `/workspaces/T0TEAM1/tools/${atlassian.id}`,
        {
          csrf,
          label: 'Jira (example)',
          host: 'example.atlassian.net',
          cloudId: CLOUD_ID,
          email: 'owner@example.com',
          ...Object.fromEntries(ATLASSIAN_READ_OPERATIONS.map((name) => [`op_${name}`, 'on'])),
          credentialJira: 'jira-secret-token-0002',
          credentialConfluence: '',
        },
        cookie,
      );
      expect(rotated.status).toBe(303);
      expect(JSON.parse((await store.toolSecret(atlassian.id))?.credential ?? '{}')).toEqual({
        jira: 'jira-secret-token-0002',
        confluence: CONFLUENCE_SECRET,
      });
      expect(await store.toolInstance(atlassian.id)).toMatchObject({ credentialVersion: 2 });

      const assign = await form(
        '/workspaces/T0TEAM1/channels/C0GENERAL/tools',
        { csrf, kind_gitlab: gitlab.id, kind_datadog: datadog?.id ?? '', kind_files: 'none' },
        cookie,
      );
      expect(assign.status).toBe(303);
      expect((await store.listChannelTools('T0TEAM1', 'C0GENERAL')).map((row) => row.kind)).toEqual(
        ['datadog', 'gitlab'],
      );
      const configPage = await page('/config');
      expect(configPage).toContain('Configuration in force');
      expect(configPage).not.toContain('Run limits');
      expect(configPage).not.toContain('runLimits');
      expect((await form('/config/run-limits', { csrf, maxToolCalls: '9' }, cookie)).status).toBe(
        404,
      );
      await form('/workspaces/T0TEAM1/tools/model', { csrf, key: 'opus' }, cookie);
      expect(await store.modelAssignment('T0TEAM1', null)).toBe('opus');
      expect(await page('/workspaces/T0TEAM1/tools')).toContain('Runs use opus');
      await form(
        '/workspaces/T0TEAM1/channels/C0GENERAL/model',
        {
          csrf,
          fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
          key: 'sonnet',
        },
        cookie,
      );
      expect(await store.modelAssignment('T0TEAM1', 'C0GENERAL')).toBe('sonnet');
      // An unknown key comes back as a notice.
      await form(
        '/workspaces/T0TEAM1/channels/C0GENERAL/model',
        {
          csrf,
          fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
          key: 'gpt',
        },
        cookie,
      );
      const channelPage = await page('/workspaces/T0TEAM1/channels/C0GENERAL/tools');
      expect(channelPage).toContain('unknown model gpt');
      expect(channelPage).toContain('Inherit (workspace default: opus)');
      expect(channelPage).toContain('rotates the native session');
      expect(channelPage).toContain('&quot;modelKey&quot;: &quot;sonnet&quot;');
      expect(channelPage).not.toContain('maxToolCalls');
      expect(channelPage).toContain('GitLab (renamed)');
      expectNoSecret(channelPage);
      expect(channelPage).toContain('No channel prompt');

      // Prompts: the workspace default, a channel override (CRLF from the
      // browser is normalized), an over-long body as a notice, a clear.
      await form('/workspaces/T0TEAM1/tools/prompt', { csrf, text: 'Answer in <German>.' }, cookie);
      expect(await store.promptAssignment('T0TEAM1', null)).toBe('Answer in <German>.');
      expect(await page('/workspaces/T0TEAM1/tools')).toContain('Answer in &lt;German&gt;.');
      let promptPage = await page('/workspaces/T0TEAM1/channels/C0GENERAL/tools');
      expect(promptPage).toContain('from the workspace');
      expect(promptPage).toContain('<pre>Answer in &lt;German&gt;.</pre>');
      await form(
        '/workspaces/T0TEAM1/channels/C0GENERAL/prompt',
        {
          csrf,
          fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
          text: 'Line one\r\nLine two',
        },
        cookie,
      );
      expect(await store.promptAssignment('T0TEAM1', 'C0GENERAL')).toBe('Line one\nLine two');
      await form(
        '/workspaces/T0TEAM1/channels/C0GENERAL/prompt',
        {
          csrf,
          fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
          text: 'x'.repeat(4001),
        },
        cookie,
      );
      promptPage = await page('/workspaces/T0TEAM1/channels/C0GENERAL/tools');
      expect(promptPage).toContain('at most 4000 characters');
      expect(promptPage).toContain('from the channel');
      expect(promptPage).toContain('&quot;systemPrompt&quot;: &quot;Line one\\nLine two&quot;');
      expect(promptPage).toContain('Clear (inherit)');
      await form(
        '/workspaces/T0TEAM1/channels/C0GENERAL/prompt',
        {
          csrf,
          fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
          reset: 'true',
        },
        cookie,
      );
      expect(await store.promptAssignment('T0TEAM1', 'C0GENERAL')).toBeNull();
      // Delete is refused while assigned.
      await form(`/workspaces/T0TEAM1/tools/${gitlab.id}/delete`, { csrf }, cookie);
      expect(await store.toolInstance(gitlab.id)).not.toBeNull();
      expect(await page('/workspaces/T0TEAM1/tools')).toContain('unassign it first');
    });
  });

  describe('channel model', () => {
    type ModelBody = {
      model: {
        effective: string | null;
        source: string;
        channel: string | null;
        workspace: string | null;
        available: boolean;
      };
      compiled: { modelKey: string | null } | null;
      configVersion?: number;
    };
    const channelModel = async (key: unknown): Promise<Response> =>
      await api('/installations/T0TEAM1/channels/C0GENERAL/model', 'PUT', {
        key,
        fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
      });
    const view = async (): Promise<ModelBody> =>
      (await (await api('/installations/T0TEAM1/channels/C0GENERAL/tools')).json()) as ModelBody;

    beforeEach(async () => {
      await pair();
      await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
      await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
    });

    it('resolves channel → workspace → deployment default, audited, and recompiles', async () => {
      expect((await view()).model).toMatchObject({
        effective: 'sonnet',
        source: 'deployment',
        channel: null,
        workspace: null,
        available: true,
      });
      expect((await view()).compiled?.modelKey).toBeNull();

      const workspace = await api('/installations/T0TEAM1/model', 'PUT', { key: 'opus' });
      expect(workspace.status).toBe(200);
      expect(await workspace.json()).toMatchObject({ effective: 'opus', source: 'workspace' });
      expect((await view()).compiled?.modelKey).toBe('opus');

      const set = await channelModel('sonnet');
      expect(set.status).toBe(200);
      const body = (await set.json()) as ModelBody;
      expect(body.model).toMatchObject({ effective: 'sonnet', source: 'channel' });
      expect(body.compiled?.modelKey).toBe('sonnet');
      const config = (await (await internalConfig()).json()) as CompiledDocument;
      expect(config.version).toBe(body.configVersion);
      expect(config.toolAssignments[0]?.modelKey).toBe('sonnet');

      // Clearing inherits again; the same value twice keeps the version.
      const cleared = (await (await channelModel(null)).json()) as ModelBody;
      expect(cleared.model).toMatchObject({ effective: 'opus', source: 'workspace' });
      const again = (await (await channelModel(null)).json()) as ModelBody;
      expect(again.configVersion).toBe(cleared.configVersion);
      await api('/installations/T0TEAM1/model', 'PUT', { key: null });
      expect((await view()).compiled?.modelKey).toBeNull();

      const actions = (await store.listAudit(20)).map((row) => [
        row.action,
        row.target,
        row.detail,
      ]);
      expect(actions).toContainEqual(['workspace.model', 'T0TEAM1', { key: 'opus' }]);
      expect(actions).toContainEqual(['channel.model', 'T0TEAM1/C0GENERAL', { key: 'sonnet' }]);
      expect(actions).toContainEqual(['channel.model', 'T0TEAM1/C0GENERAL', { key: null }]);
    });

    it('refuses keys outside the allowlist, "default", malformed bodies and unknown channels', async () => {
      for (const key of ['gpt', 'default', 'Opus', 7]) {
        expect((await channelModel(key)).status).toBe(400);
      }
      expect((await api('/installations/T0TEAM1/channels/C0GENERAL/model', 'PUT', {})).status).toBe(
        400,
      );
      expect(
        (await api('/installations/T0TEAM1/channels/C0NOPE/model', 'PUT', { key: 'opus' })).status,
      ).toBe(404);
      expect(await store.listModelAssignments()).toEqual([]);
    });

    it('keeps a stored key after the operator removes it from the allowlist and flags it (D3)', async () => {
      await channelModel('opus');
      // Simulates a restart with MODEL_CATALOG with sonnet only.
      const trimmed = await listen(
        createApp({
          config: {
            publicUrl: 'https://admin.example.test',
            internalToken: INTERNAL,
            storeKey: Buffer.alloc(32, 1),
            sessionKey: Buffer.alloc(32, 2),
            slackClientId: 'client-id',
            slackClientSecret: 'client-secret',
            slackApiUrl: slack.url,
            egressProxyUrl: undefined,
            port: 0,
            host: '127.0.0.1',
            database: { path: ':memory:' },
            models: { keys: ['sonnet'], defaultKey: 'sonnet' },
            studioUrl: null,
            costRetentionDays: 400,
          },
          store,
          slack: new SlackApi({ apiUrl: slack.url }),
          log: () => undefined,
        }),
      );
      try {
        const response = await fetch(
          `${trimmed.url}/api/installations/T0TEAM1/channels/C0GENERAL/tools`,
          { headers: { 'x-forwarded-proto': 'https', authorization: `Bearer ${apiToken}` } },
        );
        const body = (await response.json()) as ModelBody;
        expect(body.model).toMatchObject({
          effective: 'opus',
          source: 'channel',
          available: false,
        });
        expect(body.compiled?.modelKey).toBe('opus');
      } finally {
        await new Promise<void>((resolve) => trimmed.server.close(() => resolve()));
      }
    });

    it('removes model choices with the workspace', async () => {
      await api('/installations/T0TEAM1/model', 'PUT', { key: 'opus' });
      await channelModel('sonnet');
      await api('/installations/T0TEAM1', 'DELETE');
      expect(await store.listModelAssignments()).toEqual([]);
    });
  });

  describe('channel prompt', () => {
    type PromptBody = {
      effective: string | null;
      source: string;
      channel: string | null;
      workspace: string | null;
      chars: number;
      maxChars: number;
      configVersion?: number;
    };
    type ChannelBody = {
      prompt: PromptBody;
      compiled: { systemPrompt: string | null } | null;
    };
    const channelPrompt = async (text: unknown): Promise<Response> =>
      await api('/installations/T0TEAM1/channels/C0GENERAL/prompt', 'PUT', {
        text,
        fingerprint: (await store.channelSettings('T0TEAM1', 'C0GENERAL')).fingerprint,
      });
    const view = async (): Promise<ChannelBody> =>
      (await (await api('/installations/T0TEAM1/channels/C0GENERAL/tools')).json()) as ChannelBody;

    beforeEach(async () => {
      await pair();
      await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
      await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
    });

    it('resolves channel → workspace → none, audited, and recompiles', async () => {
      expect((await view()).prompt).toMatchObject({
        effective: null,
        source: 'none',
        channel: null,
        workspace: null,
        chars: 0,
        maxChars: 4000,
      });
      expect((await view()).compiled?.systemPrompt).toBeNull();

      const workspace = await api('/installations/T0TEAM1/prompt', 'PUT', {
        text: ' Answer in German. ',
      });
      expect(workspace.status).toBe(200);
      expect(await workspace.json()).toMatchObject({
        effective: 'Answer in German.',
        source: 'workspace',
        chars: 17,
      });
      expect(await (await api('/installations/T0TEAM1/prompt')).json()).toMatchObject({
        workspace: 'Answer in German.',
      });
      expect((await view()).compiled?.systemPrompt).toBe('Answer in German.');

      const set = await channelPrompt('Answer in French.');
      expect(set.status).toBe(200);
      const body = (await set.json()) as PromptBody;
      expect(body).toMatchObject({
        effective: 'Answer in French.',
        source: 'channel',
        workspace: 'Answer in German.',
      });
      const config = (await (await internalConfig()).json()) as CompiledDocument;
      expect(config.version).toBe(body.configVersion);
      expect(config.toolAssignments[0]?.systemPrompt).toBe('Answer in French.');

      // Whitespace clears and inherits again; the same value twice keeps the version.
      const cleared = (await (await channelPrompt('   ')).json()) as PromptBody;
      expect(cleared).toMatchObject({ effective: 'Answer in German.', source: 'workspace' });
      const again = (await (await channelPrompt(null)).json()) as PromptBody;
      expect(again.configVersion).toBe(cleared.configVersion);
      await api('/installations/T0TEAM1/prompt', 'PUT', { text: null });
      expect((await view()).compiled?.systemPrompt).toBeNull();

      const actions = (await store.listAudit(20)).map((row) => [
        row.action,
        row.target,
        row.detail,
      ]);
      expect(actions).toContainEqual([
        'workspace.prompt',
        'T0TEAM1',
        {
          chars: 17,
          sha256: createHash('sha256').update('Answer in German.').digest('hex'),
          text: 'Answer in German.',
        },
      ]);
      expect(actions).toContainEqual([
        'channel.prompt',
        'T0TEAM1/C0GENERAL',
        {
          chars: 17,
          sha256: createHash('sha256').update('Answer in French.').digest('hex'),
          text: 'Answer in French.',
        },
      ]);
      expect(actions).toContainEqual([
        'channel.prompt',
        'T0TEAM1/C0GENERAL',
        { chars: 0, sha256: null, text: null },
      ]);
    });

    it('refuses over-long, control-character and malformed bodies and unknown channels', async () => {
      expect((await channelPrompt('x'.repeat(4000))).status).toBe(200);
      for (const text of ['x'.repeat(4001), 'bell\u0007', 7]) {
        expect((await channelPrompt(text)).status).toBe(400);
      }
      expect(
        (await api('/installations/T0TEAM1/channels/C0GENERAL/prompt', 'PUT', {})).status,
      ).toBe(400);
      expect(
        (await api('/installations/T0TEAM1/channels/C0NOPE/prompt', 'PUT', { text: 'x' })).status,
      ).toBe(404);
      expect(await store.promptAssignment('T0TEAM1', 'C0GENERAL')).toBe('x'.repeat(4000));
    });

    it('refuses a prompt for an unregistered channel with 409 in the store', async () => {
      let status: number | undefined;
      try {
        await store.setChannelSettings('admin', 'T0TEAM1', 'C0UNKNOWN', '', { prompt: 'x' }, [
          'sonnet',
        ]);
      } catch (err) {
        status = (err as { status?: number }).status;
      }
      expect(status).toBe(409);
      expect(await store.listPromptAssignments()).toEqual([]);
    });

    it('removes prompts with the workspace', async () => {
      await api('/installations/T0TEAM1/prompt', 'PUT', { text: 'Workspace.' });
      await channelPrompt('Channel.');
      await api('/installations/T0TEAM1', 'DELETE');
      expect(await store.listPromptAssignments()).toEqual([]);
    });
  });

  describe('costs tab', () => {
    const postCosts = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${base}/internal/costs`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${INTERNAL}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    let rowSeq = 0;
    const requestRow = (overrides: Record<string, unknown> = {}) => {
      rowSeq += 1;
      return {
        id: `00000000-0000-4000-8000-${String(rowSeq).padStart(12, '0')}`,
        instance: 'test',
        completedAt: Date.now(),
        teamId: 'T0TEAM1',
        channelId: 'C0GENERAL',
        rootTs: '1716234567.111111',
        runId: 'run-1-abc',
        runSeq: 1,
        attempt: 1,
        mode: 'answer',
        requesterUserId: 'U0ALICE',
        model: 'claude-5.5-sonnet',
        route: 'anthropic',
        connection: 'anthropic',
        status: 200,
        durationMs: 800,
        outcome: 'completed',
        inputTokens: 1200,
        outputTokens: 40,
        ...overrides,
      };
    };
    const runRow = {
      runId: 'run-1-abc',
      attempt: 1,
      instance: 'test',
      completedAt: Date.now(),
      teamId: 'T0TEAM1',
      channelId: 'C0GENERAL',
      rootTs: '1716234567.111111',
      mode: 'answer',
      model: 'claude-5.5-sonnet',
      requesterUserId: 'U0ALICE',
      inputTokens: 1200,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimateUsd: 0.0042,
      costBasis: 'sdk',
      outcome: 'completed',
    };
    const signIn = async (): Promise<string> => {
      await store.createAdmin('cli', 'alice', await hashPassword('correct horse battery'));
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'x-forwarded-proto': 'https',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ name: 'alice', password: 'correct horse battery' }).toString(),
      });
      return (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    };

    it('takes ledger rows from the runner with the internal token only, once', async () => {
      const batch = { requests: [requestRow(), requestRow()], runs: [runRow] };
      expect((await postCosts(batch, { authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await postCosts(batch, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(404);
      const stored = await postCosts(batch);
      expect(stored.status).toBe(200);
      expect(await stored.json()).toEqual({ stored: { requests: 2, runs: 1 } });
      // A retried post counts nothing twice.
      expect(await (await postCosts(batch)).json()).toEqual({ stored: { requests: 0, runs: 0 } });
      // Ledger writes are telemetry, not audited configuration.
      expect((await store.listAudit(50)).some((entry) => entry.action.startsWith('cost'))).toBe(
        false,
      );
    });

    it('counts the inference requests of one run for the internal token only', async () => {
      const count = (runId: string, token = INTERNAL): Promise<Response> =>
        fetch(`${base}/internal/costs/requests?runId=${encodeURIComponent(runId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      await postCosts({
        requests: [
          requestRow({ runId: 'run-count-1' }),
          requestRow({ runId: 'run-count-1' }),
          requestRow({
            runId: 'run-count-1',
            route: 'vertex-claude',
            connection: 'vertex:fixture:global:account',
          }),
          requestRow({ runId: 'run-count-2' }),
        ],
      });
      expect(await (await count('run-count-1')).json()).toEqual({
        runId: 'run-count-1',
        requests: 3,
        inference: [
          { route: 'anthropic', connection: 'anthropic', model: 'claude-5.5-sonnet', requests: 2 },
          {
            route: 'vertex-claude',
            connection: 'vertex:fixture:global:account',
            model: 'claude-5.5-sonnet',
            requests: 1,
          },
        ],
      });
      expect(await (await count('run-unknown')).json()).toEqual({
        runId: 'run-unknown',
        requests: 0,
        inference: [],
      });
      expect((await count('run-count-1', 'wrong')).status).toBe(401);
      expect((await count('not a run')).status).toBe(400);
    });

    it('refuses invalid batches field by field and bodies above 256 KiB', async () => {
      const refused = [
        { requests: [requestRow({ channelId: '#general' })] },
        { requests: [requestRow({ prompt: 'what did the customer say' })] },
        { requests: [requestRow({ model: 'two words' })] },
        { runs: [{ ...runRow, outcome: 'great' }] },
        { requests: Array.from({ length: 201 }, () => requestRow()) },
        { rows: [] },
      ];
      for (const body of refused) {
        const response = await postCosts(body);
        expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/must be|not a field/);
      }
      expect((await store.costLedgerStatus()).requestRows).toBe(0);
      // Two full batches (above the 64 KiB form limit) fit; more than 256 KiB does not.
      const full = {
        requests: Array.from({ length: 200 }, () => requestRow()),
        runs: Array.from({ length: 200 }, (_value, index) => ({ ...runRow, attempt: index + 1 })),
      };
      expect(JSON.stringify(full).length).toBeGreaterThan(64 * 1024);
      expect((await postCosts(full)).status).toBe(200);
      const huge = JSON.stringify({ requests: [], pad: 'x'.repeat(300 * 1024) });
      expect((await postCosts(huge)).status).toBe(413);
      // Other internal routes keep the small limit.
      const big = await fetch(`${base}/internal/installations/seen`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: 'T0TEAM1', pad: 'x'.repeat(100 * 1024) }),
      });
      expect(big.status).toBe(413);
    });

    it('serves /api/costs to an API token or a session, never anonymously', async () => {
      await postCosts({
        requests: [requestRow({ outcome: 'interrupted' }), requestRow()],
        runs: [runRow],
      });
      expect((await call('/api/costs')).status).toBe(401);
      expect((await call('/api/costs', { headers: { authorization: 'Bearer nope' } })).status).toBe(
        401,
      );
      const response = await api('/costs?group=channel');
      expect(response.status).toBe(200);
      const view = (await response.json()) as {
        from: string;
        to: string;
        group: string;
        totals: Record<string, unknown>;
        rows: Array<Record<string, unknown>>;
        ledger: Record<string, unknown>;
        days?: unknown;
      };
      expect(view.group).toBe('channel');
      expect(view.days).toBeUndefined();
      expect(view.rows).toHaveLength(1);
      expect(view.rows[0]).toMatchObject({
        key: { teamId: 'T0TEAM1', channelId: 'C0GENERAL' },
        requests: 2,
        runs: 1,
        completedRequests: 1,
        interruptedRequests: 1,
        billedUsd: null,
        estimateUsd: 0.0042,
      });
      expect(view.ledger).toMatchObject({
        requestRows: 2,
        runRows: 1,
        instances: ['test'],
        retentionDays: 400,
      });
      const days = (await (await api('/costs')).json()) as { group: string; rows: unknown[] };
      expect(days.group).toBe('day');
      expect(days.rows).toHaveLength(1);
      expect((await api('/costs?group=everything')).status).toBe(400);
      expect((await api('/costs?from=2026-10-15&to=2026-10-01')).status).toBe(400);
      expect((await api('/costs', 'POST', {})).status).toBe(405);
      const cookie = await signIn();
      expect((await call('/api/costs', { headers: { cookie } })).status).toBe(200);
    });

    it('renders /costs for a session and exports CSV', async () => {
      await postCosts({ requests: [requestRow()], runs: [runRow] });
      expect((await call('/costs')).headers.get('location')).toBe('/login');
      expect((await call('/costs.csv')).status).toBe(401);
      const cookie = await signIn();
      const page = await call('/costs?group=requester', { headers: { cookie } });
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).toContain('<h1>Costs</h1>');
      expect(body).toMatch(/<a\s+href="\/costs"\s+aria-current="page"/);
      expect(body).toContain('U0ALICE');
      // the only script is the shared live client (new-data notice).
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(body).toContain('data-live-topics="costs"');
      expect(body).not.toMatch(/<script>/);
      const csv = await call('/costs.csv?group=day', { headers: { cookie } });
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(csv.headers.get('content-disposition')).toMatch(
        /^attachment; filename="costs-day-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      const lines = (await csv.text()).trimEnd().split('\r\n');
      expect(lines[0]?.startsWith('day,label,requests,')).toBe(true);
      expect(lines).toHaveLength(2);
      const byToken = await call('/costs.csv', {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect(byToken.status).toBe(200);
      expect((await call('/costs?from=nope', { headers: { cookie } })).status).toBe(400);
    });
  });

  describe('Slack rate limits', () => {
    let cookie: string;
    let csrf: string;

    beforeEach(async () => {
      await store.createAdmin('cli', 'alice', await hashPassword('correct horse battery'));
      await pair();
      await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
      await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'x-forwarded-proto': 'https',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ name: 'alice', password: 'correct horse battery' }).toString(),
      });
      cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
      const page = await (await call('/workspaces', { headers: { cookie } })).text();
      csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
      slack.calls.length = 0;
    });

    const page = async (path: string): Promise<string> =>
      await (await call(path, { headers: { cookie } })).text();
    const post = (path: string, body: Record<string, string>): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'x-forwarded-proto': 'https',
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
        body: new URLSearchParams({ ...body, csrf }).toString(),
      });
    const people = '/workspaces/T0TEAM1/channels/C0GENERAL/blocked-members';

    it('enables a channel with one conversations.info call and never lists every channel', async () => {
      expect(slack.calls).toEqual([]);
      const refused = await api('/installations/T0TEAM1/channels/C0OTHER', 'PUT', {
        enabled: true,
      });
      expect(refused.status).toBe(409);
      expect(slack.calls).toEqual(['conversations.info']);
      await page('/workspaces/T0TEAM1/channels');
      await page('/workspaces/T0TEAM1/channels');
      expect(slack.calls).toEqual(['conversations.info', 'users.conversations']);
      expect(slack.calls).not.toContain('conversations.list');
    });

    it('lists users once per TTL, refreshes on request and resolves saves from the cache', async () => {
      expect(await page(people)).toContain('Alice (U0ALICE)');
      await page(people);
      expect(slack.calls).toEqual(['users.list']);
      const saved = await post(people, { userId: 'U0ALICE' });
      expect(saved.status).toBe(303);
      expect(slack.calls).toEqual(['users.list']);
      expect((await store.listBlockedMembers('T0TEAM1', 'C0GENERAL'))[0]?.displayName).toBe(
        'Alice',
      );
      await page(`${people}?refresh=1`);
      expect(slack.calls).toEqual(['users.list', 'users.list']);
    });

    it('adds and removes people without a role', async () => {
      const empty = await page(people);
      expect(empty).toContain('Nobody is blocked.');
      expect(empty.replace(/\s+/g, ' ')).toContain(
        'All unblocked channel members, including guests and external participants, can use commands',
      );
      expect(empty).not.toMatch(/approver|name="role"|<th>Role<\/th>/i);
      expect((await post(people, { userId: 'U0ALICE' })).status).toBe(303);
      const added = await page(people);
      expect(added).toContain('Blocked (config v');
      expect(added).toContain('1 blocked. All other channel members have access.');
      expect(added).toContain(`action="${people}/U0ALICE/unblock"`);
      expect((await post(`${people}/U0ALICE/unblock`, {})).status).toBe(303);
      expect(await page(people)).toContain('Unblocked (config v');
      expect(await store.listBlockedMembers('T0TEAM1', 'C0GENERAL')).toEqual([]);
      expect((await store.listAudit(5)).map((entry) => entry.action).slice(0, 2)).toEqual([
        'channel.member.unblock',
        'channel.member.block',
      ]);
      for (const retired of ['members', 'people'])
        expect(
          (await call(people.replace(/blocked-members$/, retired), { headers: { cookie } })).status,
        ).toBe(404);
    });

    it('looks up a single user without a listing and refuses unknown or deleted ones', async () => {
      expect((await post(people, { userId: 'U0BOB' })).status).toBe(303);
      expect(slack.calls).toEqual(['users.info']);
      expect((await store.listBlockedMembers('T0TEAM1', 'C0GENERAL'))[0]).toEqual({
        teamId: 'T0TEAM1',
        channelId: 'C0GENERAL',
        userId: 'U0BOB',
        displayName: 'Bob',
      });
      // An unavailable Slack still adds the person, without a name.
      slack.rateLimits.set('users.info', { remaining: 1, retryAfter: '60' });
      expect((await post(people, { userId: 'U0ALICE' })).status).toBe(303);
      expect(
        (await store.listBlockedMembers('T0TEAM1', 'C0GENERAL')).find(
          (row) => row.userId === 'U0ALICE',
        ),
      ).toMatchObject({ displayName: '' });
      for (const userId of ['U0NOBODY', 'U0GONE']) {
        await post(people, { userId });
        expect(
          (await store.listBlockedMembers('T0TEAM1', 'C0GENERAL')).some(
            (row) => row.userId === userId,
          ),
        ).toBe(true);
      }
      expect(
        (await store.listBlockedMembers('T0TEAM1', 'C0GENERAL')).map((row) => row.userId).sort(),
      ).toEqual(['U0ALICE', 'U0BOB', 'U0GONE', 'U0NOBODY']);
    });

    it('waits out a short Retry-After and keeps the last listing when Slack stays limited', async () => {
      slack.rateLimits.set('users.list', { remaining: 1, retryAfter: '0' });
      expect(await page(people)).toContain('Alice (U0ALICE)');
      expect(slack.calls).toEqual(['users.list', 'users.list']);

      // Too long to wait for: the refresh fails at once and the cached list stays.
      slack.rateLimits.set('users.list', { remaining: 1, retryAfter: '60' });
      const stale = await page(`${people}?refresh=1`);
      expect(stale).toContain('Slack did not list the workspace&#39;s people (ratelimited)');
      expect(stale).toContain('Showing the list from');
      expect(stale).toContain('Alice (U0ALICE)');
      expect(slack.calls).toEqual(['users.list', 'users.list', 'users.list']);

      // Without any listing, the ID field remains.
      slack.rateLimits.set('users.conversations', { remaining: 3, retryAfter: '0' });
      const channels = await page('/workspaces/T0TEAM1/channels');
      expect(channels).toContain('Slack did not list the channels (ratelimited)');
      expect(channels).toContain('Only channels saved earlier are shown.');
      expect(channels).toContain('#general');
    });
  });

  describe('overview and app shell', () => {
    const signIn = async (): Promise<{ cookie: string; location: string | null }> => {
      await store.createAdmin('cli', 'alice', await hashPassword('correct horse battery'));
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'x-forwarded-proto': 'https',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ name: 'alice', password: 'correct horse battery' }).toString(),
      });
      return {
        cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] as string,
        location: login.headers.get('location'),
      };
    };

    it('serves the page enhancements as a script file without a session', async () => {
      const script = await call('/assets/admin.js');
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      const body = await script.text();
      // It parses, and it reads the palette from the session-only endpoint.
      expect(() => new Function(body)).not.toThrow();
      expect(body).toContain("'/palette.json'");
      expect((await call('/palette.json')).headers.get('location')).toBe('/login');
    });

    it('lands on the Overview after sign-in and lists what needs attention', async () => {
      await pair();
      const { cookie, location } = await signIn();
      expect(location).toBe('/');
      const pending = await (await call('/', { headers: { cookie } })).text();
      expect(pending).toContain('<h1>Overview</h1>');
      expect(pending).toMatch(/<a\s+href="\/"\s+aria-current="page"/);
      expect(pending).toContain('<script src="/assets/admin.js"></script>');
      expect(pending).not.toMatch(/<script>/);
      expect(pending).toContain('Team &lt;One&gt; is pending');
      expect(pending).not.toContain('Team <One>');
      // Every page has the workspace switcher.
      const workspaces = await (await call('/workspaces', { headers: { cookie } })).text();
      expect(workspaces).toContain('href="/workspaces/T0TEAM1/channels"');

      await api('/installations/T0TEAM1', 'PATCH', { status: 'whitelisted' });
      await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
      const live = await (await call('/', { headers: { cookie } })).text();
      expect(live).not.toContain('is pending');
      expect(live).toContain('Nothing needs attention.');
      expect(live.replace(/\s+/g, ' ')).toContain('1<small> / 1</small>');
      expect(live).toMatch(/in 1 whitelisted workspace\s*</);
    });

    it('gives the command palette every workspace and channel page', async () => {
      await pair();
      await api('/installations/T0TEAM1/channels/C0GENERAL', 'PUT', { enabled: true });
      const { cookie } = await signIn();
      const palette = await call('/palette.json', { headers: { cookie } });
      expect(palette.status).toBe(200);
      const { items } = (await palette.json()) as {
        items: Array<{ group: string; label: string; sub: string; href: string }>;
      };
      expect(items).toContainEqual({ group: 'Pages', label: 'Costs', sub: '', href: '/costs' });
      expect(items).toContainEqual({
        group: 'Workspaces',
        label: 'Team <One>',
        sub: 'Tools, model and prompt',
        href: '/workspaces/T0TEAM1/tools',
      });
      expect(items).toContainEqual({
        group: 'Channels',
        label: '#general',
        sub: 'Team <One>',
        href: '/workspaces/T0TEAM1/channels/C0GENERAL/blocked-members',
      });
      expect(items.every((item) => item.href.startsWith('/'))).toBe(true);
    });
  });
});
