import { expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import { EntityType, SpanType } from '@mastra/core/observability';
import { InMemoryStore } from '@mastra/core/storage';
import { createStudioDiagnostics } from '../src/mastra/studio-observability.js';

it('persists native traces, metrics and logs without conversation or arbitrary metadata', async () => {
  const marker = 'PRIVATE_STUDIO_TEST_115';
  const storage = new InMemoryStore();
  const diagnostics = createStudioDiagnostics(['anthropic/test-model']);
  const mastra = new Mastra({
    storage,
    ...diagnostics,
    recovery: { durableAgents: 'off', workflows: 'off' },
  });
  const domain = (await storage.getStore('observability'))!;
  const spans = vi.spyOn(domain, 'batchCreateSpans');
  const updates = vi.spyOn(domain, 'batchUpdateUnendedSpans');
  const metrics = vi.spyOn(domain, 'batchCreateMetrics');
  const logs = vi.spyOn(domain, 'batchCreateLogs');
  try {
    const instance = diagnostics.observability.getDefaultInstance()!;
    const span = instance.startSpan({
      type: SpanType.AGENT_RUN,
      name: marker,
      entityId: 'answer',
      entityType: EntityType.AGENT,
      entityName: marker,
      input: { prompt: marker },
      metadata: {
        token: marker,
        threadId: '00000000-0000-4000-8000-000000000115',
        resourceId: 'studio:' + 'a'.repeat(64),
      },
      tags: [marker],
    });
    await diagnostics.observability.flush();
    const child = span.createChildSpan({
      type: SpanType.MODEL_GENERATION,
      name: marker,
      attributes: {
        model: 'test-model',
        provider: marker,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      metadata: { secret: marker },
    });
    instance.getLoggerContext!(child).error(marker, { privateData: marker });
    child.end({ output: { text: marker } });
    span.update({ output: { text: marker } });
    await diagnostics.observability.flush();
    span.end();
    mastra.getLogger().info('studio.request.completed');
    mastra.getLogger().error(marker, { token: marker });
    await diagnostics.observability.flush();
    for (const calls of [spans, updates, metrics, logs]) {
      expect(calls).toHaveBeenCalled();
      expect(JSON.stringify(calls.mock.calls)).not.toContain(marker);
    }
    const metricWrites = JSON.stringify(metrics.mock.calls);
    expect(metricWrites).toContain('mastra_agent_duration_ms');
    expect(metricWrites).toContain('mastra_model_total_input_tokens');
    expect(metricWrites).toContain('test-model');
    expect(metricWrites).toContain('"status":"ok"');
    expect(JSON.stringify(logs.mock.calls)).toContain('studio.request.completed');
    const trace = await domain.getTrace({ traceId: span.traceId });
    expect(trace?.spans).toHaveLength(2);
    expect(JSON.stringify(trace)).toContain('answer');
    expect(JSON.stringify(trace)).toContain('00000000-0000-4000-8000-000000000115');
    expect(JSON.stringify(trace)).toContain('studio:' + 'a'.repeat(64));
    expect(JSON.stringify(trace)).not.toContain(marker);
  } finally {
    await diagnostics.observability.shutdown();
  }
});
