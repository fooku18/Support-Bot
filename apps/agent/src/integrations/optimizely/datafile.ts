import { OPTIMIZELY_SDK_KEY, type OptimizelyDatafile } from '../../contracts/tool-kinds.js';

export const OPTIMIZELY_ADAPTER = 'optimizely-datafile-v1';
const MAX_BYTES = 5_000_000;
const TIMEOUT_MS = 10_000;
const TTL_MS = 5 * 60_000;
const MAX_VALUE_CHARS = 2_000;
const MAX_MATCHES = 50;

export class OptimizelyReadError extends Error {
  override name = 'OptimizelyReadError';
}

interface Variable {
  id: string;
  key: string;
  type: string;
  defaultValue: string;
}
interface Variation {
  id: string;
  key: string;
  featureEnabled?: boolean;
  variables?: Array<{ id: string; value: string }>;
}
interface Rule {
  id: string;
  key: string;
  status: string;
  audienceIds?: string[];
  audienceConditions?: unknown;
  variations: Variation[];
  trafficAllocation: Array<{ entityId: string; endOfRange: number }>;
  forcedVariations?: Record<string, string>;
}
interface Flag {
  id: string;
  key: string;
  rolloutId: string;
  experimentIds: string[];
  variables: Variable[];
}
interface Audience {
  id: string;
  name: string;
  conditions: unknown;
}
interface Datafile {
  version: string;
  revision: string;
  projectId: string;
  environmentKey?: string;
  featureFlags: Flag[];
  experiments: Rule[];
  groups?: Array<{ id: string; experiments?: Rule[] }>;
  rollouts: Array<{ id: string; experiments: Rule[] }>;
  audiences: Audience[];
  typedAudiences?: Audience[];
  events: Array<{ id: string; key: string }>;
}

export interface LoadedDatafile {
  name: string;
  environment: string;
  fetchedAt: number;
  data: Datafile;
}

async function readCapped(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > MAX_BYTES) throw new OptimizelyReadError('the datafile is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseDatafile(text: string): Datafile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OptimizelyReadError('the datafile is not valid JSON');
  }
  const d = value as Partial<Datafile> | null;
  if (!d || typeof d !== 'object' || d.version !== '4' || !wellFormed(d))
    throw new OptimizelyReadError('the datafile is not an Optimizely v4 datafile');
  return d as Datafile;
}

const list = (value: unknown, item: (entry: never) => boolean) =>
  Array.isArray(value) &&
  value.every((entry) => !!entry && typeof entry === 'object' && item(entry as never));
const named = (entry: { key?: unknown; id?: unknown }) =>
  typeof entry.key === 'string' && typeof entry.id === 'string';
const rule = (r: Partial<Rule>) =>
  named(r) &&
  typeof r.status === 'string' &&
  list(
    r.trafficAllocation,
    (t: { entityId?: unknown; endOfRange?: unknown }) => typeof t.endOfRange === 'number',
  ) &&
  list(
    r.variations,
    (v: Partial<Variation>) =>
      named(v) && (v.variables === undefined || Array.isArray(v.variables)),
  );
const audience = (a: Partial<Audience>) => typeof a.id === 'string' && typeof a.name === 'string';

function wellFormed(d: Partial<Datafile>): boolean {
  return (
    list(
      d.featureFlags,
      (f: Partial<Flag>) =>
        named(f) &&
        typeof f.rolloutId === 'string' &&
        Array.isArray(f.experimentIds) &&
        list(f.variables, (v: Partial<Variable>) => named(v) && typeof v.defaultValue === 'string'),
    ) &&
    list(d.experiments, rule) &&
    (d.groups === undefined ||
      list(
        d.groups,
        (g: { experiments?: unknown }) => g.experiments === undefined || list(g.experiments, rule),
      )) &&
    list(
      d.rollouts,
      (r: { id?: unknown; experiments?: unknown }) =>
        typeof r.id === 'string' && list(r.experiments, rule),
    ) &&
    list(d.audiences, audience) &&
    (d.typedAudiences === undefined || list(d.typedAudiences, audience)) &&
    list(d.events, named) &&
    typeof d.revision === 'string' &&
    typeof d.projectId === 'string'
  );
}

export class DatafileReader {
  private readonly cache = new Map<string, { at: number; data: Promise<Datafile> }>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async load(ref: OptimizelyDatafile, signal: AbortSignal): Promise<LoadedDatafile> {
    if (!OPTIMIZELY_SDK_KEY.test(ref.sdkKey)) throw new OptimizelyReadError('invalid SDK key');
    const now = this.now();
    let entry = this.cache.get(ref.sdkKey);
    if (!entry || now - entry.at >= TTL_MS) {
      const fresh = { at: now, data: this.fetchDatafile(ref) };
      this.cache.set(ref.sdkKey, fresh);
      fresh.data.catch(() => {
        if (this.cache.get(ref.sdkKey) === fresh) this.cache.delete(ref.sdkKey);
      });
      entry = fresh;
    }
    const data = await abortable(entry.data, signal);
    return {
      name: ref.name,
      environment: data.environmentKey ?? 'unknown',
      fetchedAt: entry.at,
      data,
    };
  }

