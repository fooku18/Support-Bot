import { describe, expect, it } from 'vitest';
// The compiled policy must satisfy the agent's unchanged evaluator (D9).
import {
  evaluateAuthorization,
  parseAuthorizationPolicy,
  type AuthorizationAction,
} from '../../agent/src/domain/authorization/policy.js';
import {
  CompileError,
  compileDocument,
  DENY_ALL_BINDING,
  contentHash,
  type ChannelToolRow,
  type BlockedMemberRow,
  type ToolInstanceRow,
  type ToolStatusRow,
} from '../src/compile.js';
import {
  ATLASSIAN_READ_OPERATIONS,
  DEFAULT_RUN_LIMITS,
  TOOL_KINDS,
  validateRunLimits,
} from '../src/generated/tool-kinds.js';

const installation = {
  teamId: 'T0TEAM1',
  teamName: 'Team',
  botUserId: 'U0BOT1',
  botId: 'B0BOT1',
  status: 'whitelisted' as const,
  trustedBotSender: null,
};

function policyOf(document: ReturnType<typeof compileDocument>) {
  return parseAuthorizationPolicy(JSON.stringify(document.authorizationPolicy));
}

function allowed(
  document: ReturnType<typeof compileDocument>,
  user: string,
  action: AuthorizationAction,
  channel = 'C0CHAN1',
  workspace = 'T0TEAM1',
  resource?: { resourceType: 'tool' | 'skill' | 'mcp'; resourceId: string },
): boolean {
  return evaluateAuthorization(policyOf(document), {
    workspace,
    channel,
    user,
    action,
    ...resource,
  }).allowed;
}

