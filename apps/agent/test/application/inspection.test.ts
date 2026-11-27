import { testModel, testSelection } from '../model-fixture.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { createNativeAgentService } from '../../src/application/agent-service.js';
import type { NativeAgentOptions } from '../../src/application/agent-options.js';
import { nativeAgentOperations, readNativeRun } from '../../src/mastra/runtime/inspection.js';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';

type StoredRun = NonNullable<Awaited<ReturnType<typeof readNativeRun>>['native']>;
type Snapshot = Exclude<StoredRun['snapshot'], string>;
const runId = '00000000-0000-4000-8000-000000000115';
const owner = '00000000-0000-4000-8000-000000000116';
const executionStep = 'durable-agentic-execution';
const loop = 'durable-agentic-loop';
const question = { toolCallId: 'ask-115', question: 'Which discovery project?' };

/** Pinned durable snapshot shape, not a second application state format. */
function snapshot(status: Snapshot['status'] = 'suspended'): Snapshot {
  const state: Snapshot = {
    runId,
    status,
    value: {},
    context: {
      [executionStep]: {
        status: 'suspended',
        startedAt: 1794866400000,
        suspendedAt: 1794866400000,
        payload: {},
        suspendPayload: {
          type: 'suspension',
          toolName: 'ask_user',
          toolCallId: question.toolCallId,
          toolCallSuspended: { question: question.question },
        },
      },
    },
    serializedStepGraph: [],
    activePaths: [],
    activeStepsPath: {},
    suspendedPaths: {},
    resumeLabels: {},
    waitingPaths: {},
    timestamp: 1794866400000,
  };
  // Assign the declared input property separately: core's context index
  // signature also includes `input`, although input is not a step result.
  state.context.input = {
    __workflowKind: 'durable-agent',
    agentId: 'coding',
    state: { threadId: 'thread-115', resourceId: 'resource-115' },
    messageListState: { memoryInfo: { threadId: 'thread-115', resourceId: 'resource-115' } },
  };
  return state;
}
function stored(value: StoredRun['snapshot'] = snapshot(), id = runId): StoredRun {
  return {
    runId: id,
    workflowName: loop,
    snapshot: value,
    resourceId: 'resource-115',
    createdAt: new Date(1794866400000),
    updatedAt: new Date(1794866400000),
  };
}
function readonlyStorage(records: Record<string, StoredRun | null>) {
  const read = vi.fn(async ({ runId: id, workflowName }) => {
    expect(workflowName).toBe(loop);
    return records[id] ?? null;
  });
  const workflows = new Proxy(
    { getWorkflowRunById: read },
    {
      get(target, key) {
        // Promise resolution checks this property; no other framework operation
        // (including subscription, recovery or snapshot write) is allowed.
        if (key === 'then') return undefined;
        if (key !== 'getWorkflowRunById')
          throw new Error(`unexpected workflow access: ${String(key)}`);
        return target.getWorkflowRunById;
      },
    },
  );
  const getStore = vi.fn(async (domain: string) => {
    expect(domain).toBe('workflows');
    return workflows;
  });
  return { storage: { getStore } as unknown as NativeAgentOptions['storage'], read };
}

