import { randomBytes } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { GitlabTransportRequest } from '../../../src/integrations/tools/runtime-client.js';
import {
  GITLAB_CONTRACT_VERSION,
  validateTransportGitlabArgs,
  type ValidatedGitlabArgs,
} from '../../../src/integrations/gitlab/gitlab-operations.js';
import {
  buildGitlabRequest,
  createTextRetainer,
} from '../../../src/integrations/gitlab/gitlab-rest-adapter.js';
import { redactTraceOutput } from '../../../../tool-runtime/src/main.js';

/** The job of project g/p whose trace the fake serves; any other job is 404. */
export const FAKE_TRACE_JOB_ID = 4242;
/** The test that failed once and passed on retry in the fake trace. */
export const FAKE_FLAKY_TEST = 'filters.spec.ts:40:3 › filter by brand keeps selection';
/** A fake personal access token printed near the top of the fake trace. */
export const FAKE_TRACE_TOKEN = `glpat-${randomBytes(16).toString('hex')}`;
export const FAKE_TRACE_FILLER_LINES = 1500;

/**
 * A GitLab-shaped Playwright job log larger than MAX_TRACE_BYTES: ANSI
 * colours, GitLab section markers, `\r` progress overwrites, credentials
 * printed by the job, filler, and a reporter summary with one retried test.
 */