describe('compileDocument', () => {
  it('denies everything when nothing is configured, with a policy the agent accepts', () => {
    const document = compileDocument(1, { installations: [], channels: [], blockedMembers: [] });
    expect(document.installations).toEqual([]);
    expect(policyOf(document).policyId).toBe('admin-v1');
    // The contract needs one binding; it names IDs Slack never issues.
    expect(policyOf(document).bindings).toEqual([DENY_ALL_BINDING]);
    expect(allowed(document, 'U0ANY', 'task.start')).toBe(false);
  });

  it('grants the people of a channel only in whitelisted workspaces and enabled channels', () => {
    const blockedMembers: BlockedMemberRow[] = [
      { teamId: 'T0TEAM1', channelId: 'C0CHAN1', userId: 'U0ALICE' },
      { teamId: 'T0TEAM1', channelId: 'C0CHAN1', userId: 'U0BOB' },
      { teamId: 'T0TEAM1', channelId: 'C0OFF', userId: 'U0ALICE' },
      { teamId: 'T0PENDING', channelId: 'C0CHAN2', userId: 'U0ALICE' },
    ];
    const document = compileDocument(7, {
      installations: [installation, { ...installation, teamId: 'T0PENDING', status: 'pending' }],
      channels: [
        { teamId: 'T0TEAM1', channelId: 'C0CHAN1', enabled: true },
        { teamId: 'T0TEAM1', channelId: 'C0OFF', enabled: false },
        { teamId: 'T0PENDING', channelId: 'C0CHAN2', enabled: true },
      ],
      blockedMembers,
    });
    expect(document.installations.map((row) => row.teamId)).toEqual(['T0TEAM1']);
    // One base role, no approval action anywhere.
    expect(Object.keys(policyOf(document).roles)).toEqual(['user']);
    expect(JSON.stringify(document.authorizationPolicy)).not.toContain('approve');
    expect(policyOf(document).bindings).toEqual([
      { workspace: 'T0TEAM1', channels: ['C0CHAN1'], users: ['*'], roles: ['user'] },
    ]);
    for (const action of ['task.start', 'task.read', 'task.steer', 'task.cancel'] as const) {
      expect(allowed(document, 'U0ALICE', action)).toBe(false);
      expect(allowed(document, 'U0BOB', action)).toBe(false);
    }
    // Skills for every whitelisted user; tools only when assigned to the channel.
    expect(
      allowed(document, 'U0ALICE', 'tool.use', undefined, undefined, {
        resourceType: 'tool',
        resourceId: 'atlassian',
      }),
    ).toBe(false);
    expect(
      allowed(document, 'U0ALICE', 'skill.use', undefined, undefined, {
        resourceType: 'skill',
        resourceId: 'mr-workflow',
      }),
    ).toBe(false);
    // Disabled channel, pending workspace, unknown user.
    expect(allowed(document, 'U0ALICE', 'task.start', 'C0OFF')).toBe(false);
    expect(allowed(document, 'U0ALICE', 'task.start', 'C0CHAN2', 'T0PENDING')).toBe(false);
    expect(allowed(document, 'U0OTHER', 'task.start')).toBe(true);
  });

  it('grants enabled channels with an empty blocklist', () => {
    const document = compileDocument(9, {
      installations: [installation],
      channels: [
        { teamId: 'T0TEAM1', channelId: 'C0EMPTY', enabled: true },
        { teamId: 'T0TEAM1', channelId: 'C0OFF', enabled: false },
      ],
      blockedMembers: [],
    });
    expect(policyOf(document).bindings).toEqual([
      { workspace: 'T0TEAM1', channels: ['C0EMPTY'], users: ['*'], roles: ['user'] },
    ]);
    expect(allowed(document, 'U0SOMEONE', 'task.start', 'C0EMPTY')).toBe(true);
  });

  it('never carries bot tokens and publishes the trusted bot sender of whitelisted teams', () => {
    const sender = { botId: 'B0SENDER', userId: 'U0SENDER', channelId: 'C0CHAN1' };
    const document = compileDocument(2, {
      installations: [{ ...installation, trustedBotSender: sender }],
      channels: [],
      blockedMembers: [],
    });
    expect(document.installations[0]?.trustedBotSender).toEqual(sender);
    expect(JSON.stringify(document)).not.toContain('xoxb-');
  });

  it('keeps one wildcard grant with a bounded exact blocklist', () => {
    const blockedMembers: BlockedMemberRow[] = Array.from({ length: 600 }, (_, index) => ({
      teamId: 'T0TEAM1',
      channelId: 'C0CHAN1',
      userId: `U${String(index).padStart(6, '0')}`,
    }));
    const document = compileDocument(3, {
      installations: [installation],
      channels: [{ teamId: 'T0TEAM1', channelId: 'C0CHAN1', enabled: true }],
      blockedMembers,
    });
    expect(policyOf(document).bindings).toHaveLength(1);
    expect(allowed(document, 'U000599', 'task.start')).toBe(false);
  });

  it('refuses a malformed blocked user ID', () => {
    expect(() =>
      compileDocument(5, {
        installations: [installation],
        channels: [{ teamId: 'T0TEAM1', channelId: 'C0CHAN1', enabled: true }],
        blockedMembers: [{ teamId: 'T0TEAM1', channelId: 'C0CHAN1', userId: 'X0INVALID' }],
      }),
    ).toThrow(/the agent would refuse/);
  });

  it('refuses a configuration the agent could not load', () => {
    const channels = Array.from({ length: 257 }, (_, index) => ({
      teamId: 'T0TEAM1',
      channelId: `C${String(index).padStart(6, '0')}`,
      enabled: true,
    }));
    expect(() =>
      compileDocument(4, {
        installations: [installation],
        channels,
        blockedMembers: channels.map((row) => ({
          teamId: row.teamId,
          channelId: row.channelId,
          userId: 'U0ALICE',
        })),
      }),
    ).toThrow(CompileError);
  });

  it('keeps the content hash stable across versions of the same configuration', () => {
    const rows = { installations: [installation], channels: [], blockedMembers: [] };
    const first = compileDocument(1, rows);
    const second = compileDocument(2, rows);
    expect(first.hash).not.toBe(second.hash);
    expect(contentHash(first)).toBe(contentHash(second));
  });
});

