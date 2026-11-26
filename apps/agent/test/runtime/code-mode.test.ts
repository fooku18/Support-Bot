import { describe, expect, it } from 'vitest';
import {
  assertCodeModeRuntime,
  CODE_MODE_LIMITS,
  createNativeCodeMode,
} from '../../src/mastra/tools/code-mode.js';
import { createReadServiceTools } from '../../src/mastra/tools/read-services.js';
import type { BrokerToolResult } from '../../src/integrations/tools/runtime-client.js';

type Outcome = {
  success: boolean;
  result?: unknown;
  logs?: string[];
  error?: { message: string; name?: string };
};

/** Real read tools over a synthetic GitLab broker; `assigned` is the channel's
 * current assignment, checked by every read and by the start of a script. */
function setup() {
  const state = { assigned: true, starts: 0 };
  const calls: Array<{ operation: unknown; args: unknown }> = [];
  const unavailable = async (): Promise<never> => {
    throw new Error('unavailable');
  };
  const gitlab = async (operation: unknown, args: unknown): Promise<BrokerToolResult> => {
    calls.push({ operation, args });
    const data =
      operation === 'get_project'
        ? { id: 7, path_with_namespace: 'g/p', default_branch: 'main' }
        : [{ name: 'main' }, { name: 'feature' }];
    return { ok: true, output: JSON.stringify(data), operationId: String(operation), data };
  };
  const reads = createReadServiceTools({
    enabled: new Set(),
    catalog: { gitlab: true, slackSearch: false },
    authorize: async (capability) => {
      if (capability !== 'gitlab' || !state.assigned) throw new Error('service_binding_revoked');
    },
    services: {
      gitlab,
      atlassian: unavailable,
      datadog: unavailable,
      datadogDescribe: unavailable,
      cloudflareGet: unavailable,
      cloudflareGraphql: unavailable,
      slackGetUser: unavailable,
      slackLookupUserByEmail: unavailable,
      slackSearchMessages: unavailable,
    },
  });
  const tool = createNativeCodeMode(reads, async () => {
    state.starts++;
    if (!state.assigned) throw new Error('service_binding_revoked');
  });
  const run = async (code: string) =>
    (await tool.execute!({ code }, {} as never)) as unknown as Outcome;
  return { tool, run, state, calls, reads };
}

