import { testSelection } from '../model-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { nativeReadServices } from '../../src/application/bindings/read-services.js';
import { createReadServiceTools } from '../../src/mastra/tools/read-services.js';
import type { IntakeRequest } from '../../src/contracts/dto.js';

const identity = { teamId: 'TTEAM', channelId: 'CCHAN', userId: 'UTEST' } as IntakeRequest;
const KEY = 'AbCdEf0123456789';

const datafile = {
  version: '4',
  revision: '7',
  projectId: '1001',
  environmentKey: 'production',
  featureFlags: [
    { id: 'f1', key: 'shop_banner', rolloutId: 'r1', experimentIds: [], variables: [] },
  ],
  experiments: [],
  rollouts: [
    {
      id: 'r1',
      experiments: [
        {
          id: '8001',
          key: 'everyone',
          status: 'Running',
          audienceIds: [],
          variations: [{ id: '7001', key: 'on', featureEnabled: true, variables: [] }],
          trafficAllocation: [{ entityId: '7001', endOfRange: 10000 }],
        },
      ],
    },
  ],
  audiences: [],
  events: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(assigned: boolean) {
  return deriveCoordinatorConfig(
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
          id: 'ti_1150000000000009',
          teamId: 'TTEAM',
          kind: 'optimizely',
          label: 'Optimizely',
          host: null,
          settings: { datafiles: [{ name: 'Shop', sdkKey: KEY }] },
          hasCredential: false,
          credentialVersion: 0,
          status: 'enabled',
        },
      ],
      channelTools: assigned
        ? [
            {
              teamId: 'TTEAM',
              channelId: 'CCHAN',
              kind: 'optimizely',
              instanceId: 'ti_1150000000000009',
            },
          ]
        : [],
    }),
    {
      modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
      admission: { global: 1, perThread: 1 },
      execution: { maxInferenceInvocations: 5 },
    },
  );
}

it('offers optimizely_lookup on an assigned instance, reads the configured datafile and authorizes each call', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(datafile));
  });
  const assigned = config(true);
  const binding = await nativeReadServices({ configuration: async () => assigned })(
    identity,
    new AbortController().signal,
  );
  expect([...binding.enabled]).toEqual(['optimizely']);
  const checks: string[] = [];
  const tools = createReadServiceTools({
    ...binding,
    authorize: async (capability) => {
      checks.push(capability);
    },
  });
  const reply = (await tools.optimizely_lookup!.execute!(
    { query: 'shop_banner' },
    {} as Parameters<NonNullable<NonNullable<typeof tools.optimizely_lookup>['execute']>>[1],
  )) as { result: { ok: boolean; data: { found: boolean; flags: unknown[] } } };
  expect(reply.result.ok).toBe(true);
  expect(reply.result.data).toMatchObject({ found: true, flags: [{ flag: 'shop_banner' }] });
  expect(urls).toEqual([`https://cdn.optimizely.com/datafiles/${KEY}.json`]);
  expect(checks).toEqual(['optimizely', 'optimizely']);
});

it('offers no optimizely tool when the instance is not assigned to the channel', async () => {
  const unassigned = config(false);
  const binding = await nativeReadServices({ configuration: async () => unassigned })(
    identity,
    new AbortController().signal,
  );
  expect(binding.enabled.has('optimizely')).toBe(false);
  const tools = createReadServiceTools({ ...binding, authorize: async () => {} });
  expect(tools.optimizely_lookup).toBeUndefined();
});
