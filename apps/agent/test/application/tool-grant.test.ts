import { testSelection } from '../model-fixture.js';
import { expect, it } from 'vitest';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { channelToolGranted } from '../../src/application/tool-grant.js';

const identity = { teamId: 'TTEAM', channelId: 'CCHAN', userId: 'UTEST' };
const INSTANCE = 'ti_1150000000000009';

function config({ assigned = true, enabled = true, blocked = false, channel = true } = {}) {
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
      channels: [{ teamId: 'TTEAM', channelId: 'CCHAN', enabled: channel }],
      blockedMembers: blocked ? [identity] : [],
      toolInstances: [
        {
          id: INSTANCE,
          teamId: 'TTEAM',
          kind: 'codeMode',
          label: 'Code Mode',
          host: null,
          settings: {},
          hasCredential: false,
          credentialVersion: 1,
          status: enabled ? 'enabled' : 'disabled',
        },
      ],
      channelTools: assigned
        ? [{ teamId: 'TTEAM', channelId: 'CCHAN', kind: 'codeMode', instanceId: INSTANCE }]
        : [],
    }),
    {
      modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
      admission: { global: 1, perThread: 1 },
      execution: { maxInferenceInvocations: 3 },
    },
  );
}

it('grants a kind only to an allowed actor of a channel with a ready assignment', () => {
  expect(channelToolGranted(config(), identity, 'codeMode')).toBe(true);
  expect(channelToolGranted(config(), identity, 'webSearch')).toBe(false);
  expect(channelToolGranted(config(), { ...identity, channelId: 'COTHER' }, 'codeMode')).toBe(
    false,
  );
  for (const denied of [{ assigned: false }, { enabled: false }, { blocked: true }])
    expect(channelToolGranted(config(denied), identity, 'codeMode')).toBe(false);
});
