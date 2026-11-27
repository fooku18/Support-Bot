import { installationDownload } from './file-download.js';
/**
 * Workspace installations from the admin service (plan D7/D9).
 *
 * One Socket Mode app serves every paired workspace; which workspaces the
 * adapter may act in is decided by the admin service. The registry polls the
 * compiled configuration document (`GET /internal/config`, ETag
 * revalidation) and keeps one verified Slack client per whitelisted team:
 * the team's bot token is fetched from the admin service only when the team
 * is new, its bot identity changed or it was reinstalled, and `auth.test` must report exactly
 * the document's team, bot user and bot. A team that fails verification
 * stays unusable (retried after a back-off); a team that leaves the document
 * is dropped at once, so its events are treated as unknown from then on.
 *
 * Readiness reports stale configuration during an admin outage.
 * Bot tokens are never logged; log lines carry IDs only.
 */

import type { Dispatcher } from 'undici';
import type { BotIdentity } from './intake.js';
import type { StageLogger } from './logger.js';
import { createSlackClient, postEphemeral, type SlackDeps } from './slackclient.js';
import { isApplicationIdentity, type TrustedBotSender } from './generated/trusted-bot-sender.js';

/** A whitelisted, verified workspace: its bot identity and Slack client. */
export interface Installation {
  identity: BotIdentity;
  slack: SlackDeps;
}

export interface InstallationLookup {
  /** The usable installation of a team, or undefined (unknown, removed or unverified). */
  get(teamId: string): Installation | undefined;
}

export interface InstallationRegistryOptions {
  /** Admin service base URL (no trailing slash). */
  adminUrl: string;
  /** Bearer credential for the admin service's internal API. */
  adminToken: string;
  pollIntervalMs: number;
  log: StageLogger;
  /** Test-only fake Slack Web API base URL (synthetic qualification only). */
  slackApiUrl?: string;
  boundedReadRetries?: boolean;
  /** Egress proxy dispatcher for the per-workspace Slack Web API clients. */
  dispatcher?: Dispatcher;
  /** Timeout per admin request (default 10 s). */
  requestTimeoutMs?: number;
  /** Back-off before a failed team setup is retried (default 30 s). */
  setupRetryMs?: number;
  /** Minimum interval between `seen` reports per team (default 60 s). */
  seenIntervalMs?: number;
  /** Minimum interval between "not enabled" notices per team and user (default 10 min). */
  noticeIntervalMs?: number;
  now?: () => number;
}

interface DocumentInstallation {
  teamId: string;
  botUserId: string;
  botId: string;
  trustedBotSender: { botId: string; userId: string; channelId: string } | null;
  /** Last OAuth install: a reinstall (possibly a new bot token) re-keys the team. */
  installedAt: number | null;
}

interface ConfigDocument {
  version: number;
  hash: string;
  installations: DocumentInstallation[];
}

const TEAM_ID = /^T[A-Z0-9]+$/;
const USER_ID = /^[UW][A-Z0-9]+$/;
const BOT_ID = /^B[A-Z0-9]+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;

/** No successful sync for this long (at least 60 s, at least 3 poll intervals) fails readiness. */
export function adminStaleAfterMs(pollIntervalMs: number): number {
  return Math.max(60_000, 3 * pollIntervalMs);
}

export class InstallationRegistry implements InstallationLookup {
  private readonly options: InstallationRegistryOptions;
  private readonly now: () => number;
  private readonly seen: Throttle;
  private readonly notices: Throttle;
  /** Teams of the last applied document. */
  private listed = new Map<string, DocumentInstallation>();
  /** Verified teams; always a subset of `listed`. */
  private readonly ready = new Map<string, { installation: Installation; key: string }>();
  private readonly failed = new Map<string, { key: string; retryAt: number }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private etag: string | undefined;
  private version: number | undefined;
  private lastSyncAt: number | undefined;
  private failing = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private resolveFirstSync!: () => void;
  private readonly firstSyncPromise: Promise<void>;

