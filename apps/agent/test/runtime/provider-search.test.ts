import { testSelection } from '../model-fixture.js';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';
import { nativeInstructions } from '../../src/application/instructions.js';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { providerSearchEnabled } from '../../src/mastra/tools/provider-search.js';
import { fixture, searchCall, searchResult, send, text } from './provider-search-fixture.js';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { InMemoryStore } = require('@mastra/core/storage') as {
  InMemoryStore: new () => Parameters<typeof createNativeRuntime>[0]['storage'];
};
const cleanup: Array<() => Promise<void>> = [];
it('requires a ready assignment and an actor grant before exposing hosted search', () => {
  const identity = { teamId: 'TTEAM', channelId: 'CCHAN', userId: 'UTEST' };
  const config = (assigned = true, enabled = true, blocked = false) =>
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
        blockedMembers: blocked ? [identity] : [],
        toolInstances: [
          {
            id: 'ti_1150000000000002',
            teamId: 'TTEAM',
            kind: 'webSearch',
            label: 'Provider search',
            host: null,
            settings: {},
            hasCredential: false,
            credentialVersion: 1,
            status: enabled ? 'enabled' : 'disabled',
          },
        ],
        channelTools: assigned
          ? [
              {
                teamId: 'TTEAM',
                channelId: 'CCHAN',
                kind: 'webSearch',
                instanceId: 'ti_1150000000000002',
              },
            ]
          : [],
      }),
      {
        modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic', true)] },
        admission: { global: 1, perThread: 1 },
        execution: { maxInferenceInvocations: 3 },
      },
    );
  expect(providerSearchEnabled(config(), identity)).toBe(true);
  expect(providerSearchEnabled(config(false), identity)).toBe(false);
  expect(providerSearchEnabled(config(true, false), identity)).toBe(false);
  expect(providerSearchEnabled(config(true, true, true), identity)).toBe(false);
  expect(providerSearchEnabled(config(), { ...identity, channelId: 'COTHER' })).toBe(false);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(assigned = true, respond?: Parameters<typeof fixture>[0]) {
  const f = await fixture(respond);
  cleanup.push(f.close);
  let allowed = true;
  const authorize = vi.fn(async () => {
    if (!allowed) throw new Error('search assignment revoked');
  });
  const runtime = createNativeRuntime({
    storage: new InMemoryStore(),
    model: f.request,
    instructions: nativeInstructions,
    tools: {},
    beforeDispatch: async () => {},
    ...(assigned ? { webSearch: { authorize } } : {}),
    contextTokens: 12000,
    outputTokens: 1000,
    maxSteps: 3,
  });
  cleanup.push(() => runtime.mastra.shutdown());
  const run = async (thread = 'search-thread', prompt = 'Search RFC 2606 and cite the source.') => {
    const segment = await runtime.agent.stream(prompt, {
      memory: { thread, resource: 'search-resource' },
      closeOnSuspend: true,
    });
    return runNativeSegment(segment);
  };
  return {
    ...f,
    runtime,
    run,
    authorize,
    revoke: () => {
      allowed = false;
    },
  };
}

it('runs hosted search directly in the durable native agent, with citations and fresh follow-up evidence', async () => {
  const f = await setup(true, (res, index) => {
    send(res, [
      searchCall(`search-${index}`),
      searchResult(undefined, `search-${index}`),
      text('Reserved Top Level DNS Names: https://www.rfc-editor.org/rfc/rfc2606'),
    ]);
  });
  const first = await f.run();
  expect(first.uncertain).toBe(false);
  expect(first.text).toContain('https://www.rfc-editor.org/rfc/rfc2606');
  expect(first.webSearch).toEqual([{ toolCallId: 'search-1', results: 1 }]);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.body.tools).toContainEqual({
    name: 'web_search',
    type: 'web_search_20250305',
    max_uses: 1,
  });
  expect(f.authorize).toHaveBeenCalledTimes(1);
  const next = await f.run('search-thread', 'Search again for the publication year.');
  expect(next.uncertain).toBe(false);
  expect(next.webSearch).toEqual([{ toolCallId: 'search-2', results: 1 }]);
  expect(f.requests).toHaveLength(2);
  // The supported provider serialization preserves hosted calls/results on recall.
  expect(JSON.stringify(f.requests[1]!.body.messages)).toContain('web_search_tool_result');
});

it('never exposes search or records evidence when unassigned, or when the answer comes from memory', async () => {
  const f = await setup(false, (res) => send(res, [text('No search available.')]));
  const result = await f.run();
  expect(f.requests[0]!.body.tools).not.toContainEqual(
    expect.objectContaining({ name: 'web_search' }),
  );
  expect(result.webSearch).toEqual([]);
  expect(f.authorize).not.toHaveBeenCalled();
});

it('does not count provider search errors as completed searches', async () => {
  const f = await setup(true, (res) =>
    send(res, [
      searchCall(),
      searchResult({ type: 'web_search_tool_result_error', error_code: 'unavailable' }),
      text('Search failed.'),
    ]),
  );
  const result = await f.run();
  expect(result.webSearch).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

it('checks search authority before every dispatch and prevents a revoked follow-up request', async () => {
  const f = await setup();
  await f.run();
  f.revoke();
  await expect(f.run('search-thread', 'Search once more.')).rejects.toThrow(
    'search assignment revoked',
  );
  expect(f.requests).toHaveLength(1);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
