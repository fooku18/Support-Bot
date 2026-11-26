import { ChannelCommands, type CommandSource } from './channel-commands.js';
/**
 * HTTP surface of the admin service (plain `node:http`, D4):
 *
 * - `/healthz`: unauthenticated readiness with the current config version.
 * - `/internal/*`: bearer `ADMIN_INTERNAL_TOKEN`, for the agent, the adapter,
 *   the runner and the tool runtimes on the frontend network only; requests
 *   that came through a proxy are refused. Tool credentials leave the service
 *   only through the audited `/internal/tool-instances/<id>/secret`.
 *   The runner posts the cost ledger to `/internal/costs`.
 * - Everything else is reached through the reverse proxy and requires
 *   `X-Forwarded-Proto: https` (D6): the login form, the Slack OAuth
 *   callback, the session-cookie UI (CSRF token on every form), and the
 *   bearer-token JSON API under `/api/*` for automation.
 */

import { createHash } from 'node:crypto';
import { MAX_CHANNEL_PROMPT_CHARS } from './prompts.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hashPassword,
  login,
  MIN_PASSWORD_LENGTH,
  newApiToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  Sessions,
  tokenHash,
  validAdminName,
  verifyPassword,
} from './auth.js';
import { CompileError, toolReadiness, type TrustedBotSender } from './compile.js';
import {
  buildCostsView,
  COST_GROUPS,
  CostInputError,
  costsCsv,
  isCostGroup,
  MAX_COST_BODY_BYTES,
  parseCostBatch,
  parseCostRange,
  RUN_ID,
  utcDay,
  type CostGroup,
  type CostsView,
} from './costs.js';
import type { AdminConfig } from './config.js';
import { BOT_SCOPES, SlackApi, SlackApiError, SlackDirectory } from './slack.js';
import {
  StoreError,
  type AdminStore,
  type AdminUser,
  type Installation,
  type ToolInstance,
  type ToolStatusReport,
} from './store.js';
import {
  ATLASSIAN_READ_OPERATIONS,
  isToolKind,
  TOOL_INSTANCE_ID,
  TOOL_KINDS,
  ToolKindError,
  type ToolKind,
} from './generated/tool-kinds.js';
import type { PageContext } from './views/html.js';
import { ADMIN_CLIENT_JS } from './views/admin-client.js';
import { LIVE_CLIENT_JS } from './views/live-client.js';
import { LiveFeed } from './live.js';
import {
  adminsPage,
  auditPage,
  channelsPage,
  channelToolsPage,
  configPage,
  costsPage,
  loginPage,
  messagePage,
  overviewPage,
  blockedMembersPage,
  tokensPage,
  toolsPage,
  workspacesPage,
  type ChannelToolsView,
  type ModelView,
  type OverviewView,
  type PromptView,
} from './views/pages.js';

