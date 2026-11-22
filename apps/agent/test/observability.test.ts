import { afterEach, expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import { SpanType } from '@mastra/core/observability';
import { InMemoryStore } from '@mastra/core/storage';
import { createPrivateDiagnostics } from '../src/mastra/studio-observability.js';
import { createNativeDiagnostics } from '../src/mastra/observability.js';

const marker = 'SYNTHETIC_PRIVATE_CONTENT_115';
const runId = '00000000-0000-4000-8000-000000000115';
const privateData = {
  messages: [{ role: 'user' as const, content: marker }],
  instructions: marker,
  toolArguments: { query: marker },
  toolResult: marker,
  fileBytes: Buffer.from(marker),
  token: marker,
  endpoint: `https://${marker}.internal.test`,
};

afterEach(() => vi.restoreAllMocks());

async function fixture(tracing?: boolean) {
  const storage = new InMemoryStore();
  const diagnostics = tracing
    ? createPrivateDiagnostics([], { source: 'slack' })
    : createNativeDiagnostics();
  const mastra = new Mastra({
    storage,
    ...diagnostics,
    recovery: { durableAgents: 'off', workflows: 'off' },
  });
  const domain = (await storage.getStore('observability'))!;
  const instance = diagnostics.observability.getDefaultInstance()!;
  return { ...diagnostics, mastra, domain, instance };
}

it('defaults to no destinations, no persisted telemetry and no sampled spans', async () => {
  const f = await fixture();
  const creates = vi.spyOn(f.domain, 'batchCreateSpans');
  const metrics = vi.spyOn(f.domain, 'batchCreateMetrics');
  const logs = vi.spyOn(f.domain, 'batchCreateLogs');
  try {
    expect(f.instance).toBeUndefined();
    expect(f.observability.listInstances().size).toBe(0);
    f.logger.error(marker, privateData);
    f.logger.trackException(new Error(marker), privateData);
    await f.observability.flush();
    expect(creates).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  } finally {
    await f.observability.shutdown();
  }
});

it('logs only bounded native segment events with safe IDs, outcomes and numeric usage', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { logger } = createNativeDiagnostics();
  const facts = { runId, durationMs: 25, inputTokens: 10, outputTokens: 5, outcome: 'success' };
  logger.info('native.segment.ended', facts);
  logger.warn('native.segment.failed', { runId, outcome: 'unknown' });
  logger.error('native.segment.failed', { runId, errorCount: 1 });
  expect(info.mock.calls).toEqual([['native.segment.ended', facts]]);
  expect(warn.mock.calls).toEqual([['native.segment.failed', { runId, outcome: 'unknown' }]]);
  expect(error.mock.calls).toEqual([['native.segment.failed', { runId, errorCount: 1 }]]);
});

it('rejects free text, payloads, errors, unknown fields, child prefixes and unsafe scalar values', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const { logger } = createNativeDiagnostics();
  logger.info(marker, privateData);
  logger.info('native.segment.ended', privateData);
  logger.info('native.segment.ended', { runId: marker });
  logger.info('native.segment.ended', { outcome: marker });
  logger.info('native.segment.ended', { durationMs: Infinity });
  logger.info('native.segment.ended', { inputTokens: -1 });
  logger.info('native.segment.ended', new Error(marker));
  logger.info('native.segment.ended', { [marker]: marker });
  logger.info('native.segment.ended', { [Symbol(marker)]: marker });
  logger.info('native.segment.ended', {
    get runId() {
      throw new Error(marker);
    },
  });
  logger.info(
    'native.segment.ended',
    new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(marker);
        },
      },
    ),
  );
  logger.child({ component: marker }).info('native.segment.ended', { runId });
  expect(info).not.toHaveBeenCalled();
});

it('projects every native storage export lifecycle, including updates, previews and child spans', async () => {
  const f = await fixture(true);
  const creates = vi.spyOn(f.domain, 'batchCreateSpans');
  const updates = vi.spyOn(f.domain, 'batchUpdateUnendedSpans');
  const inspectWrites = () => {
    const bytes = JSON.stringify([creates.mock.calls, updates.mock.calls]);
    expect(bytes).not.toContain(marker);
    expect(bytes).not.toContain(Buffer.from(marker).toString('base64'));
    expect(bytes).not.toContain('internal.test');
    return bytes;
  };
  try {
    const root = f.instance.startSpan({
      type: SpanType.AGENT_RUN,
      name: marker,
      entityId: marker,
      entityName: marker,
      input: privateData,
      metadata: { ...privateData, runId, entityVersionId: marker, notes: marker },
      tags: [marker],
    });
    await f.observability.flush();
    expect(creates).toHaveBeenCalled();
    inspectWrites();

    root.update({
      output: { object: privateData },
      metadata: { instructions: marker },
      outcome: 'success',
    });
    await f.observability.flush();
    expect(updates).toHaveBeenCalled();
    inspectWrites();

    const model = root.createChildSpan({
      type: SpanType.MODEL_GENERATION,
      name: marker,
      input: privateData,
      attributes: { model: marker, provider: marker, usage: { inputTokens: 10, outputTokens: 5 } },
    });
    model.update({ output: { object: privateData }, metadata: privateData });
    model.end({
      output: { object: privateData },
      attributes: { usage: { inputTokens: 10, outputTokens: 5 } },
    });
    const tool = root.createChildSpan({
      type: SpanType.TOOL_CALL,
      name: marker,
      input: privateData,
      attributes: { toolCallId: marker, toolDescription: marker },
    });
    tool.end({ output: privateData, outcome: 'unknown' });
    root.error({ error: new Error(marker), endSpan: true });
    await f.observability.flush();
    const writes = inspectWrites();
    expect(writes).toContain(runId);
    expect(writes).toContain('inputTokens');
    expect(writes).toContain('startedAt');
    expect(writes).toContain('endedAt');
    const trace = await f.domain.getTrace({ traceId: root.traceId });
    expect(trace?.spans).toHaveLength(3);
    expect(JSON.stringify(trace)).not.toContain(marker);
    expect(trace?.spans.find((span) => span.spanId === model.id)?.attributes).toEqual({
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  } finally {
    await f.observability.shutdown();
  }
});

it('projects logger adapter and loggerVNext exports independently of the console filter', async () => {
  const f = await fixture(true);
  const logs = vi.spyOn(f.domain, 'batchCreateLogs');
  try {
    f.mastra.getLogger().error(marker, privateData);
    f.mastra.getLogger().trackException(new Error(marker), privateData);
    f.instance.getLoggerContext!().error(marker, privateData);
    await f.observability.flush();
    expect(logs).toHaveBeenCalled();
    expect(JSON.stringify(logs.mock.calls)).not.toContain(marker);
  } finally {
    await f.observability.shutdown();
  }
});

it('projects derived metrics that bypass the framework span formatter', async () => {
  const f = await fixture(true);
  const metrics = vi.spyOn(f.domain, 'batchCreateMetrics');
  try {
    const span = f.instance.startSpan({
      type: SpanType.AGENT_RUN,
      name: 'synthetic-only',
      metadata: { notes: marker },
    });
    span.end();
    await f.observability.flush();
    expect(metrics).toHaveBeenCalled();
    // The official exporter derives metrics before the span formatter; the
    // separate metric projection must close that path too.
    expect(JSON.stringify(metrics.mock.calls)).not.toContain(marker);
  } finally {
    await f.observability.shutdown();
  }
});
