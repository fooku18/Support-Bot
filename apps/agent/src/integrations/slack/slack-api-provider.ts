/**
 * Runtime-owned Slack provider for one admin-managed instance: the
 * workspace's bot token (read from the admin service, memory only), the
 * readiness probe (`auth.test`: workspace, bot user, granted scopes and
 * whether `search:read.public` is among them) and the
 * endpoint/workspace/credential binding. Readiness exposes only categories,
 * IDs, scope names and a fingerprint, never the token. A message search
 * carries the triggering mention's `action_token` per call; the provider
 * never stores it.
 */
import {
  SLACK_ADAPTER,
  SLACK_CONTRACT_VERSION,
  SLACK_EMAIL_SCOPE,
  SLACK_ENDPOINT,
  SLACK_SEARCH_MAX_PAGES,
  SLACK_SEARCH_SCOPE,
  SLACK_TEAM_ID,
  SLACK_USERS_SCOPE,
  SLACK_USER_ID,
  SlackRequestError,
  normalizeSlackSearchResult,
  normalizeSlackUserResult,
  sendSlackRequest,
  slackCredentialFingerprint,
  slackFailure,
  slackSearchBody,
  slackSearchOutput,
  validateSlackRequest,
  type SlackCallResult,
  type SlackFetch,
  type SlackOperation,
  type SlackSearchMessage,
} from './slack-api-adapter.js';
import type { SlackRuntimeProviderStatus } from '../tools/tool-runtime-readiness.js';
import {
  ReadinessGrace,
  probeWithRetry,
  type ReadinessRetryOptions,
} from '../tools/readiness-grace.js';

/** Readiness is re-probed at most this often (on /readyz). */
export const SLACK_READINESS_REFRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;

/** One admin-managed Slack instance: its workspace and the workspace's bot token. */
export interface SlackInstanceConfig {
  teamId: string;
  token: string;
}

export class SlackApiProvider {
  readonly state: SlackRuntimeProviderStatus;
  private readonly token: string;
  private readonly teamId: string;
  /** The workspace's `<team>.slack.com` host from auth.test (permalink filter). */
  private workspaceHost: string | null = null;
  private checkedAtMs = 0;
  private probing: Promise<SlackRuntimeProviderStatus> | null = null;
  readonly grace: ReadinessGrace;
  private readyDetail = '';

  constructor(
    config: SlackInstanceConfig,
    private readonly fetchImpl?: SlackFetch,
    private readonly now: () => number = Date.now,
    private readonly retry: ReadinessRetryOptions = {},
  ) {
    this.grace = new ReadinessGrace(now, retry);
    const token = config.token.trim();
    this.token = token;
    this.teamId = config.teamId;
    this.state = {
      tool: 'slack',
      enabled: true,
      ready: false,
      status: 'missing_config',
      detail: '',
      endpoint: SLACK_ENDPOINT,
      adapter: SLACK_ADAPTER,
      contractVersion: SLACK_CONTRACT_VERSION,
      teamId: null,
      botUserId: null,
      scopes: [],
      searchScope: false,
      credentialFingerprint: null,
      checkedAt: null,
    };
    if (!SLACK_TEAM_ID.test(config.teamId)) {
      this.state.detail = 'the Slack instance names no valid workspace';
      return;
    }
    if (!/^xoxb-[A-Za-z0-9-]{8,}$/.test(token)) {
      this.state.detail = "the workspace's bot token is missing or malformed";
      return;
    }
    this.state.credentialFingerprint = slackCredentialFingerprint(token);
    this.state.status = 'error';
    this.state.detail = 'readiness has not been established yet';
  }

  /** Values this runtime must redact. */
  secrets(): string[] {
    return this.token.length >= 4 ? [this.token] : [];
  }

  get configured(): boolean {
    return this.state.credentialFingerprint !== null;
  }