  constructor(options: InstallationRegistryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.seen = new Throttle(options.seenIntervalMs ?? 60_000, this.now);
    this.notices = new Throttle(options.noticeIntervalMs ?? 600_000, this.now);
    this.firstSyncPromise = new Promise((resolve) => {
      this.resolveFirstSync = resolve;
    });
  }

  /** Version of the last applied configuration document (undefined before the first sync). */
  get configVersion(): number | undefined {
    return this.version;
  }

  /** Number of usable installations. */
  get size(): number {
    return this.ready.size;
  }

  get(teamId: string): Installation | undefined {
    return this.ready.get(teamId)?.installation;
  }

  /** True when a document was applied and the last successful sync is not stale. */
  get synced(): boolean {
    return (
      this.lastSyncAt !== undefined &&
      this.now() - this.lastSyncAt <= adminStaleAfterMs(this.options.pollIntervalMs)
    );
  }

  readiness() {
    if (this.lastSyncAt === undefined) {
      return { name: 'admin_config_synced', ok: false, reason: 'never_evaluated' };
    }
    return this.synced
      ? { name: 'admin_config_synced', ok: true }
      : { name: 'admin_config_synced', ok: false, reason: 'stale' };
  }

  /** Resolves once the first configuration document has been applied. */
  firstSync(): Promise<void> {
    return this.firstSyncPromise;
  }

