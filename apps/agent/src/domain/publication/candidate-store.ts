import fs from 'node:fs';
import path from 'node:path';
import {
  buildTreeManifestAsync,
  ensureRealParents,
  manifestDigest,
  validateRelativePath,
  validateTreeManifest,
  type TreeManifest,
  type TransferPolicy,
} from './transfer.js';

const DIGEST = /^[a-f0-9]{64}$/;

/** The candidate store of one scope (a canonical project identity). */
function scopeStore(root: string, scope: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(scope)) throw new Error('invalid candidate scope');
  return path.join(root, 'verified-snapshots', scope);
}

async function syncPath(target: string): Promise<void> {
  const handle = await fs.promises.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectories(directory: string): Promise<void> {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await syncDirectories(path.join(directory, entry.name));
  await syncPath(directory);
}

/**
 * The retained candidate `key`, when its manifest (revalidated, links and
 * targets included) and its bytes and link targets still match it.
 */
async function verifiedCandidate(
  store: string,
  key: string,
  policy: TransferPolicy,
): Promise<{ manifest: TreeManifest; directory: string } | null> {
  const directory = path.join(store, key);
  let manifest: TreeManifest;
  try {
    manifest = validateTreeManifest(
      JSON.parse(await fs.promises.readFile(path.join(store, `${key}.json`), 'utf8')),
      policy,
    );
    if (
      manifestDigest(manifest) !== key ||
      manifestDigest(await buildTreeManifestAsync(directory, policy, manifest.root)) !== key
    )
      return null;
  } catch {
    return null;
  }
  return { manifest, directory };
}

/**
 * Controller-owned immutable bytes, outside every agent/executor mount.
 * `scope` namespaces the store by canonical project identity (e.g.
 * `project-123` or `fixture`): tasks selecting different repositories cannot
 * exchange snapshots even for identical content. A candidate is a full copy
 * of the published worktree in the thread's storage: a publication keeps it
 * only until it completes, or across a retryable failure for its retry
 * (see `dropCandidates`).
 *
 * Returns the verified copy of `manifest` (digest `key`): a retained one
 * whose bytes still match, else a fresh copy from `checkout`, re-hashed
 * before it is used. Every file system call is asynchronous, so capturing a
 * large worktree never blocks the runner's event loop.
 */
export async function captureCandidate(
  root: string,
  checkout: string,
  manifest: TreeManifest,
  policy: TransferPolicy,
  key: string,
  scope: string,
): Promise<{ manifest: TreeManifest; directory: string }> {
  if (!DIGEST.test(key) || manifestDigest(manifest) !== key)
    throw new Error('invalid candidate identity');
  const store = scopeStore(root, scope);
  const retained = await verifiedCandidate(store, key, policy);
  if (retained !== null) return retained;
  await fs.promises.mkdir(store, { recursive: true });
  const target = path.join(store, key);
  const manifestFile = path.join(store, `${key}.json`);
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.rm(manifestFile, { force: true });
  const temporary = await fs.promises.mkdtemp(path.join(store, '.candidate-'));
  try {
    for (const file of manifest.files) {
      const relative = validateRelativePath(file.path);
      const source = path.join(checkout, relative);
      const destination = path.join(temporary, relative);
      const stat = await fs.promises.lstat(source).catch(() => null);
      ensureRealParents(temporary, relative);
      if (file.kind === 'symlink') {
        // A link is copied as a link: never opened, never chmodded.
        const target =
          stat?.isSymbolicLink() === true
            ? await fs.promises.readlink(source, { encoding: 'buffer' })
            : null;
        if (target === null || !target.equals(Buffer.from(file.target, 'utf8')))
          throw new Error('candidate changed during capture');
        await fs.promises.symlink(file.target, destination);
        continue;
      }
      if (stat?.isFile() !== true) throw new Error('candidate changed during capture');
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(destination, file.mode === '100755' ? 0o755 : 0o644);
      await syncPath(destination);
    }
    const copied = await buildTreeManifestAsync(temporary, policy, manifest.root);
    if (manifestDigest(copied) !== key) throw new Error('candidate changed during capture');
    // Every directory (and with it each link's entry) is made durable.
    await syncDirectories(temporary);
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
  await fs.promises.writeFile(`${manifestFile}.tmp`, JSON.stringify(manifest));
  await syncPath(`${manifestFile}.tmp`);
  await fs.promises.rename(`${manifestFile}.tmp`, manifestFile);
  await syncPath(store);
  return { manifest, directory: target };
}

/**
 * Removes a scope's candidates (copies, manifests and interrupted captures)
 * except `keep`: a publication needs only the candidate of the tree
 * it publishes; a completed or stopped publication keeps none.
 */
export async function dropCandidates(
  root: string,
  scope: string,
  keep: string | null = null,
): Promise<void> {
  const store = scopeStore(root, scope);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(store);
  } catch {
    return;
  }
  for (const entry of entries) {
    const digest = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : entry;
    const ours =
      DIGEST.test(digest) || entry.startsWith('.candidate-') || entry.endsWith('.json.tmp');
    if (!ours || (keep !== null && digest === keep)) continue;
    await fs.promises.rm(path.join(store, entry), { recursive: true, force: true });
  }
}

/** Scoped cache key namespace for a canonical project identity (or fixture). */
export function candidateScopeForProject(projectId: number | null): string {
  return projectId === null ? 'fixture' : `project-${projectId}`;
}
