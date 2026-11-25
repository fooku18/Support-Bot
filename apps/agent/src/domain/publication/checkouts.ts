/**
 * Several GitLab checkouts per task workspace.
 *
 * Layout (inside the thread's storage allocation):
 *
 *   workspaces/<id>/checkouts/<project-slug>/   one clone per project (task branch)
 *   workspaces/<id>/checkouts.json              checkout records (this module)
 *   workspaces/<id>/publication/<slug>.json     publication intents (publish-project.ts)
 *
 * The slug is the canonical project path with `/` → `__`. A thread may clone
 * any project the GitLab token can read; identity (numeric ID, canonical
 * path, default branch) always comes from GitLab's `get_project` answer.
 *
 * Commands run in the isolated executor on a persistent working copy per
 * checkout (dependencies survive follow-ups). `verify` records the command,
 * exit code, and the checkout's tree digest; publication requires a passing
 * record at the published tree for every declared verification command.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { StageLogger } from '../../infrastructure/logger.js';
import type { ToolFailureClass } from '../../contracts/protocol.js';
import {
  parseProjectRef,
  type ValidatedGitlabArgs,
} from '../../integrations/gitlab/gitlab-operations.js';
import type { GitlabNormalizedResult } from '../../integrations/gitlab/gitlab-rest-adapter.js';
import {
  checkoutSlug,
  identityFromProject,
  taskBranchName,
  validateTargetBranch,
} from './gitlab-policy.js';
import { cloneApprovedProject } from './publisher.js';
import { resolveWithin } from './guard.js';
import { buildCandidateManifest, type WorkExecResult } from './candidate-manifest.js';
import type { TransferPolicy } from './transfer.js';
import type { WorkspacePaths } from '../../infrastructure/storage/workspace-paths.js';

export const CHECKOUTS_STATE_VERSION = 1;

export interface VerificationReplacement {
  argv: string[];
  reason: string;
}

/** One declared verification command and its latest result for a checkout. */
export interface VerificationRecord {
  argv: string[];
  /** Retained evidence of an explicit replacement; never an active requirement. */
  supersededBy?: VerificationReplacement & { treeDigest: string; runSeq: number; atMs: number };
  status: 'passed' | 'failed' | 'timed_out' | 'not_run';
  exitCode: number | null;
  /** Checkout tree digest after the command (and its reconciled changes). */
  treeDigest: string;
  /** Why a command that exited 0 still failed (its changes were not reconciled). */
  reason?: string | null;
  durationMs: number;
  runSeq: number;
  atMs: number;
}

/** Historical failures remain inspectable but cannot satisfy or block active requirements. */
export function activeVerifications(record: CheckoutRecord): VerificationRecord[] {
  return record.verifications.filter((entry) => entry.supersededBy === undefined);
}

/** Latest confirmed publication of a checkout. */
export interface CheckoutPublication {
  commit: string;
  tree: string;
  targetBranch: string;
  mrIid: number | null;
  mrUrl: string | null;
  treeDigest: string;
  runSeq: number;
  atMs: number;
}

export interface CheckoutRecord {
  /** Canonical `path_with_namespace`. */
  project: string;
  projectId: number;
  slug: string;
  defaultBranch: string;
  /** Branch the clone started from; the default merge-request target. */
  baseBranch: string;
  taskBranch: string;
  baseCommit: string;
  webUrl: string | null;
  clonedAtMs: number;
  verifications: VerificationRecord[];
  publication: CheckoutPublication | null;
}

interface CheckoutsState {
  version: typeof CHECKOUTS_STATE_VERSION;
  checkouts: CheckoutRecord[];
}

export class CheckoutError extends Error {
  /**
   * A refusal before anything ran that the model can correct at once (e.g. a
   * wrong cwd): the call does not count against the run's tool-call limit.
   */
  readonly uncounted: boolean;
  constructor(message: string, options: { uncounted?: boolean } = {}) {
    super(message);
    this.name = 'CheckoutError';
    this.uncounted = options.uncounted === true;
  }
}

/** Top-level directory names of a checkout (hidden ones and `.git` left out). */
function topLevelDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function stateFile(paths: WorkspacePaths): string {
  return path.join(paths.root, 'checkouts.json');
}

export function readCheckouts(paths: WorkspacePaths): CheckoutRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(paths), 'utf8')) as Partial<CheckoutsState>;
    if (parsed.version !== CHECKOUTS_STATE_VERSION || !Array.isArray(parsed.checkouts)) return [];
    return parsed.checkouts;
  } catch {
    return [];
  }
}

