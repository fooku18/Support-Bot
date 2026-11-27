/** GENERATED from apps/agent/src/domain/delivery/slack-charts.ts; run npm run generate:protocol. */
export const CHART_LIMITS = {
  charts: 2,
  title: 50,
  label: 20,
  axisLabel: 50,
  series: 12,
  categories: 20,
} as const;
const TYPES = ['line', 'bar', 'area', 'pie'] as const;

export const CHART_NOT_SHOWN = '_Chart not shown._';

export const CHART_INSTRUCTIONS = `When a chart makes numbers clearer, or the requester asks for one, add up to ${CHART_LIMITS.charts} charts to the answer. Write each as a fenced code block with the language chart holding one JSON object: {"type":"${TYPES.join('"|"')}","title":"...","categories":["..."],"series":[{"name":"...","values":[1.5]}],"x_label":"...","y_label":"..."}. Each series has one number per category, in order; x_label and y_label are optional. Limits: title ${CHART_LIMITS.title} characters, category and series names ${CHART_LIMITS.label} characters each, at most ${CHART_LIMITS.categories} categories and ${CHART_LIMITS.series} series; a pie has one series of positive values. Aggregate or pick a window to stay within the limits and keep the key numbers in the text too. Slack shows the chart in place of the block.`;

type Json = Record<string, unknown>;
export type ChartBlock = { type: 'data_visualization'; title: string; chart: Json };
export type ReplyPart = { kind: 'text'; text: string } | { kind: 'chart'; block: ChartBlock };

const OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function replyParts(text: string): ReplyPart[] {
  if (!text.includes('```chart')) return [{ kind: 'text', text }];
  const lines = text.split('\n');
  const parts: ReplyPart[] = [];
  let charts = 0;
  let pending: string[] = [];
  const flush = () => {
    const value = pending
      .join('\n')
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .trimEnd();
    if (value) parts.push({ kind: 'text', text: value });
    pending = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const open = OPENING.exec(line);
    if (!open) {
      pending.push(line);
      continue;
    }
    const marker = open[1] ?? '';
    const close = lines.findIndex((candidate, j) => j > i && isClosing(candidate, marker));
    if (close < 0) {
      pending.push(...lines.slice(i));
      break;
    }
    if (marker !== '```' || (open[2] ?? '').trim() !== 'chart') {
      pending.push(...lines.slice(i, close + 1));
      i = close;
      continue;
    }
    flush();
    const block = chartBlock(lines.slice(i + 1, close).join('\n'));
    if (!block || charts >= CHART_LIMITS.charts) pending.push(CHART_NOT_SHOWN, '');
    else {
      charts++;
      parts.push({ kind: 'chart', block });
    }
    i = close;
  }
  flush();
  return parts.length ? mergeText(parts) : [{ kind: 'text', text }];
}

function isClosing(line: string, marker: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line)?.[1];
  return close !== undefined && close[0] === marker[0] && close.length >= marker.length;
}

export function chartFreeText(parts: ReplyPart[]): string {
  return parts
    .map((part) => (part.kind === 'text' ? part.text : `[Chart: ${part.block.title}]`))
    .join('\n\n');
}

export function hasCharts(parts: ReplyPart[]): boolean {
  return parts.some((part) => part.kind === 'chart');
}

export function withoutCharts(parts: ReplyPart[]): ReplyPart[] {
  return mergeText(
    parts.map((part) => (part.kind === 'chart' ? { kind: 'text', text: CHART_NOT_SHOWN } : part)),
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

export function chartBlock(source: string): ChartBlock | null {
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(spec)) return null;
  const { type, title, categories, series } = spec;
  if (!TYPES.includes(type as (typeof TYPES)[number]) || !text(title, CHART_LIMITS.title))
    return null;
  if (
    !Array.isArray(categories) ||
    categories.length < 1 ||
    categories.length > CHART_LIMITS.categories ||
    !categories.every((c) => text(c, CHART_LIMITS.label)) ||
    new Set(categories).size !== categories.length
  )
    return null;
  if (!Array.isArray(series) || series.length < 1 || series.length > CHART_LIMITS.series)
    return null;
  const named: Array<{ name: string; values: number[] }> = [];
  for (const s of series) {
    if (
      !isRecord(s) ||
      !text(s.name, CHART_LIMITS.label) ||
      !Array.isArray(s.values) ||
      s.values.length !== categories.length ||
      !s.values.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      return null;
    named.push({ name: s.name, values: s.values });
  }
  if (new Set(named.map((s) => s.name)).size !== named.length) return null;
  const points = (values: number[]) => categories.map((label, i) => ({ label, value: values[i] }));
  let chart: Json;
  if (type === 'pie') {
    const [only] = named;
    if (named.length !== 1 || !only?.values.every((v) => v > 0)) return null;
    chart = { type, segments: points(only.values) };
  } else {
    const axis: Json = { categories };
    for (const key of ['x_label', 'y_label'] as const) {
      if (spec[key] === undefined) continue;
      if (!text(spec[key], CHART_LIMITS.axisLabel)) return null;
      axis[key] = spec[key];
    }
    chart = {
      type,
      series: named.map((s) => ({ name: s.name, data: points(s.values) })),
      axis_config: axis,
    };
  }
  return { type: 'data_visualization', title, chart };
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
