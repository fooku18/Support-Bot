import { createHash } from 'node:crypto';
import http from 'node:http';
import { expect, it } from 'vitest';
import {
  compileDocument,
  type CompileRows,
  type ToolInstanceRow,
} from '../../../admin/src/compile.js';
import { TOOL_KINDS } from '../../src/contracts/tool-kinds.js';
import {
  evaluateAuthorization,
  parseAuthorizationPolicy,
} from '../../src/domain/authorization/policy.js';
import { parseCoordinatorAdminDocument } from '../../src/application/configuration/admin-document.js';
import { createAdminConfigSync } from '../../src/application/configuration/admin-sync.js';

function fixture(version = 7, status: 'whitelisted' | 'disabled' = 'whitelisted') {
  const instances: ToolInstanceRow[] = TOOL_KINDS.map((kind, i): ToolInstanceRow => ({
    id: `ti_${String(i + 1).padStart(16, '0')}`,
    teamId: 'TTEAM',
    kind,
    label: kind,
    host: kind === 'gitlab' ? 'gitlab.example.test' : null,
    settings:
      kind === 'atlassian'
        ? {
            cloudId: '00000000-0000-4000-8000-000000000115',
            email: 'fixture@example.test',
            operations: ['getJiraIssue'],
          }
        : kind === 'datadog'
          ? { denyTools: ['search_datadog_logs'], toolsets: 'logs' }
          : kind === 'cloudflare'
            ? { accountId: 'a'.repeat(32), zones: ['fixture.example.test'] }
            : kind === 'optimizely'
              ? { datafiles: [{ name: 'Shop', sdkKey: 'AbCdEf0123456789' }] }
              : {},
    hasCredential: true,
    credentialVersion: 1,
    status: 'enabled',
  }));
  const rows: CompileRows = {
    installations: [
      {
        teamId: 'TTEAM',
        teamName: 'Synthetic',
        botUserId: 'UBOT',
        botId: 'BBOT',
        status,
        trustedBotSender: { botId: 'BTEST', userId: 'UTEST', channelId: 'CCHAN' },
      },
    ],
    channels: [{ teamId: 'TTEAM', channelId: 'CCHAN', enabled: true }],
    blockedMembers: [],
    toolInstances: instances,
    channelTools: instances.map((t) => ({
      teamId: 'TTEAM',
      channelId: 'CCHAN',
      kind: t.kind,
      instanceId: t.id,
    })),
  };
  return compileDocument(version, rows);
}
function rehash(input: ReturnType<typeof fixture>) {
  const { version, installations, authorizationPolicy, toolAssignments } = input;
  const body = { version, installations, authorizationPolicy, toolAssignments };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

it('accepts complete actual compiler output for every tool kind', () => {
  const source = fixture();
  expect(source.toolAssignments[0]!.tools).toHaveLength(9);
  expect(parseCoordinatorAdminDocument(source).document).toEqual(source);
});

it.each([
  ['gitlab', 'host'],
  ['atlassian', 'operations'],
  ['datadog', 'denyTools'],
  ['cloudflare', 'accountId'],
  ['cloudflare', 'zones'],
  ['optimizely', 'datafiles'],
])('refuses omitted %s.%s even with a valid recomputed hash', (kind, field) => {
  const source = fixture();
  Reflect.deleteProperty(
    source.toolAssignments[0]!.tools.find((t) => t.kind === kind)!,
    field,
  );
  expect(() => parseCoordinatorAdminDocument(rehash(source))).toThrow(
    'Invalid coordinator admin document',
  );
});

it('refuses settings belonging to another tool kind', () => {
  const source = fixture();
  const code = source.toolAssignments[0]!.tools.find((t) => t.kind === 'codeMode')!;
  code.operations = ['getJiraIssue'];
  expect(() => parseCoordinatorAdminDocument(rehash(source))).toThrow(
    'Invalid coordinator admin document',
  );
});

it('synchronizes disabled-workspace revocation', async () => {
  const enabled = fixture();
  const disabled = fixture(8, 'disabled');
  expect(disabled.installations).toEqual([]);
  expect(disabled.toolAssignments).toEqual([]);
  const etags: unknown[] = [];
  const applied: ReturnType<typeof fixture>[] = [];
  const server = http.createServer((req, res) => {
    etags.push(req.headers['if-none-match']);
    if (etags.length === 3) res.writeHead(304).end();
    else res.end(JSON.stringify(etags.length === 1 ? enabled : disabled));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const sync = createAdminConfigSync({
      adminUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      adminToken: 'synthetic',
      async applyDocument(value) {
        applied.push(value);
      },
    });
    expect((await sync.refresh()).status).toBe('applied');
    expect(await sync.refresh()).toEqual({
      status: 'applied',
      version: 8,
      adminHash: disabled.hash,
    });
    expect(await sync.refresh()).toEqual({
      status: 'unchanged',
      version: 8,
      adminHash: disabled.hash,
    });
    expect(applied).toEqual([enabled, disabled]);
    expect(etags).toEqual([undefined, `"${enabled.hash}"`, `"${disabled.hash}"`]);
    const snapshot = parseCoordinatorAdminDocument(applied[1]);
    expect(snapshot.trustedEditSenders).toEqual([]);
    expect(
      evaluateAuthorization(parseAuthorizationPolicy(snapshot.policySource), {
        workspace: 'TTEAM',
        channel: 'CCHAN',
        user: 'UHUMAN',
        action: 'task.start',
      }).allowed,
    ).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
