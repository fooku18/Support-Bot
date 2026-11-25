import { readSecret } from '../infrastructure/secret.js';
import {
  telemetryPool,
  checkTelemetryStorage,
  withTelemetryStore,
} from '../infrastructure/storage/telemetry-store.js';
import { nativeInstructions } from '../application/instructions.js';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { startNativeApplication } from '../application/server.js';
import { nativeConfiguration } from '../application/configuration/native-configuration.js';
import { nativeReadServices } from '../application/bindings/read-services.js';
import { checkNativeStorage, nativeStore } from '../infrastructure/storage/native-store.js';
import { coordinatorAdminSnapshot } from '../application/configuration/config.js';
import {
  createChannelMemoryTransport,
  startChannelMemoryProxy,
} from '../integrations/slack/channel-memory.js';
import { createNativeInputClient } from '../integrations/slack/input-client.js';
import { createNativeMessageClient } from '../integrations/slack/message-client.js';
import { nativeCoding } from '../application/bindings/coding.js';
import { checkNativeCodingSandbox } from '../mastra/tools/coding.js';
import { assertCodeModeRuntime } from '../mastra/tools/code-mode.js';
import { loadModelProviders } from '../integrations/providers/access.js';
import { CostLedger } from '../integrations/providers/ledger.js';
import { createStageLogger } from '../infrastructure/logger.js';
import { configureOutbound, modelFetch } from '../infrastructure/outbound.js';
import { webReaderFromEnv } from '../integrations/web/gemini-reader.js';

import { RuntimeConfigurationError } from '../infrastructure/configuration-error.js';
import { postgresTransport } from '../infrastructure/storage/postgres-connection.js';

function required(env: NodeJS.ProcessEnv, name: string) {
  const v = env[name]?.trim();
  if (!v || /^(<|placeholder|change-?me)/i.test(v))
    throw new RuntimeConfigurationError(`${name} required`);
  return v;
}
function serviceUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('invalid trusted service URL');
  return url.origin;
}
/** Concrete executable native application. All credentials are process/secret
 * owned closures. No generic coordinator, runner claims or automatic recovery. */
