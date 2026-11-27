/**
 * Streaming tree transfer protocol (version 2, uncompressed).
 *
 * Replaces the whole-tree base64 JSON transport between the runner and the
 * isolated executor. The wire format (media type
 * `application/x-support-agent-tree-v2`) is a bounded-buffer framed stream:
 *
 *   <manifest JSON>\n            one line: the full TreeManifest
 *   <raw file bytes>             for each regular-file entry, in order
 *   {"complete":true}\n          final frame
 *
 * The manifest is a union of regular files (normalized relative path, mode,
 * size, SHA-256 content hash) and symbolic links (mode 120000, the
 * exact target, size and hash over the target bytes). A link's target
 * travels in the manifest; it has no body, but its bytes count against every
 * bound. File bodies are streamed with backpressure; nothing accumulates
 * multi-gigabyte buffers, base64 arrays, or file maps containing file
 * contents. Compression is deliberately disabled; decompressed bytes could
 * otherwise escape the declared byte budget.
 *
 * Validation is adversarial: absolute paths, traversal, backslashes, `.git`
 * entries, duplicate entries, an entry below another leaf, devices and other
 * special files, unsupported modes, oversize files, counts and totals are
 * rejected. Every link is resolved component by component against the tree
 * it belongs to (`resolveTreeLink`): it may dangle, but it may never leave
 * the tree, enter `.git`, or expand more than 40 times. A stream whose bytes
 * or hashes disagree with the manifest is never activated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TREE_TRANSFER_VERSION = 2;
/** Media type of a v2 tree upload (`/work/sync`). */
export const TREE_MEDIA_TYPE = 'application/x-support-agent-tree-v2';
/** Bytes a link target may have (UTF-8). */
export const MAX_LINK_TARGET_BYTES = 1024;
/** Link expansions one resolution may perform (Linux MAXSYMLINKS). */
export const MAX_LINK_EXPANSIONS = 40;

export type RegularMode = '100644' | '100755';
export type LinkMode = '120000';

export interface TreeFileEntry {
  kind: 'file';
  /** Normalized relative path (forward slashes, no trailing slash). */
  path: string;
  mode: RegularMode;
  size: number;
  sha256: string;
}

export interface TreeLinkEntry {
  kind: 'symlink';
  path: string;
  mode: LinkMode;
  /** Exact link target (UTF-8, relative, never absolute). */
  target: string;
  /** Target bytes. */
  size: number;
  /** SHA-256 of the target bytes. */
  sha256: string;
}

export type TreeManifestEntry = TreeFileEntry | TreeLinkEntry;

export interface TreeManifest {
  version: typeof TREE_TRANSFER_VERSION;
  /** Logical root label (executor staging layout). */
  root: string;
  files: TreeManifestEntry[];
  totalBytes: number;
}

export interface TransferPolicy {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

const HASH_RE = /^[0-9a-f]{64}$/;

const shown = (value: string): string => value.slice(0, 200);

/** The refusal for a link that leaves its tree (or enters `.git`, or loops). */
export function linkOutsideMessage(linkPath: string): string {
  return `symbolic link target outside the tree: ${shown(linkPath)}`;
}

/** Normalizes and validates one relative path (no filesystem access). */
export function validateRelativePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) {
    throw new TransferError('invalid path length');
  }
  if (raw.includes('\\') || raw.includes('\0')) {
    throw new TransferError(`unsupported path separator: ${raw.slice(0, 80)}`);
  }
  if (path.isAbsolute(raw) || raw.startsWith('/')) {
    throw new TransferError(`absolute paths are rejected: ${raw.slice(0, 80)}`);
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TransferError(`path traversal or empty segment rejected: ${raw.slice(0, 80)}`);
    }
    if (segment.toLowerCase() === '.git') {
      throw new TransferError(`Git control data is excluded from transfers: ${raw.slice(0, 80)}`);
    }
  }
  return segments.join('/');
}

/**
 * A link target as the manifest carries it: the exact bytes must round-trip
 * as UTF-8, non-empty, at most 1024 bytes, no NUL, relative.
 */
export function validateLinkTarget(raw: Buffer | string, where: string): string {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  // Invalid byte sequences and unpaired surrogates both fail the round trip.
  if (!Buffer.from(text, 'utf8').equals(bytes) || bytes.toString('utf8') !== text) {
    throw new TransferError(`symbolic link target is not valid UTF-8: ${shown(where)}`);
  }
  if (bytes.length === 0) {
    throw new TransferError(`symbolic link target is empty: ${shown(where)}`);
  }
  if (bytes.length > MAX_LINK_TARGET_BYTES) {
    throw new TransferError(
      `symbolic link target exceeds ${MAX_LINK_TARGET_BYTES} bytes: ${shown(where)}`,
    );
  }
  if (text.includes('\0')) {
    throw new TransferError(`symbolic link target contains NUL: ${shown(where)}`);
  }
  if (text.startsWith('/')) {
    throw new TransferError(`absolute symbolic link targets are refused: ${shown(where)}`);
  }
  return text;
}