  /** Starts polling immediately; sync failures are logged and retried. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      this.timer = undefined;
      if (this.stopped) return;
      try {
        await this.syncOnce();
        if (this.failing) {
          this.failing = false;
          this.options.log.info(`admin config reachable again version=${this.version ?? 'n/a'}`);
        }
      } catch (err) {
        // Logged on the transition only: an outage at a 2 s interval would
        // otherwise flood the log. Readiness reports the stale state.
        if (!this.failing) {
          this.failing = true;
          this.options.log.warn(
            `admin config sync failed: ${summary(err)} (keeping version=${this.version ?? 'none'}; retrying)`,
          );
        }
      }
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.options.pollIntervalMs);
        this.timer.unref();
      }
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One sync: revalidates the document and applies a changed one. Team
   * setups (token fetch, auth.test) run in the background so a slow Slack
   * call never delays removals; `settled()` awaits them.
   */
  async syncOnce(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.etag !== undefined) headers['if-none-match'] = this.etag;
    const response = await this.adminFetch('/internal/config', { headers });
    if (response.status === 304 && this.version !== undefined) {
      this.lastSyncAt = this.now();
      this.reconcile();
      return;
    }
    if (response.status !== 200) {
      throw new AdminRequestError(`config request answered HTTP ${response.status}`);
    }
    let document: ConfigDocument | null;
    try {
      document = parseDocument(await response.json());
    } catch {
      document = null;
    }
    if (document === null) {
      throw new AdminRequestError('config document is malformed');
    }
    this.apply(document);
    this.etag = response.headers.get('etag') ?? `"${document.hash}"`;
    this.lastSyncAt = this.now();
    this.resolveFirstSync();
  }

  /** Awaits the team setups currently in flight (tests and diagnostics). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /**
   * Reports an event from a team that is not in the document so the admin
   * service lists it as pending. At most once per team per interval; teams
   * already in the document (whitelisted, not yet verified) are not
   * reported. Never rejects: failures are logged and ignored.
   */
  async reportSeen(teamId: string): Promise<void> {
    if (!TEAM_ID.test(teamId) || this.listed.has(teamId) || !this.seen.allow(teamId)) return;
    try {
      const response = await this.adminFetch('/internal/installations/seen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamId }),
      });
      if (response.status !== 204) {
        this.options.log.warn(`seen report rejected team=${teamId} status=${response.status}`);
      }
    } catch (err) {
      this.options.log.warn(`seen report failed team=${teamId}: ${summary(err)}`);
    }
  }

  /**
   * Tells the person who mentioned the bot in a paired but not whitelisted
   * (pending or disabled) workspace, privately, why the bot does not answer.
   * The admin service hands out that workspace's token for this notice only;
   * nothing else is done with it. At most once per team and user per
   * interval; unknown (never paired) teams get nothing. Never rejects.
   */
  async notifyUnusable(
    teamId: string,
    mention: { channel: string; user: string; threadTs: string },
  ): Promise<void> {
    if (!TEAM_ID.test(teamId) || this.listed.has(teamId)) return;
    if (!this.notices.allow(`${teamId}:${mention.user}`)) return;
    try {
      const response = await this.adminFetch(`/internal/installations/${teamId}/notice-token`, {});
      if (response.status === 404) return;
      if (response.status !== 200) {
        throw new AdminRequestError(`notice token request answered HTTP ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (
        body.teamId !== teamId ||
        typeof body.botToken !== 'string' ||
        !body.botToken.startsWith('xoxb-') ||
        (body.status !== 'pending' && body.status !== 'disabled')
      ) {
        throw new AdminRequestError('notice token response is malformed');
      }
      if (mention.user === body.botUserId) return;
      const webClient = createSlackClient(body.botToken, {
        slackApiUrl: this.options.slackApiUrl,
        dispatcher: this.options.dispatcher,
      });
      await postEphemeral(
        { webClient, botUserId: String(body.botUserId ?? ''), botId: String(body.botId ?? '') },
        { ...mention, thread_ts: mention.threadTs, text: unusableNotice(body.status) },
      );
      this.options.log.info(
        `not-enabled notice sent team=${teamId} user=${safeId(mention.user)} status=${body.status}`,
      );
    } catch (err) {
      this.options.log.warn(`not-enabled notice failed team=${teamId}: ${summary(err)}`);
    }
  }

  private apply(document: ConfigDocument): void {
    const previous = this.listed;
    const changed = this.version !== document.version;
    this.listed = new Map(document.installations.map((entry) => [entry.teamId, entry]));
    this.version = document.version;
    if (changed) {
      this.options.log.info(
        `admin config synced version=${document.version} installations=${document.installations.length}`,
      );
    }
    for (const teamId of previous.keys()) {
      if (this.listed.has(teamId)) continue;
      this.ready.delete(teamId);
      this.failed.delete(teamId);
      this.options.log.info(
        `installation removed team=${teamId} config_version=${document.version}`,
      );
    }
    this.reconcile();
  }

  /** Brings the verified set in line with the listed teams. */
  private reconcile(): void {
    for (const entry of this.listed.values()) {
      const key = identityKey(entry);
      const current = this.ready.get(entry.teamId);
      if (current !== undefined && current.key === key) {
        if (!sameSender(current.installation.identity.trustedBotSender, entry)) {
          this.updateSender(entry, current.installation);
        }
        continue;
      }
      if (current !== undefined) {
        this.ready.delete(entry.teamId);
        this.options.log.warn(
          `installation identity changed team=${entry.teamId}; unusable until verified again`,
        );
      }
      if (this.inFlight.has(entry.teamId)) continue;
      const failed = this.failed.get(entry.teamId);
      if (failed !== undefined && failed.key === key && this.now() < failed.retryAt) continue;
      this.startSetup(entry, key);
    }
  }

  private updateSender(entry: DocumentInstallation, installation: Installation): void {
    try {
      const identity = buildIdentity(entry);
      this.ready.set(entry.teamId, {
        installation: { identity, slack: installation.slack },
        key: identityKey(entry),
      });
      this.options.log.info(
        `installation updated team=${entry.teamId} trusted_bot_sender=${identity.trustedBotSender === undefined ? 'none' : identity.trustedBotSender.botId} config_version=${this.version ?? 'n/a'}`,
      );
    } catch (err) {
      this.ready.delete(entry.teamId);
      this.failed.set(entry.teamId, {
        key: identityKey(entry),
        retryAt: this.now() + (this.options.setupRetryMs ?? 30_000),
      });
      this.options.log.error(`installation unusable team=${entry.teamId}: ${summary(err)}`);
    }
  }

  private startSetup(entry: DocumentInstallation, key: string): void {
    const { teamId } = entry;
    const setup = (async (): Promise<void> => {
      try {
        const token = await this.fetchToken(teamId);
        const webClient = createSlackClient(token, {
          slackApiUrl: this.options.slackApiUrl,
          dispatcher: this.options.dispatcher,
          boundedReadRetries: this.options.boundedReadRetries,
        });
        const auth = await webClient.auth.test({});
        if (
          auth.team_id !== entry.teamId ||
          auth.user_id !== entry.botUserId ||
          auth.bot_id !== entry.botId
        ) {
          throw new InstallationSetupError(
            `auth.test identity mismatch (expected bot_user_id=${entry.botUserId} bot_id=${entry.botId}; got team_id=${safeId(auth.team_id)} bot_user_id=${safeId(auth.user_id)} bot_id=${safeId(auth.bot_id)})`,
          );
        }
        // Removed or re-keyed while in flight: discard; reconcile decides again.
        const listed = this.listed.get(teamId);
        if (listed === undefined || identityKey(listed) !== key) return;
        const identity = buildIdentity(listed);
        this.ready.set(teamId, {
          installation: {
            identity,
            slack: {
              webClient,
              downloadFile: installationDownload(token),
              fileDispatcher: this.options.dispatcher,
              botUserId: identity.botUserId,
              botId: identity.botId,
              receiptWebClient: createSlackClient(token, {
                slackApiUrl: this.options.slackApiUrl,
                dispatcher: this.options.dispatcher,
                receiptTransport: true,
              }),
            },
          },
          key,
        });
        this.failed.delete(teamId);
        this.options.log.info(
          `installation ready team=${teamId} bot_user_id=${identity.botUserId} config_version=${this.version ?? 'n/a'}`,
        );
      } catch (err) {
        this.failed.set(teamId, {
          key,
          retryAt: this.now() + (this.options.setupRetryMs ?? 30_000),
        });
        this.options.log.error(`installation unusable team=${teamId}: ${summary(err)}`);
      } finally {
        this.inFlight.delete(teamId);
      }
    })();
    this.inFlight.set(teamId, setup);
  }

  private async fetchToken(teamId: string): Promise<string> {
    const response = await this.adminFetch(`/internal/installations/${teamId}/token`, {});
    if (response.status !== 200) {
      throw new InstallationSetupError(`bot token request answered HTTP ${response.status}`);
    }
    let body: { teamId?: unknown; botToken?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new InstallationSetupError('bot token response is malformed');
    }
    if (
      body.teamId !== teamId ||
      typeof body.botToken !== 'string' ||
      !body.botToken.startsWith('xoxb-')
    ) {
      throw new InstallationSetupError('bot token response is malformed');
    }
    return body.botToken;
  }

  private async adminFetch(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    return await fetch(`${this.options.adminUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...init.headers, authorization: `Bearer ${this.options.adminToken}` },
      body: init.body,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
    });
  }
}

