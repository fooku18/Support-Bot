/** Provider inference observations and the admin ledger view. */
import { MODEL_ROUTES, type ModelRoute } from './generated/model-catalog.js';

/** Rows of each kind in one post (the runner's batch size). */
export const MAX_COST_ROWS = 200;
/** Body cap of `POST /internal/costs` (two full batches fit comfortably). */
export const MAX_COST_BODY_BYTES = 256 * 1024;
export const DEFAULT_COST_RANGE_DAYS = 30;
export const MAX_COST_RANGE_DAYS = 3_660;

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const TEAM_ID = /^T[A-Z0-9]{1,31}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{1,31}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const USER_ID = /^[UW][A-Z0-9]{1,31}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const COST_BASIS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MODES = ['answer', 'studio'] as const;
const OUTCOMES = ['completed', 'failed', 'cancelled', 'parked', 'interrupted'] as const;
/** Earliest plausible row time (2026-01-01) and the largest money/token values accepted. */
const EARLIEST_MS = Date.UTC(2026, 0, 1);
const MAX_USD = 1_000_000;
const MAX_TOKENS = 1e12;
const DAY_MS = 86_400_000;

export type CostMode = (typeof MODES)[number];
export type RunOutcome = (typeof OUTCOMES)[number];

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

export class CostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostInputError';
  }
}

/** `YYYY-MM-DD` of a time in UTC (D7). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// -- batch validation ----------------------------------------------------------

type Field = (value: unknown, where: string) => unknown;

const fail = (where: string, what: string): never => {
  throw new CostInputError(`${where} must be ${what}`);
};
const pattern =
  (shape: RegExp, what: string, nullable: boolean): Field =>
  (value, where) =>
    value === null && nullable
      ? null
      : typeof value === 'string' && shape.test(value)
        ? value
        : fail(where, nullable ? `${what} or null` : what);
const integer =
  (min: number, max: number, nullable: boolean): Field =>
  (value, where) =>
    value === null && nullable
      ? null
      : Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
        ? value
        : fail(where, `an integer from ${min} to ${max}${nullable ? ' or null' : ''}`);
const money: Field = (value, where) =>
  value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < MAX_USD
      ? value
      : fail(where, 'a non-negative USD amount or null');
const oneOf =
  (values: readonly string[]): Field =>
  (value, where) =>
    typeof value === 'string' && values.includes(value) ? value : fail(where, values.join(' | '));

function timestamp(now: number): Field {
  return integer(EARLIEST_MS, now + DAY_MS, false);
}

function requestFields(now: number): Record<keyof CostRequestRow, Field> {
  return {
    id: pattern(UUID, 'a lowercase UUID', false),
    instance: pattern(INSTANCE_ID, 'an instance label', false),
    completedAt: timestamp(now),
    teamId: pattern(TEAM_ID, 'a Slack workspace ID', true),
    channelId: pattern(CHANNEL_ID, 'a Slack channel ID', true),
    rootTs: pattern(SLACK_TS, 'a Slack timestamp', true),
    runId: pattern(RUN_ID, 'a run ID', true),
    runSeq: integer(0, 1_000_000, true),
    attempt: integer(0, 1_000_000, true),
    mode: oneOf(MODES),
    requesterUserId: pattern(USER_ID, 'a Slack user ID', true),
    model: pattern(MODEL_ID, 'a model ID', false),
    route: oneOf(MODEL_ROUTES),
    connection: pattern(
      /^[a-z][a-zA-Z0-9._~/:@-]{0,511}$/,
      'a provider connection identity',
      false,
    ),
    status: (value, where) => (value === 0 ? 0 : integer(100, 599, false)(value, where)),
    durationMs: integer(0, 7 * DAY_MS, false),
    outcome: oneOf(['completed', 'failed', 'interrupted']),
    inputTokens: integer(0, MAX_TOKENS, true),
    outputTokens: integer(0, MAX_TOKENS, true),
  };
}

function runFields(now: number): Record<keyof CostRunRow, Field> {
  const tokens = integer(0, MAX_TOKENS, true);
  return {
    runId: pattern(RUN_ID, 'a run ID', false),
    attempt: integer(0, 1_000_000, false),
    instance: pattern(INSTANCE_ID, 'an instance label', false),
    completedAt: timestamp(now),
    teamId: pattern(TEAM_ID, 'a Slack workspace ID', true),
    channelId: pattern(CHANNEL_ID, 'a Slack channel ID', true),
    rootTs: pattern(SLACK_TS, 'a Slack timestamp', true),
    mode: oneOf(MODES),
    model: pattern(MODEL_ID, 'a model alias', true),
    requesterUserId: pattern(USER_ID, 'a Slack user ID', true),
    inputTokens: tokens,
    outputTokens: tokens,
    cacheReadTokens: tokens,
    cacheCreationTokens: tokens,
    estimateUsd: money,
    costBasis: pattern(COST_BASIS, 'a cost basis label', true),
    outcome: oneOf(OUTCOMES),
  };
}

function parseRows<T>(value: unknown, name: string, fields: Record<string, Field>): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_COST_ROWS) {
    throw new CostInputError(`${name} must be a list of at most ${MAX_COST_ROWS} rows`);
  }
  return value.map((entry, index) => {
    const where = `${name}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CostInputError(`${where} must be an object`);
    }
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(fields, key)) throw new CostInputError(`${where}.${key} is not a field`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(fields)) {
      if (!Object.hasOwn(row, key)) throw new CostInputError(`${where}.${key} is missing`);
      out[key] = check(row[key], `${where}.${key}`);
    }
    return out as T;
  });
}

/** Validates a `POST /internal/costs` body; any invalid row refuses the batch. */
export function parseCostBatch(
  body: Record<string, unknown>,
  now = Date.now(),
): { requests: CostRequestRow[]; runs: CostRunRow[] } {
  for (const key of Object.keys(body)) {
    if (key !== 'requests' && key !== 'runs') throw new CostInputError(`${key} is not a field`);
  }
  const requests = parseRows<CostRequestRow>(body.requests, 'requests', requestFields(now));
  const runs = parseRows<CostRunRow>(body.runs, 'runs', runFields(now));
  for (const [index, row] of requests.entries()) {
    if (row.runId === null) {
      throw new CostInputError(`requests[${index}].runId is required for ${row.mode} rows`);
    }
  }
  return { requests, runs };
}

