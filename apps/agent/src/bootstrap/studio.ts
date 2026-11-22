import { studioStore } from '../infrastructure/storage/studio-store.js';
import { startNativeAnswerProcess } from './application.js';
import { createNativeStudio } from '../application/studio.js';
import { coordinatorAdminSnapshot } from '../application/configuration/config.js';
import { InstallationRegistry } from '../../../slack/src/installations.js';
import { createOutboundAgent } from '../../../slack/src/outbound.js';
import { isChannelMember } from '../../../slack/src/membership.js';
import { assertPrivateWorkspaceChannel } from '../../../slack/src/file-upload.js';
import { createStageLogger } from '../../../slack/src/logger.js';
import type { Mastra } from '@mastra/core/mastra';

const env = process.env;
if (env.NATIVE_STUDIO !== 'testing' || !env.STUDIO_TEAM_ID || !env.STUDIO_CHANNEL_ID)
  throw new Error('Use npm run studio -- --instance-dir <designated test instance>');
const port = Number(env.STUDIO_PORT ?? 4111);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
  throw new Error('invalid Studio port');
let registered: Mastra | undefined;
const registry = new InstallationRegistry({
  adminUrl: env.ADMIN_URL!,
  adminToken: env.ADMIN_INTERNAL_TOKEN!,
  pollIntervalMs: 2000,
  agent: createOutboundAgent(env.STUDIO_SLACK_PROXY_URL),
  log: createStageLogger('studio-installation'),
});
await registry.syncOnce();
const application = await startNativeAnswerProcess(env, async (setup) => {
  await setup.transport.readiness?.();
  const cfg = await setup.service.configuration();
  const installation = coordinatorAdminSnapshot(cfg).document.installations.find(
    (i) => i.teamId === env.STUDIO_TEAM_ID,
  );
  const sender = installation?.trustedBotSender;
  if (!installation || !sender || sender.channelId !== env.STUDIO_CHANNEL_ID)
    throw new Error('designated test sender unavailable');
  const studio = await createNativeStudio({
    service: {
      ...setup.service,
      storage: setup.service.observability
        ? setup.service.storage
        : studioStore(setup.service.pool),
    },
    port,
    publicOrigin: env.STUDIO_PUBLIC_ORIGIN,
    identity: {
      installationId: installation.botUserId,
      teamId: env.STUDIO_TEAM_ID!,
      channelId: env.STUDIO_CHANNEL_ID!,
      userId: sender.userId,
      authorBotId: sender.botId,
      // Local Studio scope only. This is never submitted as a Slack source event.
      rootTs: '1000000000.000001',
      messageTs: '1000000000.000001',
      eventId: 'studio',
      text: '',
      canonicalText: '',
    },
    authority: async () => {
      await registry.syncOnce();
      const current = registry.get(env.STUDIO_TEAM_ID!);
      if (
        !registry.synced ||
        !current ||
        current.identity.installationId !== installation.botUserId
      )
        throw new Error('test installation changed');
      await assertPrivateWorkspaceChannel(current.slack, env.STUDIO_CHANNEL_ID!);
      if (!(await isChannelMember(current, env.STUDIO_CHANNEL_ID!, sender.userId)))
        throw new Error('test membership revoked');
    },
  });
  registered = studio.mastra;
  return { server: { close: studio.close } };
});
export const mastra = registered!;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void application.close().then(
      async () => {
        registry.stop();
        await registry.settled();
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
