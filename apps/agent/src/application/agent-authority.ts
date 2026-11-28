import { modelConversationIdentity } from '../contracts/model-catalog.js';
import type { IntakeRequest } from '../contracts/dto.js';
import {
  evaluateAuthorization,
  parseAuthorizationPolicy,
  type AuthorizationAction,
} from '../domain/authorization/policy.js';
import { acceptedOriginAllowed } from '../domain/authorization/trusted-intake.js';
import { NATIVE_INPUT_VERSION, type NativeInputIdentity } from '../domain/files/native-inputs.js';
import { NATIVE_AGENT_VERSION } from '../mastra/agents/coding.js';
import {
  coordinatorAdminSnapshot,
  coordinatorRunConfiguration,
  type CoordinatorConfig,
} from './configuration/config.js';
import type { IdentityRow, NativeAgentOptions } from './agent-options.js';
import { digest, fail } from './agent-support.js';
import { CoordinatorError } from './errors.js';
import type { createNativeAgentStorage } from '../infrastructure/storage/agent-storage.js';

/** Current owner, policy and original input provenance, rechecked at effect boundaries. */
export function createNativeAgentAuthority(
  options: NativeAgentOptions,
  receipts: ReturnType<typeof createNativeAgentStorage>,
) {
  const { stopped, inputReceipts } = receipts;
  async function authorize(
    row: IdentityRow,
    action: AuthorizationAction,
    capability?: string,
    admission = false,
    externalAuthority = true,
  ) {
    const currentOwner = (
      await options.pool.query('SELECT owner FROM native_agents.tasks WHERE task_key=$1', [
        row.task_key,
      ])
    ).rows[0];
    if (!admission && currentOwner?.owner !== row.owner) fail('stale_owner');
    const cfg = await options.configuration();
    const { document, policySource } = coordinatorAdminSnapshot(cfg);
    const i = row.accepted;
    const task = { installation_id: i.installationId, team_id: i.teamId, channel_id: i.channelId };
    if (
      !acceptedOriginAllowed(document, task, {
        authorKind: i.authorBotId ? 'bot' : 'human',
        userId: i.userId,
        botId: i.authorBotId ?? null,
      })
    )
      fail('origin_revoked');
    const decision = evaluateAuthorization(parseAuthorizationPolicy(policySource), {
      workspace: i.teamId,
      channel: i.channelId,
      user: i.userId,
      action,
      ...(capability && capability !== 'gitlab'
        ? { resourceType: 'tool' as const, resourceId: capability }
        : {}),
    });
    if (!decision.allowed) fail('authorization_revoked');
    if (externalAuthority) await options.authority?.(i);
    if (capability) {
      const tool = coordinatorRunConfiguration(cfg, i.teamId, i.channelId).tools.find(
        (t) => t.kind === capability && t.ready,
      );
      if (!tool) fail('service_unavailable');
    }
    return cfg;
  }
  async function definition(identity: IntakeRequest, cfg: CoordinatorConfig) {
    const current = coordinatorRunConfiguration(cfg, identity.teamId, identity.channelId);
    const key = current.channel.modelKey ?? cfg.modelPolicy.defaultKey;
    const model = cfg.modelPolicy.models.find((m) => m.key === key);
    if (!model) fail('model_unavailable');
    const instructions = [
      options.instructions,
      current.channel.systemPrompt ?? '',
      await options.channelInstructions(identity),
    ].join('\n\n');
    return {
      key,
      model,
      instructions,
      hash: digest(
        JSON.stringify({
          model: [...modelConversationIdentity(model), model.webSearch],
          instructions,
          tools: current.tools,
          limits: options.limits,
          inputs: options.inputs ? NATIVE_INPUT_VERSION : null,
          agent: NATIVE_AGENT_VERSION,
        }),
      ),
    };
  }
  /** Current authorization of a run's recipient: owner, origin, policy, Slack
   * authority, cancellation and input receipts. Settings are not part of it:
   * a finished run is delivered under the settings it was accepted with. */
  async function recipient(r: IdentityRow) {
    const cfg = await authorize(r, 'task.read');
    await stopped(r);
    await checkInputs(r, AbortSignal.timeout(90000));
    return cfg;
  }
  /** Whether the channel's current settings still give the run's accepted
   * execution policy. An unresolvable current definition (for example a
   * removed model) counts as changed. */
  async function policyCurrent(r: IdentityRow, cfg: CoordinatorConfig) {
    try {
      return (await definition(r.accepted, cfg)).hash === r.execution_policy_hash;
    } catch (error) {
      if (error instanceof CoordinatorError) return false;
      throw error;
    }
  }
  function inputIdentity(i: IntakeRequest): NativeInputIdentity {
    return {
      installationId: i.installationId,
      teamId: i.teamId,
      channelId: i.channelId,
      rootTs: i.rootTs,
      messageTs: i.messageTs,
      userId: i.userId,
      authorBotId: i.authorBotId ?? null,
    };
  }
  async function checkInputs(r: IdentityRow, signal: AbortSignal) {
    if (!options.inputs) return;
    const receipts = await inputReceipts(r);
    if (!receipts.length) return;
    // Check both the current recipient and each original exposure's requester.
    // Owner is the current task owner; the historical identity is immutable.
    // The input transport checks current Slack identity, membership, sharing
    // and each source before/after transfer. Here retain the distinct local
    // policy checks without repeating those remote reads per file.
    const identities = [
      ...new Map(receipts.map((p) => [JSON.stringify(p.identity), p.identity])).values(),
    ];
    for (const identity of identities)
      await authorize(
        { ...r, accepted: { ...r.accepted, ...identity } },
        'task.start',
        undefined,
        false,
        false,
      );
    await options.inputs.check(inputIdentity(r.accepted), receipts, signal);
    await stopped(r);
    // Historical file sources do not establish the current request's continued
    // existence or current installation synchronization (notably on follow-up).
    await authorize(r, 'task.read');
    for (const identity of identities)
      await authorize(
        { ...r, accepted: { ...r.accepted, ...identity } },
        'task.start',
        undefined,
        false,
        false,
      );
    signal.throwIfAborted();
  }
  return { authorize, definition, recipient, policyCurrent, inputIdentity, checkInputs };
}
