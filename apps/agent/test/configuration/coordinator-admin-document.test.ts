import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { compileDocument } from '../../../admin/src/compile.js';
import { parseCoordinatorAdminDocument } from '../../src/application/configuration/admin-document.js';

function document() {
  return compileDocument(7, {
    installations: [
      {
        teamId: 'TTEAM',
        teamName: 'Synthetic',
        botUserId: 'UBOT',
        botId: 'BBOT',
        status: 'whitelisted',
        installedAt: 100,
        trustedBotSender: { botId: 'BTEST', userId: 'UTEST', channelId: 'CCHAN' },
      },
    ],
    channels: [{ teamId: 'TTEAM', channelId: 'CCHAN', enabled: true }],
    blockedMembers: [{ teamId: 'TTEAM', channelId: 'CCHAN', userId: 'UBLOCKED' }],
    modelAssignments: [{ teamId: 'TTEAM', channelId: 'CCHAN', modelKey: 'small' }],
    promptAssignments: [
      { teamId: 'TTEAM', channelId: 'CCHAN', text: 'Exact channel instructions' },
    ],
    replySettings: [{ teamId: 'TTEAM', channelId: 'CCHAN', autoReplies: false }],
    toolInstances: [
      {
        id: 'ti_0000000000000001',
        teamId: 'TTEAM',
        kind: 'gitlab',
        label: 'Fixture',
        host: 'gitlab.example.test',
        settings: {},
        hasCredential: true,
        credentialVersion: 3,
        status: 'enabled',
      },
    ],
    channelTools: [
      { teamId: 'TTEAM', channelId: 'CCHAN', kind: 'gitlab', instanceId: 'ti_0000000000000001' },
    ],
  });
}

function rehash(input: ReturnType<typeof document>) {
  const { version, installations, authorizationPolicy, toolAssignments, runLimits } = input;
  const body = { version, installations, authorizationPolicy, toolAssignments, runLimits };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

it('retains every compiled admin section, source identity and exact channel choices', () => {
  const source = document();
  const parsed = parseCoordinatorAdminDocument(source);
  expect(parsed.document).toEqual(source);
  expect(parseCoordinatorAdminDocument(JSON.parse(parsed.sourceJson)).document.hash).toBe(
    source.hash,
  );
  expect(parsed.policySource).toBe(JSON.stringify(source.authorizationPolicy));
  expect(parsed.trustedEditSenders).toEqual([
    { teamId: 'TTEAM', botId: 'BTEST', userId: 'UTEST', channelId: 'CCHAN' },
  ]);
  expect(parsed.document.toolAssignments[0]).toMatchObject({
    modelKey: 'small',
    systemPrompt: 'Exact channel instructions',
    autoReplies: false,
    tools: [{ instanceId: 'ti_0000000000000001', credentialVersion: 3 }],
  });
  source.toolAssignments[0]!.systemPrompt = 'mutated after validation';
  expect(parsed.document.toolAssignments[0]!.systemPrompt).toBe('Exact channel instructions');
});

it('refuses malformed or omitted sections even when their document hash is recomputed', () => {
  const mutations: Array<(v: ReturnType<typeof document>) => void> = [
    (v) => {
      Reflect.deleteProperty(v, 'runLimits');
    },
    (v) => {
      v.installations[0]!.trustedBotSender!.channelId = '*';
    },
    (v) => {
      v.installations.push(v.installations[0]!);
    },
    (v) => {
      v.toolAssignments[0]!.tools[0]!.credentialVersion = -1;
    },
    (v) => {
      v.toolAssignments[0]!.systemPrompt = '';
    },
    (v) => {
      v.runLimits.maxCostUsd = -1;
    },
    (v) => {
      v.authorizationPolicy.defaults = { decision: 'allow' };
    },
  ];
  for (const mutate of mutations) {
    const source = document();
    mutate(source);
    expect(() => parseCoordinatorAdminDocument(rehash(source))).toThrow(
      'Invalid coordinator admin document',
    );
  }
});

it('rejects stale hashes, unsupported top-level fields and duplicate or foreign channel identities', () => {
  const source = document();
  source.toolAssignments[0]!.systemPrompt = 'tampered';
  expect(() => parseCoordinatorAdminDocument(source)).toThrow();
  expect(() => parseCoordinatorAdminDocument({ ...document(), futurePolicy: {} })).toThrow();
  const duplicate = document();
  duplicate.toolAssignments.push(duplicate.toolAssignments[0]!);
  expect(() => parseCoordinatorAdminDocument(rehash(duplicate))).toThrow();
  const foreign = document();
  foreign.toolAssignments[0]!.teamId = 'TFOREIGN';
  expect(() => parseCoordinatorAdminDocument(rehash(foreign))).toThrow();
});

it('accepts the real empty-admin deny-all document without inventing grants', () => {
  const source = compileDocument(1, { installations: [], channels: [], blockedMembers: [] });
  const parsed = parseCoordinatorAdminDocument(source);
  expect(parsed.document).toEqual(source);
  expect(parsed.trustedEditSenders).toEqual([]);
});
