/** Trusted Git transport: clone, staging commit, and lease-guarded push against real Git remotes. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTreeManifest } from '../../../src/domain/publication/transfer.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { GitLabProjectIdentity } from '../../../src/domain/publication/gitlab-policy.js';
import { configureOutbound } from '../../../src/infrastructure/outbound.js';
import {
  buildStagingCommit,
  cloneApprovedProject,
  lsRemoteHead,
  pushTaskBranch,
  readIntent,
  writeIntent,
  PublisherError,
  classifyGitFailure,
  redactGitStderr,
  trustedGitEnv,
  type CommitIdentity,
  type PublisherOptions,
} from '../../../src/domain/publication/publisher.js';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).slice(0, 300)}`);
  }
}

function makeRemote(): { remoteDir: string; transportUrl: string; seedCommit: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-remote-'));
  const remoteDir = path.join(base, 'remote.git');
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ['init', '--bare', '-q', '--initial-branch=main']);
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '--initial-branch=main']);
  git(seed, ['config', 'user.email', 'test@local']);
  git(seed, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(seed, 'greet.js'), 'module.exports = () => "hi";\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-qm', 'seed']);
  git(seed, ['remote', 'add', 'origin', remoteDir]);
  git(seed, ['push', '-q', 'origin', 'main']);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: seed, encoding: 'utf8' });
  return { remoteDir, transportUrl: `file://${remoteDir}`, seedCommit: String(head.stdout).trim() };
}

describe('trusted Git transport (real Git remotes)', () => {
  let base: string;
  let remote: { remoteDir: string; transportUrl: string; seedCommit: string };
  let work: string;
  let identity: GitLabProjectIdentity;
  let options: PublisherOptions;
  let author: CommitIdentity;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-work-'));
    work = base;
    remote = makeRemote();
    identity = {
      host: '127.0.0.1',
      projectId: 4242,
      canonicalPath: 'g/p',
      transportUrl: remote.transportUrl,
      targetBranch: 'main',
    };
    options = { identity, token: 'synthetic-token', stagingRoot: work };
    author = { name: 'Support Agent Bot', email: 'support-agent-bot@example.test' };
  });

  afterEach(async () => {
    fs.rmSync(path.dirname(remote.remoteDir), { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  const snapshotOf = (dir: string, paths: string[]): Array<{ path: string; content: Buffer }> =>
    paths.map((p) => ({ path: p, content: fs.readFileSync(path.join(dir, p)) }));

  // Streamed publication candidate (transfer manifest + file reader).
  const manifestOf = (dir: string) => {
    const manifest = buildTreeManifest(
      dir,
      { maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 },
      'checkout',
    );
    return { manifest, read: (rel: string) => fs.createReadStream(path.join(dir, rel)) };
  };

  it('clones the approved project, pins the base, and publishes the exact verified tree', async () => {
    const checkout = path.join(work, 'checkout');
    const branch = 'support-agent/abcdef1234567890';
    const { baseCommit } = await cloneApprovedProject({
      ...options,
      checkoutDir: checkout,
      taskBranch: branch,
    });
    expect(baseCommit).toBe(remote.seedCommit);
    // Agent edit: modify a file in the checkout (the verified change).
    fs.writeFileSync(path.join(checkout, 'greet.js'), 'module.exports = (n) => `Hello, ${n}!`;\n');
    const treeFiles = snapshotOf(checkout, ['README.md', 'greet.js']);
    const staging = path.join(work, 'staging');
    const { commit } = await buildStagingCommit({
      ...options,
      author,
      stagingDir: staging,
      snapshot: manifestOf(checkout),
      message: 'support-agent: greet(name) [op:abc]',
      taskBranch: branch,
    });
    expect(/^[0-9a-f]{40}$/.test(commit)).toBe(true);
    // Commit tree matches the tested snapshot (file-level verification).
    for (const file of treeFiles) {
      const shown = spawnSync('git', ['show', `${commit}:${file.path}`], {
        cwd: staging,
        encoding: 'buffer',
        timeout: 15000,
      });
      expect(Buffer.compare(Buffer.from(shown.stdout as Buffer), file.content)).toBe(0);
    }
    const pushed = await pushTaskBranch({
      ...options,
      stagingDir: staging,
      taskBranch: branch,
      expectedRemoteHead: null,
    });
    expect(pushed.alreadyPresent).toBe(false);
    expect(await lsRemoteHead(remote.transportUrl, branch, 'synthetic-token')).toBe(commit);
    // Target branch was never directly modified.
    expect(await lsRemoteHead(remote.transportUrl, 'main', 'synthetic-token')).toBe(
      remote.seedCommit,
    );
  });

  it('ignores mutated workspace .git/config: publication derives from trusted policy', async () => {
    const checkout = path.join(work, 'checkout');
    const branch = 'support-agent/abcdef1234567890';
    await cloneApprovedProject({ ...options, checkoutDir: checkout, taskBranch: branch });
    // Adversary rewrites the workspace remote to an evil destination.
    git(checkout, ['remote', 'set-url', 'origin', 'file:///tmp/evil.git']);
    fs.writeFileSync(path.join(checkout, 'greet.js'), 'module.exports = () => "evil-proof";\n');
    const staging = path.join(work, 'staging');
    const { commit } = await buildStagingCommit({
      ...options,
      author,
      stagingDir: staging,
      snapshot: manifestOf(checkout),
      message: 'x [op:evil]',
      taskBranch: branch,
    });
    const pushed = await pushTaskBranch({
      ...options,
      stagingDir: staging,
      taskBranch: branch,
      expectedRemoteHead: null,
    });
    expect(pushed.remoteHead).toBe(commit);
    // Approved remote holds the commit; no alternate destination was used.
    expect(await lsRemoteHead(remote.transportUrl, branch, 'synthetic-token')).toBe(commit);
    expect(fs.existsSync('/tmp/evil.git')).toBe(false);
  });

  it('reconciles a lost push acknowledgment without duplicating commits', async () => {
    const checkout = path.join(work, 'checkout');
    const branch = 'support-agent/abcdef1234567890';
    await cloneApprovedProject({ ...options, checkoutDir: checkout, taskBranch: branch });
    fs.writeFileSync(path.join(checkout, 'greet.js'), 'module.exports = () => "lost-ack";\n');
    const staging = path.join(work, 'staging');
    const { commit } = await buildStagingCommit({
      ...options,
      author,
      stagingDir: staging,
      snapshot: manifestOf(checkout),
      message: 'x [op:lost]',
      taskBranch: branch,
    });
    const first = await pushTaskBranch({
      ...options,
      stagingDir: staging,
      taskBranch: branch,
      expectedRemoteHead: null,
    });
    expect(first.alreadyPresent).toBe(false);
    // Retry after a lost acknowledgment reuses the same commit.
    const second = await pushTaskBranch({
      ...options,
      stagingDir: staging,
      taskBranch: branch,
      expectedRemoteHead: null,
    });
    expect(second.alreadyPresent).toBe(true);
    expect(second.remoteHead).toBe(commit);
  });

  it('refuses blind force on external branch changes and distinguishes auth failures', async () => {
    const checkout = path.join(work, 'checkout');
    const branch = 'support-agent/abcdef1234567890';
    await cloneApprovedProject({ ...options, checkoutDir: checkout, taskBranch: branch });
    fs.writeFileSync(path.join(checkout, 'greet.js'), 'module.exports = () => "external-test";\n');
    const staging = path.join(work, 'staging');
    await buildStagingCommit({
      ...options,
      author,
      stagingDir: staging,
      snapshot: manifestOf(checkout),
      message: 'x',
      taskBranch: branch,
    });
    // External commit lands on the task branch first.
    const other = path.join(work, 'other');
    const otherBranch = branch;
    await cloneApprovedProject({ ...options, checkoutDir: other, taskBranch: `${otherBranch}` });
    git(other, ['config', 'user.email', 'test@local']);
    git(other, ['config', 'user.name', 'test']);
    // Push an external change via the other checkout's staging-equivalent.
    git(other, ['commit', '-q', '--allow-empty', '-m', 'external']);
    {
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_NOGLOBAL: '1' } as Record<
        string,
        string
      >;
      spawnSync('git', ['push', 'origin', `${otherBranch}:refs/heads/${otherBranch}`], {
        cwd: other,
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
    }
    await expect(
      (async () =>
        pushTaskBranch({
          ...options,
          stagingDir: staging,
          taskBranch: branch,
          expectedRemoteHead: remote.seedCommit,
        }))(),
    ).rejects.toThrow(/externally|recovery|force/i);
  });

  it('removes deleted files and advances the same task branch on follow-up', async () => {
    const branch = 'support-agent/1234567890abcdef';
    const firstDir = path.join(work, 'first');
    fs.rmSync(firstDir, { recursive: true, force: true });
    fs.mkdirSync(firstDir, { recursive: true });
    fs.writeFileSync(path.join(firstDir, 'greet.js'), 'first');
    const first = await buildStagingCommit({
      ...options,
      author,
      taskBranch: branch,
      stagingDir: path.join(work, 'first-staging'),
      snapshot: manifestOf(firstDir),
      message: 'first',
    });
    const names = spawnSync('git', ['ls-tree', '--name-only', first.commit], {
      cwd: path.join(work, 'first-staging'),
      encoding: 'utf8',
    });
    expect(names.stdout.trim()).toBe('greet.js');
    await pushTaskBranch({
      ...options,
      taskBranch: branch,
      stagingDir: path.join(work, 'first-staging'),
      expectedRemoteHead: null,
    });
    const secondDir = path.join(work, 'second');
    fs.rmSync(secondDir, { recursive: true, force: true });
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(secondDir, 'greet.js'), 'second');
    fs.chmodSync(path.join(secondDir, 'greet.js'), 0o755);
    const second = await buildStagingCommit({
      ...options,
      author,
      taskBranch: branch,
      stagingDir: path.join(work, 'second-staging'),
      snapshot: manifestOf(secondDir),
      message: 'second',
      parentCommit: first.commit,
    });
    expect(
      spawnSync('git', ['rev-parse', `${second.commit}^`], {
        cwd: path.join(work, 'second-staging'),
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe(first.commit);
    await pushTaskBranch({
      ...options,
      taskBranch: branch,
      stagingDir: path.join(work, 'second-staging'),
      expectedRemoteHead: first.commit,
    });
    expect(await lsRemoteHead(remote.transportUrl, branch, 'synthetic-token')).toBe(second.commit);
  });

  it('persists publication intent before remote writes (crash recovery)', () => {
    const intent = {
      version: 1 as const,
      projectId: 4242,
      canonicalPath: 'g/p',
      host: '127.0.0.1',
      taskBranch: 'support-agent/abcdef1234567890',
      targetBranch: 'main',
      transportUrl: remote.transportUrl,
      expectedRemoteHead: null,
      testedTreeHash: createHash('sha256').update('tree').digest('hex').slice(0, 32),
      commit: null,
      tree: null,
      operationId: 'op-1',
      runId: 'run-1',
      runSeq: 1,
      attempt: 1,
      state: 'publication_pending' as const,
      mrIid: null,
      mrUrl: null,
      lastError: null,
      updatedAtMs: Date.now(),
    };
    writeIntent(work, 'ws1234567890abcdef', 'g__p', intent);
    const read = readIntent(work, 'ws1234567890abcdef', 'g__p');
    expect(read?.operationId).toBe('op-1');
    expect(read?.state).toBe('publication_pending');
    // One intent per (workspace, project).
    expect(
      fs.existsSync(
        path.join(work, 'workspaces', 'ws1234567890abcdef', 'publication', 'g__p.json'),
      ),
    ).toBe(true);
    expect(readIntent(work, 'ws1234567890abcdef', 'other__project')).toBeNull();
    expect(readIntent(work, 'ws1234567890abcdef', '../escape')).toBeNull();
    expect(() => writeIntent(work, 'ws1234567890abcdef', '../escape', intent)).toThrow(
      PublisherError,
    );
  });

  it('rejects unapproved branch namespaces before any remote write', async () => {
    await expect(
      cloneApprovedProject({ ...options, checkoutDir: path.join(work, 'c2'), taskBranch: 'main' }),
    ).rejects.toThrow(PublisherError);
  });
  it('authors and commits as the resolved GitLab user, never a placeholder identity', async () => {
    const checkout = path.join(work, 'checkout');
    const branch = 'support-agent/abcdef1234567890';
    await cloneApprovedProject({ ...options, checkoutDir: checkout, taskBranch: branch });
    fs.writeFileSync(path.join(checkout, 'greet.js'), 'module.exports = () => "author";\n');
    const staging = path.join(work, 'staging');
    const { commit } = await buildStagingCommit({
      ...options,
      author: { name: 'Project Bot', email: 'project_4242_bot@noreply.gitlab.test' },
      stagingDir: staging,
      snapshot: manifestOf(checkout),
      message: 'support-agent: author check',
      taskBranch: branch,
    });
    const shown = spawnSync('git', ['show', '-s', '--format=%an|%ae|%cn|%ce', commit], {
      cwd: staging,
      encoding: 'utf8',
    });
    expect(String(shown.stdout).trim()).toBe(
      'Project Bot|project_4242_bot@noreply.gitlab.test|Project Bot|project_4242_bot@noreply.gitlab.test',
    );
    expect(String(shown.stdout)).not.toContain('support-agent-coding');
  });

  it('reports a push declined by a GitLab push rule with its reason, not as an external change', async () => {
    // Regression (2026-10-12 production): GitLab's "commit author is a GitLab
    // user" push rule declined the push; the runner said "changed externally".
    const hook = path.join(remote.remoteDir, 'hooks', 'pre-receive');
    fs.writeFileSync(
      hook,
      '#!/bin/sh\necho "GL-HOOK-ERR: Author \'support-agent-bot@example.test\' is not a GitLab user." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const checkout = path.join(work, 'checkout');
    const branch = 'support-agent/abcdef1234567890';
    await cloneApprovedProject({ ...options, checkoutDir: checkout, taskBranch: branch });
    fs.writeFileSync(path.join(checkout, 'greet.js'), 'module.exports = () => "declined";\n');
    const staging = path.join(work, 'staging');
    await buildStagingCommit({
      ...options,
      author,
      stagingDir: staging,
      snapshot: manifestOf(checkout),
      message: 'support-agent: declined',
      taskBranch: branch,
    });
    const failure = await pushTaskBranch({
      ...options,
      stagingDir: staging,
      taskBranch: branch,
      expectedRemoteHead: null,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PublisherError);
    const error = failure as PublisherError;
    expect(error.terminal).toBe(true);
    expect(error.message).toMatch(/^remote rejected the push: /);
    expect(error.message).toContain(
      "GL-HOOK-ERR: Author 'support-agent-bot@example.test' is not a GitLab user.",
    );
    expect(error.message).toContain('pre-receive hook declined');
    expect(error.message).not.toMatch(/externally/);
    expect(error.detail).toContain('[remote rejected]');
    expect(error.detail).not.toContain('synthetic-token');
    expect(await lsRemoteHead(remote.transportUrl, branch, 'synthetic-token')).toBeNull();
  });
});

describe('trusted Git environment and the egress proxy', () => {
  const gitConfig = (env: Record<string, string>, key: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-proxy-'));
    try {
      const result = spawnSync('git', ['config', '--get', key], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      return result.status === 0 ? result.stdout.trim() : '';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  afterEach(() => configureOutbound(undefined));

  it('sets http.proxy through the GIT_CONFIG_* block when a proxy is configured', () => {
    expect(gitConfig(trustedGitEnv(null), 'http.proxy')).toBe('');
    configureOutbound('http://egress:3128');
    const env = trustedGitEnv(`glpat-${randomBytes(16).toString('hex')}`);
    expect(gitConfig(env, 'http.proxy')).toBe('http://egress:3128');
    // The proxy is git configuration only: no proxy variable reaches git.
    expect(Object.keys(env).filter((name) => /_proxy$/i.test(name))).toEqual([]);
    // Global config stays disabled; the proxy is not a second way in.
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });
});

describe('Git failure classification and stderr redaction', () => {
  const token = `glpat-${randomBytes(16).toString('hex')}`;
  const env = trustedGitEnv(token);
  const encoded = Buffer.from(`oauth2:${token}`).toString('base64');

  it('separates a declined push from a moved branch and keeps the reason', () => {
    const declined = classifyGitFailure(
      [
        "remote: GitLab: Author 'support-agent-coding@local' is not a member of team",
        'To https://gitlab.example.test/g/p.git',
        ' ! [remote rejected] dfa388d0 -> support-agent/85a43eb1d1f6adc4 (pre-receive hook declined)',
        "error: failed to push some refs to 'https://gitlab.example.test/g/p.git'",
      ].join('\n'),
    );
    expect(declined.terminal).toBe(true);
    expect(declined.message).toBe(
      "remote rejected the push: GitLab: Author 'support-agent-coding@local' is not a member of team | ! [remote rejected] dfa388d0 -> support-agent/85a43eb1d1f6adc4 (pre-receive hook declined)",
    );
    for (const stderr of [
      ' ! [rejected]        abc -> support-agent/0123456789abcdef (non-fast-forward)',
      ' ! [rejected]        abc -> support-agent/0123456789abcdef (fetch first)',
      ' ! [rejected]        abc -> support-agent/0123456789abcdef (stale info)',
    ]) {
      const moved = classifyGitFailure(stderr);
      expect(moved.terminal).toBe(true);
      expect(moved.message).toBe(
        'remote task branch changed externally; explicit recovery required',
      );
    }
    expect(classifyGitFailure('remote: GL-HOOK-ERR: secrets detected').message).toBe(
      'remote rejected the push: GL-HOOK-ERR: secrets detected',
    );
    expect(
      classifyGitFailure("fatal: Authentication failed for 'https://gitlab.example.test/g/p.git/'")
        .message,
    ).toMatch(/^Git authentication failed: /);
    const generic = classifyGitFailure('fatal: unable to access: Could not resolve host');
    expect(generic.terminal).toBe(false);
    expect(generic.message).toBe(
      'Git operation failed or timed out: fatal: unable to access: Could not resolve host',
    );
    expect(classifyGitFailure('').message).toBe('Git operation failed or timed out');
  });

  it('redacts the transport credential, URL userinfo and token-shaped strings', () => {
    const redacted = redactGitStderr(
      [
        `remote: GL-HOOK-ERR: rejected for ${token}`,
        `To https://oauth2:${token}@gitlab.example.test/g/p.git`,
        `fatal: header Authorization: Basic ${encoded}`,
        `raw oauth2:${token} and ${encoded}`,
        'other glpat-AnotherTokenValue99',
      ].join('\n'),
      env,
    );
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain(encoded);
    expect(redacted).not.toContain('AnotherTokenValue99');
    expect(redacted).toContain('https://[redacted]@gitlab.example.test/g/p.git');
    expect(redacted).toContain('GL-HOOK-ERR: rejected for [redacted]');
    const surfaced = classifyGitFailure(redacted);
    expect(surfaced.message).not.toContain(token);
    expect(surfaced.detail).not.toContain(token);
  });
});