const MAX_BODY_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;
const TEAM_ID = /^T[A-Z0-9]{1,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{1,31}$/;
const USER_ID = /^[UW][A-Z0-9]{1,31}$/;
/** Block entries use Slack user IDs, including Enterprise Grid identities. */
const PERSON_ID = /^[UW][A-Z0-9]{1,31}$/;
const PERSON_ID_ERROR = 'use an exact Slack user ID starting with U or W';
const BOT_ID = /^B[A-Z0-9]{1,31}$/;
/** Internal callers that may read a tool secret; anything else is audited as `internal`. */
/**
 * Who may read which credentials. All internal callers share
 * ADMIN_INTERNAL_TOKEN, so this is defense in depth against a confused
 * caller, not an isolation boundary: each process reads only the kinds it
 * serves (the runner: GitLab, for git transport). A Slack instance's
 * credential is its workspace's bot token.
 */
const SECRET_KINDS_BY_CALLER: Record<string, readonly string[]> = {
  runner: ['gitlab'],
  'cli-runtime': ['gitlab', 'atlassian', 'datadog', 'cloudflare', 'slack'],
};
const STATUS_REPORTERS = ['cli-runtime', 'web-runtime'];
const MAX_STATUS_REPORTS = 256;
const TOOL_STATES = ['ready', 'error', 'blocked'];

export interface AppDeps {
  config: AdminConfig;
  store: AdminStore;
  slack: SlackApi;
  /** Cached channel and user listings; defaults to one over `slack`. */
  directory?: SlackDirectory;
  log?: (line: string) => void;
  /** Topic versions for cost, audit and configuration change notices. */
  feed?: LiveFeed;
}

/** what index.ts wires next to the request handler. */
export interface AdminApp {
  (req: IncomingMessage, res: ServerResponse): void;
  /** Resolves a cookie header to its live session (the `/live` upgrade). */
  resolveSession(cookieHeader: string | undefined): Promise<{ id: string; adminId: number } | null>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Session = { id: string; admin: AdminUser; csrf: string };

export function createApp(deps: AppDeps): AdminApp {
  const { config, store, slack } = deps;
  const feed = deps.feed ?? new LiveFeed();
  // Local commits (audit, configuration, cost ledger) bump their topics.
  store.onCommitted = (topics) => feed.bump(topics);
  const wsOrigin = (() => {
    try {
      const url = new URL(config.publicUrl);
      return `wss://${url.host}`;
    } catch {
      return '';
    }
  })();
  const log = deps.log ?? ((line: string) => console.log(line));
  const directory = deps.directory ?? new SlackDirectory(slack);
  const sessions = new Sessions(store, config.sessionKey);
  // Post/redirect/get notices, per session and in memory only.
  const notices = new Map<string, PageContext['notice']>();
  const redirectUri = `${config.publicUrl}/slack/oauth/callback`;
  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    type: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'${wsOrigin.length > 0 ? ` ${wsOrigin}` : ''}; form-action 'self' https://slack.com; frame-ancestors 'none'; base-uri 'none'`,
      ...headers,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers = {}): void =>
    send(res, status, JSON.stringify(body), 'application/json', headers);
  const htmlPage = (res: ServerResponse, body: string, status = 200): void =>
    send(res, status, body, 'text/html; charset=utf-8');
  const redirect = (res: ServerResponse, location: string, headers = {}): void => {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };

  /** What every signed-in page shows: the flash notice and the workspace switcher. */
  const pageContext = async (session: Session | null): Promise<PageContext> => {
    if (session === null) return { adminName: null, csrf: null, studioUrl: config.studioUrl };
    const notice = notices.get(session.id);
    notices.delete(session.id);
    return {
      adminName: session.admin.name,
      csrf: session.csrf,
      studioUrl: config.studioUrl,
      notice,
      workspaces: await store.listInstallations(),
    };
  };
  const flash = (session: Session, kind: 'ok' | 'err', text: string): void => {
    notices.set(session.id, { kind, text });
  };

  const authorizeUrl = async (): Promise<string> => {
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', config.slackClientId);
    url.searchParams.set('scope', BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', await sessions.oauthState());
    return url.toString();
  };

  /** Enable (verified against Slack) or disable one channel. */
  const setChannel = async (
    actor: string,
    teamId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<void> => {
    const stored = await store.channel(teamId, channelId);
    if (!enabled) {
      await store.setChannel(actor, {
        teamId,
        channelId,
        name: stored?.name ?? channelId,
        isPrivate: stored?.isPrivate ?? false,
        botMember: stored?.botMember ?? false,
        enabled: false,
      });
      return;
    }
    const token = await store.botToken(teamId);
    if (token === null) throw new StoreError('the workspace has not completed pairing', 409);
    const live = await slack.channel(token, channelId);
    if (live === null || !live.botMember)
      throw new StoreError('the channel is not visible to the bot', 409);
    await store.setChannel(actor, {
      teamId,
      channelId,
      name: live.name,
      isPrivate: live.isPrivate,
      botMember: live.botMember,
      enabled: true,
    });
  };

  const parseSender = (value: unknown): TrustedBotSender | null => {
    if (value === null) return null;
    const body = (value ?? {}) as Record<string, unknown>;
    const botId = String(body.botId ?? '').trim();
    const userId = String(body.userId ?? '').trim();
    const channelId = String(body.channelId ?? '').trim();
    if (!botId && !userId && !channelId) return null;
    if (!BOT_ID.test(botId) || !USER_ID.test(userId) || !CHANNEL_ID.test(channelId)) {
      throw new HttpError(400, 'a trusted bot sender needs a bot ID, a user ID and a channel ID');
    }
    return { botId, userId, channelId };
  };

  const installationView = (row: Installation): Record<string, unknown> => ({
    teamId: row.teamId,
    teamName: row.teamName,
    status: row.status,
    paired: row.hasToken,
    botUserId: row.botUserId,
    botId: row.botId,
    scopes: row.scopes,
    installedBy: row.installedBy,
    installedAt: row.installedAt,
    lastSeenAt: row.lastSeenAt,
    trustedBotSender: row.trustedBotSender,
  });

  const requireTeam = async (teamId: string): Promise<Installation> => {
    const row = TEAM_ID.test(teamId) ? await store.installation(teamId) : null;
    if (row === null) throw new HttpError(404, 'unknown workspace');
    return row;
  };

  /** The public view of an instance: settings and readiness, never the credential. */
  const instanceView = async (instance: ToolInstance): Promise<Record<string, unknown>> => {
    const status = await store.toolStatus(instance.id);
    // The same readiness a channel assignment compiles with.
    const { ready, detail } = toolReadiness(instance, status ?? undefined);
    return {
      id: instance.id,
      teamId: instance.teamId,
      kind: instance.kind,
      label: instance.label,
      host: instance.host,
      settings: instance.settings,
      hasCredential: instance.hasCredential,
      credentialVersion: instance.credentialVersion,
      status: instance.status,
      ready,
      detail,
      readiness:
        status === null
          ? null
          : {
              state: status.state,
              detail: status.detail,
              toolsCount: status.toolsCount,
              reportedAt: status.reportedAt,
              current: status.credentialVersion === instance.credentialVersion,
            },
      assignedTo: (await store.listChannelTools(instance.teamId))
        .filter((row) => row.instanceId === instance.id)
        .map((row) => row.channelId),
    };
  };

  const requireTeamInstance = async (teamId: string, id: string): Promise<ToolInstance> => {
    const instance = await store.toolInstance(id);
    if (instance === null || instance.teamId !== teamId)
      throw new HttpError(404, 'unknown tool instance');
    return instance;
  };

  const requireChannel = async (teamId: string, channelId: string): Promise<void> => {
    if (!CHANNEL_ID.test(channelId) || (await store.channel(teamId, channelId)) === null)
      throw new HttpError(404, 'unknown channel');
  };

  type ChannelSettings = Awaited<ReturnType<AdminStore['channelSettings']>>;

  /** A channel's tools as the admin sees them and as the agent enforces them. */
  const channelToolsView = async (
    teamId: string,
    channelId: string,
  ): Promise<ChannelToolsView & { teamId: string; channelId: string }> => {
    const tools: ChannelToolsView['tools'] = [];
    for (const row of await store.listChannelTools(teamId, channelId)) {
      const instance = await store.toolInstance(row.instanceId);
      if (instance === null) continue;
      const { ready, detail } = toolReadiness(
        instance,
        (await store.toolStatus(instance.id)) ?? undefined,
      );
      tools.push({ kind: row.kind, instanceId: instance.id, label: instance.label, ready, detail });
    }
    tools.sort((a, b) => TOOL_KINDS.indexOf(a.kind) - TOOL_KINDS.indexOf(b.kind));
    const compiled =
      (await store.currentDocument())?.toolAssignments.find(
        (row) => row.teamId === teamId && row.channelId === channelId,
      ) ?? null;
    const settings = await store.channelSettings(teamId, channelId);
    return {
      teamId,
      channelId,
      fingerprint: settings.fingerprint,
      model: await modelView(teamId, settings),
      prompt: await promptView(teamId, settings),
      autoReplies: settings.autoReplies,
      tools,
      compiled,
    };
  };

  /** Where a channel's (or with null a workspace's) model comes from (D1). */
  const modelView = async (
    teamId: string,
    settings: ChannelSettings | null,
  ): Promise<ModelView> => {
    const channel = settings?.model ?? null;
    const workspace = await store.modelAssignment(teamId, null);
    const deployment = config.models?.defaultKey ?? null;
    const [effective, source] =
      channel !== null
        ? [channel, 'channel' as const]
        : workspace !== null
          ? [workspace, 'workspace' as const]
          : [deployment, 'deployment' as const];
    const entry = config.models?.entries?.find(({ key }) => key === effective);
    return {
      fingerprint: settings?.fingerprint ?? null,
      effective,
      source,
      channel,
      workspace,
      deployment,
      // Show missing keys explicitly so an admin can correct the assignment.
      available: effective === null || (config.models?.keys.includes(effective) ?? false),
      keys: config.models?.keys ?? [],
      ...(config.models?.entries
        ? {
            route: entry?.route ?? null,
            modelId: entry?.model ?? null,
            webSearch: entry?.webSearch ?? false,
          }
        : {}),
    };
  };

  /** Where a channel's (or with null a workspace's) system prompt comes from (D1). */
  const promptView = async (
    teamId: string,
    settings: ChannelSettings | null,
  ): Promise<PromptView> => {
    const channel = settings?.prompt ?? null;
    const workspace = await store.promptAssignment(teamId, null);
    const [effective, source] =
      channel !== null
        ? [channel, 'channel' as const]
        : workspace !== null
          ? [workspace, 'workspace' as const]
          : [null, 'none' as const];
    return {
      fingerprint: settings?.fingerprint ?? null,
      effective,
      source,
      channel,
      workspace,
      chars: effective?.length ?? 0,
      maxChars: MAX_CHANNEL_PROMPT_CHARS,
    };
  };

  /** A model form or API body value: a key, or null/"inherit" to clear. */
  const parseModelKey = (value: unknown): string | null => {
    if (value === null || value === 'inherit' || value === '') return null;
    if (typeof value !== 'string') throw new HttpError(400, 'key must be a model key or null');
    return value;
  };

  const oauthCallback = async (
    req: Request,
    res: ServerResponse,
    session: Session | null,
  ): Promise<void> => {
    const context = await pageContext(session);
    const state = req.query.get('state') ?? '';
    if (!(await sessions.consumeOauthState(state))) {
      htmlPage(
        res,
        messagePage(
          'Installation failed',
          context,
          'The install link expired or was already used.',
        ),
        400,
      );
      return;
    }
    const code = req.query.get('code') ?? '';
    if (code.length === 0) {
      htmlPage(
        res,
        messagePage('Installation cancelled', context, 'Slack returned no authorization code.'),
        400,
      );
      return;
    }
    let installation: Installation;
    try {
      const exchanged = await slack.exchangeCode({
        clientId: config.slackClientId,
        clientSecret: config.slackClientSecret,
        code,
        redirectUri,
      });
      const identity = await slack.identity(exchanged.botToken);
      if (identity.teamId !== exchanged.teamId || identity.botUserId !== exchanged.botUserId) {
        throw new SlackApiError('auth.test', 'identity_mismatch');
      }
      if (!BOT_ID.test(identity.botId)) throw new SlackApiError('auth.test', 'no_bot_id');
      installation = await store.saveInstallation(
        session?.admin.name ?? `slack:${exchanged.installerUserId || 'unknown'}`,
        {
          teamId: exchanged.teamId,
          teamName: exchanged.teamName,
          botUserId: exchanged.botUserId,
          botId: identity.botId,
          botToken: exchanged.botToken,
          scopes: exchanged.scopes,
        },
      );
      directory.forget(installation.teamId);
    } catch (err) {
      const reason = err instanceof SlackApiError ? err.code : 'internal error';
      log(`oauth callback failed: ${reason}`);
      htmlPage(
        res,
        messagePage('Installation failed', context, `Slack pairing failed: ${reason}.`),
        502,
      );
      return;
    }
    log(`workspace paired team=${installation.teamId} status=${installation.status}`);
    const text =
      installation.status === 'whitelisted'
        ? `Workspace ${installation.teamName} reinstalled; it stays whitelisted.`
        : `Workspace ${installation.teamName} installed. It stays unusable until an admin whitelists it.`;
    if (session !== null) {
      flash(session, 'ok', text);
      redirect(res, '/workspaces');
      return;
    }
    htmlPage(res, messagePage('Workspace installed', context, text));
  };

  // -- internal API ----------------------------------------------------------

  const commands = new ChannelCommands(store, () => config.models?.keys ?? null);

  const internal = async (req: Request, res: ServerResponse): Promise<void> => {
    if (
      req.headers['x-forwarded-for'] !== undefined ||
      req.headers['x-forwarded-proto'] !== undefined ||
      req.headers['x-forwarded-host'] !== undefined
    ) {
      throw new HttpError(404, 'not found');
    }
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), config.internalToken)) {
      throw new HttpError(401, 'unauthorized');
    }
    if (req.method === 'POST' && req.path.startsWith('/internal/channel-commands/')) {
      const b = req.body;
      const route = req.path.slice('/internal/channel-commands/'.length);
      if (['execute', 'open', 'save'].includes(route)) {
        const team = String(b.teamId),
          actor = String(b.userId);
        const channel =
          route === 'save'
            ? await commands.sessionChannel(String(b.session), team, actor)
            : String(b.channelId);
        const token = await store.botToken(team);
        if (!channel || !token || !(await slack.isChannelMember(token, channel, actor)))
          throw new HttpError(403, 'You do not currently belong to this channel.');
      }
      let result: unknown;
      switch (route) {
        case 'execute':
          result = await commands.execute(b as unknown as CommandSource);
          break;
        case 'open':
          result = await commands.open(
            String(b.grant),
            String(b.teamId),
            String(b.channelId),
            String(b.userId),
          );
          break;
        case 'save':
          result = await commands.save(
            String(b.session),
            String(b.teamId),
            String(b.userId),
            {
              model: b.model,
              part1: b.part1,
              part2: b.part2,
              autoReplies: b.autoReplies,
            },
            Math.min(Number(b.deadline), Date.now() + 1800),
          );
          break;
        case 'snapshot':
          result = await commands.snapshot(String(b.teamId), String(b.channelId));
          break;
        case 'claim-receipt':
          result = await commands.claimReceipt();
          break;
        case 'authorize-receipt':
          result = await commands.authorizeReceipt(String(b.id), String(b.lease));
          break;
        case 'report-receipt':
          await commands.reportReceipt(
            String(b.id),
            String(b.lease),
            b.state as 'delivered' | 'uncertain' | 'failed',
            typeof b.ts === 'string' ? b.ts : undefined,
            typeof b.retryAfterMs === 'number' ? b.retryAfterMs : undefined,
          );
          result = { ok: true };
          break;
        default:
          throw new HttpError(404, 'not found');
      }
      json(res, 200, result);
      return;
    }
    if (req.method === 'GET' && req.path === '/internal/config') {
      const document = await store.currentDocument();
      if (document === null) throw new HttpError(503, 'no configuration document');
      const etag = `"${document.hash}"`;
      const match = (req.headers['if-none-match'] ?? '').split(',').map((v) => v.trim());
      if (match.includes(etag) || match.includes(document.hash)) {
        res.writeHead(304, { etag, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      json(res, 200, document, { etag });
      return;
    }
    const token = /^\/internal\/installations\/([A-Z0-9]+)\/token$/.exec(req.path);
    if (req.method === 'GET' && token !== null) {
      const teamId = token[1] as string;
      const botToken = await store.transaction(async () => {
        const row = TEAM_ID.test(teamId) ? await store.installation(teamId) : null;
        const token = row?.status === 'whitelisted' ? await store.botToken(teamId) : null;
        if (token === null) throw new HttpError(404, 'no whitelisted installation');
        await store.audit('adapter', 'installation.token.read', teamId);
        return token;
      });
      json(res, 200, { teamId, botToken });
      return;
    }
    const notice = /^\/internal\/installations\/([A-Z0-9]+)\/notice-token$/.exec(req.path);
    if (req.method === 'GET' && notice !== null) {
      // A paired workspace that is not whitelisted is not served, but the
      // adapter may tell the person who mentioned the bot why: this token is
      // used for that private notice only.
      const teamId = notice[1] as string;
      const result = await store.transaction(async () => {
        const row = TEAM_ID.test(teamId) ? await store.installation(teamId) : null;
        const botToken =
          row !== null && row.status !== 'whitelisted' ? await store.botToken(teamId) : null;
        if (row === null || botToken === null) throw new HttpError(404, 'no paired installation');
        await store.audit('adapter', 'installation.notice.token.read', teamId);
        return { teamId, status: row.status, botUserId: row.botUserId, botId: row.botId, botToken };
      });
      json(res, 200, result);
      return;
    }
    if (req.method === 'GET' && req.path === '/internal/tool-instances') {
      // Enabled instances of whitelisted workspaces, with every non-secret
      // setting the runtimes need; never a credential.
      const body = await store.transaction(async () => {
        const whitelisted = new Set(
          (await store.listInstallations())
            .filter((row) => row.status === 'whitelisted')
            .map((row) => row.teamId),
        );
        const instances = (await store.listToolInstances())
          .filter((row) => row.status === 'enabled' && whitelisted.has(row.teamId))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({
            id: row.id,
            teamId: row.teamId,
            kind: row.kind,
            label: row.label,
            host: row.host,
            settings: row.settings,
            credentialVersion: row.credentialVersion,
            hasCredential: row.hasCredential,
          }));
        return JSON.stringify({
          configVersion: (await store.currentDocument())?.version ?? null,
          instances,
        });
      });
      const hash = createHash('sha256').update(body).digest('hex');
      const etag = `"${hash}"`;
      const match = (req.headers['if-none-match'] ?? '').split(',').map((v) => v.trim());
      if (match.includes(etag) || match.includes(hash)) {
        res.writeHead(304, { etag, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      send(res, 200, body, 'application/json', { etag });
      return;
    }
    const secret = /^\/internal\/tool-instances\/([^/]+)\/secret$/.exec(req.path);
    if (req.method === 'GET' && secret !== null) {
      const id = secret[1] as string;
      const caller = String(req.headers['x-support-agent-caller'] ?? '');
      const result = await store.transaction(async () => {
        const instance = TOOL_INSTANCE_ID.test(id) ? await store.toolInstance(id) : null;
        const workspace = instance === null ? null : await store.installation(instance.teamId);
        const stored =
          instance !== null && workspace?.status === 'whitelisted'
            ? await store.toolSecret(id)
            : null;
        if (instance === null || stored === null)
          throw new HttpError(
            404,
            instance?.kind === 'slack' ? 'no whitelisted installation' : 'no usable credential',
          );
        if (!(SECRET_KINDS_BY_CALLER[caller] ?? []).includes(instance.kind)) {
          await store.audit('internal', 'tool.secret.refused', id, { caller: caller.slice(0, 32) });
          return null;
        }
        await store.audit(caller, 'tool.secret.read', id, {
          credentialVersion: stored.credentialVersion,
        });
        return { id, kind: instance.kind, teamId: instance.teamId, ...stored };
      });
      if (result === null)
        throw new HttpError(
          403,
          `caller ${caller.slice(0, 32) || '(none)'} may not read this credential`,
        );
      json(res, 200, result);
      return;
    }
    if (req.method === 'POST' && req.path === '/internal/tool-instances/status') {
      const reporter = String(req.body.reporter ?? '');
      if (!STATUS_REPORTERS.includes(reporter))
        throw new HttpError(400, `reporter must be one of ${STATUS_REPORTERS.join(', ')}`);
      await store.recordToolStatus(reporter, parseStatusReports(req.body.statuses));
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.path === '/internal/costs/requests') {
      // Inference requests of one run, for the live driver's request budget.
      const runId = req.query.get('runId') ?? '';
      if (!RUN_ID.test(runId)) throw new HttpError(400, 'runId must be a run ID');
      const inference = await store.costRequestsForRun(runId);
      json(res, 200, {
        runId,
        requests: inference.reduce((count, row) => count + row.requests, 0),
        inference,
      });
      return;
    }
    if (req.method === 'POST' && req.path === '/internal/costs') {
      // Cost ledger rows from the runner: validated field by field, stored idempotently, never audited.
      const stored = await store.recordCostRows(parseCostBatch(req.body));
      json(res, 200, { stored });
      return;
    }
    if (req.method === 'POST' && req.path === '/internal/installations/seen') {
      const teamId = String(req.body.teamId ?? '');
      if (!TEAM_ID.test(teamId)) throw new HttpError(400, 'teamId must be a Slack workspace ID');
      await store.recordSeen(teamId);
      res.writeHead(204);
      res.end();
      return;
    }
    throw new HttpError(404, 'not found');
  };

  // -- JSON API ----------------------------------------------------------------

  /** Tool instance, assignment and limit routes (explicit patterns: IDs are lowercase). */
  const toolApi = async (req: Request, res: ServerResponse, actor: string): Promise<boolean> => {
    const tools = /^\/api\/installations\/([^/]+)\/tools(?:\/([^/]+))?$/.exec(req.path);
    if (tools !== null) {
      const teamId = (await requireTeam(tools[1] as string)).teamId;
      const id = tools[2];
      if (id === undefined && req.method === 'GET') {
        json(res, 200, {
          instances: await Promise.all((await store.listToolInstances(teamId)).map(instanceView)),
        });
        return true;
      }
      if (id === undefined && req.method === 'POST') {
        const { instance, document } = await store.createToolInstance(actor, teamId, {
          kind: req.body.kind,
          label: req.body.label,
          host: req.body.host,
          settings: req.body.settings,
          credential: req.body.credential,
        });
        json(res, 201, { instance: await instanceView(instance), configVersion: document.version });
        return true;
      }
      if (id !== undefined && req.method === 'PUT') {
        await requireTeamInstance(teamId, id);
        const { instance, document } = await store.updateToolInstance(actor, id, {
          label: req.body.label,
          host: req.body.host,
          settings: req.body.settings,
          credential: req.body.credential,
          status: req.body.status,
        });
        json(res, 200, { instance: await instanceView(instance), configVersion: document.version });
        return true;
      }
      if (id !== undefined && req.method === 'DELETE') {
        await requireTeamInstance(teamId, id);
        const document = await store.deleteToolInstance(actor, id);
        json(res, 200, { configVersion: document.version });
        return true;
      }
      throw new HttpError(405, 'method not allowed');
    }
    const workspaceModel = /^\/api\/installations\/([^/]+)\/model$/.exec(req.path);
    if (workspaceModel !== null) {
      const teamId = (await requireTeam(workspaceModel[1] as string)).teamId;
      if (req.method === 'GET') {
        json(res, 200, await modelView(teamId, null));
        return true;
      }
      if (req.method !== 'PUT') throw new HttpError(405, 'method not allowed');
      if (req.body.key === undefined) throw new HttpError(400, 'key must be a model key or null');
      const document = await store.setWorkspaceModel(
        actor,
        teamId,
        parseModelKey(req.body.key),
        config.models?.keys ?? null,
      );
      json(res, 200, { ...(await modelView(teamId, null)), configVersion: document.version });
      return true;
    }
    const workspacePrompt = /^\/api\/installations\/([^/]+)\/prompt$/.exec(req.path);
    if (workspacePrompt !== null) {
      const teamId = (await requireTeam(workspacePrompt[1] as string)).teamId;
      if (req.method === 'GET') {
        json(res, 200, await promptView(teamId, null));
        return true;
      }
      if (req.method !== 'PUT') throw new HttpError(405, 'method not allowed');
      if (req.body.text === undefined) throw new HttpError(400, 'text must be a string or null');
      const document = await store.setWorkspacePrompt(actor, teamId, req.body.text);
      json(res, 200, { ...(await promptView(teamId, null)), configVersion: document.version });
      return true;
    }
    const channel =
      /^\/api\/installations\/([^/]+)\/channels\/([^/]+)\/(tools|model|prompt|replies)(?:\/([^/]+))?$/.exec(
        req.path,
      );
    if (channel === null) return false;
    const teamId = (await requireTeam(channel[1] as string)).teamId;
    const channelId = channel[2] as string;
    await requireChannel(teamId, channelId);
    const [section, kind] = [channel[3], channel[4]];
    if (section === 'tools' && kind === undefined && req.method === 'GET') {
      json(res, 200, await channelToolsView(teamId, channelId));
      return true;
    }
    if (section === 'tools' && kind !== undefined) {
      if (!isToolKind(kind)) throw new HttpError(404, 'unknown tool kind');
      if (req.method === 'PUT') {
        const instanceId = String(req.body.instanceId ?? '');
        if (!TOOL_INSTANCE_ID.test(instanceId))
          throw new HttpError(400, 'instanceId must be a tool instance ID');
        const document = await store.assignTool(actor, teamId, channelId, kind, instanceId);
        json(res, 200, {
          ...(await channelToolsView(teamId, channelId)),
          configVersion: document.version,
        });
        return true;
      }
      if (req.method === 'DELETE') {
        const document = await store.unassignTool(actor, teamId, channelId, kind);
        json(res, 200, {
          ...(await channelToolsView(teamId, channelId)),
          configVersion: document.version,
        });
        return true;
      }
    }
    if (section === 'model' && kind === undefined && req.method === 'PUT') {
      if (req.body.key === undefined) throw new HttpError(400, 'key must be a model key or null');
      const document = (
        await store.setChannelSettings(
          actor,
          teamId,
          channelId,
          req.body.fingerprint,
          { model: parseModelKey(req.body.key) },
          config.models?.keys ?? null,
        )
      ).document;
      json(res, 200, {
        ...(await channelToolsView(teamId, channelId)),
        configVersion: document.version,
      });
      return true;
    }
    if (section === 'replies' && kind === undefined && req.method === 'PUT') {
      if (typeof req.body.autoReplies !== 'boolean')
        throw new HttpError(400, 'autoReplies must be true or false');
      const document = (
        await store.setChannelSettings(
          actor,
          teamId,
          channelId,
          req.body.fingerprint,
          { autoReplies: req.body.autoReplies },
          config.models?.keys ?? null,
        )
      ).document;
      json(res, 200, {
        ...(await channelToolsView(teamId, channelId)),
        configVersion: document.version,
      });
      return true;
    }
    if (section === 'prompt' && kind === undefined && req.method === 'PUT') {
      if (req.body.text === undefined) throw new HttpError(400, 'text must be a string or null');
      const document = (
        await store.setChannelSettings(
          actor,
          teamId,
          channelId,
          req.body.fingerprint,
          { prompt: req.body.text },
          config.models?.keys ?? null,
        )
      ).document;
      json(res, 200, {
        ...(await promptView(teamId, await store.channelSettings(teamId, channelId))),
        configVersion: document.version,
      });
      return true;
    }
    throw new HttpError(405, 'method not allowed');
  };

  const api = async (req: Request, res: ServerResponse): Promise<void> => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ')
      ? await store.apiTokenByHash(tokenHash(auth.slice(7)))
      : null;
    if (token === null) throw new HttpError(401, 'unauthorized');
    const actor = `token:${token.name}`;
    if (req.method === 'GET' && req.path === '/api/channel-command-receipts') {
      const receipts = await store.all(
        `SELECT id, team_id AS "teamId", channel_id AS "channelId", thread_ts AS "threadTs", state,
          attempts, slack_ts AS "slackTs", committed_at AS "committedAt", last_error AS "lastError"
         FROM channel_command_receipts ORDER BY committed_at DESC LIMIT 200`,
      );
      json(res, 200, { receipts });
      return;
    }
    if (await toolApi(req, res, actor)) return;
    const parts = req.path.split('/').slice(2);
    const route = `${req.method} /${parts
      .map((part, index) => (index > 0 && /^[A-Z0-9]+$/.test(part) ? ':id' : part))
      .join('/')}`;
    switch (route) {
      case 'GET /config':
        json(res, 200, await store.currentDocument());
        return;
      case 'GET /installations':
        json(res, 200, { installations: (await store.listInstallations()).map(installationView) });
        return;
      case 'POST /installations/authorize':
        json(res, 200, { url: await authorizeUrl() });
        return;
      case 'PATCH /installations/:id': {
        const teamId = (await requireTeam(parts[1] as string)).teamId;
        // Validate everything first, then store all changes in one transaction.
        const change: Parameters<AdminStore['updateInstallation']>[2] = {};
        if (req.body.status !== undefined) {
          const status = String(req.body.status);
          if (!['pending', 'whitelisted', 'disabled'].includes(status)) {
            throw new HttpError(400, 'status must be pending, whitelisted, or disabled');
          }
          change.status = status as Installation['status'];
        }
        if (req.body.trustedBotSender !== undefined) {
          change.trustedBotSender = parseSender(req.body.trustedBotSender);
        }
        const document =
          Object.keys(change).length === 0
            ? await store.currentDocument()
            : await store.updateInstallation(actor, teamId, change);
        json(res, 200, {
          installation: installationView(await requireTeam(teamId)),
          configVersion: document?.version,
        });
        return;
      }
      case 'DELETE /installations/:id': {
        const teamId = (await requireTeam(parts[1] as string)).teamId;
        const document = await store.deleteInstallation(actor, teamId);
        directory.forget(teamId);
        json(res, 200, { configVersion: document.version });
        return;
      }
      case 'GET /installations/:id/channels': {
        const teamId = (await requireTeam(parts[1] as string)).teamId;
        const body: Record<string, unknown> = { channels: await store.listChannels(teamId) };
        if (req.query.get('live') === '1') {
          const botToken = await store.botToken(teamId);
          if (botToken === null) {
            body.slack = [];
          } else {
            const listing = await directory.channels(
              teamId,
              botToken,
              req.query.get('refresh') === '1',
            );
            if (listing.rows === null) {
              throw new SlackApiError('users.conversations', listing.error ?? 'error');
            }
            body.slack = listing.rows;
            body.slackFetchedAt = listing.fetchedAt;
            if (listing.error !== null) body.slackError = listing.error;
          }
        }
        json(res, 200, body);
        return;
      }
      case 'PUT /installations/:id/channels/:id': {
        const teamId = (await requireTeam(parts[1] as string)).teamId;
        const channelId = parts[3] as string;
        if (!CHANNEL_ID.test(channelId)) throw new HttpError(400, 'invalid channel ID');
        if (typeof req.body.enabled !== 'boolean')
          throw new HttpError(400, 'enabled must be a boolean');
        await setChannel(actor, teamId, channelId, req.body.enabled);
        json(res, 200, {
          channel: await store.channel(teamId, channelId),
          configVersion: (await store.currentDocument())?.version,
        });
        return;
      }
      case 'GET /installations/:id/channels/:id/blocked-members': {
        const teamId = (await requireTeam(parts[1] as string)).teamId;
        json(res, 200, {
          blockedMembers: await store.listBlockedMembers(teamId, parts[3] as string),
        });
        return;
      }
      case 'PUT /installations/:id/channels/:id/blocked-members/:id':
      case 'DELETE /installations/:id/channels/:id/blocked-members/:id': {
        const teamId = (await requireTeam(parts[1] as string)).teamId;
        const [channelId, userId] = [parts[3] as string, parts[5] as string];
        if (!CHANNEL_ID.test(channelId)) throw new HttpError(400, 'invalid channel ID');
        if (!PERSON_ID.test(userId)) throw new HttpError(400, PERSON_ID_ERROR);
        let document;
        if (req.method === 'DELETE') {
          document = await store.unblockMember(actor, { teamId, channelId, userId });
        } else {
          const displayName = req.body.displayName ?? '';
          if (typeof displayName !== 'string')
            throw new HttpError(400, 'displayName must be a string');
          document = await store.blockMember(actor, {
            teamId,
            channelId,
            userId,
            displayName: displayName.slice(0, 128),
          });
        }
        json(res, 200, { configVersion: document.version, hash: document.hash });
        return;
      }
      case 'GET /audit': {
        const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 100) || 100, 1), 1000);
        json(res, 200, { entries: await store.listAudit(limit) });
        return;
      }
      default:
        throw new HttpError(404, 'not found');
    }
  };

  /** Versions of `topics` at this moment (read in the same turn as the data). */
  const liveRegion = (topics: string[]) => ({
    epoch: feed.epoch,
    versions: Object.fromEntries(topics.map((topic) => [topic, feed.version(topic)])),
  });
  // -- Costs (read-only ledger view) ----------------------------------------------

  const costsView = async (query: URLSearchParams, fallback: CostGroup): Promise<CostsView> => {
    const group = query.get('group') ?? fallback;
    if (!isCostGroup(group)) {
      throw new HttpError(400, `group must be one of ${Object.keys(COST_GROUPS).join(', ')}`);
    }
    return buildCostsView(store, parseCostRange(query), group, config.costRetentionDays);
  };

  /** `GET /api/costs` and `GET /costs.csv` for a session or an API token. */
  const costsData = async (req: Request, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    if (req.path === '/api/costs') {
      const view = await costsView(req.query, 'day');
      const { days: _days, ...body } = view;
      void _days;
      json(res, 200, body);
      return;
    }
    const view = await costsView(req.query, 'day');
    send(res, 200, costsCsv(view), 'text/csv; charset=utf-8', {
      'content-disposition': `attachment; filename="costs-${view.group}-${view.from}-${view.to}.csv"`,
    });
  };

  // -- UI ------------------------------------------------------------------------

  /** The Overview: the last 7 days of the ledger and what needs attention. */
  const overview = async (): Promise<OverviewView> => {
    const now = Date.now();
    const range = { from: utcDay(now - 6 * DAY_MS), to: utcDay(now) };
    return {
      costs: await buildCostsView(store, range, 'day', config.costRetentionDays, now),
      installations: await store.listInstallations(),
      channels: await store.listChannels(),
      instances: await store.listToolInstances(),
      statuses: new Map((await store.listToolStatuses()).map((row) => [row.instanceId, row])),
      audit: await store.listAudit(6),
    };
  };

  /** The command palette's destinations: pages, workspaces and their channels. */
  const paletteItems = async (): Promise<
    Array<{ group: string; label: string; sub: string; href: string }>
  > => {
    const installations = await store.listInstallations();
    const names = new Map(installations.map((row) => [row.teamId, row.teamName || row.teamId]));
    const pages: Array<[string, string]> = [
      ['Overview', '/'],
      ['Workspaces', '/workspaces'],
      ['Costs', '/costs'],
      ['Audit log', '/audit'],
      ['Accounts', '/admins'],
      ['API tokens', '/tokens'],
      ['Application settings', '/config'],
      ['Add to Slack', '/slack/install'],
    ];
    return [
      ...pages.map(([label, href]) => ({ group: 'Pages', label, sub: '', href })),
      ...installations
        .filter((row) => row.hasToken)
        .flatMap((row) => [
          {
            group: 'Workspaces',
            label: names.get(row.teamId)!,
            sub: 'Channels',
            href: `/workspaces/${row.teamId}/channels`,
          },
          {
            group: 'Workspaces',
            label: names.get(row.teamId)!,
            sub: 'Tools, model and prompt',
            href: `/workspaces/${row.teamId}/tools`,
          },
        ]),
      ...(await store.listChannels())
        .filter((row) => names.has(row.teamId))
        .map((row) => ({
          group: 'Channels',
          label: `#${row.name || row.channelId}`,
          sub: names.get(row.teamId)!,
          href: `/workspaces/${row.teamId}/channels/${row.channelId}/blocked-members`,
        })),
    ];
  };

  const ui = async (req: Request, res: ServerResponse, session: Session): Promise<void> => {
    const actor = session.admin.name;
    if (req.method === 'POST' && !safeEqual(String(req.body.csrf ?? ''), session.csrf)) {
      throw new HttpError(403, 'invalid form token; reload the page');
    }
    const back = (path: string, kind: 'ok' | 'err', text: string): void => {
      flash(session, kind, text);
      redirect(res, path);
    };
    const parts = req.path.split('/').slice(1);
    if (req.method === 'GET' && req.path === '/') {
      htmlPage(res, overviewPage(await pageContext(session), await overview()));
      return;
    }
    if (req.method === 'GET' && req.path === '/palette.json') {
      json(res, 200, { items: await paletteItems() });
      return;
    }
    if (req.method === 'GET' && req.path === '/workspaces') {
      htmlPage(
        res,
        workspacesPage(
          await pageContext(session),
          await store.listInstallations(),
          (await store.currentDocument())!,
        ),
      );
      return;
    }
    if (req.method === 'GET' && req.path === '/slack/install') {
      redirect(res, await authorizeUrl());
      return;
    }
    if (parts[0] === 'workspaces' && parts[1] !== undefined) {
      const installation = await requireTeam(parts[1]);
      const teamId = installation.teamId;
      const tail = parts.slice(2).join('/');
      if (req.method === 'POST' && tail === 'status') {
        const status = String(req.body.status ?? '');
        if (!['pending', 'whitelisted', 'disabled'].includes(status)) {
          throw new HttpError(400, 'invalid status');
        }
        const document = await store.setInstallationStatus(
          actor,
          teamId,
          status as Installation['status'],
        );
        back(
          '/workspaces',
          'ok',
          `Workspace ${installation.teamName || teamId} is ${status} (config v${document.version}).`,
        );
        return;
      }
      if (req.method === 'POST' && tail === 'trusted-sender') {
        const document = await store.setTrustedBotSender(actor, teamId, parseSender(req.body));
        back('/workspaces', 'ok', `Trusted bot sender saved (config v${document.version}).`);
        return;
      }
      if (req.method === 'POST' && tail === 'delete') {
        const document = await store.deleteInstallation(actor, teamId);
        directory.forget(teamId);
        back('/workspaces', 'ok', `Workspace removed (config v${document.version}).`);
        return;
      }
      if (req.method === 'GET' && tail === 'channels') {
        const botToken = await store.botToken(teamId);
        const live =
          botToken === null
            ? { rows: [], fetchedAt: null, error: null }
            : await directory.channels(teamId, botToken, req.query.get('refresh') === '1');
        htmlPage(
          res,
          channelsPage(
            await pageContext(session),
            installation,
            await store.listChannels(teamId),
            live,
            blockedCounts(await store.listBlockedMembers(teamId)),
          ),
        );
        return;
      }
      const toolsPath = `/workspaces/${teamId}/tools`;
      /** Tool forms report validation and compile refusals as a notice on the page. */
      const toolForm = async (path: string, action: () => string | Promise<string>) => {
        try {
          back(path, 'ok', await action());
        } catch (err) {
          if (
            err instanceof ToolKindError ||
            err instanceof StoreError ||
            err instanceof CompileError ||
            err instanceof HttpError
          ) {
            if (err instanceof StoreError && err.status >= 500) throw err;
            back(path, 'err', err.message);
            return;
          }
          throw err;
        }
      };
      if (parts[2] === 'tools') {
        if (req.method === 'GET' && parts.length === 3) {
          htmlPage(
            res,
            toolsPage(
              await pageContext(session),
              installation,
              await store.listToolInstances(teamId),
              new Map((await store.listToolStatuses()).map((row) => [row.instanceId, row])),
              await store.listChannelTools(teamId),
              await store.listChannels(teamId),
              await modelView(teamId, null),
              await promptView(teamId, null),
            ),
          );
          return;
        }
        if (req.method === 'POST' && parts[3] === 'model' && parts.length === 4) {
          await toolForm(toolsPath, async () => {
            const document = await store.setWorkspaceModel(
              actor,
              teamId,
              parseModelKey(req.body.key),
              config.models?.keys ?? null,
            );
            return `Workspace model saved (config v${document.version}).`;
          });
          return;
        }
        if (req.method === 'POST' && parts[3] === 'prompt' && parts.length === 4) {
          await toolForm(toolsPath, async () => {
            const document = await store.setWorkspacePrompt(
              actor,
              teamId,
              req.body.reset === 'true' ? null : String(req.body.text ?? ''),
            );
            return `Workspace prompt saved (config v${document.version}).`;
          });
          return;
        }
        if (req.method === 'POST' && parts.length === 3) {
          await toolForm(toolsPath, async () => {
            const kind = String(req.body.kind ?? '');
            if (!isToolKind(kind)) throw new HttpError(400, 'unknown tool kind');
            const { instance, document } = await store.createToolInstance(actor, teamId, {
              kind,
              label: req.body.label,
              host: String(req.body.host ?? '').trim() || undefined,
              settings: settingsFromForm(kind, req.body),
              credential: credentialFromForm(kind, req.body),
            });
            return `${instance.label} created (config v${document.version}).`;
          });
          return;
        }
        const id = parts[3];
        if (req.method === 'POST' && id !== undefined && parts.length <= 5) {
          const instance = await requireTeamInstance(teamId, id);
          const action = parts[4];
          await toolForm(toolsPath, async () => {
            if (action === 'delete') {
              const document = await store.deleteToolInstance(actor, id);
              return `${instance.label} deleted (config v${document.version}).`;
            }
            if (action === 'status') {
              const status = req.body.status === 'enabled' ? 'enabled' : 'disabled';
              const { document } = await store.updateToolInstance(actor, id, { status });
              return `${instance.label} ${status} (config v${document.version}).`;
            }
            if (action !== undefined) throw new HttpError(404, 'not found');
            const { document } = await store.updateToolInstance(actor, id, {
              label: req.body.label,
              host: String(req.body.host ?? '').trim() || null,
              settings: settingsFromForm(instance.kind, req.body),
              credential: credentialFromForm(instance.kind, req.body),
            });
            return `${instance.label} saved (config v${document.version}).`;
          });
          return;
        }
      }
      const channelId = parts[3];
      if (
        parts[2] === 'channels' &&
        channelId !== undefined &&
        CHANNEL_ID.test(channelId) &&
        (parts[4] === 'tools' || parts[4] === 'model' || parts[4] === 'prompt')
      ) {
        await requireChannel(teamId, channelId);
        const channelToolsPath = `/workspaces/${teamId}/channels/${channelId}/tools`;
        if (req.method === 'GET' && parts[4] === 'tools' && parts.length === 5) {
          htmlPage(
            res,
            channelToolsPage(
              await pageContext(session),
              installation,
              (await store.channel(teamId, channelId))!,
              await store.listToolInstances(teamId),
              await channelToolsView(teamId, channelId),
            ),
          );
          return;
        }
        if (req.method === 'POST' && parts[4] === 'tools' && parts.length === 5) {
          await toolForm(channelToolsPath, async () => {
            const current = new Map(
              (await store.listChannelTools(teamId, channelId)).map((row) => [
                row.kind,
                row.instanceId,
              ]),
            );
            const change: Partial<Record<ToolKind, string | null>> = {};
            for (const kind of TOOL_KINDS) {
              const value = req.body[`kind_${kind}`];
              if (value === undefined) continue;
              const wanted = value === 'none' || value === '' ? null : String(value);
              if (wanted !== (current.get(kind) ?? null)) change[kind] = wanted;
            }
            if (Object.keys(change).length === 0) return 'No change.';
            const document = await store.setChannelTools(actor, teamId, channelId, change);
            return `Tools saved (config v${document.version}).`;
          });
          return;
        }
        if (req.method === 'POST' && parts[4] === 'model' && parts.length === 5) {
          await toolForm(channelToolsPath, async () => {
            const document = (
              await store.setChannelSettings(
                actor,
                teamId,
                channelId,
                req.body.fingerprint,
                { model: parseModelKey(req.body.key) },
                config.models?.keys ?? null,
              )
            ).document;
            return `Model saved (config v${document.version}).`;
          });
          return;
        }
        if (req.method === 'POST' && parts[4] === 'prompt' && parts.length === 5) {
          await toolForm(channelToolsPath, async () => {
            const document = (
              await store.setChannelSettings(
                actor,
                teamId,
                channelId,
                req.body.fingerprint,
                { prompt: req.body.reset === 'true' ? null : String(req.body.text ?? '') },
                config.models?.keys ?? null,
              )
            ).document;
            return `Prompt saved (config v${document.version}).`;
          });
          return;
        }
      }
      if (parts[2] === 'channels' && channelId !== undefined && CHANNEL_ID.test(channelId)) {
        const channelsPath = `/workspaces/${teamId}/channels`;
        const blockedPath = `${channelsPath}/${channelId}/blocked-members`;
        if (req.method === 'POST' && parts.length === 4) {
          const enabled = req.body.enabled === 'true';
          await setChannel(actor, teamId, channelId, enabled);
          back(
            channelsPath,
            'ok',
            `Channel ${enabled ? 'enabled' : 'disabled'} (config v${(await store.currentDocument())?.version}).`,
          );
          return;
        }
        const channel = await store.channel(teamId, channelId);
        if (channel === null) throw new HttpError(404, 'unknown channel');
        if (req.method === 'GET' && parts[4] === 'blocked-members' && parts.length === 5) {
          const botToken = await store.botToken(teamId);
          const users =
            botToken === null
              ? { rows: [], fetchedAt: null, error: null }
              : await directory.users(teamId, botToken, req.query.get('refresh') === '1');
          htmlPage(
            res,
            blockedMembersPage(
              await pageContext(session),
              installation,
              channel,
              await store.listBlockedMembers(teamId, channelId),
              users,
            ),
          );
          return;
        }
        if (req.method === 'POST' && parts[4] === 'blocked-members' && parts.length === 5) {
          const userId = String(req.body.userId ?? '').trim();
          if (!PERSON_ID.test(userId)) throw new HttpError(400, PERSON_ID_ERROR);
          let displayName = '';
          const botToken = await store.botToken(teamId);
          if (botToken !== null) {
            let user = directory.cachedUser(teamId, botToken, userId);
            if (user === null) {
              try {
                user = await slack.user(botToken, userId);
                // Exact IDs can be blocked even when absent from the directory.
              } catch {
                // Slack is unavailable: the person is still added, without a name.
              }
            }
            displayName = user?.name ?? '';
          }
          const document = await store.blockMember(actor, {
            teamId,
            channelId,
            userId,
            displayName,
          });
          back(blockedPath, 'ok', `Blocked (config v${document.version}).`);
          return;
        }
        if (
          req.method === 'POST' &&
          parts[4] === 'blocked-members' &&
          parts[6] === 'unblock' &&
          parts.length === 7
        ) {
          const userId = parts[5] as string;
          if (!PERSON_ID.test(userId)) throw new HttpError(400, PERSON_ID_ERROR);
          const document = await store.unblockMember(actor, { teamId, channelId, userId });
          back(blockedPath, 'ok', `Unblocked (config v${document.version}).`);
          return;
        }
      }
    }
    if (req.method === 'GET' && req.path === '/admins') {
      htmlPage(
        res,
        adminsPage(await pageContext(session), await store.listAdmins(), session.admin.id),
      );
      return;
    }
    if (req.method === 'POST' && req.path === '/admins') {
      const name = String(req.body.name ?? '').trim();
      if (!validAdminName(name)) throw new HttpError(400, 'invalid admin name');
      const password = String(req.body.password ?? '');
      if (password.length < MIN_PASSWORD_LENGTH) {
        back('/admins', 'err', `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      await store.createAdmin(actor, name, await hashPassword(password));
      back('/admins', 'ok', `Admin ${name} created.`);
      return;
    }
    if (req.method === 'POST' && req.path === '/admins/password') {
      const password = String(req.body.password ?? '');
      if (!(await verifyPassword(String(req.body.current ?? ''), session.admin.passwordHash))) {
        back('/admins', 'err', 'The current password is wrong.');
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        back('/admins', 'err', `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      await store.setAdminPassword(actor, session.admin.name, await hashPassword(password));
      redirect(res, '/login', { 'set-cookie': clearCookie() });
      return;
    }
    const adminId = /^\/admins\/(\d+)$/.exec(req.path);
    if (req.method === 'POST' && adminId !== null) {
      const id = Number(adminId[1]);
      if (id === session.admin.id) throw new HttpError(400, 'you cannot disable yourself');
      await store.setAdminDisabled(actor, id, req.body.disabled === 'true');
      back('/admins', 'ok', 'Admin updated.');
      return;
    }
    if (req.method === 'GET' && req.path === '/tokens') {
      htmlPage(res, tokensPage(await pageContext(session), await store.listApiTokens(), null));
      return;
    }
    if (req.method === 'POST' && req.path === '/tokens') {
      const name = String(req.body.name ?? '').trim();
      if (!validAdminName(name)) throw new HttpError(400, 'invalid token name');
      const token = newApiToken();
      await store.createApiToken(actor, name, tokenHash(token));
      // Shown once in the response body; never redirected through a URL.
      htmlPage(res, tokensPage(await pageContext(session), await store.listApiTokens(), token));
      return;
    }
    const tokenId = /^\/tokens\/(\d+)\/delete$/.exec(req.path);
    if (req.method === 'POST' && tokenId !== null) {
      await store.deleteApiToken(actor, Number(tokenId[1]));
      back('/tokens', 'ok', 'Token deleted.');
      return;
    }
    if (req.method === 'GET' && req.path === '/costs') {
      htmlPage(
        res,
        costsPage(
          await pageContext(session),
          await costsView(req.query, 'channel'),
          liveRegion(['costs']),
        ),
      );
      return;
    }
    if (req.method === 'GET' && req.path === '/audit') {
      htmlPage(
        res,
        auditPage(await pageContext(session), await store.listAudit(200), liveRegion(['audit'])),
      );
      return;
    }
    if (req.method === 'GET' && req.path === '/config') {
      htmlPage(
        res,
        configPage(
          await pageContext(session),
          (await store.currentDocument())!,
          liveRegion(['config']),
        ),
      );
      return;
    }
    throw new HttpError(404, 'not found');
  };

  const handle = async (req: Request, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.path === '/healthz') {
      const document = await store.currentDocument();
      json(res, document === null ? 503 : 200, {
        ok: document !== null,
        service: 'support-agent-admin',
        configVersion: document?.version ?? null,
        configHash: document?.hash ?? null,
      });
      return;
    }
    if (req.path.startsWith('/internal/')) {
      await internal(req, res);
      return;
    }
    if (req.headers['x-forwarded-proto'] !== 'https') {
      throw new HttpError(
        403,
        'HTTPS is required (the admin UI is served through a TLS-terminating reverse proxy only)',
      );
    }
    if (req.path === '/live') {
      // the WebSocket endpoint has no page; upgrades never reach this
      // handler (index.ts routes them to the socket service).
      send(
        res,
        426,
        'This is the WebSocket endpoint for settings change notices. Open /config; the page connects here by itself.',
        'text/plain; charset=utf-8',
        { upgrade: 'websocket', connection: 'Upgrade' },
      );
      return;
    }
    if (req.method === 'GET' && req.path === '/assets/admin.js') {
      send(res, 200, ADMIN_CLIENT_JS, 'text/javascript; charset=utf-8', {
        'cache-control': 'no-cache',
      });
      return;
    }
    if (req.method === 'GET' && req.path === '/assets/live.js') {
      send(res, 200, LIVE_CLIENT_JS, 'text/javascript; charset=utf-8', {
        'cache-control': 'no-cache',
      });
      return;
    }
    const session = await sessions.resolve(cookies(req.headers.cookie)[SESSION_COOKIE]);
    if (req.path === '/api/costs' || req.path === '/costs.csv') {
      // Read-only: the page's CSV link uses the
      // session, automation (the live harness) an API token.
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ')
        ? await store.apiTokenByHash(tokenHash(auth.slice(7)))
        : null;
      if (token === null && session === null) throw new HttpError(401, 'unauthorized');
      await costsData(req, res);
      return;
    }
    if (req.path.startsWith('/api/')) {
      await api(req, res);
      return;
    }
    if (req.path === '/slack/oauth/callback' && req.method === 'GET') {
      await oauthCallback(req, res, session);
      return;
    }
    if (req.path === '/login') {
      if (req.method === 'GET') {
        htmlPage(res, loginPage(await pageContext(null), (await store.adminCount()) === 0));
        return;
      }
      if (req.method === 'POST') {
        const result = await login(
          store,
          String(req.body.name ?? ''),
          String(req.body.password ?? ''),
        );
        if (!result.ok) {
          const text =
            result.reason === 'locked'
              ? 'Too many failed sign-ins; try again in 15 minutes.'
              : result.reason === 'busy'
                ? 'Too many sign-ins at once; try again in a moment.'
                : 'Wrong name or password.';
          htmlPage(
            res,
            loginPage({ adminName: null, csrf: null, notice: { kind: 'err', text } }, false),
            401,
          );
          return;
        }
        const cookie = await sessions.create(result.admin);
        if (cookie === null) throw new HttpError(401, 'Sign in again.');
        redirect(res, '/', {
          'set-cookie': `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
        return;
      }
    }
    if (session === null) {
      if (req.method === 'GET') {
        redirect(res, '/login');
        return;
      }
      throw new HttpError(401, 'sign in first');
    }
    if (req.path === '/logout' && req.method === 'POST') {
      if (!safeEqual(String(req.body.csrf ?? ''), session.csrf))
        throw new HttpError(403, 'invalid form token');
      await sessions.destroy(session.id);
      await store.audit(session.admin.name, 'admin.logout', session.admin.name);
      redirect(res, '/login', { 'set-cookie': clearCookie() });
      return;
    }
    await ui(req, res, session);
  };

  const handler = (incoming: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://admin.internal');
      let request: Request;
      try {
        request = {
          method: incoming.method ?? 'GET',
          path: url.pathname.replace(/\/+$/, '') || '/',
          query: url.searchParams,
          headers: incoming.headers,
          body: await readBody(
            incoming,
            url.pathname === '/internal/costs' ? MAX_COST_BODY_BYTES : MAX_BODY_BYTES,
          ),
        };
        await handle(request, res);
      } catch (err) {
        const status =
          err instanceof HttpError || err instanceof StoreError
            ? err.status
            : err instanceof ToolKindError || err instanceof CostInputError
              ? 400
              : err instanceof CompileError
                ? 409
                : err instanceof SlackApiError
                  ? 502
                  : 500;
        const message =
          status === 500 ? 'internal error' : err instanceof Error ? err.message : 'error';
        if (status === 500) log(`request failed: ${err instanceof Error ? err.name : 'error'}`);
        if (res.headersSent) {
          res.end();
          return;
        }
        const wantsHtml =
          !url.pathname.startsWith('/api/') &&
          !url.pathname.startsWith('/internal/') &&
          (incoming.headers.accept ?? '').includes('text/html');
        if (wantsHtml) {
          htmlPage(res, messagePage('Error', { adminName: null, csrf: null }, message), status);
        } else {
          json(res, status, { error: message });
        }
      }
    })();
  };
  return Object.assign(handler, {
    resolveSession: async (cookieHeader: string | undefined) => {
      const session = await sessions.resolve(cookies(cookieHeader)[SESSION_COOKIE]);
      return session === null ? null : { id: session.id, adminId: session.admin.id };
    },
  });
}

function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('application/json')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'body must be a JSON object');
    }
  }
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  throw new HttpError(415, 'unsupported content type');
}

/** Validates a runtime's readiness reports; unknown instance IDs are ignored by the store. */
function parseStatusReports(value: unknown): ToolStatusReport[] {
  if (!Array.isArray(value) || value.length > MAX_STATUS_REPORTS)
    throw new HttpError(400, `statuses must be a list of at most ${MAX_STATUS_REPORTS} reports`);
  return value.map((entry, index) => {
    const where = `statuses[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new HttpError(400, `${where} must be an object`);
    const row = entry as Record<string, unknown>;
    if (typeof row.instanceId !== 'string' || !TOOL_INSTANCE_ID.test(row.instanceId))
      throw new HttpError(400, `${where}.instanceId must be a tool instance ID`);
    if (typeof row.state !== 'string' || !TOOL_STATES.includes(row.state))
      throw new HttpError(400, `${where}.state must be ready, error or blocked`);
    if (row.detail !== undefined && row.detail !== null && typeof row.detail !== 'string')
      throw new HttpError(400, `${where}.detail must be a string`);
    const count = row.toolsCount;
    if (
      count !== undefined &&
      count !== null &&
      (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
    )
      throw new HttpError(400, `${where}.toolsCount must be a non-negative integer or null`);
    const version = row.credentialVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0)
      throw new HttpError(400, `${where}.credentialVersion must be a non-negative integer`);
    return {
      instanceId: row.instanceId,
      state: row.state as ToolStatusReport['state'],
      detail: typeof row.detail === 'string' ? row.detail : '',
      toolsCount: typeof count === 'number' ? count : null,
      credentialVersion: version,
    };
  });
}

/** Settings of a kind from the UI form fields. */
function settingsFromForm(kind: ToolKind, body: Record<string, unknown>): Record<string, unknown> {
  const field = (name: string): string => String(body[name] ?? '').trim();
  switch (kind) {
    case 'atlassian': {
      const operations = ATLASSIAN_READ_OPERATIONS.filter(
        (name) => body[`op_${name}`] !== undefined,
      );
      return {
        cloudId: field('cloudId'),
        email: field('email'),
        // Every operation checked means "all", including operations added later.
        operations: operations.length === ATLASSIAN_READ_OPERATIONS.length ? null : operations,
      };
    }
    case 'datadog':
      return {
        toolsets: field('toolsets') || 'all',
        denyTools: field('denyTools')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      };
    case 'cloudflare':
      return {
        accountId: field('accountId') || null,
        zones: field('zones')
          .split(/[\s,]+/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      };
    case 'files':
      return { readOnly: body.readOnly !== undefined };
    default:
      return {};
  }
}

/** The credential from the UI form; undefined when every credential field is empty (keep). */
function credentialFromForm(kind: ToolKind, body: Record<string, unknown>): unknown {
  if (kind === 'atlassian') {
    const jira = String(body.credentialJira ?? '').trim();
    const confluence = String(body.credentialConfluence ?? '').trim();
    if (jira === '' && confluence === '') return undefined;
    return { ...(jira === '' ? {} : { jira }), ...(confluence === '' ? {} : { confluence }) };
  }
  const credential = String(body.credential ?? '').trim();
  return credential === '' ? undefined : credential;
}

function blockedCounts(people: Array<{ channelId: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const person of people)
    counts.set(person.channelId, (counts.get(person.channelId) ?? 0) + 1);
  return counts;
}
