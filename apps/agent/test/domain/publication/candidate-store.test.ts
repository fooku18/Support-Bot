import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTreeManifest, manifestDigest } from '../../../src/domain/publication/transfer.js';
import {
  captureCandidate,
  dropCandidates,
} from '../../../src/domain/publication/candidate-store.js';
const policy = { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 10000 };
const withRoot = async (body: (root: string, checkout: string) => Promise<void>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-'));
  try {
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    await body(root, checkout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
const capture = async (root: string, checkout: string, content: string, scope = 'fixture') => {
  fs.writeFileSync(path.join(checkout, 'file'), content);
  const manifest = buildTreeManifest(checkout, policy);
  const digest = manifestDigest(manifest);
  return { digest, ...(await captureCandidate(root, checkout, manifest, policy, digest, scope)) };
};
it('retains verified A after checkout changes to B', async () => {
  await withRoot(async (root, checkout) => {
    const saved = await capture(root, checkout, 'verified A');
    fs.writeFileSync(path.join(checkout, 'file'), 'unverified B');
    expect(fs.readFileSync(path.join(saved.directory, 'file'), 'utf8')).toBe('verified A');
    // Capturing the same digest again reuses the retained copy.
    const inode = fs.statSync(path.join(saved.directory, 'file')).ino;
    const again = await captureCandidate(
      root,
      checkout,
      saved.manifest,
      policy,
      saved.digest,
      'fixture',
    );
    expect(fs.statSync(path.join(again.directory, 'file')).ino).toBe(inode);
    expect(fs.readFileSync(path.join(again.directory, 'file'), 'utf8')).toBe('verified A');
  });
});
it('never reuses a retained copy whose bytes changed, and refuses a checkout that no longer matches', async () => {
  await withRoot(async (root, checkout) => {
    const saved = await capture(root, checkout, 'verified');
    fs.writeFileSync(path.join(saved.directory, 'file'), 'tampered');
    // The tampered copy is replaced by a fresh capture of the (unchanged) checkout.
    const fresh = await captureCandidate(
      root,
      checkout,
      saved.manifest,
      policy,
      saved.digest,
      'fixture',
    );
    expect(fs.readFileSync(path.join(fresh.directory, 'file'), 'utf8')).toBe('verified');
    // With the copy gone and the checkout changed, nothing matches the digest.
    fs.rmSync(fresh.directory, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'file'), 'changed');
    await expect(
      captureCandidate(root, checkout, saved.manifest, policy, saved.digest, 'fixture'),
    ).rejects.toThrow('candidate changed during capture');
    await expect(
      captureCandidate(root, checkout, saved.manifest, policy, 'f'.repeat(64), 'fixture'),
    ).rejects.toThrow('invalid candidate identity');
  });
});
it('drops every candidate of a scope except the kept one, never another scope', async () => {
  await withRoot(async (root, checkout) => {
    const first = (await capture(root, checkout, 'one', 'project-1')).digest;
    const second = (await capture(root, checkout, 'two', 'project-1')).digest;
    await capture(root, checkout, 'three', 'project-2');
    const store = path.join(root, 'verified-snapshots', 'project-1');
    fs.mkdirSync(path.join(store, '.candidate-interrupted'));
    await dropCandidates(root, 'project-1', second);
    expect(fs.readdirSync(store).sort()).toEqual([second, `${second}.json`].sort());
    expect(fs.existsSync(path.join(store, first))).toBe(false);
    await dropCandidates(root, 'project-1');
    expect(fs.readdirSync(store)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'verified-snapshots', 'project-2'))).toHaveLength(2);
    await expect(dropCandidates(root, '../escape')).rejects.toThrow('invalid candidate scope');
  });
});
it('captures committed links as links and revalidates them before reuse', async () => {
  await withRoot(async (root, checkout) => {
    fs.mkdirSync(path.join(checkout, 'docs'));
    fs.writeFileSync(path.join(checkout, 'docs', 'guide.md'), 'guide');
    fs.symlinkSync('docs/guide.md', path.join(checkout, 'GUIDE'));
    fs.symlinkSync('missing', path.join(checkout, 'dangling'));
    const manifest = buildTreeManifest(checkout, policy);
    const digest = manifestDigest(manifest);
    const saved = await captureCandidate(root, checkout, manifest, policy, digest, 'fixture');
    expect(fs.lstatSync(path.join(saved.directory, 'GUIDE')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(saved.directory, 'GUIDE'))).toBe('docs/guide.md');
    expect(fs.readlinkSync(path.join(saved.directory, 'dangling'))).toBe('missing');
    // A retained copy whose link was retargeted is never reused.
    fs.rmSync(path.join(saved.directory, 'GUIDE'));
    fs.symlinkSync('docs', path.join(saved.directory, 'GUIDE'));
    const fresh = await captureCandidate(root, checkout, manifest, policy, digest, 'fixture');
    expect(fs.readlinkSync(path.join(fresh.directory, 'GUIDE'))).toBe('docs/guide.md');
    // A retained manifest with an escaping link is not reused either.
    const store = path.join(root, 'verified-snapshots', 'fixture');
    const recorded = JSON.parse(fs.readFileSync(path.join(store, `${digest}.json`), 'utf8'));
    expect(recorded.files).toContainEqual(
      expect.objectContaining({ kind: 'symlink', path: 'GUIDE' }),
    );
    // A checkout whose link changed after the manifest is refused.
    fs.rmSync(fresh.directory, { recursive: true });
    fs.rmSync(path.join(checkout, 'GUIDE'));
    fs.symlinkSync('docs', path.join(checkout, 'GUIDE'));
    await expect(
      captureCandidate(root, checkout, manifest, policy, digest, 'fixture'),
    ).rejects.toThrow(/changed/);
  });
});
