/**
 * staging commits for trees with symlinks and submodules. Link
 * blobs come from the manifest's target bytes (never the link-following
 * reader); every gitlink of the confirmed parent is carried into the index;
 * a snapshot leaf equal to, below or above a gitlink path is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTreeManifest } from '../../../src/domain/publication/transfer.js';
import {
  buildStagingCommit,
  type CommitIdentity,
  type PublisherOptions,
} from '../../../src/domain/publication/publisher.js';
import type { GitLabProjectIdentity } from '../../../src/domain/publication/gitlab-policy.js';

const POLICY = { maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 };
const BRANCH = 'support-agent/abcdef1234567890';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('staging commits with links and gitlinks', () => {
  let base: string;
  let remote: string;
  let seedCommit: string;
  let subCommit: string;
  let options: PublisherOptions;
  const author: CommitIdentity = {
    name: 'Support Agent Bot',
    email: 'support-agent-bot@example.test',
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-links-'));
    remote = path.join(base, 'remote.git');
    fs.mkdirSync(remote);
    git(remote, ['init', '--bare', '-q', '--initial-branch=main']);
    const sub = path.join(base, 'sub');
    fs.mkdirSync(sub);
    git(sub, ['init', '-q', '--initial-branch=main']);
    git(sub, [
      '-c',
      'user.email=t@l',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      's',
    ]);
    subCommit = git(sub, ['rev-parse', 'HEAD']);
    const seed = path.join(base, 'seed');
    fs.mkdirSync(seed);
    git(seed, ['init', '-q', '--initial-branch=main']);
    fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
    fs.mkdirSync(path.join(seed, 'deps', 'sub'), { recursive: true });
    git(seed, ['update-index', '--add', '--cacheinfo', `160000,${subCommit},deps/sub`]);
    git(seed, ['add', '-A']);
    git(seed, ['-c', 'user.email=t@l', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
    git(seed, ['push', '-q', remote, 'main']);
    seedCommit = git(seed, ['rev-parse', 'HEAD']);
    const identity: GitLabProjectIdentity = {
      host: '127.0.0.1',
      projectId: 4242,
      canonicalPath: 'g/p',
      transportUrl: `file://${remote}`,
      targetBranch: 'main',
    };
    options = { identity, token: 'synthetic-token', stagingRoot: base };
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** A checkout as the clone leaves it: README, an empty submodule directory. */
  function checkout(): string {
    const dir = path.join(base, `checkout-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(path.join(dir, 'deps', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
    return dir;
  }

  function stage(dir: string) {
    const manifest = buildTreeManifest(dir, POLICY);
    return buildStagingCommit({
      ...options,
      author,
      stagingDir: path.join(base, `staging-${Math.random().toString(16).slice(2)}`),
      snapshot: {
        manifest,
        read: (relative) => {
          if (fs.lstatSync(path.join(dir, relative)).isSymbolicLink())
            throw new Error(`link ${relative} was read through the file reader`);
          return fs.createReadStream(path.join(dir, relative));
        },
      },
      message: 'support-agent: links',
      taskBranch: BRANCH,
      baseCommit: seedCommit,
    });
  }

  it('commits links as 120000 blobs of their exact targets and carries the gitlink', async () => {
    const dir = checkout();
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), 'guide\n');
    fs.symlinkSync('docs/guide.md', path.join(dir, 'GUIDE'));
    fs.symlinkSync('missing/later', path.join(dir, 'dangling'));
    const { commit, tree } = await stage(dir);
    const staging = fs.readdirSync(base).find((name) => name.startsWith('staging-'))!;
    const cwd = path.join(base, staging);
    const listed = git(cwd, ['ls-tree', '-r', tree]).split('\n');
    expect(listed).toContainEqual(expect.stringMatching(/^120000 blob [0-9a-f]{40}\tGUIDE$/));
    expect(listed).toContainEqual(expect.stringMatching(/^120000 blob [0-9a-f]{40}\tdangling$/));
    expect(listed).toContain(`160000 commit ${subCommit}\tdeps/sub`);
    expect(git(cwd, ['cat-file', '-p', `${commit}:GUIDE`])).toBe('docs/guide.md');
    expect(git(cwd, ['cat-file', '-p', `${commit}:dangling`])).toBe('missing/later');
  });

  it('refuses a snapshot leaf at, below or above a gitlink path', async () => {
    const equal = checkout();
    fs.rmdirSync(path.join(equal, 'deps', 'sub'));
    fs.writeFileSync(path.join(equal, 'deps', 'sub'), 'not a submodule');
    await expect(stage(equal)).rejects.toThrow(/submodule path changed: deps\/sub/);

    const below = checkout();
    fs.writeFileSync(path.join(below, 'deps', 'sub', 'file.txt'), 'inside the submodule');
    await expect(stage(below)).rejects.toThrow(/submodule path changed: deps\/sub/);

    const above = checkout();
    fs.rmSync(path.join(above, 'deps'), { recursive: true });
    fs.symlinkSync('README.md', path.join(above, 'deps'));
    await expect(stage(above)).rejects.toThrow(/submodule path changed: deps\/sub/);
  });

  it('reuses nothing and refuses an unchanged tree (the gitlink makes it equal to the base)', async () => {
    await expect(stage(checkout())).rejects.toThrow(/snapshot is unchanged/);
  });
});
