/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic HTTP/Socket Mode wire fixture */
/** Runs inside the native-coding image (network none) for the `backup` and
 * `coding` suites of tests/integration/run-native.mjs. It starts the real
 * provision, application and adapter entrypoints, bundled from the current
 * source, against synthetic Slack, Gateway, settings and HTTPS Git peers. */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { renderChannelMemory } from '../../../apps/agent/src/contracts/channel-commands.js';
import { compileDocument } from '../../../apps/admin/src/compile.js';
import { backupScenario } from './native-answer-backup-scenario.js';
import { CODE_MODE_LIMITS } from '../../../apps/agent/src/mastra/tools/code-mode.js';
import { CODE_MODE_PROBES, codingDeploymentFixture } from './native-coding-deployment-fixture.js';
const repo = process.env.NATIVE_TEST_REPO!;
const root = process.env.NATIVE_TEST_ROOT!;
const socketDir = process.env.NATIVE_TEST_PG_SOCKET!;
const passwordPath = process.env.NATIVE_TEST_PASSWORD_FILE!;
for (const value of [repo, root, socketDir, passwordPath])
  assert(value && path.isAbsolute(value), 'native image fixture paths required');
const { WebSocketServer } = createRequire(path.join(repo, 'apps/slack/package.json'))('ws');
const { Pool } = createRequire(path.join(repo, 'apps/agent/package.json'))('pg');
// The driver bundles the current entrypoints and mounts them over the image's.
const native = '/app/apps/agent/dist/native';
const codingStore = '/var/lib/native-coding';
const phase = process.argv[2] ?? '';
const caseId = Date.now();
const tests: any[] = [],
  children: any[] = [];
const reports = `${root}/${phase}-${caseId}.json`;
const pool = new Pool({
  host: socketDir,
  user: 'native_answer',
  database: 'native_answer',
  max: 3,
  password: (await fs.readFile(passwordPath, 'utf8')).trim(),
});
async function check(name: string, work: () => Promise<unknown>) {
  try {
    tests.push({ name, status: 'pass', detail: await work() });
  } catch (error) {
    tests.push({
      name,
      status: 'fail',
      detail: error instanceof Error ? error.stack : String(error),
    });
  }
  await fs.writeFile(reports, JSON.stringify({ phase, tests }, null, 2));
  console.log(JSON.stringify(tests.at(-1)));
  if (tests.at(-1).status === 'fail') throw new Error(`failed ${name}`);
}
async function waitFor(work: () => Promise<any>, timeout = 30000): Promise<any> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await work();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `bounded fixture barrier expired: ${last instanceof Error ? last.message : 'no result'}`,
  );
}
async function launch(
  file: string,
  env: Record<string, string>,
  label: string,
  args: string[] = [],
) {
  const log = await fs.open(`${root}/${phase}-${caseId}-${label}.log`, 'wx');
  const child: any = spawn(process.execPath, [file, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', log.fd, log.fd],
  });
  child.done = new Promise((r) =>
    child.once('exit', (code: number | null, signal: string | null) => {
      void log.close();
      r({ code, signal });
    }),
  );
  children.push(child);
  return child;
}
async function stop(child: any) {
  if (child.exitCode === null) child.kill('SIGTERM');
  return child.done;
}
const secret = 'synthetic-service-token';
if (phase === 'provision') {
  const child = await launch(
    `${native}/provision.mjs`,
    { NATIVE_PG_SOCKET: socketDir, NATIVE_PG_PASSWORD_FILE: passwordPath },
    'maintenance',
  );
  await check('actual-maintenance-entrypoint-fresh-restricted-store', async () => {
    assert.equal((await child.done).code, 0);
    const tables = (
      await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='native_agents' ORDER BY tablename",
      )
    ).rows;
    assert.equal(tables.length, 6);
    await assert.rejects(pool.query('CREATE TABLE framework.forbidden_runtime_ddl(id int)'));
    await pool.query("UPDATE native_agents.publications SET outcome='confirmed' WHERE false");
    await assert.rejects(
      pool.query('UPDATE native_agents.publications SET project=project WHERE false'),
    );
    return {
      applicationTables: tables.length,
      runtimeDdl: 'refused',
      publicationWrite: 'receipt-columns-only',
    };
  });
  await pool.end();
  process.exit(0);
}
let revision = 1,
  blocked: string | undefined;
