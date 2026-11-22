import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Environment-level serialization for the designated live environment.
 *
 * The per-worktree `.run/live-e2e.lock` does not serialize different
 * worktrees against the SAME shared Compose project and Docker daemon:
 * separate Compose project names do not isolate shared image tags. This
 * module adds one lock per (compose project, Docker host) pair, stored in
 * the host temp directory so every worktree on the machine contends on the
 * same file. The integration owner is the only intended holder.
 *
 * This lock neither changes environment settings nor adopts an old holder.
 * A retained lock after interruption requires operator inspection.
 */

/**
 * The lock is scoped to one instance: the Compose project named by the
 * instance env file's COMPOSE_PROJECT_NAME. There is no default project, so
 * a caller can never contend on (or claim) another instance's lock by
 * omission.
 */
function requireComposeProject(composeProject) {
  if (typeof composeProject !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) {
    throw new Error('composeProject (COMPOSE_PROJECT_NAME of the instance env file) is required');
  }
  return composeProject;
}

export function environmentLockIdentity({ composeProject, dockerHost = '' } = {}) {
  requireComposeProject(composeProject);
  const key = `${composeProject}\n${dockerHost || 'default-daemon'}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function environmentLockPath(options = {}) {
  return path.join(os.tmpdir(), `support-agent-live-env-${environmentLockIdentity(options)}.lock`);
}

/**
 * Non-blocking exclusive acquire. Throws (blocked=true via opts.onHeld) when
 * another holder owns the shared environment; the caller decides how to
 * report it. Returns a release function.
 */
export function acquireEnvironmentLock({ id, composeProject, dockerHost, onHeld } = {}) {
  const lockPath = environmentLockPath({ composeProject, dockerHost });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let locked = false;
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, id, host: os.hostname(), at: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    );
    locked = true;
  } catch {
    let holder = 'unknown holder';
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')).id ?? holder;
    } catch {
      /* Preserve the generic message. */
    }
    if (onHeld) onHeld(lockPath, holder);
    throw new Error('designated environment lock unavailable');
  }
  return () => {
    if (!locked) return;
    locked = false;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* A later manual cleanup inspects the recorded PID. */
    }
  };
}
