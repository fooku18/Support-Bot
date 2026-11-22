import path from 'node:path';
import type { NativeAgentOptions } from '../agent-options.js';
import { coordinatorRunConfiguration, type CoordinatorConfig } from '../configuration/config.js';
import { resolveChannelTools } from '../../integrations/tools/tool-profile.js';
import { fetchToolSecret } from '../../integrations/tools/tool-instances.js';
import {
  fetchCliRuntimeReadiness,
  verifyGitlabInstance,
} from '../../integrations/tools/tool-runtime-readiness.js';
import { gitlabViaRuntime } from '../../integrations/tools/runtime-client.js';
import { operationScopeLabel } from '../../integrations/gitlab/gitlab-operations.js';
import { normalizeGitlabOutput } from '../../integrations/gitlab/gitlab-cli-adapter.js';
import { createStageLogger } from '../../infrastructure/logger.js';

/** Trusted deployment binding for the reviewed native coding tools. The Git
 * credential stays in process-local domain closures, outside Workspace and
 * framework state. Typed API operations still use the credential-owning runtime. */
export function nativeCoding(options: {
  configuration(): Promise<CoordinatorConfig>;
  storageDir: string;
  adminUrl: string;
  adminToken: string;
  url: string;
  token: string;
}): NonNullable<NativeAgentOptions['coding']> {
  if (!path.isAbsolute(options.storageDir)) throw new Error('absolute coding store required');
  return {
    version: '1',
    async prepare({ identity, signal, authorize }) {
      const assigned = async () => {
        const cfg = await options.configuration();
        const current = coordinatorRunConfiguration(cfg, identity.teamId, identity.channelId);
        const { profile } = resolveChannelTools(
          {
            teamId: identity.teamId,
            channelId: identity.channelId,
            tools: current.tools,
            configVersion: cfg.version,
            modelKey: current.channel.modelKey,
            systemPrompt: current.channel.systemPrompt,
          },
          { gitlab: true },
        );
        return profile.gitlab;
      };
      const pinned = await assigned();
      if (!pinned) return;
      const checkBinding = async () => {
        signal.throwIfAborted();
        await authorize();
        if (JSON.stringify(await assigned()) !== JSON.stringify(pinned))
          throw new Error('coding GitLab binding changed');
      };
      const checkRuntime = async () => {
        const ready = await fetchCliRuntimeReadiness(options.url, options.token);
        if (ready.syncError) throw new Error('tool configuration unavailable');
        verifyGitlabInstance(
          ready.instances.find((i) => i.instanceId === pinned.instanceId),
          pinned,
          identity.teamId,
        );
      };
      const check = async () => {
        await checkBinding();
        await checkRuntime();
      };
      await checkBinding();
      let secret;
      try {
        await checkRuntime();
        // The Git transport owns the only credential acquired by this process.
        secret = await fetchToolSecret(
          { adminUrl: options.adminUrl, adminToken: options.adminToken, caller: 'runner' },
          pinned.instanceId,
        );
        await checkRuntime();
      } catch {
        await checkBinding();
        return;
      }
      await checkBinding();
      if (
        secret.teamId !== identity.teamId ||
        secret.kind !== 'gitlab' ||
        secret.credentialVersion !== pinned.credentialVersion
      )
        return;
      const redact = (s: string) =>
        [secret.credential, Buffer.from(`oauth2:${secret.credential}`).toString('base64')].reduce(
          (text, value) => text.replaceAll(value, '[redacted]'),
          s,
        );
      const logger = createStageLogger('native-publication');
      return {
        storageDir: options.storageDir,
        gitlabHost: pinned.host,
        gitlabToken: secret.credential,
        transfer: { maxFiles: 10000, maxFileBytes: 16 * 1024 ** 2, maxTotalBytes: 128 * 1024 ** 2 },
        redact,
        log: {
          info: (s) => logger.info(redact(s)),
          warn: (s) => logger.warn(redact(s)),
          error: (s) => logger.error(redact(s)),
        },
        async gitlab(operation) {
          await check();
          const response = await gitlabViaRuntime(
            {
              instanceId: pinned.instanceId,
              teamId: identity.teamId,
              credentialVersion: pinned.credentialVersion,
              operation: operation.kind,
              operationArgs: operation,
              timeoutMs: 30000,
              maxOutputBytes: 200000,
            },
            options.url,
            options.token,
            40000,
            signal,
            check,
          );
          await check();
          if (response.status === 'not_run') throw new Error('GitLab operation refused');
          if (response.truncated) throw new Error('GitLab evidence incomplete');
          return normalizeGitlabOutput({
            operation: operation.kind,
            project: operationScopeLabel(operation),
            exitCode: response.exitCode,
            status: response.status,
            stdout: redact(response.output),
            stderr: redact(response.stderr ?? ''),
            ...('page' in operation ? { page: operation.page } : {}),
            ...('per_page' in operation ? { per_page: operation.per_page } : {}),
            ...(operation.kind === 'search' ? { scope: operation.scope } : {}),
            textMeta: response.textMeta,
          });
        },
      };
    },
  };
}