// --- Link resolution -------------------------------------------------------

/** What a tree holds at one path (a link is never followed by the lookup). */
export type TreeNode =
  | { type: 'dir' }
  | { type: 'file' }
  /** `target` null: a link whose target bytes are not valid UTF-8. */
  | { type: 'symlink'; target: string | null };

/** Looks one path (components below the unit root) up in a tree; null: absent. */
export type TreeLookup = (components: readonly string[]) => TreeNode | null;

export type TreeResolution =
  | { ok: true; components: string[] }
  | { ok: false; reason: 'outside' | 'absolute' | 'git' | 'loop' | 'invalid' };

const DIR: TreeNode = { type: 'dir' };
const FILE: TreeNode = { type: 'file' };

/**
 * The one resolver for every tree: resolves `requested` component
 * by component against `lookup`, expanding each link where it is met, with
 * no lexical `..` normalization first. Every step stays inside the unit
 * root: the tree root, or with `unitDepth: 1` the top-level directory (one
 * checkout) a link lives in, which its target may never leave (a plain `..`
 * of the requested path itself may still move between checkouts). A link
 * target never enters `.git` and never is absolute; more than 40 expansions
 * (cycles) are refused. A missing component is not an error: a
 * dangling-but-contained path resolves to where it would be created.
 */
export function resolveTreeLink(
  lookup: TreeLookup,
  requested: string | readonly string[],
  options: { unitDepth?: number; maxExpansions?: number } = {},
): TreeResolution {
  const unitDepth = options.unitDepth ?? 0;
  const maxExpansions = options.maxExpansions ?? MAX_LINK_EXPANSIONS;
  const parts = typeof requested === 'string' ? requested.split('/') : [...requested];
  const queue = parts.map((name) => ({ name, floor: 0, viaLink: false }));
  const stack: string[] = [];
  let expansions = 0;
  while (queue.length > 0) {
    const { name, floor, viaLink } = queue.shift()!;
    if (name === '' || name === '.') continue;
    if (name === '..') {
      if (stack.length <= floor) return { ok: false, reason: 'outside' };
      stack.pop();
      continue;
    }
    if (viaLink && name.toLowerCase() === '.git') return { ok: false, reason: 'git' };
    const node = lookup([...stack, name]);
    if (node?.type === 'symlink') {
      expansions += 1;
      if (expansions > maxExpansions) return { ok: false, reason: 'loop' };
      if (node.target === null) return { ok: false, reason: 'invalid' };
      if (node.target.startsWith('/')) return { ok: false, reason: 'absolute' };
      // A link inside a unit may not leave it; a loose link at the root may
      // move anywhere below the root.
      const linkFloor = Math.max(floor, stack.length >= unitDepth ? unitDepth : 0);
      queue.unshift(
        ...node.target.split('/').map((part) => ({ name: part, floor: linkFloor, viaLink: true })),
      );
      continue;
    }
    stack.push(name);
  }
  return { ok: true, components: stack };
}

/** Throws the refusal for the first link in `linkPaths` that does not resolve. */
export function assertTreeLinks(
  lookup: TreeLookup,
  linkPaths: Iterable<string>,
  options: { unitDepth?: number } = {},
): void {
  for (const linkPath of linkPaths) {
    if (!resolveTreeLink(lookup, linkPath, options).ok)
      throw new TransferError(linkOutsideMessage(linkPath));
  }
}

/** A manifest as a tree: its entries plus their implied directories. */
export function manifestTreeLookup(entries: readonly TreeManifestEntry[]): TreeLookup {
  const nodes = new Map<string, TreeNode>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!nodes.has(dir)) nodes.set(dir, DIR);
    }
  }
  for (const entry of entries)
    nodes.set(
      entry.path,
      entry.kind === 'symlink' ? { type: 'symlink', target: entry.target } : FILE,
    );
  return (components) =>
    components.length === 0 ? DIR : (nodes.get(components.join('/')) ?? null);
}

/**
 * A directory on disk as a tree, through lstat only: a path is present only
 * when every ancestor is a real directory, so a link is never traversed by
 * the lookup itself (the resolver expands it).
 */
