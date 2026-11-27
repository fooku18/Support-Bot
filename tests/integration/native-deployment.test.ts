import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_SETTING_NAMES,
  parseModelCatalog,
} from '../../apps/agent/src/contracts/model-catalog.js';
// @ts-expect-error operational JavaScript
import { parseModelCatalog as deploymentCatalog } from '../../deploy/lib/model-catalog.mjs';
// @ts-expect-error operational JavaScript
import { deployment } from '../../deploy/lib/native-deployment.mjs';
// @ts-expect-error operational JavaScript
import { checkEnvParity } from '../../scripts/env-parity.mjs';
import { fakeDockerImport } from './fake-docker.js';

const repo = process.cwd();
const root = path.join(repo, 'artifacts', 'native-deployment', randomUUID());
fs.mkdirSync(root, { recursive: true });
function fixture() {
  const dir = path.join(root, randomUUID());
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'admin-store'));
  fs.writeFileSync(path.join(dir, 'runtime'), 'synthetic');
  fs.writeFileSync(path.join(dir, 'gateway'), 'synthetic');
  const env: Record<string, string> = {
    COMPOSE_PROJECT_NAME: 'native-test',
    SUPPORT_AGENT_INSTANCE: 'test',
    NATIVE_IMAGE_TAG: 'test',
    NATIVE_FRONTEND_SUBNET: '172.30.10.0/24',
    NATIVE_TOOLS_SUBNET: '172.30.11.0/24',
    NATIVE_DB_SUBNET: '172.30.12.0/24',
    SUPPORT_AGENT_SERVICE_TOKEN: 'synthetic-service',
    ADMIN_INTERNAL_TOKEN: 'synthetic-admin',
    CLI_RUNTIME_TOKEN: 'synthetic-tool',
    SLACK_APP_TOKEN: 'synthetic-slack',
    MODEL_CATALOG: JSON.stringify([{ key: 'small', route: 'anthropic', model: 'model' }]),
    MODEL_DEFAULT_KEY: 'small',
    GITLAB_HOSTS: 'gitlab.test.invalid',
    ADMIN_PUBLIC_URL: 'https://admin.test.invalid',
    ADMIN_HOST_PORT: '9883',
    ADMIN_STORE_DIR: path.join(dir, 'admin-store'),
    ADMIN_STORE_KEY: 'a'.repeat(64),
    ADMIN_SESSION_KEY: 'b'.repeat(64),
    SLACK_CLIENT_ID: 'synthetic-client',
    SLACK_CLIENT_SECRET: 'synthetic-secret',
    NATIVE_RUNTIME_PASSWORD_FILE: path.join(dir, 'runtime'),
    NATIVE_ANTHROPIC_API_KEY_FILE: path.join(dir, 'gateway'),
  };
  const save = () =>
    fs.writeFileSync(
      path.join(dir, '.env.testing'),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
  save();
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ runtime: 'native-answer', idle: true, admitted: 0, waits: [] }),
  );
  fs.writeFileSync(
    path.join(dir, 'services.json'),
    JSON.stringify([
      {
        Id: 'owned',
        Config: { Labels: { 'com.docker.compose.service': 'native-answer' } },
        State: { Running: true },
      },
    ]),
  );
  fs.writeFileSync(
    path.join(dir, 'docker.cjs'),
    `const fs=require('fs'),root=__dirname,a=process.argv.slice(2);
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify({args:a,env:Object.keys(process.env),stub:process.env.NATIVE_MODEL_STUB})+String.fromCharCode(10));
if(a[0]==='ps') console.log('owned');
else if(a[0]==='inspect') console.log(fs.readFileSync(root+'/services.json','utf8'));
else if(a.includes('exec')) console.log(fs.readFileSync(root+'/state.json','utf8'));
if(a.includes('up')&&fs.existsSync(root+'/up-stderr.txt')){process.stderr.write(fs.readFileSync(root+'/up-stderr.txt','utf8'));process.exit(1);}
`,
  );
  const run = (script: string, args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', fakeDockerImport, path.join(repo, 'scripts', script), ...args],
      {
        env: {
          FAKE_DOCKER: path.join(dir, 'docker.cjs'),
          DOCKER_HOST: 'tcp://127.0.0.1:9',
          NATIVE_IMAGE_TAG: 'ambient-wrong',
          SUPPORT_AGENT_SERVICE_TOKEN: 'ambient-private',
          Compose_File: 'ambient-compose',
          native_model_stub: '1',
          SERVICE_TOKEN: 'ambient-passthrough',
          HOST_TOOLING_DIR: 'ambient-host',
        },
        encoding: 'utf8',
      },
    );
  const calls = (): Array<{ args: string[]; env: string[]; stub?: string }> =>
    fs.existsSync(path.join(dir, 'calls.jsonl'))
      ? fs
          .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return {
    dir,
    env,
    save,
    run,
    calls,
    marker: path.join(dir, 'artifacts/deploy-drain/native-test.json'),
  };
}
describe('native deployment conversion', () => {
  it('selects only active connection overlays and mounts them in execution only', () => {
    const f = fixture();
    f.env.MODEL_CATALOG = JSON.stringify([
      { key: 'gpt', route: 'openai', model: 'gpt-5' },
      { key: 'gcp-claude', route: 'vertex-claude', model: 'claude-sonnet@20250514' },
      { key: 'gemini', route: 'vertex-gemini', model: 'gemini-2.5-pro' },
    ]);
    f.env.MODEL_DEFAULT_KEY = 'gpt';
    f.env.NATIVE_ANTHROPIC_API_KEY_FILE = '';
    f.env.NATIVE_OPENAI_API_KEY_FILE = path.join(f.dir, 'synthetic-openai');
    f.env.NATIVE_VERTEX_CREDENTIALS_FILE = path.join(f.dir, 'synthetic-vertex');
    f.env.NATIVE_VERTEX_PROJECT = 'fixture-project';
    f.env.NATIVE_VERTEX_LOCATION = 'europe-west1';
    for (const file of [f.env.NATIVE_OPENAI_API_KEY_FILE, f.env.NATIVE_VERTEX_CREDENTIALS_FILE])
      fs.writeFileSync(file, 'synthetic');
    f.save();
    expect(deploymentCatalog(f.env.MODEL_CATALOG, f.env.MODEL_DEFAULT_KEY)).toEqual(
      parseModelCatalog(f.env.MODEL_CATALOG, f.env.MODEL_DEFAULT_KEY),
    );
    const result = f.run('test-stack.mjs', ['ps', '--instance-dir', f.dir]);
    expect(result.status, result.stderr).toBe(0);
    const args = f.calls().find((call) => call.args[0] === 'compose')!.args;
    for (const route of ['openai', 'vertex'])
      expect(args).toContain(path.join(repo, `deploy/compose.model-${route}.yaml`));
    expect(args).not.toContain(path.join(repo, 'deploy/compose.model-anthropic.yaml'));
    for (const connection of ['anthropic', 'openai', 'vertex']) {
      const overlay = parse(
        fs.readFileSync(path.join(repo, `deploy/compose.model-${connection}.yaml`), 'utf8'),
      );
      expect(Object.keys(overlay.services)).toEqual(['native-answer']);
      expect(overlay.services['native-answer'].secrets).toHaveLength(1);
      expect(Object.keys(overlay.secrets)).toEqual(overlay.services['native-answer'].secrets);
    }
    const base = parse(fs.readFileSync(path.join(repo, 'deploy/compose.yaml'), 'utf8'));
    for (const [service, config] of Object.entries<Record<string, unknown>>(base.services)) {
      for (const name of Object.keys(config.environment ?? {})) {
        if (!MODEL_SETTING_NAMES.some((setting) => setting === name)) continue;
        expect(['native-answer', 'admin', 'egress']).toContain(service);
        expect(name.endsWith('_FILE')).toBe(false);
      }
    }
    for (const service of ['native-answer', 'egress'])
      expect(base.services[service].environment.NATIVE_ANTHROPIC_BASE_URL).toBe(
        '${NATIVE_ANTHROPIC_BASE_URL:-}',
      );
  });

  it('requires complete isolated fetch transport configuration and selects its private overlay', () => {
    const f = fixture();
    f.env.NATIVE_WEB_RUNTIME_URL = 'http://test-web-runtime:9876';
    f.save();
    expect(f.run('test-stack.mjs', ['ps', '--instance-dir', f.dir]).status).toBe(2);
    expect(f.calls()).toHaveLength(0);
    f.env.WEB_RUNTIME_TOKEN = 'synthetic-test-web';
    f.env.NATIVE_WEB_NETWORK = 'test-webapi';
    f.save();
    const result = f.run('test-stack.mjs', ['ps', '--instance-dir', f.dir]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      f
        .calls()
        .filter((c) => c.args[0] === 'compose')
        .every((c) => c.args.includes(path.join(repo, 'deploy/compose.web-fetch.yaml'))),
    ).toBe(true);
    const c = parse(fs.readFileSync('deploy/compose.web-fetch.yaml', 'utf8'));
    expect(c.services['native-answer'].networks).toEqual({ webapi: {} });
    expect(c.networks.webapi.external).toBe(true);
  });
  it('validates subnets, the settings store and the public settings origin before Docker', () => {
    for (const [key, value] of [
      ['NATIVE_TOOLS_SUBNET', '172.30.10.0/24'],
      ['NATIVE_DB_SUBNET', 'not-a-subnet'],
      ['ADMIN_STORE_DIR', '/synthetic/missing-store'],
      ['ADMIN_PUBLIC_URL', 'http://admin.test.invalid'],
      ['ADMIN_HOST_PORT', '70000'],
      ['SLACK_CLIENT_SECRET', '<operator: client secret>'],
    ] as Array<[string, string]>) {
      const f = fixture();
      f.env[key] = value;
      f.save();
      const r = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir]);
      expect(r.status, key).toBe(2);
      expect(r.stderr, key).toContain(key);
      expect(f.calls()).toEqual([]);
    }
  });
  it('selects only native application services', () => {
    const c = parse(fs.readFileSync('deploy/compose.yaml', 'utf8'));
    expect(Object.keys(c.services).sort()).toEqual([
      'adapter',
      'admin',
      'egress',
      'model-stub',
      'native-answer',
      'native-cli-runtime',
      'native-postgres',
      'native-provision',
    ]);
    expect(c.services.adapter.environment.NATIVE_APPLICATION_URL).toBe('http://native-answer:9879');
    expect(c.services['native-provision'].profiles).toEqual(['maintenance']);
    // The model stub: tools network only, no route out, no ports, no secrets.
    const stub = c.services['model-stub'];
    expect(stub.profiles).toEqual(['stub']);
    expect(stub.build.target).toBe('model-stub');
    expect(stub.networks).toEqual(['tools']);
    expect(stub.read_only).toBe(true);
    expect(stub.cap_drop).toEqual(['ALL']);
    expect(stub.ports).toBeUndefined();
    expect(stub.secrets).toBeUndefined();
    expect(JSON.stringify(stub.healthcheck.test)).toContain('/healthz');
    expect(c.services['native-answer'].environment.NATIVE_CODING_STORE).toBe(
      '/var/lib/native-coding',
    );
    expect(c.services['native-answer'].environment).not.toHaveProperty('NATIVE_TEMPLATE');
    expect(c.networks.nativedb.internal).toBe(true);
    expect(c.networks.frontend.internal).toBe(true);
    expect(c.networks.tools.internal).toBe(true);
    // Only the egress proxy reaches the internet; the agent and CLI runtime
    // tunnel through its tools-only alias, the adapter through its frontend alias.
    expect(c.services.egress.networks.outbound).toEqual({});
    for (const name of ['native-answer', 'native-cli-runtime', 'adapter', 'native-postgres'])
      expect(JSON.stringify(c.services[name].networks)).not.toContain('outbound');
    expect(c.services['native-answer'].environment.EGRESS_PROXY_URL).toBe(
      'http://egress-tools:3128',
    );
    expect(c.services['native-cli-runtime'].environment.EGRESS_PROXY_URL).toBe(
      'http://egress-tools:3128',
    );
    // The CLI runtime needs no privilege: every tool is an HTTPS call from Node.
    expect(c.services['native-cli-runtime'].cap_drop).toEqual(['ALL']);
    expect(c.services['native-cli-runtime'].cap_add).toBeUndefined();
    expect(c.services['native-cli-runtime'].security_opt).toEqual(['no-new-privileges:true']);
    expect(c.services['native-cli-runtime'].user).toBeUndefined();
    expect(c.services.adapter.environment.EGRESS_PROXY_URL).toBe('http://egress:3128');
    expect(c.services.egress.networks.tools.aliases).toEqual(['egress-tools']);
    expect(c.services.admin.ports).toEqual([
      '127.0.0.1:${ADMIN_HOST_PORT:?loopback port for the settings reverse proxy required}:9883',
    ]);
    for (const name of ['native-answer', 'native-provision'])
      expect(JSON.stringify(c.services[name])).not.toMatch(/LIFECYCLE|native-generation/);
    expect(fs.existsSync('compose.native-answer.yaml')).toBe(false);
  });
  it('validates config without Docker, startup, or a drain marker', () => {
    const f = fixture(),
      r = f.run('deploy-preflight.mjs', [
        '--env-file',
        path.join(f.dir, '.env.testing'),
        '--no-docker',
      ]);
    expect(r.status, r.stderr).toBe(0);
    expect(f.calls()).toEqual([]);
    expect(fs.existsSync(f.marker)).toBe(false);
  });
  it('selects coding on the same receiver with retained storage and explicit sandbox isolation', () => {
    const f = fixture();
    const r = f.run('deploy-preflight.mjs', ['--env-file', path.join(f.dir, '.env.testing')]);
    expect(r.status, r.stderr).toBe(0);
    const compose = f.calls().filter((c) => c.args[0] === 'compose');
    expect(compose.length).toBeGreaterThan(0);
    expect(compose.every((c) => c.args.includes(path.join(repo, 'deploy/compose.yaml')))).toBe(
      true,
    );
    const c = parse(fs.readFileSync('deploy/compose.yaml', 'utf8'));
    expect(c.services['native-answer'].build.target).toBe('native-coding');
    expect(c.services['native-answer'].environment.CLI_RUNTIME_URL).toBe(
      'http://native-cli-runtime:9877',
    );
    expect(c.services['native-answer'].cap_add).toEqual(['SYS_ADMIN', 'NET_ADMIN']);
    expect(c.services['native-answer'].privileged).toBeUndefined();
    expect(c.services['native-answer'].volumes).toContain(
      'native-coding-data:/var/lib/native-coding',
    );
  });
  it('writes a native drain marker only for authenticated idle status', () => {
    const f = fixture(),
      args = ['--env-file', path.join(f.dir, '.env.testing')];
    fs.writeFileSync(
      path.join(f.dir, 'state.json'),
      JSON.stringify({ runtime: 'native-answer', idle: false, admitted: 1, waits: [] }),
    );
    expect(f.run('deploy-preflight.mjs', args).status).toBe(2);
    expect(fs.existsSync(f.marker)).toBe(false);
    fs.writeFileSync(
      path.join(f.dir, 'state.json'),
      JSON.stringify({
        runtime: 'native-answer',
        idle: true,
        admitted: 0,
        waits: [{ taskKey: 'retained' }],
      }),
    );
    expect(f.run('deploy-preflight.mjs', args).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.marker, 'utf8'))).toMatchObject({
      runtime: 'native-answer',
      activeRuns: 0,
      waits: 1,
    });
    expect(
      f
        .calls()
        .every(
          (c) =>
            !c.env.includes('SUPPORT_AGENT_SERVICE_TOKEN') &&
            !c.env.includes('NATIVE_IMAGE_TAG') &&
            !c.env.includes('Compose_File') &&
            !c.env.includes('native_model_stub') &&
            !c.env.includes('SERVICE_TOKEN') &&
            c.env.includes('HOST_TOOLING_DIR'),
        ),
    ).toBe(true);
  });
  it('refuses legacy projects before runtime calls or mutations', () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.dir, 'services.json'),
      JSON.stringify([
        {
          Id: 'legacy',
          Config: { Labels: { 'com.docker.compose.service': 'legacy-coordinator' } },
          State: { Running: true },
        },
      ]),
    );
    const r = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('automatic adoption refused');
    expect(f.calls().some((c) => c.args.includes('up') || c.args.includes('exec'))).toBe(false);
  });
  it('names a subnet held by another network without printing Docker output', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, 'services.json'), '[]');
    fs.writeFileSync(
      path.join(f.dir, 'up-stderr.txt'),
      'failed to create network leaked-project_frontend: Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n',
    );
    const r = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('an instance subnet is already used by another Docker network');
    expect(r.stderr).not.toContain('leaked-project');
  });
  it('stops intake, drains, then stops native writers without deleting evidence', () => {
    const f = fixture(),
      r = f.run('test-stack.mjs', ['down', '--instance-dir', f.dir]);
    expect(r.status, r.stderr).toBe(0);
    const calls = f.calls().map((c) => c.args);
    expect(calls.filter((a) => a.includes('stop')).map((a) => a.slice(a.indexOf('stop')))).toEqual([
      ['stop', 'adapter'],
      ['stop', 'native-answer', 'native-cli-runtime', 'native-postgres', 'admin', 'egress'],
    ]);
    expect(calls.findIndex((a) => a.includes('exec'))).toBeGreaterThan(
      calls.findIndex((a) => a.includes('stop')),
    );
    expect(calls.flat()).not.toContain('down');
    expect(calls.flat()).not.toContain('rm');
  });
  it('rejects old flags', () => {
    const f = fixture();
    for (const flag of ['--mastra-storage', '--settings'])
      expect(f.run('test-stack.mjs', ['up', flag, '--instance-dir', f.dir]).status).toBe(2);
    expect(f.calls()).toEqual([]);
  });
  it('refuses telemetry secrets unreadable by the selected capability-restricted image user', () => {
    const f = fixture();
    const secret = path.join(f.dir, 'telemetry');
    fs.writeFileSync(secret, 'synthetic-telemetry-password-only');
    f.env.NATIVE_OBSERVABILITY_SOURCE = 'native';
    f.env.NATIVE_OBSERVABILITY_PASSWORD_FILE = secret;
    const stat = fs.statSync.bind(fs);
    const metadata = { uid: 1234, gid: 1234, mode: 0o100600 };
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((
      file: fs.PathLike,
      options?: object,
    ) => {
      const value = stat(file, options);
      return String(file) === secret ? Object.assign(value!, metadata) : value;
    }) as typeof fs.statSync);
    try {
      f.save();
      expect(() => deployment(path.join(f.dir, '.env.testing'))).toThrow(
        'telemetry secret is unreadable by the selected container user',
      );
      Object.assign(metadata, { uid: 0, gid: 1000, mode: 0o100640 });
      expect(() => deployment(path.join(f.dir, '.env.testing'))).not.toThrow();
      expect(f.calls()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  it('drains and flushes the application before stopping shared telemetry and PostgreSQL', () => {
    const f = fixture();
    f.env.NATIVE_OBSERVABILITY_SOURCE = 'native';
    f.env.NATIVE_OBSERVABILITY_PASSWORD_FILE = path.join(f.dir, 'telemetry');
    fs.writeFileSync(f.env.NATIVE_OBSERVABILITY_PASSWORD_FILE, 'synthetic-telemetry-password-only');
    f.save();
    const r = f.run('test-stack.mjs', ['down', '--instance-dir', f.dir]);
    expect(r.status, r.stderr).toBe(0);
    const calls = f.calls().map((c) => c.args);
    const stops = calls.filter((a) => a.includes('stop'));
    expect(stops.map((a) => a.slice(a.indexOf('stop')))).toEqual([
      ['stop', 'adapter'],
      [
        'stop',
        'native-answer',
        'native-cli-runtime',
        'native-observability',
        'native-postgres',
        'admin',
        'egress',
      ],
    ]);
    expect(calls.indexOf(stops[1]!)).toBeGreaterThan(calls.findIndex((a) => a.includes('exec')));
    const c = parse(fs.readFileSync('deploy/compose.observability.yaml', 'utf8'));
    expect(c.services['native-answer'].depends_on['native-observability']).toEqual({
      condition: 'service_healthy',
    });
    expect(c.services['native-observability'].depends_on['native-postgres']).toEqual({
      condition: 'service_healthy',
    });
    expect(c.services['native-observability'].network_mode).toBe('none');
    expect(c.services['native-observability'].volumes).toEqual([
      'native-pg-socket:/run/native-postgres',
    ]);
    expect(calls.flat()).not.toContain('native-provision');
    expect(calls.flat()).not.toContain('rm');
  });
  it('requires every key of .env.example in every env file (env parity)', () => {
    const f = fixture();
    const reference = path.join(repo, '.env.example');
    const testing = path.join(f.dir, '.env.testing');
    const names = (file: string) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => l.slice(0, l.indexOf('=') + 1));
    fs.writeFileSync(testing, names(reference).join('\n'));
    expect(checkEnvParity([reference, testing])).toEqual({ missing: [], differences: [] });
    fs.writeFileSync(
      testing,
      names(reference)
        .filter((n) => n !== 'MODEL_CATALOG=')
        .join('\n'),
    );
    expect(checkEnvParity([reference, testing]).differences).toEqual([
      { name: 'MODEL_CATALOG', missingIn: [testing] },
    ]);
  });
  it('refuses legacy and synthetic settings in deployment env files', () => {
    expect(fs.readFileSync(path.join(repo, '.env.example'), 'utf8')).not.toMatch(
      /NATIVE_MODEL_STUB/,
    );
    for (const key of ['AI_GATEWAY_URL', 'NATIVE_MODEL_STUB']) {
      const f = fixture();
      f.env[key] = '1';
      f.save();
      const r = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('obsolete or synthetic model settings');
      expect(f.calls()).toEqual([]);
    }
    const f = fixture();
    for (const args of [
      ['up', '--model-mode', 'mock'],
      ['ps', '--model-mode', 'stub'],
      ['down', '--model-mode', 'gateway'],
    ]) {
      const r = f.run('test-stack.mjs', [...args, '--instance-dir', f.dir]);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(/--model-mode/);
    }
    expect(f.calls()).toEqual([]);
    expect(fs.existsSync(path.join(f.dir, 'model-mode'))).toBe(false);
  });
  it('starts the model stub by flag, records the mode and leaves the env file unchanged', () => {
    const f = fixture();
    const envFile = path.join(f.dir, '.env.testing');
    const original = fs.readFileSync(envFile, 'utf8');
    fs.writeFileSync(path.join(f.dir, 'services.json'), '[]');
    const up = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir, '--model-mode', 'stub']);
    expect(up.status, up.stderr).toBe(0);
    expect(fs.readFileSync(path.join(f.dir, 'model-mode'), 'utf8')).toBe('stub\n');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(original);
    const compose = f.calls().filter((c) => c.args[0] === 'compose');
    expect(compose.every((c) => c.args.join(' ').includes('--profile stub'))).toBe(true);
    // The overrides reach Compose interpolation only, for this command only.
    expect(compose.every((c) => c.stub === '1')).toBe(true);
    expect(compose.every((c) => !c.args.some((arg) => /compose\.model-/.test(arg)))).toBe(true);
    const start = compose.map((c) => c.args).find((a) => a.includes('up'))!;
    expect(start.slice(start.indexOf('egress'))).toEqual([
      'egress',
      'admin',
      'native-postgres',
      'model-stub',
      'native-answer',
      'adapter',
    ]);

    fs.writeFileSync(
      path.join(f.dir, 'services.json'),
      JSON.stringify(
        ['native-answer', 'model-stub'].map((service) => ({
          Id: service,
          Config: { Labels: { 'com.docker.compose.service': service } },
          State: { Running: true },
        })),
      ),
    );
    // Switching needs down first.
    const refused = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('test:stack:down');
    const before = f.calls().length;
    const down = f.run('test-stack.mjs', ['down', '--instance-dir', f.dir]);
    expect(down.status, down.stderr).toBe(0);
    const stops = f
      .calls()
      .slice(before)
      .map((c) => c.args)
      .filter((a) => a.includes('stop'))
      .map((a) => a.slice(a.indexOf('stop')));
    expect(stops).toEqual([
      ['stop', 'adapter'],
      [
        'stop',
        'native-answer',
        'model-stub',
        'native-cli-runtime',
        'native-postgres',
        'admin',
        'egress',
      ],
    ]);
    // down keeps the recorded mode.
    expect(fs.readFileSync(path.join(f.dir, 'model-mode'), 'utf8')).toBe('stub\n');

    // The default is gateway: no profile, no override, the env file's Gateway.
    fs.writeFileSync(path.join(f.dir, 'services.json'), '[]');
    const mark = f.calls().length;
    const gateway = f.run('test-stack.mjs', ['up', '--instance-dir', f.dir]);
    expect(gateway.status, gateway.stderr).toBe(0);
    expect(fs.readFileSync(path.join(f.dir, 'model-mode'), 'utf8')).toBe('gateway\n');
    const later = f.calls().slice(mark);
    expect(later.flatMap((c) => c.args)).not.toContain('model-stub');
    expect(later.flatMap((c) => c.args)).not.toContain('--profile');
    expect(later.every((c) => c.stub === undefined)).toBe(true);
  });
  it('always stops a running stub on down, even without a recorded stub mode', () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.dir, 'services.json'),
      JSON.stringify(
        ['native-answer', 'model-stub'].map((service) => ({
          Id: service,
          Config: { Labels: { 'com.docker.compose.service': service } },
          State: { Running: true },
        })),
      ),
    );
    const down = f.run('test-stack.mjs', ['down', '--instance-dir', f.dir]);
    expect(down.status, down.stderr).toBe(0);
    const last = f.calls().at(-1)!.args;
    expect(last).toContain('model-stub');
    expect(last.join(' ')).toContain('--profile stub');
  });
});
