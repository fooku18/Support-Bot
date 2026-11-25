import { evaluateAuthorization, parseAuthorizationPolicy } from '../domain/authorization/policy.js';
import type { IntakeRequest } from '../contracts/dto.js';
import type { ToolKind } from '../contracts/tool-kinds.js';
import {
  coordinatorAdminSnapshot,
  coordinatorRunConfiguration,
  type CoordinatorConfig,
} from './configuration/config.js';

/** The channel has a ready assignment and the actor may use it. Assignment
 * alone grants nothing; a denied optional capability is omitted so that an
 * otherwise authorized ordinary answer remains available. */
export function channelToolGranted(
  config: CoordinatorConfig,
  identity: Pick<IntakeRequest, 'teamId' | 'channelId' | 'userId'>,
  kind: ToolKind,
): boolean {
  return (
    coordinatorRunConfiguration(config, identity.teamId, identity.channelId).tools.some(
      (tool) => tool.kind === kind && tool.ready,
    ) &&
    evaluateAuthorization(parseAuthorizationPolicy(coordinatorAdminSnapshot(config).policySource), {
      workspace: identity.teamId,
      channel: identity.channelId,
      user: identity.userId,
      action: 'tool.use',
      resourceType: 'tool',
      resourceId: kind,
    }).allowed
  );
}
