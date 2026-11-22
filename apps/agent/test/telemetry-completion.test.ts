import { Duplex } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createPrivateDiagnostics } from '../src/mastra/studio-observability.js';
import { telemetryPool } from '../src/infrastructure/storage/telemetry-store.js';
import { nativeTelemetryScenario } from './telemetry-scenario.js';

const marker = 'PRIVATE_QUERY_ENDPOINT_CREDENTIAL_115';
const diagnostic = 'telemetry export incomplete; persistence unconfirmed';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  const storage = new InMemoryStore();
  const diagnostics = createPrivateDiagnostics([], { source: 'slack' });
  const mastra = new Mastra({
    storage,
    ...diagnostics,
    recovery: { durableAgents: 'off', workflows: 'off' },
  });
  const domain = (await storage.getStore('observability'))!;
  const instance = diagnostics.observability.getDefaultInstance()!;
  const emit = () =>
    instance.getMetricsContext!().emit('mastra_model_total_input_tokens', 9, { secret: marker });
  return { mastra, domain, emit };
}

it('times out an accepted PG write and destroys its client without connecting to a service', async () => {
  vi.useFakeTimers();
  let startup: Buffer | undefined;
  let queries = 0;
  // Real pg client/protocol and pool; only the transport is synthetic. Accept
  // startup, then stop answering an already-dispatched query (not acquisition).
  class StalledPostgresStream extends Duplex {
    connect() {
      void Promise.resolve().then(() => this.emit('connect'));
      return this;
    }
    setNoDelay() {}
    override _read() {}
    override _write(bytes: Buffer, _encoding: BufferEncoding, done: () => void) {
      if (!startup) {
        startup = Buffer.from(bytes);
        void Promise.resolve().then(() => {
          this.push(Buffer.from('5200000008000000005a0000000549', 'hex'));
        });
      } else {
        expect(bytes[0]).toBe(81); // Query
        queries++;
      }
      done();
    }
  }
  const stream = new StalledPostgresStream();
  const pool = telemetryPool({
    NATIVE_OBSERVABILITY_SOURCE: 'native',
    NATIVE_OBSERVABILITY_HOST: 'unused.synthetic.invalid',
    NATIVE_OBSERVABILITY_PASSWORD: 'synthetic-telemetry-fixture-password',
  })!;
  pool.options.stream = () => stream;
  pool.options.ssl = false;
  try {
    expect(pool.totalCount).toBe(0);
    expect(pool.options).toMatchObject({
      max: 2,
      connectionTimeoutMillis: 2000,
      lock_timeout: 1000,
      statement_timeout: 2000,
      query_timeout: 2500,
    });
    const writing = expect(
      pool.query('INSERT INTO synthetic_telemetry VALUES (1)'),
    ).rejects.toThrow('Query read timeout');
    await vi.advanceTimersByTimeAsync(2499);
    expect(queries).toBe(1);
    expect(pool.totalCount).toBe(1);
    expect(stream.destroyed).toBe(false);
    expect(startup!.includes(Buffer.from('lock_timeout\0' + '1000\0'))).toBe(true);
    expect(startup!.includes(Buffer.from('statement_timeout\0' + '2000\0'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await writing;
    expect(stream.destroyed).toBe(true);
    expect(pool.totalCount).toBe(0);
  } finally {
    await pool.end();
  }
});

it('persists a final metric after one transient failure during official Mastra shutdown', async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await fixture();
  const writes = vi.spyOn(f.domain, 'batchCreateMetrics').mockRejectedValueOnce(new Error(marker));
  f.emit();
  const closing = f.mastra.shutdown({ drainTimeout: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  await closing;
  expect(writes).toHaveBeenCalledTimes(2);
  expect(writes.mock.calls[0]).toEqual(writes.mock.calls[1]);
  expect(JSON.stringify(writes.mock.calls)).not.toContain(marker);
  expect(
    await f.domain.getMetricAggregate({
      name: ['mastra_model_total_input_tokens'],
      aggregation: 'sum',
      filters: { timestamp: { start: new Date(0), end: new Date(Date.now() + 1000) } },
    }),
  ).toMatchObject({ value: 9 });
  expect(error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('exhausts permanent final failures with finite official retries and a content-free host diagnostic', async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await fixture();
  const writes = vi.spyOn(f.domain, 'batchCreateMetrics').mockRejectedValue(new Error(marker));
  f.emit();
  const closing = f.mastra.shutdown({ drainTimeout: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  await closing;
  expect(writes).toHaveBeenCalledTimes(3);
  expect(error.mock.calls).toEqual([[diagnostic]]);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(writes).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(error.mock.calls)).not.toContain(marker);
});

it.each(['resolve', 'reject'] as const)(
  'bounds official exporter completion while storage stalls, including late %s',
  async (outcome) => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    let release!: () => void;
    const stalled = new Promise<void>((resolve, reject) => {
      release = () => (outcome === 'resolve' ? resolve() : reject(new Error(marker)));
    });
    const writes = vi.spyOn(f.domain, 'batchCreateMetrics').mockReturnValue(stalled);
    f.emit();
    let settled = false;
    const closing = f.mastra.shutdown({ drainTimeout: 1 }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toBe(true);
    expect(error.mock.calls).toEqual([[diagnostic]]);
    expect(vi.getTimerCount()).toBe(0);
    // The completion deadline does not claim to cancel/confirm an uncertain
    // write. Production's separate PG deadlines terminate that underlying work.
    release();
    await vi.advanceTimersByTimeAsync(60000);
    expect(writes).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(error.mock.calls).toEqual([[diagnostic]]);
  },
);

it('keeps real durable execution outcomes and no-replay semantics with stalled telemetry', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const storage = new InMemoryStore();
  const domain = (await storage.getStore('observability'))!;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes = vi.spyOn(domain, 'batchCreateMetrics').mockReturnValue(stalled);
  try {
    // Uses the real pinned Agent/durable wrapper and synthetic provider peer.
    // The scenario asserts exact answer bytes, one provider request, a separate
    // guard failure, no automatic resume/recovery, then actual Mastra shutdown.
    await nativeTelemetryScenario(storage);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(error.mock.calls).toEqual([[diagnostic]]);
  } finally {
    release();
  }
});
