/**
 * Publication of one checkout: the verified tree becomes a commit on the
 * task branch (`support-agent/<ws16>`), pushed with `git` (`ls-remote` +
 * `--force-with-lease`), and one task merge request per (workspace,
 * project) is found or created through the typed GitLab operations in the
 * tool runtime and updated on follow-ups.
 *
 * Durability (GitLab and the agent share no transaction): the intent
 * (`publication/<slug>.json`) is persisted before remote writes. A retry
 * after a lost push reuses the same commit; a lost MR acknowledgment finds
 * the task MR by source branch plus the `[task:<workspaceId>]` marker
 * before creating one. A merged, closed, or retargeted task MR stops
 * publication with an explicit state.
 */

import { activeVerifications } from './checkouts.js';
import fs from 'node:fs';
import path from 'node:path';
import type { StageLogger } from '../../infrastructure/logger.js';
import { validateGitlabOperation } from '../../integrations/gitlab/gitlab-operations.js';
import type { GitlabNormalizedResult } from '../../integrations/gitlab/gitlab-cli-adapter.js';
import { identityFromProject, validateTargetBranch } from './gitlab-policy.js';
import {
  buildStagingCommit,
  pushTaskBranch,
  lsRemoteHead,
  readIntent,
  snapshotTreeHash,
  writeIntent,
  PublisherError,
  type CommitIdentity,
  type PublicationIntent,
} from './publisher.js';
import { candidateScopeForProject, captureCandidate, dropCandidates } from './candidate-store.js';
import { resolveWithin } from './guard.js';
import { buildCandidateManifestAsync } from './candidate-manifest.js';
import type { TransferPolicy } from './transfer.js';
import type { WorkspacePaths } from '../../infrastructure/storage/workspace-paths.js';
import {
  CheckoutError,
  verificationReadiness,
  type CheckoutManager,
  type CheckoutRecord,
  type TrustedGitlab,
} from './checkouts.js';
import type { PublishRecord } from './publication-record.js';

export interface PublishProjectOptions {
  paths: WorkspacePaths;
  storageDir: string;
  workspaceId: string;
  gitlabHost: string;
  gitlabToken: string;
  transfer: TransferPolicy;
  gitlab: TrustedGitlab;
  checkouts: CheckoutManager;
  run: { runId: string; runSeq: number; attempt: number };
  /** Redacts deployment secrets from model-written text before it reaches GitLab. */
  redact(text: string): string;
  log: StageLogger;
  signal?: AbortSignal;
  authorize?(): Promise<void>;
  /** Persist exact-tree publication authority before the first external write. */
  beforeRemote?(evidence: {
    projectId: number;
    commit: string;
    tree: string;
    treeDigest: string;
    expectedRemoteHead: string | null;
    testedTreeHash: string;
  }): Promise<void>;
  confirmed?(publication: PublishRecord): Promise<void>;
  remoteEffect?<T>(operation: string, send: () => Promise<T>): Promise<T>;
  /** Deterministic tests only (loopback GITLAB_HOST): local push transport. */
  transportUrl?: (canonicalPath: string) => string;
}

interface MrData {
  iid: number;
  project_id: number;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: string;
  description?: string;
}

const BOT_START = '<!-- support-agent:start -->';
const BOT_END = '<!-- support-agent:end -->';

function asMr(data: unknown): MrData {
  const record = (data ?? {}) as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.iid) ||
    Number(record.iid) <= 0 ||
    !Number.isSafeInteger(record.project_id) ||
    Number(record.project_id) <= 0 ||
    typeof record.web_url !== 'string' ||
    typeof record.source_branch !== 'string' ||
    typeof record.target_branch !== 'string' ||
    typeof record.state !== 'string'
  ) {
    throw new PublisherError('GitLab returned an unreadable merge request', true);
  }
  return {
    iid: record.iid as number,
    project_id: record.project_id as number,
    web_url: record.web_url,
    source_branch: record.source_branch,
    target_branch: record.target_branch,
    state: record.state,
    description: typeof record.description === 'string' ? record.description : '',
  };
}

async function call(
  gitlab: TrustedGitlab,
  operation: string,
  args: Record<string, unknown>,
): Promise<GitlabNormalizedResult> {
  return gitlab(validateGitlabOperation(operation, args));
}