export function fsTreeLookup(root: string): TreeLookup {
  const cache = new Map<string, TreeNode | null>();
  const node = (key: string): TreeNode | null => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let result: TreeNode | null;
    try {
      const full = path.join(root, key);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const raw = fs.readlinkSync(full, { encoding: 'buffer' });
        const text = raw.toString('utf8');
        result = { type: 'symlink', target: Buffer.from(text, 'utf8').equals(raw) ? text : null };
      } else result = stat.isDirectory() ? DIR : FILE;
    } catch {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
  return (components) => {
    if (components.length === 0) return DIR;
    for (let i = 1; i < components.length; i += 1) {
      if (node(components.slice(0, i).join('/'))?.type !== 'dir') return null;
    }
    return node(components.join('/'));
  };
}

// --- Manifest builders -----------------------------------------------------

/** What the manifest walk does with one directory entry. */
function entryAction(
  entry: fs.Dirent,
  childRelative: string,
  options: { skipSpecialFiles?: boolean },
): 'skip' | 'directory' | 'file' | 'symlink' {
  // Git control data is excluded from transfers entirely.
  if (entry.isDirectory() && entry.name.toLowerCase() === '.git') return 'skip';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (!entry.isFile()) {
    if (options.skipSpecialFiles === true) return 'skip';
    throw new TransferError(
      `unsupported file type in transferred trees: ${childRelative.slice(0, 80)}`,
    );
  }
  return 'file';
}