describe('Code Mode in isolated-vm', () => {
  it('uses the agreed limits', () => {
    expect(CODE_MODE_LIMITS).toEqual({
      timeoutMs: 15_000,
      memoryLimitMb: 64,
      maxReads: 50,
      maxOutputBytes: 48_000,
    });
  });

  it('refuses to build without --no-node-snapshot', () => {
    expect(() => assertCodeModeRuntime([], '--max-old-space-size=512')).toThrow(
      /--no-node-snapshot/,
    );
    expect(() => assertCodeModeRuntime([], '--trace-warnings --no-node-snapshot')).not.toThrow();
    expect(() => assertCodeModeRuntime(['--no-node-snapshot'], '')).not.toThrow();
  });

  it('combines two read tools in one script and returns the result', async () => {
    const f = setup();
    expect(f.tool.id).toBe('execute_typescript');
    expect(f.tool.description).toContain('declare function external_get_project');
    expect(f.tool.description).toContain('declare function external_list_branches');
    expect(f.tool.description).not.toMatch(/external_(?:publish|create_|update_|delete_)/);
    const out = await f.run(`
      const [project, branches] = await Promise.all([
        external_get_project({ project: 'g/p' }),
        external_list_branches({ project: 'g/p' }),
      ]);
      console.log('branches', branches.result.data.length);
      return { project: project.result.data.path_with_namespace,
        branches: branches.result.data.map((b: { name: string }) => b.name) };
    `);
    expect(out).toMatchObject({
      success: true,
      result: { project: 'g/p', branches: ['main', 'feature'] },
      logs: ['branches 2'],
    });
    expect(f.calls.map((c) => c.operation).sort()).toEqual(['get_project', 'list_branches']);
    expect(f.state.starts).toBe(1);
  });

  it('gives the script no filesystem, network, process, timer or module access', async () => {
    const f = setup();
    const out = await f.run(`
      const probes: Record<string, string> = {};
      for (const name of ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket',
        'setTimeout', 'setInterval', 'Deno', 'Bun', 'std', 'os', 'module', 'Buffer',
        '__hostCall', '__hostLog'])
        probes[name] = typeof (globalThis as Record<string, unknown>)[name];
      const errors: Record<string, string> = {};
      const attempt = async (label: string, work: () => unknown) => {
        try { await work(); errors[label] = 'allowed'; }
        catch (e) { errors[label] = (e as Error).name; }
      };
      await attempt('import fs', () => import('node:fs'));
      await attempt('import std', () => import('std'));
      await attempt('require fs', () => (globalThis as any).require('fs'));
      await attempt('process.env', () => (globalThis as any).process.env);
      await attempt('fetch', () => (globalThis as any).fetch('http://127.0.0.1/'));
      return { probes, errors };
    `);
    expect(out.success).toBe(true);
    const { probes, errors } = out.result as {
      probes: Record<string, string>;
      errors: Record<string, string>;
    };
    expect(Object.entries(probes).filter(([, type]) => type !== 'undefined')).toEqual([]);
    expect(Object.entries(errors).filter(([, name]) => name === 'allowed')).toEqual([]);
  });

  it('refuses write tools and reads outside the allow-list', async () => {
    const f = setup();
    // The read catalog holds no GitLab writes; publication is a coding tool.
    expect(Object.keys(f.reads)).toContain('get_project');
    expect(Object.keys(f.reads)).not.toContain('create_merge_request');
    expect(Object.keys(f.reads)).not.toContain('publish');
    for (const name of ['publish', 'create_merge_request', 'jira_get_issue', 'web_fetch']) {
      const out = await f.run(`return await external_${name}({});`);
      expect(out, name).toMatchObject({
        success: false,
        error: { name: 'ReferenceError', message: expect.stringContaining(`external_${name}`) },
      });
    }
    expect(f.calls).toEqual([]);
  });

  it('refuses a script when the tool is no longer assigned', async () => {
    const f = setup();
    f.state.assigned = false;
    await expect(f.run(`return await external_get_project({ project: 'g/p' });`)).rejects.toThrow(
      'service_binding_revoked',
    );
    expect(f.calls).toEqual([]);
  });

  it('refuses a read revoked while the script runs', async () => {
    const f = setup();
    const read = f.reads.get_project!;
    const execute = read.execute!;
    read.execute = async (args, context) => {
      const result = await execute(args, context);
      f.state.assigned = false;
      return result;
    };
    const out = await f.run(`
      const project = await external_get_project({ project: 'g/p' });
      try { await external_list_branches({ project: 'g/p' }); return 'second read allowed'; }
      catch (e) { return { project: project.result.ok, refused: (e as Error).message }; }
    `);
    expect(out).toMatchObject({
      success: true,
      result: { project: true, refused: 'service_binding_revoked' },
    });
    expect(f.calls.map((c) => c.operation)).toEqual(['get_project']);
  });

  it('caps the read calls of one script; the next script starts fresh', async () => {
    const f = setup();
    const many = `
      const out = await Promise.allSettled(
        Array.from({ length: 60 }, () => external_get_project({ project: 'g/p' })));
      const refused = out.filter((o) => o.status === 'rejected');
      return { refused: refused.length, why: String((refused[0] as any).reason.message) };`;
    expect(await f.run(many)).toMatchObject({
      success: true,
      result: { refused: 10, why: 'a script may make at most 50 read calls' },
    });
    expect(f.calls).toHaveLength(50);
    expect(
      await f.run(`return (await external_get_project({ project: 'g/p' })).result.ok;`),
    ).toEqual(expect.objectContaining({ success: true, result: true }));
  });

  it('refuses a result or log output beyond the bound without returning any of it', async () => {
    const f = setup();
    expect(await f.run(`return 'x'.repeat(40_000).length;`)).toMatchObject({ result: 40_000 });
    for (const script of [
      `return 'x'.repeat(60_000);`,
      `for (let i = 0; i < 100; i++) console.log('x'.repeat(1_000)); return 1;`,
      `throw new Error('x'.repeat(60_000));`,
    ]) {
      const out = await f.run(script);
      expect(out).toMatchObject({ success: false, error: { name: 'OutputLimitError' } });
      expect(JSON.stringify(out).length).toBeLessThan(500);
    }
  });

  it('stops runaway recursion with the stack limit', async () => {
    const f = setup();
    const out = await f.run(`const down = (n: number): number => down(n + 1) + 1; return down(0);`);
    expect(out).toMatchObject({
      success: false,
      error: { name: 'RangeError', message: 'Maximum call stack size exceeded' },
    });
  });

  it('enforces the memory limit', async () => {
    const f = setup();
    const fits = await f.run(`return new Uint8Array(32 * 1024 * 1024).length;`);
    expect(fits).toMatchObject({ success: true, result: 32 * 1024 * 1024 });
    const large = await f.run(`return new Uint8Array(80 * 1024 * 1024).length;`);
    expect(large).toMatchObject({
      success: false,
      error: { name: 'RangeError', message: 'Array buffer allocation failed' },
    });
    // Array buffers count against the limit as a whole, not only one by one.
    const buffers = await f.run(`
      const held: Uint8Array[] = [];
      try { for (;;) held.push(new Uint8Array(1024 * 1024)); }
      catch (e) { return { count: held.length, error: (e as Error).message }; }
    `);
    expect(buffers).toMatchObject({
      success: true,
      result: { error: 'Array buffer allocation failed' },
    });
    expect((buffers.result as { count: number }).count).toBeLessThanOrEqual(
      CODE_MODE_LIMITS.memoryLimitMb,
    );
    const growing = await f.run(`
      const rows: Array<{ i: number }> = [];
      for (;;) rows.push({ i: rows.length });
    `);
    expect(growing).toMatchObject({
      success: false,
      error: { message: 'Isolate was disposed during execution due to memory limit' },
    });
    // The isolate is fresh for each script.
    expect(await f.run(`return 1 + 1;`)).toMatchObject({ success: true, result: 2 });
  });

  it('stops a synchronous infinite loop at the timeout without holding the event loop', async () => {
    const f = setup();
    // A host timer keeps firing on schedule while the script loops: the
    // isolate runs on its own thread, not on the agent's event loop.
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 100);
    const started = Date.now();
    const out = await f.run(`while (true) {}`).finally(() => clearInterval(timer));
    const elapsed = Date.now() - started;
    const gaps = ticks.map((t, i) => t - (ticks[i - 1] ?? started));
    expect(ticks.length).toBeGreaterThan(CODE_MODE_LIMITS.timeoutMs / 100 - 15);
    expect(Math.max(...gaps)).toBeLessThan(1_000);
    expect(out).toMatchObject({
      success: false,
      error: {
        name: 'TimeoutError',
        message: `Code Mode execution timed out after ${CODE_MODE_LIMITS.timeoutMs}ms`,
      },
    });
    expect(elapsed).toBeGreaterThanOrEqual(CODE_MODE_LIMITS.timeoutMs);
    expect(elapsed).toBeLessThan(CODE_MODE_LIMITS.timeoutMs + 5_000);
  }, 30_000);
});
