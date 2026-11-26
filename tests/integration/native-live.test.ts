import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertAnswer,
  assertWebSearch,
  assertWebFetch,
  validateScenario,
  resolveScenarioFixtures,
  slackClient,
  threadMessages,
  runScenario,
  loadLive,
  keepsPermissionBits,
  main,
  nativeRead,
  assertPublication,
  liveFileTransport,
  settledRequestCount,
  runSuite,
  assertLongAnswer,
  neededTools,
  toolTarget,
  adminClient,
  LiveError,
  IDLE_WAIT_MS,
  // @ts-expect-error operational module is JavaScript
} from '../live/run.mjs';
import {
  longAnswerMessage,
  splitLongAnswer,
} from '../../apps/agent/src/domain/delivery/long-answer.js';
import { longText } from '../../apps/model-stub/src/directives.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('requires provider-annotated citations in the delivered reply and attached answer', () => {
  const citation = '[RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)';
  const expected = { contains: ['Reserved'] };
  const promptAnswer = `Reserved names are documented in ${citation}.`;
  const message = (text: string, richLink = false) => ({
    ts: '1.2',
    user: 'UAPP',
    metadata: {
      event_type: 'support_agent_delivery',
      event_payload: { operation_id: 'op', answer: true },
    },
    blocks: richLink
      ? [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'text', text: 'Reserved names are documented in ' },
                  { type: 'link', text: 'RFC 2606', url: 'https://www.rfc-editor.org/rfc/rfc2606' },
                  { type: 'text', text: '.' },
                ],
              },
            ],
          },
        ]
      : [{ type: 'markdown', text }],
  });
  const inspection = (text: string) => ({
    delivery: {
      outcome: 'delivered',
      slack_ts: '1.2',
      operation_id: 'op',
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
    },
  });
  const ids = [hash(citation)];
  expect(() =>
    assertAnswer([message(promptAnswer, true)], inspection(promptAnswer), 'UAPP', expected, ids),
  ).not.toThrow();
  expect(() =>
    assertAnswer([message(promptAnswer)], inspection(promptAnswer), 'UAPP', expected, []),
  ).toThrow('provider_citation_evidence_missing');
  const fabricated = 'Reserved names are [documented](https://example.com).';
  expect(() =>
    assertAnswer([message(fabricated)], inspection(fabricated), 'UAPP', expected, ids),
  ).toThrow('provider_citation_not_visible');
  const head = 'Reserved names are documented in the RFC. '.repeat(3).trim();
  const preview = { preview: `Full answer attached as answer.md. ${head}` };
  expect(() => assertLongAnswer(preview, `${head}\n\n${citation}`, expected, ids)).not.toThrow();
  const balanced = '[Source](https://example.org/A_(B_(C)))';
  expect(() =>
    assertLongAnswer(preview, `${head}\n\n${balanced}`, expected, [hash(balanced)]),
  ).not.toThrow();
  expect(() => assertLongAnswer(preview, `${head}\n\n\`${citation}\``, expected, ids)).toThrow(
    'provider_citation_not_visible',
  );
});

