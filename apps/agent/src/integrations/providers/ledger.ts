/**
 * Cost ledger client: buffers
 * one row per provider attempt and one summary
 * row per finished run attempt, and posts them to the admin service's
 * `POST /internal/costs` in batches.
 *
 * Accounting never blocks or fails an inference: recording only appends to
 * a bounded in-memory buffer. Flushes run every few seconds, at once when a
 * batch is full, and at shutdown. A refused or failed post keeps the rows
 * and backs off exponentially (capped at 60 s). When the buffer is full the
 * oldest rows are dropped and counted. Request rows carry a UUID and run
 * rows their (runId, attempt) key, so a retried post never double counts.
 * Rows hold identifiers, counts and money only.
 */

import { randomUUID } from 'node:crypto';
import type { StageLogger } from '../../infrastructure/logger.js';
import type { CostMode, RunAttribution } from './attribution.js';
import type { ModelRoute } from '../../contracts/model-catalog.js';

export const COST_ROWS_METRIC = 'support_agent_runner_cost_rows_total';
export const COST_ROWS_DROPPED_METRIC = 'support_agent_runner_cost_rows_dropped_total';
export const COST_FLUSH_FAILURES_METRIC = 'support_agent_runner_cost_flush_failures_total';

/** Rows per kind in one post (the admin refuses more). */
export const COST_BATCH_ROWS = 200;
/** Rows held while the admin is unreachable. */
export const COST_BUFFER_ROWS = 10_000;
export const COST_LEDGER_FLUSH_MS = 5_000;
export const COST_BACKOFF_MAX_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** The admin refused the batch's content: retrying the same rows cannot succeed. */
const REJECTED_STATUSES = new Set([400, 413, 422]);

/** One upstream inference attempt as observed by the SDK transport. */
export interface CostRequestRow {
  id: string;
  instance: string;
  completedAt: number;
  teamId: string | null;
  channelId: string | null;
  rootTs: string | null;
  runId: string | null;
  runSeq: number | null;
  attempt: number | null;
  mode: CostMode;
  requesterUserId: string | null;
  model: string;
  route: ModelRoute;
  connection: string;
  status: number;
  durationMs: number;
  outcome: 'completed' | 'failed' | 'interrupted';
  inputTokens: number | null;
  outputTokens: number | null;
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'parked' | 'interrupted';

/** One finished run attempt with the SDK's usage (D4). */
export interface CostRunRow {
  runId: string;
  attempt: number;
  instance: string;
  completedAt: number;
  teamId: string | null;
  channelId: string | null;
  rootTs: string | null;
  mode: CostMode;
  model: string | null;
  requesterUserId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  estimateUsd: number | null;
  costBasis: string | null;
  outcome: RunOutcome;
}

export type RequestObservation = Pick<
  CostRequestRow,
  'completedAt' | 'status' | 'durationMs' | 'outcome' | 'inputTokens' | 'outputTokens'
>;

export interface CostSink {
  recordRequest(attribution: RunAttribution, observation: RequestObservation): void;
  recordRun(row: CostRunRow): void;
}

export interface CostLedgerOptions {
  adminUrl: string;
  adminToken: string;
  log: StageLogger;
  metrics?: {
    incCounter(name: string, labels?: Record<string, string>): void;
    addCounter(name: string, amount: number, labels?: Record<string, string>): void;
  };
  fetchImpl?: typeof fetch;
  flushMs?: number;
  batchRows?: number;
  bufferRows?: number;
  now?: () => number;
}

type Entry = { kind: 'request'; row: CostRequestRow } | { kind: 'run'; row: CostRunRow };

export class CostLedger implements CostSink {
  private buffer: Entry[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private failures = 0;
  private notBefore = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly flushMs: number;
  private readonly batchRows: number;
  private readonly bufferRows: number;
  private readonly now: () => number;

  constructor(private readonly options: CostLedgerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.flushMs = options.flushMs ?? COST_LEDGER_FLUSH_MS;
    this.batchRows = options.batchRows ?? COST_BATCH_ROWS;
    this.bufferRows = options.bufferRows ?? COST_BUFFER_ROWS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Starts the periodic flush; the timer never keeps the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref();
  }

  recordRequest(attribution: RunAttribution, observation: RequestObservation): void {
    this.push({
      kind: 'request',
      row: {
        id: randomUUID(),
        instance: attribution.instance,
        completedAt: observation.completedAt,
        teamId: attribution.teamId,
        channelId: attribution.channelId,
        rootTs: attribution.rootTs,
        runId: attribution.runId,
        runSeq: attribution.runSeq,
        attempt: attribution.attempt,
        mode: attribution.mode,
        requesterUserId: attribution.requesterUserId,
        model: attribution.model.model,
        route: attribution.model.route,
        connection: attribution.model.connection,
        status: observation.status,
        durationMs: observation.durationMs,
        outcome: observation.outcome,
        inputTokens: observation.inputTokens,
        outputTokens: observation.outputTokens,
      },
    });
  }

  recordRun(row: CostRunRow): void {
    this.push({ kind: 'run', row: { ...row } });
  }

  /** Rows waiting for the admin (tests and the shutdown log). */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Posts what is buffered, one batch after another, until the buffer is
   * empty or a post fails. Concurrent callers share the running flush.
   * `force` ignores the backoff (shutdown).
   */
  flush(force = false): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    if (this.buffer.length === 0 || (!force && this.now() < this.notBefore)) {
      return Promise.resolve();
    }
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** Stops the timer and makes one last attempt to deliver the buffer. */
  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.flushing;
    await this.flush(true);
    if (this.buffer.length > 0) {
      this.options.log.warn(`cost ledger closing with ${this.buffer.length} undelivered rows`);
    }
  }