  private async fetchDatafile(ref: OptimizelyDatafile): Promise<Datafile> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://cdn.optimizely.com/datafiles/${ref.sdkKey}.json`, {
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new OptimizelyReadError(`the datafile "${ref.name}" could not be fetched`);
    }
    if (!response.ok)
      throw new OptimizelyReadError(
        `the datafile "${ref.name}" could not be fetched (HTTP ${response.status})`,
      );
    return parseDatafile(await readCapped(response));
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const cap = (value: string) =>
  value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}… (truncated)` : value;

function audienceMap(d: Datafile): Map<string, Audience> {
  const map = new Map<string, Audience>();
  for (const a of d.audiences) map.set(a.id, a);
  for (const a of d.typedAudiences ?? []) map.set(a.id, a);
  return map;
}

const PERSONAL_ATTRIBUTE =
  /(?:user|customer|visitor|client|device)[-_ ]?id$|e-?mail|phone|ip[-_ ]?address/i;

function leafText(leaf: Record<string, unknown>): string {
  const name = String(leaf.name ?? '?');
  const match = typeof leaf.match === 'string' ? leaf.match : 'exact';
  if (match === 'exists') return `${name} exists`;
  if (PERSONAL_ATTRIBUTE.test(name)) return `${name} ${match} <hidden>`;
  return `${name} ${match} ${JSON.stringify(leaf.value)}`;
}

const OPERATORS = ['and', 'or', 'not'];

function treeText(node: unknown, leaf: (value: unknown) => string): string {
  if (!Array.isArray(node)) return leaf(node);
  const [head, ...rest] = node as unknown[];
  const explicit = typeof head === 'string' && OPERATORS.includes(head);
  const op = explicit ? head : 'or';
  const items = (explicit ? rest : node).map((child) => treeText(child, leaf));
  if (op === 'not') return `NOT (${items.join(' AND ')})`;
  if (items.length === 1) return items[0] as string;
  return `(${items.join(op === 'and' ? ' AND ' : ' OR ')})`;
}

function audienceConditionText(audience: Audience): string {
  let conditions = audience.conditions;
  if (typeof conditions === 'string') {
    try {
      conditions = JSON.parse(conditions);
    } catch {
      return 'unreadable conditions';
    }
  }
  return treeText(conditions, (value) =>
    value && typeof value === 'object' ? leafText(value as Record<string, unknown>) : String(value),
  );
}

function ruleView(rule: Rule, flag: Flag, audiences: Map<string, Audience>, type: string) {
  const ids = new Set<string>();
  const conditions =
    rule.audienceConditions ??
    (rule.audienceIds && rule.audienceIds.length > 0 ? ['or', ...rule.audienceIds] : []);
  const audience =
    Array.isArray(conditions) && conditions.length === 0
      ? 'everyone'
      : treeText(conditions, (id) => {
          const key = String(id);
          ids.add(key);
          return audiences.get(key)?.name ?? `audience ${key}`;
        });
  const variable = new Map(flag.variables.map((v) => [v.id, v.key]));
  let previous = 0;
  const traffic = rule.trafficAllocation.map((slot) => {
    const percent = (slot.endOfRange - previous) / 100;
    previous = slot.endOfRange;
    return {
      variation: rule.variations.find((v) => v.id === slot.entityId)?.key ?? 'unallocated',
      percent,
    };
  });
  return {
    type,
    key: rule.key,
    id: rule.id,
    status: rule.status,
    audience,
    audiences: [...ids].map((id) => {
      const a = audiences.get(id);
      return a
        ? { id, name: a.name, conditions: audienceConditionText(a) }
        : { id, name: null, conditions: 'not in this datafile' };
    }),
    allocatedPercent: previous / 100,
    traffic,
    variations: rule.variations.map((v) => ({
      key: v.key,
      id: v.id,
      featureEnabled: v.featureEnabled ?? null,
      variableOverrides: Object.fromEntries(
        (v.variables ?? []).map((x) => [variable.get(x.id) ?? x.id, cap(x.value)]),
      ),
    })),
    whitelistedUsers: Object.keys(rule.forcedVariations ?? {}).length,
  };
}

function allExperiments(d: Datafile): Rule[] {
  return [...d.experiments, ...(d.groups ?? []).flatMap((g) => g.experiments ?? [])];
}

function flagRules(d: Datafile, flag: Flag) {
  const experiments = new Map(allExperiments(d).map((e) => [e.id, e]));
  return {
    experiments: flag.experimentIds.flatMap((id) => experiments.get(id) ?? []),
    delivery: d.rollouts.find((r) => r.id === flag.rolloutId)?.experiments ?? [],
  };
}

function flagView(file: LoadedDatafile, flag: Flag) {
  const d = file.data;
  const audiences = audienceMap(d);
  const { experiments, delivery } = flagRules(d, flag);
  const rules = [
    ...experiments.map((rule) => ruleView(rule, flag, audiences, 'experiment')),
    ...delivery.map((rule, index) =>
      ruleView(
        rule,
        flag,
        audiences,
        index === delivery.length - 1 ? 'everyone else' : 'delivery rule',
      ),
    ),
  ];
  return {
    datafile: file.name,
    environment: file.environment,
    projectId: d.projectId,
    revision: d.revision,
    fetchedAt: new Date(file.fetchedAt).toISOString(),
    flag: flag.key,
    variables: flag.variables.map((v) => ({
      key: v.key,
      type: v.type,
      default: cap(v.defaultValue),
    })),
    rules,
  };
}

function owners(d: Datafile, value: string): Flag[] {
  const hits = (rule: Rule) =>
    rule.key === value || rule.id === value || rule.variations.some((v) => v.id === value);
  return d.featureFlags.filter((flag) => {
    const { experiments, delivery } = flagRules(d, flag);
    return experiments.some(hits) || delivery.some(hits);
  });
}

function listDatafiles(files: LoadedDatafile[]) {
  return files.map((file) => ({
    datafile: file.name,
    environment: file.environment,
    projectId: file.data.projectId,
    revision: file.data.revision,
    fetchedAt: new Date(file.fetchedAt).toISOString(),
    flags: file.data.featureFlags.length,
    experiments: allExperiments(file.data).length,
  }));
}

function search(files: LoadedDatafile[], query: string) {
  const q = query.toLowerCase();
  const matches: Array<Record<string, string>> = [];
  let total = 0;
  const push = (entry: Record<string, string>) => {
    total += 1;
    if (matches.length < MAX_MATCHES) matches.push(entry);
  };
  for (const file of files) {
    const d = file.data;
    const where = { datafile: file.name, environment: file.environment };
    for (const flag of d.featureFlags)
      if (flag.key.toLowerCase().includes(q)) push({ ...where, type: 'flag', key: flag.key });
    const rules = [
      ...allExperiments(d).map((rule) => ({ rule, type: 'experiment' })),
      ...d.rollouts.flatMap((r) => r.experiments.map((rule) => ({ rule, type: 'delivery rule' }))),
    ];
    for (const { rule, type } of rules)
      if (rule.key.toLowerCase().includes(q) || rule.id === query)
        push({ ...where, type, key: rule.key, id: rule.id });
    for (const a of audienceMap(d).values())
      if (a.name.toLowerCase().includes(q))
        push({ ...where, type: 'audience', key: a.name, id: a.id });
    for (const e of d.events)
      if (e.key.toLowerCase().includes(q)) push({ ...where, type: 'event', key: e.key });
  }
  return { matches, total, truncated: total > matches.length };
}

const ABSENT =
  'Not present in these datafile revisions. A flag key the SDK cannot find ("Feature key … is not in datafile") is usually archived or deleted in that environment; the SDK then treats the flag as off. The datafile cannot tell which, or when.';

export function lookupOptimizely(files: LoadedDatafile[], query: string) {
  const value = query.trim();
  if (value.length === 0) return { datafiles: listDatafiles(files) };
  const absentIn: string[] = [];
  const flags = files.flatMap((file) => {
    const exact = file.data.featureFlags.filter((f) => f.key === value);
    const found = exact.length > 0 ? exact : owners(file.data, value);
    if (found.length === 0) absentIn.push(`${file.name} (${file.environment})`);
    return found.map((flag) => flagView(file, flag));
  });
  if (flags.length > 0) return { found: true, flags, absentIn };
  const result = search(files, value);
  return {
    found: false,
    ...result,
    ...(result.total === 0 ? { note: ABSENT } : {}),
  };
}

const MAX_OUTPUT_BYTES = 48_000;

export async function readOptimizely(
  reader: DatafileReader,
  datafiles: OptimizelyDatafile[],
  query: unknown,
  signal: AbortSignal,
): Promise<{ output: string; data: unknown }> {
  if (typeof query !== 'string' || query.length > 200)
    throw new OptimizelyReadError('query must be a string of at most 200 characters');
  const settled = await Promise.allSettled(datafiles.map((ref) => reader.load(ref, signal)));
  signal.throwIfAborted();
  const files = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const failed = settled.flatMap((s, i) =>
    s.status === 'rejected' ? [`${datafiles[i]!.name}: ${reason(s.reason)}`] : [],
  );
  if (files.length === 0) throw new OptimizelyReadError(failed.join('; ') || 'no datafile');
  const result: Record<string, unknown> = lookupOptimizely(files, query);
  if (failed.length > 0) {
    result.unavailable = failed;
    if ('note' in result)
      result.note =
        'Not found in the datafiles that loaded. Other datafiles were unavailable, so the key may exist there; do not call it archived.';
  }
  let output = JSON.stringify(result);
  const flags = result.flags as unknown[] | undefined;
  while (Buffer.byteLength(output) > MAX_OUTPUT_BYTES && flags && flags.length > 1) {
    flags.pop();
    result.truncated = 'more flags matched; ask for one flag key';
    output = JSON.stringify(result);
  }
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES)
    throw new OptimizelyReadError('the answer is too large; ask for one flag key');
  return { output, data: result };
}

const reason = (error: unknown) =>
  error instanceof OptimizelyReadError ? error.message : 'the datafile could not be read';
