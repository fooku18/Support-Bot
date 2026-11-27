#!/usr/bin/env node
/** Native integration suites (T3): real PostgreSQL, synthetic HTTP peers.
 * Each run gets a fresh folder under artifacts/native/<suite>/<id> and its own
 * containers and volumes. Containers and volumes stay stopped; no cleanup. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { parseArgs } from 'node:util';
import { credentialHits } from './native-tools-evidence.mjs';

const suites = ['discovery', 'application', 'backup', 'coding', 'telemetry', 'tools'];
const imageSuites = ['backup', 'coding', 'telemetry', 'tools'];
const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'discovery' },
    'image-tag': { type: 'string' },
  },
});
const suite = values.suite;
if (!suites.includes(suite)) throw new Error(`unknown native suite; use ${suites.join('|')}`);
const tag = values['image-tag'];
if (imageSuites.includes(suite) !== Boolean(tag))
  throw new Error(
    imageSuites.includes(suite)
      ? `--suite ${suite} needs --image-tag <tag> of local ${suite === 'tools' ? 'cli-runtime and egress images' : 'native-coding image'}`
      : `--suite ${suite} takes no --image-tag`,
  );
if (tag && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('invalid image tag');

const repo = process.cwd();
const { Pool } = createRequire(path.join(repo, 'apps/agent/package.json'))('pg');
const id = randomBytes(4).toString('hex');
const root = path.join(repo, 'artifacts', 'native', suite, id);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
// The coding container runs as root without DAC_OVERRIDE and writes here.
if (imageSuites.includes(suite) && suite !== 'tools') fs.chmodSync(root, 0o777);
const prefix = `native-test-${suite}-${id}`;
const label = `org.support-agent.native-test=${suite}`;
const pgImage = 'postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3';
const image = tag && suite !== 'tools' ? `support-agent/native-coding:${tag}` : undefined;
const started = Date.now();
const pgs = [],
  volumes = [],
  networks = [];
let failed = false;
let records = 0;
const summary = {};

function run(cmd, args, { env = process.env, timeout = 180000, input, stdout, log } = {}) {
  const result = spawnSync(cmd, args, {
    env,
    timeout,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', stdout ?? 'pipe', 'pipe'],
    encoding: stdout ? undefined : 'utf8',
    maxBuffer: 64 * 1024 ** 2,
  });
  fs.appendFileSync(
    path.join(root, 'commands.jsonl'),
    JSON.stringify({ cmd, args, code: result.status, signal: result.signal }) + '\n',
  );
  if (log)
    fs.writeFileSync(
      path.join(root, log),
      (stdout ? '' : (result.stdout ?? '')) + String(result.stderr ?? ''),
    );
  if (result.status !== 0)
    throw new Error(`${cmd} ${args[0]} failed (exit ${result.status}): ${result.stderr ?? ''}`);
  return result.stdout;
}
const docker = (...args) => run('docker', args);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function reserve() {
  const s = fs.statfsSync(root);
  if (s.bavail * s.bsize < 2 * 1024 ** 3 + 128 * 1024 ** 2)
    throw new Error('2 GiB reserve plus fixture headroom required');
}
function mkdir(dir, mode = 0o777) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, mode);
  return dir;
}
function socketDir(name) {
  const dir = mkdir(path.join(root, name));
  // Unix socket paths are limited to 107 bytes.
  if (path.join(dir, '.s.PGSQL.5432').length > 107)
    throw new Error(`checkout path too long for a PostgreSQL socket under ${dir}`);
  return dir;
}

/** Bundles entry points from the current source. Package imports stay
 * external and resolve from links to the locked workspace installs. */
