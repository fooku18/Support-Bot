/**
 * Several GitLab checkouts per thread: clone (identity from GitLab), exec and
 * verify through the executor, verification-gated publication with one task
 * MR per project, follow-ups, and crash reconciliation. Real Git remotes
 * (file:// on a loopback host), fake typed GitLab and fake executor calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CheckoutError,
  CheckoutManager,
  checkoutDigest,
  readCheckouts,
  resolveCheckout,
  verificationReadiness,
  verificationSummary,
  type CheckoutRecord,
} from '../../../src/domain/publication/checkouts.js';
import {
  publishCheckout,
  type PublishProjectOptions,
} from '../../../src/domain/publication/publish-project.js';
import {
  PublisherError,
  lsRemoteHead,
  readIntent,
} from '../../../src/domain/publication/publisher.js';
import {
  operationScopeLabel,
  type ValidatedGitlabArgs,
} from '../../../src/integrations/gitlab/gitlab-operations.js';
import type { GitlabNormalizedResult } from '../../../src/integrations/gitlab/gitlab-rest-adapter.js';
import {
  workspacePaths,
  type WorkspacePaths,
} from '../../../src/infrastructure/storage/workspace-paths.js';
import {
  buildCandidateManifest,
  type WorkExecResult,
} from '../../../src/domain/publication/candidate-manifest.js';
import { resolveWithin } from '../../../src/domain/publication/guard.js';
import { createStageLogger } from '../../../src/infrastructure/logger.js';

const WORKSPACE_ID = '0123456789abcdef';
const TASK_BRANCH = 'support-agent/0123456789abcdef';
const TRANSFER = { maxFiles: 1000, maxFileBytes: 1_000_000, maxTotalBytes: 20_000_000 };

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRemote(root: string, name: string, files: Record<string, string>): string {
  const remote = path.join(root, 'remotes', `${name}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ['init', '--bare', '-q', '--initial-branch=main']);
  const seed = path.join(root, 'seed', name);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '--initial-branch=main']);
  git(seed, ['config', 'user.email', 't@local']);
  git(seed, ['config', 'user.name', 't']);
  for (const [file, content] of Object.entries(files))
    fs.writeFileSync(path.join(seed, file), content);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-qm', 'seed']);
  git(seed, ['push', '-q', remote, 'main']);
  return remote;
}

interface FakeMr {
  iid: number;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: string;
  description: string;
  title: string;
  project_id: number;
}

/** In-memory typed GitLab for two projects plus scripted failures. */
function fakeGitlab(projects: Array<{ id: number; path: string }>) {
  const mrs: FakeMr[] = [];
  const calls: string[] = [];
  type Category = NonNullable<GitlabNormalizedResult['errorCategory']>;
  /** One scripted failure per operation, optionally with GitLab's excerpt. */
  const failOnce = new Map<string, Category | { category: Category; detail: string }>();
  /** `GET /user`: the token's own user, who authors published commits. */
  const user: { current: Record<string, unknown> } = {
    current: {
      id: 1,
      username: 'support-agent-bot',
      name: 'Support Agent Bot',
      email: 'support-agent-bot@example.test',
    },
  };
  const project = (ref: string) =>
    projects.find((entry) => String(entry.id) === ref || entry.path === ref);
  const ok = (validated: ValidatedGitlabArgs, data: unknown): GitlabNormalizedResult => ({
    ok: true,
    operation: validated.kind,
    project: operationScopeLabel(validated),
    data,
    pagination: {},
    truncated: false,
    warnings: [],
  });
  const fail = (
    validated: ValidatedGitlabArgs,
    category: NonNullable<GitlabNormalizedResult['errorCategory']>,
  ): GitlabNormalizedResult => ({
    ...ok(validated, null),
    ok: false,
    errorCategory: category,
    error: category,
  });
  const gitlab = async (validated: ValidatedGitlabArgs): Promise<GitlabNormalizedResult> => {
    calls.push(validated.kind);
    const injected = failOnce.get(validated.kind);
    if (injected !== undefined) {
      failOnce.delete(validated.kind);
      return typeof injected === 'string'
        ? fail(validated, injected)
        : { ...fail(validated, injected.category), detail: injected.detail };
    }
    if (validated.kind === 'get_current_user') return ok(validated, user.current);
    // Publication reads only use the project form; group and instance lists find nothing here.
    const target = 'project' in validated ? project(String(validated.project)) : undefined;
    if (target === undefined) return fail(validated, 'not_found');
    switch (validated.kind) {
      case 'get_project':
        return ok(validated, {
          id: target.id,
          path_with_namespace: target.path,
          default_branch: 'main',
          web_url: `https://127.0.0.1/${target.path}`,
        });
      case 'list_merge_requests':
        return ok(
          validated,
          mrs.filter(
            (mr) =>
              mr.project_id === target.id &&
              (validated.source_branch === undefined ||
                mr.source_branch === validated.source_branch),
          ),
        );
      case 'get_merge_request': {
        const found = mrs.find(
          (mr) => mr.project_id === target.id && mr.iid === validated.merge_request_iid,
        );
        return found === undefined ? fail(validated, 'not_found') : ok(validated, found);
      }
      case 'create_merge_request': {
        if (
          mrs.some(
            (mr) =>
              mr.project_id === target.id &&
              mr.source_branch === validated.source_branch &&
              mr.state === 'opened',
          )
        )
          return fail(validated, 'conflict');
        const record: FakeMr = {
          iid: mrs.filter((mr) => mr.project_id === target.id).length + 1,
          web_url: '',
          source_branch: validated.source_branch,
          target_branch: validated.target_branch,
          state: 'opened',
          description: validated.description ?? '',
          title: validated.title,
          project_id: target.id,
        };
        record.web_url = `https://127.0.0.1/${target.path}/-/merge_requests/${record.iid}`;
        mrs.push(record);
        return ok(validated, record);
      }
      case 'update_merge_request': {
        const found = mrs.find(
          (mr) => mr.project_id === target.id && mr.iid === validated.merge_request_iid,
        );
        if (found === undefined) return fail(validated, 'not_found');
        if (validated.description !== undefined) found.description = validated.description;
        return ok(validated, found);
      }
      default:
        return fail(validated, 'unsupported');
    }
  };
  return { gitlab, mrs, calls, failOnce, user };
}

