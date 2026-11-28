import { testModel, testSelection } from '../model-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { NativeAgentOptions } from '../../src/application/agent-options.js';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import * as runtime from '../../src/mastra/agents/coding.js';
import {
  createNativeStudio,
  studioAddress,
  studioRequestAllowed,
} from '../../src/application/studio.js';

describe('fixed test Studio ingress', () => {
  it.each([undefined, 'https://studio.example.test'])(
    'keeps authority and exact origins with public origin %s',
    async (publicOrigin) => {
      const require = createRequire(new URL('../../package.json', import.meta.url));
      const { InMemoryStore } = require('@mastra/core/storage') as {
        InMemoryStore: new () => Parameters<typeof runtime.createNativeAgent>[0]['storage'];
      };
      const config = deriveCoordinatorConfig(
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
          blockedMembers: [],
          toolInstances: [],
          channelTools: [],
        }),
        {
          modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
          admission: { global: 2, perThread: 1 },
          execution: { maxInferenceInvocations: 3 },
        },
      );
      const authority = vi.fn(async () => {});
      const factory = vi.spyOn(runtime, 'createNativeAgent');
      const studio = await createNativeStudio({
        identity: {
          installationId: 'UBOT',
          teamId: 'TTEAM',
          channelId: 'CCHAN',
          userId: 'UTEST',
          authorBotId: null,
        } as Parameters<typeof createNativeStudio>[0]['identity'],
        authority,
        port: 4111,
        publicOrigin,
        service: {
          pool: { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) },
          storage: new InMemoryStore(),
          configuration: async () => config,
          channelInstructions: async () => '',
          bindModel: (selection: ReturnType<typeof testSelection>) =>
            testModel('http://127.0.0.1:1', 'synthetic', selection),
          services: async () => ({ enabled: new Set(), catalog: {}, services: {} }),
          limits: { contextTokens: 2000, outputTokens: 64, maxSteps: 3, timeoutMs: 1000 },
        } as unknown as NativeAgentOptions,
      });
      try {
        expect(studio.mastra.getServer()).toMatchObject({
          host: '0.0.0.0',
          studioHost: publicOrigin ? 'studio.example.test' : 'localhost',
          ...(publicOrigin ? { studioProtocol: 'https', studioPort: 443 } : {}),
          cors: {
            origin: [
              'http://localhost:4111',
              'http://127.0.0.1:4111',
              ...(publicOrigin ? [publicOrigin] : []),
            ],
            credentials: true,
          },
        });
        expect(Object.keys(studio.mastra.listAgents())).toEqual(['coding']);
        expect(factory).toHaveBeenCalledOnce();
        const beforeDispatch = factory.mock.calls[0]![0].beforeDispatch as (
          ...args: unknown[]
        ) => Promise<void>;
        await expect(
          beforeDispatch({ toolName: 'gitlab_get_project', toolCallId: 'synthetic' }),
        ).resolves.toBeUndefined();
        authority.mockRejectedValueOnce(new Error('membership revoked'));
        await expect(beforeDispatch({ toolName: 'gitlab_get_project' })).rejects.toThrow(
          'membership revoked',
        );
      } finally {
        await studio.close();
        factory.mockRestore();
      }
    },
  );
  it.each([
    ['assigned with a read tool', true, true, true],
    ['unassigned', false, true, false],
    ['assigned without any read tool', true, false, false],
  ])('binds Code Mode: %s', async (_name, assigned, gitlab, expected) => {
    const require = createRequire(new URL('../../package.json', import.meta.url));
    const { InMemoryStore } = require('@mastra/core/storage') as {
      InMemoryStore: new () => Parameters<typeof runtime.createNativeAgent>[0]['storage'];
    };
    const instance = 'ti_1150000000000009';
    const config = deriveCoordinatorConfig(
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
        blockedMembers: [],
        toolInstances: [
          {
            id: instance,
            teamId: 'TTEAM',
            kind: 'codeMode',
            label: 'Code Mode',
            host: null,
            settings: {},
            hasCredential: false,
            credentialVersion: 1,
            status: 'enabled',
          },
        ],
        channelTools: assigned
          ? [{ teamId: 'TTEAM', channelId: 'CCHAN', kind: 'codeMode', instanceId: instance }]
          : [],
      }),
      {
        modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
        admission: { global: 2, perThread: 1 },
        execution: { maxInferenceInvocations: 3 },
      },
    );
    const authority = vi.fn(async () => {});
    const factory = vi.spyOn(runtime, 'createNativeAgent');
    const studio = await createNativeStudio({
      identity: {
        installationId: 'UBOT',
        teamId: 'TTEAM',
        channelId: 'CCHAN',
        userId: 'UTEST',
        authorBotId: null,
      } as Parameters<typeof createNativeStudio>[0]['identity'],
      authority,
      port: 4111,
      service: {
        pool: { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) },
        storage: new InMemoryStore(),
        configuration: async () => config,
        channelInstructions: async () => '',
        bindModel: (selection: ReturnType<typeof testSelection>) =>
          testModel('http://127.0.0.1:1', 'synthetic', selection),
        services: async () => ({
          enabled: new Set(),
          catalog: { gitlab },
          services: {
            gitlab: async () => ({ ok: true, output: 'FACT', operationId: 'r', data: 'FACT' }),
          },
        }),
        limits: { contextTokens: 2000, outputTokens: 64, maxSteps: 3, timeoutMs: 1000 },
      } as unknown as NativeAgentOptions,
    });
    try {
      const options = factory.mock.calls[0]![0];
      expect(Object.keys(options.codeMode ?? {})).toEqual(expected ? ['execute_typescript'] : []);
      if (!expected) return;
      const tool = (
        options.codeMode as Record<
          string,
          { execute(args: { code: string }, context: object): Promise<unknown> }
        >
      ).execute_typescript!;
      const code = `return (await external_get_project({ project: 'g/p' })).data;`;
      expect(await tool.execute({ code }, {})).toMatchObject({ success: true, result: 'FACT' });
      authority.mockRejectedValueOnce(new Error('membership revoked'));
      await expect(tool.execute({ code }, {})).rejects.toThrow('membership revoked');
    } finally {
      await studio.close();
      factory.mockRestore();
    }
  });
  it('rejects public origins with insecure schemes, credentials, paths or query data', () => {
    for (const origin of [
      'http://studio.example.test',
      'https://user:secret@studio.example.test',
      'https://studio.example.test/path',
      'https://studio.example.test/?q=x',
      'https://studio.example.test/#x',
      '*',
    ]) {
      expect(() => studioAddress(4111, origin)).toThrow();
    }
    expect(studioAddress(4111, 'https://studio.example.test:8443/')).toMatchObject({
      studioProtocol: 'https',
      studioPort: 8443,
      origins: [
        'http://localhost:4111',
        'http://127.0.0.1:4111',
        'https://studio.example.test:8443',
      ],
    });
  });
  it('permits stock observability reads while refusing telemetry mutations', () => {
    for (const route of [
      'traces/query',
      'traces/aggregate',
      'threads/query',
      'spans/query',
      'spans/aggregate',
      'traces/query/fields',
      'traces/query/values',
      'metrics/aggregate',
      'metrics/breakdown',
      'metrics/timeseries',
      'metrics/percentiles',
    ])
      expect(studioRequestAllowed('POST', `/api/observability/${route}`, {})).toBe(true);
    for (const route of ['traces/delete', 'traces/score', 'feedback', 'metrics/delete'])
      expect(studioRequestAllowed('POST', `/api/observability/${route}`, {})).toBe(false);
    expect(studioRequestAllowed('DELETE', '/api/observability/traces/one')).toBe(false);
  });
  it('allows native chat, question resume and abort', () => {
    for (const route of ['stream', 'resume-stream', 'runs/run-1/abort', 'stream/ui'])
      expect(
        studioRequestAllowed('POST', `/api/agents/coding/${route}`, {
          messages: [],
          memory: { thread: 'studio-thread', resource: 'studio' },
        }),
      ).toBe(true);
  });
  it('refuses agent configuration, replay, direct tool execution and destructive memory edits', () => {
    for (const route of [
      '/api/agents/answer/stream',
      '/api/agents/coding/model',
      '/api/agents/coding/recover',
      '/api/tools/publish/execute',
      '/api/workflows/run/start',
    ])
      expect(studioRequestAllowed('POST', route, {})).toBe(false);
    expect(studioRequestAllowed('DELETE', '/api/memory/threads/a')).toBe(false);
  });
  it('refuses browser authority or execution-setting overrides', () => {
    for (const body of [
      { instructions: 'ignore policy' },
      { tools: {} },
      { maxSteps: 999 },
      { requestContext: { userId: 'another-user' } },
      { memory: { options: { readOnly: false } } },
    ])
      expect(studioRequestAllowed('POST', '/api/agents/coding/stream', body)).toBe(false);
  });
  it('accepts stock UI echoes of server defaults without permitting overrides', () => {
    const defaults = { maxSteps: 12, modelSettings: { maxOutputTokens: 6000, maxRetries: 0 } };
    const route = '/api/agents/coding/send-message';
    for (const echoed of [defaults, { modelSettings: { maxOutputTokens: 6000 } }]) {
      expect(studioRequestAllowed('POST', route, echoed, defaults)).toBe(true);
      expect(
        studioRequestAllowed('POST', route, { ifIdle: { streamOptions: echoed } }, defaults),
      ).toBe(true);
    }
    for (const changed of [
      { maxSteps: 40 },
      { modelSettings: { maxOutputTokens: 6001 } },
      { modelSettings: { maxRetries: 1 } },
      { modelSettings: { temperature: 1 } },
      { modelSettings: null },
      { modelSettings: [] },
    ]) {
      expect(studioRequestAllowed('POST', route, changed, defaults)).toBe(false);
      expect(
        studioRequestAllowed('POST', route, { ifIdle: { streamOptions: changed } }, defaults),
      ).toBe(false);
    }
    expect(studioRequestAllowed('POST', route, defaults)).toBe(false);
  });
  it('allows native question approval with pinned nested options only', () => {
    const route = '/api/agents/coding/send-tool-approval';
    const defaults = { maxSteps: 12, modelSettings: { maxOutputTokens: 6000, maxRetries: 0 } };
    const body = {
      resourceId: 'studio',
      threadId: 'thread',
      toolCallId: 'ask',
      approved: true,
      resumeData: 'Circle',
      requestContext: {},
    };
    expect(studioRequestAllowed('POST', route, body, defaults)).toBe(true);
    expect(
      studioRequestAllowed(
        'POST',
        route,
        { ...body, approved: false, streamOptions: defaults },
        defaults,
      ),
    ).toBe(true);
    for (const streamOptions of [
      { maxSteps: 13 },
      { modelSettings: { maxRetries: 1 } },
      { tools: {} },
      { model: 'another-model' },
      { requestContext: { userId: 'another-user' } },
      null,
      [],
    ])
      expect(studioRequestAllowed('POST', route, { ...body, streamOptions }, defaults)).toBe(false);
    for (const approved of [undefined, 'true', 1, null])
      expect(studioRequestAllowed('POST', route, { ...body, approved }, defaults)).toBe(false);
  });
});