export function writeCheckouts(paths: WorkspacePaths, checkouts: CheckoutRecord[]): void {
  const file = stateFile(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.writing`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ version: CHECKOUTS_STATE_VERSION, checkouts } satisfies CheckoutsState),
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Directory of one checkout. */
export function checkoutDir(paths: WorkspacePaths, record: Pick<CheckoutRecord, 'slug'>): string {
  return path.join(paths.checkouts, record.slug);
}

/**
 * Finds the checkout a tool call addresses: by project path (any case), ID,
 * or slug; without `project` the only checkout. Ambiguity and unknown
 * projects are explicit errors naming the cloned projects.
 */
export function resolveCheckout(checkouts: CheckoutRecord[], project: unknown): CheckoutRecord {
  const cloned = checkouts.map((entry) => entry.project).join(', ') || 'none';
  if (project === undefined || project === null || project === '') {
    if (checkouts.length === 1) return checkouts[0] as CheckoutRecord;
    if (checkouts.length === 0)
      throw new CheckoutError('no repository is cloned yet: call clone_repository first');
    throw new CheckoutError(
      `several repositories are cloned (${cloned}); pass project to choose one`,
    );
  }
  const wanted = typeof project === 'number' ? String(project) : String(project).trim();
  const match = checkouts.find(
    (entry) =>
      String(entry.projectId) === wanted ||
      entry.project.toLowerCase() === wanted.toLowerCase() ||
      entry.slug === wanted,
  );
  if (match === undefined) {
    throw new CheckoutError(
      `${wanted.slice(0, 120)} is not cloned in this task (cloned: ${cloned}); call clone_repository first`,
    );
  }
  return match;
}

/** Tree digest of a checkout (content manifest, `.git` excluded). */
export function checkoutDigest(dir: string, transfer: TransferPolicy): string {
  return buildCandidateManifest(dir, transfer).digest;
}

/**
 * Publication readiness of a checkout at its current tree: every declared
 * verification command must have passed at exactly this tree.
 */
export function verificationReadiness(
  record: CheckoutRecord,
  digest: string,
): { ready: boolean; detail: string } {
  if (activeVerifications(record).length === 0) {
    return {
      ready: false,
      detail: `${record.project} has no verification: run the repository's own test/lint commands with verify first`,
    };
  }
  const problems: string[] = [];
  for (const entry of activeVerifications(record)) {
    const command = entry.argv.join(' ').slice(0, 120);
    if (entry.status !== 'passed')
      problems.push(
        `\`${command}\` ${entry.status}${entry.reason ? ` (${entry.reason.slice(0, 200)})` : ''}`,
      );
    else if (entry.treeDigest !== digest)
      problems.push(`\`${command}\` passed on an older tree (re-run it)`);
  }
  if (problems.length > 0) {
    return {
      ready: false,
      detail: `${record.project} is not verified at its current tree: ${problems.join('; ')}`,
    };
  }
  return { ready: true, detail: `${record.project} verified` };
}

/** Summary used for the completion's verification field. */
export function verificationSummary(
  records: CheckoutRecord[],
  digests: Map<string, string>,
): {
  status: 'passed' | 'failed' | 'timed_out' | 'not_run';
  command: string;
  exitCode: number | null;
  durationMs: number;
} {
  const relevant = records.filter((record) => digests.has(record.slug));
  if (
    relevant.length === 0 ||
    relevant.every((record) => activeVerifications(record).length === 0)
  ) {
    return { status: 'not_run', command: 'repository verification', exitCode: null, durationMs: 0 };
  }
  let status: 'passed' | 'failed' | 'timed_out' | 'not_run' = 'passed';
  let exitCode: number | null = 0;
  let durationMs = 0;
  const commands: string[] = [];
  for (const record of relevant) {
    const readiness = verificationReadiness(record, digests.get(record.slug) ?? '');
    for (const entry of activeVerifications(record)) {
      commands.push(`${record.project}: ${entry.argv.join(' ')}`);
      durationMs += entry.durationMs;
      if (entry.status !== 'passed' && status === 'passed') {
        status = entry.status;
        exitCode = entry.exitCode;
      }
    }
    if (!readiness.ready && status === 'passed') {
      status = 'not_run';
      exitCode = null;
    }
  }
  return {
    status,
    command: commands.join('; ').slice(0, 256) || 'repository verification',
    exitCode: status === 'passed' ? 0 : exitCode,
    durationMs: Math.min(durationMs, 3_600_000),
  };
}

