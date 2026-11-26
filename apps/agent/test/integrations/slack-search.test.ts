/**
 * Slack message search: query and
 * page validation, the pinned POST body (public channels, messages, 20 per
 * page, bots and blocks included, the action_token in the body only), the
 * internal cursor loop up to three pages, error classes including the
 * rejected action token, the text cap, the permalink host filter and the
 * output bound. Hit content: blocks and attachments flattened into
 * the text, empty hits flagged and counted. No network: an injected fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  SLACK_ENDPOINT,
  SLACK_ERROR_TEXT,
  SLACK_SEARCH_MAX_QUERY_CHARS,
  SLACK_SEARCH_MAX_TEXT_CHARS,
  SlackRequestError,
  classifySlackError,
  sendSlackRequest,
  slackPermalink,
  validateSlackRequest,
} from '../../src/integrations/slack/slack-api-adapter.js';
import { SlackApiProvider } from '../../src/integrations/slack/slack-api-provider.js';
import { ACTION_TOKEN, BOT_TOKEN, SLACK_TEAM, fakeSlack, searchHit } from './helpers/slack-api.js';

const BOUNDS = { timeoutMs: 10_000, maxOutputBytes: 50_000 };
const SCOPES = 'users:read,users:read.email,search:read.public,chat:write';

async function searchProvider(
  options: Parameters<typeof fakeSlack>[0] = {},
): Promise<{ provider: SlackApiProvider; api: ReturnType<typeof fakeSlack> }> {
  const api = fakeSlack({ scopes: SCOPES, ...options });
  const provider = new SlackApiProvider({ teamId: SLACK_TEAM, token: BOT_TOKEN }, api.fetchImpl);
  await provider.refresh();
  return { provider, api };
}

function searches(api: ReturnType<typeof fakeSlack>) {
  return api.seen.filter((request) => request.url.pathname === '/api/assistant.search.context');
}

describe('Slack search validation', () => {
  it('accepts a bounded query and an optional page 1 to 3', () => {
    expect(validateSlackRequest('searchMessages', { query: ' company party ' })).toEqual({
      query: 'company party',
      page: 1,
    });
    expect(
      validateSlackRequest('searchMessages', {
        query: 'party in:#general after:2025-01-01',
        page: 3,
      }),
    ).toEqual({ query: 'party in:#general after:2025-01-01', page: 3 });
    for (const bad of [
      {},
      { query: '' },
      { query: '   ' },
      { query: 7 },
      { query: 'x'.repeat(SLACK_SEARCH_MAX_QUERY_CHARS + 1) },
      { query: 'party\nnight' },
      { query: 'party', page: 0 },
      { query: 'party', page: 4 },
      { query: 'party', page: 1.5 },
      { query: 'party', cursor: 'abc' },
      { query: 'party', channel_types: ['im'] },
      { query: 'party', action_token: 'x' },
    ])
      expect(() => validateSlackRequest('searchMessages', bad)).toThrow(SlackRequestError);
  });
});

describe('Slack search transport', () => {
  it('POSTs the pinned JSON body; GET to search and POST elsewhere are refused', async () => {
    const { provider, api } = await searchProvider();
    const result = await provider.search({ query: 'company party' }, ACTION_TOKEN, BOUNDS);
    expect(result.status).toBe('completed');
    const [request] = searches(api);
    expect(request).toMatchObject({
      method: 'POST',
      url: new URL(`${SLACK_ENDPOINT}/assistant.search.context`),
      authorization: `Bearer ${BOT_TOKEN}`,
      redirect: 'manual',
      contentType: 'application/json; charset=utf-8',
      body: {
        query: 'company party',
        action_token: ACTION_TOKEN,
        channel_types: ['public_channel'],
        content_types: ['messages'],
        // bot and app posts, with the blocks their content lives in.
        include_bots: true,
        include_message_blocks: true,
        limit: 20,
      },
    });
    expect(request!.body).not.toHaveProperty('include_context_messages');
    expect(request!.url.search).toBe('');
    // The action token travels in the search body only.
    for (const other of api.seen.filter((entry) => entry !== request))
      expect(JSON.stringify(other)).not.toContain(ACTION_TOKEN);
    await expect(
      sendSlackRequest('assistant.search.context', { verb: 'GET', params: {} }, BOT_TOKEN, {
        timeoutMs: 5_000,
        fetchImpl: api.fetchImpl,
      }),
    ).rejects.toThrow(/pinned read-only API surface/);
    await expect(
      sendSlackRequest('users.info', { verb: 'POST', body: { user: 'U1' } }, BOT_TOKEN, {
        timeoutMs: 5_000,
        fetchImpl: api.fetchImpl,
      }),
    ).rejects.toThrow(/pinned read-only API surface/);
  });

  it('classifies rejected action tokens, missing entitlements and rate limits', () => {
    expect(classifySlackError('invalid_action_token')).toBe('action_token_invalid');
    expect(classifySlackError('action_token_expired')).toBe('action_token_invalid');
    expect(classifySlackError('expired_action_token')).toBe('action_token_invalid');
    expect(classifySlackError('not_allowed_token_type')).toBe('forbidden_scope');
    expect(classifySlackError('feature_not_enabled')).toBe('forbidden_scope');
    expect(classifySlackError('missing_scope')).toBe('forbidden_scope');
    expect(classifySlackError('ratelimited')).toBe('rate_limit');
  });
});

describe('Slack provider message search', () => {
  it('returns the bounded messages only, with ISO dates and capped, cleaned text', async () => {
    const long = 'p'.repeat(SLACK_SEARCH_MAX_TEXT_CHARS + 50);
    const { provider } = await searchProvider({
      searchPages: [[searchHit(1), searchHit(2, { content: long, is_author_bot: true })]],
    });
    const result = await provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS);
    expect(result).toMatchObject({
      status: 'completed',
      pages: 1,
      resultCount: 2,
      truncated: true,
    });
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({ page: 1, nextPage: null, truncated: true });
    expect(parsed.messages[0]).toEqual({
      channel: 'company-parties',
      channelId: 'C0PARTY001',
      author: 'Author 1',
      authorId: 'U0AUTH001',
      isAuthorBot: false,
      date: new Date((1735689600 + 1) * 1000).toISOString(),
      text: 'Summer party 1  at the lake',
      permalink: 'https://support-agent-test.slack.com/archives/C0PARTY001/p1735689601000100',
    });
    expect(parsed.messages[1].isAuthorBot).toBe(true);
    expect(parsed.messages[1].text).toHaveLength(SLACK_SEARCH_MAX_TEXT_CHARS);
    expect(result.output).not.toMatch(/blocks never|context never|rich_text/);
  });

  it('walks the cursor to the requested page: three requests for page 3', async () => {
    const pages = [[searchHit(1)], [searchHit(2)], [searchHit(3)], [searchHit(4)]];
    const { provider, api } = await searchProvider({ searchPages: pages });
    const first = await provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS);
    expect(JSON.parse(first.output)).toMatchObject({ page: 1, nextPage: 2 });
    const third = await provider.search({ query: 'party', page: 3 }, ACTION_TOKEN, BOUNDS);
    expect(third).toMatchObject({ status: 'completed', pages: 3, resultCount: 1 });
    const parsed = JSON.parse(third.output);
    // Page 3 is the last the tool offers, even when Slack has more.
    expect(parsed).toMatchObject({ page: 3, nextPage: null });
    expect(parsed.messages.map((message: { author: string }) => message.author)).toEqual([
      'Author 3',
    ]);
    expect(searches(api).map((request) => request.body?.cursor ?? null)).toEqual([
      null,
      null,
      'cursor-2',
      'cursor-3',
    ]);
  });

  it('stops on an empty cursor: a page beyond the results is empty', async () => {
    const { provider, api } = await searchProvider({ searchPages: [[searchHit(1)]] });
    const result = await provider.search({ query: 'party', page: 3 }, ACTION_TOKEN, BOUNDS);
    expect(result).toMatchObject({ status: 'completed', pages: 1, resultCount: 0 });
    expect(JSON.parse(result.output)).toEqual({
      messages: [],
      page: 3,
      nextPage: null,
      truncated: false,
    });
    expect(searches(api)).toHaveLength(1);
  });

  it('fails a rejected action token with the fixed sentence and no retry', async () => {
    const { provider, api } = await searchProvider({
      searchError: { error: 'invalid_action_token' },
    });
    const result = await provider.search({ query: 'party', page: 2 }, ACTION_TOKEN, BOUNDS);
    expect(result).toMatchObject({
      status: 'failed',
      errorCategory: 'action_token_invalid',
      pages: 1,
    });
    expect(result.output).toBe(
      `slack_search_messages: action_token_invalid: ${SLACK_ERROR_TEXT.action_token_invalid}`,
    );
    expect(result.output).not.toContain(ACTION_TOKEN);
    expect(searches(api)).toHaveLength(1);
    // A per-event token rejection says nothing about the bot token.
    expect(provider.isStale()).toBe(false);
  });

  it('names the feature and the scope when Slack refuses the bot token', async () => {
    const { provider } = await searchProvider({
      searchError: { error: 'not_allowed_token_type' },
    });
    const result = await provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS);
    expect(result.errorCategory).toBe('forbidden_scope');
    expect(result.output).toMatch(/Agents & AI Apps/);
    expect(result.output).toMatch(/search:read\.public/);
    expect(provider.isStale()).toBe(true);
  });

  it('refuses a rate limit on a later page without retrying', async () => {
    const { provider, api } = await searchProvider({
      searchPages: [[searchHit(1)], [searchHit(2)]],
      searchError: { status: 429, fromRequest: 2 },
    });
    const result = await provider.search({ query: 'party', page: 2 }, ACTION_TOKEN, BOUNDS);
    expect(result).toMatchObject({ status: 'failed', errorCategory: 'rate_limit', pages: 2 });
    expect(searches(api)).toHaveLength(2);
  });

  it('answers a malformed body and other failures with fixed sentences', async () => {
    const shape = await searchProvider({ rawSearchBody: '{"ok":true,"results":"nope"}' });
    expect(
      (await shape.provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS)).errorCategory,
    ).toBe('invalid_shape');
    const server = await searchProvider({ searchError: { status: 503 } });
    expect(
      (await server.provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS)).errorCategory,
    ).toBe('upstream_error');
  });

  it('keeps only https permalinks on the workspace host and drops malformed hits', async () => {
    const { provider } = await searchProvider({
      searchPages: [
        [
          searchHit(1, { permalink: 'https://evil.example/archives/x' }),
          searchHit(2, { permalink: 'http://support-agent-test.slack.com/archives/x' }),
          searchHit(3, { permalink: 'https://other-team.slack.com/archives/x' }),
          searchHit(4, { channel_id: 'D0DIRECT01' }),
          searchHit(5, { message_ts: 'yesterday' }),
          searchHit(6, { content: 42 }),
          'not an object',
          // No content and nothing to flatten it from: malformed.
          searchHit(8, { content: undefined, blocks: undefined }),
          searchHit(7),
        ],
      ],
    });
    const parsed = JSON.parse(
      (await provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS)).output,
    );
    expect(parsed.messages.map((m: { author: string }) => m.author)).toEqual([
      'Author 1',
      'Author 2',
      'Author 3',
      'Author 7',
    ]);
    expect(parsed.messages.map((m: { permalink: string | null }) => m.permalink)).toEqual([
      null,
      null,
      null,
      'https://support-agent-test.slack.com/archives/C0PARTY001/p1735689607000100',
    ]);
    // Without a workspace URL from auth.test any *.slack.com host passes.
    expect(slackPermalink('https://other-team.slack.com/archives/x', null)).toBe(
      'https://other-team.slack.com/archives/x',
    );
    expect(slackPermalink('https://slack.com.evil.example/x', null)).toBeNull();
  });

  it('drops messages from the end until the output bound holds', async () => {
    const hits = Array.from({ length: 20 }, (_, index) =>
      searchHit(index + 1, { content: 'x'.repeat(1500) }),
    );
    const { provider } = await searchProvider({ searchPages: [hits] });
    const result = await provider.search({ query: 'party' }, ACTION_TOKEN, {
      ...BOUNDS,
      maxOutputBytes: 8_000,
    });
    expect(result.status).toBe('completed');
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(8_000);
    const parsed = JSON.parse(result.output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.messages.length).toBeLessThan(20);
    expect(result.resultCount).toBe(parsed.messages.length);
  });

  it('refuses the search without the scope, before any request', async () => {
    const { provider, api } = await searchProvider({ scopes: 'users:read' });
    expect(provider.state).toMatchObject({ ready: true, searchScope: false });
    const result = await provider.search({ query: 'party' }, ACTION_TOKEN, BOUNDS);
    expect(result.errorCategory).toBe('forbidden_scope');
    expect(searches(api)).toHaveLength(0);
  });

  it('reports the granted search scope in readiness', async () => {
    const { provider } = await searchProvider();
    expect(provider.state).toMatchObject({ ready: true, searchScope: true });
    expect(provider.state.detail).toMatch(/message search: scope granted$/);
  });
});

/**
 * Hit shapes, modelled on Slack's documented message payloads:
 * `assistant.search.context` with `include_message_blocks` returns each
 * hit's `blocks` next to its plain `content`. The search wrapper is
 * `searchHit`; the content fields are the cases below.
 */