function requireOk(result: GitlabNormalizedResult, what: string): GitlabNormalizedResult {
  if (!result.ok) {
    const terminal = ['authentication', 'forbidden', 'invalid_input'].includes(
      result.errorCategory ?? '',
    );
    // glab's excerpt rides along as detail: runner log and action
    // evidence, never the model-visible message.
    throw new PublisherError(
      `${what} failed: [${result.errorCategory ?? 'upstream'}] ${result.error ?? 'request failed'}`,
      terminal,
      result.detail ?? null,
    );
  }
  return result;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

/**
 * The GitLab token's own user authors and commits the publication: GitLab
 * push rules ("commit author is a GitLab user") decline any other address.
 * No usable e-mail stops publication instead of inventing one.
 */
export async function resolveCommitIdentity(gitlab: TrustedGitlab): Promise<CommitIdentity> {
  const result = requireOk(await call(gitlab, 'get_current_user', {}), 'GitLab token user lookup');
  const user = (result.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const email = [user.email, user.commit_email, user.public_email]
    .map(text)
    .find((value) => EMAIL.test(value));
  if (email === undefined)
    throw new PublisherError(
      `the GitLab token's user${text(user.username) ? ` @${text(user.username)}` : ''} has no usable e-mail address (GitLab returned no email, commit_email or public_email), so the commit cannot be authored as a GitLab user; the operator must give that user an e-mail address or use a token whose user has one`,
      true,
    );
  const name = (text(user.name) || text(user.username) || email).replace(/[<>\r\n]/g, '');
  return { name: name.slice(0, 200), email };
}

/** The open task MR must still be ours: same branches, open, carrying the marker. */
function validateTaskMr(
  mr: MrData,
  options: PublishProjectOptions,
  record: CheckoutRecord,
  targetBranch: string,
  marker: string,
  expectedIid: number | null = null,
): MrData {
  if (
    mr.project_id !== record.projectId ||
    (expectedIid !== null && mr.iid !== expectedIid) ||
    mr.web_url !==
      `https://${options.gitlabHost.trim().toLowerCase()}/${record.project}/-/merge_requests/${mr.iid}` ||
    mr.state !== 'opened' ||
    mr.source_branch !== record.taskBranch ||
    mr.target_branch !== targetBranch ||
    !(mr.description ?? '').includes(marker)
  ) {
    throw new PublisherError(
      `task MR !${mr.iid} was ${mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'retargeted or replaced'}; operator decision required`,
      true,
    );
  }
  return mr;
}

async function findTaskMr(
  options: PublishProjectOptions,
  record: CheckoutRecord,
  targetBranch: string,
  marker: string,
  savedIid: number | null,
): Promise<MrData | null> {
  if (savedIid !== null) {
    const found = await call(options.gitlab, 'get_merge_request', {
      project: record.projectId,
      merge_request_iid: savedIid,
    });
    if (!found.ok && found.errorCategory === 'not_found')
      throw new PublisherError('task MR was deleted; operator decision required', true);
    return validateTaskMr(
      asMr(requireOk(found, 'task MR lookup').data),
      options,
      record,
      targetBranch,
      marker,
      savedIid,
    );
  }
  const listed = requireOk(
    await call(options.gitlab, 'list_merge_requests', {
      project: record.projectId,
      state: 'all',
      source_branch: record.taskBranch,
      per_page: 100,
    }),
    'task MR lookup',
  );
  const items = (Array.isArray(listed.data) ? listed.data : []).map((entry) => asMr(entry));
  const ours = items.filter((mr) => (mr.description ?? '').includes(marker));
  if (ours.length > 1)
    throw new PublisherError('ambiguous task MR lookup; operator decision required', true);
  if (ours.length === 0) return null;
  return validateTaskMr(ours[0] as MrData, options, record, targetBranch, marker);
}

function replaceBotSection(description: string, botSection: string): string {
  const start = description.indexOf(BOT_START);
  const end = description.indexOf(BOT_END);
  return start >= 0 && end > start
    ? `${description.slice(0, start)}${botSection}${description.slice(end + BOT_END.length)}`
    : `${description}\n\n${botSection}`;
}

/**
 * Publishes the verified tree of one checkout. Throws CheckoutError for a
 * refusal before any remote write (unverified or stale tree, bad target),
 * PublisherError for remote failures (the intent keeps the state). The
 * candidate copy is a full copy of the worktree in the thread's storage
 *: a completed, refused or terminally stopped publication drops it;
 * a retryable failure keeps it for the retry of the same tree, and
 * the next publication drops it if the tree changed meanwhile.
 */
export async function publishCheckout(
  options: PublishProjectOptions,
  args: { project?: unknown; title?: string; description?: string },
): Promise<PublishRecord> {
  let retry = false;
  try {
    return await publishVerifiedTree(options, args);
  } catch (err) {
    retry = err instanceof PublisherError && !err.terminal;
    throw err;
  } finally {
    let scope: string | null = null;
    try {
      scope = candidateScopeForProject(options.checkouts.resolve(args.project).projectId);
    } catch {
      // Not a cloned project: nothing was captured.
    }
    if (scope !== null && !retry)
      await dropCandidates(options.paths.root, scope).catch((err: unknown) =>
        options.log.warn(
          `publication candidate cleanup failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
        ),
      );
  }
}

async function publishVerifiedTree(
  options: PublishProjectOptions,
  args: { project?: unknown; title?: string; description?: string },
): Promise<PublishRecord> {
  const record = options.checkouts.resolve(args.project);
  const dir = options.checkouts.dir(record);
  // Asynchronous throughout: a synchronous walk, copy and re-hash of
  // a large worktree blocked the event loop for seconds right before the MR
  // lookup, whose pooled runtime connection had been closed meanwhile.
  const { manifest, digest } = await buildCandidateManifestAsync(dir, options.transfer);
  const readiness = verificationReadiness(record, digest);
  if (!readiness.ready) throw new CheckoutError(`publication refused: ${readiness.detail}`);
  // The task branch is built on the branch the checkout was cloned from, so
  // that branch is the only sound merge-request target (clone with `ref` to
  // target another existing branch).
  const targetBranch = validateTargetBranch(record.baseBranch);
  const identity = identityFromProject(
    options.gitlabHost,
    { id: record.projectId, path_with_namespace: record.project },
    targetBranch,
    options.transportUrl,
  );
  const marker = `[task:${options.workspaceId}]`;
  const prior = readIntent(options.storageDir, options.workspaceId, record.slug);
  if (
    prior !== null &&
    (prior.projectId !== identity.projectId ||
      prior.host !== identity.host ||
      prior.transportUrl !== identity.transportUrl ||
      prior.taskBranch !== record.taskBranch)
  )
    throw new PublisherError('retained publication destination changed', true);
  // Content-addressed copy of the exact verified tree: publication streams
  // from immutable controller-owned bytes while re-verifying every hash. A
  // copy retained by a failed attempt on the same tree is reused.
  const scope = candidateScopeForProject(record.projectId);
  await dropCandidates(options.paths.root, scope, digest);
  let candidate: Awaited<ReturnType<typeof captureCandidate>>;
  try {
    candidate = await captureCandidate(
      options.paths.root,
      dir,
      manifest,
      options.transfer,
      digest,
      scope,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new CheckoutError(
        `publication refused: thread storage full (the published worktree needs ${manifest.files.reduce((total, file) => total + file.size, 0)} bytes for its copy; CODING_THREAD_WORKSPACE_BYTES bounds a thread)`,
      );
    throw err;
  }
  const { manifest: retained, directory } = candidate;
  const testedTreeHash = snapshotTreeHash(retained.files);
  const existing = await findTaskMr(options, record, targetBranch, marker, prior?.mrIid ?? null);
  if (prior?.state === 'completed' && prior.testedTreeHash === testedTreeHash && existing) {
    if (!prior.commit || !prior.tree)
      throw new PublisherError('completed publication is missing its remote evidence', true);
    await options.authorize?.();
    if (
      (await lsRemoteHead(identity.transportUrl, record.taskBranch, options.gitlabToken)) !==
      prior.commit
    )
      throw new PublisherError(
        'remote task branch changed externally; explicit recovery required',
        true,
      );
    const completed: PublishRecord = {
      state: 'completed',
      project: record.project,
      commit: prior.commit,
      tree: prior.tree,
      branch: prior.taskBranch,
      targetBranch: prior.targetBranch,
      projectId: prior.projectId,
      mrIid: existing.iid,
      mrUrl: existing.web_url,
      lastError: null,
    };
    await options.beforeRemote?.({
      projectId: record.projectId,
      commit: prior.commit,
      tree: prior.tree,
      treeDigest: digest,
      expectedRemoteHead: prior.expectedRemoteHead,
      testedTreeHash,
    });
    await options.confirmed?.(completed);
    // Attribute a no-write confirmation to this run too.
    options.checkouts.recordPublication(record.projectId, {
      ...record.publication!,
      commit: prior.commit,
      tree: prior.tree,
      targetBranch,
      mrIid: existing.iid,
      mrUrl: existing.web_url,
      treeDigest: digest,
      runSeq: options.run.runSeq,
      atMs: Date.now(),
    });
    return completed;
  }
  const expectedRemoteHead =
    prior?.taskBranch === record.taskBranch ? (prior.expectedRemoteHead ?? null) : null;
  const intent: PublicationIntent = {
    version: 1,
    projectId: identity.projectId,
    canonicalPath: identity.canonicalPath,
    host: identity.host,
    taskBranch: record.taskBranch,
    targetBranch,
    transportUrl: identity.transportUrl,
    expectedRemoteHead,
    testedTreeHash,
    commit: prior?.testedTreeHash === testedTreeHash ? (prior.commit ?? null) : null,
    tree: prior?.testedTreeHash === testedTreeHash ? (prior.tree ?? null) : null,
    operationId: `task-${options.workspaceId}-${record.slug}-run-${options.run.runSeq}`,
    runId: options.run.runId,
    runSeq: options.run.runSeq,
    attempt: options.run.attempt,
    state: 'publication_pending',
    mrIid: prior?.mrIid ?? null,
    mrUrl: prior?.mrUrl ?? null,
    lastError: null,
    updatedAtMs: Date.now(),
  };
  const persist = (patch: Partial<PublicationIntent>): void => {
    Object.assign(intent, patch);
    writeIntent(options.storageDir, options.workspaceId, record.slug, intent);
  };
  persist({});
  const stagingDir = path.join(
    options.storageDir,
    'staging',
    options.workspaceId,
    record.slug,
    `run-${options.run.runSeq}`,
  );
  try {
    const summary = options.redact(args.title ?? '').trim();
    const firstLine = summary.split('\n')[0]?.slice(0, 120) || 'task update';
    let commit: string;
    let tree: string;
    if (fs.existsSync(path.join(stagingDir, '.git')) && intent.commit !== null) {
      commit = intent.commit;
      tree = intent.tree ?? '';
      options.log.info(`reusing staged commit ${commit.slice(0, 12)} for ${record.project}`);
    } else {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
      const author = await resolveCommitIdentity(options.gitlab);
      const built = await buildStagingCommit({
        identity,
        token: options.gitlabToken,
        stagingRoot: options.storageDir,
        stagingDir,
        snapshot: {
          manifest: retained,
          // Regular files only (links come from the manifest), never through a link.
          read: (relative) => {
            let fd: number;
            try {
              fd = fs.openSync(
                resolveWithin(directory, relative),
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
              );
            } catch {
              throw new PublisherError(
                'candidate file could not be read; publication stopped',
                true,
              );
            }
            return fs.createReadStream('', { fd });
          },
        },
        message: `support-agent: ${firstLine}\n\n${marker} run-${options.run.runSeq} tree:${testedTreeHash}`,
        taskBranch: record.taskBranch,
        author,
        parentCommit: expectedRemoteHead,
        baseCommit: record.baseCommit,
        signal: options.signal,
      });
      commit = built.commit;
      tree = built.tree;
      if (built.reused)
        options.log.info(
          `task branch already holds the verified tree at ${commit.slice(0, 12)} for ${record.project}; continuing with the merge request`,
        );
    }
    persist({ commit, tree });
    await options.beforeRemote?.({
      projectId: record.projectId,
      commit,
      tree,
      treeDigest: digest,
      expectedRemoteHead,
      testedTreeHash,
    });
    await options.authorize?.();
    const push = () =>
      pushTaskBranch({
        identity,
        token: options.gitlabToken,
        stagingRoot: options.storageDir,
        stagingDir,
        taskBranch: record.taskBranch,
        expectedRemoteHead,
        signal: options.signal,
      });
    // A confirmed identical head needs no second write on MR acknowledgement recovery.
    const pushed =
      expectedRemoteHead === commit
        ? { remoteHead: commit }
        : options.remoteEffect
          ? await options.remoteEffect(`push:${record.slug}:${commit}`, push)
          : await push();
    persist({ expectedRemoteHead: pushed.remoteHead, state: 'branch_confirmed' });
    const botSection = [
      BOT_START,
      `Task: ${options.workspaceId} | Run: ${options.run.runSeq} | Commit: ${commit} | Tree: ${testedTreeHash}`,
      `Verification: ${activeVerifications(record)
        .map((entry) => `\`${entry.argv.join(' ').slice(0, 120)}\` ${entry.status}`)
        .join(', ')}`,
      marker,
      BOT_END,
    ].join('\n');
    const checked = await findTaskMr(
      options,
      record,
      targetBranch,
      marker,
      existing?.iid ?? intent.mrIid,
    );
    let mr: MrData;
    if (checked !== null) {
      const description = replaceBotSection(checked.description ?? '', botSection);
      if (description.length > 60_000)
        throw new PublisherError(
          'MR description is too long to update without removing human edits',
          true,
        );
      const updated = requireOk(
        await call(options.gitlab, 'update_merge_request', {
          project: record.projectId,
          merge_request_iid: checked.iid,
          description,
        }),
        'task MR update',
      );
      mr = validateTaskMr(asMr(updated.data), options, record, targetBranch, marker, checked.iid);
    } else {
      persist({ state: 'mr_outcome_uncertain' });
      const description = [
        options.redact(args.description ?? '').slice(0, 40_000) ||
          'Requested change with local verification evidence.',
        '',
        botSection,
      ].join('\n');
      const created = await call(options.gitlab, 'create_merge_request', {
        project: record.projectId,
        source_branch: record.taskBranch,
        target_branch: targetBranch,
        title: `support-agent: ${firstLine}`.slice(0, 255),
        description,
      });
      if (!created.ok && created.errorCategory === 'conflict') {
        const found = await findTaskMr(options, record, targetBranch, marker, null);
        if (found === null)
          throw new PublisherError(
            'an open MR for the task branch exists without the task marker; operator decision required',
            true,
          );
        mr = found;
      } else {
        mr = validateTaskMr(
          asMr(requireOk(created, 'task MR creation').data),
          options,
          record,
          targetBranch,
          marker,
        );
      }
    }
    if (
      (await lsRemoteHead(identity.transportUrl, record.taskBranch, options.gitlabToken)) !== commit
    )
      throw new PublisherError(
        'remote task branch changed externally; explicit recovery required',
        true,
      );
    persist({ mrIid: mr.iid, mrUrl: mr.web_url, state: 'completed', lastError: null });
    await options.confirmed?.({
      state: 'completed',
      project: record.project,
      commit,
      tree,
      branch: record.taskBranch,
      targetBranch,
      projectId: record.projectId,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      lastError: null,
    });
    options.checkouts.recordPublication(record.projectId, {
      commit,
      tree,
      targetBranch,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      treeDigest: digest,
      runSeq: options.run.runSeq,
      atMs: Date.now(),
    });
    options.log.info(
      `publication confirmed project=${record.project} branch=${record.taskBranch} commit=${commit.slice(0, 12)} mr=${mr.iid}`,
    );
    return {
      state: 'completed',
      project: record.project,
      commit,
      tree,
      branch: record.taskBranch,
      targetBranch,
      projectId: record.projectId,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      lastError: null,
    };
  } catch (err) {
    if (err instanceof PublisherError && err.detail !== null)
      options.log.warn(
        `publication failure project=${record.project} branch=${record.taskBranch}: ${err.message} | detail: ${err.detail.replace(/\s*\n\s*/g, ' | ').slice(0, 2000)}`,
      );
    const message = err instanceof Error ? err.message.slice(0, 500) : 'publication failed';
    try {
      persist({ state: 'failed', lastError: message });
    } catch {
      // The visible failure below is authoritative.
    }
    throw err;
  }
}