it('verifies canonical inline code against the retained complete answer hash', () => {
  const content = 'The `<title>` element.';
  const message = {
    ts: '1.2',
    user: 'UAPP',
    metadata: {
      event_type: 'support_agent_delivery',
      event_payload: { operation_id: 'op', answer: true },
    },
    blocks: [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'The ' },
              { type: 'text', text: '<title>', style: { code: true } },
              { type: 'text', text: ' element.' },
            ],
          },
        ],
      },
    ],
  };
  const inspection = {
    delivery: {
      outcome: 'delivered',
      slack_ts: '1.2',
      operation_id: 'op',
      sha256: hash(content),
      bytes: Buffer.byteLength(content),
    },
  };
  expect(assertAnswer([message], inspection, 'UAPP', { contains: ['<title>'] }).sha256).toBe(
    hash(content),
  );
  message.blocks[0]!.elements[0]!.elements[1]!.text = '<body>';
  expect(() => assertAnswer([message], inspection, 'UAPP', { contains: [] })).toThrow(
    'delivery_bytes_mismatch',
  );
});
it('requires direct-fetch evidence for the exact URL and refuses search substitution or discovery writes', () => {
  const step = { webFetch: { url: 'https://example.com/' } };
  const receipt = {
    id: hash('call'),
    url: hash('https://example.com/'),
    sha256: hash('page'),
    bytes: 4,
  };
  expect(assertWebFetch({ webFetch: [receipt] }, step)).toEqual([receipt]);
  for (const receipts of [
    undefined,
    [],
    [{ ...receipt, url: hash('https://other.example/') }],
    [{ ...receipt, bytes: 0 }],
  ])
    expect(() => assertWebFetch({ webFetch: receipts }, step)).toThrow(
      'confirmed_direct_fetch_evidence_missing',
    );
  expect(() => assertWebFetch({ webFetch: [receipt], webSearch: [{}] }, step)).toThrow(
    'direct_fetch_fixture_used_search',
  );
  expect(() => assertWebFetch({ webFetch: [receipt], publications: [{}] }, step)).toThrow(
    'fetch_discovery_produced_external_artifacts',
  );
  expect(
    validateScenario(JSON.parse(fs.readFileSync('tests/live/scenarios/web-fetch.json', 'utf8')))
      .steps,
  ).toHaveLength(2);
});
it('requires matched provider search evidence and refuses discovery publication', () => {
  const step = { webSearch: { minSearches: 1 } };
  const receipt = { id: hash('hosted-search-1'), results: 3 };
  expect(assertWebSearch({ webSearch: [receipt] }, step)).toEqual([receipt]);
  for (const webSearch of [undefined, [], [{ ...receipt, results: -1 }], [receipt, receipt]])
    expect(() => assertWebSearch({ webSearch }, step)).toThrow(
      'confirmed_provider_search_evidence_missing',
    );
  expect(() => assertWebSearch({ webSearch: [receipt], publications: [{}] }, step)).toThrow(
    'search_discovery_produced_external_artifacts',
  );
  expect(() => assertWebSearch({ webSearch: [receipt], exports: [{}] }, step)).toThrow(
    'search_discovery_produced_external_artifacts',
  );
});
it('validates the shipped discovery search scenario without requiring a publication', () => {
  const search = JSON.parse(fs.readFileSync('tests/live/scenarios/web-search.json', 'utf8'));
  expect(validateScenario(search)).toEqual(search);
  search.steps[0].webSearch.minSearches = 0;
  expect(() => validateScenario(search)).toThrow('invalid_search_fixture');
  delete search.steps[0].webSearch;
  expect(() => validateScenario(search)).toThrow('invalid_publication_fixture');
});
it('uploads only fixture bytes and verifies exact current-app file shares without logging credentials', async () => {
  const bytes = Buffer.from('fixture\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const calls: string[] = [];
  const files = liveFileTransport('synthetic-private', async (url: URL, init: RequestInit) => {
    expect(url.hostname).toBe('files.slack.com');
    expect(init.redirect).toBe('error');
    if (init.method === 'POST') expect(init.body).toEqual(bytes);
    else expect(init.headers).toEqual({ authorization: 'Bearer synthetic-private' });
    return new Response(init.method === 'POST' ? 'OK' : bytes);
  });
  const receipts: unknown[] = [];
  const slack = async (method: string) => {
    calls.push(method);
    if (method === 'files.getUploadURLExternal')
      return { file_id: 'FTEST', upload_url: 'https://files.slack.com/upload' };
    if (method === 'files.completeUploadExternal') return { ok: true };
    return {
      file: {
        id: 'FTEST',
        user: 'UAPP',
        size: bytes.length,
        url_private_download: 'https://files.slack.com/file',
        shares: { private: { CTEST: [{ ts: '1.1', thread_ts: '1.1' }] } },
      },
    };
  };
  expect(
    await files.upload(
      slack,
      [{ name: 'fixture.txt', data: bytes.toString('base64') }],
      'CTEST',
      undefined,
      'prompt',
      (r: unknown) => receipts.push(r),
    ),
  ).toEqual({ channel: 'CTEST', ts: '1.1' });
  const inspection = {
    exports: [
      {
        id: 'a',
        name: 'fixture.txt',
        bytes: bytes.length,
        sha256,
        receipt: { id: 'a', bytes: bytes.length, sha256, fileId: 'FTEST' },
      },
    ],
  };
  expect(
    await files.verify(
      slack,
      [{ name: 'fixture.txt', bytes: bytes.length, sha256 }],
      inspection,
      'CTEST',
      '1.1',
      'UAPP',
    ),
  ).toHaveLength(1);
  await expect(
    files.verify(
      slack,
      [{ name: 'fixture.txt', bytes: bytes.length, sha256 }],
      inspection,
      'CTEST',
      '2.2',
      'UAPP',
    ),
  ).rejects.toThrow('recipient');
  expect(JSON.stringify(receipts)).not.toContain('synthetic-private');
  expect(calls.filter((c) => c === 'files.completeUploadExternal')).toHaveLength(1);
});
const scenario = {
  name: 'retained native flow',
  covers: ['synthetic driver flow'],
  budget: { turns: 3, modelRequests: 6 },
  steps: [
    { prompt: 'remember alpha', contains: ['alpha'] },
    { prompt: 'recall', contains: ['alpha'] },
  ],
  isolation: { prompt: 'isolated', contains: ['empty'], excludes: ['alpha'] },
};
const identity = {
  installation: {
    teamId: 'TTEST',
    botUserId: 'UAPP',
    trustedBotSender: { botId: 'BSENDER', userId: 'USENDER', channelId: 'CTEST' },
  },
  assignedTools: 0,
};
function mockModelRead(
  deployment: { modelMode?: string },
  op: string,
  body: { runIds?: string[] },
  requestsPerRun: number,
) {
  const stub = deployment.modelMode === 'stub';
  const model = {
    key: 'fixture',
    route: 'anthropic',
    model: 'synthetic',
    webSearch: !stub,
    connection: stub ? 'synthetic-messages' : 'anthropic',
  };
  if (op === 'model') return model;
  if (op === 'identity') return identity;
  const runIds = body?.runIds ?? [];
  return {
    requests: runIds.length * requestsPerRun,
    inference: runIds.map((runId) => ({ runId, models: [{ ...model, requests: requestsPerRun }] })),
  };
}

function fixture() {
  const root = path.resolve('artifacts/native-live-tests', randomUUID());
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(root + '/admin-store');
  fs.writeFileSync(root + '/runtime', 'synthetic');
  fs.writeFileSync(root + '/gateway', 'synthetic');
  const env: Record<string, string> = {
    COMPOSE_PROJECT_NAME: 'native-test',
    SUPPORT_AGENT_INSTANCE: 'test',
    NATIVE_IMAGE_TAG: 'test',
    NATIVE_FRONTEND_SUBNET: '172.30.10.0/24',
    NATIVE_TOOLS_SUBNET: '172.30.11.0/24',
    NATIVE_DB_SUBNET: '172.30.12.0/24',
    SUPPORT_AGENT_SERVICE_TOKEN: 'synthetic-service',
    ADMIN_INTERNAL_TOKEN: 'synthetic-admin',
    CLI_RUNTIME_TOKEN: 'synthetic-cli',
    SLACK_APP_TOKEN: 'synthetic-app',
    MODEL_CATALOG: JSON.stringify([
      { key: 'fixture', route: 'anthropic', model: 'synthetic', webSearch: true },
    ]),
    MODEL_DEFAULT_KEY: 'fixture',
    GITLAB_HOSTS: 'gitlab.test.invalid',
    ADMIN_PUBLIC_URL: 'https://admin.test.invalid',
    ADMIN_HOST_PORT: '9883',
    ADMIN_STORE_DIR: root + '/admin-store',
    ADMIN_STORE_KEY: 'a'.repeat(64),
    ADMIN_SESSION_KEY: 'b'.repeat(64),
    SLACK_CLIENT_ID: 'synthetic-client',
    SLACK_CLIENT_SECRET: 'synthetic-secret',
    NATIVE_RUNTIME_PASSWORD_FILE: root + '/runtime',
    NATIVE_ANTHROPIC_API_KEY_FILE: root + '/gateway',
  };
  const write = (file: string, v: Record<string, string>) =>
    fs.writeFileSync(
      root + '/' + file,
      Object.entries(v)
        .map(([k, x]) => `${k}=${x}`)
        .join('\n'),
      { mode: 0o600 },
    );
  write('.env.testing', env);
  write('.env.e2e', {
    E2E_SLACK_SENDER_TOKEN: 'synthetic-sender',
    E2E_SLACK_TEAM_ID: 'TTEST',
    E2E_SLACK_CHANNEL_ID: 'CTEST',
  });
  fs.writeFileSync(root + '/scenario.json', JSON.stringify(scenario));
  // What `test:stack:up` records; `setMode('stub')` also writes the stub keys file.
  const setMode = (mode: 'stub' | 'gateway') => {
    fs.writeFileSync(root + '/model-mode', mode + '\n');
  };
  setMode('gateway');
  return { root, env, write, setMode };
}
describe('native live driver', () => {
  it('does not pass a resumed pending follow-up using the earlier delivered run', async () => {
    const answer = { operationId: 'opA', ts: '1.2', sha256: hash('alpha'), bytes: 5 };
    const report = {
      attempts: [
        {
          promptHash: hash(scenario.steps[0]!.prompt),
          rootTs: '1.1',
          messageTs: '1.1',
          state: 'passed',
          runId: 'runA',
          answer,
        },
        {
          promptHash: hash(scenario.steps[1]!.prompt),
          rootTs: '1.1',
          messageTs: '2.1',
          state: 'waiting',
        },
      ],
    };
    const delivery = { ...answer, operation_id: 'opA', slack_ts: '1.2', outcome: 'delivered' };
    let posts = 0,
      waits = 0;
    const slack = async (method: string) => {
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'chat.postMessage') {
        posts++;
        throw Error('unexpected resend');
      }
      return {
        messages: [
          {
            user: 'UAPP',
            ts: '1.2',
            text: 'alpha',
            metadata: {
              event_type: 'support_agent_delivery',
              event_payload: { operation_id: 'opA', answer: true },
            },
          },
          { user: 'USENDER', ts: '2.1' },
        ],
        response_metadata: { next_cursor: '' },
      };
    };
    await expect(
      runScenario({
        scenario: { ...scenario, isolation: undefined },
        slack,
        identity,
        report,
        save: () => {},
        inspect: async () => ({ runId: 'runA', messageTs: '1.1', active: false, delivery }),
        delay: async () => {
          waits++;
          throw Error('pending followup');
        },
      }),
    ).rejects.toThrow('pending followup');
    expect(posts).toBe(0);
    expect(waits).toBe(1);
    expect(report.attempts[1]!.state).toBe('waiting');
  });
  it('reconstructs a plain bullet list and abbreviated URL only when the complete retained hash matches', () => {
    const text =
      'Files:\n- one.js\n- two.js\n\nMR https://gitlab.com/fixture/test/-/merge_requests/3.';
    const section = (text: string) => ({
      type: 'rich_text_section',
      elements: [{ type: 'text', text }],
    });
    const message = {
      ts: '1.2',
      user: 'UAPP',
      metadata: {
        event_type: 'support_agent_delivery',
        event_payload: { operation_id: 'op', answer: true },
      },
      blocks: [
        {
          type: 'rich_text',
          elements: [
            section('Files:'),
            {
              type: 'rich_text_list',
              style: 'bullet',
              indent: 0,
              elements: [section('one.js'), section('two.js')],
            },
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: '\nMR ' },
                {
                  type: 'link',
                  url: 'https://gitlab.com/fixture/test/-/merge_requests/3',
                  text: 'gitlab.com/…/3',
                  truncated: true,
                },
                { type: 'text', text: '.' },
              ],
            },
          ],
        },
      ],
    };
    const inspection = {
      delivery: {
        operation_id: 'op',
        outcome: 'delivered',
        slack_ts: '1.2',
        bytes: Buffer.byteLength(text),
        sha256: hash(text),
      },
    };
    expect(assertAnswer([message], inspection, 'UAPP', { contains: ['one.js'] }).sha256).toBe(
      hash(text),
    );
    expect(() =>
      assertAnswer(
        [message],
        { ...inspection, delivery: { ...inspection.delivery, sha256: hash('changed') } },
        'UAPP',
        { contains: [] },
      ),
    ).toThrow('bytes_mismatch');
  });
  it('verifies published bytes at the receipt commit and requires the same MR on follow-up', () => {
    const commit = 'a'.repeat(40);
    const publication = {
      host: 'gitlab.com',
      project: 'fixture/test',
      projectId: 115,
      targetBranch: 'main',
      files: [{ path: 'shout.js', contains: ['toUpperCase'] }],
    };
    const evidence = {
      state: 'completed',
      project: publication.project,
      projectId: 115,
      commit,
      branch: 'support-agent/task',
      targetBranch: 'main',
      mrIid: 3,
      mrUrl: 'https://gitlab.com/fixture/test/-/merge_requests/3',
    };
    const inspection = {
      runId: 'run',
      publications: [{ run_id: 'run', outcome: 'confirmed', evidence }],
    };
    const bytes = Buffer.from('text.toUpperCase()');
    const observed = {
      project: { id: 115, path_with_namespace: publication.project, default_branch: 'main' },
      mr: {
        project_id: 115,
        iid: 3,
        state: 'opened',
        source_branch: evidence.branch,
        target_branch: 'main',
        web_url: evidence.mrUrl,
        sha: commit,
      },
      files: [
        {
          file_path: 'shout.js',
          commit_id: commit,
          encoding: 'text',
          content: bytes.toString('utf8'),
          size: bytes.length,
          content_sha256: hash(bytes.toString()),
        },
      ],
    };
    const verified = assertPublication(inspection, publication, observed);
    expect(verified.files[0].sha256).toBe(hash(bytes.toString()));
    expect(() => assertPublication(inspection, publication, observed, verified)).toThrow(
      'new_commit',
    );
    expect(() =>
      assertPublication(inspection, publication, {
        ...observed,
        mr: { ...observed.mr, target_branch: 'other' },
      }),
    ).toThrow('remote_identity');
    expect(() =>
      assertPublication(inspection, publication, {
        ...observed,
        files: [{ ...observed.files[0], commit_id: 'b'.repeat(40) }],
      }),
    ).toThrow('file_identity');
    expect(() =>
      assertPublication(inspection, publication, {
        ...observed,
        files: [{ ...observed.files[0], content: 'text.toLowerCase()' }],
      }),
    ).toThrow('bytes');
    expect(() =>
      assertPublication(
        { ...inspection, publications: [{ ...inspection.publications[0], outcome: 'uncertain' }] },
        publication,
        observed,
      ),
    ).toThrow('not_confirmed');
    expect(
      validateScenario({
        name: 'coding',
        mode: 'coding',
        covers: ['synthetic coding'],
        budget: { turns: 1, modelRequests: 30 },
        steps: [{ prompt: 'Implement fixture', contains: ['Verified publication'], publication }],
      }).mode,
    ).toBe('coding');
  });
  it('checks exact visible plain-text blocks despite Slack normalizing the fallback', () => {
    const text = 'alpha\n\nbeta';
    const delivery = {
      outcome: 'delivered',
      operation_id: 'op',
      slack_ts: '1.2',
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
    };
    const message = {
      ts: '1.2',
      user: 'UAPP',
      text: 'alpha  beta',
      metadata: {
        event_type: 'support_agent_delivery',
        event_payload: { operation_id: 'op', answer: true },
      },
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'alpha' },
                { type: 'text', text: '\n\n' },
                { type: 'text', text: 'beta' },
              ],
            },
          ],
        },
      ],
    };
    expect(
      assertAnswer([message], { delivery }, 'UAPP', { contains: ['alpha', 'beta'] }),
    ).toMatchObject({ sha256: hash(text) });
    message.blocks[0]!.elements[0]!.elements[2]!.text = 'changed';
    expect(() => assertAnswer([message], { delivery }, 'UAPP', { contains: [] })).toThrow(
      'delivery_bytes_mismatch',
    );
  });
  it('refuses incomplete inspection identity rather than hiding it as an absent run', () => {
    let calls = 0;
    expect(() =>
      nativeRead({}, 'inspect', { teamId: 'TTEST', channelId: 'CTEST' }, () => {
        calls++;
        return '{}';
      }),
    ).toThrow('native_inspection_identity_required');
    expect(calls).toBe(0);
  });
  it('reports a fixed missing-scope diagnostic without upstream private details', async () => {
    const slack = slackClient(
      'synthetic-secret',
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: 'missing_scope',
            message: 'private-upstream-detail',
          }),
          { status: 200 },
        ),
    );
    await expect(slack('conversations.replies', { channel: 'CTEST' })).rejects.toThrow(
      'slack_conversations_replies_missing_scope',
    );
  });
  it('runs the exact container inspection program without exporting service credentials', () => {
    fixture();
    let code = '',
      argument = '';
    nativeRead(
      {},
      'identity',
      { teamId: 'TTEST', channelId: 'CTEST' },
      (_d: unknown, args: string[]) => {
        code = args[6]!;
        argument = args[7]!;
        return '{}';
      },
    );
    const prefix = `globalThis.fetch=async()=>({ok:true,json:async()=>(${JSON.stringify({
      installations: [identity.installation],
      toolAssignments: [
        { teamId: 'TTEST', channelId: 'CTEST', tools: [] },
        { teamId: 'TOTHER', channelId: 'CTEST', tools: [{ id: 'unrelated' }] },
      ],
      version: 1,
      hash: 'safe',
    })})});`;
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', prefix + code, argument], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ADMIN_URL: 'http://synthetic/',
        ADMIN_INTERNAL_TOKEN: 'never-export-this',
      },
    });
    expect(p.status, p.stderr).toBe(0);
    expect(JSON.parse(p.stdout).installation).toEqual(identity.installation);
    expect(JSON.parse(p.stdout).assignedTools).toBe(0);
    expect(p.stdout).not.toContain('never-export-this');
  });

  it('validates bounded answer scenarios and refuses legacy/coding/placeholder fields', () => {
    expect(validateScenario(scenario)).toBe(scenario);
    for (const value of [
      { ...scenario, mode: 'claude-code' },
      { ...scenario, steps: [] },
      { ...scenario, steps: [{ prompt: '<operator: value>', contains: ['x'] }] },
      { ...scenario, steps: [{ prompt: '<@UBROAD>', contains: ['x'] }] },
      { ...scenario, steps: [{ ...scenario.steps[0], publications: [] }] },
    ])
      expect(() => validateScenario(value)).toThrow();
  });
  it('checks private harness identity without any network or Docker', async () => {
    const { root, env, write } = fixture();
    expect(loadLive(root).d.project).toBe('native-test');
    expect(await main(['--instance-dir', root, '--scenario', root + '/scenario.json'])).toBe(0);
    expect(
      await main(['--instance-dir', root, '--scenario', root + '/scenario.json', '--run']),
    ).toBe(2);
    const reports = fs
      .readdirSync(root + '/artifacts/native-live')
      .map((id) =>
        JSON.parse(fs.readFileSync(root + '/artifacts/native-live/' + id + '/report.json', 'utf8')),
      );
    expect(reports.some((r) => r.reason === 'gateway_availability_confirmation_required')).toBe(
      true,
    );
    fs.chmodSync(root + '/.env.e2e', 0o644);
    const kept = (fs.statSync(root + '/.env.e2e').mode & 0o777) === 0o644;
    expect(keepsPermissionBits(root)).toBe(kept);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.mode-probe-'))).toEqual([]);
    if (kept) expect(() => loadLive(root)).toThrow('private');
    else expect(() => loadLive(root)).not.toThrow('private');
    fs.chmodSync(root + '/.env.e2e', 0o600);
    write('.env.testing', { ...env, SLACK_APP_TOKEN: 'synthetic-sender' });
    expect(() => loadLive(root)).toThrow('sender_credential_not_harness_only');
  });
  it('fills GitLab fixture placeholders from .env.e2e and blocks a missing value', () => {
    const gitlab = {
      E2E_GITLAB_HOST: 'gitlab.test.invalid',
      E2E_GITLAB_PROJECT: 'group/fixture',
      E2E_GITLAB_PROJECT_ID: '42',
      E2E_GITLAB_TARGET_BRANCH: 'main',
    };
    for (const name of ['coding-files', 'thread-followup']) {
      const raw = JSON.parse(fs.readFileSync(`tests/live/scenarios/${name}.json`, 'utf8'));
      expect(JSON.stringify(raw)).not.toContain('example-group');
      const resolved = validateScenario(resolveScenarioFixtures(raw, gitlab));
      expect(JSON.stringify(resolved)).not.toContain('{{');
      expect(resolved.steps[0].prompt).toContain('group/fixture');
      for (const step of resolved.steps.filter((x: { publication?: unknown }) => x.publication)) {
        expect(step.publication).toMatchObject({
          host: 'gitlab.test.invalid',
          project: 'group/fixture',
          projectId: 42,
          targetBranch: 'main',
        });
      }
      expect(() => resolveScenarioFixtures(raw, { ...gitlab, E2E_GITLAB_PROJECT_ID: '' })).toThrow(
        'missing_E2E_GITLAB_PROJECT_ID',
      );
      expect(() =>
        resolveScenarioFixtures(raw, { ...gitlab, E2E_GITLAB_PROJECT: '<operator: project>' }),
      ).toThrow('missing_E2E_GITLAB_PROJECT');
    }
    // Only a publication's projectId becomes a number; a fact in `contains` stays text.
    const discovery = resolveScenarioFixtures(
      JSON.parse(fs.readFileSync('tests/live/scenarios/gitlab-discovery.json', 'utf8')),
      {
        ...gitlab,
        E2E_GITLAB_TRACE_JOB_ID: '7',
        E2E_GITLAB_TRACE_HEAD_MARKER: 'trace-marker head',
        E2E_GITLAB_TRACE_TAIL_MARKER: 'trace-marker-end',
      },
    );
    expect(validateScenario(discovery).steps[0].contains).toEqual(['42', 'main']);
    expect(discovery.steps[1].prompt).toContain('CI job 7 ');
    expect(() =>
      resolveScenarioFixtures(
        JSON.parse(fs.readFileSync('tests/live/scenarios/gitlab-discovery.json', 'utf8')),
        gitlab,
      ),
    ).toThrow('missing_E2E_GITLAB_TRACE_JOB_ID');
    const answer = JSON.parse(
      fs.readFileSync('tests/live/scenarios/answer-continuity.json', 'utf8'),
    );
    expect(resolveScenarioFixtures(answer, {})).toEqual(answer);
    expect(() => resolveScenarioFixtures({ prompt: '{{gitlab.token}}' }, gitlab)).toThrow(
      'invalid_native_scenario',
    );
  });
  it('never retries uncertain Slack writes and never includes raw errors or credentials', async () => {
    let calls = 0;
    const slack = slackClient('synthetic-secret', async () => {
      calls++;
      throw Error('synthetic-secret');
    });
    await expect(slack('chat.postMessage', { channel: 'CTEST', text: 'x' })).rejects.toThrow(
      'slack_send_unknown_no_retry',
    );
    expect(calls).toBe(1);
    await expect(slack('chat.scheduleMessage')).rejects.toThrow('unsupported_slack_method');
    expect(calls).toBe(1);
  });
  it('continues empty paginated pages and refuses repeating/malformed cursors', async () => {
    let n = 0;
    expect(
      await threadMessages(
        async () =>
          n++
            ? { messages: [{ ts: '1.2' }], response_metadata: { next_cursor: '' } }
            : { messages: [], response_metadata: { next_cursor: 'next' } },
        'CTEST',
        '1.1',
      ),
    ).toEqual([{ ts: '1.2' }]);
    await expect(
      threadMessages(
        async () => ({ messages: [], response_metadata: { next_cursor: 'repeat' } }),
        'CTEST',
        '1.1',
      ),
    ).rejects.toThrow('cursor');
    await expect(
      threadMessages(
        async () => ({ messages: [], response_metadata: { next_cursor: false } }),
        'CTEST',
        '1.1',
      ),
    ).rejects.toThrow('cursor');
  });
  it('binds exact Slack bytes, identity and unique operation to the native delivered receipt', () => {
    const d = {
      operation_id: 'op',
      outcome: 'delivered',
      slack_ts: '1.2',
      sha256: hash('alpha'),
      bytes: 5,
    };
    const m = {
      ts: '1.2',
      user: 'UAPP',
      text: 'alpha',
      metadata: {
        event_type: 'support_agent_delivery',
        event_payload: { operation_id: 'op', answer: true },
      },
    };
    expect(assertAnswer([m], { delivery: d }, 'UAPP', scenario.steps[0]).sha256).toBe(d.sha256);
    for (const messages of [[m, m], [{ ...m, user: 'UOTHER' }], [{ ...m, text: 'altered' }]])
      expect(() => assertAnswer(messages, { delivery: d }, 'UAPP', scenario.steps[0])).toThrow();
    expect(() =>
      assertAnswer([m], { delivery: { ...d, outcome: 'uncertain' } }, 'UAPP', scenario.steps[0]),
    ).toThrow();
  });
  it('executes a full deterministic transport flow and retains every successful send without cleanup', async () => {
    let seq = 0;
    const current = new Map<string, unknown>(),
      messages = new Map<string, unknown[]>(),
      methods: string[] = [];
    const report = { attempts: [] };
    let saves = 0;
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      methods.push(method);
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'chat.postMessage') {
        const ts = `${++seq}.000001`,
          root = String(body.thread_ts ?? ts),
          text = String(body.text).includes('isolated') ? 'empty' : 'alpha',
          op = `operation-${seq}`,
          replyTs = `${seq}.000002`;
        current.set(root, {
          runId: `run-${seq}`,
          messageTs: ts,
          active: false,
          delivery: {
            operation_id: op,
            outcome: 'delivered',
            slack_ts: replyTs,
            sha256: hash(text),
            bytes: Buffer.byteLength(text),
          },
        });
        messages.set(root, [
          ...(messages.get(root) ?? []),
          {
            ts: replyTs,
            user: 'UAPP',
            text,
            metadata: {
              event_type: 'support_agent_delivery',
              event_payload: { operation_id: op, answer: true },
            },
          },
        ]);
        return { ts, channel: 'CTEST' };
      }
      if (method === 'conversations.replies')
        return { messages: messages.get(String(body.ts)), response_metadata: { next_cursor: '' } };
      throw Error('unexpected method');
    };
    await runScenario({
      scenario,
      slack,
      identity,
      report,
      save: () => saves++,
      inspect: async (root: string) => current.get(root) ?? null,
      delay: async () => {},
    });
    expect(report.attempts).toHaveLength(3);
    expect(report.attempts.every((a: { state: string }) => a.state === 'passed')).toBe(true);
    expect(saves).toBeGreaterThan(6);
    expect(methods.filter((m) => m === 'chat.postMessage')).toHaveLength(3);
    expect(new Set(methods)).toEqual(
      new Set(['auth.test', 'chat.postMessage', 'conversations.replies']),
    );
    await runScenario({
      scenario,
      slack,
      identity,
      report,
      save: () => saves++,
      inspect: async (root: string) => current.get(root) ?? null,
      delay: async () => {},
    });
    expect(methods.filter((m) => m === 'chat.postMessage')).toHaveLength(3);
  });
  it('sends an unmentioned follow-up and requires observed then cleared app working reactions', async () => {
    let seq = 0,
      cleared = false;
    const sent: string[] = [];
    const messages: Array<Record<string, unknown>> = [];
    const report: { attempts: Array<{ workingObserved?: boolean; workingCleared?: boolean }> } = {
      attempts: [],
    };
    const ux = {
      ...scenario,
      isolation: undefined,
      steps: scenario.steps.map((s, i) => ({ ...s, mention: i === 0, working: true })),
    };
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'chat.postMessage') {
        seq++;
        cleared = false;
        sent.push(String(body.text));
        messages.push({ ts: `${seq}.1`, user: 'USENDER', text: body.text });
        messages.push({
          ts: `${seq}.2`,
          user: 'UAPP',
          text: 'alpha',
          metadata: {
            event_type: 'support_agent_delivery',
            event_payload: { operation_id: `op${seq}`, answer: true },
          },
        });
        return { ts: `${seq}.1`, channel: 'CTEST' };
      }
      if (method === 'conversations.replies')
        return {
          messages: messages.map((m) => ({
            ...m,
            ...(m.ts === `${seq}.1` && !cleared
              ? { reactions: [{ name: 'hourglass_flowing_sand', users: ['UAPP'] }] }
              : {}),
          })),
          response_metadata: { next_cursor: '' },
        };
      throw Error('unexpected');
    };
    await runScenario({
      scenario: ux,
      slack,
      identity,
      report,
      save: () => {},
      delay: async () => {},
      inspect: async () => {
        cleared = true;
        return {
          runId: `run${seq}`,
          messageTs: `${seq}.1`,
          delivery: {
            outcome: 'delivered',
            operation_id: `op${seq}`,
            slack_ts: `${seq}.2`,
            sha256: hash('alpha'),
            bytes: 5,
          },
        };
      },
    });
    expect(sent).toEqual(['<@UAPP> remember alpha', 'recall']);
    expect(report.attempts.every((a) => a.workingObserved && a.workingCleared)).toBe(true);
    expect(() =>
      validateScenario({ ...scenario, steps: [{ ...scenario.steps[0], mention: 'false' }] }),
    ).toThrow();
  });
  it('gates scenarios by the instance model mode and records it in the report', async () => {
    const { root, setMode } = fixture();
    const stubScenario = { ...scenario, model: 'stub' };
    fs.writeFileSync(root + '/stub.json', JSON.stringify(stubScenario));
    const dir = root + '/artifacts/native-live';
    const latest = async (args: string[]) => {
      const before = new Set(fs.readdirSync(dir));
      const code = await main(['--instance-dir', root, ...args]);
      const id = fs.readdirSync(dir).find((x) => !before.has(x))!;
      return { code, report: JSON.parse(fs.readFileSync(`${dir}/${id}/report.json`, 'utf8')) };
    };
    fs.mkdirSync(dir, { recursive: true });
    // Before the first test:stack:up the mode is unknown.
    fs.rmSync(root + '/model-mode');
    const unknown = await latest(['--scenario', root + '/scenario.json']);
    expect(unknown.code).toBe(2);
    expect(unknown.report.reason).toBe('model_mode_unknown_start_with_test_stack_up');
    setMode('gateway');
    // A gateway instance refuses stub scenarios: directives prove nothing to a model.
    const refused = await latest(['--scenario', root + '/stub.json']);
    expect(refused.code).toBe(2);
    expect(refused.report).toMatchObject({ reason: 'stub_mode_required', modelMode: 'gateway' });
    expect(refused.report.acceptance).toBeUndefined();
    setMode('stub');
    // A stub instance blocks gateway scenarios.
    const blocked = await latest(['--scenario', root + '/scenario.json']);
    expect(blocked.code).toBe(2);
    expect(blocked.report).toMatchObject({ reason: 'gateway_mode_required', modelMode: 'stub' });
    const valid = await latest(['--scenario', root + '/stub.json']);
    expect(valid.code).toBe(0);
    expect(valid.report).toMatchObject({
      outcome: 'configuration_valid_live_not_run',
      modelMode: 'stub',
      acceptance: 'deterministic, not live acceptance',
    });
    // Stub runs need no Gateway confirmation; the (failing) Docker check comes next.
    const bin = root + '/bin';
    fs.mkdirSync(bin);
    fs.writeFileSync(bin + '/docker', '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const run = await latest(['--scenario', root + '/stub.json', '--run']);
      expect(run.code).toBe(2);
      expect(run.report.reason).toBe('configuration_or_runtime_prerequisite_unavailable');
      expect(run.report.modelMode).toBe('stub');
    } finally {
      process.env.PATH = path;
    }
    // Nothing was posted in any mode.
    for (const id of fs.readdirSync(dir))
      expect(JSON.parse(fs.readFileSync(`${dir}/${id}/report.json`, 'utf8')).attempts).toEqual([]);
  });
  it('validates stub, question and resume fields and the shipped stub scenarios', () => {
    const stub = { ...scenario, model: 'stub' };
    expect(validateScenario(stub)).toBe(stub);
    const ask = {
      ...stub,
      steps: [
        { prompt: 'STUB_ASK Which?', contains: ['Which?'], question: true },
        { prompt: 'continue teal', contains: ['teal'], resume: true },
      ],
    };
    expect(validateScenario(ask)).toBe(ask);
    const files = {
      ...stub,
      steps: [{ prompt: 'x', contains: ['x'], attachments: [{ name: 'a.txt', data: 'eA==' }] }],
    };
    expect(validateScenario(files)).toBe(files);
    const coding = {
      name: 'tool',
      mode: 'coding',
      covers: ['synthetic tool'],
      budget: { turns: 1, modelRequests: 4 },
      steps: [{ prompt: 'x', contains: ['x'] }],
    };
    for (const value of [
      { ...scenario, model: 'mock' },
      // A coding step needs a publication or discovery fixture, in both suites.
      coding,
      { ...coding, model: 'stub' },
      { ...ask, steps: [ask.steps[1]] },
      { ...ask, steps: [ask.steps[0], { ...ask.steps[1], prompt: 'teal' }] },
      { ...ask, steps: [ask.steps[0], { ...ask.steps[1], mention: false }] },
      { ...ask, isolation: { ...scenario.isolation, question: true } },
      { ...ask, steps: [{ ...ask.steps[0], question: 'yes' }] },
      { ...stub, steps: [{ ...scenario.steps[0], exports: [] }] },
    ])
      expect(() => validateScenario(value)).toThrow();
    const gitlab = {
      E2E_GITLAB_HOST: 'gitlab.test.invalid',
      E2E_GITLAB_PROJECT: 'group/fixture',
      E2E_GITLAB_PROJECT_ID: '42',
      E2E_GITLAB_TARGET_BRANCH: 'main',
    };
    const dir = 'tests/live/scenarios/stub';
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual([
      'answer-continuity.json',
      'ask-resume.json',
      'cancel.json',
      'channel-settings.json',
      'files.json',
      'long-reply.json',
      'message-lifecycle.json',
      'thread-followup.json',
    ]);
    for (const name of names) {
      const raw = JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'));
      const resolved = validateScenario(resolveScenarioFixtures(raw, gitlab));
      expect(resolved.model, name).toBe('stub');
      expect(JSON.stringify(resolved), name).toMatch(/STUB_[A-Z]+/);
      // T4 needs only Docker and the Slack test app.
      expect(neededTools(resolved), name).toEqual([]);
    }
    // Every shipped gateway scenario stays a gateway scenario, passes the gate
    // fields and claims behaviour no other gateway scenario claims.
    const claimed: string[] = [];
    for (const name of fs.readdirSync('tests/live/scenarios').filter((n) => n.endsWith('.json'))) {
      const raw = JSON.parse(fs.readFileSync(`tests/live/scenarios/${name}`, 'utf8'));
      expect(raw.model, name).toBeUndefined();
      expect(raw.covers?.length, name).toBeGreaterThan(0);
      expect(raw.budget, name).toBeDefined();
      claimed.push(...raw.covers);
    }
    expect(new Set(claimed).size).toBe(claimed.length);
  });
  it('passes a question step on the suspension notice and resumes the same run', async () => {
    const ask = {
      ...scenario,
      model: 'stub',
      steps: [
        { prompt: 'STUB_ASK Which colour?', contains: ['Which colour?'], question: true },
        { prompt: 'continue teal-42', contains: ['teal-42'], resume: true },
      ],
    };
    let seq = 0,
      askTs = '';
    const state = new Map<string, Record<string, unknown>>(),
      threads = new Map<string, Array<Record<string, unknown>>>(),
      sent: string[] = [];
    const deliver = (root: string, runId: string, text: string, messageTs: string) => {
      const op = `op-${++seq}`,
        ts = `${seq}.9`;
      state.set(root, {
        runId,
        messageTs,
        active: false,
        delivery: {
          operation_id: op,
          outcome: 'delivered',
          slack_ts: ts,
          sha256: hash(text),
          bytes: Buffer.byteLength(text),
        },
      });
      threads.get(root)!.push({
        ts,
        user: 'UAPP',
        text,
        metadata: {
          event_type: 'support_agent_delivery',
          event_payload: { operation_id: op, answer: true },
        },
      });
    };
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'chat.postMessage') {
        const ts = `${++seq}.1`,
          root = String(body.thread_ts ?? ts),
          text = String(body.text);
        sent.push(text);
        threads.set(root, [...(threads.get(root) ?? []), { ts, user: 'USENDER', text }]);
        if (text.includes('STUB_ASK')) {
          askTs = ts;
          state.set(root, {
            runId: 'run-ask',
            messageTs: ts,
            active: false,
            suspended: true,
            delivery: null,
          });
          threads.get(root)!.push({
            ts: `${seq}.5`,
            user: 'UAPP',
            text: 'Which colour?\n\nMention me in this thread with `continue <answer>` or `cancel`.',
          });
        } else if (text.includes('continue'))
          deliver(root, 'run-ask', 'STUB_ASK_RESULT teal-42', askTs);
        else deliver(root, `run-${seq}`, 'empty', ts);
        return { ts, channel: 'CTEST' };
      }
      if (method === 'conversations.replies')
        return { messages: threads.get(String(body.ts)), response_metadata: { next_cursor: '' } };
      throw Error('unexpected');
    };
    const report: { attempts: Array<Record<string, unknown>> } = { attempts: [] };
    await runScenario({
      scenario: ask,
      slack,
      identity,
      report,
      save: () => {},
      delay: async () => {},
      inspect: async (root: string) => state.get(root) ?? null,
    });
    expect(sent).toEqual([
      '<@UAPP> STUB_ASK Which colour?',
      '<@UAPP> continue teal-42',
      '<@UAPP> isolated',
    ]);
    expect(report.attempts.map((a) => a.runId)).toEqual(['run-ask', 'run-ask', 'run-4']);
    expect(report.attempts[0]).toMatchObject({ state: 'passed', question: { ts: '1.5' } });
    expect(report.attempts[0]!.answer).toBeUndefined();
    expect(report.attempts[1]).toMatchObject({ state: 'passed', answer: { operationId: 'op-3' } });
    // A delivered answer instead of a question fails the question step.
    state.clear();
    await expect(
      runScenario({
        scenario: { ...ask, steps: [ask.steps[0]!], isolation: undefined },
        slack: async (method: string, body: Record<string, unknown> = {}) => {
          if (method === 'chat.postMessage') {
            const ts = `${++seq}.1`;
            threads.set(ts, [{ ts, user: 'USENDER', text: body.text }]);
            deliver(ts, 'run-direct', 'no question', ts);
            return { ts, channel: 'CTEST' };
          }
          return slack(method, body);
        },
        identity,
        report: { attempts: [] },
        save: () => {},
        delay: async () => {},
        inspect: async (root: string) => state.get(root) ?? null,
      }),
    ).rejects.toThrow('native_question_not_asked');
  });
  it('enforces the live-scenario gate on gateway scenarios only', () => {
    const bare: Record<string, unknown> = { ...scenario };
    delete bare.covers;
    delete bare.budget;
    expect(() => validateScenario(bare)).toThrow('gateway_gate_fields_required');
    expect(() => validateScenario({ ...bare, covers: scenario.covers })).toThrow(
      'gateway_gate_fields_required',
    );
    expect(validateScenario({ ...bare, model: 'stub' })).toBeTruthy();
    expect(() => validateScenario({ ...scenario, budget: { turns: 2, modelRequests: 6 } })).toThrow(
      'gateway_turn_budget_exceeded',
    );
    for (const covers of [[], ['x'], ['Upper Case'], ['same thing', 'same thing'], 'flow'])
      expect(() => validateScenario({ ...scenario, covers })).toThrow('invalid_gate_covers');
    for (const budget of [
      { turns: 3 },
      { turns: 3, modelRequests: 0 },
      { turns: 3, modelRequests: 6, extra: 1 },
      { turns: 10, modelRequests: 6 },
    ])
      expect(() => validateScenario({ ...scenario, budget })).toThrow('invalid_gate_budget');
  });
  it('waits for the cost ledger to settle before counting model requests', async () => {
    const waits: number[] = [];
    const delay = async (ms: number) => {
      waits.push(ms);
    };
    const reads = [3, 5, 5];
    expect(await settledRequestCount(async () => ({ requests: reads.shift() }), delay)).toBe(5);
    expect(waits).toEqual([6000, 6000]);
    await expect(settledRequestCount(async () => ({ requests: 0 }), delay, 3)).rejects.toThrow(
      'model_request_count_unsettled',
    );
    await expect(settledRequestCount(async () => ({ requests: -1 }), delay)).rejects.toThrow(
      'model_request_count_unavailable',
    );
  });
  it('counts model requests per run inside the container with the internal token only', () => {
    fixture();
    let code = '',
      argument = '';
    nativeRead({}, 'requests', { runIds: ['run-a', 'run-b'] }, (_d: unknown, args: string[]) => {
      code = args[6]!;
      argument = args[7]!;
      return '{"requests":0}';
    });
    expect(() => nativeRead({}, 'requests', { runIds: ['bad id'] })).toThrow(
      'unsupported_native_read',
    );
    const prefix = `globalThis.fetch=async(url,init)=>{if(init.headers.authorization!=='Bearer synthetic-internal')throw Error('auth');const id=new URL(url).searchParams.get('runId');return {ok:true,json:async()=>({runId:id,requests:id==='run-a'?2:3,inference:[{route:'anthropic'}]})}};`;
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', prefix + code, argument], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ADMIN_URL: 'http://synthetic/',
        ADMIN_INTERNAL_TOKEN: 'synthetic-internal',
      },
    });
    expect(p.status, p.stderr).toBe(0);
    expect(JSON.parse(p.stdout)).toEqual({
      requests: 5,
      inference: [
        { runId: 'run-a', models: [{ route: 'anthropic' }] },
        { runId: 'run-b', models: [{ route: 'anthropic' }] },
      ],
    });
  });
  it('runs a suite, enforces the request budget and skips unchanged passes until --rerun', async () => {
    const { root, env, write } = fixture();
    write('.env.testing', {
      ...env,
      COMPOSE_PROJECT_NAME: `native-suite-${randomUUID().slice(0, 8)}`,
    });
    const repo = root + '/repo';
    const folder = repo + '/tests/live/scenarios';
    fs.mkdirSync(folder, { recursive: true });
    const small = { ...scenario, name: 'small', budget: { turns: 3, modelRequests: 4 } };
    fs.writeFileSync(folder + '/a.json', JSON.stringify(scenario));
    fs.writeFileSync(folder + '/b.json', JSON.stringify({ ...small, covers: ['other flow'] }));
    let image = 'sha256:one';
    let runs = 0;
    const deps = {
      repo,
      services: () =>
        ['native-answer', 'native-postgres', 'adapter', 'admin'].map((service) => ({
          service,
          running: true,
          image: service === 'native-answer' ? image : 'sha256:same',
        })),
      status: () => ({ idle: true, waits: [] }),
      delay: async () => {},
      nativeRead: (d: { modelMode?: string }, op: string, body: { runIds?: string[] }) =>
        mockModelRead(d, op, body, 2),
      runScenario: async ({ report }: { report: { attempts: unknown[] } }) => {
        runs++;
        report.attempts.push(
          { runId: `r${runs}-1` },
          { runId: `r${runs}-2` },
          { runId: `r${runs}-3` },
        );
      },
    };
    const args = ['--instance-dir', root, '--suite', 'gateway', '--run', '--gateway-ready'];
    const summaries = () =>
      fs
        .readdirSync(root + '/artifacts/native-live')
        .filter((n) => n.startsWith('suite-'))
        .map((n) =>
          JSON.parse(fs.readFileSync(`${root}/artifacts/native-live/${n}/summary.json`, 'utf8')),
        )
        .sort((x, y) => x.startedAt.localeCompare(y.startedAt));
    // 3 runs x 2 requests: a passes (6 <= 6), b exceeds its budget (6 > 4).
    expect(await main(args, deps)).toBe(1);
    let summary = summaries().at(-1);
    expect(summary.scenarios.map((x: { outcome: string }) => x.outcome)).toEqual([
      'passed',
      'failed',
    ]);
    expect(summary.scenarios[1]).toMatchObject({
      reason: 'model_request_budget_exceeded',
      modelRequests: 6,
    });
    expect(runs).toBe(2);
    // Unchanged scenario and images: a is skipped, the failed b runs again.
    expect(await main(args, deps)).toBe(1);
    summary = summaries().at(-1);
    expect(summary.scenarios[0]).toMatchObject({ outcome: 'skipped_unchanged' });
    expect(summary.counts).toMatchObject({ skipped_unchanged: 1, failed: 1 });
    expect(runs).toBe(3);
    // --rerun runs everything; a changed image runs a again.
    await main([...args, '--rerun'], deps);
    expect(runs).toBe(5);
    image = 'sha256:two';
    fs.writeFileSync(
      folder + '/b.json',
      JSON.stringify({ ...small, covers: ['other flow'], budget: { turns: 3, modelRequests: 6 } }),
    );
    expect(await main(args, deps)).toBe(0);
    expect(runs).toBe(7);
    expect(summaries().at(-1)).toMatchObject({ outcome: 'passed', counts: { passed: 2 } });
    expect(await main(args, deps)).toBe(0);
    expect(runs).toBe(7);
    // Two gateway scenarios may not claim the same behaviour.
    fs.writeFileSync(folder + '/c.json', JSON.stringify({ ...scenario, name: 'copy' }));
    expect(await main(args, deps)).toBe(2);
    expect(summaries().at(-1)).toMatchObject({
      outcome: 'blocked',
      reason: 'gateway_covers_duplicate',
    });
    expect(runs).toBe(7);
    await expect(main([...args, '--scenario', folder + '/a.json'], deps)).rejects.toThrow(
      '--suite',
    );
    await expect(
      main(['--instance-dir', root, '--scenario', folder + '/a.json', '--rerun'], deps),
    ).rejects.toThrow('--rerun');
    expect(await runSuite({ root, suite: 'mock', values: {}, deps })).toBe(2);
  });
  it('cancels a held run and posts message attachments', async () => {
    let seq = 0,
      heldTs = '';
    const state = new Map<string, Record<string, unknown>>(),
      threads = new Map<string, Array<Record<string, unknown>>>(),
      posted: Array<Record<string, unknown>> = [];
    const deliver = (root: string, runId: string, text: string, messageTs: string) => {
      const op = `op-${++seq}`,
        ts = `${seq}.9`;
      state.set(root, {
        runId,
        messageTs,
        active: false,
        delivery: {
          operation_id: op,
          outcome: 'delivered',
          slack_ts: ts,
          sha256: hash(text),
          bytes: Buffer.byteLength(text),
        },
      });
      threads.get(root)!.push({
        ts,
        user: 'UAPP',
        text,
        metadata: {
          event_type: 'support_agent_delivery',
          event_payload: { operation_id: op, answer: true },
        },
      });
    };
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'conversations.replies')
        return { messages: threads.get(String(body.ts)), response_metadata: { next_cursor: '' } };
      if (method !== 'chat.postMessage') throw Error('unexpected method');
      posted.push(body);
      const ts = `${++seq}.1`,
        root = String(body.thread_ts ?? ts),
        text = String(body.text);
      if (!threads.has(root)) threads.set(root, []);
      threads.get(root)!.push({ ts, user: 'USENDER', text });
      if (text.includes('HOLD')) {
        // Admitted and running; the held answer never arrives.
        heldTs = ts;
        state.set(root, { runId: 'held-run', messageTs: ts, active: true, delivery: null });
        threads.get(root)!.at(-1)!.reactions = [
          { name: 'hourglass_flowing_sand', users: ['UAPP'] },
        ];
      } else if (text.endsWith('cancel')) {
        state.set(root, {
          runId: 'held-run',
          messageTs: heldTs,
          active: false,
          delivery: null,
          receipt: 'Cancellation recorded. Unconfirmed work will not restart or deliver.',
        });
        delete threads.get(root)!.find((m) => String(m.text).includes('HOLD'))!.reactions;
        threads.get(root)!.push({
          ts: `${seq}.5`,
          user: 'UAPP',
          text: 'Stopped. Unconfirmed work will not restart or deliver.',
        });
      } else deliver(root, `run-${seq}`, 'attachment noted', ts);
      return { ts, channel: 'CTEST' };
    };
    const value = {
      name: 'held',
      model: 'stub',
      steps: [
        { prompt: 'HOLD', wait: false, working: true, excludes: ['held answer'] },
        { prompt: 'cancel', contains: ['Stopped.'], cancel: true },
        {
          prompt: 'alert with attachments',
          contains: ['attachment noted'],
          messageAttachments: [{ fallback: 'alert', fields: [{ title: 'T', value: 'ATT-1' }] }],
        },
      ],
      isolation: { prompt: 'isolated', contains: ['attachment noted'] },
    };
    expect(validateScenario(value)).toBe(value);
    const report: {
      attempts: Array<{ state: string; workingCleared?: boolean; cancelled?: { ts: string } }>;
    } = { attempts: [] };
    await runScenario({
      scenario: value,
      slack,
      identity: { ...identity, assignedTools: 0, readyKinds: [] },
      report,
      save: () => {},
      delay: async () => {},
      inspect: async (root: string) => state.get(root) ?? null,
    });
    expect(report.attempts.map((a: { state: string }) => a.state)).toEqual([
      'held',
      'passed',
      'passed',
      'passed',
    ]);
    expect(report.attempts[0]!.workingCleared).toBe(true);
    expect(report.attempts[1]!.cancelled?.ts).toBeDefined();
    expect(posted[2]!.attachments).toEqual(value.steps[2]!.messageAttachments);
    // The stub suite takes no tools; the step kind that changed them is gone.
    expect(() => validateScenario({ ...value, requires: ['gitlab'] })).toThrow(
      'stub_scenario_needs_no_tools',
    );
    expect(() =>
      validateScenario({ ...value, steps: [{ ...value.steps[2], webSearch: { minSearches: 1 } }] }),
    ).toThrow('stub_scenario_needs_no_tools');
    for (const bad of [
      { ...value, steps: [value.steps[0]] },
      { ...value, steps: [value.steps[1]] },
      { ...value, steps: [value.steps[0], { ...value.steps[1], prompt: 'stop' }] },
      { ...value, steps: [{ ...value.steps[2], channelTools: { gitlab: 'unassign' } }] },
      { ...value, steps: [{ ...value.steps[2], messageAttachments: [{ text: '<@U1>' }] }] },
      { ...value, steps: [{ ...value.steps[0], contains: ['x'] }, value.steps[1]] },
      { ...value, model: 'gateway', steps: [{ prompt: 'x', contains: ['x'], discovery: false }] },
    ])
      expect(() => validateScenario(bad)).toThrow();
  });
  it('fails a step without a declared publication that published anyway', async () => {
    const text = 'answer';
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'chat.postMessage') return { ts: '1.1', channel: 'CTEST' };
      return { messages: [], response_metadata: { next_cursor: '' }, body };
    };
    await expect(
      runScenario({
        scenario: {
          name: 'discovery',
          mode: 'coding',
          covers: ['x discovery'],
          budget: { turns: 1, modelRequests: 4 },
          steps: [{ prompt: 'read only', contains: [text], discovery: true }],
        },
        slack,
        identity: { ...identity, assignedTools: 1, readyKinds: ['gitlab'] },
        report: { attempts: [] },
        save: () => {},
        delay: async () => {},
        inspect: async () => ({
          runId: 'r1',
          messageTs: '1.1',
          active: false,
          publications: [{ outcome: 'confirmed' }],
          delivery: {
            outcome: 'delivered',
            slack_ts: '1.2',
            operation_id: 'op',
            sha256: hash(text),
            bytes: 6,
          },
        }),
      }),
    ).rejects.toThrow('discovery_produced_external_artifacts');
  });
  it('refuses wrong sender and tool-enabled fixture before posting', async () => {
    for (const kind of ['sender', 'tools']) {
      let posts = 0;
      const slack = async (method: string) => {
        if (method === 'chat.postMessage') posts++;
        return method === 'auth.test'
          ? {
              team_id: 'TTEST',
              user_id: kind === 'sender' ? 'UOTHER' : 'USENDER',
              bot_id: 'BSENDER',
            }
          : {};
      };
      await expect(
        runScenario({
          scenario,
          slack,
          identity: { ...identity, assignedTools: kind === 'tools' ? 1 : 0 },
          report: { attempts: [] },
          save: () => {},
        }),
      ).rejects.toThrow();
      expect(posts).toBe(0);
    }
  });
});
it('matches canonical bold bullets with Slack-preserved paragraph breaks only by exact hash', () => {
  const text = 'Published.\n\n- **Report:** exact bytes\n\nVerified.';
  const section = (elements: unknown[]) => ({ type: 'rich_text_section', elements });
  const message = {
    ts: '1.2',
    user: 'UAPP',
    metadata: {
      event_type: 'support_agent_delivery',
      event_payload: { operation_id: 'op', answer: true },
    },
    blocks: [
      {
        type: 'rich_text',
        elements: [
          section([{ type: 'text', text: 'Published.\n\n' }]),
          {
            type: 'rich_text_list',
            style: 'bullet',
            elements: [
              section([
                { type: 'text', text: 'Report:', style: { bold: true } },
                { type: 'text', text: ' exact bytes' },
              ]),
            ],
          },
          section([{ type: 'text', text: '\nVerified.' }]),
        ],
      },
    ],
  };
  const delivery = {
    outcome: 'delivered',
    operation_id: 'op',
    slack_ts: '1.2',
    sha256: hash(text),
    bytes: Buffer.byteLength(text),
  };
  expect(assertAnswer([message], { delivery }, 'UAPP', { contains: ['exact bytes'] }).sha256).toBe(
    hash(text),
  );
  expect(() =>
    assertAnswer(
      [message],
      { delivery: { ...delivery, sha256: hash(text.replace('exact', 'other')) } },
      'UAPP',
      { contains: [] },
    ),
  ).toThrow('bytes_mismatch');
});