const PERSON_HIT = {
  content: 'Deploy freeze for checkout starts Friday 18:00, ask in #releases',
  is_author_bot: false,
  blocks: [
    {
      type: 'rich_text',
      block_id: 'Xq1',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'Deploy freeze for checkout starts Friday 18:00, ask in ' },
            { type: 'channel', channel_id: 'C0RELEASE1' },
          ],
        },
      ],
    },
  ],
};
/** An announcement app post (the announcement bot case): header, section, context. */
const APP_POST_HIT = {
  content: '',
  author_name: 'Platform Updates Bot',
  author_user_id: 'U0PLATBOT1',
  is_author_bot: true,
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'New in Platform: Preview Bar', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Preview Bar* keeps your preview sandboxes one click away. Rollout: 2025-07-24, all teams.',
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Questions? <#C0PLATHELP|platform-help>' }],
    },
  ],
};
/** A Jira-style post: everything in a legacy attachment, no content and no blocks. */
const ATTACHMENT_HIT = {
  content: undefined,
  author_name: 'Jira Cloud',
  author_user_id: 'U0JIRABOT1',
  is_author_bot: true,
  blocks: undefined,
  attachments: [
    {
      fallback: 'ABC-4211 Rotate the edge certificates',
      color: '#2684FF',
      title: 'ABC-4211 Rotate the edge certificates',
      title_link: 'https://example.atlassian.net/browse/ABC-4211',
      text: 'Certificates for the edge proxies expire on 2025-08-01.',
      fields: [
        { title: 'Status', value: 'In Progress', short: true },
        { title: 'Assignee', value: 'Platform team', short: true },
      ],
      footer: 'Jira Cloud',
    },
  ],
};
/** A hit whose content search does not return: empty content, only non-text blocks. */
const EMPTY_HIT = {
  content: '',
  is_author_bot: true,
  blocks: [{ type: 'divider' }, { type: 'actions', elements: [{ type: 'button' }] }],
};