  /** One auth.test probe: workspace, bot user and scopes, or the failure category. */
  private async probeOnce(): Promise<{
    category: string | null;
    detail: string;
    teamId: string | null;
    botUserId: string | null;
    scopes: string[];
  }> {
    let category: string | null = null;
    let detail = '';
    let teamId: string | null = null;
    let botUserId: string | null = null;
    let scopes: string[] = [];
    try {
      const http = await sendSlackRequest('auth.test', { verb: 'GET', params: {} }, this.token, {
        timeoutMs: PROBE_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      });
      if (http.errorCategory) category = http.errorCategory;
      else {
        const team = http.body?.team_id;
        const user = http.body?.user_id;
        teamId = typeof team === 'string' && SLACK_TEAM_ID.test(team) ? team : null;
        botUserId = typeof user === 'string' && SLACK_USER_ID.test(user) ? user : null;
        scopes = http.scopes ?? [];
        this.workspaceHost = workspaceHostOf(http.body?.url);
        if (teamId === null || botUserId === null) category = 'invalid_shape';
        else if (teamId !== this.teamId) {
          category = 'workspace_mismatch';
          detail = 'workspace mismatch: the bot token belongs to another workspace';
        } else if (http.scopes === null) {
          category = 'invalid_shape';
          detail = 'Slack did not report the granted scopes';
        } else {
          // users:read.email is optional: without it Slack omits e-mails
          // and refuses the lookup by e-mail, which the agent reports.
          if (!scopes.includes(SLACK_USERS_SCOPE)) {
            category = 'missing_scope';
            detail = `missing_scope ${SLACK_USERS_SCOPE} (add the scope and reinstall through Add to Slack)`;
          }
        }
      }
    } catch {
      category = 'network';
    }
    return { category, detail, teamId, botUserId, scopes };
  }

  /**
   * Probes the token with auth.test and recomputes workspace, bot user and
   * scopes. Transient failures are retried, and while the instance was ready
   * they keep the last good state within the grace bounds.
   */
  async refresh(): Promise<SlackRuntimeProviderStatus> {
    if (!this.configured) return this.state;
    this.probing ??= (async () => {
      try {
        const { category, detail, teamId, botUserId, scopes } = await probeWithRetry(
          () => this.probeOnce(),
          (o) => o.category,
          this.retry,
        );
        if (this.grace.hold(category, this.state.ready)) {
          this.state.detail = `${this.readyDetail}${this.grace.note()}`;
          this.checkedAtMs = this.now();
          this.state.checkedAt = new Date(this.checkedAtMs).toISOString();
          return this.state;
        }
        this.state.ready = category === null;
        this.state.status = category ?? 'ready';
        this.state.teamId = teamId;
        this.state.botUserId = botUserId;
        this.state.scopes = scopes;
        // A missing search scope never makes the instance unready: lookups
        // keep working and the runner withholds the search tool.
        this.state.searchScope = scopes.includes(SLACK_SEARCH_SCOPE);
        this.state.detail =
          category === null
            ? `read-only user lookups as bot ${botUserId}${scopes.includes(SLACK_EMAIL_SCOPE) ? ' with e-mail addresses' : ` without e-mail addresses (no ${SLACK_EMAIL_SCOPE} scope)`}; ${this.state.searchScope ? 'message search: scope granted' : `message search: missing ${SLACK_SEARCH_SCOPE} (add it and reinstall)`}`
            : `${detail || category} (see docs/slack-tool.md troubleshooting)`;
        if (category === null) this.readyDetail = this.state.detail;
        this.checkedAtMs = this.now();
        this.state.checkedAt = new Date(this.checkedAtMs).toISOString();
        return this.state;
      } finally {
        this.probing = null;
      }
    })();
    return this.probing;
  }

  /** Readiness is older than the bounded refresh interval (a revoked token turns it not-ready). */
  isStale(): boolean {
    return (
      this.configured &&
      this.probing === null &&
      this.now() - this.checkedAtMs >= SLACK_READINESS_REFRESH_MS
    );
  }