export function fakeJobTrace(fillerLines = FAKE_TRACE_FILLER_LINES): string {
  const lines = [
    '\x1b[0KRunning with gitlab-runner 17.4.0 (abcdef12)\x1b[0;m',
    'section_start:1760000000:prepare_executor\r\x1b[0K\x1b[0K\x1b[36;1mPreparing the "docker" executor\x1b[0;m',
    'Using Docker executor with image mcr.microsoft.com/playwright:v1.48.0 ...',
    'section_end:1760000004:prepare_executor\r\x1b[0K',
    'section_start:1760000005:step_script\r\x1b[0K\x1b[0K\x1b[36;1mExecuting "step_script" stage of the job script\x1b[0;m',
    `$ git clone https://ci-user:${FAKE_TRACE_TOKEN}@gitlab.example.test/g/p.git`,
    '$ curl -H "PRIVATE-TOKEN: hunter2-private-value" https://gitlab.example.test/api/v4/user',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'Downloading browsers 10%\rDownloading browsers 55%\rDownloading browsers 100%',
    'trace-head-marker start-of-log',
  ];
  for (let i = 1; i <= fillerLines; i += 1) lines.push(`filler line ${i} of the e2e setup output`);
  lines.push(
    'Running 42 tests using 4 workers',
    '  \x1b[32m✓\x1b[39m  1 [chromium] › search.spec.ts:12:5 › search shows results (2.1s)',
    `  \x1b[31m✘\x1b[39m  2 [chromium] › ${FAKE_FLAKY_TEST} (30.0s)`,
    `  \x1b[32m✓\x1b[39m  3 [chromium] › ${FAKE_FLAKY_TEST} (retry #1) (12.4s)`,
    '  1 flaky',
    `    [chromium] › ${FAKE_FLAKY_TEST}`,
    '  41 passed (3.2m)',
    'section_end:1760000200:step_script\r\x1b[0K',
    '\x1b[32;1mJob succeeded\x1b[0;m',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * What the credential-owning runtime answers for a trace body: the same
 * streaming retention and redaction, applied to an in-memory body.
 */
export function runtimeTraceAnswer(body: string, part: 'head' | 'tail', chunkBytes = 4096) {
  const retainer = createTextRetainer({ bytes: 48_000, part });
  const raw = Buffer.from(body, 'utf8');
  for (let at = 0; at < raw.length; at += chunkBytes) {
    if (retainer.push(raw.subarray(at, at + chunkBytes)) === 'cut') break;
  }
  const { text, meta } = retainer.finish();
  return {
    status: 'completed' as const,
    httpStatus: 200,
    output: redactTraceOutput(text),
    truncated: meta.cut || meta.returnedBytes < meta.totalBytes,
    textMeta: meta,
  };
}

export interface FakePerson {
  id: number;
  username: string;
  name: string;
  /** Not projected to the model (dropped by the people projection). */
  state?: string;
}

export interface FakeMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: string;
  title: string;
  description: string;
  author: FakePerson;
  assignees: FakePerson[];
  reviewers: FakePerson[];
  labels: string[];
  draft: boolean;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface FakeIssue {
  id: number;
  iid: number;
  project_id: number;
  web_url: string;
  state: string;
  title: string;
  description: string;
  author: FakePerson;
  assignees: FakePerson[];
  labels: string[];
  confidential: boolean;
  created_at: string;
  updated_at: string;
}

/** The token's own user: author of every merge request the fake creates. */
export const FAKE_BOT: FakePerson = {
  id: 1,
  username: 'support-agent-bot',
  name: 'support-agent bot',
};
const ALICE: FakePerson = { id: 11, username: 'Alice.Doe', name: 'Alice Doe', state: 'active' };
const BOB: FakePerson = { id: 12, username: 'bob', name: 'Bob' };
const CAROL: FakePerson = { id: 13, username: 'carol-x', name: 'Carol' };

type ListArgs = Extract<ValidatedGitlabArgs, { kind: 'list_merge_requests' | 'list_issues' }>;

/** The fake's answer to the list filters the typed contract sends (literal semantics). */
function listMatches<T extends FakeMergeRequest | FakeIssue>(
  items: T[],
  args: ListArgs,
  projectIds: number[],
): T[] {
  const mr = args.kind === 'list_merge_requests' ? args : undefined;
  const filtered = items.filter(
    (item) =>
      projectIds.includes(item.project_id) &&
      (args.state === 'all' || item.state === args.state) &&
      (args.author_username === undefined || item.author.username === args.author_username) &&
      (args.assignee_username === undefined ||
        item.assignees.some((person) => person.username === args.assignee_username)) &&
      (args.labels === undefined || args.labels.every((label) => item.labels.includes(label))) &&
      (args.search === undefined || item.title.includes(args.search)) &&
      (args.created_after === undefined || item.created_at >= args.created_after) &&
      (args.created_before === undefined || item.created_at <= args.created_before) &&
      (args.updated_after === undefined || item.updated_at >= args.updated_after) &&
      (args.updated_before === undefined || item.updated_at <= args.updated_before) &&
      (mr === undefined ||
        ((mr.reviewer_username === undefined ||
          (item as FakeMergeRequest).reviewers.some(
            (person) => person.username === mr.reviewer_username,
          )) &&
          (mr.draft === undefined || (item as FakeMergeRequest).draft === mr.draft) &&
          (mr.source_branch === undefined ||
            (item as FakeMergeRequest).source_branch === mr.source_branch) &&
          (mr.target_branch === undefined ||
            (item as FakeMergeRequest).target_branch === mr.target_branch))),
  );
  const key = args.order_by === 'due_date' ? 'created_at' : args.order_by;
  const direction = args.sort === 'asc' ? 1 : -1;
  return filtered
    .sort((a, b) => direction * a[key].localeCompare(b[key]))
    .slice((args.page - 1) * args.per_page, args.page * args.per_page);
}

/**
 * Deterministic GitLab for runner workflows: authenticated smart-HTTP Git
 * for two projects (g/p, g/q) the token reaches, plus a fake isolated tool
 * runtime (/readyz and the typed /gitlab route) whose answers mimic GitLab's
 * stdout/stderr. The runtime serves one admin-managed GitLab instance
 * (`instanceId` on `instanceHost` for workspace `teamId`) and refuses
 * requests for any other. Projects outside `projects` are unreachable (404).
 * The merge-request and issue lists serve project, group (`g`, both
 * projects) and instance scope over fixture items of other people plus the
 * merge requests the run created, with the contract's people, label, draft,
 * date and ordering filters.
 */
export async function startGitLab() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gitlab-'));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@local',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@local',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const projects = [
    { id: 4242, path: 'g/p', fact: 'amber-falcon-3102' },
    { id: 4343, path: 'g/q', fact: 'cobalt-heron-4417' },
  ];
  const remotes: Record<string, string> = {};
  for (const project of projects) {
    const seed = path.join(root, 'seed', project.path);
    fs.mkdirSync(seed, { recursive: true });
    run(seed, 'init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(seed, 'app.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(seed, 'FACT.txt'), `${project.fact}\n`);
    fs.writeFileSync(path.join(seed, 'obsolete.txt'), 'remove this\n');
    fs.writeFileSync(path.join(seed, 'package.json'), '{"scripts":{"test":"node app.js"}}');
    run(seed, 'add', '.');
    run(seed, 'commit', '-qm', 'base');
    const remote = path.join(root, `${project.path}.git`);
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    run(root, 'clone', '-q', '--bare', seed, remote);
    run(remote, 'config', 'http.receivepack', 'true');
    remotes[project.path] = remote;
  }
  const token = 'synthetic-gitlab-only';
  const instanceId = 'ti_00000000000000aa';
  const teamId = 'T0123456789';
  const runtimeToken = 'synthetic-runtime-only';
  /** Groups the token reaches; a group lists its member projects (subgroups included). */
  const groups = [{ id: 77, path: 'g', projectIds: [4242, 4343] }];
  const mrs: FakeMergeRequest[] = [];
  /** Other people's merge requests and issues, served by the list operations only. */
  const fixtureMrs: FakeMergeRequest[] = [
    {
      id: 9101,
      iid: 101,
      project_id: 4242,
      web_url: '',
      source_branch: 'feature/alice-api',
      target_branch: 'main',
      state: 'opened',
      title: 'API pagination',
      description: 'Alice opened this',
      author: ALICE,
      assignees: [BOB],
      reviewers: [CAROL],
      labels: ['backend'],
      draft: false,
      created_at: '2026-08-01T09:00:00Z',
      updated_at: '2026-09-10T09:00:00Z',
      merged_at: null,
    },
    {
      id: 9102,
      iid: 102,
      project_id: 4343,
      web_url: '',
      source_branch: 'feature/alice-ui',
      target_branch: 'main',
      state: 'merged',
      title: 'UI polish',
      description: 'Alice merged this',
      author: ALICE,
      assignees: [],
      reviewers: [BOB],
      labels: ['frontend'],
      draft: true,
      created_at: '2026-09-05T09:00:00Z',
      updated_at: '2026-09-20T09:00:00Z',
      merged_at: '2026-09-20T09:00:00Z',
    },
    {
      id: 9103,
      iid: 103,
      project_id: 4242,
      web_url: '',
      source_branch: 'feature/bob-docs',
      target_branch: 'main',
      state: 'opened',
      title: 'Docs',
      description: 'Bob opened this',
      author: BOB,
      assignees: [ALICE],
      reviewers: [],
      labels: ['docs'],
      draft: false,
      created_at: '2026-07-01T09:00:00Z',
      updated_at: '2026-07-02T09:00:00Z',
      merged_at: null,
    },
  ];
  const fixtureIssues: FakeIssue[] = [
    {
      id: 9201,
      iid: 7,
      project_id: 4242,
      web_url: '',
      state: 'opened',
      title: 'Crash on start',
      description: 'Reported by Alice',
      author: ALICE,
      assignees: [BOB],
      labels: ['bug'],
      confidential: false,
      created_at: '2026-09-02T09:00:00Z',
      updated_at: '2026-09-03T09:00:00Z',
    },
    {
      id: 9202,
      iid: 8,
      project_id: 4343,
      web_url: '',
      state: 'closed',
      title: 'Old request',
      description: 'Reported by Bob',
      author: BOB,
      assignees: [],
      labels: [],
      confidential: false,
      created_at: '2025-12-01T09:00:00Z',
      updated_at: '2025-12-02T09:00:00Z',
    },
  ];
  for (const item of [...fixtureMrs, ...fixtureIssues]) {
    const owner = projects.find((entry) => entry.id === item.project_id)!;
    item.web_url = `https://gitlab.test/${owner.path}/-/${'source_branch' in item ? 'merge_requests' : 'issues'}/${item.iid}`;
  }
  const state = {
    creates: 0,
    pushes: 0,
    loseCreateReply: false,
    gitAuthRequests: 0,
    operations: [] as string[],
    /** REST endpoint (relative to /api/v4) the runtime would request, per typed call. */
    endpoints: [] as string[],
    /** `GET /user`: the token's own user, who authors published commits. */
    currentUser: { ...FAKE_BOT, email: 'support-agent-bot@example.test' } as Record<
      string,
      unknown
    >,
    /** Issues created through `create_issue` (feedback issues). */
    createdIssues: [] as FakeIssue[],
    /**
     * The next `create_issue` answer instead of a created issue: the HTTP
     * status of a failure, `timeout` (execution deadline), `malformed` (HTTP 200, bad
     * JSON) or `hang` (the runtime never answers).
     */
    nextIssueFailure: null as string | null,
  };
  let base = '';

  const gitServer = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://test');
    const project = projects.find((entry) => url.pathname.startsWith(`/${entry.path}.git/`));
    if (project === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (
      req.headers.authorization !== `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`
    ) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
      res.end();
      return;
    }
    state.gitAuthRequests++;
    if (url.pathname.endsWith('/git-receive-pack')) state.pushes++;
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'test',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    let headers = Buffer.alloc(0);
    let sent = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (sent) {
        res.write(chunk);
        return;
      }
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) return;
      const values: Record<string, string> = {};
      let status = 200;
      for (const line of headers.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = parseInt(value);
        else values[name] = value;
      }
      res.writeHead(status, values);
      res.write(headers.subarray(end + 4));
      sent = true;
    });
    child.stderr.resume();
    child.on('close', () => res.end());
    child.on('error', () => res.destroy());
    req.pipe(child.stdin);
  });
  await new Promise<void>((resolve) => gitServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gitServer.address() as { port: number }).port}`;
  const host = new URL(base).host;
  // The instance's host is the loopback server (host:port), like a self-managed GitLab.
  const instanceHost = host;

  /** Answer of the typed /gitlab route. */
  const answer = (request: GitlabTransportRequest) => {
    const args = request.operationArgs as unknown as Record<string, unknown>;
    state.operations.push(request.operation);
    const ok = (data: unknown) => ({
      status: 'completed',
      httpStatus: 200,
      output: JSON.stringify(data),
      truncated: false,
    });
    const fail = (httpStatus: number, message: string) => ({
      status: 'failed',
      httpStatus,
      output: JSON.stringify({ message }),
      truncated: false,
    });
    // The runtime re-validates the transport shape and builds the fixed request.
    let validated: ValidatedGitlabArgs;
    try {
      validated = validateTransportGitlabArgs(request.operation, request.operationArgs);
    } catch (err) {
      return fail(400, `400 ${(err as Error).message}`);
    }
    state.endpoints.push(buildGitlabRequest(validated).endpoint);
    if (validated.kind === 'get_current_user') return ok(state.currentUser);
    // Merge request and issue lists: project, group, or instance scope.
    if (validated.kind === 'list_merge_requests' || validated.kind === 'list_issues') {
      let projectIds: number[];
      if (validated.project !== undefined) {
        const scoped = projects.find(
          (entry) => String(entry.id) === validated.project || entry.path === validated.project,
        );
        if (scoped === undefined) return fail(404, '404 Project Not Found');
        projectIds = [scoped.id];
      } else if (validated.group !== undefined) {
        const group = groups.find(
          (entry) => String(entry.id) === validated.group || entry.path === validated.group,
        );
        if (group === undefined) return fail(404, '404 Group Not Found');
        projectIds = group.projectIds;
      } else {
        projectIds = projects.map((entry) => entry.id);
      }
      return validated.kind === 'list_merge_requests'
        ? ok(listMatches([...fixtureMrs, ...mrs], validated, projectIds))
        : ok(listMatches(fixtureIssues, validated, projectIds));
    }
    const project = projects.find(
      (entry) => String(entry.id) === String(args.project) || entry.path === args.project,
    );
    if (project === undefined) return fail(404, '404 Project Not Found');
    const own = mrs.filter((mr) => mr.project_id === project.id);
    if (validated.kind === 'get_job_trace') {
      if (project.path !== 'g/p' || validated.job_id !== FAKE_TRACE_JOB_ID) {
        return {
          status: 'failed',
          httpStatus: 404,
          output: '{"message":"404 Not found"}',
          truncated: false,
        };
      }
      return runtimeTraceAnswer(fakeJobTrace(), validated.head ? 'head' : 'tail');
    }
    switch (request.operation) {
      case 'get_project':
        return ok({
          id: project.id,
          path_with_namespace: project.path,
          default_branch: 'main',
          web_url: `${base}/${project.path}`,
        });
      case 'get_merge_request': {
        const found = own.find((mr) => mr.iid === args.merge_request_iid);
        return found === undefined ? fail(404, '404 Not Found') : ok(found);
      }
      case 'create_merge_request': {
        if (own.some((mr) => mr.source_branch === args.source_branch && mr.state === 'opened'))
          return fail(409, '409 Conflict: Another open merge request already exists');
        state.creates++;
        const iid = own.length + 1;
        const mr: FakeMergeRequest = {
          id: state.creates,
          iid,
          project_id: project.id,
          web_url: `https://${instanceHost}/${project.path}/-/merge_requests/${iid}`,
          source_branch: String(args.source_branch),
          target_branch: String(args.target_branch),
          state: 'opened',
          title: String(args.title),
          description: String(args.description ?? ''),
          author: FAKE_BOT,
          assignees: [],
          reviewers: [],
          labels: [],
          draft: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          merged_at: null,
        };
        mrs.push(mr);
        if (state.loseCreateReply) {
          state.loseCreateReply = false;
          return null;
        }
        return ok(mr);
      }
      case 'create_issue': {
        const failure = state.nextIssueFailure;
        state.nextIssueFailure = null;
        if (failure === 'timeout')
          return { status: 'timed_out', httpStatus: null, output: '', truncated: false };
        if (failure === 'malformed')
          return { status: 'completed', httpStatus: 200, output: '{"iid":', truncated: false };
        if (failure === 'hang') return 'hang';
        if (failure !== null) return fail(Number(failure), 'scripted failure');
        const iid = state.createdIssues.length + 1;
        const issue: FakeIssue = {
          id: 9000 + iid,
          iid,
          project_id: project.id,
          web_url: `${base}/${project.path}/-/issues/${iid}`,
          state: 'opened',
          title: String(args.title),
          description: String(args.description ?? ''),
          author: FAKE_BOT,
          assignees: [],
          labels: (args.labels as string[] | undefined) ?? [],
          confidential: args.confidential === true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.createdIssues.push(issue);
        if (state.loseCreateReply) {
          state.loseCreateReply = false;
          return null;
        }
        return ok(issue);
      }
      case 'update_merge_request': {
        const found = own.find((mr) => mr.iid === args.merge_request_iid);
        if (found === undefined) return fail(404, '404 Not Found');
        if (typeof args.description === 'string') found.description = args.description;
        if (typeof args.title === 'string') found.title = args.title;
        return ok(found);
      }
      default:
        return fail(400, `400 operation ${request.operation} is not served by this fake`);
    }
  };

  const requests: Array<{ instanceId: string; teamId: string }> = [];
  const runtimeServer = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${runtimeToken}`) {
      send(401, {});
      return;
    }
    if (req.url === '/readyz') {
      send(200, {
        service: 'cli-runtime',
        configVersion: 1,
        syncError: null,
        instances: [
          {
            instanceId,
            teamId,
            kind: 'gitlab',
            label: 'GitLab (fake)',
            credentialVersion: 1,
            state: 'ready',
            detail: 'ready',
            gitlab: {
              tool: 'gitlab',
              ready: true,
              status: 'ready',
              detail: 'ready',
              host: instanceHost,
              contractVersion: GITLAB_CONTRACT_VERSION,
            },
          },
        ],
      });
      return;
    }
    if (req.url === '/gitlab' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw) as GitlabTransportRequest;
      requests.push({ instanceId: request.instanceId, teamId: request.teamId });
      if (request.instanceId !== instanceId || request.teamId !== teamId) {
        send(200, {
          status: 'not_run',
          httpStatus: null,
          output: 'unknown gitlab tool instance',
          truncated: false,
          refused: 'unknown gitlab tool instance',
        });
        return;
      }
      const result = answer(request);
      // A lost acknowledgment: the write happened, the reply never arrives.
      if (result === null) res.destroy();
      else if (result === 'hang') return;
      else send(200, result);
      return;
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => runtimeServer.listen(0, '127.0.0.1', resolve));
  const runtimeUrl = `http://127.0.0.1:${(runtimeServer.address() as { port: number }).port}`;

  return {
    base,
    host,
    token,
    runtimeUrl,
    runtimeToken,
    instanceId,
    instanceHost,
    teamId,
    /** Instance references of every typed request the runtime received. */
    requests,
    /** The channel tool assignment the agent serves for this instance. */
    assignment: (channelId: string) => ({
      teamId,
      channelId,
      tools: [
        {
          kind: 'gitlab',
          instanceId,
          label: 'GitLab (fake)',
          credentialVersion: 1,
          ready: true,
          detail: null,
          host: instanceHost,
        },
      ],
    }),
    projects,
    groups,
    state,
    mrs,
    fixtureMrs,
    fixtureIssues,
    remotes,
    run,
    /** HTTP transport for a canonical path (the deterministic clone/push override). */
    transportUrl: (canonicalPath: string) => `${base}/${canonicalPath}.git`,
    close: async () => {
      await new Promise<void>((resolve) => gitServer.close(() => resolve()));
      runtimeServer.closeAllConnections();
      await new Promise<void>((resolve) => runtimeServer.close(() => resolve()));
      if (process.env.SUPPORT_AGENT_TEST_RETAIN_EVIDENCE !== '1')
        fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
