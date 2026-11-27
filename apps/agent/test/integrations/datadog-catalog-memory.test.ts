import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DatadogMcpSession } from '../../src/integrations/datadog/datadog-mcp-adapter.js';
import { DatadogMcpProvider } from '../../src/integrations/datadog/datadog-mcp-provider.js';
import { fakeDatadog, LOGS_SCHEMA, type FakeTool } from './helpers/datadog-mcp.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const TOKEN = 'ddpat_provider-token-0123456789';
const bounds = { timeoutMs: 5_000, maxOutputBytes: 10_000 };

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    gc();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

async function heapUsed(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  gc();
  return process.memoryUsage().heapUsed;
}

describe('Datadog catalog memory across re-probes', () => {
  it('releases the argument schemas of a replaced catalog once calls have validated them', async () => {
    const fake = fakeDatadog({
      tools: [
        {
          name: 'search_datadog_logs',
          description: 'Search logs.',
          inputSchema: structuredClone(LOGS_SCHEMA),
        },
      ],
    });
    const provider = new DatadogMcpProvider(
      { site: 'datadoghq.eu', toolsets: 'all', token: TOKEN },
      fake.fetchImpl,
    );
    const catalogSchema = () =>
      (provider as unknown as { catalog: { tools: Array<{ inputSchema: object }> } }).catalog
        .tools[0]!.inputSchema;

    await provider.refresh();
    const first = new WeakRef(catalogSchema());
    expect(await provider.call('search_datadog_logs', { query: 'a' }, bounds)).toMatchObject({
      status: 'completed',
    });
    await provider.refresh();
    expect(await provider.call('search_datadog_logs', { query: 'b' }, bounds)).toMatchObject({
      status: 'completed',
    });
    expect(first.deref()).not.toBe(catalogSchema());
    expect(await collected(first)).toBe(true);
  });

  it('keeps no output-schema validators per tools/list and still validates structured content', async () => {
    const outputSchema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    };
    const tools: Array<FakeTool & { outputSchema: Record<string, unknown> }> = Array.from(
      { length: 50 },
      (_, i) => ({
        name: `get_datadog_thing_${i}`,
        description: 'Read a thing.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema,
      }),
    );
    const fake = fakeDatadog({
      tools,
      pageSize: 100,
      call: (name) => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: name === 'get_datadog_thing_1' ? { count: 'many' } : { count: 1 },
      }),
    });
    const session = new DatadogMcpSession({
      site: 'datadoghq.eu',
      toolsets: 'all',
      token: TOKEN,
      fetchImpl: fake.fetchImpl,
    });
    await session.listTools(5_000);
    await session.callTool('get_datadog_thing_0', {}, bounds);
    const before = await heapUsed();
    for (let probe = 0; probe < 40; probe += 1) {
      await session.listTools(5_000);
      expect(await session.callTool('get_datadog_thing_0', {}, bounds)).toMatchObject({
        status: 'completed',
      });
    }
    const perProbe = ((await heapUsed()) - before) / 40;
    expect(perProbe).toBeLessThan(50_000);
    const mismatch = await session.callTool('get_datadog_thing_1', {}, bounds);
    expect(mismatch).toMatchObject({ status: 'failed', errorCategory: 'tool_error' });
    expect(mismatch.output).toContain('does not match the tool');
  });
});