  /** One lookup with the arguments re-validated here. */
  async call(
    operation: Exclude<SlackOperation, 'searchMessages'>,
    input: unknown,
    bounds: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<SlackCallResult> {
    if (!this.state.ready)
      return { status: 'not_run', output: 'Slack is not ready', refused: 'not ready' };
    let validated;
    try {
      validated = validateSlackRequest(operation, input);
    } catch (err) {
      const reason = err instanceof SlackRequestError ? err.message : 'invalid request';
      return { status: 'not_run', output: reason, refused: reason };
    }
    const options = {
      timeoutMs: bounds.timeoutMs,
      signal: bounds.signal,
      fetchImpl: this.fetchImpl,
    };
    const http =
      'user' in validated
        ? await sendSlackRequest(
            'users.info',
            { verb: 'GET', params: { user: validated.user } },
            this.token,
            options,
          )
        : 'email' in validated
          ? await sendSlackRequest(
              'users.lookupByEmail',
              { verb: 'GET', params: { email: validated.email } },
              this.token,
              options,
            )
          : null;
    if (http === null)
      return { status: 'not_run', output: 'invalid request', refused: 'invalid request' };
    const result = normalizeSlackUserResult(operation, http, {
      maxOutputBytes: bounds.maxOutputBytes,
    });
    // A rejected token or a lost scope turns readiness stale at once (next /readyz re-probes).
    if (result.errorCategory === 'invalid_auth' || result.errorCategory === 'forbidden_scope')
      this.checkedAtMs = 0;
    return result;
  }

  /**
   * One message search in the workspace's public channels with the asking
   * user's permissions (`assistant.search.context`, the bot token plus the
   * triggering mention's `action_token`). Slack page `page` is reached
   * through the internal cursor loop: at most SLACK_SEARCH_MAX_PAGES
   * sequential requests, stopping on an empty cursor; a failure (rate limit,
   * rejected action token) ends the call without a retry.
   */
  async search(
    input: unknown,
    actionToken: string,
    bounds: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<SlackCallResult> {
    if (!this.state.ready)
      return { status: 'not_run', output: 'Slack is not ready', refused: 'not ready' };
    if (!this.state.searchScope) return slackFailure('searchMessages', 'forbidden_scope');
    let validated;
    try {
      validated = validateSlackRequest('searchMessages', input);
    } catch (err) {
      const reason = err instanceof SlackRequestError ? err.message : 'invalid request';
      return { status: 'not_run', output: reason, refused: reason };
    }
    if (!('query' in validated))
      return { status: 'not_run', output: 'invalid request', refused: 'invalid request' };
    const deadline = this.now() + bounds.timeoutMs;
    let cursor: string | null = null;
    let pages = 0;
    let messages: SlackSearchMessage[] = [];
    let capped = false;
    let more = false;
    for (let page = 1; page <= Math.min(validated.page, SLACK_SEARCH_MAX_PAGES); page += 1) {
      const remaining = deadline - this.now();
      if (remaining <= 0) return slackFailure('searchMessages', 'timeout', { pages });
      pages += 1;
      const http = await sendSlackRequest(
        'assistant.search.context',
        { verb: 'POST', body: slackSearchBody(validated.query, actionToken, cursor) },
        this.token,
        { timeoutMs: remaining, signal: bounds.signal, fetchImpl: this.fetchImpl },
      );
      if (http.errorCategory) {
        // A rejected bot token or a lost scope turns readiness stale at once.
        if (http.errorCategory === 'invalid_auth' || http.errorCategory === 'forbidden_scope')
          this.checkedAtMs = 0;
        return slackFailure('searchMessages', http.errorCategory, { pages });
      }
      const normalized = normalizeSlackSearchResult(http, this.workspaceHost);
      if (normalized === null) return slackFailure('searchMessages', 'invalid_shape', { pages });
      cursor = normalized.nextCursor;
      if (page === validated.page) {
        messages = normalized.messages;
        capped = normalized.capped;
        more = cursor !== null;
        break;
      }
      // The requested page does not exist: the result set ended earlier.
      if (cursor === null) break;
    }
    const shaped = slackSearchOutput(
      {
        messages,
        page: validated.page,
        nextPage: more && validated.page < SLACK_SEARCH_MAX_PAGES ? validated.page + 1 : null,
        truncated: capped,
      },
      bounds.maxOutputBytes,
    );
    return {
      status: 'completed',
      output: shaped.output,
      bytes: Buffer.byteLength(shaped.output),
      truncated: shaped.result.truncated,
      pages,
      resultCount: shaped.result.messages.length,
      emptyHits: shaped.result.messages.filter((message) => message.contentUnavailable === true)
        .length,
    };
  }
}

/** The `<team>.slack.com` host of auth.test's workspace URL, or null. */
function workspaceHostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && host.endsWith('.slack.com') ? host : null;
  } catch {
    return null;
  }
}