/** A synthetic Slack thread, app and settings service for the stub-only steps. */
function fakeWorld(
  options: {
    answer?: (text: string, world: ReturnType<typeof fakeWorld>, memory: string[]) => string | null;
    long?: (text: string) => string | null;
    answerEdits?: boolean;
  } = {},
) {
  let seq = 0;
  const threads = new Map<string, Array<Record<string, unknown>>>();
  // The app's thread memory: prompts and full answers as they were admitted.
  const memory = new Map<string, string[]>();
  const state = new Map<string, Record<string, unknown> | null>();
  const methods: string[] = [];
  const adminCalls: string[] = [];
  const files = new Map<string, Buffer>();
  const models: Record<string, string> = { fast: 'model-fast-1', deep: 'model-deep-2' };
  const settings = {
    enabled: true,
    model: null as string | null,
    prompt: 'Original channel prompt.' as string | null,
    blocked: [{ userId: 'UOTHER', displayName: 'Other' }] as Array<{
      userId: string;
      displayName: string;
    }>,
  };
  const effective = () => settings.model ?? 'fast';
  const world = {
    threads,
    memory,
    state,
    methods,
    adminCalls,
    settings,
    models,
    failRestore: false,
    admin: {
      unassign: async () => {},
      assign: async () => {},
      settings: async () => ({
        enabled: settings.enabled,
        model: settings.model,
        effectiveModel: effective(),
        keys: Object.keys(models),
        prompt: settings.prompt,
        fingerprint: `fp-${adminCalls.length}`,
        blocked: [...settings.blocked].sort((a, b) => a.userId.localeCompare(b.userId)),
      }),
      setEnabled: async (enabled: boolean) => {
        adminCalls.push(`enabled ${enabled}`);
        settings.enabled = enabled;
      },
      setModel: async (key: string | null, fingerprint: string) => {
        expect(fingerprint).toMatch(/^fp-/);
        adminCalls.push(`model ${key}`);
        settings.model = key;
      },
      setPrompt: async (text: string | null) => {
        if (world.failRestore && text === 'Original channel prompt.') throw Error('down');
        adminCalls.push(`prompt ${text}`);
        settings.prompt = text;
      },
      block: async (userId: string, displayName: string) => {
        adminCalls.push(`block ${userId}`);
        settings.blocked = [
          ...settings.blocked.filter((m) => m.userId !== userId),
          { userId, displayName },
        ];
      },
      unblock: async (userId: string) => {
        adminCalls.push(`unblock ${userId}`);
        settings.blocked = settings.blocked.filter((m) => m.userId !== userId);
      },
    },
    effective,
    slack: async (method: string, body: Record<string, unknown> = {}) => {
      methods.push(method);
      if (method === 'auth.test')
        return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
      if (method === 'conversations.replies')
        return { messages: threads.get(String(body.ts)) ?? [], response_metadata: {} };
      if (method === 'files.info') {
        const bytes = files.get(String(body.file))!;
        return {
          file: {
            id: body.file,
            user: 'UAPP',
            name: 'answer.md',
            size: bytes.length,
            url_private_download: `https://files.slack.com/download/${body.file}`,
            shares: { private: { CTEST: [{ thread_ts: [...threads.keys()][0] }] } },
          },
        };
      }
      const find = () => {
        for (const [root, messages] of threads) {
          const index = messages.findIndex((m) => m.ts === body.ts);
          if (index >= 0) return { root, messages, index };
        }
        throw Error('missing message');
      };
      if (method === 'chat.update') {
        const { messages, index } = find();
        messages[index] = { ...messages[index], text: body.text, edited: { ts: 'e' } };
        if (options.answerEdits) messages.push({ ts: `${++seq}.7`, user: 'UAPP', text: 'x' });
        return { ok: true, ts: body.ts };
      }
      if (method === 'chat.delete') {
        const { root, messages, index } = find();
        if (body.ts === root)
          messages[index] = { ts: root, subtype: 'tombstone', user: 'USLACKBOT' };
        else messages.splice(index, 1);
        return { ok: true, ts: body.ts };
      }
      if (method !== 'chat.postMessage') throw Error(`unexpected ${method}`);
      const ts = `${++seq}.1`,
        root = String(body.thread_ts ?? ts),
        text = String(body.text);
      if (!threads.has(root)) threads.set(root, []);
      const messages = threads.get(root)!;
      messages.push({ ts, user: 'USENDER', bot_id: 'BSENDER', text });
      const rootDeleted = messages[0]?.subtype === 'tombstone';
      const refused =
        !settings.enabled || settings.blocked.some((m) => m.userId === 'USENDER') || rootDeleted;
      if (refused) {
        // Inspection is refused under current authority.
        if (!settings.enabled || rootDeleted) state.set(root, null);
        return { ts, channel: 'CTEST' };
      }
      if (text.includes('HOLD')) {
        state.set(root, { runId: `run-${seq}`, messageTs: ts, active: true, delivery: null });
        return { ts, channel: 'CTEST' };
      }
      const prompt = text.replace('<@UAPP> ', '');
      const remembered = memory.get(root) ?? [];
      const full = options.long?.(prompt) ?? options.answer?.(prompt, world, remembered) ?? prompt;
      memory.set(root, [...remembered, prompt, full]);
      const op = `op-${++seq}`,
        reply = `${seq}.9`;
      let shown = full;
      let resultFiles;
      let answerFile = null;
      if (full.length > 12_000) {
        const split = splitLongAnswer(full)!;
        shown = longAnswerMessage(split.preview, true);
        files.set('F0ANSWER', Buffer.from(full));
        resultFiles = [{ id: 'F0ANSWER', sha256: hash(full) }];
        answerFile = { attached: true, fileId: 'F0ANSWER', sha256: hash(full) };
      }
      state.set(root, {
        runId: `run-${seq}`,
        messageTs: ts,
        active: false,
        answerFile,
        delivery: {
          operation_id: op,
          outcome: 'delivered',
          slack_ts: reply,
          sha256: hash(full),
          bytes: Buffer.byteLength(full),
        },
      });
      messages.push({
        ts: reply,
        user: 'UAPP',
        text: shown.slice(0, 3_900),
        blocks: [
          { type: 'markdown', text: shown },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `✅ Done · Model: *${effective()}*` }],
          },
        ],
        metadata: {
          event_type: 'support_agent_delivery',
          event_payload: {
            operation_id: op,
            answer: true,
            ...(resultFiles ? { result_files: resultFiles } : {}),
          },
        },
      });
      return { ts, channel: 'CTEST' };
    },
    files: liveFileTransport('synthetic-sender', async (url: string | URL) => {
      const id = String(url).split('/').at(-1)!;
      return new Response(new Uint8Array(files.get(id)!));
    }),
  };
  return world;
}
/** The model stub's replies for the directives the shipped scenarios use. */
function stubReply(prompt: string, world: ReturnType<typeof fakeWorld>, memory: string[]) {
  const lines: string[] = [];
  for (const line of prompt.split('\n')) {
    if (line.startsWith('STUB_REPLY ')) lines.push(line.slice(11));
    if (line === 'STUB_MODEL') lines.push(`STUB_MODEL ${world.models[world.effective()]}`);
    if (line.startsWith('STUB_SYSTEM '))
      lines.push(
        world.settings.prompt?.includes('STUB-PROMPT-7f3a')
          ? 'STUB_SYSTEM STUB-PROMPT-7f3a'
          : 'STUB_NONE',
      );
    if (line.startsWith('STUB_RECALL ')) {
      const pattern = new RegExp(line.slice(12), 'g');
      const corpus = memory.join('\n');
      const found = [...new Set([...corpus.matchAll(pattern)].map((m) => m[0]))];
      lines.push(found.length ? `STUB_RECALL ${found.join('; ')}` : 'STUB_NONE');
    }
  }
  return lines.join('\n');
}
const stubScenario = (name: string) =>
  JSON.parse(fs.readFileSync(`tests/live/scenarios/stub/${name}`, 'utf8'));

