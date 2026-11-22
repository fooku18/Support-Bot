/** Actual adapter executable + admin/SQLite + synthetic Slack HTTP/Socket Mode.
 * Also runnable inside the adapter image with networking disabled. No Gateway. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp } from '../../../admin/src/app.js';
import { AdminStore } from '../../../admin/src/store.js';
import { SlackApi } from '../../../admin/src/slack.js';

const root = process.env.COMMAND_BOUNDARY_ROOT!;
const entrypoint = process.env.COMMAND_BOUNDARY_ADAPTER!;
const internal = 'synthetic-command-boundary-internal';
const database = { path: path.join(root, 'admin.sqlite') };
const store = await AdminStore.open(database, Buffer.alloc(32, 1));
const servers: http.Server[] = [];
const timeline: Array<{ kind: string; detail?: unknown }> = [];
interface SlackRequest {
  user: string;
  channel: string;
  blocks: Array<{ elements: Array<{ value: string }> }>;
  view: { private_metadata: string };
}
interface Ack {
  response_action?: string;
  errors?: { part1: string };
}
const ephemeral: SlackRequest[] = [];
const views: SlackRequest[] = [];
const posts: SlackRequest[] = [];
const acks = new Map<string, Ack | undefined>();
let member = true;
let socket: WebSocket | undefined;
let connections = 0;
let agentCalls = 0;
let sequence = 0;
let child: ReturnType<typeof spawn> | undefined;
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
const wsReady = new Promise<number>((resolve) =>
  wss.once('listening', () => resolve((wss.address() as { port: number }).port)),
);
wss.on('connection', (ws) => {
  connections++;
  socket = ws;
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.envelope_id) {
      acks.set(frame.envelope_id, frame.payload);
      timeline.push({ kind: 'ack', detail: frame.envelope_id });
    }
  });
});
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function wait(check: () => boolean, name: string) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function count(table: string) {
  return Number((await store.get(`SELECT count(*) AS n FROM ${table}`))!.n);
}
async function send(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  const id = `envelope-${++sequence}`;
  socket!.send(
    JSON.stringify({
      envelope_id: id,
      type,
      accepts_response_payload: type === 'interactive',
      payload,
      ...extra,
    }),
  );
  await wait(() => acks.has(id), `ack ${id}`);
  return acks.get(id)!;
}
function source(text: string) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    event_id: `Ev${sequence + 1}`,
    event: {
      type: 'app_mention',
      channel: 'C1',
      user: 'U1',
      ts: `${Math.floor(Date.now() / 1000) + 1}.${String(sequence + 1).padStart(6, '0')}`,
      text,
    },
  };
}
async function configure() {
  const before = ephemeral.length;
  await send('events_api', source('<@UBOT> !config'));
  await wait(() => ephemeral.length > before, 'private configure button');
  const button = ephemeral.at(-1)!;
  assert.equal(button.user, 'U1');
  assert.equal(button.channel, 'C1');
  const grant = button.blocks[0]!.elements[0]!.value;
  const opened = views.length;
  await send('interactive', {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    channel: { id: 'C1' },
    container: { is_ephemeral: true, channel_id: 'C1' },
    trigger_id: 'synthetic-trigger',
    actions: [{ action_id: 'support_agent_configure_channel', value: grant }],
  });
  await wait(() => views.length > opened, 'Slack views.open');
  return views.at(-1)!.view;
}
function submission(view: SlackRequest['view'], prompt = '') {
  return {
    type: 'view_submission',
    team: { id: 'T1' },
    user: { id: 'U1' },
    view: {
      callback_id: 'support_agent_channel_settings',
      private_metadata: view.private_metadata,
      state: {
        values: {
          model: { value: { selected_option: { value: 'inherit' } } },
          part1: { value: { value: prompt } },
          part2: { value: { value: '' } },
          replies: { value: { selected_options: [{ value: 'on' }] } },
        },
      },
    },
  };
}

try {
  const wsPort = await wsReady;
  const slackUrl = await listen((req, res) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const body = req.headers['content-type']?.includes('application/json')
        ? JSON.parse(raw || '{}')
        : Object.fromEntries(new URLSearchParams(raw));
      for (const key of ['view', 'blocks', 'metadata'])
        if (typeof body[key] === 'string') body[key] = JSON.parse(body[key]);
      const method = req.url!.split('/').at(-1)!;
      timeline.push({ kind: 'slack', detail: method });
      let result: unknown = { ok: true };
      if (method === 'auth.test')
        result = { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' };
      else if (method === 'apps.connections.open')
        result = { ok: true, url: `ws://127.0.0.1:${wsPort}` };
      else if (method === 'conversations.members')
        result = { ok: true, members: member ? ['U1'] : [], response_metadata: {} };
      else if (method === 'chat.postEphemeral') {
        ephemeral.push(body);
        result = { ok: true, message_ts: '1792940000.123456' };
      } else if (method === 'views.open') {
        views.push(body);
        result = { ok: true, view: { id: 'VSYNTHETIC' } };
      } else if (method === 'chat.postMessage') {
        posts.push(body);
        result = { ok: true, ts: `1792940001.${String(posts.length).padStart(6, '0')}` };
      } else if (method === 'conversations.replies')
        result = { ok: true, messages: [], response_metadata: {} };
      else throw new Error(`Unexpected Slack method ${method}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    })().catch(() => res.writeHead(500).end());
  });
  await store.saveInstallation('fixture', {
    teamId: 'T1',
    teamName: 'Synthetic',
    botUserId: 'UBOT',
    botId: 'B1',
    botToken: 'xoxb-synthetic-only',
    scopes: '',
  });
  await store.updateInstallation('fixture', 'T1', { status: 'whitelisted' });
  await store.setChannel('fixture', {
    teamId: 'T1',
    channelId: 'C1',
    name: 'synthetic',
    isPrivate: false,
    botMember: true,
    enabled: true,
  });
  await store.unblockMember('fixture', {
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
  });
  const config = {
    publicUrl: 'https://admin.example.test',
    internalToken: internal,
    storeKey: Buffer.alloc(32, 1),
    sessionKey: Buffer.alloc(32, 2),
    slackClientId: 'synthetic',
    slackClientSecret: 'synthetic',
    slackApiUrl: `${slackUrl}/api/`,
    egressProxyUrl: undefined,
    port: 0,
    host: '127.0.0.1',
    database,
    models: { keys: ['sonnet', 'opus'], defaultKey: 'sonnet' },
    studioUrl: null,
    costRetentionDays: 400,
  };
  const app = createApp({
    config,
    store,
    slack: new SlackApi({ apiUrl: config.slackApiUrl }),
    log: () => {},
  });
  const admin = await listen((req, res) => {
    const route = req.url!;
    if (route.startsWith('/internal/channel-commands/'))
      timeline.push({ kind: 'admin', detail: route });
    app(req, res);
  });
  const application = await listen((req, res) => {
    if (req.url!.startsWith('/agents/')) agentCalls++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const log = fs.openSync(path.join(root, 'adapter.log'), 'a', 0o600);
  child = spawn(process.execPath, [entrypoint, '--process-env'], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      SERVICE_TOKEN: internal,
      NATIVE_APPLICATION_URL: application,
      ADMIN_URL: admin,
      ADMIN_INTERNAL_TOKEN: internal,
      SLACK_APP_TOKEN: 'xapp-synthetic-only',
      SLACK_API_URL: `${slackUrl}/api/`,
      NATIVE_ADAPTER_PORT: '0',
      NATIVE_BIND_HOST: '127.0.0.1',
    },
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  await wait(() => !!socket, 'single Socket Mode connection');
  const initial = (await store.currentDocument())!.version;
  const noop = await configure();
  assert.equal(await count('channel_commands'), 1);
  assert.equal(await count('channel_config_grants'), 1);
  assert.equal(posts.length, 0);
  await send('interactive', submission(noop));
  assert.equal((await store.currentDocument())!.version, initial);
  assert.equal(await count('channel_command_receipts'), 0);
  await send('interactive', submission(noop));
  assert.equal(await count('channel_command_receipts'), 0);

  const changed = await configure();
  const save = submission(changed, 'Synthetic boundary prompt');
  await send('interactive', save);
  assert.equal((await store.channelSettings('T1', 'C1')).prompt, 'Synthetic boundary prompt');
  assert.equal((await store.currentDocument())!.version, initial + 1);
  await wait(() => posts.length === 1, 'public change receipt');
  await send('interactive', save);
  assert.equal(await count('channel_command_receipts'), 1);
  assert.equal((await store.currentDocument())!.version, initial + 1);
  const mutated = await send('interactive', submission(changed, 'Different payload'));
  assert.equal(mutated.response_action, 'errors');

  const stale = await configure();
  await store.setChannelSettings(
    'fixture',
    'T1',
    'C1',
    (await store.channelSettings('T1', 'C1')).fingerprint,
    { prompt: 'Concurrent admin edit' },
    ['sonnet', 'opus'],
  );
  const conflict = await send('interactive', submission(stale, 'Stale draft'));
  assert.equal(conflict.response_action, 'errors');
  assert.match(conflict.errors!.part1, /changed/);

  const revoked = await configure();
  member = false;
  const denied = await send('interactive', submission(revoked, 'Revoked membership'));
  assert.equal(denied.response_action, 'errors');
  assert.match(denied.errors!.part1, /belong/);
  member = true;
  await store.blockMember('fixture', {
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    displayName: 'Synthetic requester',
  });
  const policyDenied = await send('interactive', submission(revoked, 'Revoked policy'));
  assert.equal(policyDenied.response_action, 'errors');
  await store.unblockMember('fixture', {
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
  });

  const replay = source('<@UBOT>!config');
  await send('events_api', replay);
  const commandCount = await count('channel_commands');
  await send('events_api', replay);
  await send('events_api', { ...replay, event_id: 'EvAlias' });
  assert.equal(await count('channel_commands'), commandCount);
  await send('events_api', source('<@UBOT> !unknown'));
  await wait(() => posts.length === 2, 'usage receipt');
  assert.equal(agentCalls, 0);
  assert.equal(connections, 1);
  assert.equal((await store.channelSettings('T1', 'C1')).prompt, 'Concurrent admin edit');
  fs.writeFileSync(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        mode: 'actual-adapter-admin-synthetic-Slack-HTTP-Socket-Mode',
        agentCalls,
        connections,
        checks: [
          'private button',
          'open modal',
          'no-op',
          'changed save',
          'exact save replay',
          'changed replay rejection',
          'fingerprint conflict',
          'current membership',
          'current admin policy',
          'source/event dedup',
          'reserved usage',
          'receipt delivery',
        ],
        publicReceipts: posts.length,
        commands: await count('channel_commands'),
        timeline,
      },
      null,
      2,
    ),
  );
  console.log('Native command HTTP/Socket Mode boundary passed; zero agent calls.');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  }
  socket?.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await store.close();
}
