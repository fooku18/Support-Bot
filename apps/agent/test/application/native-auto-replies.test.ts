import { testModel, testSelection } from '../model-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { PostgresStore } from '@mastra/pg';
import { compileDocument } from '../../../admin/src/compile.js';
import { createNativeAgentService } from '../../src/application/agent-service.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';

function setup() {
  let autoReplies = false;
  let blocked = false;
  let version = 0;
  const connect = vi.fn().mockRejectedValue(new Error('admission reached'));
  const pool = {
    options: { max: 10 },
    connect,
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  const authority = vi.fn().mockResolvedValue(undefined);
  const services = vi.fn();
  const configuration = async () =>
    deriveCoordinatorConfig(
      compileDocument(++version, {
        installations: [
          {
            teamId: 'T1',
            teamName: 'Synthetic',
            botUserId: 'UBOT',
            botId: 'B1',
            status: 'whitelisted',
            trustedBotSender: null,
          },
        ],
        channels: [{ teamId: 'T1', channelId: 'C1', enabled: true }],
        blockedMembers: blocked ? [{ teamId: 'T1', channelId: 'C1', userId: 'U1' }] : [],
        toolInstances: [],
        channelTools: [],
        replySettings: [{ teamId: 'T1', channelId: 'C1', autoReplies }],
      }),
      {
        modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
        admission: { global: 5, perThread: 1 },
        execution: { maxInferenceInvocations: 4 },
      },
    );
  const service = createNativeAgentService({
    pool,
    log: { info() {}, warn() {}, error() {} },
    storage: {} as PostgresStore,
    configuration,
    authority,
    bindModel: (selection) => testModel('http://unused', 'synthetic', selection),
    instructions: 'Synthetic',
    services,
    channelInstructions: async () => '',
    limits: { contextTokens: 1000, outputTokens: 100, maxSteps: 2, timeoutMs: 1000 },
  });
  const input = {
    installationId: 'UBOT',
    teamId: 'T1',
    channelId: 'C1',
    rootTs: '1794740012.100003',
    messageTs: '1794740013.100004',
    userId: 'U1',
    eventId: 'EvReply',
    text: 'Follow up',
    canonicalText: 'Follow up',
    authorBotId: null,
  };
  return {
    service,
    input,
    connect,
    services,
    authority,
    setEnabled: (enabled: boolean) => {
      autoReplies = enabled;
    },
    block: () => {
      blocked = true;
    },
  };
}

describe('native automatic reply admission reads current channel settings', () => {
  it('refuses a disabled automatic reply before a task lease, durable request or model call', async () => {
    const { service, input, connect, services, authority } = setup();
    await expect(service.followup(input, 'previous-owner')).rejects.toThrow(
      'automatic_replies_disabled',
    );
    expect(authority).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(services).not.toHaveBeenCalled();
    await service.close();
  });

  it('reads a toggle afresh for each automatic reply while explicit mentions still reach admission', async () => {
    const { service, input, connect, setEnabled } = setup();
    setEnabled(true);
    await expect(service.followup(input, 'previous-owner')).rejects.toThrow('admission reached');
    setEnabled(false);
    await expect(service.followup(input, 'previous-owner')).rejects.toThrow(
      'automatic_replies_disabled',
    );
    await expect(service.start({ ...input, eventId: 'EvMention' })).rejects.toThrow(
      'admission reached',
    );
    expect(connect).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('retains current policy checks before considering the automatic reply preference', async () => {
    const { service, input, block, connect } = setup();
    block();
    await expect(service.followup(input, 'previous-owner')).rejects.toThrow(
      'authorization_revoked',
    );
    expect(connect).not.toHaveBeenCalled();
    await service.close();
  });
});
