import { describe, expect, it } from 'vitest';
import {
  ATLASSIAN_API_ORIGIN,
  buildAtlassianRequest,
  buildReadinessRequest,
  classifyAtlassianHttp,
  extractAtlassianText,
  normalizeAtlassianResponse as normalize,
  plainExcerpt,
  sendAtlassianRequest,
  type AtlassianFetch,
  type AtlassianHttpResult,
} from '../../src/integrations/atlassian/atlassian-rest-adapter.js';
import {
  ATLASSIAN_READ_OPERATIONS,
  validateAtlassianOperation,
  type ValidatedAtlassianArgs,
} from '../../src/integrations/atlassian/atlassian-operations.js';

const CLOUD = '11111111-1111-4111-8111-111111111111';
const SITE = 'example.atlassian.net';
const ok = (data: unknown): AtlassianHttpResult => ({
  httpStatus: 200,
  body: JSON.stringify(data),
});
const credentials = {
  jira: { email: 'bot@example.com', token: 'jira-synthetic-token' },
  confluence: { email: 'bot@example.com', token: 'conf-synthetic-token' },
};
const basic = (token: string) =>
  `Basic ${Buffer.from(`bot@example.com:${token}`).toString('base64')}`;

/** One minimal valid argument set per operation. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  searchJiraIssues: { query: 'sample release checklist pages' },
  searchJiraIssuesUsingJql: { jql: 'project = ABC' },
  getJiraIssue: { issueKey: 'ABC-123' },
  listJiraIssueComments: { issueKey: 'ABC-123' },
  listJiraProjects: {},
  searchConfluencePages: { query: 'Sample Test' },
  getConfluencePage: { pageId: '1234567890' },
};
const sample = (op: string): ValidatedAtlassianArgs =>
  validateAtlassianOperation(op, SAMPLE_ARGS[op]);

// Synthetic fixtures shaped like the documented REST responses; no real site content.
describe('request builder', () => {
  it('maps every operation to one fixed GET on the fixed origin and product prefix', () => {
    for (const op of ATLASSIAN_READ_OPERATIONS) {
      const request = buildAtlassianRequest(sample(op), CLOUD);
      expect(request.method).toBe('GET');
      expect(request.url.origin).toBe(ATLASSIAN_API_ORIGIN);
      expect(request.url.pathname.startsWith(`/ex/${request.product}/${CLOUD}/`)).toBe(true);
      expect(request.product).toBe(op.includes('Confluence') ? 'confluence' : 'jira');
    }
  });

  it('builds the exact paths and queries', () => {
    const url = (op: string, args: Record<string, unknown>) =>
      buildAtlassianRequest(validateAtlassianOperation(op, args), CLOUD).url;
    const search = url('searchJiraIssues', { query: 'sample" OR x', projectKey: 'ABC' });
    expect(search.pathname).toBe(`/ex/jira/${CLOUD}/rest/api/3/search/jql`);
    expect(search.searchParams.get('jql')).toBe('text ~ "sample OR x" AND project = "ABC"');
    expect(search.searchParams.get('maxResults')).toBe('10');
    expect(search.searchParams.get('fields')).toBe('summary,issuetype,status,assignee,updated');
    expect(search.searchParams.has('nextPageToken')).toBe(false);
    expect(
      url('searchJiraIssuesUsingJql', {
        jql: 'status = Done',
        nextPageToken: 'abc',
      }).searchParams.get('nextPageToken'),
    ).toBe('abc');
    expect(url('getJiraIssue', { issueKey: 'ABC-123' }).pathname).toBe(
      `/ex/jira/${CLOUD}/rest/api/3/issue/ABC-123`,
    );
    const comments = url('listJiraIssueComments', { issueKey: 'A-1', maxResults: 5, startAt: 5 });
    expect(comments.pathname).toBe(`/ex/jira/${CLOUD}/rest/api/3/issue/A-1/comment`);
    expect(comments.search).toBe('?orderBy=created&maxResults=5&startAt=5');
    expect(url('listJiraProjects', {}).pathname).toBe(
      `/ex/jira/${CLOUD}/rest/api/3/project/search`,
    );
    const conf = url('searchConfluencePages', { query: 'Sample Test', spaceKey: '~123456789' });
    expect(conf.pathname).toBe(`/ex/confluence/${CLOUD}/wiki/rest/api/search`);
    expect(conf.searchParams.get('cql')).toBe(
      'siteSearch ~ "Sample Test" AND type = page AND space = "~123456789"',
    );
    expect(conf.searchParams.get('limit')).toBe('10');
    const page = url('getConfluencePage', { pageId: '1234567890' });
    expect(page.pathname).toBe(`/ex/confluence/${CLOUD}/wiki/api/v2/pages/1234567890`);
    expect(page.searchParams.get('body-format')).toBe('storage');
    expect(buildReadinessRequest('jiraServerInfo', CLOUD).url.pathname).toBe(
      `/ex/jira/${CLOUD}/rest/api/3/serverInfo`,
    );
    expect(buildReadinessRequest('confluenceSpaces', CLOUD).url.search).toBe('?limit=1');
    expect(() => buildAtlassianRequest(sample('getJiraIssue'), '../evil')).toThrow(/cloud ID/);
  });
});

describe('transport', () => {
  const capture = (response: () => Response) => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl: AtlassianFetch = async (url, init) => {
      calls.push({ url, init });
      return response();
    };
    return { calls, fetchImpl };
  };
  const opts = (fetchImpl: AtlassianFetch) => ({ timeoutMs: 5000, maxBytes: 1000, fetchImpl });

  it('sends GET with manual redirects and only the matching product token', async () => {
    const { calls, fetchImpl } = capture(() => new Response('{}', { status: 200 }));
    await sendAtlassianRequest(
      buildAtlassianRequest(sample('getJiraIssue'), CLOUD),
      credentials,
      opts(fetchImpl),
    );
    await sendAtlassianRequest(
      buildAtlassianRequest(sample('getConfluencePage'), CLOUD),
      credentials,
      opts(fetchImpl),
    );
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET']);
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'manual']);
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth).toEqual([basic('jira-synthetic-token'), basic('conf-synthetic-token')]);
  });

  it('never attaches a token outside the fixed origin, product prefix or configured product', async () => {
    const { calls, fetchImpl } = capture(() => new Response('{}'));
    const jira = buildAtlassianRequest(sample('getJiraIssue'), CLOUD);
    for (const request of [
      { ...jira, url: new URL('https://evil.example/ex/jira/x') },
      { ...jira, url: new URL(`${ATLASSIAN_API_ORIGIN}/ex/confluence/${CLOUD}/wiki`) },
      { ...jira, url: new URL(`https://user:pw@api.atlassian.com/ex/jira/${CLOUD}/x`) },
      { ...jira, method: 'POST' as unknown as 'GET' },
    ])
      await expect(sendAtlassianRequest(request, credentials, opts(fetchImpl))).rejects.toThrow(
        /trusted origin/,
      );
    await expect(
      sendAtlassianRequest(jira, { confluence: credentials.confluence }, opts(fetchImpl)),
    ).rejects.toThrow(/credential route/);
    expect(calls).toHaveLength(0);
  });

  it('rejects redirects and oversize bodies', async () => {
    const redirect = capture(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    const request = buildAtlassianRequest(sample('getJiraIssue'), CLOUD);
    expect(
      await sendAtlassianRequest(request, credentials, opts(redirect.fetchImpl)),
    ).toMatchObject({
      errorCategory: 'redirect_refused',
    });
    expect(redirect.calls).toHaveLength(1);
    const large = capture(() => new Response('x'.repeat(1001)));
    expect(await sendAtlassianRequest(request, credentials, opts(large.fetchImpl))).toMatchObject({
      errorCategory: 'output_limit',
      body: '',
    });
  });

  it('classifies timeout, caller abort and network failures', async () => {
    const hang: AtlassianFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const request = buildAtlassianRequest(sample('getJiraIssue'), CLOUD);
    expect(
      await sendAtlassianRequest(request, credentials, {
        timeoutMs: 20,
        maxBytes: 100,
        fetchImpl: hang,
      }),
    ).toMatchObject({ errorCategory: 'timeout' });
    const controller = new AbortController();
    const pending = sendAtlassianRequest(request, credentials, {
      timeoutMs: 5000,
      maxBytes: 100,
      signal: controller.signal,
      fetchImpl: hang,
    });
    controller.abort();
    expect(await pending).toMatchObject({ errorCategory: 'timeout' });
    const down: AtlassianFetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await sendAtlassianRequest(request, credentials, opts(down))).toMatchObject({
      errorCategory: 'network',
    });
  });

  it('keeps scope refusals apart from plain authentication failures and reports Retry-After', async () => {
    expect(classifyAtlassianHttp(401, '{"message":"Unauthorized; scope does not match"}')).toBe(
      'insufficient_scope',
    );
    expect(classifyAtlassianHttp(401, '{"message":"Unauthorized"}')).toBe('invalid_auth');
    expect(classifyAtlassianHttp(403, "You don't have permission to connect via API token")).toBe(
      'forbidden',
    );
    expect(classifyAtlassianHttp(404, '')).toBe('not_found');
    expect(classifyAtlassianHttp(400, '{"errorMessages":["bad jql"]}')).toBe('invalid_request');
    expect(classifyAtlassianHttp(503, '')).toBe('upstream_error');
    expect(classifyAtlassianHttp(301, '')).toBe('redirect_refused');
    expect(classifyAtlassianHttp(200, '')).toBeNull();
    const limited = capture(
      () =>
        new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const result = await sendAtlassianRequest(
      buildAtlassianRequest(sample('getJiraIssue'), CLOUD),
      credentials,
      opts(limited.fetchImpl),
    );
    expect(result).toEqual({
      errorCategory: 'rate_limit',
      httpStatus: 429,
      body: '',
      retryAfter: '30',
    });
    const failed = normalize(sample('getJiraIssue'), result, SITE);
    expect(failed.status).toBe('failed');
    expect(failed.output).toBe(
      'getJiraIssue: rate_limit: Atlassian rate limit reached; wait before trying again. Retry after 30 seconds.',
    );
    expect(failed.output).not.toContain('slow down');
  });
});

describe('normalizers', () => {
  const parse = (output: string) => JSON.parse(output.slice(output.indexOf(': ') + 2));

  it('projects Jira search hits with continuation', () => {
    const cursor = 'fixture-next-page';
    const result = normalize(
      sample('searchJiraIssues'),
      ok({
        issues: [
          {
            id: '1',
            key: 'ABC-12',
            fields: {
              summary: 'Synthetic sample issue',
              status: { name: 'In Progress' },
              issuetype: { name: 'Task' },
              assignee: { displayName: 'Synthetic User' },
              updated: '2026-09-01T10:00:00.000+0200',
            },
          },
          { id: '2', key: 'ABC-13', fields: { summary: 'Other' } },
        ],
        nextPageToken: cursor,
        isLast: false,
      }),
      SITE,
    );
    expect(result.status).toBe('completed');
    const projection = parse(result.output);
    expect(projection.items[0]).toEqual({
      key: 'ABC-12',
      summary: 'Synthetic sample issue',
      status: 'In Progress',
      type: 'Task',
      assignee: 'Synthetic User',
      updated: '2026-09-01T10:00:00.000+0200',
      url: `https://${SITE}/browse/ABC-12`,
    });
    expect(projection.items[1].assignee).toBeNull();
    expect(projection.nextPageToken).toBe(cursor);
    const last = normalize(
      sample('searchJiraIssuesUsingJql'),
      ok({ issues: [], isLast: true }),
      SITE,
    );
    expect(parse(last.output)).toEqual({ items: [], returnedCount: 0, nextPageToken: null });
  });

  it('projects a Jira issue with ADF description', () => {
    const result = normalize(
      sample('getJiraIssue'),
      ok({
        key: 'ABC-123',
        fields: {
          summary: 'Synthetic summary',
          status: { name: 'To Do' },
          issuetype: { name: 'Story' },
          project: { key: 'ABC' },
          labels: ['a'],
          description: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'marker' }] }],
          },
        },
      }),
      SITE,
    );
    const projection = parse(result.output);
    expect(projection).toMatchObject({
      key: 'ABC-123',
      summary: 'Synthetic summary',
      status: 'To Do',
      type: 'Story',
      project: 'ABC',
      labels: ['a'],
      description: 'marker',
      url: `https://${SITE}/browse/ABC-123`,
    });
  });

  it('projects comments and projects with offset continuation', () => {
    const comments = normalize(
      validateAtlassianOperation('listJiraIssueComments', { issueKey: 'A-1', maxResults: 1 }),
      ok({
        startAt: 0,
        total: 3,
        comments: [{ id: '10', author: { displayName: 'U' }, created: 'c', body: 'hello' }],
      }),
      SITE,
    );
    expect(parse(comments.output)).toMatchObject({
      items: [{ id: '10', author: 'U', created: 'c', body: 'hello' }],
      total: 3,
      nextStartAt: 1,
    });
    const projects = normalize(
      sample('listJiraProjects'),
      ok({ values: [{ id: '1', key: 'ABC', name: 'Sample Project' }], isLast: true }),
      SITE,
    );
    expect(parse(projects.output)).toMatchObject({
      items: [{ key: 'ABC', name: 'Sample Project' }],
      nextStartAt: null,
    });
  });

  it('projects Confluence hits with plain excerpts, space and cursor', () => {
    const result = normalize(
      sample('searchConfluencePages'),
      ok({
        results: [
          {
            content: { id: '123', type: 'page', title: 'Synthetic Page' },
            title: 'Synthetic Page',
            excerpt: 'a @@@hl@@@Sample@@@endhl@@@ &amp; <b>bold</b> test',
            lastModified: '2026-09-01T10:00:00.000Z',
            resultGlobalContainer: { title: 'Personal Space', displayUrl: '/spaces/~123456789' },
          },
        ],
        _links: { next: '/rest/api/search?cql=x&cursor=_sa_WyJcdDEi&limit=10' },
      }),
      SITE,
    );
    expect(parse(result.output)).toEqual({
      items: [
        {
          pageId: '123',
          title: 'Synthetic Page',
          spaceKey: '~123456789',
          spaceName: 'Personal Space',
          excerpt: 'a Sample & bold test',
          lastModified: '2026-09-01T10:00:00.000Z',
          url: `https://${SITE}/wiki/pages/viewpage.action?pageId=123`,
        },
      ],
      returnedCount: 1,
      cursor: '_sa_WyJcdDEi',
    });
    expect(plainExcerpt('<script>x</script>@@@hl@@@a@@@endhl@@@')).toBe('a');
  });

  it('extracts page storage markup without scripts or resources', () => {
    const result = normalize(
      sample('getConfluencePage'),
      ok({
        id: '1234567890',
        title: 'Test',
        status: 'current',
        spaceId: '42',
        body: {
          storage: {
            value: '<p>A &amp; B</p><script>evil()</script><img src="https://evil.invalid">',
          },
        },
      }),
      SITE,
    );
    expect(parse(result.output)).toEqual({
      pageId: '1234567890',
      title: 'Test',
      status: 'current',
      spaceId: '42',
      body: 'A & B',
      url: `https://${SITE}/wiki/pages/viewpage.action?pageId=1234567890`,
    });
  });

  it('rejects malformed, oversize-window, wrong-resource and invalid-continuation payloads', () => {
    const cases: Array<[string, unknown]> = [
      ['getJiraIssue', {}],
      ['getJiraIssue', { key: 'bad', fields: {} }],
      ['getJiraIssue', []],
      ['getConfluencePage', { id: '999', title: 'x' }],
      ['searchJiraIssues', { issues: [{}] }],
      ['searchJiraIssues', { issues: [], isLast: false, nextPageToken: 'a b' }],
      [
        'searchJiraIssues',
        { issues: Array.from({ length: 11 }, (_, i) => ({ key: `A-${i + 1}`, fields: {} })) },
      ],
      ['listJiraIssueComments', { comments: [{ error: 'permission denied' }] }],
      ['listJiraProjects', { values: [{ id: '1', key: 'A' }] }],
      ['searchConfluencePages', { results: [{ title: 'no content' }] }],
      ['searchConfluencePages', { results: [], _links: { next: '/x?cursor=a%20b' } }],
    ];
    for (const [op, data] of cases)
      expect(normalize(sample(op), ok(data), SITE), `${op} ${JSON.stringify(data)}`).toMatchObject({
        status: 'failed',
        errorCategory: 'invalid_shape',
      });
    expect(normalize(sample('getJiraIssue'), { httpStatus: 200, body: '{' }, SITE)).toMatchObject({
      errorCategory: 'invalid_json',
    });
    expect(
      normalize(
        sample('getJiraIssue'),
        { errorCategory: 'timeout', httpStatus: null, body: '' },
        SITE,
      ).status,
    ).toBe('timed_out');
  });

  it('bounds recursive text and projected bytes', () => {
    expect(extractAtlassianText('x'.repeat(10000), 10)).toEqual({
      text: 'x'.repeat(10),
      truncated: true,
    });
    const result = normalize(
      sample('getConfluencePage'),
      ok({ id: '1234567890', title: 'x', body: 'é'.repeat(10000) }),
      SITE,
      512,
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(512);
    expect(parse(result.output).body).toMatch(/\[…truncated\]$/);
  });

  it('drops whole comments to fit the bound and continues at the first one left out', () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: String(100 + i),
      author: { displayName: `Person ${i}` },
      created: '2026-11-01T10:00:00.000+0000',
      body: `comment ${i} `.padEnd(1500, 'x'),
    }));
    const result = normalize(
      validateAtlassianOperation('listJiraIssueComments', { issueKey: 'ABC-1', startAt: 40 }),
      ok({ comments, startAt: 40, maxResults: 20, total: 100 }),
      SITE,
      200000,
    );
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(12000);
    const projection = parse(result.output);
    const delivered = projection.items.length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(20);
    expect(projection.items.at(-1).id).toBe(String(100 + delivered - 1));
    expect(projection).toMatchObject({
      returnedCount: delivered,
      nextStartAt: 40 + delivered,
      truncated: true,
      omittedCount: 20 - delivered,
    });
    expect(result.truncated).toBe(true);
  });

  it('moves past a comment that alone exceeds the bound', () => {
    const comments = Array.from({ length: 2 }, (_, i) => ({
      id: String(100 + i),
      author: { displayName: `Person ${i}` },
      created: '2026-11-01T10:00:00.000+0000',
      body: '\u0001'.repeat(2000),
    }));
    const result = normalize(
      validateAtlassianOperation('listJiraIssueComments', { issueKey: 'ABC-1', startAt: 40 }),
      ok({ comments, startAt: 40, maxResults: 20, total: 100 }),
      SITE,
      200000,
    );
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(12000);
    expect(result.output).toContain('"id":"100"');
    expect(result.output).toContain('"nextStartAt":41,');
    expect(result.truncated).toBe(true);
  });

  it('withholds the token of a cut search page and says how to continue after the shown hits', () => {
    const issues = Array.from({ length: 20 }, (_, i) => ({
      key: `ABC-${i + 1}`,
      fields: { summary: `summary ${i} `.padEnd(500, 'y'), status: { name: 'Open' } },
    }));
    const result = normalize(
      validateAtlassianOperation('searchJiraIssuesUsingJql', {
        jql: 'project = ABC',
        maxResults: 20,
      }),
      ok({ issues, nextPageToken: 'tok-2', isLast: false }),
      SITE,
    );
    const projection = parse(result.output);
    const delivered = projection.items.length;
    expect(delivered).toBeLessThan(20);
    expect(projection).toMatchObject({
      nextPageToken: null,
      truncated: true,
      omittedCount: 20 - delivered,
      continueWith: `repeat this call unchanged except maxResults: ${delivered}, then continue with the nextPageToken it returns`,
    });
  });

  it('marks a Confluence page body cut at the text bound', () => {
    const storage = `<p>${'Intro paragraph. '.repeat(400)}</p><p>Rollback: run deploy --rollback</p>`;
    const result = normalize(
      validateAtlassianOperation('getConfluencePage', { pageId: '42' }),
      ok({ id: '42', title: 'Runbook', status: 'current', body: { storage: { value: storage } } }),
      SITE,
    );
    expect(result.truncated).toBe(true);
    expect(parse(result.output).body).toMatch(/Intro paragraph\.[^]*\[…truncated\]$/);
  });

  it('keeps code macro bodies (CDATA) of page storage, including ">"', () => {
    const storage =
      '<p>Restart the service:</p>' +
      '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
      '<ac:parameter ac:name="language">bash</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[kubectl -n shop rollout restart deploy/checkout]]></ac:plain-text-body>' +
      '</ac:structured-macro>' +
      '<ac:structured-macro ac:name="code">' +
      '<ac:plain-text-body><![CDATA[kubectl get pods > pods.txt && echo "<done> &amp;"]]></ac:plain-text-body>' +
      '</ac:structured-macro>';
    const result = normalize(
      validateAtlassianOperation('getConfluencePage', { pageId: '7' }),
      ok({ id: '7', title: 'Runbook', status: 'current', body: { storage: { value: storage } } }),
      SITE,
    );
    const body = parse(result.output).body as string;
    expect(body).toContain('kubectl -n shop rollout restart deploy/checkout');
    expect(body).toContain('kubectl get pods > pods.txt && echo "<done> &amp;"');
  });

  it('renders pasted links, mentions, emoji, status and dates of Jira ADF', () => {
    const { text } = extractAtlassianText({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Regression from ' },
            {
              type: 'inlineCard',
              attrs: { url: 'https://gitlab.example.com/shop/checkout/-/merge_requests/812' },
            },
            { type: 'text', text: ', please check with ' },
            { type: 'mention', attrs: { id: '5b10a2844c20165700ede21g', text: '@Jane Doe' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { shortName: ':fire:', text: '🔥' } },
            { type: 'text', text: ' state ' },
            { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } },
            { type: 'text', text: ' due ' },
            { type: 'date', attrs: { timestamp: '1798761600000' } },
          ],
        },
        { type: 'blockCard', attrs: { url: 'https://example.com/incident/42' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Next' }] },
      ],
    });
    expect(text).toBe(
      'Regression from https://gitlab.example.com/shop/checkout/-/merge_requests/812, please check with @Jane Doe 🔥 state BLOCKED due 2027-01-01\nhttps://example.com/incident/42\nNext',
    );
  });
});
