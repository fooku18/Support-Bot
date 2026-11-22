/**
 * Cost ledger client against a fake admin service
 *: batching, idempotent ids,
 * backoff, the bounded buffer with its drop counter, rejected batches, and
 * the flush on shutdown.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunAttribution } from '../../../src/integrations/providers/attribution.js';
import { testSelection } from '../../model-fixture.js';
import {
  COST_FLUSH_FAILURES_METRIC,
  COST_ROWS_DROPPED_METRIC,
  COST_ROWS_METRIC,
  CostLedger,
  type CostRequestRow,
  type CostRunRow,
  type RequestObservation,
} from '../../../src/integrations/providers/ledger.js';
import { TestCounters } from '../helpers/counters.js';

const ADMIN_TOKEN = 'admin-internal-token-0123456789abcdef';

interface Post {
  authorization: string | undefined;
  requests: CostRequestRow[];
  runs: CostRunRow[];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fakeAdmin(answer: (post: Post) => number = () => 204) {
  const posts: Post[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/internal/costs');
      const parsed = JSON.parse(body) as { requests: CostRequestRow[]; runs: CostRunRow[] };
      const post = { authorization: req.headers.authorization, ...parsed };
      posts.push(post);
      res.writeHead(answer(post));
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts };
}

const RUN: RunAttribution = {
  instance: 'test',
  teamId: 'T0123456789',
  channelId: 'C0TEST0001',
  rootTs: '1716234567.111111',
  runId: 'run-1-abc',
  runSeq: 1,
  attempt: 1,
  mode: 'answer',
  model: testSelection('claude', 'claude-5.5-sonnet'),
  requesterUserId: 'UHUMAN1',
};

const OBSERVATION: RequestObservation = {
  completedAt: Date.UTC(2026, 9, 15, 12),
  status: 200,
  durationMs: 120,
  outcome: 'completed',
  inputTokens: 10,
  outputTokens: 5,
};

function runRow(attempt: number): CostRunRow {
  return {
    runId: 'run-1-abc',
    attempt,
    instance: 'test',
    completedAt: Date.UTC(2026, 9, 15, 12),
    teamId: 'T0123456789',
    channelId: 'C0TEST0001',
    rootTs: '1716234567.111111',
    mode: 'answer',
    model: 'claude-5.5-sonnet',
    requesterUserId: 'UHUMAN1',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimateUsd: 0.002,
    costBasis: 'sdk',
    outcome: 'completed',
  };
}

function ledgerFor(url: string, extra: Partial<ConstructorParameters<typeof CostLedger>[0]> = {}) {
  const lines: string[] = [];
  const metrics = new TestCounters();
  const log = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
  let clock = 1_000_000;
  const ledger = new CostLedger({
    adminUrl: `${url}/`,
    adminToken: ADMIN_TOKEN,
    log,
    metrics,
    now: () => clock,
    ...extra,
  });
  return {
    ledger,
    lines,
    metrics,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function metric(metrics: TestCounters, name: string): number {
  return metrics
    .snapshot()
    .filter((series) => series.name === name)
    .reduce((sum, series) => sum + series.value, 0);
}

describe('cost ledger client', () => {
  it('posts request and run rows with the internal token and the run attribution', async () => {
    const admin = await fakeAdmin();
    const { ledger, metrics } = ledgerFor(admin.url);
    ledger.recordRequest(RUN, OBSERVATION);
    ledger.recordRequest(
      { ...RUN, mode: 'studio', model: testSelection('opus', 'claude-5-opus') },
      OBSERVATION,
    );
    ledger.recordRun(runRow(1));
    await ledger.flush();
    expect(admin.posts).toHaveLength(1);
    const [post] = admin.posts;
    expect(post?.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(post?.requests).toHaveLength(2);
    expect(post?.requests[0]).toMatchObject({
      instance: 'test',
      teamId: 'T0123456789',
      channelId: 'C0TEST0001',
      runId: 'run-1-abc',
      mode: 'answer',
      requesterUserId: 'UHUMAN1',
      model: 'claude-5.5-sonnet',
      route: 'anthropic',
      connection: 'anthropic',
      outcome: 'completed',
      inputTokens: 10,
    });
    expect(post?.requests[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.requests[1]).toMatchObject({
      mode: 'studio',
      runId: RUN.runId,
      model: 'claude-5-opus',
    });
    expect(post?.runs).toEqual([runRow(1)]);
    expect(ledger.pending).toBe(0);
    expect(metric(metrics, COST_ROWS_METRIC)).toBe(3);
  });

  it('splits the buffer into batches of at most the batch size per kind', async () => {
    const admin = await fakeAdmin();
    const { ledger } = ledgerFor(admin.url, { batchRows: 3, flushMs: 60_000 });
    // A full batch triggers a flush by itself.
    for (let i = 0; i < 7; i += 1) ledger.recordRequest(RUN, OBSERVATION);
    for (let i = 1; i <= 4; i += 1) ledger.recordRun(runRow(i));
    await ledger.flush(true);
    expect(admin.posts.every((post) => post.requests.length <= 3 && post.runs.length <= 3)).toBe(
      true,
    );
    expect(admin.posts.flatMap((post) => post.requests)).toHaveLength(7);
    expect(admin.posts.flatMap((post) => post.runs.map((row) => row.attempt))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(new Set(admin.posts.flatMap((post) => post.requests.map((row) => row.id))).size).toBe(7);
    expect(ledger.pending).toBe(0);
  });

  it('keeps rows when the admin is down, backs off, and resends the same ids', async () => {
    let up = false;
    const admin = await fakeAdmin(() => (up ? 204 : 503));
    const { ledger, metrics, advance, lines } = ledgerFor(admin.url, { flushMs: 5_000 });
    ledger.recordRequest(RUN, OBSERVATION);
    await ledger.flush();
    expect(admin.posts).toHaveLength(1);
    expect(ledger.pending).toBe(1);
    expect(metric(metrics, COST_FLUSH_FAILURES_METRIC)).toBe(1);
    // Inside the backoff nothing is sent.
    await ledger.flush();
    expect(admin.posts).toHaveLength(1);
    advance(5_000);
    await ledger.flush();
    expect(admin.posts).toHaveLength(2);
    // The second failure doubles the wait.
    advance(5_000);
    await ledger.flush();
    expect(admin.posts).toHaveLength(2);
    advance(5_000);
    up = true;
    await ledger.flush();
    expect(admin.posts).toHaveLength(3);
    expect(ledger.pending).toBe(0);
    const ids = admin.posts.map((post) => post.requests[0]?.id);
    expect(new Set(ids).size).toBe(1);
    expect(lines.join('\n')).toContain('admin answered HTTP 503');
    expect(lines.join('\n')).not.toContain(ADMIN_TOKEN);
  });

  it('caps the backoff at 60 seconds', async () => {
    const admin = await fakeAdmin(() => 503);
    const { ledger, advance } = ledgerFor(admin.url, { flushMs: 5_000 });
    ledger.recordRequest(RUN, OBSERVATION);
    for (let i = 0; i < 6; i += 1) {
      await ledger.flush(true);
    }
    const before = admin.posts.length;
    advance(59_999);
    await ledger.flush();
    expect(admin.posts).toHaveLength(before);
    advance(1);
    await ledger.flush();
    expect(admin.posts).toHaveLength(before + 1);
  });

  it('drops the oldest rows beyond the buffer bound and counts them', async () => {
    const admin = await fakeAdmin(() => 503);
    const { ledger, metrics } = ledgerFor(admin.url, { bufferRows: 5, batchRows: 100 });
    for (let i = 0; i < 8; i += 1) {
      ledger.recordRequest(RUN, { ...OBSERVATION, durationMs: i });
    }
    expect(ledger.pending).toBe(5);
    expect(metric(metrics, COST_ROWS_DROPPED_METRIC)).toBe(3);
    await ledger.flush(true);
    expect(admin.posts[0]?.requests.map((row) => row.durationMs)).toEqual([3, 4, 5, 6, 7]);
  });

  it('drops a batch the admin refuses as invalid instead of retrying it forever', async () => {
    const admin = await fakeAdmin((post) => (post.runs.length > 0 ? 400 : 204));
    const { ledger, metrics, lines } = ledgerFor(admin.url);
    ledger.recordRun(runRow(1));
    await ledger.flush();
    expect(ledger.pending).toBe(0);
    expect(metric(metrics, COST_ROWS_DROPPED_METRIC)).toBe(1);
    expect(lines.join('\n')).toContain('cost ledger batch rejected: admin answered HTTP 400');
    ledger.recordRequest(RUN, OBSERVATION);
    await ledger.flush();
    expect(admin.posts).toHaveLength(2);
  });

  it('keeps rows for an admin without the route (404) and for an unreachable admin', async () => {
    const admin = await fakeAdmin(() => 404);
    const { ledger } = ledgerFor(admin.url);
    ledger.recordRequest(RUN, OBSERVATION);
    await ledger.flush();
    expect(ledger.pending).toBe(1);
    const unreachable = ledgerFor('http://127.0.0.1:1');
    unreachable.ledger.recordRequest(RUN, OBSERVATION);
    await unreachable.ledger.flush();
    expect(unreachable.ledger.pending).toBe(1);
    expect(unreachable.lines.join('\n')).toContain('admin unreachable');
  });

  it('flushes on close despite a running backoff, and stops its timer', async () => {
    let up = false;
    const admin = await fakeAdmin(() => (up ? 204 : 503));
    const { ledger } = ledgerFor(admin.url, { flushMs: 20 });
    ledger.start();
    ledger.recordRequest(RUN, OBSERVATION);
    await ledger.flush();
    expect(ledger.pending).toBe(1);
    up = true;
    await ledger.close();
    expect(ledger.pending).toBe(0);
    const posted = admin.posts.length;
    ledger.recordRequest(RUN, OBSERVATION);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(admin.posts).toHaveLength(posted);
  });
});
