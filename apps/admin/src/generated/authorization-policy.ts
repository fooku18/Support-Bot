/**
 * GENERATED verbatim from apps/agent/src/domain/authorization/policy.ts — do not
 * hand-edit. Regenerate with:
 *
 *   npm run generate:protocol
 */

/**
 * Deterministic, fail-closed authorization policy for Slack actors.
 *
 * Policies are deployment configuration. They bind immutable Slack workspace,
 * channel, and user IDs to roles. Roles grant exact actions and, for the
 * optional tools, skills, and MCP providers, exact operator-owned resource
 * IDs. GitLab is not a policy resource: the GitLab token is its permission
 * boundary. Conversation text, model output, skills, and tool output never
 * participate in decisions.
 */

export const AUTHORIZATION_POLICY_VERSION = 2;

export const AUTHORIZATION_ACTIONS = [
  'task.start',
  'task.read',
  'task.steer',
  'task.cancel',
  'tool.use',
  'skill.use',
  'mcp.use',
] as const;

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];
export type AuthorizationResourceType = 'tool' | 'skill' | 'mcp';

export interface AuthorizationGrant {
  actions: AuthorizationAction[];
  resourceType: AuthorizationResourceType | null;
  resources: string[];
}

export interface AuthorizationRole {
  grants: AuthorizationGrant[];
}

export interface AuthorizationBinding {
  workspace: string;
  channels: string[];
  users: string[];
  roles: string[];
}

export interface AuthorizationPolicy {
  version: 2;
  policyId: string;
  defaults: { decision: 'deny' };
  roles: Record<string, AuthorizationRole>;
  bindings: AuthorizationBinding[];
  blocked: Array<{ workspace: string; channel: string; user: string }>;
  /** Exact source JSON used for the attributable policy digest. */
  source: string;
}

export interface AuthorizationRequest {
  workspace: string;
  channel: string;
  user: string;
  action: AuthorizationAction;
  resourceType?: AuthorizationResourceType;
  resourceId?: string;
}

export interface AuthorizationEvaluation {
  allowed: boolean;
  reason: 'granted' | 'no_matching_binding' | 'no_matching_grant' | 'invalid_resource' | 'blocked';
  roles: string[];
}

export class AuthorizationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationPolicyError';
  }
}

const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESOURCE_PATTERN = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/;
const ACTION_SET = new Set<string>(AUTHORIZATION_ACTIONS);

const RESOURCE_BY_ACTION: Partial<Record<AuthorizationAction, AuthorizationResourceType>> = {
  'tool.use': 'tool',
  'skill.use': 'skill',
  'mcp.use': 'mcp',
};

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthorizationPolicyError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function noUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new AuthorizationPolicyError(`unknown field ${where}.${key}`);
    }
  }
}