/** Executor stand-in: `true`/`false` argv decide the exit code; no changes returned. */
const executorCalls = {
  sync: async () => ({ digest: 'd', files: 0 }),
  exec: async (args: { argv: string[] }): Promise<WorkExecResult> => ({
    status: args.argv[0] === 'false' ? 'failed' : 'completed',
    exitCode: args.argv[0] === 'false' ? 1 : 0,
    durationMs: 3,
    output: `ran ${args.argv.join(' ')}\n`,
    truncated: false,
  }),
};

describe('multi-repository checkouts and publication', () => {
  let root: string;
  let paths: WorkspacePaths;
  let remotes: Record<string, string>;
  let fake: ReturnType<typeof fakeGitlab>;
  let registered: CheckoutRecord[];
  let baselined: string[];
  let warnings: string[];
  let retainNativeEvidence: boolean;
  const transportUrl = (canonicalPath: string): string =>
    `file://${remotes[canonicalPath] ?? '/nonexistent'}`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkouts-'));
    remotes = {
      'example-group/test': makeRemote(root, 'test', { hello: 'amber-falcon-3102\n' }),
      'example-group/test2': makeRemote(root, 'test2', { hello: 'cobalt-heron-4417\n' }),
    };
    paths = workspacePaths(path.join(root, 'store'), WORKSPACE_ID);
    fs.mkdirSync(paths.checkouts, { recursive: true });
    fake = fakeGitlab([
      { id: 100001, path: 'example-group/test' },
      { id: 100002, path: 'example-group/test2' },
    ]);
    registered = [];
    baselined = [];
    warnings = [];
    retainNativeEvidence = false;
  });
  afterEach(() => {
    if (retainNativeEvidence || process.env.SUPPORT_AGENT_TEST_RETAIN_EVIDENCE === '1') {
      fs.mkdirSync('artifacts/native-publication', { recursive: true });
      fs.writeFileSync(
        path.join('artifacts/native-publication', `${path.basename(root)}.json`),
        JSON.stringify({ root, retained: true }, null, 2),
      );
      return;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = (runSeq = 1) =>
    new CheckoutManager({
      paths,
      workspaceId: WORKSPACE_ID,
      gitlabHost: '127.0.0.1',
      gitlabToken: 'synthetic-token',
      stagingRoot: path.join(root, 'store'),
      transfer: TRANSFER,
      gitlab: fake.gitlab,
      runSeq,
      register: async (record) => {
        registered.push(record);
      },
      onCloned: (record) => baselined.push(record.slug),
      maxOutputBytes: 10_000,
      log: createStageLogger('checkouts-test'),
      executeInPlace: executorCalls.exec,
      transportUrl,
    });
  const publishOptions = (checkouts: CheckoutManager, runSeq = 1): PublishProjectOptions => ({
    paths,
    storageDir: path.join(root, 'store'),
    workspaceId: WORKSPACE_ID,
    gitlabHost: '127.0.0.1',
    gitlabToken: 'synthetic-token',
    transfer: TRANSFER,
    gitlab: fake.gitlab,
    checkouts,
    run: { runId: `run-${runSeq}`, runSeq, attempt: 1 },
    redact: (text) => text.replaceAll('synthetic-token', '[redacted]'),
    log: { ...createStageLogger('publish-test'), warn: (message) => warnings.push(message) },
    transportUrl,
  });

  it('clones several projects by path or ID into separate checkouts on the task branch', async () => {
    const checkouts = manager();
    const first = await checkouts.clone('example-group/test');
    expect(first.output).toContain(
      'cloned example-group/test (project 100001) into example-group__test/',
    );
    const second = await checkouts.clone(100002);
    expect(second.ok).toBe(true);
    const records = readCheckouts(paths);
    expect(records.map((record) => [record.project, record.slug, record.baseBranch])).toEqual([
      ['example-group/test', 'example-group__test', 'main'],
      ['example-group/test2', 'example-group__test2', 'main'],
    ]);
    for (const record of records) {
      const dir = path.join(paths.checkouts, record.slug);
      expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(TASK_BRANCH);
      expect(record.baseCommit).toBe(git(dir, ['rev-parse', 'HEAD']));
    }
    expect(fs.readFileSync(path.join(paths.checkouts, 'example-group__test2/hello'), 'utf8')).toBe(
      'cobalt-heron-4417\n',
    );
    expect(registered.map((record) => record.projectId)).toEqual([100001, 100002]);
    expect(baselined).toEqual(['example-group__test', 'example-group__test2']);
    // Re-cloning is a no-op reporting the checkout.
    const again = await checkouts.clone('example-group/test');
    expect(again.output).toMatch(/^already cloned/);
    expect(registered).toHaveLength(2);
    // Unknown or unreadable projects are explicit.
    await expect(checkouts.clone('group/missing')).rejects.toThrow(/not readable: \[not_found\]/);
    await expect(checkouts.clone('https://evil/x/y')).rejects.toThrow(/project/);
    await expect(checkouts.clone('example-group/test', 'support-agent/x')).resolves.toBeDefined();
    // Addressing: path, ID, slug; ambiguity when omitted.
    expect(resolveCheckout(records, 100002).slug).toBe('example-group__test2');
    expect(resolveCheckout(records, 'EXAMPLE-GROUP/TEST').slug).toBe('example-group__test');
    expect(() => resolveCheckout(records, undefined)).toThrow(/several repositories are cloned/);
    expect(() => resolveCheckout([], undefined)).toThrow(/clone_repository first/);
    expect(() => resolveCheckout(records, 'group/other')).toThrow(/not cloned/);
    expect(resolveCheckout([records[0]!], undefined).slug).toBe('example-group__test');
  });

  it('refuses a missing ref and cleans interrupted clones', async () => {
    const checkouts = manager();
    await expect(checkouts.clone('example-group/test', 'no-such-branch')).rejects.toThrow(
      /clone of example-group\/test \(no-such-branch\) failed/,
    );
    expect(fs.existsSync(path.join(paths.checkouts, 'example-group__test'))).toBe(false);
    expect(readCheckouts(paths)).toEqual([]);
  });

  it('records verification per checkout and gates publication on the exact tree', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    const dir = path.join(paths.checkouts, 'example-group__test');
    fs.writeFileSync(path.join(dir, 'hello'), 'amber-falcon-3102\nchanged\n');
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(
      /has no verification/,
    );
    const failed = await checkouts.verify({ argv: ['false'], timeoutMs: 1000 });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain('verification failed');
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(/`false` failed/);
    const passed = await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    expect(passed.ok).toBe(true);
    // Every declared command must pass: `false` is still failing.
    const record = readCheckouts(paths)[0]!;
    expect(verificationReadiness(record, checkoutDigest(dir, TRANSFER)).ready).toBe(false);
    // Recovery must be explicit and cannot retire a check on the same tree.
    const replaces = { argv: ['false'], reason: 'Implementation changed to the supported runtime' };
    await expect(checkouts.verify({ argv: ['true'], timeoutMs: 1000, replaces })).rejects.toThrow(
      /changed tree/,
    );
    fs.appendFileSync(path.join(dir, 'hello'), 'runtime changed\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000, replaces });
    const fixed = readCheckouts(paths)[0]!;
    expect(fixed.verifications.find((v) => v.argv[0] === 'false')).toMatchObject({
      status: 'failed',
      supersededBy: { argv: ['true'], reason: replaces.reason },
    });
    expect(verificationReadiness(fixed, checkoutDigest(dir, TRANSFER)).ready).toBe(true);
    // An edit after verification makes it stale.
    fs.writeFileSync(path.join(dir, 'hello'), 'edited again\n');
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(
      /passed on an older tree/,
    );
    const summary = verificationSummary(
      readCheckouts(paths),
      new Map([['example-group__test', checkoutDigest(dir, TRANSFER)]]),
    );
    expect(summary.status).toBe('not_run');
    expect(fake.calls).not.toContain('create_merge_request');
  });

  it('keeps failed replacements and unrelated project checks required', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    await checkouts.clone('example-group/test2');
    for (const project of ['example-group/test', 'example-group/test2'])
      await checkouts.verify({ project, argv: ['false', 'old'], timeoutMs: 1000 });
    const dir = path.join(paths.checkouts, 'example-group__test');
    fs.appendFileSync(path.join(dir, 'hello'), 'new implementation\n');
    const replaces = { argv: ['false', 'old'], reason: 'Replaced obsolete implementation' };
    const failed = await checkouts.verify({
      project: 'example-group/test',
      argv: ['false', 'new'],
      replaces,
      timeoutMs: 1000,
    });
    expect(failed.ok).toBe(false);
    expect(readCheckouts(paths)[0]!.verifications.every((v) => !v.supersededBy)).toBe(true);
    await checkouts.verify({
      project: 'example-group/test',
      argv: ['true'],
      replaces,
      timeoutMs: 1000,
    });
    expect(
      verificationReadiness(readCheckouts(paths)[0]!, checkoutDigest(dir, TRANSFER)).ready,
    ).toBe(false);
    expect(readCheckouts(paths)[1]!.verifications[0]!.supersededBy).toBeUndefined();
    await expect(
      checkouts.verify({
        project: 'example-group/test',
        argv: ['true'],
        replaces,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/active verification/);
  });

  it('publishes a replacement only after a passing reconciled check and retains its failed predecessor', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    await checkouts.verify({ argv: ['false'], timeoutMs: 1000 });
    const dir = path.join(paths.checkouts, 'example-group__test');
    fs.appendFileSync(path.join(dir, 'hello'), 'replacement implementation\n');
    await checkouts.verify({
      argv: ['true'],
      timeoutMs: 1000,
      replaces: { argv: ['false'], reason: 'Replaced obsolete implementation' },
    });
    const published = await publishCheckout(publishOptions(checkouts), {});
    expect(published.state).toBe('completed');
    expect(git(remotes['example-group/test']!, ['show', `${published.commit}:hello`])).toContain(
      'replacement implementation',
    );
    expect(readCheckouts(paths)[0]!.verifications).toHaveLength(2);
    expect(
      verificationSummary(
        readCheckouts(paths),
        new Map([['example-group__test', checkoutDigest(dir, TRANSFER)]]),
      ).status,
    ).toBe('passed');
  });

  it('refuses record overflow without forgetting a failed requirement', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    await checkouts.verify({ argv: ['false'], timeoutMs: 1000 });
    for (let i = 1; i < 20; i++)
      await checkouts.verify({ argv: ['true', String(i)], timeoutMs: 1000 });
    await expect(checkouts.verify({ argv: ['true', 'overflow'], timeoutMs: 1000 })).rejects.toThrow(
      /record limit/,
    );
    const records = readCheckouts(paths);
    expect(records[0]!.verifications).toHaveLength(20);
    expect(records[0]!.verifications[0]!.status).toBe('failed');
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(/`false` failed/);
  });

  it('publishes two projects from one thread with separate MRs and updates both on follow-up', async () => {
    const checkouts = manager(1);
    await checkouts.clone('example-group/test');
    await checkouts.clone('example-group/test2');
    for (const [slug, text] of [
      ['example-group__test', 'amber-falcon-3102\nfirst change\n'],
      ['example-group__test2', 'cobalt-heron-4417\nfirst change\n'],
    ] as const) {
      fs.writeFileSync(path.join(paths.checkouts, slug, 'hello'), text);
      await checkouts.verify({ project: slug, argv: ['true'], timeoutMs: 1000 });
    }
    const first = await publishCheckout(publishOptions(checkouts, 1), {
      project: 'example-group/test',
      title: 'Change test',
    });
    const second = await publishCheckout(publishOptions(checkouts, 1), {
      project: 100002,
      title: 'Change test2 synthetic-token',
      description: 'Why: shared change',
    });
    expect(first).toMatchObject({
      state: 'completed',
      project: 'example-group/test',
      projectId: 100001,
      branch: TASK_BRANCH,
      targetBranch: 'main',
      mrIid: 1,
      mrUrl: 'https://127.0.0.1/example-group/test/-/merge_requests/1',
    });
    expect(second.mrUrl).toBe('https://127.0.0.1/example-group/test2/-/merge_requests/1');
    expect(fake.mrs).toHaveLength(2);
    // Secrets are redacted from model text; the task marker is present.
    expect(fake.mrs[1]!.title).toBe('support-agent: Change test2 [redacted]');
    expect(fake.mrs[1]!.description).toContain('Why: shared change');
    expect(fake.mrs[1]!.description).toContain(`[task:${WORKSPACE_ID}]`);
    for (const [project, text] of [
      ['example-group/test', 'first change'],
      ['example-group/test2', 'first change'],
    ] as const) {
      const head = await lsRemoteHead(`file://${remotes[project]}`, TASK_BRANCH, 't');
      expect(head).toBe(project === 'example-group/test' ? first.commit : second.commit);
      const shown = git(remotes[project]!, ['show', `${head}:hello`]);
      expect(shown).toContain(text);
      // The default branch is never written.
      expect(git(remotes[project]!, ['log', '--format=%s', '-1', 'main'])).toBe('seed');
    }
    // Follow-up run: both projects change again; the same MRs are updated.
    const followUp = manager(2);
    for (const slug of ['example-group__test', 'example-group__test2']) {
      fs.appendFileSync(path.join(paths.checkouts, slug, 'hello'), 'second change\n');
      await followUp.verify({ project: slug, argv: ['true'], timeoutMs: 1000 });
    }
    const updatedA = await publishCheckout(publishOptions(followUp, 2), {
      project: 'example-group/test',
    });
    const updatedB = await publishCheckout(publishOptions(followUp, 2), {
      project: 'example-group/test2',
    });
    expect([updatedA.mrIid, updatedB.mrIid]).toEqual([1, 1]);
    expect(fake.mrs).toHaveLength(2);
    expect(git(remotes['example-group/test']!, ['rev-parse', `${updatedA.commit}^`])).toBe(
      first.commit,
    );
    expect(fake.mrs[0]!.description).toContain('Run: 2');
    expect(fake.mrs[0]!.description.match(/support-agent:start/g)).toHaveLength(1);
    const records = readCheckouts(paths);
    expect(records.map((record) => record.publication?.runSeq)).toEqual([2, 2]);
  });

  it('authors the published commit as the GitLab token user (looked up once per publication)', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'authored\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    fake.user.current = {
      id: 7,
      username: 'project_100001_bot',
      name: 'Project Bot',
      commit_email: 'project_100001_bot@noreply.gitlab.test',
    };
    const published = await publishCheckout(publishOptions(checkouts), { title: 'Authored' });
    const remote = remotes['example-group/test']!;
    expect(git(remote, ['show', '-s', '--format=%an|%ae|%cn|%ce', published.commit!])).toBe(
      'Project Bot|project_100001_bot@noreply.gitlab.test|Project Bot|project_100001_bot@noreply.gitlab.test',
    );
    expect(git(remote, ['show', '-s', '--format=%s', published.commit!])).toBe(
      'support-agent: Authored',
    );
    expect(fake.calls.filter((kind) => kind === 'get_current_user')).toHaveLength(1);
  });

  it('rechecks actor authorization immediately before push and leaves the remote untouched on denial', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(
      path.join(paths.checkouts, 'example-group__test/hello'),
      'blocked publication\n',
    );
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    let checked = false;
    await expect(
      publishCheckout(
        {
          ...publishOptions(checkouts),
          authorize: async () => {
            checked = true;
            throw new Error('actor blocked');
          },
        },
        { title: 'Must not publish' },
      ),
    ).rejects.toThrow('actor blocked');
    expect(checked).toBe(true);
    expect(
      await lsRemoteHead(`file://${remotes['example-group/test']}`, TASK_BRANCH, 't'),
    ).toBeNull();
    expect(fake.mrs).toEqual([]);
  });

  it('stops publication before any push when the GitLab token user has no usable e-mail', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'no email\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    fake.user.current = { id: 7, username: 'nomail', name: 'No Mail', email: '', public_email: '' };
    const failure = await publishCheckout(publishOptions(checkouts), {}).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PublisherError);
    expect((failure as PublisherError).terminal).toBe(true);
    expect((failure as Error).message).toMatch(
      /GitLab token's user @nomail has no usable e-mail address/,
    );
    expect(
      await lsRemoteHead(`file://${remotes['example-group/test']}`, TASK_BRANCH, 't'),
    ).toBeNull();
    expect(readIntent(path.join(root, 'store'), WORKSPACE_ID, 'example-group__test')).toMatchObject(
      {
        state: 'failed',
        lastError: expect.stringMatching(/no usable e-mail/),
      },
    );
    expect(fake.calls).not.toContain('create_merge_request');
  });

  it('surfaces and logs the reason when GitLab declines the push', async () => {
    const remote = remotes['example-group/test']!;
    fs.writeFileSync(
      path.join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "GL-HOOK-ERR: Commit author is not a GitLab user." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'declined\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    const failure = await publishCheckout(publishOptions(checkouts), {}).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PublisherError);
    expect((failure as Error).message).toMatch(
      /^remote rejected the push: GL-HOOK-ERR: Commit author is not a GitLab user\./,
    );
    expect((failure as Error).message).not.toMatch(/externally/);
    expect(readIntent(path.join(root, 'store'), WORKSPACE_ID, 'example-group__test')).toMatchObject(
      {
        state: 'failed',
        lastError: expect.stringMatching(/^remote rejected the push: GL-HOOK-ERR/),
      },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('publication failure project=example-group/test');
    expect(warnings[0]).toContain('[remote rejected]');
    expect(warnings[0]).not.toContain('synthetic-token');
    expect(fake.calls).not.toContain('create_merge_request');
  });

  it('reconciles a crash between push and MR creation without a duplicate MR', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'crash test\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    fake.failOnce.set('create_merge_request', 'upstream');
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(PublisherError);
    const intent = readIntent(path.join(root, 'store'), WORKSPACE_ID, 'example-group__test');
    expect(intent).toMatchObject({ state: 'failed', mrIid: null });
    const pushed = await lsRemoteHead(`file://${remotes['example-group/test']}`, TASK_BRANCH, 't');
    expect(pushed).toBe(intent?.commit);
    const retried = await publishCheckout(publishOptions(checkouts), {});
    expect(retried.commit).toBe(intent?.commit);
    expect(fake.mrs).toHaveLength(1);
    // A lost MR acknowledgment (the MR exists) is found instead of recreated.
    fake.mrs[0]!.description += '\nhuman note';
    const again = await publishCheckout(publishOptions(checkouts), {});
    expect(again.mrIid).toBe(1);
    expect(fake.mrs).toHaveLength(1);
    expect(fake.mrs[0]!.description).toContain('human note');
  });

  it('publishes the task MR in a later run when the tree was pushed but MR creation failed', async () => {
    // Production 2026-10-23 (handbook thread): run 3 pushed and MR creation
    // failed (GitLab request failed); run 4 refused with "snapshot is unchanged".
    const checkouts = manager(3);
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'handbook change\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    fake.failOnce.set('create_merge_request', {
      category: 'upstream',
      detail: 'could not decode the response: unexpected EOF',
    });
    const failure = await publishCheckout(publishOptions(checkouts, 3), {
      title: 'Handbook',
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PublisherError);
    expect((failure as PublisherError).terminal).toBe(false);
    expect((failure as Error).message).toBe('task MR creation failed: [upstream] upstream');
    // GitLab's excerpt reaches the runner log with the failure.
    expect(warnings).toContainEqual(
      expect.stringContaining('could not decode the response: unexpected EOF'),
    );
    const intent = readIntent(path.join(root, 'store'), WORKSPACE_ID, 'example-group__test');
    expect(intent).toMatchObject({ state: 'failed', mrIid: null });
    expect(intent?.expectedRemoteHead).toBe(intent?.commit);
    const remote = `file://${remotes['example-group/test']}`;
    expect(await lsRemoteHead(remote, TASK_BRANCH, 't')).toBe(intent?.commit);
    expect(fake.mrs).toHaveLength(0);
    // Run 4: the same tree is republished from a run without a staged commit.
    const next = manager(4);
    await next.verify({ argv: ['true'], timeoutMs: 1000 });
    const published = await publishCheckout(publishOptions(next, 4), { title: 'Handbook' });
    expect(published).toMatchObject({ state: 'completed', commit: intent?.commit, mrIid: 1 });
    expect(await lsRemoteHead(remote, TASK_BRANCH, 't')).toBe(intent?.commit);
    expect(fake.mrs).toHaveLength(1);
    expect(fake.mrs[0]).toMatchObject({ source_branch: TASK_BRANCH, target_branch: 'main' });
    expect(fake.mrs[0]!.description).toContain(`[task:${WORKSPACE_ID}]`);
    expect(fake.mrs[0]!.description).toContain(`Run: 4 | Commit: ${intent?.commit}`);
    expect(readIntent(path.join(root, 'store'), WORKSPACE_ID, 'example-group__test')).toMatchObject(
      {
        state: 'completed',
        mrIid: 1,
        lastError: null,
      },
    );
  });

  it.each(
    ['create', 'update'].flatMap((mode) =>
      [
        { project_id: 999 },
        { web_url: 'https://foreign.invalid/g/p/-/merge_requests/1' },
        { source_branch: 'different-source' },
        { target_branch: 'different-target' },
        { state: 'closed' },
        { description: 'task marker removed' },
        { iid: 0 },
        ...(mode === 'update' ? [{ iid: 2 }] : []),
      ].map((change) => ({ mode, change })),
    ),
  )('rejects $mode acknowledgement mismatch $change', async ({ mode, change }) => {
    retainNativeEvidence = true;
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    const file = path.join(paths.checkouts, 'example-group__test/hello');
    fs.writeFileSync(file, 'first verified tree\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    if (mode === 'update') {
      await publishCheckout(publishOptions(checkouts), {});
      fs.writeFileSync(file, 'second verified tree\n');
      await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    }
    const options = publishOptions(checkouts);
    let observed = false;
    let confirmed = false;
    options.confirmed = async () => {
      confirmed = true;
    };
    options.gitlab = async (request) => {
      const response = await fake.gitlab(request);
      if (request.kind === `${mode}_merge_request`) {
        observed = true;
        return { ...response, data: { ...(response.data as object), ...change } };
      }
      return response;
    };
    await expect(publishCheckout(options, {})).rejects.toThrow(PublisherError);
    expect(observed).toBe(true);
    expect(confirmed).toBe(false);
    expect(
      readIntent(path.join(root, 'store'), WORKSPACE_ID, 'example-group__test')?.state,
    ).not.toBe('completed');
  });
  it('still refuses to publish a tree identical to the base branch', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(
      'snapshot is unchanged; no commit to publish',
    );
    expect(
      await lsRemoteHead(`file://${remotes['example-group/test']}`, TASK_BRANCH, 't'),
    ).toBeNull();
    expect(fake.calls).not.toContain('create_merge_request');
  });

  it('keeps the candidate for a retry after a retryable failure and drops it once published', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'retained\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    const store = path.join(paths.root, 'verified-snapshots', 'project-100001');
    fake.failOnce.set('list_merge_requests', 'timeout');
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(
      'task MR lookup failed: [timeout] timeout',
    );
    const kept = fs.readdirSync(store).sort();
    expect(kept).toHaveLength(2);
    const digest = kept[0]!;
    expect(kept[1]).toBe(`${digest}.json`);
    const inode = fs.statSync(path.join(store, digest, 'hello')).ino;
    // The retry reuses the retained copy (same inode at the first GitLab call).
    const seen: number[] = [];
    const published = await publishCheckout(
      {
        ...publishOptions(checkouts),
        gitlab: async (validated) => {
          if (seen.length === 0) seen.push(fs.statSync(path.join(store, digest, 'hello')).ino);
          return fake.gitlab(validated);
        },
      },
      {},
    );
    expect(published.state).toBe('completed');
    expect(seen).toEqual([inode]);
    expect(fs.readdirSync(store)).toEqual([]);
    // A terminal stop leaves no copy either.
    fake.mrs[0]!.state = 'merged';
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'after merge\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(/was merged/);
    expect(fs.readdirSync(store)).toEqual([]);
  });

  it('keeps the event loop running while it captures the candidate', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    const dir = path.join(paths.checkouts, 'example-group__test');
    fs.mkdirSync(path.join(dir, 'bulk'));
    for (let i = 0; i < 200; i += 1)
      fs.writeFileSync(path.join(dir, 'bulk', `file-${i}.txt`), `${i}\n`.repeat(2000));
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    let ticks = 0;
    let ticksAtFirstCall: number | null = null;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      await publishCheckout(
        {
          ...publishOptions(checkouts),
          gitlab: async (validated) => {
            ticksAtFirstCall ??= ticks;
            return fake.gitlab(validated);
          },
        },
        {},
      );
    } finally {
      clearInterval(timer);
    }
    // Previously, manifest, copy and re-hash ran synchronously before the
    // first GitLab call: no timer could fire in between.
    expect(ticksAtFirstCall).toBeGreaterThan(5);
  });

  // Ported from the retained executor-new-directories-publication and
  // large-checkout-publication live scenarios: commands run in place, so files
  // they create in new nested directories are part of the published tree.
  it('publishes over 500 files in new nested directories and updates the same MR', async () => {
    const checkouts = manager(1);
    await checkouts.clone('example-group/test');
    const dir = path.join(paths.checkouts, 'example-group__test');
    const token = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 12);
    for (let part = 0; part < 5; part += 1) {
      fs.mkdirSync(path.join(dir, 'many-files', `part-${part}`), { recursive: true });
      for (let i = 0; i < 120; i += 1) {
        const name = `many-files/part-${part}/file-${i}.txt`;
        fs.writeFileSync(path.join(dir, name), `${token(name)}\n`);
      }
    }
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    const first = await publishCheckout(publishOptions(checkouts, 1), { title: 'Many files' });
    const remote = remotes['example-group/test']!;
    const tree = (commit: string) =>
      git(remote, ['ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean);
    expect(tree(first.commit!).filter((f) => f.startsWith('many-files/'))).toHaveLength(600);
    expect(git(remote, ['show', `${first.commit}:many-files/part-4/file-119.txt`])).toBe(
      token('many-files/part-4/file-119.txt'),
    );
    // Follow-up: edit one file and add a further nested new directory.
    const followUp = manager(2);
    fs.mkdirSync(path.join(dir, 'many-files', 'part-5', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'many-files/part-5/deep/file.txt'), 'deep-token\n');
    fs.writeFileSync(path.join(dir, 'many-files/part-0/file-0.txt'), 'edited\n');
    await followUp.verify({ argv: ['true'], timeoutMs: 1000 });
    const second = await publishCheckout(publishOptions(followUp, 2), {});
    expect(second.mrIid).toBe(first.mrIid);
    expect(fake.mrs).toHaveLength(1);
    expect(git(remote, ['rev-parse', `${second.commit}^`])).toBe(first.commit);
    expect(tree(second.commit!).filter((f) => f.startsWith('many-files/'))).toHaveLength(601);
    expect(git(remote, ['show', `${second.commit}:many-files/part-5/deep/file.txt`])).toBe(
      'deep-token',
    );
    expect(git(remote, ['show', `${second.commit}:many-files/part-0/file-0.txt`])).toBe('edited');
  });

  it('stops publication when the task MR was merged or closed', async () => {
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'v1\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    await publishCheckout(publishOptions(checkouts), {});
    fake.mrs[0]!.state = 'merged';
    fs.writeFileSync(path.join(paths.checkouts, 'example-group__test/hello'), 'v2\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(/was merged/);
    expect(fake.mrs).toHaveLength(1);
  });

  it('refuses a cwd outside the checkout before any executor call, uncounted, with the valid directories', async () => {
    const synced: string[] = [];
    const checkouts = new CheckoutManager({
      ...(manager() as unknown as { options: ConstructorParameters<typeof CheckoutManager>[0] })
        .options,
      executeInPlace: async (args) => {
        synced.push(path.basename(args.dir));
        return executorCalls.exec(args);
      },
    });
    await checkouts.clone('example-group/test');
    await checkouts.clone('example-group/test2');
    fs.mkdirSync(path.join(paths.checkouts, 'example-group__test/src'), { recursive: true });
    const refused = await checkouts
      .exec({ project: 'example-group/test', argv: ['ls'], cwd: 'slack-runner', timeoutMs: 1000 })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(CheckoutError);
    expect((refused as CheckoutError).uncounted).toBe(true);
    const message = (refused as Error).message;
    expect(message).toContain('cwd "slack-runner" is not a directory of example-group/test');
    expect(message).toContain('Its top-level directories: src/');
    expect(message).toContain(
      'Other checkouts (pass their project instead): example-group__test2/',
    );
    expect(synced).toEqual([]);
    // Escapes are refused the same way; a real directory runs.
    await expect(
      checkouts.exec({ project: 'example-group/test', argv: ['ls'], cwd: '..', timeoutMs: 1000 }),
    ).rejects.toThrow(/is not a directory/);
    await checkouts.exec({
      project: 'example-group/test',
      argv: ['ls'],
      cwd: 'src',
      timeoutMs: 1000,
    });
    expect(synced).toEqual(['example-group__test']);
  });
});