// -- ranges and groups -----------------------------------------------------------

export const COST_GROUPS = {
  day: ['day'],
  channel: ['team_id', 'channel_id'],
  requester: ['team_id', 'requester_user_id'],
  mode: ['mode'],
  model: ['route', 'model', 'connection'],
  route: ['route', 'connection'],
} as const;

export type CostGroup = keyof typeof COST_GROUPS;

export function isCostGroup(value: string): value is CostGroup {
  return Object.hasOwn(COST_GROUPS, value);
}

export interface CostRange {
  from: string;
  to: string;
}

function validDay(value: string): boolean {
  return DAY.test(value) && utcDay(Date.parse(`${value}T00:00:00Z`) || 0) === value;
}

/** `from`/`to` (UTC days, inclusive); defaults to the last 30 days including today. */
export function parseCostRange(query: URLSearchParams, now = Date.now()): CostRange {
  const to = query.get('to') || utcDay(now);
  const from =
    query.get('from') ||
    utcDay(
      Date.parse(`${validDay(to) ? to : utcDay(now)}T00:00:00Z`) -
        (DEFAULT_COST_RANGE_DAYS - 1) * DAY_MS,
    );
  if (!validDay(from) || !validDay(to)) throw new CostInputError('from and to must be YYYY-MM-DD');
  if (from > to) throw new CostInputError('from must not be after to');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (span > MAX_COST_RANGE_DAYS) {
    throw new CostInputError(`a range covers at most ${MAX_COST_RANGE_DAYS} days`);
  }
  return { from, to };
}

/** Preset ranges for the page: today, the last 7 and the last 30 days. */
export function costPresets(now = Date.now()): Array<{ label: string; range: CostRange }> {
  const today = utcDay(now);
  const back = (days: number): string => utcDay(now - (days - 1) * DAY_MS);
  return [
    { label: 'Today', range: { from: today, to: today } },
    { label: 'Last 7 days', range: { from: back(7), to: today } },
    { label: 'Last 30 days', range: { from: back(30), to: today } },
  ];
}

// -- view model ------------------------------------------------------------------

