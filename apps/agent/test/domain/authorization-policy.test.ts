import { describe, expect, it } from 'vitest';
import {
  AuthorizationPolicyError,
  evaluateAuthorization,
  parseAuthorizationPolicy,
} from '../../src/domain/authorization/policy.js';

const policy = (tool = 'atlassian'): string =>
  JSON.stringify({
    version: 2,
    blocked: [],
    policyId: `policy-${tool}`,
    defaults: { decision: 'deny' },
    roles: {
      collaborator: {
        grants: [
          { actions: ['task.start', 'task.steer', 'task.cancel'] },
          { actions: ['tool.use'], resourceType: 'tool', resources: [tool] },
        ],
      },
    },
    bindings: [
      {
        workspace: 'T0WORKSPACE1',
        channels: ['C0ALLOWED1', 'G0PRIVATE1'],
        users: ['U0ALICE1', 'U0BOB1'],
        roles: ['collaborator'],
      },
    ],
  });

describe('authorization policy', () => {
  it('requires both an allowed channel and an allowed user', () => {
    const parsed = parseAuthorizationPolicy(policy());

    expect(
      evaluateAuthorization(parsed, {
        workspace: 'T0WORKSPACE1',
        channel: 'C0ALLOWED1',
        user: 'U0ALICE1',
        action: 'task.start',
      }).allowed,
    ).toBe(true);
    expect(
      evaluateAuthorization(parsed, {
        workspace: 'T0WORKSPACE1',
        channel: 'C0DENIED01',
        user: 'U0ALICE1',
        action: 'task.start',
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAuthorization(parsed, {
        workspace: 'T0WORKSPACE1',
        channel: 'C0ALLOWED1',
        user: 'U0MALLORY1',
        action: 'task.start',
      }).allowed,
    ).toBe(false);
  });

  it('rejects the removed task.approveInternet action (web tools need no thread approval)', () => {
    const withInternet = JSON.parse(policy()) as {
      roles: Record<string, { grants: Array<{ actions: string[] }> }>;
    };
    withInternet.roles.web = { grants: [{ actions: ['task.approveInternet'] }] };
    expect(() => parseAuthorizationPolicy(JSON.stringify(withInternet))).toThrow(
      AuthorizationPolicyError,
    );
  });

  it('rejects the removed task.approveGitlabWrites action (GitLab writes need no approval)', () => {
    const withApproval = JSON.parse(policy()) as {
      roles: Record<string, { grants: Array<{ actions: string[] }> }>;
    };
    withApproval.roles.approver = { grants: [{ actions: ['task.approveGitlabWrites'] }] };
    expect(() => parseAuthorizationPolicy(JSON.stringify(withApproval))).toThrow(
      AuthorizationPolicyError,
    );
  });

  it('lets environments grant different tools without code changes', () => {
    const e2e = parseAuthorizationPolicy(policy('webFetch'));
    const production = parseAuthorizationPolicy(policy('atlassian'));
    const request = {
      workspace: 'T0WORKSPACE1',
      channel: 'C0ALLOWED1',
      user: 'U0ALICE1',
      action: 'tool.use' as const,
      resourceType: 'tool' as const,
    };

    expect(evaluateAuthorization(e2e, { ...request, resourceId: 'webFetch' }).allowed).toBe(true);
    expect(evaluateAuthorization(e2e, { ...request, resourceId: 'atlassian' }).allowed).toBe(false);
    expect(evaluateAuthorization(production, { ...request, resourceId: 'atlassian' }).allowed).toBe(
      true,
    );
  });

  it('rejects the removed repository actions and resource type', () => {
    for (const action of ['repository.read', 'workspace.edit', 'gitlab.publish']) {
      expect(() =>
        parseAuthorizationPolicy(
          JSON.stringify({
            version: 2,
            blocked: [],
            policyId: 'removed',
            defaults: { decision: 'deny' },
            roles: {
              old: {
                grants: [{ actions: [action], resourceType: 'repository', resources: ['*'] }],
              },
            },
            bindings: [],
          }),
        ),
      ).toThrow(AuthorizationPolicyError);
    }
    expect(() =>
      parseAuthorizationPolicy(
        JSON.stringify({
          version: 2,
          blocked: [],
          policyId: 'removed-type',
          defaults: { decision: 'deny' },
          roles: {
            old: {
              grants: [{ actions: ['tool.use'], resourceType: 'repository', resources: ['*'] }],
            },
          },
          bindings: [],
        }),
      ),
    ).toThrow(AuthorizationPolicyError);
  });

  it('rejects unknown fields, allow-by-default policies, and mismatched resource grants', () => {
    expect(() =>
      parseAuthorizationPolicy(
        JSON.stringify({
          version: 2,
          blocked: [],
          policyId: 'unsafe',
          defaults: { decision: 'allow' },
          roles: {},
          bindings: [],
        }),
      ),
    ).toThrow(AuthorizationPolicyError);

    expect(() =>
      parseAuthorizationPolicy(
        JSON.stringify({
          version: 2,
          blocked: [],
          policyId: 'bad-resource',
          defaults: { decision: 'deny' },
          roles: {
            bad: {
              grants: [
                {
                  actions: ['skill.use'],
                  resourceType: 'tool',
                  resources: ['gitlab'],
                },
              ],
            },
          },
          bindings: [],
        }),
      ),
    ).toThrow(/resourceType/);

    const raw = JSON.parse(policy()) as Record<string, unknown>;
    raw.unexpected = true;
    expect(() => parseAuthorizationPolicy(JSON.stringify(raw))).toThrow(/unknown field/);
  });
});

it('exact blocks defeat wildcard and overlapping grants for every action and resource', () => {
  const source = JSON.parse(policy());
  source.bindings.push({ workspace: '*', channels: ['*'], users: ['*'], roles: ['collaborator'] });
  source.blocked = [{ workspace: 'T0WORKSPACE1', channel: 'C0ALLOWED1', user: 'W0EXTERNAL' }];
  const parsed = parseAuthorizationPolicy(JSON.stringify(source));
  for (const action of ['task.start', 'task.steer', 'task.cancel', 'tool.use'] as const) {
    const request = {
      workspace: 'T0WORKSPACE1',
      channel: 'C0ALLOWED1',
      user: 'W0EXTERNAL',
      action,
      ...(action === 'tool.use' ? { resourceType: 'tool' as const, resourceId: 'atlassian' } : {}),
    };
    expect(evaluateAuthorization(parsed, request)).toMatchObject({
      allowed: false,
      reason: 'blocked',
    });
    expect(evaluateAuthorization(parsed, { ...request, channel: 'C0OTHER' }).allowed).toBe(true);
    expect(evaluateAuthorization(parsed, { ...request, workspace: 'T0OTHER' }).allowed).toBe(true);
    expect(evaluateAuthorization(parsed, { ...request, user: 'U0NEW' }).allowed).toBe(true);
  }
});

it('rejects old schemas, missing/oversize blocks and non-exact denial scopes', () => {
  const source = JSON.parse(policy());
  for (const change of [
    { version: 1 },
    { blocked: undefined },
    { blocked: [{ workspace: '*', channel: 'C1', user: 'U1' }] },
    {
      blocked: Array.from({ length: 1025 }, (_, i) => ({
        workspace: 'T1',
        channel: 'C1',
        user: `U${i}`,
      })),
    },
  ]) {
    expect(() => parseAuthorizationPolicy(JSON.stringify({ ...source, ...change }))).toThrow();
  }
});