/**
 * clone intake through the local transport with committed links and
 * gitlinks, end to end (clone, change detection, verification sync,
 * publication), and verification refused when the command's changes could
 * not be reconciled.
 */
describe('committed symlinks and submodules', () => {
  let root: string;
  let paths: WorkspacePaths;
  let remotes: Record<string, string>;
  let fake: ReturnType<typeof fakeGitlab>;
  const transportUrl = (canonicalPath: string): string =>
    `file://${remotes[canonicalPath] ?? '/nonexistent'}`;

  /** A remote whose seed commit is shaped by `seed` (links, gitlinks). */
  function linkedRemote(name: string, seed: (dir: string) => void): string {
    const remote = path.join(root, 'remotes', `${name}.git`);
    fs.mkdirSync(remote, { recursive: true });
    git(remote, ['init', '--bare', '-q', '--initial-branch=main']);
    const dir = path.join(root, 'seed', name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '--initial-branch=main']);
    git(dir, ['config', 'user.email', 't@local']);
    git(dir, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'hello'), 'amber-falcon-3102\n');
    seed(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'seed']);
    git(dir, ['push', '-q', remote, 'main']);
    return remote;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkouts-links-'));
    remotes = {};
    paths = workspacePaths(path.join(root, 'store'), WORKSPACE_ID);
    fs.mkdirSync(paths.checkouts, { recursive: true });
    fake = fakeGitlab([{ id: 100001, path: 'example-group/test' }]);
  });
  afterEach(() => {
    if (process.env.SUPPORT_AGENT_TEST_RETAIN_EVIDENCE === '1') {
      fs.mkdirSync('artifacts/native-publication', { recursive: true });
      fs.writeFileSync(
        path.join('artifacts/native-publication', `${path.basename(root)}.json`),
        JSON.stringify({ root, retained: true }),
      );
      return;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Executor stand-in: the real sync manifest (transfer refusals), scripted exec changes. */
  const manager = () =>
    new CheckoutManager({
      paths,
      workspaceId: WORKSPACE_ID,
      gitlabHost: '127.0.0.1',
      gitlabToken: 'synthetic-token',
      stagingRoot: path.join(root, 'store'),
      transfer: TRANSFER,
      gitlab: fake.gitlab,
      runSeq: 1,
      register: async () => {},
      onCloned: () => {},
      maxOutputBytes: 10_000,
      log: createStageLogger('checkouts-links-test'),
      executeInPlace: executorCalls.exec,
      transportUrl,
    });
  const publishOptions = (checkouts: CheckoutManager): PublishProjectOptions => ({
    paths,
    storageDir: path.join(root, 'store'),
    workspaceId: WORKSPACE_ID,
    gitlabHost: '127.0.0.1',
    gitlabToken: 'synthetic-token',
    transfer: TRANSFER,
    gitlab: fake.gitlab,
    checkouts,
    run: { runId: 'run-1', runSeq: 1, attempt: 1 },
    redact: (text) => text,
    log: createStageLogger('publish-links-test'),
    transportUrl,
  });
  const slugDir = () => path.join(paths.checkouts, 'example-group__test');

  it('clones, verifies and publishes a checkout with a committed in-tree link', async () => {
    remotes['example-group/test'] = linkedRemote('test', (dir) => {
      fs.mkdirSync(path.join(dir, 'apps', 'shop', 'docs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'apps', 'shop', 'docs', 'index.md'), '# shop\n');
      fs.mkdirSync(path.join(dir, 'docs', 'apps'), { recursive: true });
      fs.symlinkSync('../../apps/shop/docs', path.join(dir, 'docs', 'apps', 'shop'));
    });
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    expect(fs.readlinkSync(path.join(slugDir(), 'docs', 'apps', 'shop'))).toBe(
      '../../apps/shop/docs',
    );
    const snapshot = buildCandidateManifest(slugDir(), TRANSFER);
    expect(snapshot.manifest.files).toContainEqual(
      expect.objectContaining({ kind: 'symlink', path: 'docs/apps/shop', mode: '120000' }),
    );
    fs.writeFileSync(path.join(slugDir(), 'hello'), 'amber-falcon-3102\nedited\n');
    const verified = await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    expect(verified.ok).toBe(true);
    const published = await publishCheckout(publishOptions(checkouts), { title: 'Edit hello' });
    const remote = remotes['example-group/test']!;
    expect(git(remote, ['ls-tree', published.commit!, 'docs/apps/shop'])).toMatch(
      /^120000 blob [0-9a-f]{40}\tdocs\/apps\/shop$/,
    );
    expect(git(remote, ['cat-file', '-p', `${published.commit}:docs/apps/shop`])).toBe(
      '../../apps/shop/docs',
    );
    expect(git(remote, ['show', `${published.commit}:hello`])).toBe('amber-falcon-3102\nedited');
  });

  it('clones and reads around a committed escaping link, but refuses transfer and publication', async () => {
    remotes['example-group/test'] = linkedRemote('test', (dir) => {
      fs.symlinkSync('../../other-project/secret', path.join(dir, 'escape'));
    });
    const checkouts = manager();
    const cloned = await checkouts.clone('example-group/test');
    expect(cloned.ok).toBe(true);
    expect(() => buildCandidateManifest(slugDir(), TRANSFER)).toThrow(
      /symbolic link target outside the tree: escape/,
    );
    // Contained read-only discovery still works; the link itself is refused.
    const resolve = (file: string) => resolveWithin(paths.checkouts, file, { perCheckout: true });
    expect(resolve('example-group__test/hello')).toBe(
      path.join(paths.checkouts, 'example-group__test/hello'),
    );
    expect(() => resolve('example-group__test/escape')).toThrow(/escapes|outside/);
    await expect(checkouts.verify({ argv: ['true'], timeoutMs: 1000 })).rejects.toThrow(
      /symbolic link target outside the tree: escape/,
    );
    await expect(publishCheckout(publishOptions(checkouts), {})).rejects.toThrow(
      /symbolic link target outside the tree: escape/,
    );
    expect(fake.mrs).toHaveLength(0);
  });

  it('keeps a submodule entry the publication did not change', async () => {
    let subCommit = '';
    remotes['example-group/test'] = linkedRemote('test', (dir) => {
      const sub = path.join(root, 'sub-seed');
      fs.mkdirSync(sub);
      git(sub, ['init', '-q', '--initial-branch=main']);
      git(sub, [
        '-c',
        'user.email=t@local',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        's',
      ]);
      subCommit = git(sub, ['rev-parse', 'HEAD']);
      fs.writeFileSync(
        path.join(dir, '.gitmodules'),
        '[submodule "vendor/sub"]\n\tpath = vendor/sub\n\turl = ../sub.git\n',
      );
      // An uninitialised submodule is an empty directory (kept by `add -A`).
      fs.mkdirSync(path.join(dir, 'vendor', 'sub'), { recursive: true });
      git(dir, ['update-index', '--add', '--cacheinfo', `160000,${subCommit},vendor/sub`]);
    });
    const checkouts = manager();
    await checkouts.clone('example-group/test');
    fs.writeFileSync(path.join(slugDir(), 'hello'), 'amber-falcon-3102\nedited\n');
    await checkouts.verify({ argv: ['true'], timeoutMs: 1000 });
    const published = await publishCheckout(publishOptions(checkouts), { title: 'Edit' });
    expect(git(remotes['example-group/test']!, ['ls-tree', published.commit!, 'vendor/sub'])).toBe(
      `160000 commit ${subCommit}\tvendor/sub`,
    );
    expect(
      git(remotes['example-group/test']!, ['show', `${published.commit}:.gitmodules`]),
    ).toContain('path = vendor/sub');
  });
});
