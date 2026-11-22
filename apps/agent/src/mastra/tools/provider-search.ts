import {
  evaluateAuthorization,
  parseAuthorizationPolicy,
} from '../../domain/authorization/policy.js';
import type { IntakeRequest } from '../../contracts/dto.js';
import {
  coordinatorAdminSnapshot,
  coordinatorRunConfiguration,
  type CoordinatorConfig,
} from '../../application/configuration/config.js';

/** Assignment alone cannot grant hosted execution. Omit a denied capability so
 * an otherwise authorized ordinary answer remains available. */
export function providerSearchEnabled(
  config: CoordinatorConfig,
  identity: Pick<IntakeRequest, 'teamId' | 'channelId' | 'userId'>,
) {
  const current = coordinatorRunConfiguration(config, identity.teamId, identity.channelId);
  const model = config.modelPolicy.models.find(
    ({ key }) => key === (current.channel.modelKey ?? config.modelPolicy.defaultKey),
  );
  return (
    model?.webSearch === true &&
    current.tools.some((t) => t.kind === 'webSearch' && t.ready) &&
    evaluateAuthorization(parseAuthorizationPolicy(coordinatorAdminSnapshot(config).policySource), {
      workspace: identity.teamId,
      channel: identity.channelId,
      user: identity.userId,
      action: 'tool.use',
      resourceType: 'tool',
      resourceId: 'webSearch',
    }).allowed
  );
}

/** Counts-only evidence from actual framework call/result pairs. Text answers,
 * advertised tools and provider error results never prove a completed search. */
export function providerSearchReceipts(
  steps: Array<{
    toolCalls: Array<{
      payload: { toolName: string; toolCallId: string; providerExecuted?: boolean };
    }>;
    toolResults: Array<{
      payload: { toolName: string; toolCallId: string; result: unknown; isError?: boolean };
    }>;
  }>,
) {
  const receipts = new Map<string, { toolCallId: string; results: number }>();
  for (const step of steps) {
    for (const { payload: call } of step.toolCalls) {
      if (call.toolName !== 'web_search' || call.providerExecuted !== true) continue;
      const result = step.toolResults.find(
        ({ payload: p }) => p.toolName === call.toolName && p.toolCallId === call.toolCallId,
      )?.payload;
      if (!result || result.isError) continue;
      const output = result.result;
      if (
        Array.isArray(output) &&
        output.every(
          (hit: unknown) =>
            hit !== null &&
            typeof hit === 'object' &&
            'type' in hit &&
            hit.type === 'web_search_result',
        )
      ) {
        receipts.set(call.toolCallId, { toolCallId: call.toolCallId, results: output.length });
      } else if (
        output &&
        typeof output === 'object' &&
        'action' in output &&
        output.action &&
        typeof output.action === 'object' &&
        'type' in output.action &&
        output.action.type === 'search'
      ) {
        const sources = 'sources' in output && Array.isArray(output.sources) ? output.sources : [];
        receipts.set(call.toolCallId, {
          toolCallId: call.toolCallId,
          results: sources.filter(
            (source) => source && typeof source === 'object' && source.type === 'url',
          ).length,
        });
      }
    }
  }
  return [...receipts.values()];
}