/**
 * In-memory per-key rate limit. The key set is bounded: when full and no
 * entry has expired, further keys are refused (never unbounded growth from
 * arbitrary team IDs).
 */
export class Throttle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 1_000,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const last = this.last.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    if (last === undefined && this.last.size >= this.maxKeys) {
      for (const [other, at] of this.last) {
        if (now - at >= this.windowMs) this.last.delete(other);
      }
      if (this.last.size >= this.maxKeys) return false;
    }
    this.last.set(key, now);
    return true;
  }
}

export class InstallationSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationSetupError';
  }
}

export class AdminRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminRequestError';
  }
}

function buildIdentity(entry: DocumentInstallation): BotIdentity {
  const identity: BotIdentity = {
    teamId: entry.teamId,
    installationId: entry.botUserId,
    botUserId: entry.botUserId,
    botId: entry.botId,
  };
  if (entry.trustedBotSender !== null) {
    const sender: TrustedBotSender = { teamId: entry.teamId, ...entry.trustedBotSender };
    // The admin service checks this too; the application must never be
    // able to trigger itself.
    if (isApplicationIdentity(sender, identity)) {
      throw new InstallationSetupError('the trusted bot sender is the application itself');
    }
    identity.trustedBotSender = sender;
  }
  return identity;
}

