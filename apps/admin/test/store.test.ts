import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminStore } from '../src/store.js';

const KEY = Buffer.alloc(32, 7);

describe('admin store startup', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('recompiles a stored document the current code compiles differently, once', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'admin.sqlite');
    const first = await AdminStore.open({ path: file }, KEY);
    const initial = (await first.currentDocument())!;
    // Simulate a document compiled by an older admin version (a grant the
    // current compiler no longer emits).
    const stale = structuredClone(initial);
    stale.authorizationPolicy = { ...stale.authorizationPolicy, legacyField: 'older admin' };
    await first.run(
      'UPDATE config_versions SET compiled_json = ? WHERE version = ?',
      JSON.stringify(stale),
      initial.version,
    );
    await first.close();

    const second = await AdminStore.open({ path: file }, KEY);
    const recompiled = (await second.currentDocument())!;
    expect(recompiled.version).toBe(initial.version + 1);
    expect(recompiled.authorizationPolicy).not.toHaveProperty('legacyField');
    expect((await second.listAudit(10)).map((row) => row.action)).toContain('config.recompile');
    await second.close();

    // An unchanged compilation adds no version on the next start.
    const third = await AdminStore.open({ path: file }, KEY);
    expect((await third.currentDocument())!.version).toBe(recompiled.version);
    await third.close();
  });
  it('recompiles a stored document carrying a section the current code removed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'admin.sqlite');
    const first = await AdminStore.open({ path: file }, KEY);
    const initial = (await first.currentDocument())!;
    // An older admin compiled a section (here the retired feedbackIssues)
    // that the content hash of the current code does not cover.
    await first.run(
      'UPDATE config_versions SET compiled_json = ? WHERE version = ?',
      JSON.stringify({ ...initial, feedbackIssues: null }),
      initial.version,
    );
    await first.close();

    const second = await AdminStore.open({ path: file }, KEY);
    const recompiled = (await second.currentDocument())!;
    expect(recompiled.version).toBe(initial.version + 1);
    expect(recompiled).not.toHaveProperty('feedbackIssues');
    await second.close();
  });
});