/** Enforces the policy bounds for one more entry; returns the new byte total. */
function admitFile(
  policy: TransferPolicy,
  fileCount: number,
  totalBytes: number,
  size: number,
  childRelative: string,
): number {
  if (fileCount >= policy.maxFiles) {
    throw new TransferError(`tree exceeds the file-count bound (${policy.maxFiles})`);
  }
  if (size > policy.maxFileBytes) {
    throw new TransferError(
      `file exceeds the per-file bound (${policy.maxFileBytes}): ${childRelative.slice(0, 80)}`,
    );
  }
  const total = totalBytes + size;
  if (total > policy.maxTotalBytes) {
    throw new TransferError(`tree exceeds the total byte bound (${policy.maxTotalBytes})`);
  }
  return total;
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The one entry function of both manifest builders: a regular file from its
 * lstat mode and streamed hash, or a link from its raw target bytes.
 */
function manifestEntry(
  childRelative: string,
  found: { mode: number; size: number; sha256: string } | { target: Buffer },
): TreeManifestEntry {
  const entryPath = validateRelativePath(childRelative);
  if ('target' in found) {
    const target = validateLinkTarget(found.target, childRelative);
    return {
      kind: 'symlink',
      path: entryPath,
      mode: '120000',
      target,
      size: found.target.length,
      sha256: sha256Of(found.target),
    };
  }
  return {
    kind: 'file',
    path: entryPath,
    mode: (found.mode & 0o111) !== 0 ? '100755' : '100644',
    size: found.size,
    sha256: found.sha256,
  };
}

const drifted = (childRelative: string): TransferError =>
  new TransferError(`file changed during manifest build: ${childRelative.slice(0, 80)}`);

/** Opens a regular file without following a link swapped in after the walk. */
const NOFOLLOW_READ = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

function finishManifest(
  files: TreeManifestEntry[],
  rootLabel: string,
  totalBytes: number,
): TreeManifest {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assertTreeLinks(
    manifestTreeLookup(files),
    files.filter((entry) => entry.kind === 'symlink').map((entry) => entry.path),
  );
  return { version: TREE_TRANSFER_VERSION, root: rootLabel, files, totalBytes };
}

/**
 * Builds a manifest for a directory tree with a streaming hash pass (bounded
 * buffers; file contents are never held in memory). `.git` is skipped, links
 * are recorded with their targets (lstat/readlink, never followed) and
 * resolved against the tree, other special files are rejected (or, with
 * `skipSpecialFiles`, left out: change detection only), and every policy
 * bound is enforced. Throws TransferError when the tree cannot be
 * represented, including when an entry changes type during the walk.
 */
export function buildTreeManifest(
  rootDir: string,
  policy: TransferPolicy,
  rootLabel = 'checkout',
  options: { skipSpecialFiles?: boolean } = {},
): TreeManifest {
  const files: TreeManifestEntry[] = [];
  let totalBytes = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  const walk = (relative: string): void => {
    const current = relative.length === 0 ? rootDir : path.join(rootDir, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      throw new TransferError(`directory cannot be read: ${relative.slice(0, 80)}`);
    }
    for (const entry of entries) {
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const action = entryAction(entry, childRelative, options);
      if (action === 'skip') continue;
      if (action === 'directory') {
        walk(childRelative);
        continue;
      }
      const full = path.join(rootDir, childRelative);
      if (action === 'symlink') {
        let target: Buffer;
        try {
          if (!fs.lstatSync(full).isSymbolicLink()) throw drifted(childRelative);
          target = fs.readlinkSync(full, { encoding: 'buffer' });
        } catch (err) {
          throw err instanceof TransferError ? err : drifted(childRelative);
        }
        const link = manifestEntry(childRelative, { target });
        totalBytes = admitFile(policy, files.length, totalBytes, link.size, childRelative);
        files.push(link);
        continue;
      }
      let fd: number;
      try {
        fd = fs.openSync(full, NOFOLLOW_READ);
      } catch {
        throw drifted(childRelative);
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw drifted(childRelative);
        totalBytes = admitFile(policy, files.length, totalBytes, stat.size, childRelative);
        const hash = createHash('sha256');
        let read = 0;
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (count === 0) break;
          read += count;
          hash.update(buffer.subarray(0, count));
        }
        if (read !== stat.size) throw drifted(childRelative);
        files.push(
          manifestEntry(childRelative, {
            mode: stat.mode,
            size: stat.size,
            sha256: hash.digest('hex'),
          }),
        );
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  walk('');
  return finishManifest(files, rootLabel, totalBytes);
}

/**
 * `buildTreeManifest` without blocking the event loop: the same
 * walk, entry function, bounds and errors on asynchronous file system
 * calls, hashing each file in bounded chunks. Publication uses it before its
 * network calls, so a large worktree never stalls the runner's other
 * connections.
 */
export async function buildTreeManifestAsync(
  rootDir: string,
  policy: TransferPolicy,
  rootLabel = 'checkout',
  options: { skipSpecialFiles?: boolean } = {},
): Promise<TreeManifest> {
  const files: TreeManifestEntry[] = [];
  let totalBytes = 0;
  const buffer = Buffer.alloc(256 * 1024);
  const walk = async (relative: string): Promise<void> => {
    const current = relative.length === 0 ? rootDir : path.join(rootDir, relative);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      throw new TransferError(`directory cannot be read: ${relative.slice(0, 80)}`);
    }
    for (const entry of entries) {
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const action = entryAction(entry, childRelative, options);
      if (action === 'skip') continue;
      if (action === 'directory') {
        await walk(childRelative);
        continue;
      }
      const full = path.join(rootDir, childRelative);
      if (action === 'symlink') {
        let target: Buffer;
        try {
          if (!(await fs.promises.lstat(full)).isSymbolicLink()) throw drifted(childRelative);
          target = await fs.promises.readlink(full, { encoding: 'buffer' });
        } catch (err) {
          throw err instanceof TransferError ? err : drifted(childRelative);
        }
        const link = manifestEntry(childRelative, { target });
        totalBytes = admitFile(policy, files.length, totalBytes, link.size, childRelative);
        files.push(link);
        continue;
      }
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(full, NOFOLLOW_READ);
      } catch {
        throw drifted(childRelative);
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw drifted(childRelative);
        totalBytes = admitFile(policy, files.length, totalBytes, stat.size, childRelative);
        const hash = createHash('sha256');
        let read = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          read += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (read !== stat.size) throw drifted(childRelative);
        files.push(
          manifestEntry(childRelative, {
            mode: stat.mode,
            size: stat.size,
            sha256: hash.digest('hex'),
          }),
        );
      } finally {
        await handle.close();
      }
    }
  };
  await walk('');
  return finishManifest(files, rootLabel, totalBytes);
}

/** Canonical manifest JSON (stable key order, sorted entries; kind and target bound). */
export function canonicalManifestJson(manifest: TreeManifest): string {
  const sorted = {
    version: manifest.version,
    root: manifest.root,
    totalBytes: manifest.totalBytes,
    files: [...manifest.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) =>
        entry.kind === 'symlink'
          ? {
              kind: entry.kind,
              mode: entry.mode,
              path: entry.path,
              sha256: entry.sha256,
              size: entry.size,
              target: entry.target,
            }
          : {
              kind: entry.kind,
              mode: entry.mode,
              path: entry.path,
              sha256: entry.sha256,
              size: entry.size,
            },
      ),
  };
  return JSON.stringify(sorted);
}