/** Raw sums of one group key, as the store computes them. */
export interface CostSums {
  key: Record<string, string | number | null>;
  requests: number;
  completedRequests: number;
  failedRequests: number;
  interruptedRequests: number;
  runs: number;
  runsWithEstimate: number;
  estimateUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CostLedgerStatus {
  requestRows: number;
  runRows: number;
  lastReceivedAt: number | null;
  firstDay: string | null;
  instances: string[];
}

export interface CostAggregate {
  requests: number;
  completedRequests: number;
  failedRequests: number;
  interruptedRequests: number;
  billedUsd: null;
  runs: number;
  estimateUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CostRow extends CostAggregate {
  /** Group key in API names (e.g. `{ teamId, channelId }`). */
  key: Record<string, string | number | null>;
  label: string;
  /** Secondary text (IDs under a name). */
  detail: string | null;
}

export interface CostsView {
  generatedAt: number;
  from: string;
  to: string;
  group: CostGroup;
  totals: CostAggregate;
  /** One row per UTC day with data, newest first. */
  days: CostRow[];
  /** The `group` breakdown, highest displayed cost first (the days again for `day`). */
  rows: CostRow[];
  ledger: CostLedgerStatus & { retentionDays: number };
}

/** What the view reads from the admin store. */
export interface CostSource {
  costSums(range: CostRange, group: CostGroup): Promise<CostSums[]>;
  costLedgerStatus(): Promise<CostLedgerStatus>;
  channel(teamId: string, channelId: string): Promise<{ name: string } | null>;
  installation(teamId: string): Promise<{ teamName: string } | null>;
}

const API_KEYS: Record<string, string> = {
  day: 'day',
  team_id: 'teamId',
  channel_id: 'channelId',
  requester_user_id: 'requesterUserId',
  mode: 'mode',
  model: 'model',
  route: 'route',
  connection: 'connection',
};

/** Money rounded to micro-dollars: sums of floats must not show noise. */
function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function aggregate(sums: Omit<CostSums, 'key'>): CostAggregate {
  return {
    requests: sums.requests,
    completedRequests: sums.completedRequests,
    failedRequests: sums.failedRequests,
    interruptedRequests: sums.interruptedRequests,
    billedUsd: null,
    runs: sums.runs,
    estimateUsd: sums.runsWithEstimate > 0 ? usd(sums.estimateUsd) : null,
    inputTokens: sums.inputTokens,
    outputTokens: sums.outputTokens,
    cacheReadTokens: sums.cacheReadTokens,
    cacheCreationTokens: sums.cacheCreationTokens,
  };
}

function totalOf(rows: CostSums[]): Omit<CostSums, 'key'> {
  const total: Omit<CostSums, 'key'> = {
    requests: 0,
    completedRequests: 0,
    failedRequests: 0,
    interruptedRequests: 0,
    runs: 0,
    runsWithEstimate: 0,
    estimateUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const row of rows) {
    for (const field of Object.keys(total) as Array<keyof typeof total>) {
      total[field] += row[field];
    }
  }
  return total;
}

async function label(
  source: CostSource,
  group: CostGroup,
  key: Record<string, string | number | null>,
): Promise<{ label: string; detail: string | null }> {
  const teamId = typeof key.team_id === 'string' ? key.team_id : null;
  switch (group) {
    case 'day':
      return { label: String(key.day), detail: null };
    case 'channel': {
      const channelId = typeof key.channel_id === 'string' ? key.channel_id : null;
      if (teamId === null || channelId === null) {
        return { label: 'unknown channel', detail: null };
      }
      const name = (await source.channel(teamId, channelId))?.name;
      const team = (await source.installation(teamId))?.teamName;
      return {
        label: name !== undefined && name !== '' ? `#${name}` : channelId,
        detail: `${team !== undefined && team !== '' ? `${team} · ` : ''}${teamId}/${channelId}`,
      };
    }
    case 'requester': {
      const userId = typeof key.requester_user_id === 'string' ? key.requester_user_id : null;
      if (teamId === null || userId === null) return { label: 'unknown', detail: null };
      return { label: userId, detail: `${teamId}/${userId}` };
    }
    case 'mode':
      return { label: String(key.mode), detail: null };
    case 'model':
      return { label: `${key.route}/${key.model}`, detail: String(key.connection) };
    case 'route':
      return { label: String(key.route), detail: String(key.connection) };
  }
}

async function rowsFor(source: CostSource, sums: CostSums[], group: CostGroup): Promise<CostRow[]> {
  return Promise.all(
    sums.map(async (entry) => ({
      key: Object.fromEntries(
        Object.entries(entry.key).map(([column, value]) => [API_KEYS[column] ?? column, value]),
      ),
      ...(await label(source, group, entry.key)),
      ...aggregate(entry),
    })),
  );
}

/** The page and `GET /api/costs`: daily rows, one breakdown, totals and ledger health. */
export async function buildCostsView(
  source: CostSource,
  range: CostRange,
  group: CostGroup,
  retentionDays: number,
  now = Date.now(),
): Promise<CostsView> {
  const daySums = await source.costSums(range, 'day');
  const days = (await rowsFor(source, daySums, 'day')).sort((a, b) =>
    b.label.localeCompare(a.label),
  );
  const rows =
    group === 'day'
      ? days
      : (await rowsFor(source, await source.costSums(range, group), group)).sort(
          (a, b) => b.requests - a.requests || a.label.localeCompare(b.label),
        );
  return {
    generatedAt: now,
    from: range.from,
    to: range.to,
    group,
    totals: aggregate(totalOf(daySums)),
    days,
    rows,
    ledger: { ...(await source.costLedgerStatus()), retentionDays },
  };
}

// -- CSV ---------------------------------------------------------------------------

/** One CSV field; formula-looking text is defused, quotes doubled. */
function csvField(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** `GET /costs.csv`: the rows of one grouping (default: the daily rows). */
export function costsCsv(view: CostsView): string {
  const keyColumns = COST_GROUPS[view.group].map((column) => API_KEYS[column] ?? column);
  const header = [
    ...keyColumns,
    'label',
    'requests',
    'completed_requests',
    'failed_requests',
    'interrupted_requests',
    'billed_usd',
    'runs',
    'estimate_usd',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
  ];
  const lines = view.rows.map((row) =>
    [
      ...keyColumns.map((column) => row.key[column] ?? null),
      row.label,
      row.requests,
      row.completedRequests,
      row.failedRequests,
      row.interruptedRequests,
      row.billedUsd,
      row.runs,
      row.estimateUsd,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheCreationTokens,
    ]
      .map(csvField)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