describe('compileDocument tool assignments', () => {
  const instance = (
    id: string,
    kind: ToolInstanceRow['kind'],
    extra: Partial<ToolInstanceRow> = {},
  ): ToolInstanceRow => ({
    id,
    teamId: 'T0TEAM1',
    kind,
    label: `${kind} instance`,
    host: null,
    settings: {},
    hasCredential: false,
    credentialVersion: 0,
    status: 'enabled',
    ...extra,
  });
  const gitlab = instance('ti_000000000000000a', 'gitlab', {
    host: 'gitlab.example.com',
    hasCredential: true,
    credentialVersion: 2,
  });
  const atlassian = instance('ti_000000000000000b', 'atlassian', {
    host: 'example.atlassian.net',
    settings: {
      cloudId: '11111111-2222-3333-4444-555555555555',
      email: 'owner@example.com',
      operations: ['getJiraIssue', 'searchJiraIssues'],
    },
    hasCredential: true,
    credentialVersion: 1,
  });
  const datadog = instance('ti_000000000000000c', 'datadog', {
    host: 'datadoghq.eu',
    settings: { toolsets: 'logs,metrics', denyTools: ['search_datadog_rum'] },
    hasCredential: true,
    credentialVersion: 1,
  });
  // Credential-free: searches run through the AI Gateway.
  const search = instance('ti_000000000000000d', 'webSearch');
  // Stored rows of the retired search-provider shape (plan D9).
  const legacySearch = instance('ti_0000000000000010', 'webSearch', {
    host: 'search.example.com',
    settings: { endpoint: 'https://search.example.com/v1/search' },
    hasCredential: true,
    credentialVersion: 1,
  });
  const files = instance('ti_000000000000000e', 'files', { settings: { readOnly: true } });
  const assign = (channelId: string, row: ToolInstanceRow): ChannelToolRow => ({
    teamId: 'T0TEAM1',
    channelId,
    kind: row.kind,
    instanceId: row.id,
  });
  const ready = (
    row: ToolInstanceRow,
    credentialVersion = row.credentialVersion,
  ): ToolStatusRow => ({
    instanceId: row.id,
    state: 'ready',
    detail: '',
    toolsCount: null,
    credentialVersion,
    reporter: 'cli-runtime',
    reportedAt: 1,
  });
  const base = {
    installations: [installation],
    channels: [
      { teamId: 'T0TEAM1', channelId: 'C0CHAN1', enabled: true },
      { teamId: 'T0TEAM1', channelId: 'C0CHAN2', enabled: true },
      { teamId: 'T0TEAM1', channelId: 'C0OFF', enabled: false },
    ],
    blockedMembers: [],
    toolInstances: [gitlab, atlassian, datadog, search, files],
  };
  const tool = (resourceId: string) => ({ resourceType: 'tool' as const, resourceId });
  const mcp = (resourceId: string) => ({ resourceType: 'mcp' as const, resourceId });

  it('names roles per distinct kind set and grants exactly the assigned kinds', () => {
    const document = compileDocument(10, {
      ...base,
      channelTools: [
        assign('C0CHAN1', files),
        assign('C0CHAN1', gitlab),
        assign('C0CHAN1', atlassian),
        assign('C0OFF', datadog),
      ],
    });
    const policy = policyOf(document);
    expect(Object.keys(policy.roles).sort()).toEqual(['user', 'user-gl-at-fs']);
    expect(policy.bindings).toEqual([
      {
        workspace: 'T0TEAM1',
        channels: ['C0CHAN1'],
        users: ['*'],
        roles: ['user-gl-at-fs'],
      },
      { workspace: 'T0TEAM1', channels: ['C0CHAN2'], users: ['*'], roles: ['user'] },
    ]);
    // Every person on the list has the same grants: task actions, skills and the channel's tools.
    expect(document.authorizationPolicy.roles).toMatchObject({
      'user-gl-at-fs': {
        grants: [
          { actions: ['task.start', 'task.read', 'task.steer', 'task.cancel'] },
          { actions: ['skill.use'], resourceType: 'skill', resources: ['*'] },
          {
            actions: ['tool.use'],
            resourceType: 'tool',
            resources: ['gitlab', 'atlassian', 'files'],
          },
          { actions: ['mcp.use'], resourceType: 'mcp', resources: ['atlassian'] },
        ],
      },
    });
    for (const kind of ['gitlab', 'atlassian', 'files'])
      expect(allowed(document, 'U0ALICE', 'tool.use', 'C0CHAN1', undefined, tool(kind))).toBe(true);
    expect(allowed(document, 'U0ALICE', 'tool.use', 'C0CHAN1', undefined, tool('datadog'))).toBe(
      false,
    );
    expect(allowed(document, 'U0ALICE', 'mcp.use', 'C0CHAN1', undefined, mcp('atlassian'))).toBe(
      true,
    );
    expect(allowed(document, 'U0ALICE', 'mcp.use', 'C0CHAN1', undefined, mcp('gitlab'))).toBe(
      false,
    );
    for (const kind of ['gitlab', 'atlassian', 'files'])
      expect(allowed(document, 'U0BOB', 'tool.use', 'C0CHAN1', undefined, tool(kind))).toBe(true);
    // A channel without assignments: task actions and skills, no tool.
    expect(allowed(document, 'U0ALICE', 'task.start', 'C0CHAN2')).toBe(true);
    expect(allowed(document, 'U0ALICE', 'tool.use', 'C0CHAN2', undefined, tool('gitlab'))).toBe(
      false,
    );
    expect(
      allowed(document, 'U0ALICE', 'skill.use', 'C0CHAN2', undefined, {
        resourceType: 'skill',
        resourceId: 'mr-workflow',
      }),
    ).toBe(true);
    // Assignments cover every enabled channel of whitelisted workspaces, disabled channels none.
    expect(document.toolAssignments.map((row) => row.channelId)).toEqual(['C0CHAN1', 'C0CHAN2']);
    expect(document.toolAssignments[0]?.tools.map((row) => row.kind)).toEqual([
      'gitlab',
      'atlassian',
      'files',
    ]);
    expect(document.toolAssignments[1]).toEqual({
      teamId: 'T0TEAM1',
      channelId: 'C0CHAN2',
      modelKey: null,
      systemPrompt: null,
      autoReplies: true,
      tools: [],
    });
  });

  it('shares roles between channels with the same kind set and binds channels without people to their role', () => {
    const document = compileDocument(11, {
      ...base,
      channels: [...base.channels, { teamId: 'T0TEAM1', channelId: 'C0EMPTY', enabled: true }],
      channelTools: [assign('C0CHAN2', datadog), assign('C0EMPTY', datadog)],
    });
    const policy = policyOf(document);
    expect(Object.keys(policy.roles).sort()).toEqual(['user', 'user-dd']);
    expect(policy.bindings.find((row) => row.channels[0] === 'C0EMPTY')).toEqual({
      workspace: 'T0TEAM1',
      channels: ['C0EMPTY'],
      users: ['*'],
      roles: ['user-dd'],
    });
  });

  it('refuses more than 64 roles with a clear reason', () => {
    const kinds = TOOL_KINDS;
    const settings: Partial<Record<(typeof TOOL_KINDS)[number], ToolInstanceRow['settings']>> = {
      atlassian: atlassian.settings,
      datadog: datadog.settings,
      cloudflare: { accountId: null, zones: null },
      webSearch: search.settings,
      files: files.settings,
    };
    const instances = kinds.map((kind, index) =>
      instance(`ti_${String(index).padStart(16, '0')}`, kind, { settings: settings[kind] ?? {} }),
    );
    // 64 channels with distinct non-empty kind sets, each with one person.
    const channels = Array.from(
      { length: 64 },
      (_, index) => `C${String(index + 1).padStart(6, '0')}`,
    );
    const rows = (count: number) => ({
      installations: [installation],
      channels: channels
        .slice(0, count)
        .map((channelId) => ({ teamId: 'T0TEAM1', channelId, enabled: true })),
      blockedMembers: channels
        .slice(0, count)
        .map((channelId) => ({ teamId: 'T0TEAM1', channelId, userId: 'U0ALICE' })),
      toolInstances: instances,
      channelTools: channels
        .slice(0, count)
        .flatMap((channelId, index) =>
          instances
            .filter((_, bit) => ((index + 1) >> bit) & 1)
            .map((row) => assign(channelId, row)),
        ),
    });
    // `user` plus 63 tool sets: 64 distinct sets (including the empty one) fit.
    expect(Object.keys(policyOf(compileDocument(12, rows(63))).roles)).toHaveLength(64);
    expect(() => compileDocument(13, rows(64))).toThrow(
      /65 policy roles \(one policy role per distinct set of assigned tool kinds\).*at most 64/,
    );
  });

  it('omits disabled and foreign instances and keeps the policy independent of readiness', () => {
    const foreign = { ...files, id: 'ti_00000000000000ff', teamId: 'T0OTHER' };
    const rows = {
      ...base,
      toolInstances: [{ ...gitlab, status: 'disabled' as const }, datadog, foreign],
      channelTools: [
        assign('C0CHAN1', gitlab),
        assign('C0CHAN1', datadog),
        { ...assign('C0CHAN1', foreign) },
      ],
    };
    const waiting = compileDocument(14, rows);
    expect(waiting.toolAssignments[0]?.tools.map((row) => row.kind)).toEqual(['datadog']);
    expect(Object.keys(policyOf(waiting).roles)).toContain('user-dd');
    const readyNow = compileDocument(15, { ...rows, toolStatuses: [ready(datadog)] });
    expect(readyNow.toolAssignments[0]?.tools[0]?.ready).toBe(true);
    // Readiness changes the content (the agent refetches) but not the policy.
    expect(contentHash(readyNow)).not.toBe(contentHash(waiting));
    expect({ ...readyNow.authorizationPolicy, policyId: '' }).toEqual({
      ...waiting.authorizationPolicy,
      policyId: '',
    });
  });

  it('computes readiness from credential and the report for the current credential version', () => {
    const noCredential = { ...gitlab, hasCredential: false };
    const document = compileDocument(16, {
      ...base,
      toolInstances: [noCredential, atlassian, datadog, search, files],
      toolStatuses: [
        ready(noCredential),
        ready(atlassian, 0), // stale: probed an older credential
        {
          ...ready(datadog),
          state: 'error',
          detail: 'token rejected (403)',
        },
      ],
      channelTools: [
        assign('C0CHAN1', noCredential),
        assign('C0CHAN1', atlassian),
        assign('C0CHAN1', datadog),
        assign('C0CHAN1', search),
        assign('C0CHAN1', files),
      ],
    });
    const tools = document.toolAssignments[0]?.tools ?? [];
    expect(tools.map((row) => [row.kind, row.ready, row.detail])).toEqual([
      ['gitlab', false, 'no credential'],
      ['atlassian', false, 'waiting for runtime readiness'],
      ['datadog', false, 'token rejected (403)'],
      ['webSearch', true, null],
      ['files', true, null],
    ]);
  });

  it('never advertises a web search row of the retired provider shape as ready', () => {
    const credentialOnly = { ...legacySearch, id: 'ti_0000000000000011', settings: {} };
    const settingsOnly = {
      ...legacySearch,
      id: 'ti_0000000000000012',
      hasCredential: false,
      credentialVersion: 0,
    };
    const rows = [legacySearch, credentialOnly, settingsOnly];
    const document = compileDocument(18, {
      ...base,
      toolInstances: rows,
      // Even a stale ready report from the old web runtime does not count.
      toolStatuses: rows.map((row) => ready(row)),
      channelTools: rows.map((row) => assign('C0CHAN1', row)),
    });
    expect(
      (document.toolAssignments[0]?.tools ?? []).map((row) => [
        row.instanceId,
        row.ready,
        row.detail,
      ]),
    ).toEqual(
      rows.map((row) => [row.id, false, 'legacy search-provider instance: delete and recreate it']),
    );
  });

  it('publishes only non-secret settings the runner needs', () => {
    const document = compileDocument(17, {
      ...base,
      toolInstances: [
        gitlab,
        { ...atlassian, settings: { ...atlassian.settings, operations: null } },
        datadog,
        search,
        files,
      ],
      toolStatuses: [ready(gitlab)],
      channelTools: [gitlab, atlassian, datadog, search, files].map((row) =>
        assign('C0CHAN1', row),
      ),
      runLimits: { ...DEFAULT_RUN_LIMITS, maxToolCalls: 7 },
    });
    // One deployment-wide set, not per channel.
    expect(document.runLimits.maxToolCalls).toBe(7);
    const assignment = document.toolAssignments[0];
    expect(assignment).not.toHaveProperty('limits');
    expect(assignment?.tools).toEqual([
      {
        kind: 'gitlab',
        instanceId: gitlab.id,
        label: gitlab.label,
        credentialVersion: 2,
        ready: true,
        detail: null,
        host: 'gitlab.example.com',
      },
      {
        kind: 'atlassian',
        instanceId: atlassian.id,
        label: atlassian.label,
        credentialVersion: 1,
        ready: false,
        detail: 'waiting for runtime readiness',
        operations: [...ATLASSIAN_READ_OPERATIONS].sort(),
      },
      {
        kind: 'datadog',
        instanceId: datadog.id,
        label: datadog.label,
        credentialVersion: 1,
        ready: false,
        detail: 'waiting for runtime readiness',
        denyTools: ['search_datadog_rum'],
      },
      {
        kind: 'webSearch',
        instanceId: search.id,
        label: search.label,
        credentialVersion: 0,
        ready: true,
        detail: null,
      },
      {
        kind: 'files',
        instanceId: files.id,
        label: files.label,
        credentialVersion: 0,
        ready: true,
        detail: null,
        readOnly: true,
      },
    ]);
    const text = JSON.stringify(document);
    for (const secretish of [
      '11111111-2222-3333-4444-555555555555',
      'owner@example.com',
      'https://search.example.com',
      'logs,metrics',
      'example.atlassian.net',
    ])
      expect(text).not.toContain(secretish);
  });

  it('publishes the Cloudflare account and zones and grants mcp.use for the kind', () => {
    const cloudflare = instance('ti_000000000000000f', 'cloudflare', {
      host: 'api.cloudflare.com',
      settings: { accountId: 'c'.repeat(32), zones: ['cloud.example.com'] },
      hasCredential: true,
      credentialVersion: 3,
    });
    const document = compileDocument(19, {
      ...base,
      toolInstances: [cloudflare],
      toolStatuses: [ready(cloudflare)],
      channelTools: [assign('C0CHAN1', cloudflare)],
    });
    expect(document.toolAssignments[0]?.tools).toEqual([
      {
        kind: 'cloudflare',
        instanceId: cloudflare.id,
        label: cloudflare.label,
        credentialVersion: 3,
        ready: true,
        detail: null,
        accountId: 'c'.repeat(32),
        zones: ['cloud.example.com'],
      },
    ]);
    const mcp = { resourceType: 'mcp' as const, resourceId: 'cloudflare' };
    expect(allowed(document, 'U0ALICE', 'mcp.use', 'C0CHAN1', undefined, mcp)).toBe(true);
    expect(allowed(document, 'U0ALICE', 'mcp.use', 'C0CHAN2', undefined, mcp)).toBe(false);
  });

  it('compiles the effective model key: channel, else workspace default, else null', () => {
    const channels = [...base.channels, { teamId: 'T0TEAM1', channelId: 'C0CHAN3', enabled: true }];
    const keys = (modelAssignments: Parameters<typeof compileDocument>[1]['modelAssignments']) =>
      compileDocument(18, { ...base, channels, modelAssignments }).toolAssignments.map((row) => [
        row.channelId,
        row.modelKey,
      ]);
    expect(keys([])).toEqual([
      ['C0CHAN1', null],
      ['C0CHAN2', null],
      ['C0CHAN3', null],
    ]);
    const assignments = [
      { teamId: 'T0TEAM1', channelId: null, modelKey: 'sonnet' },
      { teamId: 'T0TEAM1', channelId: 'C0CHAN2', modelKey: 'opus' },
      // A key the operator removed from CLAUDE_MODELS still compiles (D3).
      { teamId: 'T0TEAM1', channelId: 'C0CHAN3', modelKey: 'retired' },
      // Disabled channels and other workspaces are not in the section.
      { teamId: 'T0TEAM1', channelId: 'C0OFF', modelKey: 'opus' },
      { teamId: 'T0OTHER', channelId: null, modelKey: 'opus' },
    ];
    expect(keys(assignments)).toEqual([
      ['C0CHAN1', 'sonnet'],
      ['C0CHAN2', 'opus'],
      ['C0CHAN3', 'retired'],
    ]);
    // The model is content: changing it changes the hash; the policy is untouched.
    const before = compileDocument(19, { ...base, channels });
    const after = compileDocument(19, { ...base, channels, modelAssignments: assignments });
    expect(contentHash(after)).not.toBe(contentHash(before));
    expect(after.authorizationPolicy).toEqual(before.authorizationPolicy);
  });

  it('compiles the effective system prompt: channel replaces workspace, else null', () => {
    const channels = [...base.channels, { teamId: 'T0TEAM1', channelId: 'C0CHAN3', enabled: true }];
    const prompts = (
      promptAssignments: Parameters<typeof compileDocument>[1]['promptAssignments'],
    ) =>
      compileDocument(20, { ...base, channels, promptAssignments }).toolAssignments.map((row) => [
        row.channelId,
        row.systemPrompt,
      ]);
    expect(prompts([])).toEqual([
      ['C0CHAN1', null],
      ['C0CHAN2', null],
      ['C0CHAN3', null],
    ]);
    const assignments = [
      { teamId: 'T0TEAM1', channelId: null, text: 'Answer in German.' },
      { teamId: 'T0TEAM1', channelId: 'C0CHAN2', text: 'Answer in French.' },
      // Disabled channels and other workspaces are not in the section.
      { teamId: 'T0TEAM1', channelId: 'C0OFF', text: 'Off.' },
      { teamId: 'T0OTHER', channelId: null, text: 'Other.' },
    ];
    expect(prompts(assignments)).toEqual([
      ['C0CHAN1', 'Answer in German.'],
      ['C0CHAN2', 'Answer in French.'],
      ['C0CHAN3', 'Answer in German.'],
    ]);
    const before = compileDocument(21, { ...base, channels });
    const after = compileDocument(21, { ...base, channels, promptAssignments: assignments });
    expect(contentHash(after)).not.toBe(contentHash(before));
    expect(after.authorizationPolicy).toEqual(before.authorizationPolicy);
  });
});

