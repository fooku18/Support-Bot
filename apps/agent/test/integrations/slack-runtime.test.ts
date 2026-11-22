/**
 * Isolated tool runtime: admin-managed Slack instances (the fixed slack.com
 * host, the workspace bot token as credential, readiness, the /slack route's
 * binding and workspace checks, redaction).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliInstanceRegistry,
  handleSlack,
  redactRuntimeOutput,
  setInstanceRegistry,
} from '../../../tool-runtime/src/main.js';
import {
  SLACK_ENDPOINT,
  slackCredentialFingerprint,
} from '../../src/integrations/slack/slack-api-adapter.js';
import type {
  SyncedToolInstance,
  ToolInstanceStatusReport,
} from '../../src/integrations/tools/tool-instances.js';
import {
  ACTION_TOKEN,
  BOT_TOKEN,
  BOT_USER,
  FIXTURE_USER,
  SLACK_TEAM,
  fakeSlack,
  searchHit,
} from './helpers/slack-api.js';

const SLACK_ID = 'ti_0000000000000009';
const INSTALLED_AT = 1_790_000_000_000;

function slackInstance(
  overrides: Partial<SyncedToolInstance<'slack'>> = {},
): SyncedToolInstance<'slack'> {
  return {
    id: SLACK_ID,
    teamId: SLACK_TEAM,
    kind: 'slack',
    label: 'Slack (test)',
    host: 'slack.com',
    settings: {},
    credentialVersion: INSTALLED_AT,
    hasCredential: true,
    ...overrides,
  };
}

function harness(api = fakeSlack()) {
  const reports: ToolInstanceStatusReport[] = [];
  const secretCalls: string[] = [];
  const registry = new CliInstanceRegistry({
    admitted: {
      gitlab: new Set(),
      atlassian: new Set(),
      datadog: new Set(),
      cloudflare: new Set(),
    },
    glab: { path: '/opt/glab', installed: false, sha256: null, version: null },
    secret: async (instanceId) => {
      secretCalls.push(instanceId);
      return { credential: BOT_TOKEN, credentialVersion: INSTALLED_AT };
    },
    report: async (statuses) => {
      reports.push(...statuses);
    },
    slackFetch: api.fetchImpl,
  });
  setInstanceRegistry(registry);
  return { registry, reports, secretCalls, api };
}

const BINDING = {
  endpoint: SLACK_ENDPOINT,
  adapter: 'slack-api-v1',
  contractVersion: 'slack-read-v1',
  teamId: SLACK_TEAM,
  botUserId: BOT_USER,
  credentialFingerprint: slackCredentialFingerprint(BOT_TOKEN),
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: SLACK_ID,
    teamId: SLACK_TEAM,
    operation: 'getUser',
    arguments: { user: FIXTURE_USER.id },
    binding: BINDING,
    timeoutMs: 10_000,
    maxOutputBytes: 50_000,
    ...overrides,
  };
}

async function readyHarness(instance = slackInstance(), api = fakeSlack()) {
  const h = harness(api);
  await h.registry.apply(new Map([[SLACK_ID, instance]]));
  await h.registry.probe(SLACK_ID);
  return h;
}

afterEach(() => {
  setInstanceRegistry(null);
});

describe('cli-runtime Slack admission and readiness', () => {
  it('serves slack.com without an allowlist entry and reads the workspace bot token', async () => {
    const h = await readyHarness();
    expect(h.secretCalls).toEqual([SLACK_ID]);
    const [status] = h.registry.statuses();
    expect(status).toMatchObject({
      kind: 'slack',
      teamId: SLACK_TEAM,
      state: 'ready',
      credentialVersion: INSTALLED_AT,
      slack: { ready: true, teamId: SLACK_TEAM, botUserId: BOT_USER },
    });
    expect(JSON.stringify(h.registry.statuses())).not.toContain(BOT_TOKEN);
    expect(h.reports.at(-1)).toMatchObject({
      instanceId: SLACK_ID,
      state: 'ready',
      credentialVersion: INSTALLED_AT,
    });
    expect(redactRuntimeOutput(`token ${BOT_TOKEN} here`)).toBe('token [redacted] here');
  });

  it('blocks any host but slack.com: no secret, no probe', async () => {
    const h = harness();
    await h.registry.apply(new Map([[SLACK_ID, slackInstance({ host: 'evil.example.com' })]]));
    expect(h.secretCalls).toEqual([]);
    expect(h.api.seen).toEqual([]);
    expect(h.reports[0]).toMatchObject({
      state: 'blocked',
      detail: 'host not admitted: evil.example.com is not slack.com',
    });
  });

  it('reports missing_scope to the admin service until the reinstall', async () => {
    const h = await readyHarness(slackInstance(), fakeSlack({ scopes: 'chat:write' }));
    expect(h.reports.at(-1)).toMatchObject({ state: 'error' });
    expect(h.reports.at(-1)!.detail).toMatch(/^missing_scope users:read /);
  });

  it('reports an instance without a bot token (workspace not whitelisted) as error', async () => {
    const h = harness();
    await h.registry.apply(new Map([[SLACK_ID, slackInstance({ hasCredential: false })]]));
    expect(h.secretCalls).toEqual([]);
    expect(h.reports[0]).toMatchObject({ state: 'error', detail: 'no credential' });
  });
});

describe('cli-runtime /slack route', () => {
  it('runs one bounded lookup with the held token', async () => {
    const h = await readyHarness();
    const result = await handleSlack(request());
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.output).user).toMatchObject({
      id: FIXTURE_USER.id,
      email: 'sam.rivera@example.com',
    });
    expect(h.api.seen.at(-1)!.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const byEmail = await handleSlack(
      request({ operation: 'lookupByEmail', arguments: { email: 'sam.rivera@example.com' } }),
    );
    expect(JSON.parse(byEmail.output).user.id).toBe(FIXTURE_USER.id);
  });

  it('refuses another workspace, a changed binding and unknown fields or operations', async () => {
    const h = await readyHarness();
    const before = h.api.seen.length;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ teamId: 'T0OTHER' }, /belongs to another workspace/],
      [{ binding: { ...BINDING, teamId: 'T0OTHER' } }, /binding mismatch/],
      [{ binding: { ...BINDING, credentialFingerprint: 'f'.repeat(16) } }, /binding mismatch/],
      [{ binding: { ...BINDING, exposeEmail: true } }, /binding mismatch/],
      [{ binding: { ...BINDING, token: BOT_TOKEN } }, /binding mismatch/],
      [{ operation: 'listUsers' }, /unknown Slack operation/],
      [{ channel: 'C1' }, /unknown transport field/],
      [{ arguments: { user: 'everyone' } }, /Slack user ID/],
      [{ instanceId: 'ti_0000000000000001' }, /unknown slack tool instance/],
    ];
    for (const [overrides, message] of cases) {
      const result = await handleSlack(request(overrides));
      expect(result.status).toBe('not_run');
      expect(result.refused).toMatch(message);
    }
    expect(h.api.seen).toHaveLength(before);
  });
});

describe('cli-runtime /slack message search', () => {
  const SEARCH_SCOPES = 'users:read,users:read.email,search:read.public';
  const search = (overrides: Record<string, unknown> = {}) =>
    request({
      operation: 'searchMessages',
      arguments: { query: 'company party' },
      actionToken: ACTION_TOKEN,
      ...overrides,
    });

  it('reports the search scope on /readyz without making it a readiness condition', async () => {
    const granted = await readyHarness(slackInstance(), fakeSlack({ scopes: SEARCH_SCOPES }));
    expect(granted.registry.statuses()[0]).toMatchObject({
      state: 'ready',
      slack: { ready: true, searchScope: true },
    });
    const missing = await readyHarness(slackInstance(), fakeSlack({ scopes: 'users:read' }));
    expect(missing.registry.statuses()[0]).toMatchObject({
      state: 'ready',
      slack: { ready: true, searchScope: false },
    });
    expect(missing.registry.statuses()[0]?.detail).toMatch(/missing search:read\.public/);
  });

  it('searches with the held bot token and the per-call action token', async () => {
    const h = await readyHarness(slackInstance(), fakeSlack({ scopes: SEARCH_SCOPES }));
    const result = await handleSlack(search());
    expect(result).toMatchObject({ status: 'completed', pages: 1, resultCount: 2 });
    const sent = h.api.seen.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(sent.body).toMatchObject({
      action_token: ACTION_TOKEN,
      channel_types: ['public_channel'],
    });
    expect(JSON.parse(result.output).messages[0].channel).toBe('company-parties');
  });

  it('requires the action token for a search and refuses it for a lookup', async () => {
    const h = await readyHarness(slackInstance(), fakeSlack({ scopes: SEARCH_SCOPES }));
    const before = h.api.seen.length;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ actionToken: undefined }, /needs the triggering mention's action token/],
      [{ actionToken: '' }, /needs the triggering mention's action token/],
      [{ actionToken: 'with space' }, /needs the triggering mention's action token/],
      [{ actionToken: 'x'.repeat(4097) }, /needs the triggering mention's action token/],
      [{ arguments: { query: 'party', channel_types: ['im'] } }, /unknown argument/],
    ];
    for (const [overrides, message] of cases) {
      const result = await handleSlack(search(overrides));
      expect(result.status).toBe('not_run');
      expect(result.refused).toMatch(message);
    }
    const lookup = await handleSlack(request({ actionToken: ACTION_TOKEN }));
    expect(lookup.refused).toMatch(/only a message search carries an action token/);
    expect(h.api.seen).toHaveLength(before);
  });

  it('redacts the action token from anything Slack echoes back', async () => {
    await readyHarness(
      slackInstance(),
      fakeSlack({
        scopes: SEARCH_SCOPES,
        searchPages: [[searchHit(1, { content: `echo ${ACTION_TOKEN} and ${BOT_TOKEN}` })]],
      }),
    );
    const result = await handleSlack(search());
    expect(result.status).toBe('completed');
    expect(result.output).not.toContain(ACTION_TOKEN);
    expect(result.output).not.toContain(BOT_TOKEN);
    expect(result.output).toContain('[redacted]');
    expect(redactRuntimeOutput(`a ${ACTION_TOKEN} b`, [ACTION_TOKEN])).toBe('a [redacted] b');
  });
});