/** Trusted (non-admitted) typed GitLab call, used by controller code only. */
export type TrustedGitlab = (validated: ValidatedGitlabArgs) => Promise<GitlabNormalizedResult>;

export interface CheckoutManagerOptions {
  paths: WorkspacePaths;
  workspaceId: string;
  gitlabHost: string;
  gitlabToken: string;
  /** Protected staging root for clones (outside agent-writable checkouts). */
  stagingRoot: string;
  transfer: TransferPolicy;
  /** Native workspace backend: runs directly in this checkout under framework isolation. */
  executeInPlace?(input: {
    dir: string;
    argv: string[];
    cwd?: string;
    timeoutMs: number;
  }): Promise<Pick<WorkExecResult, 'status' | 'exitCode' | 'durationMs' | 'output' | 'truncated'>>;
  gitlab: TrustedGitlab;
  runSeq: number;
  /** Durable registration of a new checkout with the agent (coding_task_repositories). */
  register(record: CheckoutRecord): Promise<void>;
  /** Cloned content is retained code, not this turn's edit. */
  onCloned(record: CheckoutRecord, dir: string): void;
  maxOutputBytes: number;
  log: StageLogger;
  signal?: AbortSignal;
  /** Deterministic tests only (loopback GITLAB_HOST): local clone transport. */
  transportUrl?: (canonicalPath: string) => string;
}

export interface CommandOutcome {
  ok: boolean;
  output: string;
  evidence: string;
  uncertain?: boolean;
  /** Why a command did not succeed (tool trace). */
  failureClass?: ToolFailureClass;
}

/** A finished command's failure class: none on exit 0, `timeout`, else `exit`. */
export function commandFailureClass(
  status: string,
  exitCode: number | null,
): { failureClass?: ToolFailureClass } {
  if (status === 'timed_out') return { failureClass: 'timeout' };
  if (status === 'completed' && exitCode === 0) return {};
  return { failureClass: 'exit' };
}

/** Clone, exec, and verification for a workspace's GitLab checkouts. */
export class CheckoutManager {
  constructor(private readonly options: CheckoutManagerOptions) {}

  list(): CheckoutRecord[] {
    return readCheckouts(this.options.paths);
  }

  private update(record: CheckoutRecord): void {
    const all = this.list().filter((entry) => entry.projectId !== record.projectId);
    all.push(record);
    all.sort((a, b) => a.clonedAtMs - b.clonedAtMs);
    writeCheckouts(this.options.paths, all);
  }

  resolve(project: unknown): CheckoutRecord {
    return resolveCheckout(this.list(), project);
  }

  dir(record: CheckoutRecord): string {
    return checkoutDir(this.options.paths, record);
  }

  /**
   * Clones a project (identity from GitLab) onto the task branch. Re-cloning
   * an existing checkout is a no-op that reports its state.
   */
  async clone(project: unknown, ref?: unknown): Promise<CommandOutcome> {
    const reference = parseProjectRef(project, 'clone_repository');
    const lookup = await this.options.gitlab({ kind: 'get_project', project: reference });
    if (!lookup.ok) {
      throw new CheckoutError(
        `GitLab project ${reference.slice(0, 120)} is not readable: [${lookup.errorCategory ?? 'upstream'}] ${lookup.error ?? 'lookup failed'}`,
      );
    }
    const data = lookup.data as Record<string, unknown>;
    const existing = this.list().find((entry) => entry.projectId === data.id);
    if (existing !== undefined) {
      return {
        ok: true,
        output: this.describe(existing, 'already cloned'),
        evidence: `${existing.project}@${existing.baseCommit.slice(0, 12)}`,
      };
    }
    const defaultBranch = typeof data.default_branch === 'string' ? data.default_branch : '';
    let baseBranch: string;
    if (ref !== undefined && ref !== null && ref !== '') {
      if (typeof ref !== 'string') throw new CheckoutError('ref must be a branch name');
      baseBranch = validateTargetBranch(ref);
    } else {
      if (defaultBranch.length === 0)
        throw new CheckoutError('the project has no default branch (empty repository?)');
      baseBranch = defaultBranch;
    }
    const identity = identityFromProject(
      this.options.gitlabHost,
      { id: data.id, path_with_namespace: data.path_with_namespace },
      baseBranch,
      this.options.transportUrl,
    );
    const slug = checkoutSlug(identity.canonicalPath);
    const dir = path.join(this.options.paths.checkouts, slug);
    // A directory without a record is an interrupted clone: never retained work.
    fs.rmSync(dir, { recursive: true, force: true });
    const taskBranch = taskBranchName(this.options.workspaceId);
    let cloned: { baseCommit: string };
    try {
      cloned = await cloneApprovedProject({
        identity,
        token: this.options.gitlabToken,
        stagingRoot: this.options.stagingRoot,
        checkoutDir: dir,
        taskBranch,
        signal: this.options.signal,
      });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      const nospace = err instanceof Error && /ENOSPC|No space left/i.test(err.message);
      throw new CheckoutError(
        nospace
          ? `the thread's storage is full while cloning ${identity.canonicalPath}; remove other checkouts' build output or start a new thread`
          : `clone of ${identity.canonicalPath} (${baseBranch}) failed: ${err instanceof Error ? err.message.slice(0, 200) : 'git failed'}`,
      );
    }
    const record: CheckoutRecord = {
      project: identity.canonicalPath,
      projectId: identity.projectId,
      slug,
      defaultBranch: defaultBranch || baseBranch,
      baseBranch,
      taskBranch,
      baseCommit: cloned.baseCommit,
      webUrl: typeof data.web_url === 'string' ? data.web_url : null,
      clonedAtMs: Date.now(),
      verifications: [],
      publication: null,
    };
    this.update(record);
    this.options.onCloned(record, dir);
    await this.options.register(record);
    this.options.log.info(
      `checkout cloned project=${record.project} id=${record.projectId} base=${record.baseCommit.slice(0, 12)} branch=${taskBranch}`,
    );
    return {
      ok: true,
      output: this.describe(record, 'cloned'),
      evidence: `${record.project}@${record.baseCommit.slice(0, 12)}`,
    };
  }