describe('run limits', () => {
  it('compiles the defaults until an admin saves limits', () => {
    const document = compileDocument(1, { installations: [], channels: [], blockedMembers: [] });
    expect(document.runLimits).toEqual({
      maxToolCalls: 300,
      maxCostUsd: 10,
      maxActiveMinutes: 30,
      pauseWaitMinutes: 30,
      toolTimeoutMs: 60_000,
      maxOutputBytes: 200_000,
    });
  });

  it('changes the content hash when a limit changes', () => {
    const rows = { installations: [], channels: [], blockedMembers: [] };
    const before = contentHash(compileDocument(1, rows));
    const after = contentHash(
      compileDocument(1, { ...rows, runLimits: { ...DEFAULT_RUN_LIMITS, maxCostUsd: 20 } }),
    );
    expect(after).not.toBe(before);
  });

  it('validates bounds, cents and unknown fields', () => {
    expect(validateRunLimits({ maxToolCalls: '12', maxCostUsd: '2.5' })).toMatchObject({
      maxToolCalls: 12,
      maxCostUsd: 2.5,
      maxActiveMinutes: 30,
    });
    expect(validateRunLimits({ maxCostUsd: 0.29 }).maxCostUsd).toBe(0.29);
    expect(() => validateRunLimits({ maxToolCalls: 0 })).toThrow(/maxToolCalls/);
    expect(() => validateRunLimits({ maxToolCalls: 1.5 })).toThrow(/integer/);
    expect(() => validateRunLimits({ maxCostUsd: 1.234 })).toThrow(/two decimals/);
    expect(() => validateRunLimits({ pauseWaitMinutes: 121 })).toThrow(/pauseWaitMinutes/);
    expect(() => validateRunLimits({ runDeadlineMs: 1 })).toThrow();
  });
});
