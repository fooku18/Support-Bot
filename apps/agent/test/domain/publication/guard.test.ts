import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWithin,
  isWithin,
  assertCommandAllowed,
  assertRepoEnvIsolated,
  buildRepoEnv,
  ContainmentError,
} from '../../../src/domain/publication/guard.js';

describe('workspace containment', () => {
  let root: string;
  let other: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-root-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-other-'));
    fs.writeFileSync(path.join(root, 'greet.js'), 'hi');
    fs.writeFileSync(path.join(other, 'secret.txt'), 'other-task-data');
  });

  afterEach(() => {
    if (process.env.SUPPORT_AGENT_TEST_RETAIN_EVIDENCE === '1') return;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('resolves contained paths', () => {
    expect(resolveWithin(root, 'greet.js')).toBe(path.join(fs.realpathSync(root), 'greet.js'));
    expect(isWithin(root, 'sub/new.txt')).toBe(true);
  });

  it('resolves contained names beginning with two dots', () => {
    fs.mkdirSync(path.join(root, '..notes'));
    fs.writeFileSync(path.join(root, '..notes', 'draft.md'), 'draft');
    for (const relative of ['..notes', '..notes/draft.md']) {
      const expected = path.join(fs.realpathSync(root), relative);
      expect(resolveWithin(root, relative)).toBe(expected);
      expect(resolveWithin(root, path.join(root, relative))).toBe(expected);
    }
  });

  it('denies traversal escapes', () => {
    expect(() => resolveWithin(root, '..')).toThrow(ContainmentError);
    expect(() => resolveWithin(root, '../')).toThrow(ContainmentError);
    expect(() => resolveWithin(root, '../escape.txt')).toThrow(ContainmentError);
    expect(() => resolveWithin(root, 'sub/../../escape.txt')).toThrow(ContainmentError);
    expect(isWithin(root, '../../etc/passwd')).toBe(false);
  });

  it('denies absolute escapes', () => {
    expect(() => resolveWithin(root, '/etc/passwd')).toThrow(ContainmentError);
    expect(() => resolveWithin(root, other)).toThrow(ContainmentError);
  });

  it('denial messages carry a workspace-relative recovery instruction', () => {
    for (const attempt of ['/etc/passwd', '../escape.txt', 'sub/../../escape.txt']) {
      try {
        resolveWithin(root, attempt);
        expect.unreachable(attempt);
      } catch (err) {
        expect(err).toBeInstanceOf(ContainmentError);
        expect((err as Error).message).toMatch(/workspace-relative path/);
      }
    }
  });

  it('denies symlink escapes', () => {
    const link = path.join(root, 'evil-link');
    try {
      fs.symlinkSync(path.join(other, 'secret.txt'), link);
    } catch {
      return; // symlink creation unavailable; skip
    }
    expect(() => resolveWithin(root, 'evil-link')).toThrow(ContainmentError);
  });

  it('denies other-task paths', () => {
    const sibling = path.dirname(root);
    expect(() => resolveWithin(root, path.relative(root, path.join(other, 'secret.txt')))).toThrow(
      ContainmentError,
    );
    void sibling;
  });
});

/**
 * native admission resolves links component by component (lstat,
 * no lexical `..` normalization first) within the checkout the path belongs
 * to; a dangling link that would escape is refused like an existing one.
 */