describe('inert durable inspection', () => {
  it.each([false, true])('projects a persisted question with string snapshot=%s', async (json) => {
    const native = stored(json ? JSON.stringify(snapshot()) : snapshot());
    const { storage, read } = readonlyStorage({ [runId]: native });
    const before = JSON.stringify(native);
    const result = await readNativeRun(storage, runId);
    expect(result.native).toBe(native);
    expect(result.suspended).toEqual(question);
    expect(result.status).toBe('suspended');
    expect(result.mayBeInterrupted).toBe(false);
    expect(JSON.stringify(native)).toBe(before);
    expect(read).toHaveBeenCalledExactlyOnceWith({ runId, workflowName: loop });
  });

  it('projects the option labels of a persisted question', async () => {
    const value = snapshot();
    const step = value.context[executionStep] as { suspendPayload: Record<string, unknown> };
    step.suspendPayload.toolCallSuspended = {
      question: question.question,
      options: [
        { label: 'www.kaufland.de', description: 'Germany' },
        { label: ' ' },
        { description: 'no label' },
        { label: 'All markets' },
      ],
      selectionMode: 'single_select',
    };
    const { storage } = readonlyStorage({ [runId]: stored(value) });
    expect((await readNativeRun(storage, runId)).suspended).toEqual({
      ...question,
      options: ['www.kaufland.de', 'All markets'],
    });
  });

  it.each(['running', 'pending', 'paused', 'success', 'failed', 'canceled', 'tripwire'] as const)(
    'keeps %s distinct from a suspended question despite a retained tool payload',
    async (status) => {
      const native = stored(snapshot(status));
      const { storage } = readonlyStorage({ [runId]: native });
      const result = await readNativeRun(storage, runId);
      expect(result.native).toBe(native);
      expect(result.status).toBe(status);
      expect(result.suspended).toBeUndefined();
      expect(result.mayBeInterrupted).toBe(status === 'running');
    },
  );

  it('keeps unknown state unknown and propagates unreadable storage', async () => {
    const { storage, read } = readonlyStorage({});
    expect(await readNativeRun(storage, runId)).toEqual({
      native: null,
      status: undefined,
      suspended: undefined,
      mayBeInterrupted: true,
    });
    read.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(readNativeRun(storage, runId)).rejects.toThrow('storage unavailable');
    read.mockResolvedValueOnce(stored('{invalid JSON'));
    await expect(readNativeRun(storage, runId)).rejects.toThrow(SyntaxError);
  });

  it.each(['completed-step', 'approval', 'other-tool', 'missing-id', 'invalid-question', 'nested'])(
    'does not invent a question from %s',
    async (mode) => {
      const state = snapshot();
      const step = state.context[executionStep]!;
      if (mode === 'completed-step') step.status = 'success';
      if (mode === 'approval') step.suspendPayload.type = 'approval';
      if (mode === 'other-tool') step.suspendPayload.toolName = 'other_tool';
      if (mode === 'missing-id') delete step.suspendPayload.toolCallId;
      if (mode === 'invalid-question') step.suspendPayload.toolCallSuspended.question = 115;
      if (mode === 'nested') {
        delete state.context[executionStep];
        state.context.other = step;
      }
      const { storage } = readonlyStorage({ [runId]: stored(state) });
      expect((await readNativeRun(storage, runId)).suspended).toBeUndefined();
    },
  );

  it('reads a retained snapshot in a new process without runtime, model or replay', async () => {
    await fs.mkdir('artifacts', { recursive: true });
    const dir = await fs.mkdtemp(path.resolve('artifacts/native-inspection-'));
    const fixture = path.join(dir, 'suspended.json');
    await fs.writeFile(fixture, JSON.stringify(stored(JSON.stringify(snapshot()))), { flag: 'wx' });
    const inspector = pathToFileURL(path.resolve('src/mastra/runtime/inspection.ts')).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import fs from 'node:fs/promises';
        import { readNativeRun } from ${JSON.stringify(inspector)};
        const native = JSON.parse(await fs.readFile(process.argv[1], 'utf8'));
        let reads = 0;
        const storage = { getStore: async domain => {
          if (domain !== 'workflows') throw new Error('unexpected domain');
          return { getWorkflowRunById: async input => {
            if (input.workflowName !== native.workflowName || input.runId !== native.runId)
              throw new Error('wrong run');
            reads++;
            return native;
          }};
        }};
        const result = await readNativeRun(storage, native.runId);
        console.log(JSON.stringify({ result, reads }));
      `,
        fixture,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    const result = JSON.parse(output);
    expect(result.reads).toBe(1);
    expect(result.result.suspended).toEqual(question);
    expect(result.result.status).toBe('suspended');
    await fs.writeFile(path.join(dir, 'cold-process.json'), output, { flag: 'wx' });
  });
});

function serviceFixture() {
  const identity = {
    installationId: 'UBOT',
    teamId: 'TTEAM',
    channelId: 'CCHAN',
    userId: 'UOWNER',
    rootTs: '1794866400.000115',
    messageTs: '1794866400.000115',
    eventId: 'event-115',
    text: '',
    canonicalText: '',
    authorBotId: null,
  };
  const row = { run_id: runId, task_key: 'task-115', owner, accepted: identity };
  let currentOwner = owner;
  let blocked = false;
  let cancelled = false;
  let delivery: Record<string, unknown> | null = null;
  const cfg = () =>
    deriveCoordinatorConfig(
      compileDocument(1, {
        installations: [
          {
            teamId: 'TTEAM',
            teamName: 'Synthetic',
            botUserId: 'UBOT',
            botId: 'BBOT',
            status: 'whitelisted',
            trustedBotSender: null,
          },
        ],
        channels: [{ teamId: 'TTEAM', channelId: 'CCHAN', enabled: true }],
        blockedMembers: blocked ? [{ teamId: 'TTEAM', channelId: 'CCHAN', userId: 'UOWNER' }] : [],
      }),
      {
        modelPolicy: {
          defaultKey: 'fixture',
          models: [testSelection('fixture', 'fixture/model')],
        },
        admission: { global: 1, perThread: 1 },
        execution: { maxInferenceInvocations: 1 },
      },
    );
  const query = vi.fn(async (sql: string) => {
    expect(sql).toMatch(/^SELECT /);
    let rows: unknown[];
    if (sql.startsWith('SELECT * FROM native_agents.requests')) rows = [row];
    else if (sql.startsWith('SELECT owner FROM')) rows = [{ owner: currentOwner }];
    else if (sql.includes('FROM native_agents.actions'))
      rows = cancelled ? [{ action: 'cancel' }] : [];
    else if (sql.includes('FROM native_agents.deliveries')) rows = delivery ? [delivery] : [];
    else if (
      sql.includes('FROM native_agents.publications') ||
      sql.includes('FROM native_agents.exports')
    )
      rows = [];
    else throw new Error(`unexpected query: ${sql}`);
    return { rows, rowCount: rows.length };
  });
  const records: Record<string, StoredRun | null> = { [runId]: stored() };
  const { storage, read } = readonlyStorage(records);
  const services = vi.fn(async () => {
    throw new Error('inspection must not create services');
  });
  const authority = vi.fn(async () => {});
  const options: NativeAgentOptions = {
    pool: { query } as unknown as NativeAgentOptions['pool'],
    log: { info() {}, warn() {}, error() {} },
    storage,
    configuration: async () => cfg(),
    authority,
    bindModel: (selection) => testModel('http://127.0.0.1:1', 'synthetic-unused', selection),
    instructions: '',
    services,
    channelInstructions: async () => '',
    limits: { outputTokens: 100, maxSteps: 1, timeoutMs: 1000 },
  };
  return {
    service: createNativeAgentService(options),
    read,
    services,
    authority,
    records,
    block: () => {
      blocked = true;
    },
    transfer: () => {
      currentOwner = 'new-owner';
    },
    cancel: () => {
      cancelled = true;
    },
    deliver: (value: Record<string, unknown>) => {
      delivery = value;
    },
  };
}

describe('inspection application boundaries', () => {
  it('checks exact actor, owner and current policy before reading framework state', async () => {
    const f = serviceFixture();
    await expect(f.service.inspect(runId, 'UOTHER', owner)).rejects.toThrow('stale_or_wrong_owner');
    await expect(f.service.inspect(runId, 'UOWNER', 'other')).rejects.toThrow(
      'stale_or_wrong_owner',
    );
    expect(f.read).not.toHaveBeenCalled();
    const result = await f.service.inspect(runId, 'UOWNER', owner);
    expect(result.suspended).toEqual(question);
    expect(result.native).toBe(f.records[runId]);
    f.read.mockClear();
    f.block();
    await expect(f.service.inspect(runId, 'UOWNER', owner)).rejects.toThrow(
      'authorization_revoked',
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.services).not.toHaveBeenCalled();
  });

  it('refuses a former owner and current external authority refusal before framework reads', async () => {
    const f = serviceFixture();
    f.transfer();
    await expect(f.service.inspect(runId, 'UOWNER', owner)).rejects.toThrow('stale_owner');
    expect(f.read).not.toHaveBeenCalled();
    const g = serviceFixture();
    g.authority.mockRejectedValueOnce(new Error('source no longer allowed'));
    await expect(g.service.inspect(runId, 'UOWNER', owner)).rejects.toThrow(
      'source no longer allowed',
    );
    expect(g.read).not.toHaveBeenCalled();
  });

  it('retains cancellation and delivery receipts when framework state is unknown', async () => {
    const f = serviceFixture();
    f.records[runId] = null;
    const unknown = await f.service.inspect(runId, 'UOWNER', owner);
    expect(unknown.native).toBeNull();
    expect(unknown.receipt).toMatch(/No confirmed result/);
    const delivery = {
      operation_id: 'operation-115',
      outcome: 'uncertain',
      sha256: 'sha115',
      bytes: 10,
      slack_ts: null,
    };
    f.deliver(delivery);
    const uncertain = await f.service.inspect(runId, 'UOWNER', owner);
    expect(uncertain.delivery).toEqual(delivery);
    expect(uncertain.receipt).toBeUndefined();
    f.cancel();
    expect((await f.service.inspect(runId, 'UOWNER', owner)).receipt).toMatch(
      /Cancellation recorded/,
    );
    await f.service.close();
    await expect(f.service.start({} as never)).rejects.toThrow('native_agent_closing');
    expect(f.services).not.toHaveBeenCalled();
  });
});

it('operational projection preserves waits, interrupted truth and late drain state', async () => {
  const records = {
    question: stored(snapshot(), 'question'),
    cancelled: stored(snapshot(), 'cancelled'),
    running: stored(snapshot('running'), 'running'),
    active: stored(snapshot('running'), 'active'),
    delivered: null,
    unknown: null,
    failed: stored(snapshot('failed'), 'failed'),
    success: stored(snapshot('success'), 'success'),
  };
  const { storage } = readonlyStorage(records);
  const active = new Map<string, unknown>([['active', {}]]);
  let admitted = 1;
  let accepting = true;
  const query = vi.fn(async (sql: string, args?: string[]) => {
    expect(sql).toMatch(/^SELECT /);
    if (sql.startsWith('SELECT r.*'))
      return { rows: Object.keys(records).map((id) => ({ run_id: id, task_key: `task-${id}` })) };
    if (sql.includes("action='cancel'")) return { rowCount: args?.[0] === 'cancelled' ? 1 : 0 };
    if (sql.startsWith('SELECT 1 FROM native_agents.deliveries'))
      return { rowCount: args?.[0] === 'delivered' ? 1 : 0 };
    if (sql.includes("outcome='uncertain'")) return { rows: [{ count: '1' }] };
    if (sql.includes("outcome='retained'")) return { rows: [{ count: '2' }] };
    if (sql.includes("a.action LIKE 'notice:%'")) {
      admitted = 0;
      accepting = false;
      active.clear();
      return { rows: [{ count: '3' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await nativeAgentOperations({
    pool: { query } as unknown as NativeAgentOptions['pool'],
    storage,
    active,
    state: () => ({ admitted, accepting }),
  });
  expect(result).toEqual({
    runtime: 'native-answer',
    accepting: false,
    admitted: 0,
    active: [],
    waits: [{ taskKey: 'task-question', runId: 'question' }],
    interrupted: 2,
    ambiguous: 1,
    undelivered: 2,
    unknownNotices: 3,
    idle: false,
  });
});

it('documents the pinned public inspection projections without inference', async () => {
  const require = createRequire(path.resolve('package.json'));
  const { InMemoryStore } = require('@mastra/core/storage') as {
    InMemoryStore: new () => Parameters<typeof createNativeRuntime>[0]['storage'];
  };
  const storage = new InMemoryStore();
  await storage.init();
  const workflows = (await storage.getStore('workflows'))!;
  await workflows.persistWorkflowSnapshot({
    workflowName: loop,
    runId,
    resourceId: 'resource-115',
    snapshot: snapshot(),
  });
  const beforeDispatch = vi.fn(async () => {
    throw new Error('inspection attempted inference');
  });
  const runtime = createNativeRuntime({
    storage,
    model: testModel(
      'http://127.0.0.1:1',
      'synthetic-unused',
      testSelection('test', 'fixture/model'),
    ),
    instructions: '',
    tools: {},
    beforeDispatch,
    contextTokens: 1000,
    outputTokens: 100,
    maxSteps: 1,
  });
  try {
    const publicRun = await runtime.agent
      .getWorkflow()
      .getWorkflowRunById(runId, { withNestedWorkflows: false });
    expect(publicRun?.status).toBe('suspended');
    expect(publicRun).not.toHaveProperty('snapshot');
    const suspended = await runtime.agent.listSuspendedRuns({
      threadId: 'thread-115',
      resourceId: 'resource-115',
    });
    expect(suspended.runs[0]?.toolCalls[0]).toMatchObject({
      toolCallId: question.toolCallId,
      toolName: 'ask_user',
      requiresApproval: false,
      suspendPayload: { question: question.question },
    });
    const observer = await runtime.agent.observe(runId);
    observer.detach();
    const observed = [];
    for await (const chunk of observer.output.fullStream) observed.push(chunk);
    expect(observed).toEqual([]);
    expect((await readNativeRun(storage, runId)).suspended).toEqual(question);
    await workflows.persistWorkflowSnapshot({
      workflowName: loop,
      runId,
      snapshot: snapshot('failed'),
    });
    expect((await runtime.agent.listSuspendedRuns()).runs).toEqual([]);
    expect((await runtime.agent.getWorkflow().getWorkflowRunById(runId))?.status).toBe('failed');
    expect(await runtime.agent.getWorkflow().getWorkflowRunById('unknown')).toBeNull();
    expect(beforeDispatch).not.toHaveBeenCalled();
  } finally {
    await runtime.mastra.shutdown();
  }
});