/** Content digest binding verification, artifacts, and publication to one candidate. */
export function manifestDigest(manifest: TreeManifest): string {
  return createHash('sha256').update(canonicalManifestJson(manifest)).digest('hex');
}

/** Rejects an entry that sits below another leaf (`a` with `a/x`, any order). */
function assertNoLeafAncestors(paths: readonly string[], what: string): void {
  const leaves = new Set(paths);
  for (const entryPath of paths) {
    let slash = entryPath.indexOf('/');
    while (slash >= 0) {
      const prefix = entryPath.slice(0, slash);
      if (leaves.has(prefix))
        throw new TransferError(`conflicting ${what}: ${shown(prefix)} and ${shown(entryPath)}`);
      slash = entryPath.indexOf('/', slash + 1);
    }
  }
}

/** Validates a parsed manifest against policy and structural rules. */
export function validateTreeManifest(
  parsed: unknown,
  policy: TransferPolicy,
  expectedRoot?: string,
): TreeManifest {
  if (parsed === null || typeof parsed !== 'object') {
    throw new TransferError('manifest is not an object');
  }
  const manifest = parsed as Partial<TreeManifest> & { version?: unknown };
  if (manifest.version !== TREE_TRANSFER_VERSION) {
    throw new TransferError(`unsupported transfer manifest version: ${String(manifest.version)}`);
  }
  if (
    typeof manifest.root !== 'string' ||
    manifest.root.length === 0 ||
    manifest.root.length > 32
  ) {
    throw new TransferError('manifest root label is invalid');
  }
  if (expectedRoot !== undefined && manifest.root !== expectedRoot) {
    throw new TransferError(`manifest root mismatch: ${manifest.root.slice(0, 32)}`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new TransferError('manifest files must be an array');
  }
  if (manifest.files.length > policy.maxFiles) {
    throw new TransferError(`manifest exceeds the file-count bound (${policy.maxFiles})`);
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  const files: TreeManifestEntry[] = manifest.files.map((entry: unknown, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TransferError(`manifest entry ${index} is not an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.kind !== 'file' && candidate.kind !== 'symlink') {
      throw new TransferError(`manifest entry ${index} has no valid kind`);
    }
    const validatedPath = validateRelativePath(String(candidate.path ?? ''));
    if (candidate.path !== validatedPath) {
      throw new TransferError(
        `manifest path is not normalized: ${String(candidate.path).slice(0, 80)}`,
      );
    }
    if (seen.has(validatedPath)) {
      throw new TransferError(`duplicate manifest entry: ${validatedPath.slice(0, 80)}`);
    }
    seen.add(validatedPath);
    const size = candidate.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new TransferError(`invalid size for ${validatedPath.slice(0, 80)}`);
    }
    if (size > policy.maxFileBytes) {
      throw new TransferError(
        `file exceeds the per-file bound (${policy.maxFileBytes}): ${validatedPath.slice(0, 80)}`,
      );
    }
    totalBytes += size;
    if (totalBytes > policy.maxTotalBytes) {
      throw new TransferError(`manifest exceeds the total byte bound (${policy.maxTotalBytes})`);
    }
    if (typeof candidate.sha256 !== 'string' || !HASH_RE.test(candidate.sha256)) {
      throw new TransferError(`invalid content hash for ${validatedPath.slice(0, 80)}`);
    }
    if (candidate.kind === 'symlink') {
      if (candidate.mode !== '120000') {
        throw new TransferError(`unsupported mode for ${validatedPath.slice(0, 80)}`);
      }
      if (typeof candidate.target !== 'string') {
        throw new TransferError(`symbolic link target is missing: ${validatedPath.slice(0, 80)}`);
      }
      const target = validateLinkTarget(candidate.target, validatedPath);
      const bytes = Buffer.from(target, 'utf8');
      if (size !== bytes.length) {
        throw new TransferError(`invalid size for ${validatedPath.slice(0, 80)}`);
      }
      if (candidate.sha256 !== sha256Of(bytes)) {
        throw new TransferError(`invalid content hash for ${validatedPath.slice(0, 80)}`);
      }
      return {
        kind: 'symlink',
        path: validatedPath,
        mode: '120000',
        target,
        size,
        sha256: candidate.sha256,
      };
    }
    if (candidate.mode !== '100644' && candidate.mode !== '100755') {
      throw new TransferError(`unsupported mode for ${validatedPath.slice(0, 80)}`);
    }
    return {
      kind: 'file',
      path: validatedPath,
      mode: candidate.mode,
      size,
      sha256: candidate.sha256,
    };
  });
  assertNoLeafAncestors(
    files.map((entry) => entry.path),
    'manifest entries',
  );
  assertTreeLinks(
    manifestTreeLookup(files),
    files.filter((entry) => entry.kind === 'symlink').map((entry) => entry.path),
  );
  if (typeof manifest.totalBytes !== 'number' || manifest.totalBytes !== totalBytes) {
    throw new TransferError('manifest totalBytes does not match its entries');
  }
  return { version: TREE_TRANSFER_VERSION, root: manifest.root, files, totalBytes };
}

// --- Stream ----------------------------------------------------------------

/**
 * Encodes a tree as a framed stream (manifest line, raw bodies of the
 * regular files in manifest order, completion line). Reads happen through
 * bounded chunks without following links; each file is re-hashed while
 * streaming and each link's target re-read, and any drift (content, type
 * or target) fails the stream immediately.
 */
export async function* encodeTreeStream(
  manifest: TreeManifest,
  rootDir: string,
): AsyncGenerator<Uint8Array> {
  yield Buffer.from(`${canonicalManifestJson(manifest)}\n`, 'utf8');
  const buffer = Buffer.alloc(1024 * 1024);
  let runningTotal = 0;
  for (const entry of manifest.files) {
    const full = path.join(rootDir, entry.path);
    const changed = () =>
      new TransferError(`file changed while streaming: ${entry.path.slice(0, 80)}`);
    if (entry.kind === 'symlink') {
      let target: Buffer;
      try {
        target = fs.readlinkSync(full, { encoding: 'buffer' });
      } catch {
        throw changed();
      }
      if (!target.equals(Buffer.from(entry.target, 'utf8'))) throw changed();
      continue;
    }
    const hash = createHash('sha256');
    let sent = 0;
    let fd: number;
    try {
      fd = fs.openSync(full, NOFOLLOW_READ);
    } catch {
      throw changed();
    }
    try {
      if (!fs.fstatSync(fd).isFile()) throw changed();
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        hash.update(read === buffer.length ? buffer : buffer.subarray(0, read));
        sent += read;
        runningTotal += read;
        if (runningTotal > manifest.totalBytes) {
          throw new TransferError('stream exceeds the manifest byte budget');
        }
        // Yield a copy: the read buffer is reused, and a slow consumer must
        // never observe it overwritten (bounded memory; GC reclaims quickly).
        yield Buffer.from(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    if (sent !== entry.size || hash.digest('hex') !== entry.sha256) throw changed();
  }
  yield Buffer.from('{"complete":true}\n', 'utf8');
}

const MAX_MANIFEST_LINE_BYTES = 64 * 1024 * 1024;

export interface DecodeResult {
  manifest: TreeManifest;
  /** Body bytes received (all regular files, on success). */
  bytesReceived: number;
}

/**
 * Decodes a framed tree stream into `destDir`, verifying every byte against
 * the manifest while streaming to disk. Regular files are written first
 * (never through a link, at the destination or in any parent), links only after
 * the completion frame. The directory is only usable once this resolves;
 * callers must treat failure as garbage and remove the staging directory
 * (never activate a partial tree).
 */
export async function decodeTreeStream(
  input: AsyncIterable<Uint8Array>,
  destDir: string,
  policy: TransferPolicy,
  expectedRoot?: string,
): Promise<DecodeResult> {
  const decoder = new StreamDecoder(destDir, policy, expectedRoot);
  for await (const chunk of input) {
    decoder.push(Buffer.from(chunk));
  }
  return decoder.finish();
}

/**
 * Creates the parent directories of `relative` below `root`, refusing any
 * existing parent that is not a real directory (a link is never traversed).
 */
export function ensureRealParents(
  root: string,
  relative: string,
  onCreate?: (dir: string) => void,
): void {
  const parts = relative.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat === null) {
      fs.mkdirSync(current, { mode: 0o755 });
      onCreate?.(current);
    } else if (!stat.isDirectory()) {
      throw new TransferError(`unsafe destination parent: ${shown(relative)}`);
    }
  }
}

/** Creates or truncates a regular file; a link at the destination is never followed. */
const NOFOLLOW_WRITE =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;

class StreamDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private manifest: TreeManifest | null = null;
  private regular: TreeFileEntry[] = [];
  private fileIndex = 0;
  private fileBytesRead = 0;
  private fileHash = createHash('sha256');
  private writeFd: number | null = null;
  private totalBytes = 0;
  private complete = false;

  constructor(
    private readonly destDir: string,
    private readonly policy: TransferPolicy,
    private readonly expectedRoot?: string,
  ) {}

  push(chunk: Buffer): void {
    if (this.complete) throw new TransferError('bytes after the completion frame');
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.manifest === null) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline < 0) {
          if (this.buffer.length > MAX_MANIFEST_LINE_BYTES) {
            throw new TransferError('manifest line exceeds the bound');
          }
          return;
        }
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.toString('utf8'));
        } catch {
          throw new TransferError('manifest line is not valid JSON');
        }
        this.manifest = validateTreeManifest(parsed, this.policy, this.expectedRoot);
        this.regular = this.manifest.files.filter(
          (entry): entry is TreeFileEntry => entry.kind === 'file',
        );
        continue;
      }
      if (this.fileIndex >= this.regular.length) {
        // Only the completion frame may remain.
        const newline = this.buffer.indexOf(0x0a);
        if (newline < 0) {
          if (this.buffer.length > 128)
            throw new TransferError('unexpected trailing bytes after file bodies');
          return;
        }
        const line = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        if (line !== '{"complete":true}') {
          throw new TransferError('transfer is missing its completion frame');
        }
        this.complete = true;
        return;
      }
      const file = this.regular[this.fileIndex] as TreeFileEntry;
      if (this.writeFd === null) {
        if (this.buffer.length === 0) return;
        this.openFile(file);
      }
      const remaining = file.size - this.fileBytesRead;
      const take = Math.min(remaining, this.buffer.length);
      if (take > 0) {
        const piece = this.buffer.subarray(0, take);
        fs.writeSync(this.writeFd as number, piece);
        this.fileHash.update(piece);
        this.fileBytesRead += take;
        this.totalBytes += take;
        if (this.totalBytes > this.policy.maxTotalBytes) {
          throw new TransferError(
            `stream exceeds the total byte bound (${this.policy.maxTotalBytes})`,
          );
        }
        this.buffer = this.buffer.subarray(take);
      }
      if (this.fileBytesRead === file.size) {
        const actual = this.fileHash.digest('hex');
        if (actual !== file.sha256) {
          throw new TransferError(`content hash mismatch for ${file.path.slice(0, 80)}`);
        }
        this.closeFile(file);
        this.fileIndex += 1;
        this.fileBytesRead = 0;
        this.fileHash = createHash('sha256');
      }
      if (this.buffer.length === 0) return;
    }
  }

  private openFile(file: TreeFileEntry): void {
    fs.mkdirSync(this.destDir, { recursive: true });
    ensureRealParents(this.destDir, file.path);
    // Restrictive write mode; the declared executable bit is applied only
    // after the file's bytes are fully verified.
    try {
      this.writeFd = fs.openSync(path.join(this.destDir, file.path), NOFOLLOW_WRITE, 0o600);
    } catch {
      throw new TransferError(`unsafe destination: ${shown(file.path)}`);
    }
  }

  private closeFile(file: TreeFileEntry): void {
    if (this.writeFd !== null) {
      if (file.mode === '100755') fs.fchmodSync(this.writeFd, 0o755);
      fs.closeSync(this.writeFd);
      this.writeFd = null;
    }
  }

  finish(): DecodeResult {
    if (!this.complete || this.manifest === null) {
      throw new TransferError('transfer ended before the completion frame');
    }
    if (this.fileIndex !== this.regular.length) {
      throw new TransferError('transfer ended before all manifest files arrived');
    }
    // Links last: no regular file is ever written below or through one.
    for (const entry of this.manifest.files) {
      if (entry.kind !== 'symlink') continue;
      fs.mkdirSync(this.destDir, { recursive: true });
      ensureRealParents(this.destDir, entry.path);
      try {
        fs.symlinkSync(entry.target, path.join(this.destDir, entry.path));
      } catch {
        throw new TransferError(`unsafe destination: ${shown(entry.path)}`);
      }
    }
    return { manifest: this.manifest, bytesReceived: this.totalBytes };
  }
}

// --- Executor changes ------------------------------------------------------

/** One changed entry returned by the executor: a regular file or a link. */
export type WorkChangedEntry =
  | { kind: 'file'; path: string; mode: RegularMode; contentB64: string }
  | { kind: 'symlink'; path: string; mode: LinkMode; target: string };

/** Changes the executor returns for one command (strict union, both sides). */
export interface WorkChanges {
  files: WorkChangedEntry[];
  deleted: string[];
  /** False when the changes cannot be returned (nothing is returned then). */
  complete: boolean;
  /** Paths that changed but were not returned (bounded list, only when incomplete). */
  omitted: string[];
  /** Why an incomplete change set was not returned (path-specific); null when complete. */
  reason: string | null;
}

export interface WorkChangeBounds {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Deleted paths (manifest entries); default `maxFiles`. */
  maxDeleted?: number;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key)))
    throw new TransferError(`${what} has unexpected fields`);
}

function changePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new TransferError('changed path must be a string');
  if (validateRelativePath(raw) !== raw)
    throw new TransferError(`changed path is not normalized: ${raw.slice(0, 80)}`);
  return raw;
}

/**
 * Strict validation of an executor change set: exactly the union
 * above, normalized paths, no duplicates, no entry below another entry, no
 * path both changed and deleted, valid base64 and link targets, and every
 * bound (link targets count as bytes).
 */
export function validateWorkChanges(parsed: unknown, bounds: WorkChangeBounds): WorkChanges {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TransferError('changes are not an object');
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ['files', 'deleted', 'complete', 'omitted', 'reason'], 'changes');
  if (typeof value.complete !== 'boolean') throw new TransferError('changes.complete is invalid');
  if (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length > 1000))
    throw new TransferError('changes.reason is invalid');
  if (
    !Array.isArray(value.omitted) ||
    value.omitted.length > 50 ||
    !value.omitted.every((entry) => typeof entry === 'string' && entry.length <= 1024)
  )
    throw new TransferError('changes.omitted is invalid');
  if (!Array.isArray(value.files) || !Array.isArray(value.deleted))
    throw new TransferError('changes.files and changes.deleted must be arrays');
  if (!value.complete) {
    if (value.files.length > 0 || value.deleted.length > 0)
      throw new TransferError('incomplete changes carry entries');
    return {
      files: [],
      deleted: [],
      complete: false,
      omitted: value.omitted as string[],
      reason: (value.reason as string | null) ?? 'changes could not be returned',
    };
  }
  if (value.reason !== null) throw new TransferError('complete changes carry a reason');
  if (value.files.length > bounds.maxFiles)
    throw new TransferError(`changes exceed the file-count bound (${bounds.maxFiles})`);
  if (value.deleted.length > (bounds.maxDeleted ?? bounds.maxFiles))
    throw new TransferError('changes exceed the deletion bound');
  const seen = new Set<string>();
  let total = 0;
  const files: WorkChangedEntry[] = value.files.map((raw: unknown) => {
    if (raw === null || typeof raw !== 'object')
      throw new TransferError('changed entry is not an object');
    const entry = raw as Record<string, unknown>;
    const entryPath = changePath(entry.path);
    if (seen.has(entryPath)) throw new TransferError(`duplicate changed path: ${shown(entryPath)}`);
    seen.add(entryPath);
    let size: number;
    let result: WorkChangedEntry;
    if (entry.kind === 'symlink') {
      exactKeys(entry, ['kind', 'path', 'mode', 'target'], 'changed link');
      if (entry.mode !== '120000' || typeof entry.target !== 'string')
        throw new TransferError(`invalid changed link: ${shown(entryPath)}`);
      const target = validateLinkTarget(entry.target, entryPath);
      size = Buffer.byteLength(target);
      result = { kind: 'symlink', path: entryPath, mode: '120000', target };
    } else if (entry.kind === 'file') {
      exactKeys(entry, ['kind', 'path', 'mode', 'contentB64'], 'changed file');
      if (
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        typeof entry.contentB64 !== 'string' ||
        !BASE64_RE.test(entry.contentB64)
      )
        throw new TransferError(`invalid changed file: ${shown(entryPath)}`);
      const padding = entry.contentB64.endsWith('==') ? 2 : entry.contentB64.endsWith('=') ? 1 : 0;
      size = (entry.contentB64.length / 4) * 3 - padding;
      result = { kind: 'file', path: entryPath, mode: entry.mode, contentB64: entry.contentB64 };
    } else {
      throw new TransferError('changed entry has no valid kind');
    }
    if (size > bounds.maxFileBytes)
      throw new TransferError(`changed entry exceeds the per-file bound: ${shown(entryPath)}`);
    total += size;
    if (total > bounds.maxTotalBytes)
      throw new TransferError(`changes exceed the total byte bound (${bounds.maxTotalBytes})`);
    return result;
  });
  assertNoLeafAncestors(
    files.map((entry) => entry.path),
    'changed entries',
  );
  const deleted = value.deleted.map((raw: unknown) => {
    const entryPath = changePath(raw);
    if (seen.has(entryPath))
      throw new TransferError(`path both changed and deleted: ${shown(entryPath)}`);
    seen.add(entryPath);
    return entryPath;
  });
  return { files, deleted, complete: true, omitted: [], reason: null };
}