  private push(entry: Entry): void {
    this.buffer.push(entry);
    this.options.metrics?.incCounter(COST_ROWS_METRIC, { kind: entry.kind });
    const overflow = this.buffer.length - this.bufferRows;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.options.metrics?.addCounter(COST_ROWS_DROPPED_METRIC, overflow);
    }
    if (this.buffer.length >= this.batchRows) void this.flush();
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.nextBatch();
      const outcome = await this.post(batch);
      if (outcome === 'retry') {
        this.failures += 1;
        this.options.metrics?.incCounter(COST_FLUSH_FAILURES_METRIC);
        this.notBefore =
          this.now() + Math.min(COST_BACKOFF_MAX_MS, this.flushMs * 2 ** (this.failures - 1));
        return;
      }
      this.failures = 0;
      this.notBefore = 0;
      // Rows recorded meanwhile were appended; remove exactly the posted ones
      // (overflow may have dropped some of them already).
      const sent = new Set<Entry>([...batch.requests, ...batch.runs]);
      const before = this.buffer.length;
      this.buffer = this.buffer.filter((entry) => !sent.has(entry));
      if (outcome === 'rejected') {
        this.options.metrics?.addCounter(COST_ROWS_DROPPED_METRIC, before - this.buffer.length);
      }
    }
  }

  private nextBatch(): { requests: Entry[]; runs: Entry[] } {
    const requests: Entry[] = [];
    const runs: Entry[] = [];
    for (const entry of this.buffer) {
      const target = entry.kind === 'request' ? requests : runs;
      if (target.length < this.batchRows) target.push(entry);
      if (requests.length >= this.batchRows && runs.length >= this.batchRows) break;
    }
    return { requests, runs };
  }

  /**
   * `delivered`; `rejected`: the admin refused the rows themselves (a
   * retry would be refused again, so they are dropped and counted);
   * `retry`: unreachable or not ready (an older admin without the route
   * answers 404), the rows stay.
   */
  private async post(batch: {
    requests: Entry[];
    runs: Entry[];
  }): Promise<'delivered' | 'rejected' | 'retry'> {
    const body = JSON.stringify({
      requests: batch.requests.map((entry) => entry.row),
      runs: batch.runs.map((entry) => entry.row),
    });
    try {
      const response = await this.fetchImpl(
        `${this.options.adminUrl.replace(/\/+$/, '')}/internal/costs`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.adminToken}`,
            'content-type': 'application/json',
            'x-support-agent-caller': 'runner',
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return 'delivered';
      if (REJECTED_STATUSES.has(response.status)) {
        this.options.log.error(
          `cost ledger batch rejected: admin answered HTTP ${response.status}; dropping ${batch.requests.length + batch.runs.length} rows`,
        );
        return 'rejected';
      }
      this.options.log.warn(
        `cost ledger flush refused: admin answered HTTP ${response.status} (rows kept: ${this.buffer.length})`,
      );
      return 'retry';
    } catch (err) {
      this.options.log.warn(
        `cost ledger flush failed: admin unreachable (${err instanceof Error ? err.name : 'error'}; rows kept: ${this.buffer.length})`,
      );
      return 'retry';
    }
  }
}
