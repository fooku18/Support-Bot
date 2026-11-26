/**
 * Trusted Git transport for clone and publication.
 *
 * The publisher derives project, branch, target, and destination from a
 * trusted GitLabProjectIdentity (GitLab's own answer through the typed
 * `get_project` read), never from agent-writable `.git/config`, remotes,
 * local journals, Slack text, or SDK tool calls. Merge requests are handled
 * by the typed GitLab operations in the tool runtime (see
 * publish-project.ts); this module only moves Git objects.
 *
 * Credential discipline:
 * - The GitLab token travels via `GIT_CONFIG_COUNT` HTTP Basic headers in
 *   the Git process environment. It is never embedded in URLs, never placed
 *   in repository environments, never logged, and never exposed to
 *   repository execution (which runs in the isolated executor without
 *   credentials).
 * - Trusted Git operations disable inherited configuration, hooks,
 *   credential helpers, URL rewrites, executable filters, and automatic
 *   submodule recursion. Fetched repository data and build scripts are
 *   untrusted: repository-controlled code never executes in the credentialed
 *   transport process.
 * - Publication builds the commit in a protected staging repository from
 *   the finalized tested snapshot. The commit tree is verified against the
 *   snapshot before any push. A live workspace that can still change after
 *   testing is never published.
 * - The commit's author and committer are the GitLab token's own user
 *   (`GET /user`), so GitLab push rules that require a known commit author
 *   accept it. A declined push keeps the remote's redacted reason.
 *
 * Durability (GitLab and the agent share no transaction):
 * - Publication intent (project ID, task branch, target branch, expected
 *   remote head, tested tree hash, commit identity, operation ID, ownership
 *   fence) is persisted before remote writes. Stable task/operation markers
 *   associate remote state without exposing Slack discussion or secrets.
 * - Only the task branch is ever pushed, never the target/default branch.
 *   Remote branches are never deleted and unrelated history is never
 *   overwritten. Follow-ups build on the recorded published head;
 *   non-fast-forward conflicts require explicit recovery (no blind force).
 * - On retry after a lost push/MR acknowledgment, the approved remote
 *   branch/commit and matching MR are inspected before writing again. A
 *   lost push reuses/reconciles the same commit; a lost MR acknowledgment
 *   finds the matching project/source/target/task operation first. When
 *   existence cannot be established, uncertainty is preserved instead of
 *   creating a duplicate.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { outboundProxyUrl } from '../../infrastructure/outbound.js';
import type { GitLabProjectIdentity } from './gitlab-policy.js';
import { validateRelativePath, type TreeManifest } from './transfer.js';

export type PublicationState =
  | 'verified'
  | 'publication_pending'
  | 'push_outcome_uncertain'
  | 'branch_confirmed'
  | 'mr_outcome_uncertain'
  | 'mr_confirmed'
  | 'completed'
  | 'failed';

export interface PublicationIntent {
  version: 1;
  projectId: number;
  canonicalPath: string;
  host: string;
  taskBranch: string;
  targetBranch: string;
  transportUrl: string;
  expectedRemoteHead: string | null;
  testedTreeHash: string;
  commit: string | null;
  tree: string | null;
  operationId: string;
  runId: string;
  runSeq: number;
  attempt: number;
  state: PublicationState;
  mrIid: number | null;
  mrUrl: string | null;
  lastError: string | null;
  updatedAtMs: number;
}

export class PublisherError extends Error {
  readonly terminal: boolean;
  /** Redacted Git stderr behind the failure, for the runner log (never a credential). */
  readonly detail: string | null;
  constructor(message: string, terminal = false, detail: string | null = null) {
    super(message);
    this.name = 'PublisherError';
    this.terminal = terminal;
    this.detail = detail;
  }
}

/** Author and committer of published commits: the GitLab token's own user. */
export interface CommitIdentity {
  name: string;
  email: string;
}