function document() {
  return compileDocument(revision, {
    installations: [
      {
        teamId: 'TASSEMBLED',
        teamName: 'Synthetic',
        botUserId: 'UBOT',
        botId: 'BBOT',
        status: 'whitelisted',
        trustedBotSender: null,
      },
    ],
    channels: [{ teamId: 'TASSEMBLED', channelId: 'CASSEMBLED', enabled: true }],
    blockedMembers: blocked
      ? [{ teamId: 'TASSEMBLED', channelId: 'CASSEMBLED', userId: blocked }]
      : [],
    toolInstances: [
      {
        id: 'ti_1150000000000001',
        teamId: 'TASSEMBLED',
        kind: 'gitlab',
        label: 'Synthetic GitLab',
        status: 'enabled',
        credentialVersion: 1,
        host: 'gitlab.synthetic.invalid',
        settings: {},
        hasCredential: true,
      },
    ],
    toolStatuses: [
      {
        instanceId: 'ti_1150000000000001',
        state: 'ready',
        detail: 'synthetic',
        credentialVersion: 1,
        reporter: 'fixture',
        toolsCount: 24,
        reportedAt: 1000,
      },
    ],
    channelTools: gitlabAssigned
      ? [
          {
            teamId: 'TASSEMBLED',
            channelId: 'CASSEMBLED',
            kind: 'gitlab',
            instanceId: 'ti_1150000000000001',
          },
        ]
      : [],
  } as never);
}
let gitlabAssigned = phase !== 'coding-compose';
// When the model starts and the agent returns the synchronous-loop probe.
const codeModeLoop: { started?: number; ended?: number } = {};
const codingPeer = await codingDeploymentFixture(root);
const exportFiles = new Map<string, any>();
const sources: any[] =
  phase === 'backup-restore' ? JSON.parse(await fs.readFile(`${root}/sources.json`, 'utf8')) : [];
const posts: any[] = [],
  ephemeral: any[] = [],
  reactions: any[] = [],
  gatewayRequests: any[] = [],
  reads: any[] = [],
  unexpected: string[] = [];
if (['coding-files-cold', 'coding-backup-source', 'coding-backup-restore'].includes(phase)) {
  const retained = JSON.parse(await fs.readFile(`${root}/coding-files-state.json`, 'utf8'));
  sources.push(...retained.sources);
  posts.push(...retained.posts);
  for (const [id, f] of retained.files) exportFiles.set(id, f);
  for (const [id, data] of retained.uploaded)
    codingPeer.uploaded.set(id, Buffer.from(data, 'base64'));
  if (phase === 'coding-backup-restore') {
    const question = JSON.parse(await fs.readFile(`${root}/coding-backup-question.json`, 'utf8'));
    sources.push(question.event);
  }
}
const acks = new Set<string>();
let socket: any,
  connections = 0,
  dropSend = false;
