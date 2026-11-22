import type { ModelRoute } from '../contracts/model-catalog.js';
import { createHash } from 'node:crypto';
import { ConsoleLogger, LogLevel } from '@mastra/core/logger';
import {
  EntityType,
  type AnyExportedSpan,
  type CorrelationContext,
  type LogEvent,
  type MetricEvent,
} from '@mastra/core/observability';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { contentFreeSpan, safeLogFilter } from './observability.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const trace = /^[a-f0-9]{32}$/i;
const span = /^[a-f0-9]{16}$/i;
const agentNames: Record<string, string> = { answer: 'Answer', coding: 'Coding' };
const metricNames = new Set([
  'mastra_agent_duration_ms',
  'mastra_model_duration_ms',
  'mastra_model_input_audio_tokens',
  'mastra_model_input_cache_read_tokens',
  'mastra_model_input_cache_write_tokens',
  'mastra_model_input_image_tokens',
  'mastra_model_input_text_tokens',
  'mastra_model_output_audio_tokens',
  'mastra_model_output_image_tokens',
  'mastra_model_output_reasoning_tokens',
  'mastra_model_output_text_tokens',
  'mastra_model_total_input_tokens',
  'mastra_model_total_output_tokens',
  'mastra_processor_duration_ms',
  'mastra_tool_duration_ms',
  'mastra_workflow_duration_ms',
]);
const messages = new Set([
  'studio.request.started',
  'studio.request.completed',
  'studio.request.failed',
  'studio.ready',
  'native.segment.started',
  'native.segment.ended',
  'native.segment.failed',
]);
const safeId = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;
export interface DiagnosticsSource {
  source: 'studio' | 'slack';
  route?: ModelRoute;
  correlation?: Pick<CorrelationContext, 'runId' | 'threadId' | 'resourceId'>;
}
function context(options: DiagnosticsSource, value?: CorrelationContext): CorrelationContext {
  const correlation = { ...value, ...options.correlation };
  const hash = (kind: string, value?: string) =>
    value
      ? `${options.source}:${kind}:${createHash('sha256').update(`${kind}:${value}`).digest('hex')}`
      : undefined;
  const id =
    value?.entityId && Object.hasOwn(agentNames, value.entityId) ? value.entityId : undefined;
  const root =
    value?.rootEntityId && Object.hasOwn(agentNames, value.rootEntityId)
      ? value.rootEntityId
      : undefined;
  return {
    serviceName: options.source === 'slack' ? 'support-agent-slack' : 'support-agent-studio',
    ...(id ? { entityId: id, entityType: EntityType.AGENT, entityName: agentNames[id] } : {}),
    ...(root
      ? { rootEntityId: root, rootEntityType: EntityType.AGENT, rootEntityName: agentNames[root] }
      : {}),
    runId: safeId(correlation.runId, uuid),
    threadId:
      options.source === 'slack'
        ? hash('thread', correlation.threadId)
        : safeId(correlation.threadId, uuid),
    resourceId:
      options.source === 'slack'
        ? hash('resource', correlation.resourceId)
        : safeId(correlation.resourceId, /^studio:[a-f0-9]{64}$/),
  };
}

/** The official exporter owns buffering, persistence and retries. This projection
 * closes its documented log/metric formatter gap; no payloads or arbitrary
 * metadata reach Studio storage. Application delivery receipts stay authoritative. */
class PrivateStorageExporter extends MastraStorageExporter {
  private flushWork?: Promise<void>;
  private completionExpired = false;
  private reportedFailure = false;

