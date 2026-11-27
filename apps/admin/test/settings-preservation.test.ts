import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth.js';
import { ChannelCommands } from '../src/channel-commands.js';
import { loadConfig } from '../src/config.js';
import { SlackApi } from '../src/slack.js';
import { AdminStore } from '../src/store.js';
import { createSettingsFixture } from './helpers/create-settings-fixture.js';

// Hash logical rows, including encrypted fields, so assertion failures cannot
// print credential material. The fixture contains synthetic credentials only.
function snapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = db
      .prepare('SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name')
      .all();
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all();
    return {
      schema,
      tables: tables.map(({ name }) => {
        const rows = db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all();
        return {
          name,
          count: rows.length,
          hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        };
      }),
    };
  } finally {
    db.close();
  }
}

it('reopens SQLite without changing settings, auth, memory or encrypted bindings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-preservation-'));
  const file = join(dir, 'admin.sqlite');
  const key = randomBytes(32);
  await createSettingsFixture(file, key);
  const before = snapshot(file);
  const settings: Record<string, string> = {
    ADMIN_PUBLIC_URL: 'https://admin.example.test',
    ADMIN_INTERNAL_TOKEN: 'synthetic-internal-token'.repeat(2),
    ADMIN_STORE_KEY: key.toString('hex'),
    ADMIN_SESSION_KEY: randomBytes(32).toString('hex'),
    ADMIN_STUDIO_URL: 'https://studio.example.test',
    ADMIN_DB: file,
    SLACK_CLIENT_ID: 'synthetic-client',
    SLACK_CLIENT_SECRET: 'synthetic-secret',
    MODEL_CATALOG: JSON.stringify([
      { key: 'sonnet', route: 'anthropic', model: 'fixture-sonnet' },
      { key: 'opus', route: 'anthropic', model: 'fixture-opus' },
    ]),
    MODEL_DEFAULT_KEY: 'sonnet',
  };
  const config = loadConfig((name) => settings[name]);
  const store = await AdminStore.open({ path: file }, config.storeKey);
  let opened = before;
  const server = http.createServer(
    createApp({ config, store, slack: new SlackApi(), log: () => undefined }),
  );
  try {
    const commands = new ChannelCommands(store, () => config.models!.keys);
    expect(await store.channelSettings('T1', 'C1')).toMatchObject({
      model: 'opus',
      prompt: 'Channel fixture prompt.',
      autoReplies: false,
    });
    expect(await store.modelAssignment('T1', null)).toBe('sonnet');
    expect(await store.promptAssignment('T1', null)).toBe('Workspace fixture prompt.');
    expect(await store.installation('T1')).toMatchObject({
      status: 'whitelisted',
      hasToken: true,
      trustedBotSender: { userId: 'UTEST', botId: 'BTEST', channelId: 'C1' },
    });
    expect(await store.channel('T1', 'C1')).toMatchObject({ enabled: true, botMember: true });
    expect((await store.listBlockedMembers('T1', 'C1')).map((row) => row.userId)).toEqual([
      'UBLOCKED',
    ]);
    const instances = await store.listToolInstances('T1');
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      kind: 'gitlab',
      credentialVersion: 1,
      hasCredential: true,
    });
    expect(await store.listChannelTools('T1', 'C1')).toMatchObject([
      { kind: 'gitlab', instanceId: instances[0]!.id },
    ]);
    expect((await commands.snapshot('T1', 'C1')).entries.map((entry) => entry.text)).toEqual([
      'Fixture memory.',
    ]);
    expect((await store.listAudit(100)).some((entry) => entry.action === 'fixture.retained')).toBe(
      true,
    );
    // The fixture includes the retired feedbackIssues and runLimits sections
    // and the retired run_limits table, so the first start recompiles once:
    // one new version and its audit row. Every other table is unchanged.
    opened = snapshot(file);
    const appended = ['audit', 'config_versions'];
    // sqlite_sequence holds the audit autoincrement counter.
    const moved = [...appended, 'sqlite_sequence'];
    const others = (s: typeof before) => s.tables.filter((t) => !moved.includes(String(t.name)));
    expect(opened.schema).toEqual(before.schema);
    expect(others(opened)).toEqual(others(before));
    for (const name of appended)
      expect(opened.tables.find((t) => t.name === name)!.count).toBe(
        before.tables.find((t) => t.name === name)!.count + 1,
      );
    expect(await store.currentDocument()).not.toHaveProperty('feedbackIssues');
    expect(await store.currentDocument()).not.toHaveProperty('runLimits');
    expect(opened.tables.find((t) => t.name === 'run_limits')!.count).toBe(1);
    expect((await store.listAudit(1))[0]).toMatchObject({ action: 'config.recompile' });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const id = 'fixture-session';
    const mac = createHmac('sha256', config.sessionKey).update(id).digest('base64url');
    const headers = { 'x-forwarded-proto': 'https', cookie: `${SESSION_COOKIE}=${id}.${mac}` };
    const page = await fetch(`${base}/config`, { headers, redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<h1>Application settings</h1>');
    expect(html).not.toContain('Run limits');
    expect(html).toContain('href="https://studio.example.test"');
    expect(html).toContain('Mastra Studio');
    expect(html).not.toContain('href="/threads"');
    for (const path of [
      '/threads',
      '/threads/fragment',
      '/threads/run',
      '/api/threads',
      '/api/threads/old/runs/old/trace',
      '/api/threads/old/runs/old/pin',
      '/assets/trace.js',
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { ...headers, authorization: 'Bearer synthetic-fixture-api-token' },
        method: path.endsWith('/pin') ? 'POST' : 'GET',
        redirect: 'manual',
      });
      expect(response.status, path).toBe(404);
    }
    const configResponse = await fetch(`${base}/internal/config`, {
      headers: { authorization: `Bearer ${config.internalToken}` },
    });
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toEqual(await store.currentDocument());
    const ingest = await fetch(`${base}/internal/observability/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.internalToken}`,
        'content-type': 'application/json',
      },
      body: '{"events":[]}',
    });
    expect(ingest.status).toBe(404);
    expect(snapshot(file)).toEqual(opened);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  }
  const reopened = await AdminStore.open({ path: file }, config.storeKey);
  try {
    expect(snapshot(file)).toEqual(opened);
  } finally {
    await reopened.close();
  }
  // Keep this synthetic database as local evidence; no teardown deletes state.
});

