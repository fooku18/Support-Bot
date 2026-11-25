import { testSelection } from '../../../apps/agent/test/model-fixture.js';
/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic wire assertions against the real runtime */
/**
 * The `tools` suite (T3). Two roles, each in its own container started by
 * tests/integration/run-native.mjs:
 *
 * - `upstream`: the fake HTTPS services (native-tools-upstream.ts) on port
 *   443, reached by the egress proxy under the real host names.
 * - `client`: the agent side. It serves the synthetic settings service the
 *   real CLI runtime syncs its instances and credentials from, compiles the
 *   channel's tool assignment with the settings service's own compiler, and
 *   calls the agent's real read-service binding and Mastra tools against the
 *   real CLI runtime, which reaches the upstream only through the real egress
 *   proxy.
 *
 * Nothing here changes product behaviour: every test value enters through
 * configuration (instances, host lists, the trusted CA, network aliases).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compileDocument } from '../../../apps/admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../../apps/agent/src/application/configuration/config.js';
import { nativeReadServices } from '../../../apps/agent/src/application/bindings/read-services.js';
import { createReadServiceTools } from '../../../apps/agent/src/mastra/tools/read-services.js';
import { fetchCliRuntimeReadiness } from '../../../apps/agent/src/integrations/tools/tool-runtime-readiness.js';
import {
  atlassianViaRuntime,
  datadogViaRuntime,
  gitlabViaRuntime,
} from '../../../apps/agent/src/integrations/tools/runtime-client.js';
import { validateGitlabOperation } from '../../../apps/agent/src/integrations/gitlab/gitlab-operations.js';
import {
  ATLASSIAN_CLOUD_ID,
  ATLASSIAN_EMAIL,
  ATLASSIAN_SITE,
  CHANNEL_ID,
  DATADOG_SITE,
  GITLAB_BINARY_PATH,
  GITLAB_BLOCKED_HOST,
  GITLAB_FILE_PATH,
  GITLAB_FILE_TEXT,
  GITLAB_HOST,
  GITLAB_PROJECT,
  GITLAB_RELEASE_BRANCH,
  GITLAB_UNAPPROVED_HOST,
  OTHER_TEAM_ID,
  SLACK_BOT_USER,
  SLACK_FIXTURE_USER,
  TEAM_ID,
  createUpstreamHandler,
  credentialsIn,
  misroutedCredentials,
  type ToolCredentials,
  type UpstreamRecord,
} from './native-tools-upstream.js';

const mode = process.argv[2];
const root = process.env.NATIVE_TEST_ROOT!;
const credentials = JSON.parse(
  fs.readFileSync(process.env.NATIVE_TEST_CREDENTIALS!, 'utf8'),
) as ToolCredentials;
const requestLog = path.join(root, 'upstream-requests.jsonl');

if (mode === 'upstream') {
  const handler = createUpstreamHandler(credentials, (entry) =>
    fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`),
  );
  https
    .createServer(
      {
        key: fs.readFileSync(process.env.NATIVE_TEST_TLS_KEY!),
        cert: fs.readFileSync(process.env.NATIVE_TEST_TLS_CERT!),
      },
      (req, res) => void handler(req, res),
    )
    .listen(443, () => console.log('tools upstream listening on 443'));
} else if (mode === 'client') {
  await client();
} else {
  throw new Error('mode must be upstream or client');
}

// --- client -----------------------------------------------------------------

async function client(): Promise<void> {
  const runtimeUrl = 'http://cli-runtime:9877';
  const runtimeToken = process.env.NATIVE_TEST_RUNTIME_TOKEN!;
  const adminToken = process.env.NATIVE_TEST_ADMIN_TOKEN!;
  const ids = {
    gitlab: 'ti_7001000000000001',
    atlassian: 'ti_7001000000000002',
    datadog: 'ti_7001000000000003',
    cloudflare: 'ti_7001000000000004',
    slack: 'ti_7001000000000005',
    gitlabUnapproved: 'ti_7001000000000006',
    gitlabBlocked: 'ti_7001000000000007',
  } as const;
  type Row = {
    id: string;
    teamId: string;
    kind: string;
    label: string;
    host: string | null;
    settings: Record<string, unknown>;
    hasCredential: boolean;
    credentialVersion: number;
    status: 'enabled' | 'disabled';
  };
  const row = (
    id: string,
    kind: string,
    label: string,
    host: string,
    settings: Record<string, unknown> = {},
  ): Row => ({
    id,
    teamId: TEAM_ID,
    kind,
    label,
    host,
    settings,
    hasCredential: true,
    credentialVersion: 1,
    status: 'enabled',
  });
  const instances: Row[] = [
    row(ids.gitlab, 'gitlab', 'Tools GitLab', GITLAB_HOST),
    row(ids.atlassian, 'atlassian', 'Tools Atlassian', ATLASSIAN_SITE, {
      cloudId: ATLASSIAN_CLOUD_ID,
      email: ATLASSIAN_EMAIL,
      operations: null,
    }),
    row(ids.datadog, 'datadog', 'Tools Datadog', DATADOG_SITE, {
      toolsets: 'all',
      denyTools: [],
    }),
    row(ids.cloudflare, 'cloudflare', 'Tools Cloudflare', 'api.cloudflare.com', {
      accountId: null,
      zones: null,
    }),
    row(ids.slack, 'slack', 'Tools Slack', 'slack.com'),
    row(ids.gitlabUnapproved, 'gitlab', 'Unapproved GitLab', GITLAB_UNAPPROVED_HOST),
    row(ids.gitlabBlocked, 'gitlab', 'Blocked GitLab', GITLAB_BLOCKED_HOST),
  ];
  const secretOf: Record<string, string> = {
    [ids.gitlab]: credentials.gitlab,
    [ids.atlassian]: JSON.stringify({ jira: credentials.jira, confluence: credentials.confluence }),
    [ids.datadog]: credentials.datadog,
    [ids.cloudflare]: credentials.cloudflare,
    [ids.slack]: credentials.slack,
    [ids.gitlabUnapproved]: credentials.gitlabUnapproved,
    [ids.gitlabBlocked]: credentials.gitlabBlocked,
  };
  const statuses = new Map<string, any>();
  const secretReads: string[] = [];
  let configVersion = 1;

  // The synthetic settings service: the three internal routes the CLI runtime uses.
  const settings = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part as Uint8Array));
    if (req.headers.authorization !== `Bearer ${adminToken}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://admin');
    if (req.method === 'GET' && url.pathname === '/internal/tool-instances') {
      const body = JSON.stringify({
        configVersion,
        instances: instances
          .filter((r) => r.status === 'enabled')
          .map(({ status: _status, ...r }) => r),
      });
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag }).end(body);
      return;
    }
    const secret = /^\/internal\/tool-instances\/(ti_[a-f0-9]{16})\/secret$/.exec(url.pathname);
    if (req.method === 'GET' && secret) {
      const instance = instances.find((r) => r.id === secret[1] && r.status === 'enabled');
      if (!instance || req.headers['x-support-agent-caller'] !== 'cli-runtime') {
        res.writeHead(404).end();
        return;
      }
      secretReads.push(instance.id);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: instance.id,
          kind: instance.kind,
          teamId: instance.teamId,
          credential: secretOf[instance.id],
          credentialVersion: instance.credentialVersion,
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/tool-instances/status') {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      for (const s of body.statuses)
        statuses.set(s.instanceId, { ...s, reporter: body.reporter, reportedAt: Date.now() });
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => settings.listen(9883, resolve));

  /** The channel's configuration as the settings service compiles it. */
  const configuration = (assigned: readonly string[]) => {
    const enabled = instances.filter((r) => r.status === 'enabled');
    const document = compileDocument(configVersion, {
      installations: [
        {
          teamId: TEAM_ID,
          teamName: 'Tools',
          botUserId: SLACK_BOT_USER,
          botId: 'BTOOLS',
          status: 'whitelisted',
          trustedBotSender: null,
        },
      ],
      channels: [{ teamId: TEAM_ID, channelId: CHANNEL_ID, enabled: true }],
      blockedMembers: [],
      toolInstances: instances,
      toolStatuses: [...statuses.values()],
      channelTools: enabled
        .filter((r) => assigned.includes(r.id))
        .map((r) => ({ teamId: TEAM_ID, channelId: CHANNEL_ID, kind: r.kind, instanceId: r.id })),
    } as never);
    return deriveCoordinatorConfig(document as never, {
      modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
      admission: { global: 5, perThread: 1 },
      execution: { maxInferenceInvocations: 4 },
    });
  };
  /** The agent's binding for one run of the channel with the given assignment. */
  const bind = async (assigned: readonly string[]) => {
    const binding = await nativeReadServices({
      configuration: async () => configuration(assigned),
      cli: { url: runtimeUrl, token: runtimeToken },
    })({ teamId: TEAM_ID, channelId: CHANNEL_ID } as never, new AbortController().signal);
    const tools = createReadServiceTools({ ...binding, authorize: async () => {} }) as Record<
      string,
      any
    >;
    return { binding, tools };
  };
  const call = async (tools: Record<string, any>, name: string, args: unknown) => {
    assert(tools[name], `tool ${name} is not offered`);
    // The service catalog answers { result, content }; `result` is the read.
    const answer = await tools[name].execute(args, {});
    assert(
      answer?.result,
      `tool ${name} returned no result: ${JSON.stringify(answer).slice(0, 300)}`,
    );
    return answer.result;
  };
  const upstream = (): UpstreamRecord[] =>
    fs.existsSync(requestLog)
      ? fs
          .readFileSync(requestLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const leaks = (value: unknown) => credentialsIn(JSON.stringify(value), credentials);
  const readiness = () => fetchCliRuntimeReadiness(runtimeUrl, runtimeToken);
  const stateOf = async (id: string) =>
    (await readiness()).instances.find((i) => i.instanceId === id);

  const tests: Array<{ name: string; status: 'pass' | 'fail'; ms: number; detail: unknown }> = [];
  const check = async (name: string, fn: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      const detail = await fn();
      assert.deepEqual(leaks(detail), [], 'a credential reached the report');
      tests.push({ name, status: 'pass', ms: Date.now() - started, detail });
    } catch (err) {
      const message = String((err as Error)?.stack ?? err);
      // Never write a credential, even into a failure.
      tests.push({
        name,
        status: 'fail',
        ms: Date.now() - started,
        detail: leaks(message).length > 0 ? 'failure text withheld: it held a credential' : message,
      });
    }
  };
  const all = [ids.gitlab, ids.atlassian, ids.datadog, ids.cloudflare, ids.slack];

  await check('runtime-syncs-instances-and-probes-through-the-egress-proxy', async () => {
    const end = Date.now() + 40_000;
    let report: Awaited<ReturnType<typeof readiness>> | undefined;
    for (;;) {
      report = await readiness();
      const state = (id: string) => report!.instances.find((i) => i.instanceId === id)?.state;
      const settled =
        all.every((id) => state(id) === 'ready') &&
        state(ids.gitlabUnapproved) === 'error' &&
        state(ids.gitlabBlocked) === 'blocked' &&
        [...all, ids.gitlabUnapproved, ids.gitlabBlocked].every((id) => statuses.has(id));
      if (settled) break;
      if (Date.now() > end)
        throw new Error(
          `readiness did not settle: ${JSON.stringify(report.instances.map((i) => [i.instanceId, i.state, i.detail]))}`,
        );
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(report.syncError, null);
    const unapproved = report.instances.find((i) => i.instanceId === ids.gitlabUnapproved)!;
    const blocked = report.instances.find((i) => i.instanceId === ids.gitlabBlocked)!;
    assert.match(blocked.detail, /not in GITLAB_HOSTS/);
    // The blocked instance is never probed, so its credential is never read.
    assert(!secretReads.includes(ids.gitlabBlocked));
    assert.equal(statuses.get(ids.gitlab).state, 'ready');
    return {
      states: Object.fromEntries(report.instances.map((i) => [i.label, i.state])),
      unapproved: unapproved.detail,
      blocked: blocked.detail,
      secretReads: [...new Set(secretReads)].length,
    };
  });

  const full = await bind(all);
  await check('channel-assignment-builds-the-tool-list', async () => {
    const names = Object.keys(full.tools).sort();
    for (const name of [
      'get_project',
      'list_projects',
      'list_branches',
      'list_merge_requests',
      'get_repository_file',
      'searchJiraIssues',
      'datadog_describe_tools',
      'datadog_call',
      'cloudflare_get',
      'slack_get_user',
    ])
      assert(names.includes(name), `${name} missing from ${names.join(',')}`);
    assert.deepEqual(
      full.binding.catalog.datadogTools?.map((t: any) => t.name),
      ['search_datadog_logs'],
      'the write tool must stay out of the pinned catalog',
    );
    const withoutSlack = await bind(all.filter((id) => id !== ids.slack));
    assert(!withoutSlack.binding.enabled.has('slack'));
    assert(!('slack_get_user' in withoutSlack.tools));
    await assert.rejects(withoutSlack.binding.services.slackGetUser({ user: SLACK_FIXTURE_USER }));
    const none = await bind([]);
    assert.equal(none.binding.enabled.size, 0);
    assert.equal(none.binding.catalog.gitlab, false);
    assert(!('get_project' in none.tools) && !('searchJiraIssues' in none.tools));
    return {
      assigned: names.length,
      withoutSlack: Object.keys(withoutSlack.tools).length,
      none: Object.keys(none.tools).length,
    };
  });

  await check('gitlab-read-through-egress', async () => {
    const result = await call(full.tools, 'get_project', { project: 'fixture/project' });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    assert.match(result.output, /TOOLS_FACT_gitlab_4242/);
    assert.match(result.output, /\[redacted\]/, 'the echoed credential must be redacted');
    assert.deepEqual(leaks(result), []);
    const reads = upstream().filter((r) => r.path === '/api/v4/projects/fixture%2Fproject');
    assert.equal(reads.length, 1, JSON.stringify(upstream().map((r) => r.path)));
    assert.deepEqual(reads[0]!.credentials, ['gitlab']);
    return { ok: result.ok, redacted: true };
  });

  /**
   * One GitLab tool call through the CLI runtime and the egress proxy: the
   * result, and the one API read it made, which carried only the GitLab
   * credential. The query comes back sorted by key.
   */
  const gitlabRead = async (name: string, args: Record<string, unknown>) => {
    const before = upstream().length;
    const result = await call(full.tools, name, args);
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    assert.deepEqual(leaks(result), []);
    const reads = upstream().slice(before);
    assert.equal(
      reads.length,
      1,
      JSON.stringify(reads.map((r) => `${r.method} ${r.host}${r.path}${r.query}`)),
    );
    const read = reads[0]!;
    assert.equal(read.host, GITLAB_HOST);
    assert.equal(read.status, 200, `${read.method} ${read.path}${read.query}`);
    assert.deepEqual(read.credentials, ['gitlab']);
    const query = [...new URLSearchParams(read.query)].sort(([a], [b]) => a.localeCompare(b));
    return { result, read: { method: read.method, path: read.path, raw: read.query, query } };
  };
  const sorted = (params: Record<string, string>) =>
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b));

  await check('gitlab-list-projects-through-egress', async () => {
    const { result, read } = await gitlabRead('list_projects', {
      search: 'fixture',
      page: 2,
      per_page: 5,
    });
    assert.equal(read.method, 'GET');
    assert.equal(read.path, '/api/v4/projects');
    assert.deepEqual(
      read.query,
      sorted({
        membership: 'true',
        simple: 'true',
        order_by: 'last_activity_at',
        sort: 'desc',
        search: 'fixture',
        page: '2',
        per_page: '5',
      }),
    );
    assert.deepEqual(
      result.data.map((p: any) => [p.id, p.path_with_namespace, p.default_branch]),
      [
        [4242, GITLAB_PROJECT, 'main'],
        [4243, 'fixture/other', 'trunk'],
      ],
    );
    assert.match(result.data[0].description, /^TOOLS_FACT_gitlab_list_projects echo \[redacted\]$/);
    return { request: `${read.method} ${read.path}${read.raw}`, projects: result.data.length };
  });

  await check('gitlab-list-branches-through-egress', async () => {
    const { result, read } = await gitlabRead('list_branches', {
      project: GITLAB_PROJECT,
      search: 'release',
      page: 1,
      per_page: 10,
    });
    assert.equal(read.method, 'GET');
    assert.equal(read.path, '/api/v4/projects/fixture%2Fproject/repository/branches');
    assert.deepEqual(read.query, sorted({ search: 'release', page: '1', per_page: '10' }));
    assert.deepEqual(
      result.data.map((b: any) => [b.name, b.default, b.protected, b.commit.short_id]),
      [[GITLAB_RELEASE_BRANCH, false, true, '5f1e2d3c']],
    );
    assert.match(
      result.data[0].commit.title,
      /^TOOLS_FACT_gitlab_branch_release echo \[redacted\]$/,
    );
    return { request: `${read.method} ${read.path}${read.raw}`, branches: result.data.length };
  });

  await check('gitlab-list-merge-requests-through-egress', async () => {
    const { result, read } = await gitlabRead('list_merge_requests', {
      project: GITLAB_PROJECT,
      state: 'merged',
      target_branch: 'main',
      page: 3,
      per_page: 2,
    });
    assert.equal(read.method, 'GET');
    assert.equal(read.path, '/api/v4/projects/fixture%2Fproject/merge_requests');
    assert.deepEqual(
      read.query,
      sorted({
        state: 'merged',
        target_branch: 'main',
        order_by: 'updated_at',
        sort: 'desc',
        page: '3',
        per_page: '2',
      }),
    );
    assert.deepEqual(
      result.data.map((m: any) => [m.iid, m.state, m.source_branch, m.target_branch]),
      [[17, 'merged', GITLAB_RELEASE_BRANCH, 'main']],
    );
    assert.match(result.data[0].title, /^TOOLS_FACT_gitlab_mr_17 /);
    assert.equal(result.data[0].description, 'echo [redacted]');
    return { request: `${read.method} ${read.path}${read.raw}`, mergeRequests: result.data.length };
  });

  await check('gitlab-get-repository-file-through-egress', async () => {
    const { result, read } = await gitlabRead('get_repository_file', {
      project: GITLAB_PROJECT,
      file_path: GITLAB_FILE_PATH,
      ref: GITLAB_RELEASE_BRANCH,
    });
    // The nested path is one encoded path parameter; the ref is an encoded query value.
    assert.equal(read.method, 'GET');
    assert.equal(
      read.path,
      '/api/v4/projects/fixture%2Fproject/repository/files/docs%2Frunbooks%2Fon%20call.md',
    );
    assert.equal(read.raw, '?ref=release%2F2026.11');
    assert.deepEqual(
      [result.data.file_path, result.data.ref, result.data.encoding],
      [GITLAB_FILE_PATH, GITLAB_RELEASE_BRANCH, 'text'],
    );
    // The runtime decodes the file before it redacts: the credential the
    // file echoes inside its base64 content is redacted in the decoded text.
    assert.equal(result.data.content, `${GITLAB_FILE_TEXT}echo [redacted]\n`);
    assert.match(result.output, /^ok \(get_repository_file @ fixture\/project\):\n/);
    assert.match(result.output, /TOOLS_FACT_gitlab_file at release\/2026\.11/);
    return { request: `${read.method} ${read.path}${read.raw}`, bytes: result.data.size };
  });

  await check('gitlab-get-binary-repository-file-is-reported-without-content', async () => {
    const { result, read } = await gitlabRead('get_repository_file', {
      project: GITLAB_PROJECT,
      file_path: GITLAB_BINARY_PATH,
      ref: GITLAB_RELEASE_BRANCH,
    });
    assert.equal(
      read.path,
      '/api/v4/projects/fixture%2Fproject/repository/files/assets%2Flogo.png',
    );
    assert.deepEqual(
      [result.data.file_path, result.data.content, result.data.binary, result.data.content_note],
      [GITLAB_BINARY_PATH, null, true, 'binary file content is not returned as text'],
    );
    return { request: `${read.method} ${read.path}${read.raw}`, bytes: result.data.size };
  });

  await check('atlassian-read-through-egress', async () => {
    const result = await call(full.tools, 'searchJiraIssues', {
      query: 'lunar lighthouse handoff',
      maxResults: 5,
    });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    assert.match(result.output, /KAN-1/);
    assert.match(result.output, /TOOLS_FACT_jira/);
    return { ok: result.ok };
  });

  await check('datadog-read-through-egress', async () => {
    const matches = await call(full.tools, 'datadog_describe_tools', { search: 'logs' });
    assert.equal(matches.ok, true);
    const [match] = JSON.parse(matches.output);
    assert.equal(match.name, 'search_datadog_logs');
    assert.equal(match.inputSchema, undefined);
    const schema = await call(full.tools, 'datadog_describe_tools', { names: [match.name] });
    assert.equal(schema.ok, true);
    assert.equal(JSON.parse(schema.output)[0].inputSchema.type, 'object');
    const result = await call(full.tools, 'datadog_call', {
      tool: 'search_datadog_logs',
      arguments: { query: 'env:prod status:error' },
    });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    assert.match(result.output, /TOOLS_FACT_datadog/);
    assert(upstream().some((r) => r.rpc === 'tools/call search_datadog_logs'));
    return { ok: result.ok };
  });

  await check('cloudflare-read-through-egress', async () => {
    const result = await call(full.tools, 'cloudflare_get', { path: '/user/tokens/verify' });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    assert.match(result.output, /"active"/);
    return { ok: result.ok };
  });

  await check('slack-read-through-egress', async () => {
    const result = await call(full.tools, 'slack_get_user', { user: SLACK_FIXTURE_USER });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    assert.match(result.output, /TOOLS_FACT_slack Fixture Person/);
    assert.match(result.output, /\[redacted\]/, 'the echoed credential must be redacted');
    assert.deepEqual(leaks(result), []);
    return { ok: result.ok, redacted: true };
  });

  await check('each-credential-reaches-only-its-own-service', async () => {
    const records = upstream();
    assert.deepEqual(misroutedCredentials(records), []);
    const expected: Array<[string, RegExp, string[]]> = [
      [GITLAB_HOST, /^\/api\/v4\//, ['gitlab']],
      ['api.atlassian.com', /^\/ex\/jira\//, ['jira']],
      ['api.atlassian.com', /^\/ex\/confluence\//, ['confluence']],
      [`mcp.${DATADOG_SITE}`, /^\/v1\/mcp$/, ['datadog']],
      ['api.cloudflare.com', /^\/client\/v4\//, ['cloudflare']],
      ['slack.com', /^\/api\//, ['slack']],
    ];
    const counts: Record<string, number> = {};
    for (const [host, pathPattern, owners] of expected) {
      const matching = records.filter((r) => r.host === host && pathPattern.test(r.path));
      assert(matching.length > 0, `no request reached ${host} ${pathPattern}`);
      for (const r of matching)
        assert.deepEqual(r.credentials, owners, `${r.method} ${r.host}${r.path}`);
      counts[`${host}${pathPattern.source.slice(1, 12)}`] = matching.length;
    }
    assert.equal(records.filter((r) => r.status === 404).length, 0, 'every request had a fixture');
    return { requests: records.length, counts };
  });

  await check('egress-proxy-refuses-hosts-it-does-not-approve', async () => {
    const connect = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = net.connect(3128, 'egress-tools', () =>
          socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
        );
        socket.once('data', (chunk) => {
          resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString('latin1'))?.[1] ?? 0));
          socket.destroy();
        });
        socket.once('error', reject);
        socket.setTimeout(5000, () => reject(new Error(`CONNECT ${host} timed out`)));
      });
    const approved = await connect('api.cloudflare.com');
    const unapproved = await connect(GITLAB_UNAPPROVED_HOST);
    const unknown = await connect('example.org');
    assert.equal(approved, 200);
    assert.equal(unapproved, 403);
    assert.equal(unknown, 403);
    // The runtime admits the host, the proxy does not: the probe never reached it.
    const state = await stateOf(ids.gitlabUnapproved);
    assert.equal(state?.state, 'error');
    assert.equal(upstream().filter((r) => r.host === GITLAB_UNAPPROVED_HOST).length, 0);
    const refused = await gitlabViaRuntime(
      {
        instanceId: ids.gitlabUnapproved,
        teamId: TEAM_ID,
        operation: 'get_project',
        operationArgs: validateGitlabOperation('get_project', { project: 'fixture/project' }),
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      },
      runtimeUrl,
      runtimeToken,
      20_000,
    );
    assert.equal(refused.status, 'not_run');
    assert.match(refused.refused ?? '', /not ready/);
    return { approved, unapproved, unknown, readiness: state?.detail };
  });

  await check('foreign-workspace-and-unknown-instances-are-refused', async () => {
    const before = upstream().length;
    const request = (instanceId: string, teamId: string) =>
      gitlabViaRuntime(
        {
          instanceId,
          teamId,
          operation: 'get_project',
          operationArgs: validateGitlabOperation('get_project', { project: 'fixture/project' }),
          timeoutMs: 10_000,
          maxOutputBytes: 10_000,
        },
        runtimeUrl,
        runtimeToken,
        20_000,
      );
    const foreign = await request(ids.gitlab, OTHER_TEAM_ID);
    assert.match(foreign.refused ?? '', /belongs to another workspace/);
    const unknown = await request('ti_70010000000000ff', TEAM_ID);
    assert.match(unknown.refused ?? '', /unknown gitlab tool instance/);
    const blocked = await request(ids.gitlabBlocked, TEAM_ID);
    assert.match(blocked.refused ?? '', /is blocked: host not admitted/);
    assert.equal(upstream().length, before);
    return { foreign: foreign.refused, unknown: unknown.refused, blocked: blocked.refused };
  });

  await check('runtime-refuses-write-attempts-of-read-only-tools', async () => {
    const before = upstream().length;
    // The current, valid bindings: the refusal is the read-only rule, not a mismatch.
    const d = ((await stateOf(ids.datadog)) as any).datadog;
    const a = ((await stateOf(ids.atlassian)) as any).atlassian;
    const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    const datadogBinding = pick(d, [
      'site',
      'endpoint',
      'adapter',
      'contractVersion',
      'toolCatalogHash',
      'credentialFingerprint',
    ]);
    const atlassianBinding = pick(a, [
      'site',
      'cloudId',
      'adapter',
      'contractVersion',
      'operations',
      'credentialFingerprints',
    ]);
    const dd = await datadogViaRuntime(
      {
        instanceId: ids.datadog,
        teamId: TEAM_ID,
        tool: 'create_datadog_notebook',
        arguments: { name: 'write attempt' },
        binding: datadogBinding,
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      } as never,
      runtimeUrl,
      runtimeToken,
    );
    assert.equal(dd.status, 'not_run');
    assert.match(dd.refused ?? '', /not in the pinned read catalog/);
    const at = await atlassianViaRuntime(
      {
        instanceId: ids.atlassian,
        teamId: TEAM_ID,
        operation: 'createJiraIssue',
        operationArgs: { summary: 'write attempt' },
        binding: atlassianBinding,
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      } as never,
      runtimeUrl,
      runtimeToken,
    );
    assert.equal(at.status, 'not_run');
    assert.match(at.refused ?? '', /invalid Atlassian operation/);
    const cf = (await (
      await fetch(`${runtimeUrl}/cloudflare`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          instanceId: ids.cloudflare,
          teamId: TEAM_ID,
          operation: 'post',
          request: { path: '/zones' },
          binding: {},
        }),
      })
    ).json()) as { refused?: string };
    assert.match(cf.refused ?? '', /unknown Cloudflare operation/);
    const after = upstream().slice(before);
    assert.deepEqual(after, [], 'a refused write reached a service');
    return { datadog: dd.refused, atlassian: at.refused, cloudflare: cf.refused };
  });

  await check('revoked-instance-is-refused-at-the-next-call', async () => {
    const before = upstream().filter((r) => r.host === 'api.cloudflare.com').length;
    // The operator disables the instance in the settings service.
    instances.find((r) => r.id === ids.cloudflare)!.status = 'disabled';
    configVersion += 1;
    const end = Date.now() + 15_000;
    while ((await stateOf(ids.cloudflare)) !== undefined) {
      if (Date.now() > end) throw new Error('the runtime kept the revoked instance');
      await new Promise((r) => setTimeout(r, 250));
    }
    // A binding made before the revocation (a run in progress) is refused.
    const stale = await call(full.tools, 'cloudflare_get', { path: '/user/tokens/verify' });
    assert.equal(stale.ok, false);
    assert.match(stale.output, /unknown cloudflare tool instance/);
    // The next run no longer offers the tool.
    const next = await bind(all);
    assert(!next.binding.enabled.has('cloudflare'));
    assert(!('cloudflare_get' in next.tools));
    assert.equal(upstream().filter((r) => r.host === 'api.cloudflare.com').length, before);
    return { stale: stale.output, nextRunOffersCloudflare: false };
  });

  fs.writeFileSync(
    path.join(root, 'tools-report.json'),
    JSON.stringify({ suite: 'tools', tests }, null, 2),
  );
  settings.close();
  const failed = tests.filter((t) => t.status !== 'pass');
  for (const t of tests) console.log(`${t.status} ${t.name} ${t.ms} ms`);
  process.exit(failed.length === 0 ? 0 : 1);
}