describe('admission through symlinks', () => {
  let ws: string;
  let other: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-links-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-links-other-'));
    fs.mkdirSync(path.join(ws, 'group__app', 'apps', 'shop', 'docs'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'group__app', 'docs', 'apps'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'group__app', '.git'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'group__lib'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'group__lib', 'secret.txt'), 'lib');
    fs.symlinkSync('../../apps/shop/docs', path.join(ws, 'group__app', 'docs', 'apps', 'shop'));
  });
  afterEach(() => {
    if (process.env.SUPPORT_AGENT_TEST_RETAIN_EVIDENCE === '1') return;
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const real = (relative: string) => path.join(fs.realpathSync(ws), relative);
  const within = (relative: string) => resolveWithin(ws, relative, { perCheckout: true });

  it('admits edits through an in-checkout link to its destination', () => {
    expect(within('group__app/docs/apps/shop/new.md')).toBe(
      real('group__app/apps/shop/docs/new.md'),
    );
    expect(within(path.join(ws, 'group__app/docs/apps/shop'))).toBe(
      real('group__app/apps/shop/docs'),
    );
  });

  it('refuses a dangling link that would escape (formerly admitted)', () => {
    fs.symlinkSync(path.join(other, 'not-yet-there.txt'), path.join(ws, 'group__app', 'dangle'));
    expect(() => within('group__app/dangle')).toThrow(ContainmentError);
    expect(() => resolveWithin(ws, 'group__app/dangle')).toThrow(ContainmentError);
    fs.symlinkSync('../../../nowhere/x', path.join(ws, 'group__app', 'rel-dangle'));
    expect(() => within('group__app/rel-dangle')).toThrow(
      /symbolic link target outside the tree: group__app\/rel-dangle/,
    );
  });

  it('refuses links that leave their checkout or enter Git control data', () => {
    fs.symlinkSync('../group__lib/secret.txt', path.join(ws, 'group__app', 'peek'));
    expect(() => within('group__app/peek')).toThrow(ContainmentError);
    fs.symlinkSync('.git', path.join(ws, 'group__app', 'gitdir'));
    expect(() => within('group__app/gitdir/config')).toThrow(ContainmentError);
  });

  it('expands links before `..` (no lexical normalization)', () => {
    fs.mkdirSync(path.join(ws, 'group__app', 'deep', 'er'), { recursive: true });
    fs.symlinkSync('deep/er', path.join(ws, 'group__app', 'two'));
    // two/.. is group__app/deep, not group__app.
    expect(within('group__app/two/../f.txt')).toBe(real('group__app/deep/f.txt'));
    // Lexically group__app/a/b/x; through `up` (-> group__app) it leaves the workspace.
    fs.mkdirSync(path.join(ws, 'group__app', 'a', 'b', 'c'), { recursive: true });
    fs.symlinkSync('../../..', path.join(ws, 'group__app', 'a', 'b', 'c', 'up'));
    expect(within('group__app/a/b/c/up/x')).toBe(real('group__app/x'));
    expect(() => within('group__app/a/b/c/up/../../x')).toThrow(ContainmentError);
  });
});

describe('command allowlist', () => {
  it('allows exactly the configured test command', () => {
    expect(assertCommandAllowed('npm test --silent', 'npm test --silent')).toEqual([
      'npm',
      'test',
      '--silent',
    ]);
  });

  it('denies extra flags, pipes, and other commands', () => {
    for (const attempt of [
      'npm test',
      'npm test --silent --extra',
      'npm test --silent | tee out',
      'npm test --silent; rm -rf /',
      'curl https://example.com',
      'git push',
      '',
    ]) {
      expect(() => assertCommandAllowed('npm test --silent', attempt), attempt).toThrow(
        ContainmentError,
      );
    }
  });
});

describe('repository environment isolation', () => {
  it('builds a minimal env without credentials', () => {
    process.env.SUPPORT_AGENT_SERVICE_TOKEN = 'parent-must-not-leak';
    process.env.AI_GATEWAY_API_KEYS = 'sk-parent-must-not-leak';
    try {
      const env = buildRepoEnv({ pathValue: '/usr/bin:/bin', homeDir: '/tmp/home' });
      expect(env.SUPPORT_AGENT_SERVICE_TOKEN).toBeUndefined();
      expect(env.AI_GATEWAY_API_KEYS).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.SLACK_BOT_TOKEN).toBeUndefined();
      expect(env.NODE_DISABLE_COMPILE_CACHE).toBe('1');
      expect(() =>
        assertRepoEnvIsolated({ ...env, SUPPORT_AGENT_SERVICE_TOKEN: 'leaked' }),
      ).toThrow(ContainmentError);
      expect(() => assertRepoEnvIsolated({ ...env, ANTHROPIC_API_KEY: 'leaked' })).toThrow(
        ContainmentError,
      );
    } finally {
      delete process.env.SUPPORT_AGENT_SERVICE_TOKEN;
      delete process.env.AI_GATEWAY_API_KEYS;
    }
  });
});