describe('Slack search hit content', () => {
  async function searchOf(...hits: Record<string, unknown>[]) {
    const { provider } = await searchProvider({
      searchPages: [hits.map((hit, index) => searchHit(index + 1, hit))],
    });
    const result = await provider.search({ query: 'sandbox' }, ACTION_TOKEN, BOUNDS);
    return { result, parsed: JSON.parse(result.output) };
  }

  it("reads a person's message once when its rich-text block mirrors the content", async () => {
    const { result, parsed } = await searchOf(PERSON_HIT);
    expect(parsed.messages[0].text).toBe(
      'Deploy freeze for checkout starts Friday 18:00, ask in #releases',
    );
    expect(parsed.messages[0]).not.toHaveProperty('contentUnavailable');
    expect(result.emptyHits).toBe(0);
  });

  it("reads a person's rich-text block when search returned no content for it", async () => {
    const { parsed } = await searchOf({ ...PERSON_HIT, content: '' });
    expect(parsed.messages[0].text).toBe(
      'Deploy freeze for checkout starts Friday 18:00, ask in <#C0RELEASE1>',
    );
  });

  it('reads a blocks-only app post as its header, section and context', async () => {
    const { result, parsed } = await searchOf(APP_POST_HIT);
    expect(parsed.messages[0]).toMatchObject({
      author: 'Platform Updates Bot',
      isAuthorBot: true,
      text: [
        'New in Platform: Preview Bar',
        '*Preview Bar* keeps your preview sandboxes one click away. Rollout: 2025-07-24, all teams.',
        'Questions? <#C0PLATHELP|platform-help>',
      ].join('\n'),
    });
    expect(parsed.messages[0]).not.toHaveProperty('contentUnavailable');
    expect(result).toMatchObject({ resultCount: 1, emptyHits: 0 });
  });

  it('reads an attachment-only Jira-style post as title, text, fields and footer', async () => {
    const { result, parsed } = await searchOf(ATTACHMENT_HIT);
    expect(parsed.messages[0].text).toBe(
      [
        'ABC-4211 Rotate the edge certificates (https://example.atlassian.net/browse/ABC-4211)',
        'Certificates for the edge proxies expire on 2025-08-01.',
        'Status: In Progress',
        'Assignee: Platform team',
        'Jira Cloud',
      ].join('\n'),
    );
    expect(result.emptyHits).toBe(0);
  });

  it('flags a hit whose content stays empty and counts it', async () => {
    const { result, parsed } = await searchOf(EMPTY_HIT, APP_POST_HIT, {
      content: '   ',
      blocks: [],
    });
    expect(parsed.messages.map((m: { text: string }) => m.text.length > 0)).toEqual([
      false,
      true,
      false,
    ]);
    expect(parsed.messages[0]).toMatchObject({ text: '', contentUnavailable: true });
    expect(parsed.messages[0].permalink).toMatch(/^https:\/\/support-agent-test\.slack\.com\//);
    expect(parsed.messages[2]).toMatchObject({ text: '', contentUnavailable: true });
    expect(result).toMatchObject({ status: 'completed', resultCount: 3, emptyHits: 2 });
  });

  it('caps an oversized block hit at the per-hit text cap', async () => {
    const announcement = `NOTICE ${'long announcement paragraph '.repeat(200)}`;
    const { result, parsed } = await searchOf({
      content: '',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Quarterly platform update' } },
        { type: 'section', text: { type: 'mrkdwn', text: announcement } },
      ],
    });
    const text: string = parsed.messages[0].text;
    expect(text).toHaveLength(SLACK_SEARCH_MAX_TEXT_CHARS);
    expect(text.startsWith('Quarterly platform update\nNOTICE long announcement')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(result).toMatchObject({ truncated: true, emptyHits: 0 });
  });

  it('counts only the empty hits that survive the output bound', async () => {
    const hits = [...Array.from({ length: 6 }, () => ({ content: 'x'.repeat(1500) })), EMPTY_HIT];
    const { result, parsed } = await (async () => {
      const { provider } = await searchProvider({
        searchPages: [hits.map((hit, index) => searchHit(index + 1, hit))],
      });
      const out = await provider.search({ query: 'x' }, ACTION_TOKEN, {
        ...BOUNDS,
        maxOutputBytes: 6_000,
      });
      return { result: out, parsed: JSON.parse(out.output) };
    })();
    expect(parsed.messages.length).toBeLessThan(7);
    expect(result.emptyHits).toBe(0);
  });
});
