/**
 * Workspace installations from the admin service: the registry against a
 * fake admin internal API and a fake Slack Web API (both node:http on
 * 127.0.0.1), unknown-workspace handling at the receiver, and per-team
 * routing of intake, delivery and context history.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decideMention } from '../src/intake.js';
import {
  adminStaleAfterMs,
  InstallationRegistry,
  Throttle,
  type InstallationRegistryOptions,
} from '../src/installations.js';
import type { StageLogger } from '../src/logger.js';
import { handleEnvelope } from '../src/receiver.js';

const ADMIN_TOKEN = 'admin-internal-test-token';
const TOKEN_A = 'xoxb-team-a-secret-token';
const TOKEN_B = 'xoxb-team-b-secret-token';

interface TeamEntry {
  teamId: string;
  teamName: string;
  botUserId: string;
  botId: string;
  trustedBotSender: { botId: string; userId: string; channelId: string } | null;
}

const TEAM_A: TeamEntry = {
  teamId: 'TAAA',
  teamName: 'Team A',
  botUserId: 'UBOTA',
  botId: 'BBOTA',
  trustedBotSender: null,
};
const TEAM_B: TeamEntry = {
  teamId: 'TBBB',
  teamName: 'Team B',
  botUserId: 'UBOTB',
  botId: 'BBOTB',
  trustedBotSender: { botId: 'BAUTO', userId: 'UAUTO', channelId: 'CBBB' },
};

interface Listening {
  url: string;
  close(): Promise<void>;
}

async function listen(handler: http.RequestListener): Promise<Listening> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

/** Stand-in for the admin service's internal API (see apps/admin/src/app.ts). */
function fakeAdmin() {
  const state = {
    version: 1,
    teams: [] as TeamEntry[],
    tokens: new Map<string, string>([
      [TEAM_A.teamId, TOKEN_A],
      [TEAM_B.teamId, TOKEN_B],
    ]),
    available: true,
    configRequests: [] as Array<{ ifNoneMatch: string | undefined; status: number }>,
    tokenRequests: [] as string[],
    seen: [] as string[],
    /** Paired but not whitelisted teams (served only for the notice). */
    unserved: new Map<string, 'pending' | 'disabled'>(),
    noticeRequests: [] as string[],
  };
  const hash = (): string => `h${state.version}`;
  const handler: http.RequestListener = (req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (!state.available) {
        res.writeHead(503).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/internal/config') {
        const etag = `"${hash()}"`;
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === etag) {
          state.configRequests.push({ ifNoneMatch, status: 304 });
          res.writeHead(304, { etag }).end();
          return;
        }
        state.configRequests.push({ ifNoneMatch, status: 200 });
        res.writeHead(200, { 'content-type': 'application/json', etag }).end(
          JSON.stringify({
            version: state.version,
            hash: hash(),
            installations: state.teams,
            authorizationPolicy: { version: 1, bindings: [] },
          }),
        );
        return;
      }
      const token = /^\/internal\/installations\/([A-Z0-9]+)\/token$/.exec(req.url ?? '');
      if (req.method === 'GET' && token !== null) {
        const teamId = token[1] as string;
        state.tokenRequests.push(teamId);
        const listed = state.teams.some((team) => team.teamId === teamId);
        const botToken = state.tokens.get(teamId);
        if (!listed || botToken === undefined) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ teamId, botToken }));
        return;
      }
      const notice = /^\/internal\/installations\/([A-Z0-9]+)\/notice-token$/.exec(req.url ?? '');
      if (req.method === 'GET' && notice !== null) {
        const teamId = notice[1] as string;
        state.noticeRequests.push(teamId);
        const status = state.unserved.get(teamId);
        const team = [TEAM_A, TEAM_B].find((row) => row.teamId === teamId);
        if (status === undefined || team === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            teamId,
            status,
            botUserId: team.botUserId,
            botId: team.botId,
            botToken: state.tokens.get(teamId),
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/installations/seen') {
        state.seen.push(String((JSON.parse(body) as { teamId?: unknown }).teamId));
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    })();
  };
  return { state, handler };
}

/**
 * Fake Slack Web API: identifies the workspace by the bearer token and
 * records every call with that token's team.
 */
