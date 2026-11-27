export const MAX_CHARTS_PER_MESSAGE = 2;
const MAX_TITLE = 50;
const MAX_LABEL = 20;
const MAX_AXIS_LABEL = 50;
const MAX_SERIES = 12;
const MAX_POINTS = 20;
const TYPES = ['line', 'bar', 'area', 'pie'] as const;

export const CHART_NOT_SHOWN = '_Chart not shown: it does not fit Slack chart limits._';
export const CHARTS_OVER_LIMIT = `_Chart not shown: a reply shows at most ${MAX_CHARTS_PER_MESSAGE} charts._`;
export const CHART_REJECTED = '_Chart not shown: Slack did not accept it._';

export type ReplyPart =
  | { kind: 'text'; text: string }
  | { kind: 'chart'; title: string; block: Json };

type Json = Record<string, unknown>;

const FENCE = /^```chart[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function replyParts(text: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let charts = 0;
  let last = 0;
  const pushText = (value: string) => {
    if (value.trim()) parts.push({ kind: 'text', text: value.trim() });
  };
  for (const match of text.matchAll(FENCE)) {
    pushText(text.slice(last, match.index));
    last = match.index + match[0].length;
    const block = chartBlock(match[1] ?? '');
    if (!block) pushText(CHART_NOT_SHOWN);
    else if (charts >= MAX_CHARTS_PER_MESSAGE) pushText(CHARTS_OVER_LIMIT);
    else {
      charts++;
      parts.push({ kind: 'chart', title: block.title as string, block });
    }
  }
  pushText(text.slice(last));
  return mergeText(parts);
}

export function chartFreeText(parts: ReplyPart[], rejected = false): string {
  return parts
    .map((part) =>
      part.kind === 'text' ? part.text : rejected ? CHART_REJECTED : `[Chart: ${part.title}]`,
    )
    .join('\n\n');
}

export function hasCharts(parts: ReplyPart[]): boolean {
  return parts.some((part) => part.kind === 'chart');
}

export function withoutCharts(parts: ReplyPart[]): ReplyPart[] {
  return mergeText(
    parts.map((part) => (part.kind === 'chart' ? { kind: 'text', text: CHART_REJECTED } : part)),
  );
}

function mergeText(parts: ReplyPart[]): ReplyPart[] {
  const merged: ReplyPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.kind === 'text' && previous?.kind === 'text')
      merged[merged.length - 1] = { kind: 'text', text: `${previous.text}\n\n${part.text}` };
    else merged.push(part);
  }
  return merged;
}

export function chartBlock(source: string): Json | null {
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(spec)) return null;
  const type = spec.type;
  const title = spec.title;
  if (!TYPES.includes(type as (typeof TYPES)[number])) return null;
  if (!text(title, MAX_TITLE)) return null;
  const categories = spec.categories;
  if (
    !Array.isArray(categories) ||
    categories.length < 1 ||
    categories.length > MAX_POINTS ||
    !categories.every((c) => text(c, MAX_LABEL)) ||
    new Set(categories).size !== categories.length
  )
    return null;
  const series = spec.series;
  if (!Array.isArray(series) || series.length < 1 || series.length > MAX_SERIES) return null;
  const names = new Set<string>();
  for (const s of series) {
    if (!isRecord(s) || !text(s.name, MAX_LABEL) || names.has(s.name)) return null;
    names.add(s.name);
    if (
      !Array.isArray(s.values) ||
      s.values.length !== categories.length ||
      !s.values.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      return null;
  }
  const values = (s: Json) => s.values as number[];
  if (type === 'pie') {
    const only = series[0] as Json;
    if (series.length !== 1 || !values(only).every((v) => v > 0)) return null;
    return {
      type: 'data_visualization',
      title,
      chart: {
        type,
        segments: categories.map((label, i) => ({ label, value: values(only)[i] })),
      },
    };
  }
  const axis: Json = { categories };
  for (const key of ['x_label', 'y_label'] as const) {
    if (spec[key] === undefined) continue;
    if (!text(spec[key], MAX_AXIS_LABEL)) return null;
    axis[key] = spec[key];
  }
  return {
    type: 'data_visualization',
    title,
    chart: {
      type,
      series: (series as Json[]).map((s) => ({
        name: s.name,
        data: categories.map((label, i) => ({ label, value: values(s)[i] })),
      })),
      axis_config: axis,
    },
  };
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