  constructor(
    private readonly models: Set<string>,
    private readonly options: DiagnosticsSource,
  ) {
    super({
      customSpanFormatter: (value) => this.projectSpan(value),
      maxBatchWaitMs: 1000,
      // In the pinned exporter only byte batching drains requeued final events
      // during flush/shutdown. Mastra owns batching, backoff and retry exhaustion.
      byteBatching: { maxConcurrentWrites: 1 },
      maxRetries: 2,
      retryDelayMs: 100,
    });
  }
  private reportIncomplete() {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    // Bypass the telemetry logger/storage and never include an error, query,
    // correlation ID or payload. This says nothing about execution or delivery.
    console.error('telemetry export incomplete; persistence unconfirmed');
  }
  onDroppedEvent() {
    this.reportIncomplete();
  }
  override flush(): Promise<void> {
    if (this.completionExpired) return Promise.resolve();
    return (this.flushWork ??= this.completeFlush().finally(() => {
      this.flushWork = undefined;
    }));
  }
  private async completeFlush() {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Mastra's drainTimeout covers workers, not exporter completion. The
      // separate PG pool bounds underlying writes; this deadline also bounds
      // the total official drain across batches/retries before admission release.
      await Promise.race([
        super.flush(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('telemetry completion deadline')), 10000);
        }),
      ]);
    } catch {
      this.completionExpired = true;
      this.setDisabled('telemetry completion deadline');
      this.reportIncomplete();
    } finally {
      clearTimeout(timer);
    }
  }
  private model(value: unknown) {
    return typeof value === 'string' && this.models.has(value) ? value : undefined;
  }
  private projectSpan(value: AnyExportedSpan): AnyExportedSpan {
    const base = contentFreeSpan(value);
    const entity = context(this.options, {
      entityId: value.entityId,
      rootEntityId: value.rootEntityId,
      threadId: value.metadata?.threadId,
      runId: value.metadata?.runId,
      resourceId: value.metadata?.resourceId,
    });
    const attrs = value.attributes as Record<string, unknown> | undefined;
    const model = this.model(attrs?.model);
    return {
      ...base,
      entityId: entity.entityId,
      entityType: entity.entityType,
      entityName: entity.entityName,
      rootEntityId: entity.rootEntityId,
      rootEntityType: entity.rootEntityType,
      rootEntityName: entity.rootEntityName,
      serviceName: entity.serviceName,
      metadata: {
        runId: entity.runId,
        threadId: entity.threadId,
        resourceId: entity.resourceId,
      },
      attributes: {
        ...base.attributes,
        ...(model ? { model, provider: this.options.route ?? 'anthropic' } : {}),
      },
    } as AnyExportedSpan;
  }
  override async onMetricEvent(event: MetricEvent) {
    if (this.completionExpired) return;
    const m = event.metric;
    if (!metricNames.has(m.name) || !Number.isFinite(m.value) || m.value < 0) return;
    const model = this.model(m.costContext?.model ?? m.labels.model);
    await super.onMetricEvent({
      type: 'metric',
      metric: {
        metricId: safeId(m.metricId, uuid) ?? crypto.randomUUID(),
        timestamp: m.timestamp,
        name: m.name,
        value: m.value,
        traceId: safeId(m.traceId, trace),
        spanId: safeId(m.spanId, span),
        usageId: safeId(m.usageId, uuid),
        labels: ['ok', 'error'].includes(m.labels.status ?? '') ? { status: m.labels.status! } : {},
        correlationContext: context(this.options, m.correlationContext),
        ...(model ? { costContext: { model, provider: this.options.route ?? 'anthropic' } } : {}),
      },
    });
  }
  override async onLogEvent(event: LogEvent) {
    if (this.completionExpired) return;
    const l = event.log;
    await super.onLogEvent({
      type: 'log',
      log: {
        logId: safeId(l.logId, uuid) ?? crypto.randomUUID(),
        timestamp: l.timestamp,
        level: l.level,
        message: messages.has(l.message) ? l.message : 'Framework event (content omitted)',
        traceId: safeId(l.traceId, trace),
        spanId: safeId(l.spanId, span),
        correlationContext: context(this.options, l.correlationContext),
      },
    });
  }
}

export function createPrivateDiagnostics(models: string[], options: DiagnosticsSource) {
  const allowedModels = new Set(
    models.flatMap((model) => [model, model.replace(/^anthropic\//, '')]),
  );
  return {
    logger: new ConsoleLogger({
      name: options.source === 'slack' ? 'support-agent-slack' : 'support-agent-studio',
      level: LogLevel.INFO,
      filter:
        options.source === 'slack'
          ? safeLogFilter
          : (record) => messages.has(record.message) && record.args.length === 0,
    }),
    loggerOptions: { export: true, correlation: true },
    observability: new Observability({
      configs: {
        default: {
          serviceName: options.source === 'slack' ? 'support-agent-slack' : 'support-agent-studio',
          exporters: [new PrivateStorageExporter(allowedModels, options)],
          logging: { enabled: true, level: 'info' },
        },
      },
    }),
  };
}

export const createStudioDiagnostics = (models: string[], route?: ModelRoute) =>
  createPrivateDiagnostics(models, { source: 'studio', route });
