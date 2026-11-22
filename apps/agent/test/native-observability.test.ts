import { expect, it, vi } from 'vitest';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { nativeTelemetryScenario, privateMarker } from './telemetry-scenario.js';
import {
  telemetryPool,
  withTelemetryStore,
} from '../src/infrastructure/storage/telemetry-store.js';
import { Pool } from 'pg';

it('exports actual durable native success/failure runs with safe correlation and graceful shutdown', async () => {
  const storage = new InMemoryStore();
  const domain = (await storage.getStore('observability'))!;
  const spans = vi.spyOn(domain, 'batchCreateSpans');
  const metrics = vi.spyOn(domain, 'batchCreateMetrics');
  const logs = vi.spyOn(domain, 'batchCreateLogs');
  const { runId, identity } = await nativeTelemetryScenario(storage);
  for (const writes of [spans, metrics, logs]) {
    expect(writes).toHaveBeenCalled();
    const bytes = JSON.stringify(writes.mock.calls);
    expect(bytes).not.toContain(privateMarker);
    expect(bytes).not.toContain(identity.threadId);
    expect(bytes).not.toContain(identity.resourceId);
    expect(bytes).toContain('support-agent-slack');
    expect(bytes).toContain(runId);
  }
  const bytes = JSON.stringify(spans.mock.calls);
  expect(bytes).toContain('slack:thread:');
  expect(bytes).toContain('slack:resource:');
  expect(bytes).toContain('model_generation');
  expect(JSON.stringify(metrics.mock.calls)).toContain('mastra_model_total_input_tokens');
  expect(JSON.stringify(logs.mock.calls)).toContain('native.segment.ended');
});

it('routes only observability through the official separate pool and leaves primary domains untouched', async () => {
  const primaryPool = new Pool({ host: 'unused.invalid' });
  const telemetry = new Pool({ host: 'unused-telemetry.invalid' });
  const primary = new InMemoryStore();
  const store = withTelemetryStore(primary, primaryPool, telemetry);
  expect(store.disableInit).toBe(true);
  expect(await store.getStore('memory')).toBe(await primary.getStore('memory'));
  expect(await store.getStore('workflows')).toBe(await primary.getStore('workflows'));
  expect(await store.getStore('observability')).not.toBe(await primary.getStore('observability'));
  // Factory/close must not connect, initialize schema, or close caller-owned pools.
  await store.close();
  expect(primaryPool.ended).toBe(false);
  expect(telemetry.ended).toBe(false);
  await primaryPool.end();
  await telemetry.end();
});

it('supports absent/off sources and rejects incomplete or unrecognized explicit telemetry', () => {
  expect(telemetryPool({})).toBeUndefined();
  expect(telemetryPool({ NATIVE_OBSERVABILITY_SOURCE: 'off' })).toBeUndefined();
  expect(() => telemetryPool({ NATIVE_OBSERVABILITY_SOURCE: 'other' })).toThrow(/source/);
  expect(() => telemetryPool({ NATIVE_OBSERVABILITY_SOURCE: 'native' })).toThrow(/explicit/);
});

it('keeps runtime DDL disabled when Studio starts framework workers', async () => {
  const primaryPool = new Pool({ host: 'unused.invalid' });
  const telemetry = new Pool({ host: 'unused-telemetry.invalid' });
  const primary = new InMemoryStore();
  const store = withTelemetryStore(primary, primaryPool, telemetry);
  const domain = (await store.getStore('observability'))!;
  const ddl = vi.spyOn(domain, 'init').mockRejectedValue(new Error('restricted runtime DDL'));
  const mastra = new Mastra({ storage: store, logger: false, scheduler: { enabled: false } });
  try {
    await mastra.startWorkers();
    await mastra.startWorkers();
    expect(ddl).not.toHaveBeenCalled();
    expect(primaryPool.totalCount).toBe(0);
    expect(telemetry.totalCount).toBe(0);
    expect(await store.getStore('memory')).toBe(await primary.getStore('memory'));
  } finally {
    await mastra.shutdown();
    await primaryPool.end();
    await telemetry.end();
  }
});