const sockets: any[] = [];
const server = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(Buffer.from(part));
  const bytes = Buffer.concat(parts).toString();
  const path = req.url!;
  const api = new URLSearchParams(bytes);
  const json = (value: unknown, status = 200) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (path === '/internal/config') {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const d = document();
    if (req.headers['if-none-match'] === `"${d.hash}"`) {
      res.writeHead(304).end();
      return;
    }
    res.setHeader('etag', `"${d.hash}"`);
    json(d);
    return;
  }
  if (path === '/internal/installations/TASSEMBLED/token') {
    json({ teamId: 'TASSEMBLED', botToken: 'xoxb-synthetic-local-only' });
    return;
  }
  if (path === '/internal/tool-instances/ti_1150000000000001/secret') {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers['x-support-agent-caller'], 'runner');
    json(codingPeer.secret);
    return;
  }
  if (
    path === '/internal/costs' ||
    path === '/internal/costs/batch' ||
    path.startsWith('/internal/costs/')
  ) {
    json({ ok: true });
    return;
  }
  if (path === '/internal/channel-commands/snapshot') {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const entries = [
      {
        id: 1,
        text: 'TRUSTED_ASSEMBLED_CHANNEL_MEMORY.',
        creator: 'UCONFIG',
        editor: 'UCONFIG',
        channelId: 'CASSEMBLED',
        threadTs: '1000000000.000001',
        messageTs: '1000000000.000001',
        createdAt: 1,
        lastConfirmedAt: 1,
      },
    ];
    const rendered = renderChannelMemory(entries);
    json({
      revision: 1,
      rendered,
      hash: createHash('sha256').update(rendered).digest('hex'),
      entries,
    });
    return;
  }
  if (path === '/internal/channel-commands/claim-receipt') {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.method, 'POST');
    json(null);
    return;
  }
  if (path === '/readyz') {
    json({
      service: 'cli-runtime',
      configVersion: revision,
      syncError: null,
      instances: [
        {
          instanceId: 'ti_1150000000000001',
          teamId: 'TASSEMBLED',
          kind: 'gitlab',
          label: 'Synthetic GitLab',
          credentialVersion: 1,
          state: 'ready',
          detail: 'synthetic',
          gitlab: {
            ready: true,
            host: 'gitlab.synthetic.invalid',
            contractVersion: 6,
          },
        },
      ],
    });
    return;
  }
  if (path === '/gitlab') {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const request = JSON.parse(bytes);
    reads.push(request);
    json(codingPeer.api(request));
    return;
  }
  if (path === '/api/auth.test') {
    json({ ok: true, team_id: 'TASSEMBLED', user_id: 'UBOT', bot_id: 'BBOT' });
    return;
  }
  if (path === '/api/apps.connections.open') {
    json({ ok: true, url: `ws://127.0.0.1:${port}/socket` });
    return;
  }
  if (path === '/api/conversations.members') {
    json({ ok: true, members: [...new Set(sources.map((s) => s.user))] });
    return;
  }
  if (path === '/api/conversations.info') {
    json({
      ok: true,
      channel: { is_ext_shared: false, is_pending_ext_shared: false, is_org_shared: false },
    });
    return;
  }
  if (path === '/api/conversations.replies') {
    json({ ok: true, messages: sources.filter((s) => (s.thread_ts ?? s.ts) === api.get('ts')) });
    return;
  }
  if (path === '/api/files.info') {
    json({
      ok: true,
      file:
        exportFiles.get(api.get('file')!) ??
        sources.flatMap((s) => s.files ?? []).find((f) => f.id === api.get('file')),
    });
    return;
  }
  if (path === '/api/files.getUploadURLExternal') {
    const id = `FOUTPUT${exportFiles.size + 1}`;
    exportFiles.set(id, {
      id,
      user: 'UBOT',
      name: api.get('filename'),
      size: Number(api.get('length')),
      permalink: `https://slack.com/files/${id}`,
    });
    json({ ok: true, file_id: id, upload_url: `https://files.slack.com/upload/${id}` });
    return;
  }
  if (path === '/api/files.completeUploadExternal') {
    const files = JSON.parse(api.get('files')!);
    for (const f of files) {
      assert(codingPeer.uploaded.has(f.id));
      exportFiles.get(f.id).shares = {
        private: { [api.get('channel_id')!]: [{ thread_ts: api.get('thread_ts') }] },
      };
    }
    if (phase === 'coding-files-unknown') res.destroy();
    else json({ ok: true, files });
    return;
  }
  if (path === '/api/users.info') {
    json({ ok: true, user: { team_id: 'TASSEMBLED' } });
    return;
  }
  if (path === '/api/reactions.add' || path === '/api/reactions.remove') {
    reactions.push({ operation: path.split('.').at(-1), ...Object.fromEntries(api) });
    json({ ok: true });
    return;
  }
  if (path === '/api/chat.postEphemeral') {
    ephemeral.push(Object.fromEntries(api));
    json({ ok: true, message_ts: `1794700000.${String(ephemeral.length).padStart(6, '0')}` });
    return;
  }
  if (path === '/api/chat.postMessage') {
    posts.push(Object.fromEntries(api));
    if (dropSend) {
      res.destroy();
      return;
    }
    json({
      ok: true,
      ts: `1794700001.${String(posts.length).padStart(6, '0')}`,
      message: { ts: `1794700001.${String(posts.length).padStart(6, '0')}` },
    });
    return;
  }
  if (path === '/v1/messages') {
    const body = JSON.parse(bytes);
    gatewayRequests.push(body);
    const prompt = JSON.stringify(body.messages);
    if (codeModeLoop.started && !codeModeLoop.ended && prompt.includes('TimeoutError'))
      codeModeLoop.ended = Date.now();
    assert(JSON.stringify(body.system).includes('TRUSTED_ASSEMBLED_CHANNEL_MEMORY'));
    const asked = prompt.includes('ASK_ASSEMBLED') && !prompt.includes('TARGET_ASSEMBLED');
    const read =
      prompt.includes('DISCOVER_ASSEMBLED') && !prompt.includes('ASSEMBLED_SERVICE_FACT');
    const codingPart = codingPeer.response(body);
    if (codingPart && 'input' in codingPart && codingPart.name === 'execute_typescript')
      if ((codingPart.input as { code: string }).code === CODE_MODE_PROBES.at(-1))
        codeModeLoop.started = Date.now();
    const content = codingPart
      ? [codingPart]
      : asked
        ? [
            {
              type: 'tool_use',
              id: 'ask-assembled',
              name: 'ask_user',
              input: { question: 'Which assembled target?' },
            },
          ]
        : read
          ? [
              {
                type: 'tool_use',
                id: `read-assembled-${gatewayRequests.length}`,
                name: body.tools.some((t: any) => t.name === 'get_project')
                  ? 'get_project'
                  : 'search_tools',
                input: body.tools.some((t: any) => t.name === 'get_project')
                  ? { project: 'synthetic/fixture' }
                  : { query: 'get_project' },
              },
            ]
          : [
              {
                type: 'text',
                text: prompt.includes('ASSEMBLED_SERVICE_FACT')
                  ? 'Read: ASSEMBLED_SERVICE_FACT.'
                  : 'Assembled answer — amber 🦊.',
              },
            ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', {
      message: {
        id: 'msg_assembled',
        type: 'message',
        role: 'assistant',
        model: 'synthetic',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 13, output_tokens: 0 },
      },
    });
    content.forEach((part: any, index) => {
      send('content_block_start', {
        index,
        content_block: part.type === 'text' ? { type: 'text', text: '' } : { ...part, input: {} },
      });
      send('content_block_delta', {
        index,
        delta:
          part.type === 'text'
            ? { type: 'text_delta', text: part.text }
            : { type: 'input_json_delta', partial_json: JSON.stringify(part.input) },
      });
      send('content_block_stop', { index });
    });
    send('message_delta', {
      delta: {
        stop_reason: content.some((p: any) => p.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 7 },
    });
    send('message_stop', {});
    res.end();
    return;
  }
  unexpected.push(path);
  json({ error: 'unexpected_synthetic_route' }, 404);
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, client, head) =>
  wss.handleUpgrade(req, client, head, (ws: any) => wss.emit('connection', ws, req)),
);
wss.on('connection', (ws: any) => {
  socket = ws;
  sockets.push(ws);
  connections++;
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.on('message', (data: any) => {
    const b = JSON.parse(data.toString());
    if (b.envelope_id) acks.add(b.envelope_id);
  });
});
await new Promise<void>((r) => server.listen(9877, '127.0.0.1', r));
const port = (server.address() as any).port,
  peer = `http://127.0.0.1:${port}`;
