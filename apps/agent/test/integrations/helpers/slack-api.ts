/**
 * Deterministic fake Slack Web API behind an injected fetch: `auth.test`
 * (workspace, bot user, workspace URL, `x-oauth-scopes`), `users.info` and
 * `users.lookupByEmail` over a small directory, and
 * `assistant.search.context` over cursor-linked result pages. Records every
 * request with its method, URL, headers, redirect mode and JSON body.
 */
import type { SlackFetch } from '../../../src/integrations/slack/slack-api-adapter.js';

export const SLACK_TEAM = 'T0TEAM1';
export const BOT_TOKEN = 'xoxb-1111-2222-heldbottoken';
export const BOT_USER = 'U0BOT0001';
export const WORKSPACE_URL = 'https://support-agent-test.slack.com/';
export const ACTION_TOKEN = 'actiontoken.fake.0123456789abcdef';

/** One fixture search hit as Slack returns it (with fields the model must not see). */
export function searchHit(index: number, overrides: Record<string, unknown> = {}) {
  return {
    author_name: `Author ${index}`,
    author_user_id: `U0AUTH${String(index).padStart(3, '0')}`,
    channel_id: 'C0PARTY001',
    channel_name: 'company-parties',
    message_ts: `${1735689600 + index}.000100`,
    content: `Summer party ${index}\u0007 at the lake`,
    is_author_bot: false,
    permalink: `https://support-agent-test.slack.com/archives/C0PARTY001/p${1735689600 + index}000100`,
    blocks: [{ type: 'rich_text', secret: 'blocks never reach the model' }],
    context_messages: { before: [{ content: 'context never reaches the model' }] },
    ...overrides,
  };
}
export const FIXTURE_USER = {
  id: 'U0123456789',
  team_id: SLACK_TEAM,
  name: 'sam',
  deleted: false,
  real_name: 'Sam Rivera',
  tz: 'Europe/Berlin',
  is_admin: false,
  is_owner: false,
  is_bot: false,
  is_restricted: false,
  is_ultra_restricted: false,
  profile: {
    real_name: 'Sam Rivera',
    display_name: 'Sam',
    title: 'Engineer\u0007 (platform)',
    email: 'sam.rivera@example.com',
    phone: '+49 000 000',
    image_72: 'https://avatars.example/s.png',
    fields: { Xf01: { value: 'secret custom field' } },
  },
};

export interface SeenSlackRequest {
  method: string;
  url: URL;
  authorization: string | null;
  redirect: Parameters<SlackFetch>[1]['redirect'];
  /** POST only: content type and parsed JSON body. */
  contentType?: string | null;
  body?: Record<string, unknown>;
}

export interface FakeSlackOptions {
  team?: string;
  scopes?: string | null;
  /** HTTP status for every request (e.g. 429 or 500). */
  status?: number;
  /** `ok: false` error for every request (e.g. invalid_auth). */
  error?: string;
  users?: Array<typeof FIXTURE_USER>;
  /** Raw body text for users.* answers (e.g. oversize). */
  rawUsersBody?: string;
  /** auth.test `url` (null: omitted). */
  workspaceUrl?: string | null;
  /** Search result pages; page N answers the cursor `cursor-N`. */
  searchPages?: unknown[][];
  /** `ok: false` error of assistant.search.context only, from this request number on (1-based). */
  searchError?: { error?: string; status?: number; fromRequest?: number };
  /** Raw body text for search answers. */
  rawSearchBody?: string;
}

export function fakeSlack(options: FakeSlackOptions = {}): {
  fetchImpl: SlackFetch;
  seen: SeenSlackRequest[];
} {
  const seen: SeenSlackRequest[] = [];
  const users = options.users ?? [FIXTURE_USER];
  const fetchImpl: SlackFetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({
      method: init.method ?? 'GET',
      url,
      authorization: headers.get('authorization'),
      redirect: init.redirect,
      ...(init.method === 'POST' ? { contentType: headers.get('content-type'), body } : {}),
    });
    const scopes =
      options.scopes === null
        ? {}
        : { 'x-oauth-scopes': options.scopes ?? 'users:read,users:read.email,chat:write' };
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...scopes },
      });
    if (options.status !== undefined) return answer({ ok: false }, options.status);
    if (options.error !== undefined) return answer({ ok: false, error: options.error });
    if (url.pathname === '/api/auth.test')
      return answer({
        ok: true,
        team_id: options.team ?? SLACK_TEAM,
        user_id: BOT_USER,
        ...(options.workspaceUrl === null ? {} : { url: options.workspaceUrl ?? WORKSPACE_URL }),
      });
    if (url.pathname === '/api/assistant.search.context') {
      const searches = seen.filter((entry) => entry.url.pathname === url.pathname).length;
      const failure = options.searchError;
      if (failure !== undefined && searches >= (failure.fromRequest ?? 1))
        return answer({ ok: false, error: failure.error ?? 'fatal_error' }, failure.status ?? 200);
      if (options.rawSearchBody !== undefined)
        return new Response(options.rawSearchBody, { status: 200, headers: scopes });
      const pages = options.searchPages ?? [[searchHit(1), searchHit(2)]];
      const cursor = typeof body?.cursor === 'string' ? body.cursor : 'cursor-1';
      const index = Number(cursor.replace('cursor-', '')) - 1;
      const messages = pages[index] ?? [];
      const next = index + 1 < pages.length ? `cursor-${index + 2}` : '';
      return answer({ ok: true, results: { messages }, response_metadata: { next_cursor: next } });
    }
    if (options.rawUsersBody !== undefined)
      return new Response(options.rawUsersBody, { status: 200, headers: scopes });
    // Like Slack: without users:read.email profiles carry no e-mail and the
    // lookup by e-mail answers missing_scope.
    const emailScope = (options.scopes ?? 'users:read.email').includes('users:read.email');
    if (url.pathname === '/api/users.info') {
      const found = users.find((entry) => entry.id === url.searchParams.get('user'));
      const user =
        found === undefined || emailScope
          ? found
          : { ...found, profile: { ...found.profile, email: undefined } };
      return answer(
        user === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, user },
      );
    }
    if (url.pathname === '/api/users.lookupByEmail') {
      if (!emailScope) return answer({ ok: false, error: 'missing_scope' });
      const user = users.find((entry) => entry.profile.email === url.searchParams.get('email'));
      return answer(
        user === undefined ? { ok: false, error: 'users_not_found' } : { ok: true, user },
      );
    }
    return answer({ ok: false, error: 'unknown_method' });
  };
  return { fetchImpl, seen };
}
