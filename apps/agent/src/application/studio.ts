import { registerNativeExport } from '../domain/delivery/register-export.js';
import { providerSearchEnabled } from '../mastra/tools/provider-search.js';
import { createStudioDiagnostics } from '../mastra/studio-observability.js';
import { createHash, randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core/mastra';
import type { Middleware } from '@mastra/core/server';
import type { NativeAgentOptions } from './agent-options.js';
import {
  createNativeAgent,
  NATIVE_AGENT_ID,
  NATIVE_AGENT_VERSION,
} from '../mastra/agents/coding.js';
import { createNativeCodingBinding } from '../mastra/tools/coding.js';
import { createReadServiceTools } from '../mastra/tools/read-services.js';
import { evaluateAuthorization, parseAuthorizationPolicy } from '../domain/authorization/policy.js';
import { coordinatorAdminSnapshot, coordinatorRunConfiguration } from './configuration/config.js';
import { acceptedOriginAllowed } from '../domain/authorization/trusted-intake.js';
import { nativeInstructions } from './instructions.js';
import type { IntakeRequest } from '../contracts/dto.js';

// Stock dashboard read queries use POST; mutations remain unavailable.
const observabilityReads = new Set(
  [
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
  ].map((route) => `/api/observability/${route}`),
);

const agentRoute = `/api/agents/${NATIVE_AGENT_ID}/`;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export function studioAddress(port: number, publicOrigin?: string) {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (!publicOrigin) return { studioHost: 'localhost', origins };
  const url = new URL(publicOrigin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Studio public origin must be an HTTPS origin without credentials or a path');
  return {
    studioHost: url.hostname,
    studioProtocol: 'https' as const,
    studioPort: Number(url.port || 443),
    origins: [...origins, url.origin],
  };
}

/** Studio is a local test ingress, not a Slack receiver. Browser context never
 * supplies identity, credentials, model selection or application instructions. */
export function studioRequestAllowed(
  method: string,
  route: string,
  body: unknown = {},
  defaults: { maxSteps?: number; modelSettings?: object } = {},
) {
  if (method === 'GET' || method === 'OPTIONS') return true;
  if (method !== 'POST') return false;
  if (observabilityReads.has(route)) return true;
  if (route === '/api/memory/threads') return true;
  if (
    !route.startsWith(agentRoute) ||
    !/^(stream(?:\/ui)?|stream-until-idle|resume-stream(?:-until-idle)?|send-message|send-tool-approval|runs\/[^/]+\/abort|threads\/(abort|subscribe))$/.test(
      route.slice(agentRoute.length),
    )
  )
    return false;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const allowed = new Set([
    'messages',
    'memory',
    'threadId',
    'resourceId',
    'runId',
    'resumeData',
    'toolCallId',
    'requestContext',
    'withInitialHistory',
    'withRunStatus',
    'clearPendingSignals',
    'expectedRunId',
    'format',
    'untilIdle',
    'modelSettings',
    'clientTools',
    'tracingOptions',
    'message',
    'ifIdle',
    'maxSteps',
    'approved',
    'streamOptions',
  ]);
  if (Object.keys(body).some((k) => !allowed.has(k))) return false;
  const b = body as Record<string, unknown>;
  const approval = route.endsWith('/send-tool-approval');
  if (approval && typeof b.approved !== 'boolean') return false;
  if (!approval && ('approved' in b || 'streamOptions' in b)) return false;
  if (
    'streamOptions' in b &&
    !studioRequestAllowed('POST', `${agentRoute}stream`, b.streamOptions, defaults)
  )
    return false;
  for (const field of ['requestContext', 'clientTools'])
    if (b[field] && (typeof b[field] !== 'object' || Object.keys(b[field]).length)) return false;
  if ('maxSteps' in b && b.maxSteps !== defaults.maxSteps) return false;
  if ('modelSettings' in b) {
    if (!b.modelSettings || typeof b.modelSettings !== 'object' || Array.isArray(b.modelSettings))
      return false;
    const pinned = defaults.modelSettings as Record<string, unknown> | undefined;
    if (
      Object.entries(b.modelSettings).some(
        ([key, value]) => !pinned || !Object.hasOwn(pinned, key) || value !== pinned[key],
      )
    )
      return false;
  }
  if (b.ifIdle) {
    if (typeof b.ifIdle !== 'object' || Object.keys(b.ifIdle).some((k) => k !== 'streamOptions'))
      return false;
    const nested = (b.ifIdle as { streamOptions?: unknown }).streamOptions ?? {};
    if (!studioRequestAllowed('POST', route, nested, defaults)) return false;
  }
  if (
    b.memory &&
    (typeof b.memory !== 'object' ||
      Object.keys(b.memory).some((k) => !['thread', 'resource'].includes(k)))
  )
    return false;
  return true;
}

export async function createNativeStudio(options: {
  service: NativeAgentOptions;
  identity: IntakeRequest;
  /** Live installation/channel membership check, without pretending a Studio
   * prompt originated from a Slack event. */
  authority(): Promise<void>;
  port: number;
  publicOrigin?: string;
}) {
  const { service, identity } = options;
  const { origins, ...address } = studioAddress(options.port, options.publicOrigin);
  const stop = new AbortController();
  const initial = await service.configuration();
  const instructions = await service.channelInstructions(identity);
  const current = coordinatorRunConfiguration(initial, identity.teamId, identity.channelId);
  const modelKey = current.channel.modelKey ?? initial.modelPolicy.defaultKey;
  const model = initial.modelPolicy.models.find((m) => m.key === modelKey);
  if (!model) throw new Error('studio model unavailable');
  const guard = async (capability?: string) => {
    stop.signal.throwIfAborted();
    const cfg = await service.configuration();
    const { document, policySource } = coordinatorAdminSnapshot(cfg);
    if (
      !acceptedOriginAllowed(
        document,
        {
          installation_id: identity.installationId,
          team_id: identity.teamId,
          channel_id: identity.channelId,
        },
        {
          authorKind: identity.authorBotId ? 'bot' : 'human',
          userId: identity.userId,
          botId: identity.authorBotId,
        },
      )
    )
      throw new Error('studio identity revoked');
    const decision = evaluateAuthorization(parseAuthorizationPolicy(policySource), {
      workspace: identity.teamId,
      channel: identity.channelId,
      user: identity.userId,
      action: capability && capability !== 'gitlab' ? 'tool.use' : 'task.start',
      ...(capability && capability !== 'gitlab'
        ? { resourceType: 'tool' as const, resourceId: capability }
        : {}),
    });
    if (!decision.allowed) throw new Error('studio authorization revoked');
    if (cfg.hash !== initial.hash || (await service.channelInstructions(identity)) !== instructions)
      throw new Error('Studio test policy changed; restart Studio and start a fresh chat');
    await options.authority();
  };
  await guard();
  const binding = await service.services(identity, stop.signal);
  // Message reads act for a Slack thread's requester; Studio has no thread.
  const reads = createReadServiceTools({
    ...binding,
    catalog: { ...binding.catalog, slackMessages: false },
    authorize: guard,
  });
  const workspaceId = hash(`studio:${identity.teamId}:${identity.channelId}:${identity.userId}`);
  const taskKey = `studio:${workspaceId}`;
  const runId = randomUUID();
  // Existing application receipt tables in the DEDICATED Studio database. Each
  // publication has a fresh operation identity; unknown writes survive restart.
  const request = async (id: string) =>
    service.pool.query(
      'INSERT INTO native_agents.requests(run_id,task_key,event_id,owner,accepted,execution_policy_hash) VALUES($1::uuid,$2,$1::uuid::text,$1::uuid,$3,$4)',
      [id, taskKey, JSON.stringify({ source: 'studio', ...identity }), initial.hash],
    );
  await request(runId);
  const workspace = await service.coding?.prepare({
    identity,
    taskKey,
    workspaceId,
    runId,
    signal: stop.signal,
    authorize: () => guard('gitlab'),
  });
  const coding = workspace
    ? await createNativeCodingBinding(
        {
          ...workspace,
          workspaceId,
          run: { runId, runSeq: 1, attempt: 1 },
          signal: stop.signal,
          authorize: () => guard('gitlab'),
          publication: async (project, send) => {
            await guard('gitlab');
            const id = randomUUID();
            return send(async () => {
              await guard('gitlab');
              const tx = await service.pool.connect();
              try {
                await tx.query('BEGIN');
                await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,11514))', [
                  taskKey,
                ]);
                if (
                  (
                    await tx.query(
                      "SELECT 1 FROM native_agents.publications WHERE task_key=$1 AND outcome='uncertain'",
                      [taskKey],
                    )
                  ).rowCount
                )
                  throw new Error(
                    'publication uncertain; inspect retained evidence, do not replay',
                  );
                await tx.query(
                  'INSERT INTO native_agents.requests(run_id,task_key,event_id,owner,accepted,execution_policy_hash) VALUES($1::uuid,$2,$1::uuid::text,$1::uuid,$3,$4)',
                  [id, taskKey, JSON.stringify({ source: 'studio', ...identity }), initial.hash],
                );
                await tx.query(
                  "INSERT INTO native_agents.publications(task_key,run_id,project,outcome) VALUES($1,$2,$3,'uncertain')",
                  [taskKey, id, project],
                );
                await tx.query('COMMIT');
              } catch (e) {
                await tx.query('ROLLBACK');
                throw e;
              } finally {
                tx.release();
              }
            }).then(async (evidence) => {
              await guard('gitlab');
              await service.pool.query(
                "UPDATE native_agents.publications SET outcome='confirmed',evidence=$2 WHERE run_id=$1 AND outcome='uncertain'",
                [id, JSON.stringify(evidence)],
              );
              return evidence;
            });
          },
          exportFile: async (file) => {
            await guard();
            const receipt = await registerNativeExport(service.pool, runId, file);
            return {
              ...receipt,
              delivery:
                'Retained in Studio; download the file from the Workspace tab. No Slack upload.',
            };
          },
        },
        reads,
      )
    : undefined;
  const modelBinding = service.bindModel(model, identity);
  const agent = createNativeAgent({
    storage: service.storage,
    model: modelBinding,
    modelForRun: (runId) => service.bindModel(model, identity, { runId, runSeq: 1, studio: true }),
    beforeDispatch: () => guard(),
    ...(providerSearchEnabled(initial, identity)
      ? { webSearch: { authorize: () => guard('webSearch') } }
      : {}),
    tools: reads,
    coding,
    instructions: [
      nativeInstructions,
      current.channel.systemPrompt ?? '',
      instructions,
      'This is a local Studio test session. Do not post or upload to Slack. Coding chats share this Studio workspace; exported snapshots are retained locally and files can be downloaded from the Workspace tab.',
    ].join('\n\n'),
    contextTokens: service.limits.contextTokens,
    outputTokens: service.limits.outputTokens,
    maxSteps: service.limits.maxSteps,
  });
  const resourceId = `studio:${hash(JSON.stringify([identity.teamId, identity.channelId, identity.userId, initial.hash, instructions, NATIVE_AGENT_VERSION]))}`;
  const middleware: Middleware = async (c, next) => {
    // Native request context ownership checks also fence cold resumes from an
    // older trusted definition. UI-selected resource IDs never confer authority.
    c.get('requestContext').set('mastra__resourceId', resourceId);
    const origin = c.req.header('origin');
    if (origin && !origins.includes(origin)) return c.json({ error: 'studio_origin_refused' }, 403);
    let body: unknown = {};
    if (c.req.method === 'POST' && c.req.header('content-type')?.includes('application/json')) {
      try {
        body = await c.req.raw.clone().json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    const defaults = c.req.path.startsWith(agentRoute) ? await agent.getDefaultOptions() : {};
    if (!studioRequestAllowed(c.req.method, c.req.path, body, defaults))
      return c.json({ error: 'test_configuration_is_fixed' }, 403);
    try {
      if (
        c.req.method !== 'GET' &&
        c.req.method !== 'OPTIONS' &&
        !c.req.path.endsWith('/abort') &&
        !observabilityReads.has(c.req.path)
      )
        await guard();
    } catch {
      return c.json({ error: 'test_authority_unavailable_restart_if_configuration_changed' }, 403);
    }
    const execution = c.req.method === 'POST' && !!agent;
    if (execution) mastra.getLogger().info('studio.request.started');
    try {
      await next();
      if (execution) mastra.getLogger().info('studio.request.completed');
    } catch (error) {
      if (execution) mastra.getLogger().error('studio.request.failed');
      throw error;
    }
  };
  const mastra = new Mastra({
    agents: { [NATIVE_AGENT_ID]: agent },
    storage: service.storage,
    ...createStudioDiagnostics([model.model], model.route),
    recovery: { durableAgents: 'off', workflows: 'off' },
    server: {
      host: '0.0.0.0',
      ...address,
      port: options.port,
      handleShutdownSignals: false,
      onError: (error, c) => {
        console.error(
          'Studio request failed',
          error.name,
          error.stack?.split('\n').slice(1, 5).join('\n'),
        );
        return c.json({ error: 'studio_request_failed' }, 500);
      },
      middleware,
      cors: {
        origin: origins,
        credentials: true,
      },
    },
  });
  return {
    mastra,
    async close() {
      stop.abort();
      await mastra.shutdown({ drainTimeout: 30000 });
      await coding?.close();
    },
  };
}