export async function startNativeAnswerProcess(
  env: NodeJS.ProcessEnv,
  serve: (
    options: Parameters<typeof startNativeApplication>[0],
  ) => Promise<{ server: { close(): Promise<void> } }> = startNativeApplication,
) {
  // The deployed stack mounts this store. Isolated read-only fixtures omit it.
  const storageDir = env.NATIVE_CODING_STORE;
  if (storageDir !== undefined && !storageDir.trim())
    throw new Error('retained coding store unavailable');
  if (storageDir && (!path.isAbsolute(storageDir) || !fs.lstatSync(storageDir).isDirectory()))
    throw new Error('retained coding store unavailable');
  if (
    Boolean(env.CLI_RUNTIME_URL?.trim()) !== Boolean(env.CLI_RUNTIME_TOKEN?.trim()) ||
    (storageDir && !env.CLI_RUNTIME_URL?.trim())
  )
    throw new RuntimeConfigurationError(
      'CLI_RUNTIME_URL and CLI_RUNTIME_TOKEN must be configured together and are required for coding',
    );
  const cli = env.CLI_RUNTIME_URL?.trim()
    ? {
        url: serviceUrl(required(env, 'CLI_RUNTIME_URL')),
        token: required(env, 'CLI_RUNTIME_TOKEN'),
      }
    : undefined;
  // Any channel can be assigned Code Mode, with or without a coding store.
  assertCodeModeRuntime();
  if (storageDir) await checkNativeCodingSandbox(storageDir);
  const token = required(env, 'SERVICE_TOKEN');
  const adminUrl = serviceUrl(required(env, 'ADMIN_URL'));
  const adminToken = required(env, 'ADMIN_INTERNAL_TOKEN');
  const adapterUrl = serviceUrl(required(env, 'NATIVE_ADAPTER_URL'));
  const providers = loadModelProviders(env);
  const webReader = webReaderFromEnv(env, modelFetch);
  const instance = required(env, 'SUPPORT_AGENT_INSTANCE');
  const admission = { global: 8, perThread: 1 };
  const host = required(env, 'NATIVE_PG_HOST');
  const pool = new Pool({
    host,
    ...postgresTransport(env, host),
    database: 'native_answer',
    user: 'native_answer',
    password: readSecret(env, 'NATIVE_PG_PASSWORD'),
    // One singleton lease, bounded task leases, and two connections for native
    // storage/authority work. Task admission reserves this headroom too.
    max: admission.global + 3,
    connectionTimeoutMillis: 5000,
  });
  let telemetry: Pool | undefined;
  let lease: PoolClient | undefined;
  const ledger = new CostLedger({
    adminUrl,
    adminToken,
    log: createStageLogger('model-providers'),
  });
  let memoryProxy: ReturnType<typeof startChannelMemoryProxy> | undefined;
  let memory: ReturnType<typeof createChannelMemoryTransport> | undefined;
  let application: Awaited<ReturnType<typeof serve>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await application?.server.close();
      } finally {
        await memory?.close();
        await memoryProxy?.close();
        await ledger.close();
        if (lease) {
          await lease.query('SELECT pg_advisory_unlock(115,11513)');
          lease.release();
        }
        await telemetry?.end();
        await pool.end();
      }
    })());
  let stage = 'storage';
  try {
    await checkNativeStorage(pool);
    telemetry = telemetryPool(env);
    if (telemetry) await checkTelemetryStorage(telemetry);
    stage = 'execution-lease';
    lease = await pool.connect();
    if (!(await lease.query('SELECT pg_try_advisory_lock(115,11513) AS held')).rows[0].held)
      throw new Error('native execution authority already active');
    stage = 'configuration';
    const configuration = nativeConfiguration({
      adminUrl,
      adminToken,
      deployment: {
        modelPolicy: providers.modelPolicy,
        admission,
        execution: { maxInferenceInvocations: 1 },
      },
    });
    const adapter = async (route: string, body?: unknown) => {
      const response = await fetch(`${adapterUrl}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(route === '/native-delivery' ? 180000 : 90000),
      });
      if (!response.ok) throw new Error('native adapter authority unavailable');
      return response.json();
    };
    // Reuse the existing authenticated memory transport. The validated admin
    // snapshot is process-owned here, so its proxy can stay on loopback too.
    stage = 'channel-memory';
    memoryProxy = startChannelMemoryProxy({
      host: '127.0.0.1',
      port: 0,
      token,
      adminUrl,
      adminToken,
      ready: () => true,
    });
    await memoryProxy.ready;
    memory = createChannelMemoryTransport({
      baseUrl: `http://127.0.0.1:${memoryProxy.port}`,
      token,
    });
    configureOutbound(env.EGRESS_PROXY_URL);
    ledger.start();
    const readiness = async () => {
      stage = 'readiness-storage';
      await checkNativeStorage(pool);
      stage = 'readiness-configuration';
      const cfg = await configuration();
      const document = coordinatorAdminSnapshot(cfg).document;
      for (const channel of document.toolAssignments) {
        if (
          channel.modelKey &&
          !cfg.modelPolicy.models.some((model) => model.key === channel.modelKey)
        )
          throw new Error('an assigned model key is missing from MODEL_CATALOG');
      }
      stage = 'readiness-memory';
      for (const channel of document.toolAssignments)
        await memory!.snapshot({ teamId: channel.teamId, channelId: channel.channelId });
      stage = 'readiness-adapter';
      await adapter('/native-authority/ready');
    };
    const limits = {
      contextTokens: 24000,
      outputTokens: 6000,
      maxSteps: storageDir ? 40 : 12,
      timeoutMs: storageDir ? 600000 : 120000,
    };
    const messages = createNativeMessageClient({ baseUrl: adapterUrl, token });
    stage = 'dependency-readiness';
    application = await serve({
      service: {
        pool,
        log: createStageLogger('native-answer'),
        storage: telemetry
          ? withTelemetryStore(nativeStore(pool), pool, telemetry)
          : nativeStore(pool),
        observability: !!telemetry,
        configuration,
        limits,
        bindModel: (model, identity, attribution) =>
          providers.bind(
            model,
            attribution && {
              sink: ledger,
              run: {
                instance,
                teamId: identity.teamId,
                channelId: identity.channelId,
                rootTs: identity.rootTs,
                requesterUserId: identity.userId,
                runId: attribution.runId,
                runSeq: attribution.runSeq,
                attempt: 1,
                model,
                mode: attribution.studio ? 'studio' : storageDir ? 'coding' : 'answer',
              },
            },
          ),
        instructions: nativeInstructions,
        ...(storageDir && cli
          ? {
              coding: nativeCoding({
                configuration,
                storageDir,
                adminUrl,
                adminToken,
                ...cli,
              }),
            }
          : {}),
        inputs: createNativeInputClient({ baseUrl: adapterUrl, token }),
        messages,
        services: nativeReadServices({
          configuration,
          cli,
          messages,
          ...(webReader
            ? { web: { reader: webReader } }
            : env.WEB_RUNTIME_URL || env.WEB_RUNTIME_TOKEN
              ? {
                  web: {
                    url: serviceUrl(required(env, 'WEB_RUNTIME_URL')),
                    token: required(env, 'WEB_RUNTIME_TOKEN'),
                  },
                }
              : {}),
        }),
        authority: async (identity) => {
          await adapter('/native-authority/check', identity);
        },
        channelInstructions: async (identity) =>
          (await memory!.snapshot({ teamId: identity.teamId, channelId: identity.channelId }))
            .rendered,
      },
      transport: {
        host: env.NATIVE_BIND_HOST ?? '0.0.0.0',
        port: Number(required(env, 'NATIVE_APPLICATION_PORT')),
        token,
        readiness,
        send: async (value) => (await adapter('/native-delivery', value)) as { ts?: string },
      },
    });
    return { ...application, close };
  } catch (error) {
    console.error(`native startup dependency refused: ${stage}`);
    await close();
    throw error;
  }
}