it('recompiles a stored document whose only retired section is runLimits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-run-limits-'));
  const file = join(dir, 'admin.sqlite');
  const key = randomBytes(32);
  const first = await AdminStore.open({ path: file }, key);
  let legacyVersion: number;
  try {
    const { version, installations, authorizationPolicy, toolAssignments } =
      (await first.currentDocument())!;
    legacyVersion = version;
    const runLimits = {
      maxToolCalls: 17,
      maxCostUsd: 10,
      maxActiveMinutes: 30,
      pauseWaitMinutes: 30,
      toolTimeoutMs: 60_000,
      maxOutputBytes: 200_000,
    };
    const body = { version, installations, authorizationPolicy, toolAssignments, runLimits };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await first.run(
      'UPDATE config_versions SET compiled_json = ?, hash = ? WHERE version = ?',
      JSON.stringify({ ...body, hash }),
      hash,
      version,
    );
    await first.run(
      `CREATE TABLE IF NOT EXISTS run_limits (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        limits_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await first.run(
      'INSERT INTO run_limits (id, limits_json, updated_at) VALUES (1, ?, ?)',
      JSON.stringify(runLimits),
      Date.now(),
    );
  } finally {
    await first.close();
  }

  const reopened = await AdminStore.open({ path: file }, key);
  let recompiled;
  try {
    recompiled = (await reopened.currentDocument())!;
    expect(recompiled.version).toBe(legacyVersion + 1);
    expect(Object.keys(recompiled).sort()).toEqual([
      'authorizationPolicy',
      'hash',
      'installations',
      'toolAssignments',
      'version',
    ]);
    expect((await reopened.listAudit(1))[0]).toMatchObject({ action: 'config.recompile' });
    expect(await reopened.get('SELECT id FROM run_limits')).toEqual({ id: 1 });
  } finally {
    await reopened.close();
  }

  const again = await AdminStore.open({ path: file }, key);
  try {
    expect(await again.currentDocument()).toEqual(recompiled);
  } finally {
    await again.close();
  }
});