export interface PublisherOptions {
  identity: GitLabProjectIdentity;
  token: string;
  /** Protected staging root (outside agent-writable checkouts). */
  stagingRoot: string;
  commandTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Authentication is process-local configuration, never a checkout file or argv. */
export function trustedGitEnv(token: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  const config: Record<string, string> = {
    'core.hooksPath': '/dev/null',
    'core.fsmonitor': 'false',
    'credential.helper': '',
    'http.followRedirects': 'false',
    'protocol.allow': 'never',
    'protocol.https.allow': 'always',
    'protocol.http.allow': 'always',
    'protocol.file.allow': 'always',
  };
  // External remotes tunnel through the egress proxy (CONNECT); the global
  // git config is disabled above, so the proxy is set here explicitly.
  const proxy = outboundProxyUrl();
  if (proxy !== undefined) config['http.proxy'] = proxy;
  if (token)
    config['http.extraHeader'] =
      `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
  env.GIT_CONFIG_COUNT = String(Object.keys(config).length);
  Object.entries(config).forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function assertDestination(identity: GitLabProjectIdentity, branch?: string): void {
  const url = new URL(identity.transportUrl);
  // Loopback hosts are deterministic test fixtures (file:// or http:// remotes).
  const test = ['127.0.0.1', 'localhost'].includes(new URL(`http://${identity.host}`).hostname);
  if (
    !(test && url.protocol === 'file:') &&
    (url.host !== identity.host ||
      url.pathname !== `/${identity.canonicalPath}.git` ||
      (url.protocol !== 'https:' && !(test && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash)
  ) {
    throw new PublisherError('transport does not match the pinned project', true);
  }
  if (
    branch !== undefined &&
    (!/^support-agent\/[0-9a-f]{8,16}$/.test(branch) || branch === identity.targetBranch)
  ) {
    throw new PublisherError('unapproved task branch', true);
  }
}

/**
 * Removes credentials from Git stderr: the Basic header of the trusted
 * environment (encoded and decoded), URL userinfo, and token-shaped strings.
 * The transport URL carries no credential; this is defence in depth.
 */
export function redactGitStderr(text: string, env: Record<string, string> = {}): string {
  let out = text;
  for (const value of Object.values(env)) {
    const header = /^Authorization:\s*Basic\s+(\S+)$/i.exec(value);
    if (header === null) continue;
    const encoded = header[1] as string;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const secret = decoded.slice(decoded.indexOf(':') + 1);
    for (const literal of [encoded, decoded, secret].filter((entry) => entry.length >= 4))
      out = out.replaceAll(literal, '[redacted]');
  }
  return out
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1[redacted]@')
    .replace(/(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(/(?:glpat|gldt|glptt|glrt|gloas)-[A-Za-z0-9_-]{6,}/g, '[redacted]');
}

/** Transfer progress and boilerplate that never explains a failure. */
const GIT_NOISE =
  /^(?:To |From |Enumerating |Counting |Compressing |Writing |Total |Delta |Resolving |Receiving |Unpacking |hint:|error: failed to push some refs)/;

/** The lines of (redacted) Git stderr that state why it failed, bounded. */
function stderrExcerpt(stderr: string, max = 400): string {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/^remote:\s*/, '').trim())
    .filter((line) => line.length > 0 && !GIT_NOISE.test(line));
  const text = [...new Set(lines)].join(' | ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Maps a failed Git invocation to a publication error. A remote that
 * declines the push (GitLab push rules, protected branches, pre-receive
 * hooks) is distinct from a task branch that moved (non-fast-forward or a
 * stale lease); both stop publication, and the remote's own reason is kept.
 */
export function classifyGitFailure(redactedStderr: string): PublisherError {
  const excerpt = stderrExcerpt(redactedStderr);
  const detail = redactedStderr.trim().length > 0 ? redactedStderr.trim() : null;
  const withReason = (message: string) => (excerpt ? `${message}: ${excerpt}` : message);
  if (/no space left on device/i.test(redactedStderr))
    return new PublisherError(
      'Git operation failed: no space left on device (ENOSPC)',
      false,
      detail,
    );
  if (/\[remote rejected\]|pre-receive hook declined|GL-HOOK-ERR/i.test(redactedStderr))
    return new PublisherError(withReason('remote rejected the push'), true, detail);
  if (/\b40[13]\b|authentication failed|access denied/i.test(redactedStderr))
    return new PublisherError(withReason('Git authentication failed'), true, detail);
  if (/non-fast-forward|fetch first|stale info|\[rejected\]/i.test(redactedStderr))
    return new PublisherError(
      'remote task branch changed externally; explicit recovery required',
      true,
      detail,
    );
  return new PublisherError(withReason('Git operation failed or timed out'), false, detail);
}

async function git(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
  input?: Buffer | string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        overflow = true;
        child.kill('SIGKILL');
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', () => reject(new PublisherError('Git transport interrupted or unavailable')));
    child.on('close', (code) => {
      if (code !== 0 || overflow) reject(classifyGitFailure(redactGitStderr(stderr, env)));
      else resolve(Buffer.concat(output).toString('utf8').trimEnd());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function cloneApprovedProject(
  options: PublisherOptions & { checkoutDir: string; taskBranch: string },
): Promise<{ baseCommit: string; baseTree: string }> {
  const { identity, token, checkoutDir, taskBranch } = options;
  assertDestination(identity, taskBranch);
  if (fs.existsSync(checkoutDir) && fs.readdirSync(checkoutDir).length)
    throw new PublisherError('clone target must be empty', true);
  fs.mkdirSync(checkoutDir, { recursive: true });
  const env = trustedGitEnv(token);
  await git(
    [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
      '--no-recurse-submodules',
      '--branch',
      identity.targetBranch,
      identity.transportUrl,
      '.',
    ],
    checkoutDir,
    env,
    options.commandTimeoutMs ?? 120_000,
    undefined,
    options.signal,
  );
  await git(['checkout', '-qb', taskBranch], checkoutDir, trustedGitEnv(null));
  return {
    baseCommit: await git(['rev-parse', 'HEAD'], checkoutDir, trustedGitEnv(null)),
    baseTree: await git(['rev-parse', 'HEAD^{tree}'], checkoutDir, trustedGitEnv(null)),
  };
}

/**
 * Streamed publication candidate: the verified manifest (path/mode/size/
 * sha256, link targets) plus a reader for each regular file's bytes.
 * Publication streams every file through blob creation while re-verifying
 * its content hash, so the commit is provably the tested candidate without
 * buffering any file. A link's blob is its target from the manifest; the
 * reader is never asked for a link.
 */
export interface SnapshotSource {
  manifest: TreeManifest;
  read: (relativePath: string) => fs.ReadStream;
}

export function snapshotTreeHash(
  entries: Array<{ path: string; sha256: string; mode?: string }>,
): string {
  const hash = createHash('sha256');
  for (const file of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${file.path}\0${file.mode ?? '100644'}\0${file.sha256}\0`);
  }
  return hash.digest('hex').slice(0, 32);
}

/** Creates one blob by streaming (bounded memory) while re-verifying the hash. */
async function streamBlob(
  options: PublisherOptions,
  stagingDir: string,
  source: Readable,
  expectedSha256: string,
): Promise<string> {
  const hash = createHash('sha256');
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['hash-object', '-w', '--stdin'], {
      cwd: stagingDir,
      env: trustedGitEnv(null),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let blob = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      blob += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, 2000);
    });
    child.on('error', () => reject(new PublisherError('Git transport interrupted or unavailable')));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new PublisherError('Git blob creation failed', true));
        return;
      }
      const digest = hash.digest('hex');
      if (digest !== expectedSha256) {
        reject(
          new PublisherError(
            'candidate file changed after verification; publication stopped',
            true,
          ),
        );
        return;
      }
      resolve(blob.trim());
    });
    source.on('data', (chunk) => {
      hash.update(chunk as Buffer);
    });
    // Backpressure is handled by pipe; hash updates precede the pipe write.
    const input = source;
    input.pipe(child.stdin);
    source.on('error', () =>
      reject(new PublisherError('candidate file could not be read; publication stopped', true)),
    );
    child.stdin.on('error', () => {});
  });
}

/** Submodule entries (mode 160000) of a fetched commit's tree: path -> commit. */
async function gitlinksOf(stagingDir: string, commit: string): Promise<Map<string, string>> {
  const listed = await git(
    ['ls-tree', '-r', '-z', '--full-tree', commit],
    stagingDir,
    trustedGitEnv(null),
  );
  const gitlinks = new Map<string, string>();
  for (const record of listed.split('\0')) {
    const match = /^160000 commit ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
    if (match !== null) gitlinks.set(match[2] as string, match[1] as string);
  }
  return gitlinks;
}

/**
 * A snapshot leaf equal to, below or above a submodule path would change
 * the submodule, which publication does not support.
 */
function assertSubmodulesUntouched(
  manifest: TreeManifest,
  gitlinks: ReadonlyMap<string, string>,
): void {
  if (gitlinks.size === 0) return;
  const above = new Map<string, string>();
  for (const gitlink of gitlinks.keys()) {
    const parts = gitlink.split('/');
    for (let i = 1; i < parts.length; i += 1) above.set(parts.slice(0, i).join('/'), gitlink);
  }
  for (const entry of manifest.files) {
    const parts = entry.path.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (gitlinks.has(prefix))
        throw new PublisherError(`submodule path changed: ${prefix.slice(0, 200)}`, true);
    }
    const covered = above.get(entry.path);
    if (covered !== undefined)
      throw new PublisherError(`submodule path changed: ${covered.slice(0, 200)}`, true);
  }
}

/**
 * Build objects directly from the streamed candidate: no checkout, hooks, or
 * filters. Regular files stream through blob creation, a link's blob is its
 * manifest target (mode 120000), and every submodule entry (160000) of the
 * confirmed parent is carried into the index unchanged (the checkout
 * holds no submodule content). A tree equal to the base refuses (nothing to
 * publish). A tree equal to `parentCommit`, the task branch's confirmed head
 * (re-fetched and compared above), is already published: an earlier run
 * pushed it and stopped before its merge request, so that head is
 * the commit (`reused`) and publication continues with the merge request.
 */
export async function buildStagingCommit(
  options: PublisherOptions & {
    stagingDir: string;
    snapshot: SnapshotSource;
    message: string;
    taskBranch: string;
    /** The GitLab token's own user (GitLab push rules require a known author). */
    author: CommitIdentity;
    parentCommit?: string | null;
    baseCommit?: string;
  },
): Promise<{ commit: string; tree: string; reused: boolean }> {
  const { identity, token, stagingDir, snapshot, message, taskBranch } = options;
  assertDestination(identity, taskBranch);
  fs.mkdirSync(stagingDir, { recursive: true });
  if (fs.readdirSync(stagingDir).length)
    throw new PublisherError('staging directory must be empty', true);
  const env = trustedGitEnv(null);
  await git(['init', '-q'], stagingDir, env);
  const ref = options.parentCommit ? taskBranch : identity.targetBranch;
  await git(
    ['fetch', '--depth', '1', '--no-tags', identity.transportUrl, `refs/heads/${ref}`],
    stagingDir,
    trustedGitEnv(token),
    options.commandTimeoutMs ?? 120_000,
    undefined,
    options.signal,
  );
  const fetched = await git(['rev-parse', 'FETCH_HEAD'], stagingDir, env);
  const parent = options.parentCommit ?? options.baseCommit ?? fetched;
  if (fetched !== parent)
    throw new PublisherError('remote base changed; explicit recovery required', true);
  const gitlinks = await gitlinksOf(stagingDir, parent);
  assertSubmodulesUntouched(snapshot.manifest, gitlinks);
  await git(['read-tree', '--empty'], stagingDir, env);
  const entries: string[] = [];
  const expected: string[] = [];
  const seen = new Set<string>();
  for (const file of snapshot.manifest.files) {
    if (file.path.length > 1024 || seen.has(file.path))
      throw new PublisherError('unsupported snapshot path', true);
    try {
      validateRelativePath(file.path);
    } catch {
      throw new PublisherError('unsupported snapshot path', true);
    }
    seen.add(file.path);
    const blob = await streamBlob(
      options,
      stagingDir,
      file.kind === 'symlink'
        ? Readable.from([Buffer.from(file.target, 'utf8')])
        : snapshot.read(file.path),
      file.sha256,
    );
    entries.push(`${file.mode} ${blob}\t${file.path}\0`);
    expected.push(`${file.mode} blob ${blob}\t${file.path}\0`);
  }
  for (const [gitlink, commit] of gitlinks) {
    entries.push(`160000 ${commit}\t${gitlink}\0`);
    expected.push(`160000 commit ${commit}\t${gitlink}\0`);
  }
  expected.sort();
  await git(['update-index', '-z', '--index-info'], stagingDir, env, 30_000, entries.join(''));
  const tree = await git(['write-tree'], stagingDir, env);
  const actual = await git(['ls-tree', '-rz', tree], stagingDir, env);
  if (
    JSON.stringify(
      actual
        .split('\0')
        .filter(Boolean)
        .map((e) => e + '\0')
        .sort(),
    ) !== JSON.stringify(expected)
  )
    throw new PublisherError('staged tree differs from tested snapshot', true);
  const parentTree = await git(['rev-parse', `${parent}^{tree}`], stagingDir, env);
  if (tree === parentTree) {
    if (!options.parentCommit)
      throw new PublisherError('snapshot is unchanged; no commit to publish', true);
    await git(['update-ref', `refs/heads/${taskBranch}`, parent], stagingDir, env);
    await git(['symbolic-ref', 'HEAD', `refs/heads/${taskBranch}`], stagingDir, env);
    return { commit: parent, tree, reused: true };
  }
  const authorEnv = {
    ...env,
    GIT_AUTHOR_NAME: options.author.name,
    GIT_AUTHOR_EMAIL: options.author.email,
    GIT_COMMITTER_NAME: options.author.name,
    GIT_COMMITTER_EMAIL: options.author.email,
  };
  const commit = await git(
    ['commit-tree', tree, '-p', parent],
    stagingDir,
    authorEnv,
    30_000,
    message.slice(0, 2000),
  );
  await git(['update-ref', `refs/heads/${taskBranch}`, commit], stagingDir, env);
  await git(['symbolic-ref', 'HEAD', `refs/heads/${taskBranch}`], stagingDir, env);
  return { commit, tree, reused: false };
}

export async function lsRemoteHead(
  transportUrl: string,
  branch: string,
  token: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  const result = await git(
    ['ls-remote', transportUrl, `refs/heads/${branch}`],
    os.tmpdir(),
    trustedGitEnv(token),
    timeoutMs,
  );
  return result.split(/\s+/)[0] || null;
}

export async function pushTaskBranch(
  options: PublisherOptions & {
    stagingDir: string;
    taskBranch: string;
    expectedRemoteHead: string | null;
  },
): Promise<{ remoteHead: string; alreadyPresent: boolean }> {
  const { identity, token, stagingDir, taskBranch, expectedRemoteHead } = options;
  assertDestination(identity, taskBranch);
  const localHead = await git(['rev-parse', 'HEAD'], stagingDir, trustedGitEnv(null));
  const remoteHead = await lsRemoteHead(identity.transportUrl, taskBranch, token);
  if (remoteHead === localHead) return { remoteHead, alreadyPresent: true };
  if (remoteHead !== expectedRemoteHead)
    throw new PublisherError(
      'remote task branch changed externally; explicit recovery required',
      true,
    );
  if (expectedRemoteHead)
    await git(
      ['merge-base', '--is-ancestor', expectedRemoteHead, localHead],
      stagingDir,
      trustedGitEnv(null),
    );
  // The ancestry check forbids rewriting history; the lease closes the race
  // between inspection and push, including branch creation by another writer.
  await git(
    [
      'push',
      `--force-with-lease=refs/heads/${taskBranch}:${expectedRemoteHead ?? ''}`,
      identity.transportUrl,
      `${localHead}:refs/heads/${taskBranch}`,
    ],
    stagingDir,
    trustedGitEnv(token),
    options.commandTimeoutMs ?? 120_000,
    undefined,
    options.signal,
  );
  const confirmed = await lsRemoteHead(identity.transportUrl, taskBranch, token);
  if (confirmed !== localHead)
    throw new PublisherError('push outcome uncertain: unexpected remote head');
  return { remoteHead: confirmed, alreadyPresent: false };
}

// --- Publication intent journal (local durability, fsynced) ---

/** One intent file per (workspace, project): `publication/<project-slug>.json`. */
export function intentFileFor(storageDir: string, workspaceId: string, slug: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(slug) || slug.includes('..')) {
    throw new PublisherError('invalid publication slug', true);
  }
  return path.join(storageDir, 'workspaces', workspaceId, 'publication', `${slug}.json`);
}

export function readIntent(
  storageDir: string,
  workspaceId: string,
  slug: string,
): PublicationIntent | null {
  try {
    const raw = fs.readFileSync(intentFileFor(storageDir, workspaceId, slug), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PublicationIntent>;
    if (
      parsed.version !== 1 ||
      typeof parsed.taskBranch !== 'string' ||
      typeof parsed.state !== 'string'
    ) {
      return null;
    }
    return parsed as PublicationIntent;
  } catch {
    return null;
  }
}

export function writeIntent(
  storageDir: string,
  workspaceId: string,
  slug: string,
  intent: PublicationIntent,
): void {
  const file = intentFileFor(storageDir, workspaceId, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.writing`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ ...intent, updatedAtMs: Date.now() }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