function identityKey(entry: DocumentInstallation): string {
  return `${entry.botUserId}:${entry.botId}:${entry.installedAt ?? ''}`;
}

function sameSender(current: TrustedBotSender | undefined, entry: DocumentInstallation): boolean {
  const next = entry.trustedBotSender;
  if (current === undefined || next === null) return current === undefined && next === null;
  return (
    current.botId === next.botId &&
    current.userId === next.userId &&
    current.channelId === next.channelId
  );
}

/** Strict shape check; any malformed entry rejects the whole document (fail closed). */
function parseDocument(raw: unknown): ConfigDocument | null {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof body.version !== 'number' ||
    !Number.isInteger(body.version) ||
    typeof body.hash !== 'string' ||
    body.hash.length === 0 ||
    !Array.isArray(body.installations)
  ) {
    return null;
  }
  const installations: DocumentInstallation[] = [];
  const teams = new Set<string>();
  for (const item of body.installations as unknown[]) {
    const row = (item ?? {}) as Record<string, unknown>;
    const sender = row.trustedBotSender as Record<string, unknown> | null | undefined;
    if (
      typeof row.teamId !== 'string' ||
      !TEAM_ID.test(row.teamId) ||
      teams.has(row.teamId) ||
      typeof row.botUserId !== 'string' ||
      !USER_ID.test(row.botUserId) ||
      typeof row.botId !== 'string' ||
      !BOT_ID.test(row.botId) ||
      (row.installedAt !== undefined &&
        row.installedAt !== null &&
        !Number.isSafeInteger(row.installedAt))
    ) {
      return null;
    }
    let trustedBotSender: DocumentInstallation['trustedBotSender'] = null;
    if (sender !== null && sender !== undefined) {
      if (
        typeof sender.botId !== 'string' ||
        !BOT_ID.test(sender.botId) ||
        typeof sender.userId !== 'string' ||
        !USER_ID.test(sender.userId) ||
        typeof sender.channelId !== 'string' ||
        !CHANNEL_ID.test(sender.channelId)
      ) {
        return null;
      }
      trustedBotSender = {
        botId: sender.botId,
        userId: sender.userId,
        channelId: sender.channelId,
      };
    }
    teams.add(row.teamId);
    installations.push({
      teamId: row.teamId,
      botUserId: row.botUserId,
      botId: row.botId,
      trustedBotSender,
      installedAt: typeof row.installedAt === 'number' ? row.installedAt : null,
    });
  }
  return { version: body.version, hash: body.hash, installations };
}

/** The private answer in a workspace the bot does not serve. */
export function unusableNotice(status: 'pending' | 'disabled'): string {
  return status === 'pending'
    ? 'The bot is not enabled in this workspace yet: an administrator has to approve the workspace first. Your message was not processed.'
    : 'The bot is disabled in this workspace. Ask an administrator to enable it. Your message was not processed.';
}

function safeId(value: string | undefined): string {
  return value !== undefined && /^[A-Z0-9]{1,32}$/.test(value) ? value : 'n/a';
}

/** Error name plus a Slack error code or our own message; never payloads or tokens. */
function summary(err: unknown): string {
  if (err instanceof InstallationSetupError || err instanceof AdminRequestError) {
    return `${err.name}: ${err.message}`;
  }
  if (err instanceof Error) {
    const data = (err as { data?: { error?: unknown } }).data;
    const code =
      typeof data?.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : undefined;
    return code !== undefined ? `${err.name} (${code})` : err.name;
  }
  return 'unknown error';
}