async function bundle(entries, outdir, banner = false) {
  const result = await build({
    entryPoints: entries,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node26',
    outdir,
    outExtension: { '.js': '.mjs' },
    metafile: true,
    ...(banner
      ? {
          banner: {
            js: "import { createRequire as nativeRequire } from 'node:module'; const require = nativeRequire(import.meta.url);",
          },
        }
      : {}),
  });
  fs.writeFileSync(path.join(outdir, 'metafile.json'), JSON.stringify(result.metafile, null, 2));
  return result.metafile;
}
function linkExternals(metafile, workspaces = ['apps/agent', 'apps/slack', 'apps/admin', '']) {
  for (const name of new Set(
    Object.values(metafile.outputs)
      .flatMap((o) => o.imports)
      .filter((i) => i.external && !i.path.startsWith('node:'))
      .map((i) =>
        i.path
          .split('/')
          .slice(0, i.path.startsWith('@') ? 2 : 1)
          .join('/'),
      ),
  )) {
    const target = path.join(root, 'node_modules', name);
    if (fs.existsSync(target)) continue;
    const source = workspaces
      .map((p) => path.join(repo, p, 'node_modules', name))
      .find((p) => fs.existsSync(p));
    if (!source) throw new Error(`Missing locked dependency ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
  }
}

/** One PostgreSQL 17 container. `tcp` publishes a loopback port; `socket`
 * exposes only a Unix socket directory in the run folder (network none). */
async function startPg(name, { tcp = false, socket, hba, password } = {}) {
  const volume = `${name}-data`;
  docker('volume', 'create', '--label', label, volume);
  volumes.push(volume);
  const remote = process.env.DOCKER_HOST?.startsWith('tcp://');
  const args = [
    'run',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--label',
    label,
    '--memory',
    '256m',
    '--pids-limit',
    '64',
    '--log-opt',
    'max-size=1m',
    '--mount',
    `type=volume,src=${volume},dst=/var/lib/postgresql/data`,
    ...(tcp ? ['-p', remote ? '5432' : '127.0.0.1::5432'] : ['--network', 'none']),
    ...(socket ? ['--mount', `type=bind,src=${socket},dst=/socket`] : []),
    ...(hba ? ['--mount', `type=bind,src=${hba},dst=/config/pg_hba.conf,readonly`] : []),
    '-e',
    password ? 'POSTGRES_PASSWORD' : 'POSTGRES_HOST_AUTH_METHOD=trust',
    pgImage,
    'postgres',
    '-c',
    'shared_buffers=16MB',
    '-c',
    'max_connections=30',
    '-c',
    'max_wal_size=64MB',
    ...(socket ? ['-c', 'unix_socket_directories=/var/run/postgresql,/socket'] : []),
    ...(hba ? ['-c', 'hba_file=/config/pg_hba.conf'] : []),
  ];
  run('docker', args, {
    env: { ...process.env, ...(password ? { POSTGRES_PASSWORD: password } : {}) },
  });
  pgs.push(name);
  const end = Date.now() + 30000;
  for (;;) {
    const ready = spawnSync(
      'docker',
      ['exec', name, 'sh', '-c', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'],
      { stdio: 'ignore' },
    );
    if (ready.status === 0) break;
    if (Date.now() > end) throw new Error(`${name} readiness timed out`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!tcp) return {};
  const inspected = JSON.parse(docker('inspect', name))[0];
  const host = remote
    ? new URL(process.env.DOCKER_HOST.replace('tcp://', 'http://')).hostname
    : process.env.NATIVE_TEST_DOCKER_LOOPBACK || '127.0.0.1';
  return { host, port: inspected.NetworkSettings.Ports['5432/tcp'][0].HostPort };
}

/** Counts the test records of every phase report in the run folder. */
function countRecords() {
  let n = 0;
  for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.json'))) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (Array.isArray(report.tests)) {
        assert(report.tests.every((t) => t.status === 'pass' || t.outcome === 'pass'));
        n += report.tests.length;
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw new Error(`failed record in ${file}`);
    }
  }
  return n;
}

// --- discovery and application: in-process vertical, Node on the host -----

async function inProcessSuite() {
  fs.cpSync(path.join(repo, 'tests/fixtures/native-inputs'), path.join(root, 'source-fixtures'), {
    recursive: true,
  });
  const metafile = await bundle(
    { vertical: 'tests/integration/mastra/durable-answer-vertical.ts' },
    root,
  );
  linkExternals(metafile, ['apps/agent', 'apps/slack', '']);
  const password = randomBytes(32).toString('hex');
  const { host, port } = await startPg(`${prefix}-pg`, { tcp: true, password });
  if (suite === 'application') {
    const built = await bundle({ provision: 'apps/agent/src/bootstrap/provision.ts' }, root, true);
    linkExternals(built);
    const env = {
      PATH: process.env.PATH,
      NATIVE_PG_HOST: host,
      NATIVE_PG_PORT: port,
      NATIVE_PG_ADMIN_PASSWORD: password,
      NATIVE_PG_PASSWORD: randomBytes(32).toString('hex'),
    };
    const provision = () =>
      spawnSync(process.execPath, [path.join(root, 'provision.mjs')], { env, timeout: 60000 });
    assert.equal(provision().status, 0, 'fresh TCP provisioning');
    assert.equal(provision().status, 1, 'refuse existing TCP database');
  }
  const phases = [
    'discovery-provision',
    'discovery',
    'discovery-cold',
    ...(suite === 'application'
      ? [
          'checks',
          'boundary-busy',
          'boundary-policy',
          'boundary-shutdown',
          'inputs',
          'inputs-cold',
          'inputs-corrections',
          'memory',
          'memory-cold',
          'interrupt',
          'inspect-interrupted',
          'suspend',
          'resume',
        ]
      : []),
  ];
  // These phases never exit: the driver kills them once their files show the
  // state to cut (a model call in flight, a suspended run). The next phase is
  // a new process on the same database.
  const killed = {
    interrupt: ['interrupted-handle.json', 'interrupted-model-barrier.json'],
    suspend: ['ready-to-terminate.json'],
  };
  const env = {
    PATH: process.env.PATH,
    NATIVE_TEST_ROOT: root,
    NATIVE_TEST_REPO: repo,
    NATIVE_TEST_PG_HOST: host,
    NATIVE_TEST_PG_PORT: port,
    NATIVE_TEST_PG_PASSWORD: password,
  };
  for (const phase of phases) {
    reserve();
    const log = path.join(root, `${phase}.log`);
    if (killed[phase]) {
      const out = fs.openSync(log, 'w');
      const child = spawn(process.execPath, [path.join(root, 'vertical.mjs'), phase], {
        cwd: repo,
        env,
        stdio: ['ignore', out, out],
      });
      const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      const end = Date.now() + 60000;
      let ready = false;
      while (!ready && Date.now() < end) {
        ready = killed[phase].every((f) => fs.existsSync(path.join(root, f)));
        if (!ready) await Promise.race([exited, new Promise((r) => setTimeout(r, 100))]);
        if (child.exitCode !== null) break;
      }
      child.kill('SIGKILL');
      await exited;
      fs.closeSync(out);
      if (!ready) throw new Error(`${phase} did not reach its kill point`);
      continue;
    }
    const result = spawnSync(process.execPath, [path.join(root, 'vertical.mjs'), phase], {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 ** 2,
    });
    fs.writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.status !== 0) throw new Error(`${phase} failed`);
  }
}

// --- backup and coding: real entrypoints inside the native-coding image ------

const nodeModules = ['node_modules', 'apps/agent/node_modules', 'apps/slack/node_modules']
  .concat(
    fs.existsSync(path.join(repo, 'apps/admin/node_modules')) ? ['apps/admin/node_modules'] : [],
  )
  .map((p) => path.join(repo, p));

async function prepareImageRun() {
  const imageId = docker('image', 'inspect', image, '--format', '{{.Id}}').trim();
  summary.image = { name: image, id: imageId };
  docker('image', 'inspect', pgImage);
  for (const dir of ['tls', 'native', 'adapter', 'fixture']) mkdir(path.join(root, dir), 0o755);
  // Synthetic values only; the root-run fixture without DAC_OVERRIDE reads them.
  const secret = (name, value) =>
    fs.writeFileSync(path.join(root, name), value, { mode: 0o644, flag: 'wx' });
  secret('runtime-secret', randomBytes(24).toString('hex'));
  secret('restore-runtime-secret', randomBytes(24).toString('hex'));
  fs.writeFileSync(
    path.join(root, 'pg_hba.conf'),
    'local all native_answer scram-sha-256\nlocal all postgres trust\n',
    { mode: 0o644 },
  );
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(root, 'tls/key.pem'),
      '-out',
      path.join(root, 'tls/cert.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=gitlab.synthetic.invalid',
      '-addext',
      'subjectAltName=DNS:gitlab.synthetic.invalid,DNS:files.slack.com',
    ],
    { log: 'tls.log' },
  );
  fs.chmodSync(path.join(root, 'tls/key.pem'), 0o644);
  await bundle(
    {
      main: 'apps/agent/src/bootstrap/main.ts',
      provision: 'apps/agent/src/bootstrap/provision.ts',
      telemetry: 'apps/agent/src/bootstrap/telemetry.ts',
    },
    path.join(root, 'native'),
    true,
  );
  await bundle({ index: 'apps/slack/src/index.ts' }, path.join(root, 'adapter'), true);
  fs.symlinkSync(
    path.join(repo, 'apps/slack/node_modules'),
    path.join(root, 'adapter/node_modules'),
  );
  linkExternals(
    await bundle(
      { vertical: 'tests/integration/mastra/native-image-vertical.ts' },
      path.join(root, 'fixture'),
      true,
    ),
  );
}

/** One fixture phase in a network-none native-coding container, with the
 * same user, capabilities and security options as the Compose service. */
function imagePhase(phase, { socket, password, store }) {
  reserve();
  const args = [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    `${prefix}-${phase}`,
    '--label',
    label,
    '--network',
    'none',
    '--add-host',
    'model-stub:127.0.0.1',
    '--read-only',
    '--user',
    '0:0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SYS_ADMIN',
    '--cap-add',
    'NET_ADMIN',
    '--security-opt',
    'no-new-privileges:true',
    '--security-opt',
    'seccomp=unconfined',
    '--security-opt',
    'apparmor=unconfined',
    '--memory',
    '768m',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=128m',
    '--mount',
    `type=bind,src=${root},dst=${root}`,
    '--mount',
    `type=bind,src=${root}/native,dst=/app/apps/agent/dist/native,readonly`,
    '--mount',
    `type=bind,src=${root}/tls/cert.pem,dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
    '--mount',
    `type=bind,src=${store},dst=/var/lib/native-coding`,
    ...nodeModules.flatMap((dir) => ['--mount', `type=bind,src=${dir},dst=${dir},readonly`]),
    '-e',
    `NATIVE_TEST_ROOT=${root}`,
    '-e',
    `NATIVE_TEST_REPO=${repo}`,
    '-e',
    `NATIVE_TEST_PG_SOCKET=${socket}`,
    '-e',
    `NATIVE_TEST_PASSWORD_FILE=${password}`,
    '--entrypoint',
    'node',
    image,
    `${root}/fixture/vertical.mjs`,
    phase,
  ];
  run('docker', args, { log: `${phase}.log`, timeout: 300000 });
}

async function snapshot(socket) {
  const pool = new Pool({ host: socket, user: 'postgres', database: 'native_answer', max: 1 });
  try {
    const sessions = (
      await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='native_answer'",
      )
    ).rows[0].n;
    assert.equal(sessions, 0, 'runtime database sessions must end before backup or inspection');
    const tables = (
      await pool.query(
        "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('framework','native_agents') ORDER BY 1,2",
      )
    ).rows;
    const rows = {};
    for (const { schemaname, tablename } of tables) {
      const ident = `"${schemaname}"."${tablename.replaceAll('"', '""')}"`;
      const data = (
        await pool.query(
          `SELECT to_jsonb(t)::text AS v FROM ${ident} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
        )
      ).rows.map((r) => r.v);
      rows[`${schemaname}.${tablename}`] = {
        count: data.length,
        sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      };
    }
    const catalog = {};
    for (const [key, sql] of Object.entries({
      schemas:
        "SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl,obj_description(oid,'pg_namespace') AS seal FROM pg_namespace WHERE nspname IN ('framework','native_agents','public') ORDER BY 1",
      relations:
        "SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('framework','native_agents') ORDER BY 1,2",
      columns:
        "SELECT n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attacl,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname IN ('framework','native_agents') AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,a.attnum",
      constraints:
        "SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('framework','native_agents') ORDER BY 1,2,3",
      indexes:
        "SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('framework','native_agents') ORDER BY 1,2,3",
      defaults:
        'SELECT pg_get_userbyid(defaclrole) AS owner,n.nspname,defaclobjtype,defaclacl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY 1,2,3',
      database:
        'SELECT datname,pg_get_userbyid(datdba) AS owner,datacl FROM pg_database WHERE datname=current_database()',
      role: "SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='native_answer'",
    }))
      catalog[key] = (await pool.query(sql)).rows;
    return { rows, catalog };
  } finally {
    await pool.end();
  }
}

/** GNU tar in the image: sparse, PAX, ACLs, xattrs and numeric owners. */
function workspaceTar(mount, member, file, name) {
  const dir = path.dirname(file);
  run(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      `${prefix}-${name}`,
      '--label',
      label,
      '--network',
      'none',
      '--mount',
      `type=bind,src=${mount},dst=/source,readonly`,
      '--mount',
      `type=bind,src=${dir},dst=/out`,
      '--entrypoint',
      'tar',
      image,
      '--create',
      '--sparse',
      '--sort=name',
      '--format=pax',
      '--pax-option=delete=atime,delete=ctime',
      '--acls',
      '--xattrs',
      '--numeric-owner',
      '--file',
      `/out/${path.basename(file)}`,
      '--directory',
      '/source',
      member,
    ],
    { log: `${name}.log` },
  );
  return sha256(file);
}

async function codingSuite() {
  await prepareImageRun();
  const socket = socketDir('pg-source');
  await startPg(`${prefix}-pg`, { socket, hba: path.join(root, 'pg_hba.conf') });
  const store = mkdir(path.join(root, 'source/native-coding'));
  const target = { socket, password: path.join(root, 'runtime-secret'), store };
  for (const phase of [
    'provision',
    'answer-only',
    'coding-compose',
    'coding-files',
    'coding-files-cold',
    'coding-files-unknown',
  ])
    imagePhase(phase, target);
  imageCodeMode();
}

/** The phases above load the host's node_modules. This one uses only the
 * image's own production install: it must ship the isolated-vm addon for the
 * image's Node and architecture, and set NODE_OPTIONS=--no-node-snapshot. */
function imageCodeMode() {
  const script = `
    import { createCodeMode, createTool } from '@mastra/core/tools';
    import { IsolatedVmCodeModeTransport } from '@mastra/isolated-vm';
    import { z } from 'zod';
    const read = createTool({ id: 'read', description: 'read', inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ n: n * 2 }) });
    const { tool } = createCodeMode({ tools: { read }, timeout: 5000 },
      new IsolatedVmCodeModeTransport({ memoryLimitMb: 16 }));
    const out = await tool.execute({ code: 'return (await external_read({ n: 21 })).n;' }, {});
    console.log(JSON.stringify(out));`;
  const output = run(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      `${prefix}-image-code-mode`,
      '--label',
      label,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--workdir',
      '/app/apps/agent',
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-e',
      script,
    ],
    { log: 'image-code-mode.log' },
  );
  const result = JSON.parse(output.trim().split('\n').at(-1));
  const tests = [
    {
      name: 'image-production-install-runs-code-mode-in-isolated-vm',
      status: result.success === true && result.result === 42 ? 'pass' : 'fail',
      detail: result,
    },
  ];
  fs.writeFileSync(path.join(root, 'image-code-mode.json'), JSON.stringify({ tests }, null, 2));
  assert.equal(tests[0].status, 'pass', 'image Code Mode failed');
}

async function backupSuite() {
  await prepareImageRun();
  const hba = path.join(root, 'pg_hba.conf');
  const source = {
    socket: socketDir('pg-source'),
    password: path.join(root, 'runtime-secret'),
    store: mkdir(path.join(root, 'source/native-coding')),
  };
  const sourcePg = `${prefix}-source-pg`;
  await startPg(sourcePg, { socket: source.socket, hba });
  for (const phase of ['provision', 'backup-source', 'coding-files', 'coding-backup-source'])
    imagePhase(phase, source);

  // Every writer has stopped with its fixture container. Snapshot, dump, recheck.
  const out = mkdir(path.join(root, 'backup'));
  const before = await snapshot(source.socket);
  fs.writeFileSync(path.join(out, 'source-before.json'), JSON.stringify(before, null, 2));
  const archive = path.join(out, 'native-answer.dump');
  const fd = fs.openSync(archive, 'wx', 0o600);
  try {
    run(
      'docker',
      [
        'exec',
        sourcePg,
        'pg_dump',
        '-h',
        '/socket',
        '-U',
        'postgres',
        '--dbname=native_answer',
        '--format=custom',
      ],
      { stdout: fd },
    );
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(
    `${archive}.toc`,
    run('docker', ['exec', '-i', sourcePg, 'pg_restore', '--list'], {
      input: fs.readFileSync(archive),
    }),
  );
  assert.deepEqual(await snapshot(source.socket), before, 'source changed while dumping');
  const workspace = path.join(out, 'coding-workspace.tar');
  const workspaceSha = workspaceTar(
    path.join(root, 'source'),
    'native-coding',
    workspace,
    'tar-source',
  );
  const recheck = workspaceTar(
    path.join(root, 'source'),
    'native-coding',
    path.join(out, 'coding-workspace-recheck.tar'),
    'tar-recheck',
  );
  assert.equal(recheck, workspaceSha, 'source workspace changed while archiving');
  docker('stop', sourcePg);

  // Fresh destination: new cluster, a new runtime login with a fresh secret, then restore.
  const restore = {
    socket: socketDir('pg-restore'),
    password: path.join(root, 'restore-runtime-secret'),
    store: path.join(root, 'restore/native-coding'),
  };
  const restorePg = `${prefix}-restore-pg`;
  await startPg(restorePg, { socket: restore.socket, hba });
  const cluster = new Pool({
    host: restore.socket,
    user: 'postgres',
    database: 'postgres',
    max: 1,
  });
  try {
    assert.equal(
      (await cluster.query("SELECT 1 FROM pg_database WHERE datname='native_answer'")).rowCount,
      0,
    );
    const sql = (
      await cluster.query(
        "SELECT format('CREATE ROLE native_answer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',$1::text) AS sql",
        [fs.readFileSync(restore.password, 'utf8').trim()],
      )
    ).rows[0].sql;
    await cluster.query(sql);
  } finally {
    await cluster.end();
  }
  run(
    'docker',
    [
      'exec',
      '-i',
      restorePg,
      'pg_restore',
      '-h',
      '/socket',
      '-U',
      'postgres',
      '--dbname=postgres',
      '--create',
      '--exit-on-error',
      '--verbose',
    ],
    { input: fs.readFileSync(archive), log: 'pg-restore.log' },
  );
  const restored = await snapshot(restore.socket);
  fs.writeFileSync(
    path.join(out, 'restored-before-runtime.json'),
    JSON.stringify(restored, null, 2),
  );
  assert.deepEqual(restored, before, 'restored rows or catalog differ');
  const script = run('docker', ['exec', '-i', restorePg, 'pg_restore', '--file=-'], {
    input: fs.readFileSync(archive),
  });
  for (const file of ['runtime-secret', 'restore-runtime-secret'])
    assert(
      !script.includes(fs.readFileSync(path.join(root, file), 'utf8').trim()),
      'archive holds a credential',
    );
  assert(!/CREATE ROLE|ALTER ROLE|PASSWORD/.test(script), 'archive holds roles or passwords');

  mkdir(path.join(root, 'restore'));
  run(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      `${prefix}-untar`,
      '--label',
      label,
      '--network',
      'none',
      '--mount',
      `type=bind,src=${out},dst=/backup,readonly`,
      '--mount',
      `type=bind,src=${root}/restore,dst=/restore`,
      '--entrypoint',
      'tar',
      image,
      '--extract',
      '--acls',
      '--xattrs',
      '--same-owner',
      '--numeric-owner',
      '--file',
      `/backup/${path.basename(workspace)}`,
      '--directory',
      '/restore',
    ],
    { log: 'untar.log' },
  );
  const restoredSha = workspaceTar(
    path.join(root, 'restore'),
    'native-coding',
    path.join(out, 'coding-workspace-restored.tar'),
    'tar-restored',
  );
  assert.equal(restoredSha, workspaceSha, 'restored workspace differs');

  for (const phase of ['backup-restore', 'coding-backup-restore']) imagePhase(phase, restore);
  summary.backup = {
    archiveSha256: sha256(archive),
    workspaceSha256: workspaceSha,
    tables: Object.keys(before.rows).length,
    rows: Object.values(before.rows).reduce((n, r) => n + r.count, 0),
    rowsAndCatalogEqual: true,
    workspaceEqual: true,
  };
}

// --- telemetry: maintenance entrypoint in the image, checks on the host -----

async function telemetrySuite() {
  const imageId = docker('image', 'inspect', image, '--format', '{{.Id}}').trim();
  summary.image = { name: image, id: imageId };
  const socket = socketDir('socket');
  mkdir(path.join(root, 'native'), 0o755);
  await bundle(
    { telemetry: 'apps/agent/src/bootstrap/telemetry.ts' },
    path.join(root, 'native'),
    true,
  );
  linkExternals(await bundle({ fixture: 'apps/agent/test/telemetry-postgres.ts' }, root, true), [
    'apps/agent',
    '',
  ]);
  const { host, port } = await startPg(`${prefix}-pg`, {
    tcp: true,
    socket,
    hba: path.join(repo, 'deploy/docker/native-answer-pg-hba.conf'),
  });
  const env = {
    PATH: process.env.PATH,
    NATIVE_TEST_ROOT: root,
    NATIVE_TEST_PG_SOCKET: socket,
    NATIVE_TEST_PG_HOST: host,
    NATIVE_TEST_PG_PORT: port,
  };
  const fixture = (phase) =>
    run(process.execPath, [path.join(root, 'fixture.mjs'), phase], { env, log: `${phase}.log` });
  fixture('setup');
  // The image's telemetry maintenance entrypoint over the Unix socket only.
  const maintenance = `${prefix}-maintenance`;
  docker(
    'run',
    '-d',
    '--pull=never',
    '--name',
    maintenance,
    '--label',
    label,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=4m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    '192m',
    '--mount',
    `type=bind,src=${root}/native,dst=/app/apps/agent/dist/native,readonly`,
    '--mount',
    `type=bind,src=${socket},dst=/socket`,
    '--mount',
    `type=bind,src=${root}/telemetry-password,dst=/run/secrets/telemetry-password,readonly`,
    '-e',
    'NATIVE_PG_SOCKET=/socket',
    '-e',
    'NATIVE_OBSERVABILITY_PASSWORD_FILE=/run/secrets/telemetry-password',
    image,
    'telemetry',
  );
  pgs.push(maintenance);
  for (let attempt = 0; ; attempt++) {
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', maintenance));
    if (!state.Running) throw new Error('telemetry maintenance exited; see its log');
    if (
      spawnSync('docker', ['exec', maintenance, 'test', '-f', '/tmp/telemetry-ready']).status === 0
    )
      break;
    if (attempt > 60) throw new Error('telemetry maintenance readiness timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
  fixture('qualify');
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  assert.equal(result.outcome, 'pass');
  summary.telemetry = result.counts;
  records = result.checks.length;
}

// --- tools: real cli-runtime and egress images against a fake HTTPS upstream --

/** The fake upstream's host names (its network aliases and certificate names). */
const TOOLS_UPSTREAM_HOSTS = [
  'gitlab.example.com',
  'gitlab-unapproved.example.com',
  'api.atlassian.com',
  'mcp.datadoghq.eu',
  'api.cloudflare.com',
  'slack.com',
];
/** Synthetic tool credentials of one run: random, shaped like no real token. */
let toolCredentials = null;

/** Starts a container of the tools suite; secrets travel by `-e NAME` from `env`, never argv. */
function toolsContainer(name, image, { network, aliases = [], user, args = [], env = {}, opts }) {
  run(
    'docker',
    [
      'create',
      '--pull=never',
      '--name',
      name,
      '--label',
      label,
      '--network',
      network,
      ...aliases.flatMap((alias) => ['--network-alias', alias]),
      ...(user ? ['--user', user] : []),
      '--read-only',
      '--security-opt',
      'no-new-privileges:true',
      '--log-opt',
      'max-size=1m',
      ...opts,
      ...Object.keys(env).flatMap((key) => ['-e', key]),
      image,
      ...args,
    ],
    { env: { ...process.env, ...env } },
  );
  pgs.push(name);
}

async function toolsSuite() {
  const runtimeImage = `support-agent/cli-runtime:${tag}`;
  const egressImage = `support-agent/egress:${tag}`;
  summary.images = Object.fromEntries(
    [
      ['cliRuntime', runtimeImage],
      ['egress', egressImage],
    ].map(([key, name]) => [
      key,
      { name, id: docker('image', 'inspect', name, '--format', '{{.Id}}').trim() },
    ]),
  );
  const user = `${process.getuid()}:${process.getgid()}`;
  const privateDir = mkdir(path.join(root, 'private'), 0o700);
  const random = () => randomBytes(18).toString('hex');
  toolCredentials = {
    gitlab: random(),
    gitlabUnapproved: random(),
    gitlabBlocked: random(),
    jira: random(),
    confluence: random(),
    datadog: random(),
    cloudflare: random(),
    // The Slack provider accepts only a bot-token shape.
    slack: `xoxb-${random()}`,
  };
  const credentialFile = path.join(privateDir, 'credentials.json');
  fs.writeFileSync(credentialFile, JSON.stringify(toolCredentials), { mode: 0o600 });
  const runtimeToken = random();
  const adminToken = random();

  // A per-run CA and a leaf certificate for every upstream host name.
  const tls = mkdir(path.join(root, 'tls'), 0o755);
  const caKey = path.join(privateDir, 'ca.key');
  const ca = path.join(tls, 'ca.pem');
  const key = path.join(privateDir, 'upstream.key');
  const cert = path.join(tls, 'upstream.pem');
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      ca,
      '-days',
      '2',
      '-subj',
      '/CN=Support Agent tools suite CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
    ],
    { log: 'tls-ca.log' },
  );
  run(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      path.join(privateDir, 'upstream.csr'),
      '-subj',
      '/CN=Support Agent tools suite upstream',
    ],
    { log: 'tls-csr.log' },
  );
  fs.writeFileSync(
    path.join(privateDir, 'upstream.ext'),
    `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${TOOLS_UPSTREAM_HOSTS.map((h) => `DNS:${h}`).join(',')}\n`,
  );
  run(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      path.join(privateDir, 'upstream.csr'),
      '-CA',
      ca,
      '-CAkey',
      caKey,
      '-set_serial',
      `0x${randomBytes(8).toString('hex')}`,
      '-days',
      '2',
      '-extfile',
      path.join(privateDir, 'upstream.ext'),
      '-out',
      cert,
    ],
    { log: 'tls-sign.log' },
  );
  fs.chmodSync(ca, 0o644);

  mkdir(path.join(root, 'fixture'), 0o755);
  linkExternals(
    await bundle(
      { vertical: 'tests/integration/mastra/native-tools-vertical.ts' },
      path.join(root, 'fixture'),
      true,
    ),
    ['apps/agent', 'apps/admin', ''],
  );
  const mounts = [
    '--mount',
    `type=bind,src=${root},dst=${root}`,
    ...nodeModules.flatMap((dir) => ['--mount', `type=bind,src=${dir},dst=${dir},readonly`]),
  ];
  const fixtureEnv = { NATIVE_TEST_ROOT: root, NATIVE_TEST_CREDENTIALS: credentialFile };

  // Two internal networks: tools (agent side, CLI runtime, egress) and the
  // proxy's outbound side, where only the fake upstream answers.
  const toolsNet = `${prefix}-tools`;
  const outboundNet = `${prefix}-outbound`;
  for (const net of [toolsNet, outboundNet]) {
    docker('network', 'create', '--internal', '--label', label, net);
    networks.push(net);
  }
  const toolsSubnet = docker(
    'network',
    'inspect',
    toolsNet,
    '--format',
    '{{(index .IPAM.Config 0).Subnet}}',
  ).trim();
  summary.toolsSubnet = toolsSubnet;

  const upstream = `${prefix}-upstream`;
  toolsContainer(upstream, runtimeImage, {
    network: outboundNet,
    aliases: TOOLS_UPSTREAM_HOSTS,
    user,
    args: [`${root}/fixture/vertical.mjs`, 'upstream'],
    env: { ...fixtureEnv, NATIVE_TEST_TLS_KEY: key, NATIVE_TEST_TLS_CERT: cert },
    opts: [
      '--entrypoint',
      'node',
      '--cap-drop',
      'ALL',
      '--sysctl',
      'net.ipv4.ip_unprivileged_port_start=0',
      '--tmpfs',
      '/tmp:rw,size=8m',
      '--memory',
      '128m',
      ...mounts,
    ],
  });
  docker('start', upstream);

  // The egress proxy as Compose runs it: tools policy by source subnet.
  const egress = `${prefix}-egress`;
  toolsContainer(egress, egressImage, {
    network: toolsNet,
    aliases: ['egress-tools'],
    env: {
      SUPPORT_AGENT_TOOLS_SUBNET: toolsSubnet,
      GITLAB_HOSTS: 'gitlab.example.com',
      ATLASSIAN_SITES: 'support-agent-test.atlassian.net',
      DATADOG_SITES: 'datadoghq.eu',
      CLOUDFLARE_HOSTS: 'api.cloudflare.com',
    },
    opts: ['--init', '--cap-drop', 'ALL', '--memory', '128m'],
  });
  docker('network', 'connect', outboundNet, egress);
  docker('start', egress);

  // The agent side and the synthetic settings service (alias `admin`).
  const client = `${prefix}-client`;
  toolsContainer(client, runtimeImage, {
    network: toolsNet,
    aliases: ['admin'],
    user,
    args: [`${root}/fixture/vertical.mjs`, 'client'],
    env: {
      ...fixtureEnv,
      NATIVE_TEST_RUNTIME_TOKEN: runtimeToken,
      NATIVE_TEST_ADMIN_TOKEN: adminToken,
    },
    opts: [
      '--entrypoint',
      'node',
      '--cap-drop',
      'ALL',
      '--tmpfs',
      '/tmp:rw,size=16m',
      '--memory',
      '384m',
      ...mounts,
    ],
  });

  // The CLI runtime as Compose runs it, plus the run's CA as a trusted root.
  const runtime = `${prefix}-cli-runtime`;
  const caInImage = '/etc/ssl/certs/support-agent-tools-suite-ca.pem';
  toolsContainer(runtime, runtimeImage, {
    network: toolsNet,
    aliases: ['cli-runtime'],
    env: {
      CLI_RUNTIME_PORT: '9877',
      CLI_RUNTIME_TOKEN: runtimeToken,
      ADMIN_URL: 'http://admin:9883',
      ADMIN_INTERNAL_TOKEN: adminToken,
      EGRESS_PROXY_URL: 'http://egress-tools:3128',
      // The runtime admits the unapproved host; only the proxy refuses it.
      GITLAB_HOSTS: 'gitlab.example.com,gitlab-unapproved.example.com',
      ATLASSIAN_SITES: 'support-agent-test.atlassian.net',
      DATADOG_SITES: 'datadoghq.eu',
      CLOUDFLARE_HOSTS: 'api.cloudflare.com',
      NODE_EXTRA_CA_CERTS: caInImage,
    },
    opts: [
      '--init',
      '--cap-drop',
      'ALL',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=64m',
      '--memory',
      '256m',
      '--pids-limit',
      '128',
      '--mount',
      `type=bind,src=${ca},dst=${caInImage},readonly`,
    ],
  });
  docker('start', client);
  docker('start', runtime);

  const wait = spawnSync('docker', ['wait', client], { encoding: 'utf8', timeout: 120000 });
  const code = Number(wait.stdout?.trim());
  fs.writeFileSync(path.join(root, 'client.out'), run('docker', ['logs', client]));
  if (code !== 0) throw new Error(`tools client exited ${wait.stdout?.trim() || wait.error}`);

  // The proxy's own record of the refusals.
  const decisions = run('docker', ['logs', egress])
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const denied = (host) =>
    decisions.some((d) => d.event === 'denied' && d.reason === 'host' && d.host === host);
  const post = [];
  const record = (name, fn) => {
    try {
      post.push({ name, status: 'pass', detail: fn() });
    } catch (e) {
      post.push({ name, status: 'fail', detail: String(e) });
    }
  };
  record('egress-log-records-each-refused-host', () => {
    assert(denied('gitlab-unapproved.example.com'), 'no denial of the unapproved GitLab host');
    assert(denied('example.org'), 'no denial of example.org');
    assert(
      !decisions.some((d) => d.event === 'denied' && d.host === 'gitlab.example.com'),
      'the approved GitLab host was denied',
    );
    return { denied: decisions.filter((d) => d.event === 'denied').length };
  });
  fs.writeFileSync(
    path.join(root, 'post-checks.json'),
    JSON.stringify({ suite: 'tools', tests: post }, null, 2),
  );
  if (post.some((t) => t.status !== 'pass')) throw new Error('tools post-checks failed');
}

try {
  reserve();
  if (suite === 'discovery' || suite === 'application') await inProcessSuite();
  else if (suite === 'coding') await codingSuite();
  else if (suite === 'backup') await backupSuite();
  else if (suite === 'tools') await toolsSuite();
  else await telemetrySuite();
  if (suite !== 'telemetry') records = countRecords();
} catch (e) {
  failed = true;
  fs.writeFileSync(path.join(root, 'failure.txt'), String(e?.stack ?? e));
  console.error(String(e));
} finally {
  // Reverse start order: clients stop before their database.
  for (const name of pgs.toReversed()) {
    try {
      const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
      if (state.Running && name.endsWith('-pg')) {
        const dump = run('docker', [
          'exec',
          name,
          'pg_dumpall',
          '--no-role-passwords',
          '-U',
          'postgres',
        ]);
        const compressed = gzipSync(dump);
        fs.writeFileSync(path.join(root, `${name}.sql.gz`), compressed, { mode: 0o600 });
        fs.writeFileSync(
          path.join(root, `${name}.sha256`),
          createHash('sha256').update(compressed).digest('hex') + '\n',
        );
      }
      fs.writeFileSync(path.join(root, `${name}.log`), run('docker', ['logs', name]));
      if (state.Running) docker('stop', name);
      const c = JSON.parse(docker('inspect', '--size', name))[0];
      fs.writeFileSync(
        path.join(root, `${name}.container.json`),
        JSON.stringify(
          { id: c.Id, image: c.Image, state: c.State, mounts: c.Mounts, sizeRw: c.SizeRw },
          null,
          2,
        ),
      );
    } catch (e) {
      failed = true;
      fs.appendFileSync(path.join(root, 'retention-failure.txt'), `${name}: ${e}\n`);
    }
  }
  // Networks are a scarce address pool: the stopped containers leave them,
  // and their configuration stays in each *.container.json.
  for (const net of networks)
    try {
      const attached = docker(
        'network',
        'inspect',
        net,
        '--format',
        '{{range .Containers}}{{.Name}} {{end}}',
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const name of attached) docker('network', 'disconnect', '--force', net, name);
      docker('network', 'rm', net);
    } catch (e) {
      fs.appendFileSync(path.join(root, 'retention-failure.txt'), `network ${net}: ${e}\n`);
    }
  if (summary.toolsSubnet) summary.networksRemoved = networks;
  // No retained file may hold a tool credential; then the synthetic
  // credentials, the CA key and the upstream key are deleted.
  if (toolCredentials !== null) {
    const privateDir = path.join(root, 'private');
    const scan = credentialHits(root, toolCredentials, [privateDir]);
    const pass = scan.hits.length === 0;
    fs.writeFileSync(
      path.join(root, 'credential-scan.json'),
      JSON.stringify(
        {
          suite,
          tests: [
            {
              name: 'no-credential-in-retained-evidence',
              status: pass ? 'pass' : 'fail',
              detail: scan,
            },
          ],
        },
        null,
        2,
      ),
    );
    summary.credentialScan = { files: scan.files, hits: scan.hits.length };
    if (pass) records += failed ? 0 : 1;
    else failed = true;
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
  // Root-run containers leave root-owned files; return them to the caller.
  if (image && fs.existsSync(root))
    try {
      run('docker', [
        'run',
        '--rm',
        '--pull=never',
        '--network',
        'none',
        '--mount',
        `type=bind,src=${root},dst=/run-folder`,
        '--entrypoint',
        'chown',
        image,
        '-R',
        '--no-dereference',
        `${process.getuid()}:${process.getgid()}`,
        '/run-folder',
      ]);
    } catch (e) {
      fs.appendFileSync(path.join(root, 'retention-failure.txt'), `chown: ${e}\n`);
    }
  const seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(
    path.join(root, 'summary.json.tmp'),
    JSON.stringify(
      {
        passed: !failed,
        suite,
        seconds,
        records,
        containers: pgs,
        volumes,
        pgImage,
        ...summary,
        retention: 'No cleanup. Containers and volumes stay stopped.',
      },
      null,
      2,
    ),
  );
  fs.renameSync(path.join(root, 'summary.json.tmp'), path.join(root, 'summary.json'));
  console.log(
    `Native ${suite} suite ${failed ? 'FAILED' : 'passed'}: ${records} test records, ${seconds} s. Evidence: ${root}`,
  );
}
process.exitCode = failed ? 1 : 0;
