/**
 * The Slack Web API calls the admin service makes: the OAuth exchange and
 * identity check at pairing (D7), the bot's channels and the workspace's
 * users for the Channels and Members pages (cached in `SlackDirectory`), and
 * single-item lookups for saves. Token values never appear in errors.
 */

import { createHash } from 'node:crypto';

export const BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'files:read',
  'files:write',
  'channels:history',
  'groups:history',
  'reactions:write',
  'users:read',
  'channels:read',
  'groups:read',
  'users:read.email',
  // Added by Agents & AI Apps (requested to match the app; not used).
  'assistant:write',
  'search:read.public',
];

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackApiError';
  }
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  botMember: boolean;
}

export interface SlackUser {
  id: string;
  name: string;
  isBot: boolean;
}

const MAX_PAGES = 20;
/** A 429 is retried after its `Retry-After` when that is at most this long. */
const MAX_RETRY_WAIT_MS = 5_000;
const MAX_RETRIES = 2;

export class SlackApi {
  private readonly base: string;
  private readonly maxRetryWaitMs: number;

  constructor(options: { apiUrl?: string | undefined; maxRetryWaitMs?: number } = {}) {
    this.base = options.apiUrl ?? 'https://slack.com/api/';
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  }

  async isChannelMember(token: string, channel: string, user: string): Promise<boolean> {
    if (!/^[CG][A-Z0-9]+$/.test(channel) || !/^[UW][A-Z0-9]+$/.test(user)) return false;
    let cursor = '';
    const seen = new Set<string>();
    for (let page = 0; page < 50; page++) {
      const result = await this.call(
        'conversations.members',
        { channel, limit: '200', ...(cursor ? { cursor } : {}) },
        { bearer: token },
      );
      if (!Array.isArray(result.members))
        throw new SlackApiError('conversations.members', 'invalid_members');
      if (result.members.includes(user)) return true;
      cursor = String(
        (result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '',
      ).trim();
      if (!cursor) return false;
      if (seen.has(cursor)) throw new SlackApiError('conversations.members', 'repeated_cursor');
      seen.add(cursor);
    }
    throw new SlackApiError('conversations.members', 'pagination_limit');
  }

  /** One Web API call; a short rate limit is waited out and retried. */
  private async call(
    method: string,
    params: Record<string, string>,
    auth: { bearer?: string; basic?: [string, string] },
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.callOnce(method, params, auth);
      } catch (err) {
        if (!(err instanceof RateLimited)) throw err;
        const waitMs = err.retryAfterSeconds * 1000;
        if (attempt >= MAX_RETRIES || waitMs > this.maxRetryWaitMs) {
          throw new SlackApiError(method, 'ratelimited');
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  private async callOnce(
    method: string,
    params: Record<string, string>,
    auth: { bearer?: string; basic?: [string, string] },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (auth.bearer !== undefined) headers.authorization = `Bearer ${auth.bearer}`;
    if (auth.basic !== undefined) {
      headers.authorization = `Basic ${Buffer.from(auth.basic.join(':')).toString('base64')}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.base}${method}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new SlackApiError(method, err instanceof Error ? err.name : 'network_error');
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? '');
      throw new RateLimited(Number.isFinite(seconds) && seconds >= 0 ? seconds : Infinity);
    }
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new SlackApiError(method, `http_${response.status}`);
    }
    if (body.ok !== true) {
      throw new SlackApiError(
        method,
        typeof body.error === 'string' ? body.error.slice(0, 64) : 'error',
      );
    }
    return body;
  }

  /** `oauth.v2.access`: exchanges the install code for the bot token. */
  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<{
    teamId: string;
    teamName: string;
    botUserId: string;
    botToken: string;
    scopes: string;
    installerUserId: string;
  }> {
    const body = await this.call(
      'oauth.v2.access',
      { code: input.code, redirect_uri: input.redirectUri },
      { basic: [input.clientId, input.clientSecret] },
    );
    const team = (body.team ?? {}) as Record<string, unknown>;
    const installer = (body.authed_user ?? {}) as Record<string, unknown>;
    if (body.is_enterprise_install === true) {
      throw new SlackApiError('oauth.v2.access', 'enterprise_install_not_supported');
    }
    const result = {
      teamId: String(team.id ?? ''),
      teamName: String(team.name ?? ''),
      botUserId: String(body.bot_user_id ?? ''),
      botToken: String(body.access_token ?? ''),
      scopes: String(body.scope ?? ''),
      installerUserId: String(installer.id ?? ''),
    };
    if (
      !/^T[A-Z0-9]+$/.test(result.teamId) ||
      !/^[UW][A-Z0-9]+$/.test(result.botUserId) ||
      !result.botToken.startsWith('xoxb-') ||
      body.token_type !== 'bot'
    ) {
      throw new SlackApiError('oauth.v2.access', 'unexpected_response');
    }
    return result;
  }

  /** `auth.test` with the bot token: the bot_id that marks the app's own messages. */
  async identity(botToken: string): Promise<{ teamId: string; botUserId: string; botId: string }> {
    const body = await this.call('auth.test', {}, { bearer: botToken });
    return {
      teamId: String(body.team_id ?? ''),
      botUserId: String(body.user_id ?? ''),
      botId: String(body.bot_id ?? ''),
    };
  }

  /**
   * The public and private channels the bot is in: the only ones that can be
   * enabled. (`conversations.list` would page through every public channel of
   * the workspace for rows that offer no action.)
   */
  async listChannels(botToken: string): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    for await (const page of this.pages('users.conversations', botToken, {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    })) {
      for (const channel of (page.channels ?? []) as Array<Record<string, unknown>>) {
        const parsed = parseChannel(channel);
        if (parsed !== null) channels.push({ ...parsed, botMember: true });
      }
    }
    return channels.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** `conversations.info`: one channel as the bot sees it; null when not visible or archived. */
  async channel(botToken: string, channelId: string): Promise<SlackChannel | null> {
    let body: Record<string, unknown>;
    try {
      body = await this.call('conversations.info', { channel: channelId }, { bearer: botToken });
    } catch (err) {
      if (err instanceof SlackApiError && err.code === 'channel_not_found') return null;
      throw err;
    }
    const channel = (body.channel ?? {}) as Record<string, unknown>;
    if (channel.is_archived === true) return null;
    const parsed = parseChannel(channel);
    return parsed === null ? null : { ...parsed, botMember: channel.is_member === true };
  }

  /** `users.info`: one active user; null when unknown or deleted. */
  async user(botToken: string, userId: string): Promise<SlackUser | null> {
    let body: Record<string, unknown>;
    try {
      body = await this.call('users.info', { user: userId }, { bearer: botToken });
    } catch (err) {
      if (err instanceof SlackApiError && err.code === 'user_not_found') return null;
      throw err;
    }
    return parseUser((body.user ?? {}) as Record<string, unknown>);
  }

  /** Active users; bots are flagged so the UI can list humans first. */
  async listUsers(botToken: string): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    for await (const page of this.pages('users.list', botToken, { limit: '200' })) {
      for (const user of (page.members ?? []) as Array<Record<string, unknown>>) {
        const parsed = parseUser(user);
        if (parsed !== null) users.push(parsed);
      }
    }
    return users.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async *pages(
    method: string,
    botToken: string,
    params: Record<string, string>,
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.call(
        method,
        { ...params, ...(cursor ? { cursor } : {}) },
        { bearer: botToken },
      );
      yield body;
      const metadata = (body.response_metadata ?? {}) as Record<string, unknown>;
      cursor = typeof metadata.next_cursor === 'string' ? metadata.next_cursor : '';
      if (!cursor) return;
    }
  }
}

class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('ratelimited');
  }
}

function parseChannel(channel: Record<string, unknown>): Omit<SlackChannel, 'botMember'> | null {
  const id = String(channel.id ?? '');
  if (!/^[CG][A-Z0-9]+$/.test(id)) return null;
  return { id, name: String(channel.name ?? id), isPrivate: channel.is_private === true };
}

function parseUser(user: Record<string, unknown>): SlackUser | null {
  const id = String(user.id ?? '');
  if (!/^[UW][A-Z0-9]+$/.test(id) || user.deleted === true || id === 'USLACKBOT') return null;
  const profile = (user.profile ?? {}) as Record<string, unknown>;
  const name =
    String(profile.display_name ?? '') || String(user.real_name ?? '') || String(user.name ?? id);
  return { id, name, isBot: user.is_bot === true };
}

/** A listing as the pages show it: rows (null when never fetched), age and the last error. */
export interface Listing<T> {
  rows: T[] | null;
  fetchedAt: number | null;
  error: string | null;
}

const DIRECTORY_TTL_MS = 10 * 60_000;

interface Entry<T> {
  tokenHash: string;
  rows: T[] | null;
  fetchedAt: number | null;
  inflight: Promise<void> | null;
}

/**
 * Per-workspace cache of the channel and user listings. Pages read it
 * instead of paging through Slack on every render; concurrent readers share
 * one fetch, and a failed refresh keeps serving the last listing with the
 * error. A re-paired workspace (new bot token) starts empty.
 */
export class SlackDirectory {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly slack: SlackApi,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DIRECTORY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  channels(teamId: string, botToken: string, refresh = false): Promise<Listing<SlackChannel>> {
    return this.read(`channels:${teamId}`, botToken, refresh, () =>
      this.slack.listChannels(botToken),
    );
  }

  users(teamId: string, botToken: string, refresh = false): Promise<Listing<SlackUser>> {
    return this.read(`users:${teamId}`, botToken, refresh, () => this.slack.listUsers(botToken));
  }

  /** The cached user, if any listing so far had them; never calls Slack. */
  cachedUser(teamId: string, botToken: string, userId: string): SlackUser | null {
    const entry = this.entries.get(`users:${teamId}`) as Entry<SlackUser> | undefined;
    if (entry === undefined || entry.tokenHash !== hashToken(botToken)) return null;
    return entry.rows?.find((user) => user.id === userId) ?? null;
  }

  /** Drops a workspace's listings (re-pairing, removal, channel changes). */
  forget(teamId: string, kind?: 'channels' | 'users'): void {
    for (const name of kind === undefined ? ['channels', 'users'] : [kind]) {
      this.entries.delete(`${name}:${teamId}`);
    }
  }

  private async read<T>(
    key: string,
    botToken: string,
    refresh: boolean,
    fetchRows: () => Promise<T[]>,
  ): Promise<Listing<T>> {
    const tokenHash = hashToken(botToken);
    let entry = this.entries.get(key) as Entry<T> | undefined;
    if (entry === undefined || entry.tokenHash !== tokenHash) {
      entry = { tokenHash, rows: null, fetchedAt: null, inflight: null };
      this.entries.set(key, entry as Entry<unknown>);
    }
    const fresh = entry.fetchedAt !== null && this.now() - entry.fetchedAt < this.ttlMs;
    if (fresh && !refresh) return { rows: entry.rows, fetchedAt: entry.fetchedAt, error: null };
    const current = entry;
    let error: string | null = null;
    current.inflight ??= (async () => {
      try {
        const rows = await fetchRows();
        current.rows = rows;
        current.fetchedAt = this.now();
      } finally {
        current.inflight = null;
      }
    })();
    try {
      await current.inflight;
    } catch (err) {
      error = err instanceof SlackApiError ? err.code : 'error';
    }
    return { rows: current.rows, fetchedAt: current.fetchedAt, error };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
