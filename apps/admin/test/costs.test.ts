/**
 * Cost ledger in the admin store and the Costs view
 *: idempotent inserts,
 * aggregates by every grouping, UTC day boundaries, retention pruning,
 * the basis rule, batch validation, ranges, names, CSV and the page.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCostsView,
  CostInputError,
  costsCsv,
  MAX_COST_ROWS,
  parseCostBatch,
  parseCostRange,
  type CostRequestRow,
  type CostRunRow,
} from '../src/costs.js';
import { AdminStore } from '../src/store.js';
import { costsPage } from '../src/views/pages.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY_MS = 86_400_000;
let seq = 0;

function request(overrides: Partial<CostRequestRow> = {}): CostRequestRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    instance: 'test',
    completedAt: NOW,
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
    durationMs: 900,
    outcome: 'completed',
    inputTokens: 100,
    outputTokens: 10,
    ...overrides,
  };
}

function run(overrides: Partial<CostRunRow> = {}): CostRunRow {
  return {
    runId: 'run-1-abc',
    attempt: 1,
    instance: 'test',
    completedAt: NOW,
    teamId: 'T0TEAM1',
    channelId: 'C0GENERAL',
    rootTs: '1716234567.111111',
    mode: 'answer',
    model: 'claude-5.5-sonnet',
    requesterUserId: 'U0ALICE',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheCreationTokens: 5,
    estimateUsd: 0.012,
    costBasis: 'sdk',
    outcome: 'completed',
    ...overrides,
  };
}

describe('cost ledger store', () => {
  let store: AdminStore;
  beforeEach(async () => {
    store = await AdminStore.open({ path: ':memory:' }, Buffer.alloc(32, 1));
  });
  afterEach(async () => await store.close());

  it('stores a batch once: a retried post inserts nothing', async () => {
    const batch = { requests: [request(), request()], runs: [run()] };
    expect(await store.recordCostRows(batch)).toEqual({ requests: 2, runs: 1 });
    expect(await store.recordCostRows(batch)).toEqual({ requests: 0, runs: 0 });
    expect(await store.costLedgerStatus()).toMatchObject({
      requestRows: 2,
      runRows: 1,
      firstDay: '2026-10-15',
      instances: ['test'],
    });
    expect((await store.costLedgerStatus()).lastReceivedAt).toBeGreaterThan(0);
    // Telemetry, not configuration: no audit rows.
    expect((await store.listAudit(10)).filter((entry) => entry.action.startsWith('costs'))).toEqual(
      [],
    );
  });

  it('assigns rows to UTC calendar days at the boundary', async () => {
    const lastMs = Date.UTC(2026, 9, 14, 23, 59, 59, 999);
    await store.recordCostRows({
      requests: [request({ completedAt: lastMs }), request({ completedAt: lastMs + 1 })],
      runs: [run({ completedAt: lastMs + 1 })],
    });
    const days = await store.costSums({ from: '2026-10-01', to: '2026-10-31' }, 'day');
    expect(days.map((row) => [row.key.day, row.requests, row.runs]).sort()).toEqual([
      ['2026-10-14', 1, 0],
      ['2026-10-15', 1, 1],
    ]);
    // The range is inclusive on both ends and excludes everything else.
    expect(await store.costSums({ from: '2026-10-15', to: '2026-10-15' }, 'day')).toHaveLength(1);
    expect(await store.costSums({ from: '2026-10-16', to: '2026-10-20' }, 'day')).toEqual([]);
  });

  it('separates route and connection even when model IDs match', async () => {
    await store.recordCostRows({
      requests: [
        request(),
        request({ status: 429, outcome: 'failed', inputTokens: null, outputTokens: null }),
        request({
          route: 'vertex-claude',
          connection: 'vertex:fixture:global:account',
          outcome: 'interrupted',
        }),
      ],
      runs: [run()],
    });
    const range = { from: '2026-10-15', to: '2026-10-15' };
    expect(await store.costSums(range, 'channel')).toMatchObject([
      {
        requests: 3,
        completedRequests: 1,
        failedRequests: 1,
        interruptedRequests: 1,
        runs: 1,
        inputTokens: 200,
        outputTokens: 20,
      },
    ]);
    for (const group of ['model', 'route'] as const) {
      const routes = await store.costSums(range, group);
      expect(routes).toHaveLength(2);
      expect(routes.find((entry) => entry.key.route === 'anthropic')?.requests).toBe(2);
      expect(routes.find((entry) => entry.key.route === 'vertex-claude')?.requests).toBe(1);
    }
    expect(await store.costRequestsForRun('run-1-abc')).toEqual([
      { route: 'anthropic', connection: 'anthropic', model: 'claude-5.5-sonnet', requests: 2 },
      {
        route: 'vertex-claude',
        connection: 'vertex:fixture:global:account',
        model: 'claude-5.5-sonnet',
        requests: 1,
      },
    ]);
  });

  it('prunes days older than the retention, and audits a pass that deleted rows', async () => {
    await store.recordCostRows({
      requests: [
        request({ completedAt: NOW - 31 * DAY_MS }),
        request({ completedAt: NOW - 30 * DAY_MS }),
        request(),
      ],
      runs: [run({ completedAt: NOW - 40 * DAY_MS }), run({ attempt: 2 })],
    });
    expect(await store.pruneCosts(30, NOW)).toEqual({ requests: 1, runs: 1 });
    expect(await store.costLedgerStatus()).toMatchObject({ requestRows: 2, runRows: 1 });
    const audit = (await store.listAudit(5)).filter((entry) => entry.action === 'costs.prune');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toEqual({ before: '2026-09-15', requests: 1, runs: 1 });
    expect(await store.pruneCosts(30, NOW)).toEqual({ requests: 0, runs: 0 });
    expect(
      (await store.listAudit(5)).filter((entry) => entry.action === 'costs.prune'),
    ).toHaveLength(1);
  });
});

describe('cost batch validation', () => {
  const body = (requests: unknown[] = [request()], runs: unknown[] = [run()]) => ({
    requests,
    runs,
  });

  it('accepts gateway model IDs and canonical connection identities', () => {
    const requests = [
      request({
        model: 'vertex_ai/claude-sonnet-4-5@20250929',
        connection: 'anthropic:https://gateway.example.test/team/v1',
      }),
      request({
        route: 'vertex-claude',
        model: 'claude-sonnet-4-5@20250929',
        connection:
          'vertex:https://gateway.example.test/vertex/v1beta1/projects/test-project/locations/global/publishers',
      }),
    ];
    expect(parseCostBatch(body(requests, []), NOW).requests).toEqual(requests);
  });

  it('accepts the rows the runner sends, and empty or absent lists', () => {
    const parsed = parseCostBatch(body(), NOW);
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.runs).toHaveLength(1);
    expect(parseCostBatch({}, NOW)).toEqual({ requests: [], runs: [] });
  });

  it('refuses anything outside the bounded shapes, naming the field only', () => {
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...body(), extra: 1 }, /^extra is not a field$/],
      [body([{ ...request(), prompt: 'secret text' }]), /requests\[0\]\.prompt is not a field/],
      [body([{ ...request(), model: 'summarise this please' }]), /requests\[0\]\.model/],
      [body([{ ...request(), channelId: '#general' }]), /requests\[0\]\.channelId/],
      [body([{ ...request(), id: 'not-a-uuid' }]), /requests\[0\]\.id/],
      [body([{ ...request(), status: 99 }]), /requests\[0\]\.status/],
      [body([{ ...request(), route: 'gateway' }]), /requests\[0\]\.route/],
      [body([{ ...request(), inputTokens: -1 }]), /requests\[0\]\.inputTokens/],
      [body([{ ...request(), connection: 'secret url' }]), /requests\[0\]\.connection/],
      [body([{ ...request(), outcome: 'none' }]), /requests\[0\]\.outcome/],
      [body([{ ...request(), completedAt: NOW + 2 * DAY_MS }]), /requests\[0\]\.completedAt/],
      [body([{ ...request(), runId: null }]), /requests\[0\]\.runId is required/],
      [body([(({ mode: _m, ...rest }) => rest)(request())]), /requests\[0\]\.mode is missing/],
      [body([], [{ ...run(), mode: 'smoke' }]), /runs\[0\]\.mode/],
      [body([], [{ ...run(), outcome: 'great' }]), /runs\[0\]\.outcome/],
      [body([], [{ ...run(), inputTokens: 1.5 }]), /runs\[0\]\.inputTokens/],
      [body([], [{ ...run(), costBasis: 'a basis with spaces' }]), /runs\[0\]\.costBasis/],
      [body('x' as never), /requests must be a list/],
      [body(Array.from({ length: MAX_COST_ROWS + 1 }, () => request())), /at most 200/],
    ];
    for (const [input, message] of refusals) {
      expect(() => parseCostBatch(input, NOW), String(message)).toThrow(CostInputError);
      expect(() => parseCostBatch(input, NOW), String(message)).toThrow(message);
    }
  });
});

describe('cost ranges', () => {
  it('defaults to the last 30 UTC days including today', () => {
    expect(parseCostRange(new URLSearchParams(), NOW)).toEqual({
      from: '2026-09-16',
      to: '2026-10-15',
    });
    expect(parseCostRange(new URLSearchParams({ to: '2026-03-01' }), NOW)).toEqual({
      from: '2026-01-31',
      to: '2026-03-01',
    });
  });

  it('refuses malformed, reversed and over-long ranges', () => {
    const queries: Record<string, string>[] = [
      { from: '2026-13-01' },
      { from: '2026-02-30' },
      { from: 'yesterday' },
      { from: '2026-10-15', to: '2026-10-14' },
      { from: '2010-01-01', to: '2026-10-15' },
    ];
    for (const query of queries) {
      expect(() => parseCostRange(new URLSearchParams(query), NOW), JSON.stringify(query)).toThrow(
        CostInputError,
      );
    }
  });
});

describe('costs view', () => {
  let store: AdminStore;
  beforeEach(async () => {
    store = await AdminStore.open({ path: ':memory:' }, Buffer.alloc(32, 1));
    await store.saveInstallation('test', {
      teamId: 'T0TEAM1',
      teamName: 'Team <One>',
      botUserId: 'U0BOT',
      botId: 'B0BOT',
      botToken: 'xoxb-test',
      scopes: '',
    });
    await store.setChannel('test', {
      teamId: 'T0TEAM1',
      channelId: 'C0GENERAL',
      name: '<script>general</script>',
      isPrivate: false,
      botMember: true,
      enabled: true,
    });
    await store.recordCostRows({
      requests: [
        request({ completedAt: NOW - DAY_MS }),
        request({ channelId: 'C0OTHER', requesterUserId: 'U0BOB' }),
        request({ channelId: 'C0OTHER', outcome: 'interrupted' }),
      ],
      runs: [run({ completedAt: NOW - DAY_MS }), run({ runId: 'run-2', channelId: 'C0OTHER' })],
    });
  });
  afterEach(async () => await store.close());

  it('builds daily rows newest first, a sorted breakdown with names, and totals', async () => {
    const view = await buildCostsView(
      store,
      { from: '2026-10-01', to: '2026-10-15' },
      'channel',
      400,
      NOW,
    );
    expect(view.days.map((row) => row.label)).toEqual(['2026-10-15', '2026-10-14']);
    expect(view.days[0]).toMatchObject({
      key: { day: '2026-10-15' },
      requests: 2,
      interruptedRequests: 1,
    });
    expect(view.days[1]).toMatchObject({ completedRequests: 1, billedUsd: null });
    expect(view.rows.map((row) => row.key)).toEqual([
      { teamId: 'T0TEAM1', channelId: 'C0OTHER' },
      { teamId: 'T0TEAM1', channelId: 'C0GENERAL' },
    ]);
    expect(view.rows[1]).toMatchObject({
      label: '#<script>general</script>',
      detail: 'Team <One> · T0TEAM1/C0GENERAL',
      completedRequests: 1,
      billedUsd: null,
    });
    // An unnamed channel falls back to its ID.
    expect(view.rows[0]).toMatchObject({
      label: 'C0OTHER',
      billedUsd: null,
      interruptedRequests: 1,
    });
    expect(view.totals).toMatchObject({ requests: 3, runs: 2, billedUsd: null });
    expect(view.ledger).toMatchObject({ requestRows: 3, runRows: 2, retentionDays: 400 });

    const requesters = await buildCostsView(
      store,
      { from: '2026-10-15', to: '2026-10-15' },
      'requester',
      400,
      NOW,
    );
    expect(requesters.rows.map((row) => row.label).sort()).toEqual(['U0ALICE', 'U0BOB']);
  });

  it('exports CSV with key columns, unknown as empty, and defused formula text', async () => {
    await store.run(
      `INSERT INTO blocked_members (team_id, channel_id, user_id, display_name, updated_at)
       VALUES ('T0TEAM1', 'C0GENERAL', 'U0BOB', '=HYPERLINK("x")', 1)`,
    );
    const view = await buildCostsView(
      store,
      { from: '2026-10-15', to: '2026-10-15' },
      'channel',
      400,
      NOW,
    );
    const lines = costsCsv(view).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'teamId,channelId,label,requests,completed_requests,failed_requests,interrupted_requests,billed_usd,runs,estimate_usd,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('T0TEAM1,C0OTHER,C0OTHER,2,1,0,1,,1,0.012,200,20,50,5');
    const people = costsCsv(
      await buildCostsView(store, { from: '2026-10-15', to: '2026-10-15' }, 'requester', 400, NOW),
    );
    expect(people).toContain(`T0TEAM1,U0BOB,U0BOB,1,1,0,0,,0,,100,10,0,0`);
  });

  it('renders the page with escaped names, the basis, presets and ledger health', async () => {
    const view = await buildCostsView(
      store,
      { from: '2026-10-01', to: '2026-10-15' },
      'channel',
      400,
      NOW,
    );
    const body = costsPage({ adminName: 'alice', csrf: 'csrf-token' }, view);
    expect(body).toContain('<title>Costs - Support Agent settings</title>');
    expect(body).toMatch(/<a\s+href="\/costs"\s+aria-current="page"/);
    expect(body).toContain('#&lt;script&gt;general&lt;/script&gt;');
    expect(body).not.toContain('<script>general');
    expect(body).toContain('Team &lt;One&gt; · T0TEAM1/C0GENERAL');
    expect(body).toContain('Day (UTC)');
    expect(body).toContain('Billed USD is unavailable.');
    expect(body).toContain('/costs.csv?from=2026-10-01&amp;to=2026-10-15&amp;group=day');
    expect(body).toContain('/costs?from=2026-10-01&amp;to=2026-10-15&amp;group=requester');
    expect(body.replace(/\s+/g, ' ')).toContain('· instance test · kept 400 days.');
    // The only scripts are the served enhancements, never inline code.
    expect(body).not.toMatch(/<script(?! src="\/assets\/admin\.js">)/);
    const empty = costsPage(
      { adminName: 'alice', csrf: 'csrf-token' },
      await buildCostsView(store, { from: '2026-01-01', to: '2026-01-02' }, 'route', 400, NOW),
    );
    expect(empty).toContain('No model attempts in this range.');
  });
});
