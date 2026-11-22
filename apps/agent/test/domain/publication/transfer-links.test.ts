/**
 * committed symlinks in transferred trees. The manifest is a union
 * of regular files and links (exact target bytes), every link is resolved
 * component by component against the tree it belongs to (≤ 40 expansions,
 * never outside the unit root or into `.git`, dangling-but-contained
 * allowed), and the v2 stream carries link targets in its header and writes
 * links only after every regular file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  MAX_LINK_TARGET_BYTES,
  TREE_MEDIA_TYPE,
  TREE_TRANSFER_VERSION,
  TransferError,
  buildTreeManifest,
  buildTreeManifestAsync,
  canonicalManifestJson,
  decodeTreeStream,
  encodeTreeStream,
  fsTreeLookup,
  manifestDigest,
  manifestTreeLookup,
  resolveTreeLink,
  validateLinkTarget,
  validateTreeManifest,
  validateWorkChanges,
  type TreeManifestEntry,
} from '../../../src/domain/publication/transfer.js';

const policy = { maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function link(target: string, entryPath: string): TreeManifestEntry {
  return {
    kind: 'symlink',
    path: entryPath,
    mode: '120000',
    target,
    size: Buffer.byteLength(target),
    sha256: sha(target),
  };
}

function file(entryPath: string, content = 'x'): TreeManifestEntry {
  return {
    kind: 'file',
    path: entryPath,
    mode: '100644',
    size: Buffer.byteLength(content),
    sha256: sha(content),
  };
}

function manifestOf(files: TreeManifestEntry[]): Record<string, unknown> {
  return {
    version: TREE_TRANSFER_VERSION,
    root: 'checkout',
    files,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return chunks;
}

describe('transfer v2', () => {
  it('pins the protocol version and media type', () => {
    expect(TREE_TRANSFER_VERSION).toBe(2);
    expect(TREE_MEDIA_TYPE).toBe('application/x-support-agent-tree-v2');
    expect(MAX_LINK_TARGET_BYTES).toBe(1024);
  });

  it('refuses a v1 manifest', () => {
    expect(() =>
      validateTreeManifest({ version: 1, root: 'checkout', files: [], totalBytes: 0 }, policy),
    ).toThrow(/unsupported transfer manifest version: 1/);
  });
});

describe('manifest union with committed symlinks', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-links-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records an in-tree link with its exact target bytes (production shape)', async () => {
    // Project 2868: docs/apps/brand-shops -> ../../apps/brand-shops/docs
    fs.mkdirSync(path.join(dir, 'apps', 'brand-shops', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps', 'brand-shops', 'docs', 'index.md'), '# docs\n');
    fs.mkdirSync(path.join(dir, 'docs', 'apps'), { recursive: true });
    fs.symlinkSync('../../apps/brand-shops/docs', path.join(dir, 'docs', 'apps', 'brand-shops'));
    const manifest = buildTreeManifest(dir, policy);
    const entry = manifest.files.find((candidate) => candidate.path === 'docs/apps/brand-shops');
    expect(entry).toEqual(link('../../apps/brand-shops/docs', 'docs/apps/brand-shops'));
    // The link is never followed: the target directory is listed once, by its own path.
    expect(manifest.files.map((candidate) => candidate.path)).toEqual([
      'apps/brand-shops/docs/index.md',
      'docs/apps/brand-shops',
    ]);
    expect(manifest.totalBytes).toBe('# docs\n'.length + '../../apps/brand-shops/docs'.length);
    // Sync and async builders share one entry function.
    expect(await buildTreeManifestAsync(dir, policy)).toEqual(manifest);
    // Canonical serialization binds kind and target.
    const canonical = JSON.parse(canonicalManifestJson(manifest)) as { files: unknown[] };
    expect(canonical.files).toContainEqual({
      kind: 'symlink',
      mode: '120000',
      path: 'docs/apps/brand-shops',
      sha256: sha('../../apps/brand-shops/docs'),
      size: '../../apps/brand-shops/docs'.length,
      target: '../../apps/brand-shops/docs',
    });
    const retargeted = structuredClone(manifest);
    const changed = retargeted.files.find((candidate) => candidate.kind === 'symlink')!;
    if (changed.kind === 'symlink') changed.target = '../../apps/brand-shops/doc';
    expect(manifestDigest(retargeted)).not.toBe(manifestDigest(manifest));
  });

  it('allows a dangling link that stays inside the tree', () => {
    fs.symlinkSync('missing/later.txt', path.join(dir, 'dangling'));
    expect(buildTreeManifest(dir, policy).files).toEqual([link('missing/later.txt', 'dangling')]);
  });

  it('refuses a chained escape that a lexical check of each link misses', () => {
    fs.mkdirSync(path.join(dir, 'a'));
    // a/hop -> ../b stays inside on its own; b -> ../outside escapes.
    fs.symlinkSync('../b', path.join(dir, 'a', 'hop'));
    fs.symlinkSync('../outside', path.join(dir, 'b'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(
      /symbolic link target outside the tree: (a\/hop|b)/,
    );
  });

  it('refuses a link whose target climbs through a link out of the tree', () => {
    fs.mkdirSync(path.join(dir, 'deep', 'er'), { recursive: true });
    fs.symlinkSync('deep/er', path.join(dir, 'two'));
    // two/../../../x: two expands to deep/er, then three levels up leave the tree.
    fs.symlinkSync('two/../../../x', path.join(dir, 'up'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(
      /symbolic link target outside the tree: up/,
    );
  });

  it('refuses link cycles', () => {
    fs.symlinkSync('b', path.join(dir, 'a'));
    fs.symlinkSync('a', path.join(dir, 'b'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(/symbolic link target outside the tree/);
    fs.rmSync(path.join(dir, 'a'));
    fs.rmSync(path.join(dir, 'b'));
    fs.symlinkSync('self', path.join(dir, 'self'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(/symbolic link target outside the tree/);
  });

  it('refuses links into Git control data', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
    fs.symlinkSync('.git/config', path.join(dir, 'cfg'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(
      /symbolic link target outside the tree: cfg/,
    );
    fs.rmSync(path.join(dir, 'cfg'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.symlinkSync('../.GIT', path.join(dir, 'sub', 'g'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(
      /symbolic link target outside the tree: sub\/g/,
    );
  });

  it('refuses absolute, non-UTF-8 and oversize targets', () => {
    fs.symlinkSync('/etc/passwd', path.join(dir, 'abs'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(/abs/);
    fs.rmSync(path.join(dir, 'abs'));
    fs.symlinkSync(Buffer.from([0x66, 0xff, 0xfe]), path.join(dir, 'binary'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(/UTF-8.*binary|binary.*UTF-8/);
    fs.rmSync(path.join(dir, 'binary'));
    fs.symlinkSync('a/'.repeat(600), path.join(dir, 'long'));
    expect(() => buildTreeManifest(dir, policy)).toThrow(/1024/);
  });

  it('validates link targets on their own', () => {
    expect(validateLinkTarget(Buffer.from('../x'), 'p')).toBe('../x');
    expect(validateLinkTarget('ok/target', 'p')).toBe('ok/target');
    expect(() => validateLinkTarget('', 'p')).toThrow(TransferError);
    expect(() => validateLinkTarget('/abs', 'p')).toThrow(/absolute/);
    expect(() => validateLinkTarget('a\0b', 'p')).toThrow(TransferError);
    expect(() => validateLinkTarget('\ud800', 'p')).toThrow(/UTF-8/);
    expect(() => validateLinkTarget(Buffer.from([0xc3, 0x28]), 'p')).toThrow(/UTF-8/);
    expect(() => validateLinkTarget('x'.repeat(1025), 'p')).toThrow(/1024/);
  });

  it('counts link targets against every bound', () => {
    fs.symlinkSync('t'.repeat(40), path.join(dir, 'l1'));
    fs.symlinkSync('u'.repeat(40), path.join(dir, 'l2'));
    expect(() => buildTreeManifest(dir, { ...policy, maxFiles: 1 })).toThrow(/file-count bound/);
    expect(() => buildTreeManifest(dir, { ...policy, maxFileBytes: 39 })).toThrow(/per-file/);
    expect(() => buildTreeManifest(dir, { ...policy, maxTotalBytes: 79 })).toThrow(/total byte/);
    expect(buildTreeManifest(dir, { ...policy, maxTotalBytes: 80 }).totalBytes).toBe(80);
  });

  it('still refuses other special files in transfers and skips them in snapshots', () => {
    fs.writeFileSync(path.join(dir, 'regular'), 'r');
    const fifo = path.join(dir, 'pipe');
    const made = spawnFifo(fifo);
    if (!made) return;
    expect(() => buildTreeManifest(dir, policy)).toThrow(/unsupported file type/);
    expect(
      buildTreeManifest(dir, policy, 'checkout', { skipSpecialFiles: true }).files.map(
        (entry) => entry.path,
      ),
    ).toEqual(['regular']);
  });
});

function spawnFifo(target: string): boolean {
  return spawnSync('mkfifo', [target]).status === 0;
}

describe('manifest validation', () => {
  it('refuses leaf-ancestor conflicts in any order, allows a -> b with b/x', () => {
    for (const files of [
      [file('a'), file('a/x')],
      [file('a/x'), file('a')],
      [link('b', 'a'), file('a/x')],
      [file('a/x/y'), link('b', 'a/x')],
    ]) {
      expect(() => validateTreeManifest(manifestOf(files), policy)).toThrow(
        /conflicting manifest entries/,
      );
    }
    const allowed = validateTreeManifest(manifestOf([link('b', 'a'), file('b/x')]), policy);
    expect(allowed.files.map((entry) => entry.path)).toEqual(['a', 'b/x']);
  });

  it('refuses duplicates, untyped entries and inconsistent link entries', () => {
    expect(() => validateTreeManifest(manifestOf([file('a'), link('b', 'a')]), policy)).toThrow(
      /duplicate manifest entry/,
    );
    const untyped = { path: 'a', mode: '100644', size: 1, sha256: sha('x') };
    expect(() =>
      validateTreeManifest({ ...manifestOf([]), files: [untyped], totalBytes: 1 }, policy),
    ).toThrow(/kind/);
    const wrongSize = { ...link('target', 'l'), size: 3 };
    expect(() =>
      validateTreeManifest({ ...manifestOf([]), files: [wrongSize], totalBytes: 3 }, policy),
    ).toThrow(/l/);
    const wrongHash = { ...link('target', 'l'), sha256: sha('other') };
    expect(() => validateTreeManifest(manifestOf([wrongHash]), policy)).toThrow(/l/);
    const wrongMode = { ...link('target', 'l'), mode: '100644' };
    expect(() =>
      validateTreeManifest(manifestOf([wrongMode as TreeManifestEntry]), policy),
    ).toThrow(/mode/);
    expect(() => validateTreeManifest(manifestOf([link('/etc', 'l')]), policy)).toThrow(/absolute/);
  });

  it('resolves links against the manifest itself', () => {
    expect(() =>
      validateTreeManifest(manifestOf([link('../b', 'a/hop'), link('../outside', 'b')]), policy),
    ).toThrow(/symbolic link target outside the tree/);
    expect(() =>
      validateTreeManifest(manifestOf([link('x', 'y'), link('y', 'x')]), policy),
    ).toThrow(/symbolic link target outside the tree/);
    expect(
      validateTreeManifest(manifestOf([link('../b', 'a/hop'), file('b/c')]), policy).files,
    ).toHaveLength(2);
  });
});

describe('resolveTreeLink', () => {
  const tree = manifestTreeLookup([
    link('../shared', 'docs/link'),
    file('shared/readme'),
    link('deep/er', 'two'),
    file('deep/er/f'),
    link('../../../x', 'deep/er/out'),
  ]);

  it('expands component by component without normalizing first', () => {
    expect(resolveTreeLink(tree, 'docs/link/readme')).toEqual({
      ok: true,
      components: ['shared', 'readme'],
    });
    // two/.. is deep, not the root: no lexical normalization before expansion.
    expect(resolveTreeLink(tree, 'two/../f2')).toEqual({ ok: true, components: ['deep', 'f2'] });
    expect(resolveTreeLink(tree, 'missing/../shared')).toEqual({
      ok: true,
      components: ['shared'],
    });
    expect(resolveTreeLink(tree, 'deep/er/out').ok).toBe(false);
    expect(resolveTreeLink(tree, '../x')).toEqual({ ok: false, reason: 'outside' });
  });

  it('bounds expansions at 40', () => {
    const chain: TreeManifestEntry[] = [];
    for (let i = 0; i < 40; i += 1) chain.push(link(`l${i + 1}`, `l${i}`));
    chain.push(file('l40'));
    expect(resolveTreeLink(manifestTreeLookup(chain), 'l0')).toEqual({
      ok: true,
      components: ['l40'],
    });
    chain.pop();
    chain.push(link('l41', 'l40'), file('l41'));
    expect(resolveTreeLink(manifestTreeLookup(chain), 'l0')).toEqual({ ok: false, reason: 'loop' });
  });

  it('confines expansions to a unit at unitDepth 1 (one checkout)', () => {
    const units = manifestTreeLookup([
      link('../b/secret', 'a/peek'),
      file('b/secret'),
      link('inner', 'a/alias'),
      file('a/inner'),
    ]);
    expect(resolveTreeLink(units, 'a/peek', { unitDepth: 1 }).ok).toBe(false);
    expect(resolveTreeLink(units, 'a/peek').ok).toBe(true);
    expect(resolveTreeLink(units, 'a/alias', { unitDepth: 1 })).toEqual({
      ok: true,
      components: ['a', 'inner'],
    });
    // A plain `..` of the requested path may move between checkouts.
    expect(resolveTreeLink(units, 'a/../b/secret', { unitDepth: 1 })).toEqual({
      ok: true,
      components: ['b', 'secret'],
    });
  });

  it('resolves against the filesystem with lstat only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-fs-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-out-'));
    try {
      fs.mkdirSync(path.join(root, 'd'));
      fs.symlinkSync(outside, path.join(root, 'abs'));
      fs.symlinkSync('../d', path.join(root, 'd', 'up'));
      const lookup = fsTreeLookup(root);
      expect(resolveTreeLink(lookup, 'abs/x')).toEqual({ ok: false, reason: 'absolute' });
      expect(resolveTreeLink(lookup, 'd/up/up/new.txt')).toEqual({
        ok: true,
        components: ['d', 'new.txt'],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('v2 stream with links', () => {
  let src: string;
  let dest: string;
  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-src-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-dest-'));
  });
  afterEach(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('carries targets in the header, no link body, and decodes links as links', async () => {
    fs.mkdirSync(path.join(src, 'lib'));
    fs.writeFileSync(path.join(src, 'lib', 'impl.js'), 'module.exports = 1;\n');
    fs.symlinkSync('lib/impl.js', path.join(src, 'index.js'));
    fs.symlinkSync('lib', path.join(src, 'alias'));
    const manifest = buildTreeManifest(src, policy);
    const chunks = await collect(encodeTreeStream(manifest, src));
    const wire = Buffer.concat(chunks).toString('utf8');
    const [header, ...rest] = wire.split('\n');
    expect(JSON.parse(header!).files).toContainEqual(
      expect.objectContaining({ kind: 'symlink', path: 'index.js', target: 'lib/impl.js' }),
    );
    // Only the regular file's bytes follow the header.
    expect(rest.join('\n')).toBe('module.exports = 1;\n{"complete":true}\n');
    const decoded = await decodeTreeStream(
      (async function* () {
        yield* chunks;
      })(),
      dest,
      policy,
      'checkout',
    );
    expect(manifestDigest(decoded.manifest)).toBe(manifestDigest(manifest));
    expect(fs.lstatSync(path.join(dest, 'index.js')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dest, 'index.js'))).toBe('lib/impl.js');
    expect(fs.readlinkSync(path.join(dest, 'alias'))).toBe('lib');
    expect(fs.readFileSync(path.join(dest, 'lib', 'impl.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
    expect(manifestDigest(buildTreeManifest(dest, policy))).toBe(manifestDigest(manifest));
  });

  it('never writes a regular file through a link in the destination', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-outside-'));
    try {
      fs.mkdirSync(path.join(src, 'd'));
      fs.writeFileSync(path.join(src, 'd', 'x'), 'payload');
      const manifest = buildTreeManifest(src, policy);
      fs.symlinkSync(outside, path.join(dest, 'd'));
      await expect(
        decodeTreeStream(encodeTreeStream(manifest, src), dest, policy, 'checkout'),
      ).rejects.toThrow(TransferError);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails the stream when a link target or file type drifts after the manifest', async () => {
    fs.writeFileSync(path.join(src, 'real'), 'r');
    fs.symlinkSync('real', path.join(src, 'l'));
    const manifest = buildTreeManifest(src, policy);
    fs.rmSync(path.join(src, 'l'));
    fs.symlinkSync('real2', path.join(src, 'l'));
    await expect(collect(encodeTreeStream(manifest, src))).rejects.toThrow(
      /changed while streaming/,
    );
    fs.rmSync(path.join(src, 'l'));
    fs.symlinkSync('real', path.join(src, 'l'));
    const again = buildTreeManifest(src, policy);
    // A regular file swapped for a link is never read through the link.
    fs.rmSync(path.join(src, 'real'));
    fs.writeFileSync(path.join(src, 'elsewhere'), 'r');
    fs.symlinkSync('elsewhere', path.join(src, 'real'));
    await expect(collect(encodeTreeStream(again, src))).rejects.toThrow(TransferError);
  });

  it('refuses a stream whose manifest is v1', async () => {
    const v1 = `${JSON.stringify({ version: 1, root: 'checkout', files: [], totalBytes: 0 })}\n{"complete":true}\n`;
    await expect(
      decodeTreeStream(
        (async function* () {
          yield Buffer.from(v1);
        })(),
        dest,
        policy,
      ),
    ).rejects.toThrow(/version/);
  });
});

describe('WorkChanges union', () => {
  const bounds = { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 200 };
  const base = { files: [], deleted: [], complete: true, omitted: [], reason: null };

  it('accepts files and links and keeps the union exact', () => {
    const parsed = validateWorkChanges(
      {
        ...base,
        files: [
          {
            kind: 'file',
            path: 'a.txt',
            mode: '100644',
            contentB64: Buffer.from('a').toString('base64'),
          },
          { kind: 'symlink', path: 'b', mode: '120000', target: 'a.txt' },
        ],
        deleted: ['c'],
      },
      bounds,
    );
    expect(parsed.files).toEqual([
      { kind: 'file', path: 'a.txt', mode: '100644', contentB64: 'YQ==' },
      { kind: 'symlink', path: 'b', mode: '120000', target: 'a.txt' },
    ]);
    expect(parsed.deleted).toEqual(['c']);
  });

  it('refuses anything outside the union', () => {
    const bad: unknown[] = [
      { ...base, files: [{ path: 'a', mode: '100644', contentB64: '' }] },
      { ...base, files: [{ kind: 'symlink', path: 'a', mode: '120000' }] },
      { ...base, files: [{ kind: 'symlink', path: 'a', mode: '120000', target: '/etc' }] },
      { ...base, files: [{ kind: 'symlink', path: 'a', mode: '100644', target: 'b' }] },
      { ...base, files: [{ kind: 'file', path: '../a', mode: '100644', contentB64: '' }] },
      { ...base, files: [{ kind: 'file', path: 'a', mode: '100644', contentB64: '***' }] },
      { ...base, deleted: ['.git/config'] },
      {
        ...base,
        deleted: ['a'],
        files: [{ kind: 'symlink', path: 'a', mode: '120000', target: 'b' }],
      },
      {
        ...base,
        files: [
          { kind: 'file', path: 'a', mode: '100644', contentB64: '' },
          { kind: 'file', path: 'a/b', mode: '100644', contentB64: '' },
        ],
      },
      {
        ...base,
        complete: false,
        files: [{ kind: 'file', path: 'a', mode: '100644', contentB64: '' }],
      },
      { ...base, complete: 'yes' },
      { ...base, files: [{ kind: 'symlink', path: 'a', mode: '120000', target: 'x'.repeat(201) }] },
      { files: [], deleted: [], complete: true, omitted: [] },
    ];
    for (const value of bad)
      expect(() => validateWorkChanges(value, bounds)).toThrow(TransferError);
  });
});