describe('admin store channel blocklist', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const configure = async (store: AdminStore): Promise<void> => {
    await store.saveInstallation('test', {
      teamId: 'T0TEAM1',
      teamName: 'Team',
      botUserId: 'U0BOT',
      botId: 'B0BOT',
      botToken: 'xoxb-test',
      scopes: '',
    });
    await store.updateInstallation('test', 'T0TEAM1', { status: 'whitelisted' });
    await store.setChannel('test', {
      teamId: 'T0TEAM1',
      channelId: 'C0CHAN1',
      name: 'general',
      isPrivate: false,
      botMember: true,
      enabled: true,
    });
  };

  it('leaves an old channel_users table behind: its people are neither read nor bound', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'admin.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE channel_users (
      team_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL, PRIMARY KEY (team_id, channel_id, user_id));
      INSERT INTO channel_users VALUES ('T0TEAM1', 'C0CHAN1', 'U0OLD', 'Old', 0);`);
    old.close();

    const store = await AdminStore.open({ path: file }, KEY);
    await configure(store);
    expect(await store.listBlockedMembers()).toEqual([]);
    const empty = (await store.currentDocument())!.authorizationPolicy as { bindings: unknown[] };
    expect(empty.bindings).toEqual([
      { workspace: 'T0TEAM1', channels: ['C0CHAN1'], users: ['*'], roles: ['user'] },
    ]);
    await store.blockMember('test', {
      teamId: 'T0TEAM1',
      channelId: 'C0CHAN1',
      userId: 'U0NEW',
      displayName: 'New',
    });
    const policy = (await store.currentDocument())!.authorizationPolicy;
    expect(policy.bindings).toEqual([
      { workspace: 'T0TEAM1', channels: ['C0CHAN1'], users: ['*'], roles: ['user'] },
    ]);
    expect(JSON.stringify(policy)).not.toContain('U0OLD');
    expect(await store.all('SELECT user_id FROM channel_users')).toEqual([{ user_id: 'U0OLD' }]);
    const version = (await store.currentDocument())!.version;
    await store.close();
    const reopened = await AdminStore.open({ path: file }, KEY);
    expect((await reopened.listBlockedMembers()).map((row) => row.userId)).toEqual(['U0NEW']);
    expect((await reopened.currentDocument())!.version).toBe(version);
    await reopened.close();
  });

  it('keeps repeated block/unblock content idempotent and rolls back an oversized mutation', async () => {
    const store = await AdminStore.open({ path: ':memory:' }, KEY);
    await configure(store);
    const identity = {
      teamId: 'T0TEAM1',
      channelId: 'C0CHAN1',
      userId: 'WEXTERNAL',
      displayName: '',
    };
    const blocked = await store.blockMember('test', identity);
    expect((await store.blockMember('test', identity)).version).toBe(blocked.version);
    const unblocked = await store.unblockMember('test', identity);
    expect((await store.unblockMember('test', identity)).version).toBe(unblocked.version);
    // Fill synthetic rows directly to reach the parser's explicit count boundary.
    for (let i = 0; i < 1024; i++)
      await store.run(
        'INSERT INTO blocked_members VALUES (?, ?, ?, ?, ?)',
        'T0TEAM1',
        'C0CHAN1',
        `U${i}`,
        '',
        0,
      );
    const before = (await store.currentDocument())!.version;
    await expect(store.blockMember('test', identity)).rejects.toThrow();
    expect(await store.listBlockedMembers()).toHaveLength(1024);
    expect((await store.listBlockedMembers()).some((row) => row.userId === 'WEXTERNAL')).toBe(
      false,
    );
    expect((await store.currentDocument())!.version).toBe(before);
    await store.close();
  });

  it('refuses people for an unknown channel and removes them on workspace removal', async () => {
    const store = await AdminStore.open({ path: ':memory:' }, KEY);
    await configure(store);
    await expect(
      store.blockMember('test', {
        teamId: 'T0TEAM1',
        channelId: 'C0UNKNOWN',
        userId: 'U0ALICE',
        displayName: '',
      }),
    ).rejects.toThrow(/before blocking members/);
    await store.blockMember('test', {
      teamId: 'T0TEAM1',
      channelId: 'C0CHAN1',
      userId: 'U0ALICE',
      displayName: '',
    });
    // A fresh store has no members table; removal touches blocked_members only.
    await store.deleteInstallation('test', 'T0TEAM1');
    expect(await store.listBlockedMembers()).toEqual([]);
    await store.close();
  });
});

/** the realtime hooks fire after the change, for the right scope. */
describe('admin store realtime hooks', () => {
  it('reports committed topics and session revocations after the change', async () => {
    const store = await AdminStore.open({ path: ':memory:' }, Buffer.alloc(32, 7));
    const topics: string[][] = [];
    const revoked: Array<{ sessionId?: string; adminId?: number }> = [];
    store.onCommitted = (t) => topics.push(t);
    store.onSessionsRevoked = (scope) => revoked.push(scope);
    await store.createAdmin('cli', 'alice', 'hash');
    const admin = (await store.adminByName('alice'))!;
    await store.createSession('sess-1', admin.id, 'csrf', Date.now() + 60_000);
    topics.length = 0;
    await store.transaction(async () => {
      await store.audit('alice', 'admin.login', 'alice');
      expect(topics).toEqual([]);
    });
    expect(topics).toEqual([['audit']]);
    await store.deleteSession('sess-1');
    await store.setAdminPassword('cli', 'alice', 'new-hash');
    await store.setAdminDisabled('cli', admin.id, true);
    await Promise.resolve();
    expect(revoked).toEqual([
      { sessionId: 'sess-1' },
      { adminId: admin.id },
      { adminId: admin.id },
    ]);
    await store.close();
  });
});

describe('admin store GitLab hosts', () => {
  it('accepts a bare host and refuses a port, which the egress proxy cannot reach', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-store-'));
    try {
      const store = await AdminStore.open({ path: path.join(dir, 'admin.sqlite') }, KEY);
      await store.recordSeen('T0TEAM1');
      const { instance } = await store.createToolInstance('test', 'T0TEAM1', {
        kind: 'gitlab',
        label: 'GitLab',
        host: 'gitlab.example.com',
      });
      expect(instance.host).toBe('gitlab.example.com');
      for (const host of ['gitlab.example.com:8443', 'https://gitlab.example.com'])
        await expect(
          store.createToolInstance('test', 'T0TEAM1', { kind: 'gitlab', label: 'GitLab', host }),
        ).rejects.toThrow('host must be');
      await expect(
        store.updateToolInstance('test', instance.id, { host: 'gitlab.example.com:8443' }),
      ).rejects.toThrow('no port');
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
