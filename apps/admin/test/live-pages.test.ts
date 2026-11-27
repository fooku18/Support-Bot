import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import type { AdminConfig } from '../src/config.js';
import type { CostRequestRow } from '../src/costs.js';
import { LiveFeed } from '../src/live.js';
import { SlackApi } from '../src/slack.js';
import { AdminStore } from '../src/store.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const costRequest = (): CostRequestRow => ({
  id: randomUUID(),
  instance: 'test',
  completedAt: Date.now(),
  teamId: 'T0TEAM1',
  channelId: 'C0GENERAL',
  rootTs: '1716234567.111111',
  runId: 'run-1-abc',
  runSeq: 1,
  attempt: 1,
  mode: 'answer',
  requesterUserId: 'U0ALICE',
  model: 'claude-5.5-sonnet',
  route: 'anthropic',
  connection: 'anthropic',
  status: 200,
  durationMs: 800,
  outcome: 'completed',
  inputTokens: 1200,
  outputTokens: 40,
});

describe('live notice versions of signed-in pages', () => {
  let store: AdminStore;
  let server: http.Server;
  let base: string;
  let feed: LiveFeed;
  let cookie: string;

  beforeEach(async () => {
    const config: AdminConfig = {
      publicUrl: 'https://admin.example.test',
      internalToken: 'internal-token-internal-token-internal-token',
      storeKey: Buffer.alloc(32, 1),
      sessionKey: Buffer.alloc(32, 2),
      slackClientId: 'client-id',
      slackClientSecret: 'client-secret',
      slackApiUrl: 'http://127.0.0.1:9/api/',
      egressProxyUrl: undefined,
      port: 0,
      host: '127.0.0.1',
      database: { path: ':memory:' },
      models: null,
      studioUrl: null,
      costRetentionDays: 400,
    };
    store = await AdminStore.open({ path: ':memory:' }, config.storeKey);
    feed = new LiveFeed();
    server = http.createServer(
      createApp({
        config,
        store,
        slack: new SlackApi({ apiUrl: config.slackApiUrl }),
        feed,
        log: () => undefined,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await store.createAdmin('cli', 'alice', await hashPassword('correct horse battery'));
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'x-forwarded-proto': 'https',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ name: 'alice', password: 'correct horse battery' }).toString(),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    await settle();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  const renderedVersions = async (
    path: string,
  ): Promise<{ page: string; versions: Record<string, number> }> => {
    const page = await (
      await fetch(`${base}${path}`, { headers: { 'x-forwarded-proto': 'https', cookie } })
    ).text();
    const attribute = /data-live-versions="([^"]*)"/.exec(page)?.[1] ?? '{}';
    return {
      page,
      versions: JSON.parse(attribute.replaceAll('&quot;', '"')) as Record<string, number>,
    };
  };

  it('stamps the costs page with the version its data was read at', async () => {
    const ledgerStatus = store.costLedgerStatus.bind(store);
    let raced = false;
    store.costLedgerStatus = async () => {
      if (!raced) {
        raced = true;
        await store.recordCostRows({ requests: [costRequest()], runs: [] });
        await settle();
      }
      return ledgerStatus();
    };
    const { page, versions } = await renderedVersions('/costs');
    expect(page).toContain('No model attempts in this range.');
    expect(versions.costs).toBeLessThan(feed.version('costs'));
  });

  it('stamps the audit page with the version its entries were read at', async () => {
    const listAudit = store.listAudit.bind(store);
    store.listAudit = async (limit) => {
      const entries = await listAudit(limit);
      await store.audit('system', 'concurrent.entry', 'test');
      await settle();
      return entries;
    };
    const { page, versions } = await renderedVersions('/audit');
    expect(page).not.toContain('concurrent.entry');
    expect(versions.audit).toBeLessThan(feed.version('audit'));
  });

  it('stamps the settings page with the version its document was read at', async () => {
    const currentDocument = store.currentDocument.bind(store);
    let raced = false;
    store.currentDocument = async () => {
      const document = await currentDocument();
      if (!raced) {
        raced = true;
        await store.recordSeen('T0TEAM1');
        await settle();
      }
      return document;
    };
    const { versions } = await renderedVersions('/config');
    expect(versions.config).toBeLessThan(feed.version('config'));
  });
});
