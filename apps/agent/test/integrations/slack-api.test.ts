/**
 * Slack user lookup adapter and provider: argument validation (mentions,
 * e-mails), the pinned transport (three methods, GET, bearer, no
 * redirects), scope readiness from x-oauth-scopes, error classes, the
 * response bound and e-mail masking. No network: an injected fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  SLACK_ENDPOINT,
  SLACK_RESPONSE_MAX_BYTES,
  SlackRequestError,
  classifySlackError,
  normalizeSlackUserId,
  sendSlackRequest,
  slackArgumentFingerprint,
  slackArgumentProblem,
  slackCredentialFingerprint,
  validateSlackRequest,
} from '../../src/integrations/slack/slack-api-adapter.js';
import { SlackApiProvider } from '../../src/integrations/slack/slack-api-provider.js';
import { BOT_TOKEN, BOT_USER, FIXTURE_USER, SLACK_TEAM, fakeSlack } from './helpers/slack-api.js';

const BOUNDS = { timeoutMs: 10_000, maxOutputBytes: 50_000 };

async function readyProvider(
  options: Parameters<typeof fakeSlack>[0] = {},
): Promise<{ provider: SlackApiProvider; api: ReturnType<typeof fakeSlack> }> {
  const api = fakeSlack(options);
  const provider = new SlackApiProvider({ teamId: SLACK_TEAM, token: BOT_TOKEN }, api.fetchImpl);
  await provider.refresh();
  return { provider, api };
}

describe('Slack argument validation', () => {
  it('accepts user IDs and strips mention wrappers', () => {
    expect(normalizeSlackUserId('U0123456789')).toBe('U0123456789');
    expect(normalizeSlackUserId(' <@U0123456789> ')).toBe('U0123456789');
    expect(normalizeSlackUserId('<@W0123ABC|sam>')).toBe('W0123ABC');
    for (const bad of ['u0123456789', 'C0123', '<#C0123>', '<@U01|x', '', 'U', 'U0 1', 42])
      expect(() => normalizeSlackUserId(bad)).toThrow(SlackRequestError);
  });

  it('validates each operation with its own argument only', () => {
    expect(validateSlackRequest('getUser', { user: '<@U0123456789>' })).toEqual({
      user: 'U0123456789',
    });
    expect(validateSlackRequest('lookupByEmail', { email: ' a@example.com ' })).toEqual({
      email: 'a@example.com',
    });
    expect(() => validateSlackRequest('getUser', { user: 'U1', limit: 10 })).toThrow(
      /unknown argument limit/,
    );
    expect(() => validateSlackRequest('lookupByEmail', { email: 'not-an-email' })).toThrow(
      /e-mail address/,
    );
    expect(() =>
      validateSlackRequest('lookupByEmail', { email: `${'a'.repeat(120)}@${'b'.repeat(140)}.com` }),
    ).toThrow(/e-mail address/);
    expect(slackArgumentProblem('slack_get_user', { user: 'U1' })).toBeNull();
    expect(slackArgumentProblem('slack_get_user', { user: 'U1', cursor: 'x' })).toMatch(
      /unknown argument cursor/,
    );
    expect(slackArgumentProblem('slack_list_users', {})).toMatch(/unknown Slack tool/);
  });

  it('fingerprints arguments per run without revealing them', () => {
    const a = slackArgumentFingerprint('run-1', { email: 'A@example.com' });
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(a).toBe(slackArgumentFingerprint('run-1', { email: 'a@example.com' }));
    expect(a).not.toBe(slackArgumentFingerprint('run-2', { email: 'a@example.com' }));
  });
});

describe('Slack transport', () => {
  it('sends GET to the pinned origin with the bearer token and refuses redirects', async () => {
    const api = fakeSlack();
    const result = await sendSlackRequest(
      'users.info',
      { verb: 'GET', params: { user: 'U0123456789' } },
      BOT_TOKEN,
      { timeoutMs: 5_000, fetchImpl: api.fetchImpl },
    );
    expect(result.errorCategory).toBeUndefined();
    expect(result.scopes).toEqual(['chat:write', 'users:read', 'users:read.email']);
    expect(api.seen).toEqual([
      {
        method: 'GET',
        url: new URL(`${SLACK_ENDPOINT}/users.info?user=U0123456789`),
        authorization: `Bearer ${BOT_TOKEN}`,
        redirect: 'manual',
      },
    ]);
    await expect(
      sendSlackRequest('users.list' as never, { verb: 'GET', params: {} }, BOT_TOKEN, {
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/pinned read-only API surface/);
  });

  it('classifies Slack errors and HTTP failures into fixed categories', async () => {
    expect(classifySlackError('token_revoked')).toBe('invalid_auth');
    expect(classifySlackError('account_inactive')).toBe('invalid_auth');
    expect(classifySlackError('missing_scope')).toBe('forbidden_scope');
    expect(classifySlackError('users_not_found')).toBe('not_found');
    expect(classifySlackError('ratelimited')).toBe('rate_limit');
    expect(classifySlackError('fatal_error')).toBe('upstream_error');
    const send = (options: Parameters<typeof fakeSlack>[0]) =>
      sendSlackRequest('users.info', { verb: 'GET', params: { user: 'U1' } }, BOT_TOKEN, {
        timeoutMs: 5_000,
        fetchImpl: fakeSlack(options).fetchImpl,
      });
    expect((await send({ status: 429 })).errorCategory).toBe('rate_limit');
    expect((await send({ status: 503 })).errorCategory).toBe('upstream_error');
    expect((await send({ status: 302 })).errorCategory).toBe('redirect_refused');
    expect((await send({ error: 'invalid_auth' })).errorCategory).toBe('invalid_auth');
    expect((await send({ rawUsersBody: 'not json' })).errorCategory).toBe('invalid_shape');
    expect(
      (await send({ rawUsersBody: 'x'.repeat(SLACK_RESPONSE_MAX_BYTES + 1) })).errorCategory,
    ).toBe('output_limit');
    const failing = await sendSlackRequest('auth.test', { verb: 'GET', params: {} }, BOT_TOKEN, {
      timeoutMs: 5_000,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(failing.errorCategory).toBe('network');
  });
});

describe('Slack provider readiness', () => {
  it('is ready with the workspace, bot user and granted scopes', async () => {
    const { provider, api } = await readyProvider();
    expect(provider.state).toMatchObject({
      tool: 'slack',
      ready: true,
      status: 'ready',
      endpoint: SLACK_ENDPOINT,
      adapter: 'slack-api-v1',
      contractVersion: 'slack-read-v1',
      teamId: SLACK_TEAM,
      botUserId: BOT_USER,
      scopes: ['chat:write', 'users:read', 'users:read.email'],
      searchScope: false,
      credentialFingerprint: slackCredentialFingerprint(BOT_TOKEN),
    });
    expect(provider.state.detail).toMatch(
      /message search: missing search:read\.public \(add it and reinstall\)$/,
    );
    expect(JSON.stringify(provider.state)).not.toContain(BOT_TOKEN);
    expect(api.seen.map((request) => request.url.pathname)).toEqual(['/api/auth.test']);
    expect(provider.secrets()).toEqual([BOT_TOKEN]);
  });

  it('needs users:read only; users:read.email is optional', async () => {
    const { provider } = await readyProvider({ scopes: 'chat:write' });
    expect(provider.state).toMatchObject({ ready: false, status: 'missing_scope' });
    expect(provider.state.detail).toMatch(/^missing_scope users:read \(/);
    const plain = await readyProvider({ scopes: 'users:read,chat:write' });
    expect(plain.provider.state.ready).toBe(true);
    expect(plain.provider.state.detail).toMatch(/without e-mail addresses \(no users:read\.email/);
  });

  it('refuses a token of another workspace, a malformed token and a revoked token', async () => {
    const other = await readyProvider({ team: 'T0OTHER' });
    expect(other.provider.state).toMatchObject({ ready: false, status: 'workspace_mismatch' });
    expect(other.provider.state.detail).toMatch(/workspace mismatch/);
    const revoked = await readyProvider({ error: 'token_revoked' });
    expect(revoked.provider.state).toMatchObject({ ready: false, status: 'invalid_auth' });
    const malformed = new SlackApiProvider({ teamId: SLACK_TEAM, token: 'x' });
    expect(malformed.configured).toBe(false);
    expect(malformed.state.detail).toMatch(/bot token is missing or malformed/);
  });
});

describe('Slack provider lookups', () => {
  it('returns the bounded profile only (no phone, avatar or custom fields)', async () => {
    const { provider, api } = await readyProvider();
    const result = await provider.call('getUser', { user: '<@U0123456789>' }, BOUNDS);
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.output)).toEqual({
      user: {
        id: FIXTURE_USER.id,
        name: 'sam',
        realName: 'Sam Rivera',
        displayName: 'Sam',
        title: 'Engineer  (platform)',
        email: 'sam.rivera@example.com',
        timeZone: 'Europe/Berlin',
        isBot: false,
        isDeleted: false,
        isRestricted: false,
        isAdmin: false,
      },
    });
    expect(result.output).not.toMatch(/phone|avatars|secret custom field/);
    expect(api.seen.at(-1)!.url.pathname).toBe('/api/users.info');
    const byEmail = await provider.call(
      'lookupByEmail',
      { email: 'sam.rivera@example.com' },
      BOUNDS,
    );
    expect(JSON.parse(byEmail.output).user.id).toBe(FIXTURE_USER.id);
    expect(api.seen.at(-1)!.url.pathname).toBe('/api/users.lookupByEmail');
  });

  it('flags deleted, bot and guest accounts instead of refusing them', async () => {
    const { provider } = await readyProvider({
      users: [
        { ...FIXTURE_USER, deleted: true, is_bot: true, is_ultra_restricted: true, is_owner: true },
      ],
    });
    const user = JSON.parse(
      (await provider.call('getUser', { user: FIXTURE_USER.id }, BOUNDS)).output,
    ).user;
    expect(user).toMatchObject({ isDeleted: true, isBot: true, isRestricted: true, isAdmin: true });
  });

  it('without users:read.email: no e-mail in profiles, the e-mail lookup reports the scope', async () => {
    const { provider } = await readyProvider({ scopes: 'users:read' });
    const result = await provider.call('getUser', { user: FIXTURE_USER.id }, BOUNDS);
    expect(JSON.parse(result.output).user.email).toBeNull();
    expect(result.output).not.toContain('sam.rivera@example.com');
    const refused = await provider.call(
      'lookupByEmail',
      { email: 'sam.rivera@example.com' },
      BOUNDS,
    );
    expect(refused).toMatchObject({ status: 'failed', errorCategory: 'forbidden_scope' });
    expect(refused.output).toMatch(/users:read\.email/);
  });

  it('answers failures with fixed sentences and re-probes after an auth failure', async () => {
    const { provider } = await readyProvider();
    const missing = await provider.call('getUser', { user: 'U0NOBODY' }, BOUNDS);
    expect(missing).toMatchObject({ status: 'failed', errorCategory: 'not_found' });
    expect(missing.output).toBe(
      'slack_get_user: not_found: No Slack user matches in this workspace.',
    );
    const invalid = await provider.call('getUser', { user: 'not a user' }, BOUNDS);
    expect(invalid.status).toBe('not_run');
    const revoked = new SlackApiProvider(
      { teamId: SLACK_TEAM, token: BOT_TOKEN },
      fakeSlack().fetchImpl,
    );
    await revoked.refresh();
    expect(revoked.isStale()).toBe(false);
    (revoked as unknown as { fetchImpl: unknown }).fetchImpl = fakeSlack({
      error: 'invalid_auth',
    }).fetchImpl;
    const failed = await revoked.call('getUser', { user: FIXTURE_USER.id }, BOUNDS);
    expect(failed.errorCategory).toBe('invalid_auth');
    expect(failed.output).not.toContain(BOT_TOKEN);
    expect(revoked.isStale()).toBe(true);
  });

  it('refuses every call while not ready', async () => {
    const { provider, api } = await readyProvider({ team: 'T0OTHER' });
    const before = api.seen.length;
    expect(await provider.call('getUser', { user: FIXTURE_USER.id }, BOUNDS)).toMatchObject({
      status: 'not_run',
    });
    expect(api.seen).toHaveLength(before);
  });
});