function stringArray(value: unknown, where: string, pattern: RegExp, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new AuthorizationPolicyError(`${where} must contain 1 to ${max} values`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) {
      throw new AuthorizationPolicyError(`${where} contains an invalid value`);
    }
    if (seen.has(item)) {
      throw new AuthorizationPolicyError(`${where} contains a duplicate value`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function parseAuthorizationPolicy(source: string): AuthorizationPolicy {
  if (source.length === 0 || source.length > 65_536) {
    throw new AuthorizationPolicyError('authorization policy must contain 1 to 65536 bytes');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new AuthorizationPolicyError('authorization policy is not valid JSON');
  }
  const root = record(decoded, 'authorization policy');
  noUnknown(root, ['version', 'policyId', 'defaults', 'roles', 'bindings', 'blocked'], 'policy');
  if (root.version !== AUTHORIZATION_POLICY_VERSION) {
    throw new AuthorizationPolicyError(
      `authorization policy version must be ${AUTHORIZATION_POLICY_VERSION}`,
    );
  }
  if (typeof root.policyId !== 'string' || !POLICY_ID_PATTERN.test(root.policyId)) {
    throw new AuthorizationPolicyError('policyId must be a stable bounded identifier');
  }
  const defaults = record(root.defaults, 'defaults');
  noUnknown(defaults, ['decision'], 'defaults');
  if (defaults.decision !== 'deny') {
    throw new AuthorizationPolicyError('defaults.decision must be deny');
  }

  const rawRoles = record(root.roles, 'roles');
  const roleNames = Object.keys(rawRoles);
  if (roleNames.length === 0 || roleNames.length > 64) {
    throw new AuthorizationPolicyError('roles must contain 1 to 64 roles');
  }
  const roles: Record<string, AuthorizationRole> = {};
  for (const roleName of roleNames) {
    if (!ROLE_PATTERN.test(roleName)) {
      throw new AuthorizationPolicyError(`invalid role name ${roleName.slice(0, 64)}`);
    }
    const rawRole = record(rawRoles[roleName], `roles.${roleName}`);
    noUnknown(rawRole, ['grants'], `roles.${roleName}`);
    if (
      !Array.isArray(rawRole.grants) ||
      rawRole.grants.length === 0 ||
      rawRole.grants.length > 64
    ) {
      throw new AuthorizationPolicyError(`roles.${roleName}.grants must contain 1 to 64 grants`);
    }
    const grants: AuthorizationGrant[] = [];
    for (let index = 0; index < rawRole.grants.length; index += 1) {
      const where = `roles.${roleName}.grants[${index}]`;
      const rawGrant = record(rawRole.grants[index], where);
      noUnknown(rawGrant, ['actions', 'resourceType', 'resources'], where);
      const rawActions = stringArray(rawGrant.actions, `${where}.actions`, /^[a-zA-Z.]+$/, 16);
      const actions = rawActions.map((action) => {
        if (!ACTION_SET.has(action)) {
          throw new AuthorizationPolicyError(`${where}.actions contains unsupported action`);
        }
        return action as AuthorizationAction;
      });
      const expectedTypes = new Set(actions.map((action) => RESOURCE_BY_ACTION[action] ?? null));
      if (expectedTypes.size !== 1) {
        throw new AuthorizationPolicyError(`${where}.actions must use the same resourceType`);
      }
      const expectedType = [...expectedTypes][0] ?? null;
      if (expectedType === null) {
        if (rawGrant.resourceType !== undefined || rawGrant.resources !== undefined) {
          throw new AuthorizationPolicyError(`${where}.resourceType is not valid for task actions`);
        }
        grants.push({ actions, resourceType: null, resources: [] });
        continue;
      }
      if (rawGrant.resourceType !== expectedType) {
        throw new AuthorizationPolicyError(`${where}.resourceType must be ${expectedType}`);
      }
      const resources = stringArray(
        rawGrant.resources,
        `${where}.resources`,
        RESOURCE_PATTERN,
        128,
      );
      grants.push({ actions, resourceType: expectedType, resources });
    }
    roles[roleName] = { grants };
  }

  if (!Array.isArray(root.bindings) || root.bindings.length === 0 || root.bindings.length > 256) {
    throw new AuthorizationPolicyError('bindings must contain 1 to 256 bindings');
  }
  const bindings: AuthorizationBinding[] = [];
  for (let index = 0; index < root.bindings.length; index += 1) {
    const where = `bindings[${index}]`;
    const rawBinding = record(root.bindings[index], where);
    noUnknown(rawBinding, ['workspace', 'channels', 'users', 'roles'], where);
    if (
      typeof rawBinding.workspace !== 'string' ||
      !/^(?:\*|T[A-Z0-9]+)$/.test(rawBinding.workspace)
    ) {
      throw new AuthorizationPolicyError(`${where}.workspace must be a Slack workspace ID`);
    }
    const channels = stringArray(
      rawBinding.channels,
      `${where}.channels`,
      /^(?:\*|[CG][A-Z0-9]+)$/,
      64,
    );
    const users = stringArray(rawBinding.users, `${where}.users`, /^(?:\*|[UW][A-Z0-9]+)$/, 256);
    const bindingRoles = stringArray(rawBinding.roles, `${where}.roles`, ROLE_PATTERN, 32);
    for (const roleName of bindingRoles) {
      if (roles[roleName] === undefined) {
        throw new AuthorizationPolicyError(`${where}.roles references unknown role ${roleName}`);
      }
    }
    bindings.push({ workspace: rawBinding.workspace, channels, users, roles: bindingRoles });
  }

  if (!Array.isArray(root.blocked) || root.blocked.length > 1024) {
    throw new AuthorizationPolicyError('blocked must contain at most 1024 exact identities');
  }
  const seenBlocks = new Set<string>();
  const blocked = root.blocked.map((value, index) => {
    const entry = record(value, `blocked[${index}]`);
    noUnknown(entry, ['workspace', 'channel', 'user'], 'blocked');
    if (
      typeof entry.workspace !== 'string' ||
      !/^T[A-Z0-9]+$/.test(entry.workspace) ||
      typeof entry.channel !== 'string' ||
      !/^[CG][A-Z0-9]+$/.test(entry.channel) ||
      typeof entry.user !== 'string' ||
      !/^[UW][A-Z0-9]+$/.test(entry.user)
    ) {
      throw new AuthorizationPolicyError('blocked requires exact workspace/channel/user IDs');
    }
    const key = `${entry.workspace}/${entry.channel}/${entry.user}`;
    if (seenBlocks.has(key)) throw new AuthorizationPolicyError('duplicate blocked identity');
    seenBlocks.add(key);
    return { workspace: entry.workspace, channel: entry.channel, user: entry.user };
  });

  return {
    version: AUTHORIZATION_POLICY_VERSION,
    policyId: root.policyId,
    defaults: { decision: 'deny' },
    roles,
    bindings,
    blocked,
    source,
  };
}

export function evaluateAuthorization(
  policy: AuthorizationPolicy,
  request: AuthorizationRequest,
): AuthorizationEvaluation {
  if (
    policy.blocked.some(
      (entry) =>
        entry.workspace === request.workspace &&
        entry.channel === request.channel &&
        entry.user === request.user,
    )
  ) {
    return { allowed: false, reason: 'blocked', roles: [] };
  }
  const expectedType = RESOURCE_BY_ACTION[request.action] ?? null;
  if (
    (expectedType === null &&
      (request.resourceType !== undefined || request.resourceId !== undefined)) ||
    (expectedType !== null &&
      (request.resourceType !== expectedType ||
        typeof request.resourceId !== 'string' ||
        !RESOURCE_PATTERN.test(request.resourceId)))
  ) {
    return { allowed: false, reason: 'invalid_resource', roles: [] };
  }
  const matchingBindings = policy.bindings.filter(
    (binding) =>
      (binding.workspace === '*' || binding.workspace === request.workspace) &&
      (binding.channels.includes('*') || binding.channels.includes(request.channel)) &&
      (binding.users.includes('*') || binding.users.includes(request.user)),
  );
  if (matchingBindings.length === 0) {
    return { allowed: false, reason: 'no_matching_binding', roles: [] };
  }
  const roleNames = [...new Set(matchingBindings.flatMap((binding) => binding.roles))].sort();
  for (const roleName of roleNames) {
    for (const grant of policy.roles[roleName]?.grants ?? []) {
      if (!grant.actions.includes(request.action) || grant.resourceType !== expectedType) continue;
      if (
        expectedType === null ||
        grant.resources.includes('*') ||
        grant.resources.includes(request.resourceId as string)
      ) {
        return { allowed: true, reason: 'granted', roles: roleNames };
      }
    }
  }
  return { allowed: false, reason: 'no_matching_grant', roles: roleNames };
}
