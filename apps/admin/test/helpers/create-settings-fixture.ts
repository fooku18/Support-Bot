/** Populate a disposable settings database for the reopen test. */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AdminStore } from '../../src/store.js';
import { ChannelCommands } from '../../src/channel-commands.js';
import { hashPassword, tokenHash } from '../../src/auth.js';

export async function createSettingsFixture(file: string, key: Buffer): Promise<void> {
  if (existsSync(file)) throw new Error('Supply a new fixture path.');
  const store = await AdminStore.open({ path: file }, key);
  try {
    await store.createAdmin(
      'fixture',
      'operator',
      await hashPassword('synthetic fixture password'),
    );
    await store.createApiToken('fixture', 'automation', tokenHash('synthetic-fixture-api-token'));
    await store.createSession(
      'fixture-session',
      (await store.adminByName('operator'))!.id,
      'fixture-csrf',
      4e12,
    );
    await store.saveInstallation('fixture', {
      teamId: 'T1',
      teamName: 'Fixture workspace',
      botUserId: 'UBOT',
      botId: 'B1',
      botToken: 'xoxb-synthetic-fixture',
      scopes: 'app_mentions:read,chat:write',
    });
    await store.updateInstallation('fixture', 'T1', { status: 'whitelisted' });
    await store.setTrustedBotSender('fixture', 'T1', {
      userId: 'UTEST',
      botId: 'BTEST',
      channelId: 'C1',
    });
    await store.setChannel('fixture', {
      teamId: 'T1',
      channelId: 'C1',
      name: 'fixture',
      isPrivate: false,
      botMember: true,
      enabled: true,
    });
    await store.blockMember('fixture', {
      teamId: 'T1',
      channelId: 'C1',
      userId: 'UBLOCKED',
      displayName: 'Blocked',
    });
    await store.setWorkspaceModel('fixture', 'T1', 'sonnet', ['sonnet', 'opus']);
    await store.setWorkspacePrompt('fixture', 'T1', 'Workspace fixture prompt.');
    await store.setChannelSettings(
      'fixture',
      'T1',
      'C1',
      (await store.channelSettings('T1', 'C1')).fingerprint,
      { model: 'opus', prompt: 'Channel fixture prompt.', autoReplies: false },
      ['sonnet', 'opus'],
    );
    const { instance } = await store.createToolInstance('fixture', 'T1', {
      kind: 'gitlab',
      label: 'Fixture GitLab',
      host: 'gitlab.example.test',
      credential: `glpat-${randomBytes(16).toString('hex')}`,
    });
    await store.assignTool('fixture', 'T1', 'C1', 'gitlab', instance.id);
    await store.setRunLimits('fixture', { ...(await store.runLimits()), maxToolCalls: 17 });
    const commands = new ChannelCommands(store, () => ['sonnet', 'opus']);
    await commands.execute({
      teamId: 'T1',
      channelId: 'C1',
      userId: 'U1',
      messageTs: `${Math.floor(Date.now() / 1000) + 1}.000001`,
      eventId: 'EvFixture',
      text: '<@UBOT> !memory remember Fixture memory.',
    });
    await store.audit('fixture', 'fixture.retained', 'settings');
    const document = (await store.currentDocument())!;
    await store.run(
      'UPDATE config_versions SET compiled_json = ? WHERE version = ?',
      JSON.stringify({ ...document, feedbackIssues: null }),
      document.version,
    );
  } finally {
    await store.close();
  }
}