  private describe(record: CheckoutRecord, verb: string): string {
    return (
      `${verb} ${record.project} (project ${record.projectId}) into ${record.slug}/ ` +
      `on branch ${record.taskBranch} from ${record.baseBranch} at ${record.baseCommit.slice(0, 12)} ` +
      `(default branch ${record.defaultBranch}). Edit files under ${record.slug}/.`
    );
  }

  /**
   * A cwd must be a directory of the checkout (relative to it). A wrong one
   * is refused before any sync with the directories that exist, and does
   * not count as a tool call.
   */
  private assertCwd(record: CheckoutRecord, dir: string, cwd: string | undefined): void {
    if (cwd === undefined || cwd === '' || cwd === '.') return;
    // The executor's resolver: a linked directory inside the checkout counts.
    let isDirectory = false;
    try {
      isDirectory = !path.isAbsolute(cwd) && fs.lstatSync(resolveWithin(dir, cwd)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) return;
    const listed = topLevelDirectories(dir).slice(0, 30);
    const others = this.list()
      .filter((entry) => entry.projectId !== record.projectId)
      .map((entry) => `${entry.slug}/ (${entry.project})`);
    throw new CheckoutError(
      `cwd "${cwd.slice(0, 120)}" is not a directory of ${record.project}; cwd is relative to its checkout ${record.slug}/. ` +
        `Its top-level directories: ${listed.length > 0 ? listed.map((name) => `${name}/`).join(', ') : 'none'}.` +
        (others.length > 0
          ? ` Other checkouts (pass their project instead): ${others.join(', ')}.`
          : '') +
        ' This refusal did not count as a tool call.',
      { uncounted: true },
    );
  }

  /** Execute in the checkout through the framework-owned sandbox binding. */
  private async runCommand(
    record: CheckoutRecord,
    argv: string[],
    cwd: string | undefined,
    timeoutMs: number,
  ): Promise<{
    result: Pick<WorkExecResult, 'status' | 'exitCode' | 'durationMs' | 'output' | 'truncated'>;
    applied: string;
    digest: string;
    refused: string | null;
  }> {
    const dir = this.dir(record);
    this.assertCwd(record, dir, cwd);
    if (this.options.executeInPlace) {
      const result = await this.options.executeInPlace({ dir, argv, cwd, timeoutMs });
      return {
        result,
        applied: '',
        digest: checkoutDigest(dir, this.options.transfer),
        refused: null,
      };
    }
    throw new CheckoutError('native workspace execution unavailable');
  }

  async exec(args: {
    project?: unknown;
    argv: string[];
    cwd?: string;
    timeoutMs: number;
  }): Promise<CommandOutcome> {
    const record = this.resolve(args.project);
    const { result, applied } = await this.runCommand(record, args.argv, args.cwd, args.timeoutMs);
    if (result.status === 'not_run') {
      throw new CheckoutError(`the executor refused the command: ${result.output.slice(0, 200)}`);
    }
    return {
      ok: result.status === 'completed' && result.exitCode === 0,
      output: `${result.output}${applied}`,
      evidence: `${record.project} exit=${result.exitCode ?? 'n/a'}${result.status === 'timed_out' ? ' timed_out' : ''}`,
      uncertain: result.status === 'timed_out',
      ...commandFailureClass(result.status, result.exitCode),
    };
  }

  /**
   * Runs one declared verification command and records its result against
   * the checkout's tree (after reconciling the command's own changes).
   */
  async verify(args: {
    project?: unknown;
    argv: string[];
    cwd?: string;
    timeoutMs: number;
    replaces?: VerificationReplacement;
  }): Promise<CommandOutcome> {
    const record = this.resolve(args.project);
    const argvKey = JSON.stringify(args.argv);
    const previous =
      args.replaces === undefined
        ? undefined
        : activeVerifications(record).find(
            (entry) => JSON.stringify(entry.argv) === JSON.stringify(args.replaces?.argv),
          );
    if (args.replaces !== undefined) {
      if (
        typeof args.replaces.reason !== 'string' ||
        !args.replaces.reason.trim() ||
        args.replaces.reason.length > 240
      )
        throw new CheckoutError('replacement requires a reason of 1–240 characters');
      if (!previous || JSON.stringify(previous.argv) === argvKey)
        throw new CheckoutError(
          'replacement must name a different active verification in this project',
        );
      if (
        previous.treeDigest ===
        checkoutDigest(checkoutDir(this.options.paths, record), this.options.transfer)
      )
        throw new CheckoutError(
          'replacement requires a changed tree: fix failing checks instead of retiring them',
        );
    }
    // Never silently evict a requirement (or retained replacement evidence).
    if (
      record.verifications.length >= 20 &&
      !activeVerifications(record).some((entry) => JSON.stringify(entry.argv) === argvKey)
    )
      throw new CheckoutError('verification record limit reached (20); reuse an existing command');
    const { result, applied, digest, refused } = await this.runCommand(
      record,
      args.argv,
      args.cwd,
      args.timeoutMs,
    );
    if (result.status === 'not_run') {
      throw new CheckoutError(`the executor refused the command: ${result.output.slice(0, 200)}`);
    }
    // A command whose changes were not reconciled never verified this tree.
    const status: VerificationRecord['status'] =
      result.status === 'timed_out'
        ? 'timed_out'
        : result.status === 'completed' && result.exitCode === 0 && refused === null
          ? 'passed'
          : 'failed';
    const reason =
      refused !== null && status === 'failed'
        ? `changes not reconciled: ${refused.slice(0, 300)}`
        : null;
    const current = this.resolve(record.projectId);
    if (previous && status === 'passed' && digest !== previous.treeDigest) {
      const retired = activeVerifications(current).find(
        (entry) => JSON.stringify(entry.argv) === JSON.stringify(previous.argv),
      );
      if (retired)
        retired.supersededBy = {
          argv: [...args.argv],
          reason: args.replaces!.reason.trim(),
          treeDigest: digest,
          runSeq: this.options.runSeq,
          atMs: Date.now(),
        };
    }
    current.verifications = [
      ...current.verifications.filter(
        (entry) => entry.supersededBy !== undefined || JSON.stringify(entry.argv) !== argvKey,
      ),
      {
        argv: [...args.argv],
        status,
        exitCode: result.exitCode,
        treeDigest: digest,
        reason,
        durationMs: result.durationMs,
        runSeq: this.options.runSeq,
        atMs: Date.now(),
      },
    ];
    this.update(current);
    const readiness = verificationReadiness(current, digest);
    return {
      ok: status === 'passed',
      output: `${result.output}${applied}\n[verification ${status}: ${args.argv.join(' ').slice(0, 120)} on ${record.project}${reason !== null ? ` (${reason})` : ''}; ${readiness.ready ? 'all declared verification commands pass at this tree' : readiness.detail}]`,
      evidence: `${record.project} verify ${status} exit=${result.exitCode ?? 'n/a'} tree=${digest.slice(0, 12)}`,
      uncertain: false,
      ...(refused !== null && status === 'failed'
        ? { failureClass: 'exit' as const }
        : commandFailureClass(result.status, result.exitCode)),
    };
  }

  /** Records a confirmed publication on the checkout. */
  recordPublication(projectId: number, publication: CheckoutPublication): void {
    const current = this.resolve(projectId);
    current.publication = publication;
    this.update(current);
  }
}