function fakeSlackApi() {
  const identities = new Map<string, { team_id: string; user_id: string; bot_id: string }>([
    [TOKEN_A, { team_id: TEAM_A.teamId, user_id: TEAM_A.botUserId, bot_id: TEAM_A.botId }],
    [TOKEN_B, { team_id: TEAM_B.teamId, user_id: TEAM_B.botUserId, bot_id: TEAM_B.botId }],
  ]);
  const calls: Array<{ method: string; team: string; params: URLSearchParams }> = [];
  const replies = new Map<string, Array<Record<string, unknown>>>();
  const handler: http.RequestListener = (req, res) => {
    void (async () => {
      const params = new URLSearchParams(await readBody(req));
      const method = (req.url ?? '').replace(/^\/api\//, '');
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const identity = identities.get(token);
      const send = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (identity === undefined) {
        send({ ok: false, error: 'invalid_auth' });
        return;
      }
      calls.push({ method, team: identity.team_id, params });
      switch (method) {
        case 'conversations.members':
          send({
            ok: true,
            members: ['UHUMAN1', 'UHUMAN2', 'UAUTO', 'WEXTERNAL'],
            response_metadata: {},
          });
          return;
        case 'auth.test':
          send({ ok: true, team: 'fake', ...identity });
          return;
        case 'chat.postEphemeral':
          send({ ok: true, message_ts: '1716235000.000002' });
          return;
        case 'chat.postMessage':
          send({ ok: true, ts: '1716235000.000001', channel: params.get('channel') });
          return;
        case 'conversations.replies':
          send({
            ok: true,
            messages: replies.get(identity.team_id) ?? [],
            response_metadata: {},
          });
          return;
        default:
          send({ ok: false, error: 'unknown_method' });
      }
    })();
  };
  return { identities, calls, replies, handler };
}

function capturingLog(): StageLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

describe('installation registry (fake admin service, fake Slack API)', () => {
  let admin: ReturnType<typeof fakeAdmin>;
  let slack: ReturnType<typeof fakeSlackApi>;
  let adminServer: Listening;
  let slackServer: Listening;
  const allLogs: string[] = [];
  const registries: InstallationRegistry[] = [];

  beforeAll(async () => {
    admin = fakeAdmin();
    slack = fakeSlackApi();
    adminServer = await listen((req, res) => admin.handler(req, res));
    slackServer = await listen((req, res) => slack.handler(req, res));
  });

  afterEach(() => {
    for (const registry of registries.splice(0)) registry.stop();
  });

  afterAll(async () => {
    // No token (bot or admin credential) ever reaches a log line.
    const joined = allLogs.join('\n');
    expect(joined).not.toContain('xoxb-');
    expect(joined).not.toContain(ADMIN_TOKEN);
    await adminServer?.close();
    await slackServer?.close();
  });

  function reset(teams: TeamEntry[], version = 1): void {
    const fresh = fakeAdmin();
    Object.assign(admin.state, fresh.state, { teams, version });
    slack.calls.length = 0;
    slack.replies.clear();
  }

  function registry(overrides: Partial<InstallationRegistryOptions> = {}) {
    const log = capturingLog();
    const created = new InstallationRegistry({
      adminUrl: adminServer.url,
      adminToken: ADMIN_TOKEN,
      pollIntervalMs: 60_000,
      slackApiUrl: `${slackServer.url}/api/`,
      log,
      ...overrides,
    });
    registries.push(created);
    return {
      registry: created,
      log,
      sync: async () => {
        await created.syncOnce();
        await created.settled();
        allLogs.push(...log.lines);
      },
    };
  }

  it('syncs the document, verifies each team with auth.test, and revalidates with ETag', async () => {
    reset([TEAM_A, TEAM_B], 7);
    const { registry: reg, log, sync } = registry();
    expect(reg.readiness()).toEqual({
      name: 'admin_config_synced',
      ok: false,
      reason: 'never_evaluated',
    });
    await sync();
    expect(reg.configVersion).toBe(7);
    expect(reg.size).toBe(2);
    expect(reg.readiness()).toEqual({ name: 'admin_config_synced', ok: true });
    expect(admin.state.tokenRequests.sort()).toEqual(['TAAA', 'TBBB']);
    expect(
      slack.calls
        .filter((c) => c.method === 'auth.test')
        .map((c) => c.team)
        .sort(),
    ).toEqual(['TAAA', 'TBBB']);
    // The task-key installation discriminator is the team's bot user.
    expect(reg.get('TAAA')?.identity).toEqual({
      teamId: 'TAAA',
      installationId: 'UBOTA',
      botUserId: 'UBOTA',
      botId: 'BBOTA',
    });
    expect(reg.get('TBBB')?.identity.trustedBotSender).toEqual({
      teamId: 'TBBB',
      botId: 'BAUTO',
      userId: 'UAUTO',
      channelId: 'CBBB',
    });
    expect(reg.get('TBBB')?.slack).toMatchObject({ botUserId: 'UBOTB', botId: 'BBOTB' });
    expect(log.lines).toContain('info admin config synced version=7 installations=2');
    expect(log.lines).toContain(
      'info installation ready team=TAAA bot_user_id=UBOTA config_version=7',
    );
    expect(log.lines).toContain(
      'info installation ready team=TBBB bot_user_id=UBOTB config_version=7',
    );

    // Unchanged document: 304 with the ETag, no token fetch, no auth.test.
    await sync();
    expect(admin.state.configRequests.at(-1)).toEqual({ ifNoneMatch: '"h7"', status: 304 });
    expect(admin.state.tokenRequests).toHaveLength(2);
    expect(slack.calls.filter((c) => c.method === 'auth.test')).toHaveLength(2);
    expect(log.lines.filter((line) => line.includes('admin config synced'))).toHaveLength(1);
  });

  it('fetches tokens only for new or re-keyed teams and drops a removed team at once', async () => {
    reset([TEAM_A], 1);
    const { registry: reg, log, sync } = registry();
    await sync();
    const clientA = reg.get('TAAA')?.slack.webClient;
    expect(clientA).toBeDefined();

    admin.state.version = 2;
    admin.state.teams = [TEAM_B];
    await reg.syncOnce();
    // Removal is synchronous with the sync; the new team is set up after.
    expect(reg.get('TAAA')).toBeUndefined();
    await reg.settled();
    allLogs.push(...log.lines);
    expect(reg.get('TBBB')).toBeDefined();
    expect(admin.state.tokenRequests).toEqual(['TAAA', 'TBBB']);
    expect(log.lines).toContain('info installation removed team=TAAA config_version=2');

    // A sender change reuses the verified client; a new bot identity re-verifies.
    admin.state.version = 3;
    admin.state.teams = [{ ...TEAM_B, trustedBotSender: null }];
    await sync();
    expect(admin.state.tokenRequests).toEqual(['TAAA', 'TBBB']);
    expect(reg.get('TBBB')?.identity.trustedBotSender).toBeUndefined();

    admin.state.version = 4;
    admin.state.teams = [{ ...TEAM_B, botId: 'BNEWBOT' }];
    await sync();
    expect(admin.state.tokenRequests).toEqual(['TAAA', 'TBBB', 'TBBB']);
    // auth.test still reports the old bot: the team stays unusable.
    expect(reg.get('TBBB')).toBeUndefined();
  });

  it('leaves a team unusable when auth.test disagrees with the document, logging IDs only', async () => {
    reset([{ ...TEAM_A, botUserId: 'UIMPOSTOR' }], 1);
    const { registry: reg, log, sync } = registry();
    await sync();
    expect(reg.get('TAAA')).toBeUndefined();
    expect(reg.size).toBe(0);
    const failure = log.lines.find((line) =>
      line.startsWith('error installation unusable team=TAAA'),
    );
    expect(failure).toContain('auth.test identity mismatch');
    expect(failure).toContain('bot_user_id=UBOTA');
    // Not retried on every poll: the back-off applies to the same identity.
    await sync();
    expect(admin.state.tokenRequests).toEqual(['TAAA']);
  });

  it('refuses a trusted bot sender that is the application itself', async () => {
    reset([
      { ...TEAM_A, trustedBotSender: { botId: 'BBOTA', userId: 'UOTHER', channelId: 'CAAA' } },
    ]);
    const { registry: reg, log, sync } = registry();
    await sync();
    expect(reg.get('TAAA')).toBeUndefined();
    expect(log.lines.some((line) => line.includes('the application itself'))).toBe(true);
  });

  it('accepts a document without installations and rejects a malformed one', async () => {
    reset([], 1);
    const { registry: reg, sync } = registry();
    await sync();
    expect(reg.configVersion).toBe(1);
    expect(reg.size).toBe(0);
    expect(reg.readiness().ok).toBe(true);

    admin.state.version = 2;
    admin.state.teams = [{ ...TEAM_A, botId: 'not-a-bot' }];
    await expect(reg.syncOnce()).rejects.toThrow(/malformed/);
    // The last applied document stays in force.
    expect(reg.configVersion).toBe(1);
  });

  it('reports readiness stale once no sync succeeded within the bound', async () => {
    reset([], 1);
    let now = 1_000_000;
    const { registry: reg, sync } = registry({ pollIntervalMs: 2_000, now: () => now });
    await sync();
    expect(adminStaleAfterMs(2_000)).toBe(60_000);
    expect(adminStaleAfterMs(30_000)).toBe(90_000);
    now += 60_000;
    expect(reg.synced).toBe(true);
    now += 1;
    expect(reg.readiness()).toEqual({ name: 'admin_config_synced', ok: false, reason: 'stale' });
    admin.state.available = false;
    await expect(reg.syncOnce()).rejects.toThrow(/HTTP 503/);
    expect(reg.synced).toBe(false);
    admin.state.available = true;
    await sync();
    expect(reg.synced).toBe(true);
  });

  it('acks events from a non-whitelisted team, reports it once per window, never intakes', async () => {
    reset([TEAM_A], 1);
    let now = 5_000_000;
    const { registry: reg, sync } = registry({ now: () => now });
    await sync();
    const intake = vi.fn(async () => undefined);
    const interaction = vi.fn(async () => undefined);
    const ack = vi.fn(async () => undefined);
    const deps = {
      appToken: 'unused',
      installations: reg,
      reportSeen: (teamId: string) => void reg.reportSeen(teamId),
      intake,
      interaction,
      log: { info() {}, warn() {}, error() {} },
    };
    const mention = (teamId: string, eventId: string) => ({
      type: 'events_api',
      ack,
      body: {
        type: 'event_callback',
        team_id: teamId,
        event_id: eventId,
        event: {
          type: 'app_mention',
          user: 'UHUMAN1',
          channel: 'C0123456789',
          ts: '1716234567.111111',
        },
      },
    });
    await handleEnvelope(mention('TUNKNOWN', 'Ev1'), deps);
    await handleEnvelope(mention('TUNKNOWN', 'Ev2'), deps);
    await handleEnvelope(
      { type: 'interactive', ack, body: { type: 'block_actions', team: { id: 'TUNKNOWN' } } },
      deps,
    );
    await vi.waitFor(() => expect(admin.state.seen).toEqual(['TUNKNOWN']));
    expect(ack).toHaveBeenCalledTimes(3);
    expect(intake).not.toHaveBeenCalled();
    expect(interaction).not.toHaveBeenCalled();

    // After the rate-limit window the team is reported again.
    now += 60_000;
    await handleEnvelope(mention('TUNKNOWN', 'Ev3'), deps);
    await vi.waitFor(() => expect(admin.state.seen).toEqual(['TUNKNOWN', 'TUNKNOWN']));
    // A whitelisted team is never reported and reaches intake.
    await handleEnvelope(mention('TAAA', 'Ev4'), deps);
    expect(intake).toHaveBeenCalledOnce();
    expect(admin.state.seen).toEqual(['TUNKNOWN', 'TUNKNOWN']);
  });

  it('tells a person privately why the bot does not answer in a paired, non-whitelisted workspace', async () => {
    reset([TEAM_A], 1);
    admin.state.unserved.set(TEAM_B.teamId, 'pending');
    let now = 7_000_000;
    const { registry: reg, sync, log } = registry({ now: () => now });
    await sync();
    const ack = vi.fn(async () => undefined);
    const intake = vi.fn(async () => undefined);
    const deps = {
      appToken: 'unused',
      installations: reg,
      notifyUnusable: (
        teamId: string,
        mention: { channel: string; user: string; threadTs: string },
      ) => void reg.notifyUnusable(teamId, mention),
      intake,
      log: { info() {}, warn() {}, error() {} },
    };
    const mention = (teamId: string, event: Record<string, unknown>) => ({
      type: 'events_api',
      ack,
      body: {
        type: 'event_callback',
        team_id: teamId,
        event_id: `Ev-${Math.random()}`,
        event: { type: 'app_mention', channel: 'CBBB', ts: '1716234567.222222', ...event },
      },
    });
    const ephemerals = () => slack.calls.filter((call) => call.method === 'chat.postEphemeral');

    await handleEnvelope(
      mention(TEAM_B.teamId, { user: 'UHUMAN1', thread_ts: '1716234567.1' }),
      deps,
    );
    await vi.waitFor(() => expect(ephemerals()).toHaveLength(1));
    const [notice] = ephemerals();
    expect(notice?.team).toBe(TEAM_B.teamId);
    expect(notice?.params.get('user')).toBe('UHUMAN1');
    expect(notice?.params.get('channel')).toBe('CBBB');
    expect(notice?.params.get('thread_ts')).toBe('1716234567.1');
    expect(notice?.params.get('text')).toContain('not enabled in this workspace yet');
    expect(intake).not.toHaveBeenCalled();

    // Once per user per window; bots and never-paired teams get nothing.
    await handleEnvelope(mention(TEAM_B.teamId, { user: 'UHUMAN1' }), deps);
    await handleEnvelope(mention(TEAM_B.teamId, { user: 'UAUTO', bot_id: 'BAUTO' }), deps);
    await handleEnvelope(mention('TNEVER', { user: 'UHUMAN1' }), deps);
    await vi.waitFor(() => expect(admin.state.noticeRequests).toContain('TNEVER'));
    expect(ephemerals()).toHaveLength(1);

    // A disabled workspace says so, after the window.
    admin.state.unserved.set(TEAM_B.teamId, 'disabled');
    now += 600_000;
    await handleEnvelope(mention(TEAM_B.teamId, { user: 'UHUMAN1' }), deps);
    await vi.waitFor(() => expect(ephemerals()).toHaveLength(2));
    expect(ephemerals()[1]?.params.get('text')).toContain('disabled in this workspace');
    // A whitelisted team never asks for a notice token.
    await handleEnvelope(mention(TEAM_A.teamId, { user: 'UHUMAN1', channel: 'CAAA' }), deps);
    expect(admin.state.noticeRequests).not.toContain(TEAM_A.teamId);
    allLogs.push(...log.lines);
  });

  it('routes two whitelisted teams to their own identities and Slack clients', async () => {
    reset([TEAM_A, TEAM_B], 1);
    const { registry: reg, sync } = registry();
    await sync();

    const accepted: Array<{ installationId: string; teamId: string }> = [];
    const deps = {
      appToken: 'unused',
      installations: reg,
      intake: async (
        event: Parameters<typeof decideMention>[0],
        _eventId: string | undefined,
        installation: { identity: Parameters<typeof decideMention>[1] },
      ) => {
        const decision = decideMention(event, installation.identity);
        if (decision.kind === 'accept') accepted.push(decision.request);
      },
      log: { info() {}, warn() {}, error() {} },
    };
    for (const [team, channel] of [
      ['TAAA', 'CAAA'],
      ['TBBB', 'CBBB'],
    ] as const) {
      await handleEnvelope(
        {
          type: 'events_api',
          ack: async () => undefined,
          body: {
            type: 'event_callback',
            team_id: team,
            event: { type: 'app_mention', user: 'UHUMAN1', channel, ts: '1716234567.111111' },
          },
        },
        deps,
      );
    }
    expect(accepted.map((r) => [r.installationId, r.teamId])).toEqual([
      ['UBOTA', 'TAAA'],
      ['UBOTB', 'TBBB'],
    ]);

    // Slack Connect's outer team can be the actor's home workspace. Route
    // by the recipient installation, then verify its channel roster.
    await handleEnvelope(
      {
        type: 'events_api',
        ack: async () => undefined,
        body: {
          type: 'event_callback',
          team_id: 'TEXTERNAL',
          authorizations: [{ team_id: 'TAAA' }],
          event: {
            type: 'app_mention',
            user: 'WEXTERNAL',
            channel: 'CAAA',
            ts: '1716234567.333333',
          },
        },
      },
      deps,
    );
    expect(accepted.at(-1)).toMatchObject({
      installationId: 'UBOTA',
      teamId: 'TAAA',
      userId: 'WEXTERNAL',
    });
  });
});

describe('Throttle', () => {
  it('allows a key once per window and bounds the key set', () => {
    let now = 0;
    const throttle = new Throttle(1_000, () => now, 2);
    expect(throttle.allow('A')).toBe(true);
    expect(throttle.allow('A')).toBe(false);
    expect(throttle.allow('B')).toBe(true);
    // Full and nothing expired: new keys are refused.
    expect(throttle.allow('C')).toBe(false);
    now = 1_000;
    expect(throttle.allow('C')).toBe(true);
    expect(throttle.allow('A')).toBe(true);
  });
});