describe('stub-suite steps', () => {
  it('edits and deletes only the sender own messages, records snapshots and sees no run', async () => {
    const world = fakeWorld({ answer: (p) => p.replace('reply ', '') + '-answer' });
    const value = {
      name: 'lifecycle',
      model: 'stub',
      steps: [
        { prompt: 'reply root', contains: ['root-answer'] },
        { edit: { step: 0, prompt: 'reply edited' }, settleSeconds: 6, excludes: ['edited'] },
        { prompt: 'HOLD reply held', wait: false },
        { delete: { step: 2 }, settleSeconds: 6, excludes: ['held-answer'] },
        { prompt: 'reply after', contains: ['after-answer'] },
        { delete: { step: 0 }, settleSeconds: 6 },
        { prompt: 'reply refused', refused: true, settleSeconds: 6 },
      ],
      isolation: { prompt: 'reply iso', contains: ['iso-answer'] },
    };
    expect(validateScenario(value)).toBe(value);
    const report: { attempts: Array<Record<string, unknown>> } = { attempts: [] };
    await runScenario({
      scenario: value,
      slack: world.slack,
      identity,
      report,
      save: () => {},
      delay: async () => {},
      inspect: async (root: string) => world.state.get(root) ?? null,
    });
    const a = report.attempts;
    expect(a.map((x) => x.state)).toEqual([
      'passed',
      'passed',
      'held',
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(a[1]).toMatchObject({
      change: 'edit',
      targetStep: 0,
      messageTs: a[0]!.messageTs,
      before: { sha256: hash('<@UAPP> reply root') },
      after: { sha256: hash('<@UAPP> reply edited') },
    });
    expect(a[3]).toMatchObject({ change: 'delete', targetStep: 2, after: { deleted: true } });
    expect(a[5]).toMatchObject({ change: 'delete', after: { deleted: true, tombstone: true } });
    expect(a[6]).toMatchObject({ refused: { ts: a[6]!.messageTs } });
    expect(world.methods.filter((m) => m === 'chat.update')).toHaveLength(1);
    expect(world.methods.filter((m) => m === 'chat.delete')).toHaveLength(2);
    // The app answering an edit fails the step.
    const answering = fakeWorld({ answer: (p) => p + '-answer', answerEdits: true });
    await expect(
      runScenario({
        scenario: { ...value, steps: value.steps.slice(0, 2) },
        slack: answering.slack,
        identity,
        report: { attempts: [] },
        save: () => {},
        delay: async () => {},
        inspect: async (root: string) => answering.state.get(root) ?? null,
      }),
    ).rejects.toThrow('changed_message_answered');
    for (const bad of [
      { ...value, model: 'gateway', covers: ['x y z'], budget: { turns: 9, modelRequests: 9 } },
      { ...value, steps: [value.steps[1]] },
      { ...value, steps: [value.steps[0], { delete: { step: 0 }, edit: value.steps[1]!.edit }] },
      { ...value, steps: [value.steps[0], { delete: { step: 0 } }, { delete: { step: 0 } }] },
      { ...value, steps: [value.steps[0], { edit: { step: 0, prompt: '<@U1> x' } }] },
      { ...value, steps: [value.steps[0], { delete: { step: 0 }, settleSeconds: 999 }] },
      { ...value, steps: [value.steps[2], { prompt: 'x', contains: ['x'] }] },
      { ...value, isolation: { delete: { step: 0 } } },
      { ...value, steps: [{ prompt: 'x', refused: true, contains: ['x'] }] },
    ])
      expect(() => validateScenario(bad)).toThrow();
  });

  it('refuses to change a message the sender did not post', async () => {
    const world = fakeWorld({ answer: (p) => p + '-answer' });
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      const result = await world.slack(method, body);
      if (method === 'conversations.replies')
        return {
          ...result,
          messages: (result.messages as Array<Record<string, unknown>>).map((m) =>
            m.user === 'USENDER' ? { ...m, user: 'UHUMAN' } : m,
          ),
        };
      return result;
    };
    await expect(
      runScenario({
        scenario: {
          name: 'x',
          model: 'stub',
          steps: [{ prompt: 'a', contains: ['a-answer'] }, { delete: { step: 0 } }],
          isolation: { prompt: 'b', contains: ['b'] },
        },
        slack,
        identity,
        report: { attempts: [] },
        save: () => {},
        delay: async () => {},
        inspect: async (root: string) => world.state.get(root) ?? null,
      }),
    ).rejects.toThrow('message_change_not_own');
    expect(world.methods).not.toContain('chat.delete');
  });

  it('runs the shipped channel settings scenario and restores the exact prior state', async () => {
    const world = fakeWorld({ answer: stubReply });
    const value = validateScenario(stubScenario('channel-settings.json'));
    const original = await world.admin.settings();
    const report: {
      attempts: Array<Record<string, unknown>>;
      channelSettings?: Record<string, unknown>;
    } = { attempts: [] };
    await runScenario({
      scenario: value,
      slack: world.slack,
      identity,
      report,
      save: () => {},
      admin: world.admin,
      models: world.models,
      delay: async () => {},
      inspect: async (root: string) => world.state.get(root) ?? null,
    });
    expect(world.adminCalls).toEqual([
      'enabled false',
      'enabled true',
      'block USENDER',
      'unblock USENDER',
      'model deep',
      'prompt Live stub scenario channel prompt STUB-PROMPT-7f3a.',
      'model null',
      'prompt Original channel prompt.',
    ]);
    const answers = report.attempts.map((x) => x.answer as { footer?: string } | undefined);
    expect(answers[3]?.footer).toContain('Model: *deep*');
    expect(report.attempts[1]).toMatchObject({ state: 'passed', refused: {} });
    expect(report.channelSettings).toMatchObject({ original, restored: true });
    expect(await world.admin.settings()).toMatchObject({
      enabled: true,
      model: null,
      prompt: 'Original channel prompt.',
      blocked: original.blocked,
    });
    // A failure after a change still restores; the run reports the failure.
    const failing = fakeWorld({
      answer: (p, w, m) => stubReply(p, w, m).replace('deep-2', 'wrong'),
    });
    const failed: { attempts: unknown[]; channelSettings?: Record<string, unknown> } = {
      attempts: [],
    };
    await expect(
      runScenario({
        scenario: value,
        slack: failing.slack,
        identity,
        report: failed,
        save: () => {},
        admin: failing.admin,
        models: failing.models,
        delay: async () => {},
        inspect: async (root: string) => failing.state.get(root) ?? null,
      }),
    ).rejects.toThrow('expected_answer_fact_missing');
    expect(failed.channelSettings).toMatchObject({ restored: true });
    expect(failing.settings).toMatchObject({ model: null, prompt: 'Original channel prompt.' });
    // An unconfirmed restore fails the run and names the original values.
    const stuck = fakeWorld({ answer: stubReply });
    stuck.failRestore = true;
    const unconfirmed: { attempts: unknown[]; channelSettings?: Record<string, unknown> } = {
      attempts: [],
    };
    await expect(
      runScenario({
        scenario: value,
        slack: stuck.slack,
        identity,
        report: unconfirmed,
        save: () => {},
        admin: stuck.admin,
        models: stuck.models,
        delay: async () => {},
        inspect: async (root: string) => stuck.state.get(root) ?? null,
      }),
    ).rejects.toThrow('channel_settings_restore_unconfirmed');
    expect(unconfirmed.channelSettings).toMatchObject({
      restored: false,
      restoreByHand: { prompt: 'Original channel prompt.', model: null, enabled: true },
    });
    // A single model key cannot prove a model change.
    const single = fakeWorld({ answer: stubReply });
    delete (single.models as Record<string, string>).deep;
    await expect(
      runScenario({
        scenario: value,
        slack: single.slack,
        identity,
        report: { attempts: [] },
        save: () => {},
        admin: single.admin,
        models: single.models,
        delay: async () => {},
        inspect: async (root: string) => single.state.get(root) ?? null,
      }),
    ).rejects.toThrow('alternate_model_required');
    for (const bad of [
      { ...value, model: 'gateway', covers: ['x y z'], budget: { turns: 9, modelRequests: 9 } },
      { ...value, steps: [{ ...value.steps[1], channelSettings: { enabled: true } }] },
      { ...value, steps: [{ ...value.steps[1], channelSettings: { model: 'deep' } }] },
      { ...value, steps: [{ ...value.steps[1], channelSettings: { prompt: '<@U1>' } }] },
      { ...value, steps: [{ ...value.steps[1], channelSettings: {} }] },
      { ...value, isolation: { ...value.isolation, channelSettings: { enabled: false } } },
    ])
      expect(() => validateScenario(bad)).toThrow();
    await expect(
      runScenario({
        scenario: value,
        slack: world.slack,
        identity,
        report: { attempts: [] },
        save: () => {},
      }),
    ).rejects.toThrow('missing_E2E_ADMIN_TOKEN');
  });

  it('runs the shipped message lifecycle scenario against the synthetic app', async () => {
    const world = fakeWorld({ answer: stubReply });
    const report: { attempts: Array<Record<string, unknown>> } = { attempts: [] };
    await runScenario({
      scenario: validateScenario(stubScenario('message-lifecycle.json')),
      slack: world.slack,
      identity,
      report,
      save: () => {},
      delay: async () => {},
      inspect: async (root: string) => world.state.get(root) ?? null,
    });
    expect(report.attempts.filter((x) => x.change).map((x) => x.change)).toEqual([
      'edit',
      'delete',
      'delete',
    ]);
  });

  it('checks a long answer preview, downloads answer.md and recalls past the limit', async () => {
    const long = (p: string) => (p === 'STUB_LONG 16000' ? longText(16000) : null);
    const world = fakeWorld({ long, answer: stubReply });
    const value = validateScenario(stubScenario('long-reply.json'));
    const report: { attempts: Array<{ answer?: Record<string, unknown> }> } = { attempts: [] };
    await runScenario({
      scenario: value,
      slack: world.slack,
      files: world.files,
      identity,
      report,
      save: () => {},
      delay: async () => {},
      inspect: async (root: string) => world.state.get(root) ?? null,
    });
    expect(report.attempts[0]!.answer).toMatchObject({
      file: { fileId: 'F0ANSWER', sha256: hash(longText(16000)) },
      footer: '✅ Done · Model: *fast*',
      long: { previewChars: expect.any(Number) },
    });
    expect(report.attempts[0]!.answer).not.toHaveProperty('preview');
    // Changed bytes, a missing file and a preview past the limit all fail.
    const bad = fakeWorld({ long, answer: stubReply });
    const transport = liveFileTransport('synthetic-sender', async () => new Response('changed'));
    await expect(
      runScenario({
        scenario: value,
        slack: bad.slack,
        files: transport,
        identity,
        report: { attempts: [] },
        save: () => {},
        delay: async () => {},
        inspect: async (root: string) => bad.state.get(root) ?? null,
      }),
    ).rejects.toThrow(/answer_file_(size|bytes)_mismatch/);
    const message = (prefix: string, files?: unknown) => ({
      ts: '1.9',
      user: 'UAPP',
      blocks: [{ type: 'markdown', text: `${prefix}Line 00001 of the long stub answer.` }],
      metadata: {
        event_type: 'support_agent_delivery',
        event_payload: {
          operation_id: 'op',
          answer: true,
          ...(files ? { result_files: files } : {}),
        },
      },
    });
    const inspection = {
      delivery: {
        operation_id: 'op',
        outcome: 'delivered',
        slack_ts: '1.9',
        sha256: 'a'.repeat(64),
        bytes: 9,
      },
      answerFile: { attached: true, fileId: 'F0ANSWER', sha256: 'a'.repeat(64) },
    };
    const files = [{ id: 'F0ANSWER', sha256: 'a'.repeat(64) }];
    expect(() =>
      assertAnswer([message('x ')], inspection, 'UAPP', { contains: [], longAnswer: {} }),
    ).toThrow('answer_file_not_attached');
    expect(() =>
      assertAnswer([message('x ', files)], inspection, 'UAPP', { contains: [] }),
    ).toThrow('unexpected_answer_file');
    expect(() =>
      assertAnswer([message('x ', files)], { ...inspection, answerFile: null }, 'UAPP', {
        contains: [],
        longAnswer: {},
      }),
    ).toThrow('answer_file_identity_mismatch');
    expect(() =>
      assertAnswer([message('x ', files)], inspection, 'UAPP', {
        contains: [],
        longAnswer: { previewExcludes: ['Line 00001'] },
      }),
    ).toThrow('forbidden_preview_fact_present');
    const full = longText(16000);
    const answer = { preview: `Notice without the file name.\n\n${full.slice(0, 2000)}` };
    expect(() => assertLongAnswer(answer, full, { contains: [] })).toThrow(
      'answer_preview_mismatch',
    );
    expect(() =>
      assertLongAnswer({ preview: longAnswerMessage(full.slice(5, 2000), true) }, full, {
        contains: [],
      }),
    ).toThrow('answer_preview_mismatch');
    expect(
      assertLongAnswer({ preview: longAnswerMessage(full.slice(0, 2000), true) }, full, {
        contains: ['STUB_LONG_END 16000'],
      }),
    ).toMatchObject({ previewChars: expect.any(Number) });
  });
});

/** A synthetic settings service: the channel's assignment and the workspace's
 * existing instances. It never holds or returns a credential. */
function fakeTools(
  initial: Record<string, string>,
  instances: Array<{ id: string; kind: string; host?: string; ready: boolean }>,
) {
  const assignment: Record<string, string> = { ...initial };
  const calls: string[] = [];
  const admin = {
    failAssign: false,
    assignment: async () =>
      Object.fromEntries(
        Object.entries(assignment).map(([kind, id]) => [
          kind,
          {
            instanceId: id,
            label: `label ${id}`,
            ready: instances.find((i) => i.id === id)?.ready ?? false,
          },
        ]),
      ),
    instances: async () => instances.map((i) => ({ host: null, label: i.id, ...i })),
    assign: async (kind: string, id: string) => {
      if (admin.failAssign) throw Error('settings service down');
      calls.push(`assign ${kind} ${id}`);
      assignment[kind] = id;
    },
    unassign: async (kind: string) => {
      calls.push(`unassign ${kind}`);
      delete assignment[kind];
    },
  };
  return { admin, assignment, calls };
}
/** A synthetic app that answers each mention with `reply(text, tools)`. */
function answeringApp(reply: (text: string) => string) {
  let seq = 0;
  const state = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, Array<Record<string, unknown>>>();
  const posted: string[] = [];
  const slack = async (method: string, body: Record<string, unknown> = {}) => {
    if (method === 'auth.test') return { team_id: 'TTEST', user_id: 'USENDER', bot_id: 'BSENDER' };
    if (method === 'conversations.replies')
      return { messages: threads.get(String(body.ts)) ?? [], response_metadata: {} };
    if (method !== 'chat.postMessage') throw Error(`unexpected ${method}`);
    const ts = `${++seq}.1`,
      root = String(body.thread_ts ?? ts),
      text = String(body.text);
    posted.push(text);
    const answer = reply(text);
    const op = `op-${seq}`;
    state.set(root, {
      runId: `run-${seq}`,
      messageTs: ts,
      active: false,
      delivery: {
        operation_id: op,
        outcome: 'delivered',
        slack_ts: `${seq}.9`,
        sha256: hash(answer),
        bytes: Buffer.byteLength(answer),
      },
    });
    threads.set(root, [
      ...(threads.get(root) ?? []),
      { ts, user: 'USENDER', text },
      {
        ts: `${seq}.9`,
        user: 'UAPP',
        text: answer,
        metadata: {
          event_type: 'support_agent_delivery',
          event_payload: { operation_id: op, answer: true },
        },
      },
    ]);
    return { ts, channel: 'CTEST' };
  };
  return { slack, posted, inspect: async (root: string) => state.get(root) ?? null };
}
describe('driver-managed tools, tool scopes and the model mode switch', () => {
  const answer = (text: string) => (text.includes('isolated') ? 'empty' : 'alpha');
  const gitlabInstances = [
    { id: 'ti_gitlab', kind: 'gitlab', host: 'gitlab.test.invalid', ready: true },
    { id: 'ti_search', kind: 'webSearch', ready: true },
    { id: 'ti_jira', kind: 'atlassian', ready: false },
  ];

  it('derives each shipped scenario needed tools and picks exactly one ready instance per kind', () => {
    const needs = (file: string) =>
      neededTools(JSON.parse(fs.readFileSync(`tests/live/scenarios/${file}`, 'utf8')));
    expect(needs('answer-continuity.json')).toEqual([]);
    expect(needs('stub/channel-settings.json')).toEqual([]);
    expect(needs('thread-followup.json')).toEqual(['gitlab']);
    expect(needs('coding-files.json')).toEqual(['gitlab']);
    expect(needs('gitlab-discovery.json')).toEqual(['gitlab']);
    expect(needs('web-search.json')).toEqual(['webSearch']);
    expect(needs('web-fetch.json')).toEqual(['webFetch']);
    expect(needs('service-tools.json')).toEqual(['atlassian', 'datadog', 'cloudflare', 'slack']);
    const two = [
      ...gitlabInstances,
      { id: 'ti_other', kind: 'gitlab', host: 'gitlab.other.invalid', ready: true },
      { id: 'ti_search2', kind: 'webSearch', ready: true },
    ];
    // GitLab: the instance on the scenario's host.
    expect(toolTarget(['gitlab'], two, {}, 'gitlab.test.invalid')).toEqual({
      gitlab: 'ti_gitlab',
    });
    expect(() => toolTarget(['gitlab'], two, {}, 'gitlab.none.invalid')).toThrow(
      'ready_gitlab_instance_required',
    );
    expect(() => toolTarget(['gitlab'], two, {}, null)).toThrow('ambiguous_gitlab_instance');
    // Not ready counts as missing; two ready ones are ambiguous unless the
    // channel already has one of them.
    expect(() => toolTarget(['atlassian'], two, {}, null)).toThrow(
      'ready_atlassian_instance_required',
    );
    expect(() => toolTarget(['webSearch'], two, {}, null)).toThrow('ambiguous_webSearch_instance');
    expect(
      toolTarget(['webSearch'], two, { webSearch: { instanceId: 'ti_search2' } }, null),
    ).toEqual({ webSearch: 'ti_search2' });
    expect(toolTarget([], two, { gitlab: { instanceId: 'ti_gitlab' } }, null)).toEqual({});
  });

  it('unassigns every tool for an answer scenario and restores the exact original', async () => {
    const original = {
      gitlab: 'ti_gitlab',
      atlassian: 'ti_jira',
      codeMode: 'ti_code',
      files: 'ti_files',
      localExec: 'ti_exec',
    };
    const tools = fakeTools(original, gitlabInstances);
    const app = answeringApp(answer);
    const report: Record<string, unknown> & { attempts: unknown[] } = { attempts: [] };
    let duringRun: Record<string, string> | undefined;
    await runScenario({
      scenario,
      slack: async (method: string, body?: Record<string, unknown>) => {
        if (method === 'chat.postMessage') duringRun ??= { ...tools.assignment };
        return app.slack(method, body);
      },
      // The channel as it is would block: the identity read saw tools.
      identity: { ...identity, assignedTools: 5, readyKinds: ['gitlab'] },
      report,
      save: () => {},
      admin: tools.admin,
      manageTools: true,
      delay: async () => {},
      inspect: app.inspect,
    });
    expect(duringRun).toEqual({});
    expect(tools.calls).toEqual([
      'unassign gitlab',
      'unassign atlassian',
      'unassign codeMode',
      'unassign files',
      'unassign localExec',
      'assign gitlab ti_gitlab',
      'assign atlassian ti_jira',
      'assign codeMode ti_code',
      'assign files ti_files',
      'assign localExec ti_exec',
    ]);
    expect(tools.assignment).toEqual(original);
    expect(report.toolAssignment).toMatchObject({
      needs: [],
      target: {},
      applied: {},
      state: 'applied',
      original: {
        gitlab: { instanceId: 'ti_gitlab', ready: true },
        atlassian: { instanceId: 'ti_jira', ready: false },
      },
      restored: true,
      restoredState: { gitlab: { instanceId: 'ti_gitlab' }, atlassian: { instanceId: 'ti_jira' } },
    });
    expect(JSON.stringify(report)).not.toMatch(/credential|token|secret/i);
  });

  it('assigns the needed instances and restores after a failure', async () => {
    const tools = fakeTools({ webSearch: 'ti_search' }, gitlabInstances);
    // A gateway tool scenario: the stub suite takes no tools.
    const value = validateScenario({
      ...scenario,
      name: 'gitlab reads',
      mode: 'coding',
      requires: ['gitlab'],
      isolation: undefined,
      steps: [
        { prompt: 'read the project', contains: ['42'], discovery: true },
        { prompt: 'read it again', contains: ['42'], discovery: true },
      ],
    });
    const app = answeringApp(() => (tools.assignment.gitlab ? 'project 42' : 'no GitLab'));
    const seen: Array<Record<string, string>> = [];
    const report: Record<string, unknown> & { attempts: unknown[] } = { attempts: [] };
    await runScenario({
      scenario: value,
      slack: async (method: string, body?: Record<string, unknown>) => {
        if (method === 'chat.postMessage') seen.push({ ...tools.assignment });
        return app.slack(method, body);
      },
      identity: { ...identity, assignedTools: 1, readyKinds: ['webSearch'] },
      report,
      save: () => {},
      admin: tools.admin,
      manageTools: true,
      gitlabHost: 'gitlab.test.invalid',
      delay: async () => {},
      inspect: app.inspect,
    });
    // GitLab only: the web search instance is unassigned for the scenario.
    expect(seen).toEqual([{ gitlab: 'ti_gitlab' }, { gitlab: 'ti_gitlab' }]);
    expect(tools.assignment).toEqual({ webSearch: 'ti_search' });
    expect(report).not.toHaveProperty('channelTools');
    expect(report.toolAssignment).toMatchObject({
      target: { gitlab: 'ti_gitlab' },
      restored: true,
    });
    // A failing step still restores the original assignment.
    const failing = answeringApp(() => 'no GitLab');
    const failed: Record<string, unknown> & { attempts: unknown[] } = { attempts: [] };
    await expect(
      runScenario({
        scenario: value,
        slack: failing.slack,
        identity,
        report: failed,
        save: () => {},
        admin: tools.admin,
        manageTools: true,
        gitlabHost: 'gitlab.test.invalid',
        delay: async () => {},
        inspect: failing.inspect,
      }),
    ).rejects.toThrow('expected_answer_fact_missing');
    expect(tools.assignment).toEqual({ webSearch: 'ti_search' });
    expect(failed.toolAssignment).toMatchObject({ restored: true });
  });

  it('blocks a missing or ambiguous instance before any change and never guesses', async () => {
    const service = {
      ...scenario,
      name: 'service',
      mode: 'coding',
      requires: ['atlassian'],
      isolation: undefined,
      steps: [{ prompt: 'read', contains: ['x'], discovery: true }],
    };
    for (const [instances, code] of [
      [gitlabInstances, 'ready_atlassian_instance_required'],
      [
        [
          { id: 'ti_a1', kind: 'atlassian', ready: true },
          { id: 'ti_a2', kind: 'atlassian', ready: true },
        ],
        'ambiguous_atlassian_instance',
      ],
    ] as const) {
      const tools = fakeTools({ gitlab: 'ti_gitlab' }, [...instances]);
      const app = answeringApp(() => 'x');
      const report: Record<string, unknown> & { attempts: unknown[] } = { attempts: [] };
      const error = await runScenario({
        scenario: validateScenario(service),
        slack: app.slack,
        identity,
        report,
        save: () => {},
        admin: tools.admin,
        manageTools: true,
        delay: async () => {},
        inspect: app.inspect,
      }).catch((e: Error & { blocked?: boolean }) => e);
      expect(error).toMatchObject({ message: code, blocked: true });
      expect(tools.calls).toEqual([]);
      expect(app.posted).toEqual([]);
      expect(report.toolAssignment).toMatchObject({ state: 'read' });
      expect(report.toolAssignment).not.toHaveProperty('restored');
    }
    // Managing tools needs the token.
    await expect(
      runScenario({
        scenario,
        slack: answeringApp(answer).slack,
        identity,
        report: { attempts: [] },
        save: () => {},
        manageTools: true,
      }),
    ).rejects.toThrow('missing_E2E_ADMIN_TOKEN');
  });

  it('fails with a by-hand list when the restore cannot be confirmed, and restores after an interrupt', async () => {
    const tools = fakeTools({ gitlab: 'ti_gitlab' }, gitlabInstances);
    const app = answeringApp(answer);
    const report: Record<string, unknown> & { attempts: unknown[] } = { attempts: [] };
    await expect(
      runScenario({
        scenario,
        slack: async (method: string, body?: Record<string, unknown>) => {
          // The settings service fails after the managed change.
          if (method === 'chat.postMessage') tools.admin.failAssign = true;
          return app.slack(method, body);
        },
        identity,
        report,
        save: () => {},
        admin: tools.admin,
        manageTools: true,
        delay: async () => {},
        inspect: app.inspect,
      }),
    ).rejects.toThrow('channel_tool_restore_unconfirmed');
    expect(report.toolAssignment).toMatchObject({
      restored: false,
      restoreByHand: {
        assign: [{ kind: 'gitlab', instanceId: 'ti_gitlab', label: 'label ti_gitlab' }],
        unassign: [
          'atlassian',
          'datadog',
          'cloudflare',
          'slack',
          'webSearch',
          'webFetch',
          'codeMode',
          'files',
          'localExec',
        ],
      },
    });
    // An interrupt during a wait ends the scenario; the original comes back.
    const restored = fakeTools({ gitlab: 'ti_gitlab' }, gitlabInstances);
    const controller = new AbortController();
    const pending = answeringApp(answer);
    const interrupted: Record<string, unknown> & { attempts: unknown[] } = { attempts: [] };
    const error = await runScenario({
      scenario,
      slack: pending.slack,
      identity,
      report: interrupted,
      save: () => {},
      admin: restored.admin,
      manageTools: true,
      signal: controller.signal,
      // The app never answers; the operator interrupts during the wait.
      inspect: async () => null,
      delay: () => {
        controller.abort();
        return new Promise(() => {});
      },
    }).catch((e: Error & { blocked?: boolean }) => e);
    expect(error).toMatchObject({ message: 'interrupted', blocked: false });
    expect(restored.calls).toEqual(['unassign gitlab', 'assign gitlab ti_gitlab']);
    expect(interrupted.toolAssignment).toMatchObject({ restored: true });
    expect(pending.posted).toHaveLength(1);
  });

  it('manages tools only with E2E_ADMIN_TOKEN and checks the channel as it is without it', async () => {
    const { root, env, write } = fixture();
    write('.env.testing', {
      ...env,
      COMPOSE_PROJECT_NAME: `native-tools-${randomUUID().slice(0, 8)}`,
    });
    const seen: Array<Record<string, unknown>> = [];
    const deps = {
      services: () =>
        ['native-answer', 'native-postgres', 'adapter'].map((service) => ({
          service,
          running: true,
          image: 'sha256:same',
        })),
      status: () => ({ idle: true, waits: [] }),
      delay: async () => {},
      nativeRead: (d: { modelMode?: string }, op: string, body: { runIds?: string[] }) =>
        mockModelRead(d, op, body, 2),
      adminClient: (options: Record<string, unknown>) => ({ options }),
      runScenario: async (
        options: Record<string, unknown> & { report: { attempts: unknown[] } },
      ) => {
        seen.push(options);
        options.report.attempts.push({ runId: 'r1' });
      },
    };
    const args = [
      '--instance-dir',
      root,
      '--scenario',
      root + '/scenario.json',
      '--run',
      '--gateway-ready',
    ];
    expect(await main(args, deps)).toBe(0);
    expect(seen[0]).toMatchObject({ manageTools: false });
    expect(seen[0]!.admin).toBeUndefined();
    write('.env.e2e', {
      E2E_SLACK_SENDER_TOKEN: 'synthetic-sender',
      E2E_SLACK_TEAM_ID: 'TTEST',
      E2E_SLACK_CHANNEL_ID: 'CTEST',
      E2E_ADMIN_TOKEN: 'synthetic-admin-api',
      E2E_GITLAB_HOST: 'gitlab.test.invalid',
    });
    expect(await main(args, deps)).toBe(0);
    expect(seen[1]).toMatchObject({
      manageTools: true,
      gitlabHost: 'gitlab.test.invalid',
      admin: { options: { teamId: 'TTEST', channelId: 'CTEST' } },
    });
    // The token never enters a report.
    for (const id of fs.readdirSync(root + '/artifacts/native-live').filter((n) => n !== 'passed'))
      expect(
        fs.readFileSync(`${root}/artifacts/native-live/${id}/report.json`, 'utf8'),
      ).not.toContain('synthetic-admin-api');
  });

  it('reads the exact assignment and the instances through the settings API without credentials', async () => {
    const requests: string[] = [];
    const admin = adminClient(
      {
        origin: 'https://admin.test.invalid',
        token: 'synthetic-api',
        teamId: 'TTEST',
        channelId: 'CTEST',
      },
      async (url: URL | string, init: RequestInit) => {
        requests.push(`${init.method} ${String(url)}`);
        expect(init.headers).toMatchObject({ authorization: 'Bearer synthetic-api' });
        return new Response(
          JSON.stringify(
            String(url).endsWith('/channels/CTEST/tools')
              ? {
                  tools: [
                    { kind: 'gitlab', instanceId: 'ti_gitlab', label: 'GitLab', ready: true },
                    { kind: 'localExec', instanceId: 'ti_exec', label: 'Exec', ready: true },
                  ],
                }
              : {
                  instances: [
                    {
                      id: 'ti_gitlab',
                      kind: 'gitlab',
                      host: 'gitlab.test.invalid',
                      ready: true,
                      hasCredential: true,
                      settings: { x: 1 },
                    },
                    { id: 'ti_jira', kind: 'atlassian', host: 'x.atlassian.net', ready: false },
                  ],
                },
          ),
        );
      },
    );
    expect(await admin.assignment()).toEqual({
      gitlab: { instanceId: 'ti_gitlab', label: 'GitLab', ready: true },
      localExec: { instanceId: 'ti_exec', label: 'Exec', ready: true },
    });
    expect(await admin.instances()).toEqual([
      { id: 'ti_gitlab', kind: 'gitlab', label: '', host: 'gitlab.test.invalid', ready: true },
      { id: 'ti_jira', kind: 'atlassian', label: '', host: 'x.atlassian.net', ready: false },
    ]);
    expect(requests).toEqual([
      'GET https://admin.test.invalid/api/installations/TTEST/channels/CTEST/tools',
      'GET https://admin.test.invalid/api/installations/TTEST/tools',
    ]);
    // A settings service without its readiness field is refused, not read as "not ready".
    const old = adminClient(
      {
        origin: 'https://admin.test.invalid',
        token: 'synthetic-api',
        teamId: 'TTEST',
        channelId: 'CTEST',
      },
      async () =>
        new Response(JSON.stringify({ instances: [{ id: 'ti_gitlab', kind: 'gitlab' }] })),
    );
    await expect(old.instances()).rejects.toThrow('tool_instances_unreadable');
  });

  it('selects scenarios by --tools and lists the others as not_selected', async () => {
    const { root, env, write } = fixture();
    write('.env.testing', {
      ...env,
      COMPOSE_PROJECT_NAME: `native-scope-${randomUUID().slice(0, 8)}`,
    });
    const repo = root + '/repo';
    const folder = repo + '/tests/live/scenarios';
    fs.mkdirSync(folder, { recursive: true });
    const tool = (name: string, extra: Record<string, unknown>) => ({
      name,
      mode: 'coding',
      covers: [`${name} flow`],
      budget: { turns: 1, modelRequests: 4 },
      ...extra,
    });
    fs.writeFileSync(folder + '/a.json', JSON.stringify(scenario));
    fs.writeFileSync(
      folder + '/b.json',
      JSON.stringify(
        tool('gitlab read', {
          requires: ['gitlab'],
          steps: [{ prompt: 'read', contains: ['x'], discovery: true }],
        }),
      ),
    );
    fs.writeFileSync(
      folder + '/c.json',
      JSON.stringify(
        tool('search', {
          steps: [{ prompt: 'search', contains: ['x'], webSearch: { minSearches: 1 } }],
        }),
      ),
    );
    const ran: string[] = [];
    const deps = {
      repo,
      services: () =>
        ['native-answer', 'native-postgres', 'adapter'].map((service) => ({
          service,
          running: true,
          image: 'sha256:same',
        })),
      status: () => ({ idle: true, waits: [] }),
      delay: async () => {},
      nativeRead: (d: { modelMode?: string }, op: string, body: { runIds?: string[] }) =>
        mockModelRead(d, op, body, 1),
      runScenario: async ({
        scenario: s,
        report,
      }: {
        scenario: { name: string };
        report: { attempts: unknown[] };
      }) => {
        ran.push(s.name);
        report.attempts.push({ runId: `r${ran.length}` });
      },
    };
    const latest = () => {
      const dir = root + '/artifacts/native-live';
      return fs
        .readdirSync(dir)
        .filter((n) => n.startsWith('suite-'))
        .map((n) => JSON.parse(fs.readFileSync(`${dir}/${n}/summary.json`, 'utf8')))
        .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
        .at(-1);
    };
    const suite = [
      '--instance-dir',
      root,
      '--suite',
      'gateway',
      '--run',
      '--gateway-ready',
      '--rerun',
    ];
    expect(await main([...suite, '--tools', 'none'], deps)).toBe(0);
    expect(ran).toEqual([scenario.name]);
    expect(latest()).toMatchObject({
      tools: 'none',
      outcome: 'passed',
      counts: { passed: 1, not_selected: 2 },
      scenarios: [
        { outcome: 'passed' },
        {
          outcome: 'not_selected',
          reason: 'tools_outside_scope',
          needs: ['gitlab'],
          name: 'gitlab read',
        },
        { outcome: 'not_selected', reason: 'tools_outside_scope', needs: ['webSearch'] },
      ],
    });
    expect(await main([...suite, '--tools', 'webSearch,gitlab'], deps)).toBe(0);
    expect(latest()).toMatchObject({
      tools: ['gitlab', 'webSearch'],
      counts: { passed: 3, not_selected: 0 },
    });
    expect(await main([...suite, '--tools', 'gitlab'], deps)).toBe(0);
    expect(latest().scenarios.map((s: { outcome: string }) => s.outcome)).toEqual([
      'passed',
      'passed',
      'not_selected',
    ]);
    expect(await main(suite, deps)).toBe(0);
    expect(latest()).toMatchObject({ tools: 'all', counts: { passed: 3 } });
    // A scope without any scenario is blocked, not passed.
    fs.rmSync(folder + '/a.json');
    expect(await main([...suite, '--tools', 'none'], deps)).toBe(2);
    expect(latest()).toMatchObject({ outcome: 'blocked', reason: 'no_scenario_in_tool_scope' });
    await expect(main([...suite, '--tools', 'jira'], deps)).rejects.toThrow('--tools');
    await expect(
      main(['--instance-dir', root, '--scenario', folder + '/b.json', '--tools', 'none'], deps),
    ).rejects.toThrow('--suite only');
  });

  /** A fake `docker` for the real `test-stack.mjs`: records every call and
   * fails `stop` in stub mode while `fail-stub-stop` exists. */
  function stackFixture() {
    const f = fixture();
    f.write('.env.testing', {
      ...f.env,
      COMPOSE_PROJECT_NAME: `native-mode-${randomUUID().slice(0, 8)}`,
    });
    const bin = f.root + '/bin';
    fs.mkdirSync(bin);
    fs.writeFileSync(bin + '/package.json', '{"type":"commonjs"}');
    fs.writeFileSync(
      f.root + '/services.json',
      JSON.stringify([
        {
          Id: 'owned',
          Config: { Labels: { 'com.docker.compose.service': 'native-answer' } },
          State: { Running: true },
        },
      ]),
    );
    fs.writeFileSync(
      bin + '/docker',
      `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),root=path.dirname(__dirname),a=process.argv.slice(2);
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify(a)+String.fromCharCode(10));
if(a.includes('stop')&&a.includes('--profile')&&fs.existsSync(root+'/fail-stub-stop'))process.exit(1);
if(a[0]==='ps')console.log('owned');
else if(a[0]==='inspect')console.log(fs.readFileSync(root+'/services.json','utf8'));
else if(a.includes('exec'))console.log(JSON.stringify({runtime:'native-answer',idle:true,admitted:0,waits:[]}));
`,
      { mode: 0o755 },
    );
    const repo = f.root + '/repo';
    fs.mkdirSync(repo + '/tests/live/scenarios/stub', { recursive: true });
    fs.writeFileSync(`${repo}/tests/live/scenarios/gateway.json`, JSON.stringify(scenario));
    for (const name of ['a', 'b'])
      fs.writeFileSync(
        `${repo}/tests/live/scenarios/stub/${name}.json`,
        JSON.stringify({ ...scenario, name: `stub ${name}`, model: 'stub' }),
      );
    const modes: string[] = [];
    const deps = {
      repo,
      services: () =>
        ['native-answer', 'native-postgres', 'adapter', 'model-stub'].map((service) => ({
          service,
          running: true,
          image: 'sha256:same',
        })),
      status: () => ({ idle: true, waits: [] }),
      delay: async () => {},
      nativeRead: (d: { modelMode?: string }, op: string, body: { runIds?: string[] }) =>
        mockModelRead(d, op, body, 1),
      runScenario: async ({ report }: { report: { attempts: unknown[] } }) => {
        modes.push(fs.readFileSync(f.root + '/model-mode', 'utf8').trim());
        report.attempts.push({ runId: `r${modes.length}` });
      },
    };
    const calls = () =>
      fs.existsSync(f.root + '/calls.jsonl')
        ? fs
            .readFileSync(f.root + '/calls.jsonl', 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as string[])
        : [];
    /** The stack commands as `stop`/`up` with or without the stub. */
    const steps = () =>
      calls()
        .filter((a) => a[0] === 'compose' && (a.includes('stop') || a.includes('up')))
        .map((a) =>
          a.includes('stop')
            ? `stop ${a.slice(a.indexOf('stop') + 1).join(' ')}`
            : `up${a.includes('model-stub') ? ' stub' : ' gateway'}`,
        );
    const summary = () => {
      const dir = f.root + '/artifacts/native-live';
      return fs
        .readdirSync(dir)
        .filter((n) => n.startsWith('suite-'))
        .map((n) => JSON.parse(fs.readFileSync(`${dir}/${n}/summary.json`, 'utf8')))
        .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
        .at(-1);
    };
    const withPath = async <T>(run: () => Promise<T>) => {
      const original = process.env.PATH;
      process.env.PATH = `${bin}:${original}`;
      try {
        return await run();
      } finally {
        process.env.PATH = original;
      }
    };
    return { ...f, deps, modes, calls, steps, summary, withPath };
  }

  it('blocks a mode mismatch without --switch-mode and names the flag', async () => {
    const s = stackFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const args = ['--instance-dir', s.root, '--suite', 'stub', '--run'];
      expect(await main(args, s.deps)).toBe(2);
      expect(s.summary()).toMatchObject({
        outcome: 'blocked',
        hint: expect.stringContaining('--switch-mode'),
        scenarios: [{ reason: 'stub_mode_required' }, { reason: 'stub_mode_required' }],
      });
      expect(log.mock.calls.flat().join('\n')).toContain('--switch-mode');
      expect(s.calls()).toEqual([]);
      await expect(
        main(['--instance-dir', s.root, '--suite', 'stub', '--switch-mode'], s.deps),
      ).rejects.toThrow('--switch-mode requires --run');
      // A switch to gateway mode needs the Gateway confirmation first.
      s.setMode('stub');
      expect(
        await main(
          ['--instance-dir', s.root, '--suite', 'gateway', '--run', '--switch-mode'],
          s.deps,
        ),
      ).toBe(2);
      expect(s.summary()).toMatchObject({ reason: 'gateway_availability_confirmation_required' });
      expect(s.calls()).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('switches the instance to stub mode for the suite and always restores gateway mode', async () => {
    const s = stackFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const args = [
        '--instance-dir',
        s.root,
        '--suite',
        'stub',
        '--run',
        '--switch-mode',
        '--rerun',
      ];
      expect(await s.withPath(() => main(args, s.deps))).toBe(0);
      expect(s.modes).toEqual(['stub', 'stub']);
      expect(fs.readFileSync(s.root + '/model-mode', 'utf8')).toBe('gateway\n');
      expect(s.steps()).toEqual([
        'stop adapter',
        'stop native-answer native-cli-runtime native-postgres admin egress',
        'up stub',
        'stop adapter',
        'stop native-answer model-stub native-cli-runtime native-postgres admin egress',
        'up gateway',
      ]);
      expect(s.summary()).toMatchObject({
        outcome: 'passed',
        modelModeSwitch: {
          from: 'gateway',
          to: 'stub',
          switched: true,
          restored: true,
          restoredMode: 'gateway',
        },
      });
      // In the needed mode already: no stack command.
      s.setMode('stub');
      const before = s.calls().length;
      expect(await s.withPath(() => main(args, s.deps))).toBe(0);
      expect(s.calls()).toHaveLength(before);
      expect(s.summary().modelModeSwitch).toEqual({ from: 'stub', to: 'stub', switched: false });
      // One scenario: the switch state goes into its report.
      s.setMode('gateway');
      const one = [
        '--instance-dir',
        s.root,
        '--scenario',
        `${s.root}/repo/tests/live/scenarios/stub/a.json`,
        '--run',
        '--switch-mode',
      ];
      expect(await s.withPath(() => main(one, s.deps))).toBe(0);
      const dir = s.root + '/artifacts/native-live';
      const reports = fs
        .readdirSync(dir)
        .filter((n) => !n.startsWith('suite-') && n !== 'passed')
        .map((n) => JSON.parse(fs.readFileSync(`${dir}/${n}/report.json`, 'utf8')))
        .filter((r) => r.modelModeSwitch);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        outcome: 'passed',
        modelMode: 'stub',
        modelModeSwitch: { switched: true, restored: true, restoredMode: 'gateway' },
      });
      expect(fs.readFileSync(s.root + '/model-mode', 'utf8')).toBe('gateway\n');
    } finally {
      log.mockRestore();
    }
  });

  it('restores the mode after an interrupt and exits non-zero when the restore fails', async () => {
    const s = stackFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const args = [
        '--instance-dir',
        s.root,
        '--suite',
        'stub',
        '--run',
        '--switch-mode',
        '--rerun',
      ];
      // An interrupt during the first scenario: the second never runs.
      const controller = new AbortController();
      const interrupted = {
        ...s.deps,
        signal: controller.signal,
        runScenario: async () => {
          s.modes.push('interrupted');
          controller.abort();
          throw new LiveError('interrupted');
        },
      };
      expect(await s.withPath(() => main(args, interrupted))).toBe(1);
      expect(s.modes).toEqual(['interrupted']);
      expect(s.summary()).toMatchObject({
        outcome: 'failed',
        reason: 'interrupted',
        interrupted: true,
        scenarios: [{ outcome: 'failed', reason: 'interrupted' }],
        modelModeSwitch: { restored: true, restoredMode: 'gateway' },
      });
      expect(fs.readFileSync(s.root + '/model-mode', 'utf8')).toBe('gateway\n');
      // `down` in stub mode fails (for example it cannot drain): the suite
      // passed, but the instance is left in stub mode and the exit is 1.
      fs.writeFileSync(s.root + '/fail-stub-stop', '');
      expect(await s.withPath(() => main(args, s.deps))).toBe(1);
      expect(s.summary()).toMatchObject({
        outcome: 'passed',
        modelModeSwitch: {
          switched: true,
          restored: false,
          leftIn: 'stub mode, intake stopped',
          restoreByHand: [
            `npm run test:stack:down -- --instance-dir ${s.root}`,
            `npm run test:stack:up -- --instance-dir ${s.root} --model-mode gateway`,
          ],
        },
      });
      const message = error.mock.calls.flat().join('\n');
      expect(message).toContain('MODEL MODE NOT RESTORED');
      expect(message).toContain('left in stub mode, intake stopped');
      expect(message).toContain(
        `npm run test:stack:up -- --instance-dir ${s.root} --model-mode gateway`,
      );
      expect(s.steps().at(-1)).toBe('stop adapter');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('step correlation and the idle wait', () => {
  it('accepts only the run of its own message after a refused inspection and a late admission', async () => {
    // channel-settings.json on support-agent-test: inspection was refused while the
    // sender was blocked, and step 4's run was admitted after the driver's
    // first look. The driver took step 1's delivered run for step 4's answer.
    const world = fakeWorld({ answer: stubReply });
    let late: { root: string; state: Record<string, unknown> | null | undefined } | undefined;
    let lag = 0;
    const slack = async (method: string, body: Record<string, unknown> = {}) => {
      const root = String(body.thread_ts ?? '');
      const before = world.state.get(root);
      const result = await world.slack(method, body);
      const after = world.state.get(root);
      if (method === 'chat.postMessage' && body.thread_ts && after && after !== before) {
        // Admitted only after two more inspections of the thread.
        late = { root, state: after };
        world.state.set(root, before ?? null);
        lag = 2;
      }
      return result;
    };
    const inspections: unknown[] = [];
    const inspect = async (root: string) => {
      const blocked = world.settings.blocked.some((m) => m.userId === 'USENDER');
      const current = !world.settings.enabled
        ? { refused: 'origin_revoked' }
        : blocked
          ? { refused: 'authorization_revoked' }
          : (() => {
              if (late?.root === root && lag-- <= 0) {
                world.state.set(root, late.state ?? null);
                late = undefined;
              }
              return world.state.get(root) ?? null;
            })();
      inspections.push(current);
      return current;
    };
    const report: { attempts: Array<Record<string, unknown>> } = { attempts: [] };
    await runScenario({
      scenario: validateScenario(stubScenario('channel-settings.json')),
      slack,
      identity,
      report,
      save: () => {},
      admin: world.admin,
      models: world.models,
      delay: async () => {},
      inspect,
    });
    const a = report.attempts;
    expect(a.map((x) => x.state)).toEqual(Array(6).fill('passed'));
    expect(inspections).toContainEqual({ refused: 'origin_revoked' });
    expect(inspections).toContainEqual({ refused: 'authorization_revoked' });
    // Step 4 is its own run, admitted for its own message, and on the changed model.
    expect(a[3]!.runId).not.toBe(a[0]!.runId);
    expect(new Set(a.map((x) => x.runId).filter(Boolean)).size).toBe(4);
    expect((a[3]!.answer as { footer: string }).footer).toContain('Model: *deep*');
    expect(a.some((x) => 'beforeRunId' in x)).toBe(false);
  });

  it('records a refused inspection and never reads it as an absent or earlier run', async () => {
    const world = fakeWorld({ answer: stubReply });
    const report: { attempts: Array<Record<string, unknown>> } = { attempts: [] };
    await expect(
      runScenario({
        scenario: { ...scenario, isolation: undefined, steps: [scenario.steps[0]] },
        slack: world.slack,
        identity,
        report,
        save: () => {},
        delay: async () => {},
        timeoutMs: 0,
        inspect: async () => ({ refused: 'authorization_revoked' }),
      }),
    ).rejects.toThrow('native_answer_timeout_no_retry');
    expect(report.attempts[0]).toMatchObject({
      state: 'waiting',
      inspectionRefused: 'authorization_revoked',
    });
    // A run without its request's message cannot be correlated.
    await expect(
      runScenario({
        scenario: { ...scenario, isolation: undefined, steps: [scenario.steps[0]] },
        slack: world.slack,
        identity,
        report: { attempts: [] },
        save: () => {},
        delay: async () => {},
        inspect: async (root: string) => {
          const current = { ...world.state.get(root) };
          delete current.messageTs;
          return current;
        },
      }),
    ).rejects.toThrow('native_inspection_message_identity_missing');
  });

  it('keeps an inspection refusal code and maps only a missing thread to no run', () => {
    const read = (output: string | Error) =>
      nativeRead(
        {},
        'inspect',
        { installationId: 'UAPP', teamId: 'TTEST', channelId: 'CTEST' },
        () => {
          if (output instanceof Error) throw output;
          return output;
        },
      );
    expect(read(JSON.stringify({ refused: 'thread_owner_required' }))).toBeNull();
    expect(read(JSON.stringify({ refused: 'authorization_revoked' }))).toEqual({
      refused: 'authorization_revoked',
    });
    expect(read(new Error('exit 1'))).toEqual({ refused: 'unavailable' });
    // The container program prints only the service's fixed refusal code.
    let code = '',
      argument = '';
    nativeRead(
      {},
      'inspect',
      { installationId: 'UAPP', teamId: 'TTEST', channelId: 'CTEST' },
      (_d: unknown, args: string[]) => {
        code = args[6]!;
        argument = args[7]!;
        return '{}';
      },
    );
    const run = (responses: Array<{ status: number; body: unknown }>) => {
      const prefix = `const r=${JSON.stringify(responses)};globalThis.fetch=async()=>{const x=r.shift();return {ok:x.status<300,status:x.status,json:async()=>x.body}};`;
      const p = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', prefix + code, argument],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            NATIVE_APPLICATION_PORT: '1',
            SERVICE_TOKEN: 'never-export-this',
          },
        },
      );
      expect(p.status, p.stderr).toBe(0);
      expect(p.stdout).not.toContain('never-export-this');
      return JSON.parse(p.stdout);
    };
    expect(run([{ status: 409, body: { error: 'authorization_revoked' } }])).toEqual({
      refused: 'authorization_revoked',
    });
    expect(run([{ status: 409, body: { error: 'Private https://detail' } }])).toEqual({
      refused: 'refused',
    });
    expect(
      run([
        { status: 200, body: { runId: 'r1', owner: 'o1' } },
        { status: 200, body: { runId: 'r1', messageTs: '1.1', active: false, private: 'x' } },
      ]),
    ).toEqual({ runId: 'r1', messageTs: '1.1', active: false, suspended: false });
  });

  it('waits for an earlier run to settle before a scenario and blocks after the bound', async () => {
    const { root, env, write } = fixture();
    write('.env.testing', {
      ...env,
      COMPOSE_PROJECT_NAME: `native-idle-${randomUUID().slice(0, 8)}`,
    });
    const repo = root + '/repo';
    const folder = repo + '/tests/live/scenarios';
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(folder + '/a.json', JSON.stringify(scenario));
    fs.writeFileSync(
      folder + '/b.json',
      JSON.stringify({ ...scenario, name: 'b', covers: ['other flow'] }),
    );
    let busy = 0;
    const waits: number[] = [];
    const deps = {
      repo,
      services: () =>
        ['native-answer', 'native-postgres', 'adapter'].map((service) => ({
          service,
          running: true,
          image: 'sha256:same',
        })),
      // The first scenario left work behind: busy for three checks.
      status: () => (busy-- > 0 ? { idle: false, admitted: 1, waits: [] } : { idle: true }),
      delay: async (ms: number) => {
        waits.push(ms);
      },
      nativeRead: (d: { modelMode?: string }, op: string, body: { runIds?: string[] }) =>
        mockModelRead(d, op, body, 2),
      runScenario: async ({ report }: { report: { attempts: unknown[] } }) => {
        report.attempts.push({ runId: `r${waits.length}` });
        busy = 3;
      },
    };
    const args = ['--instance-dir', root, '--suite', 'gateway', '--run', '--gateway-ready'];
    const summary = () => {
      const dir = fs
        .readdirSync(root + '/artifacts/native-live')
        .filter((n) => n.startsWith('suite-'))
        .map((n) => `${root}/artifacts/native-live/${n}/summary.json`)
        .sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs)
        .at(-1)!;
      return JSON.parse(fs.readFileSync(dir, 'utf8'));
    };
    const report = (entry: { report: string }) => JSON.parse(fs.readFileSync(entry.report, 'utf8'));
    expect(await main(args, deps)).toBe(0);
    const passed = summary();
    expect(passed.scenarios.map((x: { outcome: string }) => x.outcome)).toEqual([
      'passed',
      'passed',
    ]);
    expect(report(passed.scenarios[1]).idleWaitMs).toBe(15000);
    expect(waits.filter((ms) => ms === 5000)).toHaveLength(3);
    // Still busy after the bound: BLOCKED with the status it saw.
    busy = 0;
    deps.status = () => ({ idle: false, admitted: 1, waits: [] });
    waits.length = 0;
    expect(await main([...args, '--rerun'], deps)).toBe(2);
    const blocked = summary();
    expect(blocked.scenarios[0]).toMatchObject({
      outcome: 'blocked',
      reason: 'native_test_work_not_idle',
    });
    const first = report(blocked.scenarios[0]);
    expect(first.idleWaitMs).toBe(IDLE_WAIT_MS);
    expect(first.before).toMatchObject({ idle: false, admitted: 1 });
    expect(waits.filter((ms) => ms === 5000)).toHaveLength((IDLE_WAIT_MS / 5000) * 2);
  });
});
