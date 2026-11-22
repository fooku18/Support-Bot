/**
 * GitLab destination policy for clone and publication.
 *
 * The GitLab token is the permission boundary: any project the token can
 * reach on the configured GITLAB_HOST may be cloned and published to. The
 * destination identity (numeric project ID, canonical path, default branch)
 * always comes from GitLab itself (the typed `get_project` read through the
 * tool runtime), never from agent-writable `.git/config`, remotes, or local
 * journals. The host is configuration, never model input; transport URLs are
 * derived here and carry no credentials.
 *
 * Only `support-agent/<workspace>` branches are ever pushed; default and other
 * target branches are never written directly.
 */

export interface GitLabProjectIdentity {
  /** Lowercased configured GITLAB_HOST. */
  host: string;
  /** Canonical numeric project ID from GitLab (never model-supplied). */
  projectId: number;
  /** Canonical `path_with_namespace` from GitLab (case-preserved). */
  canonicalPath: string;
  /** Approved https clone URL without credentials (derived, never accepted). */
  transportUrl: string;
  /** Branch the task branch is based on and merge requests target. */
  targetBranch: string;
}

export class GitLabPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLabPolicyError';
  }
}

const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;

/** Validates a target/base branch name (never a support-agent/ branch). */
export function validateTargetBranch(branch: string): string {
  if (
    !BRANCH_PATTERN.test(branch) ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.startsWith('-')
  ) {
    throw new GitLabPolicyError('branch name is not supported');
  }
  if (branch.startsWith('support-agent/')) {
    throw new GitLabPolicyError('support-agent/ branches are never publication targets');
  }
  return branch;
}

/** Approved transport URL from a canonical identity (no credentials). */
export function approvedTransportUrl(host: string, canonicalPath: string): string {
  return `https://${host}/${canonicalPath}.git`;
}

/** Builds the trusted identity from a GitLab `get_project` answer. */
export function identityFromProject(
  host: string,
  project: { id: unknown; path_with_namespace: unknown },
  targetBranch: string,
  /** Deterministic tests only (loopback hosts): a local transport for the path. */
  transportOverride?: (canonicalPath: string) => string,
): GitLabProjectIdentity {
  if (!Number.isSafeInteger(project.id) || (project.id as number) <= 0) {
    throw new GitLabPolicyError('GitLab returned no numeric project ID');
  }
  const canonicalPath = String(project.path_with_namespace ?? '');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/.test(canonicalPath)) {
    throw new GitLabPolicyError('GitLab returned an unsupported project path');
  }
  const normalizedHost = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(normalizedHost)) {
    throw new GitLabPolicyError('GITLAB_HOST is not a host name');
  }
  return {
    host: normalizedHost,
    projectId: project.id as number,
    canonicalPath,
    transportUrl:
      transportOverride !== undefined
        ? transportOverride(canonicalPath)
        : approvedTransportUrl(normalizedHost, canonicalPath),
    targetBranch: validateTargetBranch(targetBranch),
  };
}

/** Opaque deterministic task branch for a workspace (no Slack text). */
export function taskBranchName(workspaceId: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(workspaceId)) {
    throw new GitLabPolicyError('workspace identity is invalid for branch derivation');
  }
  return `support-agent/${workspaceId.slice(0, 16)}`;
}

/** Checkout directory slug: the canonical project path with `/` → `__`. */
export function checkoutSlug(canonicalPath: string): string {
  return canonicalPath.split('/').join('__');
}

/** Sanitizes policy diagnostics (never includes tokens or full URLs). */
export function sanitizePolicyError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'GitLab policy violation';
  return message.slice(0, 300);
}
