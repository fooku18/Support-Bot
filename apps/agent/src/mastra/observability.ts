import { ConsoleLogger, LogLevel } from '@mastra/core/logger';
import {
  SPAN_OUTCOMES,
  SPAN_STOP_REASONS,
  SpanType,
  type AnyExportedSpan,
} from '@mastra/core/observability';
import { Observability } from '@mastra/observability';

const events = new Set(['native.segment.started', 'native.segment.ended', 'native.segment.failed']);
const outcomes = new Set<string>(SPAN_OUTCOMES);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const traceId = /^[a-f0-9]{32}$/i;
const spanId = /^[a-f0-9]{16}$/i;
const counts = new Set(['durationMs', 'inputTokens', 'outputTokens', 'totalTokens', 'errorCount']);

function safeField(key: string, value: unknown): boolean {
  if (counts.has(key)) return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (typeof value !== 'string') return false;
  if (key === 'runId') return uuid.test(value);
  if (key === 'traceId') return traceId.test(value);
  if (key === 'spanId') return spanId.test(value);
  return key === 'outcome' && outcomes.has(value);
}

/** Validate the entire console record, including children; never inspect arbitrary payloads.
 * ConsoleLogger's own filter exception handling is fail-open, so catch locally. */
export const safeLogFilter: NonNullable<
  ConstructorParameters<typeof ConsoleLogger>[0]
>['filter'] = (record) => {
  try {
    if (record.component !== undefined || !events.has(record.message)) return false;
    if (record.args.length === 0) return true;
    if (record.args.length !== 1) return false;
    const fields: unknown = record.args[0];
    if (!fields || typeof fields !== 'object' || Object.getPrototypeOf(fields) !== Object.prototype)
      return false;
    return Reflect.ownKeys(fields).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(fields, key);
      return (
        typeof key === 'string' &&
        !!descriptor &&
        'value' in descriptor &&
        safeField(key, descriptor.value)
      );
    });
  } catch {
    return false;
  }
};

/** Exporter formatter covers start/update/end, including derived correlation fields.
 * This is deliberately a projection rather than a secret-name blacklist. It does
 * NOT sanitize native metrics or logs, which bypass customSpanFormatter. */
export function contentFreeSpan(span: AnyExportedSpan): AnyExportedSpan {
  const usage = span.attributes && 'usage' in span.attributes ? span.attributes.usage : undefined;
  const tokens = Object.fromEntries(
    Object.entries(usage ?? {}).filter(
      ([key, value]) =>
        ['inputTokens', 'outputTokens', 'totalTokens'].includes(key) && safeField(key, value),
    ),
  );
  return {
    id: spanId.test(span.id) ? span.id : '0000000000000000',
    traceId: traceId.test(span.traceId) ? span.traceId : '00000000000000000000000000000000',
    parentSpanId:
      span.parentSpanId && spanId.test(span.parentSpanId) ? span.parentSpanId : undefined,
    name: Object.values(SpanType).includes(span.type) ? span.type : SpanType.GENERIC,
    type: span.type,
    startTime: span.startTime,
    endTime: span.endTime,
    isEvent: span.isEvent,
    isRootSpan: span.isRootSpan,
    attributes: { usage: tokens },
    metadata: safeField('runId', span.metadata?.runId) ? { runId: span.metadata!.runId } : {},
    outcome: span.outcome && outcomes.has(span.outcome) ? span.outcome : undefined,
    stopReason:
      span.stopReason && Object.hasOwn(SPAN_STOP_REASONS, span.stopReason)
        ? span.stopReason
        : undefined,
    errorInfo: span.errorInfo ? { message: '[redacted]' } : undefined,
  };
}

/** Default for isolated harnesses and explicitly disabled telemetry. Enabling
 * persistence uses createPrivateDiagnostics and the separate VNext domain. */
export function createNativeDiagnostics() {
  return {
    logger: new ConsoleLogger({
      name: 'native-answer',
      level: LogLevel.INFO,
      filter: safeLogFilter,
    }),
    loggerOptions: { export: false, correlation: false },
    observability: new Observability({ configs: {} }),
  };
}