codingPeer.allowPeer(port);
async function freePort() {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const appPort = await freePort(),
  adapterPort = await freePort();
// The image sets NODE_OPTIONS=--no-node-snapshot for Code Mode's isolated-vm.
assert.match(process.env.NODE_OPTIONS ?? '', /--no-node-snapshot/, 'image NODE_OPTIONS');
const baseEnv: Record<string, string> = {
  NODE_OPTIONS: process.env.NODE_OPTIONS!,
  SERVICE_TOKEN: secret,
  ADMIN_URL: peer,
  ADMIN_INTERNAL_TOKEN: secret,
  NATIVE_CODING_STORE: codingStore,
  EGRESS_PROXY_URL: codingPeer.proxyUrl,
  NODE_EXTRA_CA_CERTS: `${root}/tls/cert.pem`,
  NATIVE_BIND_HOST: '127.0.0.1',
  NATIVE_APPLICATION_URL: `http://127.0.0.1:${appPort}`,
  NATIVE_ADAPTER_URL: `http://127.0.0.1:${adapterPort}`,
  NATIVE_APPLICATION_PORT: String(appPort),
  NATIVE_ADAPTER_PORT: String(adapterPort),
  SLACK_APP_TOKEN: 'xapp-synthetic-local',
  SLACK_API_URL: `${peer}/api/`,
  NATIVE_PG_HOST: socketDir,
  NATIVE_PG_PASSWORD_FILE: passwordPath,
  NATIVE_MODEL_STUB: '1',
  SUPPORT_AGENT_INSTANCE: 'native-image-fixture',
  CLI_RUNTIME_URL: peer,
  CLI_RUNTIME_TOKEN: secret,
  MODEL_CATALOG: JSON.stringify([{ key: 'test', model: 'synthetic', route: 'anthropic' }]),
  MODEL_DEFAULT_KEY: 'test',
};
if (phase === 'answer-only') {
  delete baseEnv.NATIVE_CODING_STORE;
  delete baseEnv.CLI_RUNTIME_URL;
  delete baseEnv.CLI_RUNTIME_TOKEN;
}
const get = async (route: string) => {
  const response = await fetch(`http://127.0.0.1:${appPort}${route}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!response.ok) throw new Error(`app ${response.status}`);
  return response.json() as any;
};
const call = async (operation: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${appPort}/agents/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`refused ${r.status}`);
  return r.json() as any;
};
let seq = 0;
function event(text: string, options: any = {}) {
  const ts = `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, '0')}`;
  const user =
    options.user ??
    `U${caseId.toString(36).toUpperCase()}${phase.toUpperCase().replace(/[^A-Z0-9]/g, '')}${seq}`;
  const e = {
    type: 'app_mention',
    channel: 'CASSEMBLED',
    user,
    ts,
    text: `<@UBOT> ${text}`,
    ...options,
  };
  sources.push(e);
  return e;
}
async function emit(e: any, id = `evt-${caseId}-${++seq}`, awaitAck = true) {
  socket.send(
    JSON.stringify({
      envelope_id: id,
      type: 'events_api',
      accepts_response_payload: false,
      payload: {
        type: 'event_callback',
        team_id: 'TASSEMBLED',
        event_id: id,
        event: e,
        authorizations: [{ team_id: 'TASSEMBLED' }],
      },
    }),
  );
  if (awaitAck) await waitFor(async () => acks.has(id));
  return id;
}
async function row(e: any) {
  return (
    await pool.query(
      `SELECT run_id AS "runId",owner,accepted FROM native_agents.requests WHERE task_key=$1 AND accepted->>'messageTs'=$2`,
      [`v1:UBOT:TASSEMBLED:CASSEMBLED:${e.thread_ts ?? e.ts}`, e.ts],
    )
  ).rows[0];
}
async function delivered(e: any) {
  return waitFor(async () => posts.find((p) => p.thread_ts === (e.thread_ts ?? e.ts)));
}
try {
  await launch(`${root}/adapter/index.mjs`, baseEnv, 'adapter', ['--process-env']);
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${adapterPort}/native-authority/ready`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    return r.ok;
  });
  await launch(`${native}/main.mjs`, baseEnv, 'application');
  await waitFor(() => get('/readyz'));
  await waitFor(async () => socket);
  if (phase === 'backup-source' || phase === 'backup-restore')
    await backupScenario({
      root,
      phase,
      check,
      waitFor,
      call,
      get,
      event,
      emit,
      row,
      delivered,
      launch,
      main: `${native}/main.mjs`,
      baseEnv,
      pool,
      posts,
      ephemeral,
      gatewayRequests,
      setDropSend: (value: boolean) => {
        dropSend = value;
      },
      setBlocked: (value: string | undefined) => {
        blocked = value;
        revision++;
      },
    });
  if (phase === 'backup-source')
    await fs.writeFile(`${root}/sources.json`, JSON.stringify(sources));
  if (phase === 'coding-compose')
    await check('invalid-workspace-mount-refused-before-second-execution', async () => {
      const refused = await launch(
        `${native}/main.mjs`,
        { ...baseEnv, NATIVE_CODING_STORE: 'relative-path' },
        'coding-refused',
      );
      assert.equal((await refused.done).code, 1);
      assert.equal(connections, 1);
      return { coding: 'retained-store-required' };
    });
  await check(
    'actual-default-entrypoints-single-authenticated-receiver-no-legacy-calls',
    async () => {
      assert.equal(connections, 1);
      assert.equal((await get('/healthz')).runtime, 'native-answer');
      const r = await fetch(`http://127.0.0.1:${appPort}/tasks`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      assert(!r.ok);
      return { connections, noLegacyConfiguration: true };
    },
  );
  if (phase === 'coding-backup-source') {
    await check('coding-backup-retains-native-question-without-resuming', async () => {
      const e = event('ASK_ASSEMBLED');
      await emit(e);
      await delivered(e);
      const handle = await row(e);
      const inspected = await call('inspect', { ...handle, actor: e.user });
      assert.equal(inspected.suspended.toolCallId, 'ask-assembled');
      await fs.writeFile(
        `${root}/coding-backup-question.json`,
        JSON.stringify({ event: e, handle }),
      );
      return { runId: handle.runId, suspended: true };
    });
  } else if (phase === 'coding-files-cold' || phase === 'coding-backup-restore') {
    await check(
      'cold-native-inspection-retains-file-receipts-with-no-upload-or-inference',
      async () => {
        const before = posts.length;
        const handle = JSON.parse(await fs.readFile(`${root}/coding-files-handle.json`, 'utf8'));
        const inspected = await call('inspect', handle);
        assert.deepEqual(inspected.exports, handle.inspected.exports);
        await call('present', handle);
        assert.equal(posts.length, before);
        assert.equal(gatewayRequests.length, 0);
        assert.equal(exportFiles.size, 3);
        return { retainedExports: 3, providerCalls: 0, duplicatePosts: 0 };
      },
    );
    if (phase === 'coding-backup-restore') {
      await check('restored-question-requires-current-authority-and-resumes-once', async () => {
        const saved = JSON.parse(await fs.readFile(`${root}/coding-backup-question.json`, 'utf8'));
        const who = { ...saved.handle, actor: saved.event.user };
        const before = gatewayRequests.length;
        blocked = saved.event.user;
        revision++;
        await assert.rejects(
          call('resume', { ...who, toolCallId: 'ask-assembled', answer: 'TARGET_ASSEMBLED' }),
        );
        assert.equal(gatewayRequests.length, before);
        blocked = undefined;
        revision++;
        await call('resume', { ...who, toolCallId: 'ask-assembled', answer: 'TARGET_ASSEMBLED' });
        await call('result', who);
        await call('present', who);
        await assert.rejects(
          call('resume', { ...who, toolCallId: 'ask-assembled', answer: 'TARGET_ASSEMBLED' }),
        );
        assert.equal(gatewayRequests.length, before + 1);
        assert.equal(posts.filter((p) => p.thread_ts === saved.event.ts).length, 1);
        return { explicitResume: 1, rejectedRevoked: 1, noReplay: true };
      });
    }
  } else if (phase === 'coding-files' || phase === 'coding-files-unknown') {
    await check('actual-workspace-input-and-designated-exact-byte-Slack-exports', async () => {
      const e = event('CODING_FILES');
      e.files = [
        {
          id: 'FINPUT',
          name: 'input.csv',
          mimetype: 'text/csv',
          size: codingPeer.inputBytes.length,
          updated: 1,
          mode: 'hosted',
          is_external: false,
          user: e.user,
          url_private_download: 'https://files.slack.com/files/FINPUT',
        },
        {
          id: 'FIMAGE',
          name: 'pixel.png',
          mimetype: 'image/png',
          size: codingPeer.imageBytes.length,
          updated: 1,
          mode: 'hosted',
          is_external: false,
          user: e.user,
          url_private_download: 'https://files.slack.com/files/FIMAGE',
        },
      ];
      await emit(e);
      const r = await waitFor(() => row(e));
      if (phase === 'coding-files-unknown') {
        await waitFor(
          async () =>
            (await call('inspect', { ...r, actor: e.user })).delivery?.outcome === 'uncertain',
        );
        await waitFor(async () => [...exportFiles.values()].some((f) => f.shares));
        await call('present', { ...r, actor: e.user });
        assert.equal(posts.length, 0);
        assert.equal(exportFiles.size, 1);
        const retained = await call('inspect', { ...r, actor: e.user });
        assert.equal(retained.exports.length, 3);
        assert(retained.exports.every((f: any) => f.receipt === null));
        return { uncertain: true, noRetry: true, retainedBytes: true };
      }
      assert.equal((await delivered(e)).text, 'Files ready.');
      const inspected = await waitFor(async () => {
        const value = await call('inspect', { ...r, actor: e.user });
        return value.delivery?.outcome === 'delivered' ? value : undefined;
      });
      assert.equal(inspected.delivery.outcome, 'delivered');
      assert.equal(inspected.exports.length, 3);
      const wanted = new Map([
        ['report.csv', Buffer.from('name,doubled\r\nfox,28\r\n')],
        ['original.csv', codingPeer.inputBytes],
        ['pixel.png', codingPeer.imageBytes],
      ]);
      for (const f of inspected.exports) {
        const bytes = wanted.get(f.name)!;
        assert.deepEqual(codingPeer.uploaded.get(f.receipt.fileId), bytes);
        assert.equal(f.sha256, createHash('sha256').update(bytes).digest('hex'));
      }
      await call('present', { ...r, actor: e.user });
      assert.equal(exportFiles.size, 3);
      assert.equal(posts.length, 1);
      await fs.writeFile(
        `${root}/coding-files-handle.json`,
        JSON.stringify({ ...r, actor: e.user, inspected }),
      );
      await fs.writeFile(
        `${root}/coding-files-state.json`,
        JSON.stringify({
          sources,
          posts,
          files: [...exportFiles],
          uploaded: [...codingPeer.uploaded].map(([id, b]) => [id, b.toString('base64')]),
        }),
      );
      await assert.rejects(
        pool.query("UPDATE native_agents.exports SET content='corrupt' WHERE false"),
      );
      return { runId: r.runId, exports: inspected.exports, uploads: 3, posts: 1 };
    });
  } else if (phase === 'answer-only') {
    await check('answer delivered with GitLab assigned and no CLI runtime', async () => {
      const plain = event('PLAIN_ASSEMBLED');
      await emit(plain);
      assert.equal((await delivered(plain)).text, 'Assembled answer — amber 🦊.');
      assert.equal(reads.length, 0);
    });
  } else if (phase === 'coding-compose') {
    await check('unified-entrypoint-answers-without-an-assigned-gitlab', async () => {
      const offset = gatewayRequests.length;
      const plain = event('PLAIN_ASSEMBLED');
      await emit(plain);
      assert.equal((await delivered(plain)).text, 'Assembled answer — amber 🦊.');
      assert.deepEqual(gatewayRequests[offset].tools.map((t: any) => t.name).sort(), [
        'ask_user',
        'search_tools',
      ]);
      assert.equal(reads.length, 0);
      gitlabAssigned = true;
      revision++;
      return { answer: 'delivered', gitlabCalls: reads.length };
    });
    await check(
      'unified-thread-discovers-reads-then-verifies-and-publishes-over-authenticated-https',
      async () => {
        assert.equal((await get('/readyz')).runtime, 'native-answer');
        const offset = gatewayRequests.length;
        const discover = event('DISCOVER_ASSEMBLED');
        await emit(discover);
        assert.equal((await delivered(discover)).text, 'Read: ASSEMBLED_SERVICE_FACT.');
        const initial = gatewayRequests[offset];
        assert(!JSON.stringify(initial.system).includes('declare function external_'));
        assert(initial.tools.some((t: any) => t.name === 'search_tools'));
        assert(
          !initial.tools.some((t: any) => ['get_project', 'execute_typescript'].includes(t.name)),
        );
        assert(gatewayRequests[offset + 1].tools.some((t: any) => t.name === 'get_project'));
        const e = event('CODING_FIRST', { thread_ts: discover.ts, user: discover.user });
        await emit(e);
        // While Code Mode loops synchronously in its isolate, the agent's event
        // loop keeps serving: another durable run in another thread completes.
        await waitFor(async () => codeModeLoop.started, 60000);
        const other = event('PLAIN_ASSEMBLED');
        await emit(other);
        assert.equal((await delivered(other)).text, 'Assembled answer — amber 🦊.');
        const otherDone = Date.now();
        assert(!codeModeLoop.ended, 'the other run completed only after the loop ended');
        const threadPosts = () => posts.filter((p) => p.thread_ts === discover.ts);
        const sent = await waitFor(async () => threadPosts()[1], 60000);
        assert.match(sent.text, /Verified publication: fixture\/project/);
        const r = await row(e);
        const inspected = await call('inspect', { ...r, actor: e.user });
        assert.equal(inspected.publications[0].outcome, 'confirmed');
        const first = await codingPeer.assertPublished('native first');
        const follow = event('CODING_FOLLOW', { user: e.user, thread_ts: discover.ts });
        await emit(follow);
        await waitFor(async () => threadPosts().length === 3, 60000);
        const second = await codingPeer.assertPublished('native follow');
        assert.equal(first.branch, second.branch);
        assert.equal(first.mrIid, second.mrIid);
        assert.notEqual(first.commit, second.commit);
        const last = await row(follow);
        await call('present', { ...last, actor: e.user });
        assert.equal(threadPosts().length, 3);
        const lost = /could not verify that this execution still owns the run/;
        const logs = await fs.readdir(root);
        for (const log of logs.filter((f) => f.startsWith(`${phase}-${caseId}-`)))
          assert.doesNotMatch(await fs.readFile(`${root}/${log}`, 'utf8'), lost, log);
        const loop = {
          otherRunDoneAfterMs: otherDone - codeModeLoop.started!,
          loopMs: codeModeLoop.ended! - codeModeLoop.started!,
        };
        assert(loop.loopMs >= CODE_MODE_LIMITS.timeoutMs, 'the loop ran to its timeout');
        return { first, second, deliveries: 3, loop };
      },
    );
    await check('code-mode-runs-in-isolated-vm-within-its-limits', async () => {
      const uses = new Map<string, string>();
      const results = new Map<string, string>();
      for (const body of gatewayRequests)
        for (const message of body.messages)
          for (const part of Array.isArray(message.content) ? message.content : []) {
            if (part.type === 'tool_use' && part.name === 'execute_typescript')
              uses.set(part.id, part.input.code);
            if (part.type === 'tool_result')
              results.set(part.tool_use_id, JSON.stringify(part.content).replaceAll('\\', ''));
          }
      const result = (code: string) => {
        const id = [...uses].find(([, used]) => used === code)?.[0];
        assert(id && results.has(id), `no execute_typescript result for: ${code}`);
        return results.get(id)!;
      };
      const [combined, host, write, recursion, fits, memory, loop] = CODE_MODE_PROBES.map(result);
      assert.match(combined!, /"success":true/);
      assert.match(combined!, /"combined":true/);
      assert.match(host!, /"hostAccess":"none"/);
      assert.match(write!, /ReferenceError/);
      assert.match(write!, /external_create_merge_request/);
      assert.match(recursion!, /Maximum call stack size exceeded/);
      assert.match(fits!, /"allocated":33554432/);
      assert.match(memory!, /Array buffer allocation failed/);
      assert.match(loop!, /TimeoutError/);
      assert(loop!.includes(`timed out after ${CODE_MODE_LIMITS.timeoutMs}ms`));
      return {
        scripts: CODE_MODE_PROBES.length,
        combined,
        host,
        write,
        recursion,
        fits,
        memory,
        loop,
      };
    });
    await check('startup-refused-without-no-node-snapshot', async () => {
      const refused = await launch(
        `${native}/main.mjs`,
        { ...baseEnv, NODE_OPTIONS: '' },
        'no-node-snapshot',
      );
      assert.equal((await refused.done).code, 1);
      const log = await fs.readFile(`${root}/${phase}-${caseId}-no-node-snapshot.log`, 'utf8');
      assert.match(log, /--no-node-snapshot/);
      assert.equal(connections, 1);
      return { startup: 'refused' };
    });
    await check('execution-lock-refuses-second-startup-without-changing-state', async () => {
      const refused = await launch(`${native}/main.mjs`, baseEnv, 'second-startup');
      assert.equal((await refused.done).code, 1);
      assert.equal(connections, 1);
      return { secondStartup: 'refused' };
    });
  }
  await check('no-legacy-claims-qualification-or-poller-and-no-secret-persistence', async () => {
    assert.deepEqual(unexpected, []);
    assert.equal(connections, 1);
    const stored = (
      await pool.query('SELECT row_to_json(r)::text AS data FROM native_agents.requests r')
    ).rows
      .map((r: any) => r.data)
      .join('');
    assert(!stored.includes('xoxb-'));
    assert(!stored.includes(secret));
    const snapshots = (
      await pool.query(
        'SELECT row_to_json(r)::text AS data FROM framework.mastra_workflow_snapshot r',
      )
    ).rows
      .map((r: any) => r.data)
      .join('');
    assert(!snapshots.includes('stub-key-2'));
    assert(!snapshots.includes(secret));
    return { unexpectedCalls: unexpected, connections };
  });
} finally {
  for (const child of children) await stop(child);
  for (const ws of sockets) ws.terminate();
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
  await codingPeer.close();
  await pool.end();
  await fs.writeFile(
    `${root}/${phase}-${caseId}-peers.json`,
    JSON.stringify({ posts, ephemeral, reactions, gatewayRequests, reads, unexpected }, null, 2),
  );
}
