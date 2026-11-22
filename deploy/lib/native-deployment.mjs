/** Native deployment authority. No legacy runtime or store fallback. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './env-contract.mjs';
import { composeHostEnvironment } from './compose-environment.mjs';
import {
  activeModelConnections,
  parseModelCatalog,
  vertexModelLocation,
} from './model-catalog.mjs';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The mode of the last test:stack:up. Env files never select stub mode. */
export const MODEL_MODE_FILE = 'model-mode';
export const MODEL_MODES = ['gateway', 'stub'];
/** The recorded model mode of a test instance, or null before the first start. */
export function readModelMode(dir) {
  const file = path.join(dir, MODEL_MODE_FILE);
  if (!fs.existsSync(file)) return null;
  const mode = fs.readFileSync(file, 'utf8').trim();
  if (!MODEL_MODES.includes(mode))
    throw new Error(`${MODEL_MODE_FILE} is invalid; restart with test:stack:up`);
  return mode;
}
export function writeModelMode(dir, mode) {
  if (!MODEL_MODES.includes(mode)) throw new Error('--model-mode must be stub or gateway');
  fs.writeFileSync(path.join(dir, MODEL_MODE_FILE), `${mode}\n`, { mode: 0o644 });
}
const PROVIDER_FILE = {
  anthropic: 'NATIVE_ANTHROPIC_API_KEY_FILE',
  openai: 'NATIVE_OPENAI_API_KEY_FILE',
  vertex: 'NATIVE_VERTEX_CREDENTIALS_FILE',
};

/** Validate a deployment and select the execution service's secret overlays. */
export function deployment(file, { modelMode = 'gateway' } = {}) {
  if (!file) throw new Error('--env-file is required');
  if (!MODEL_MODES.includes(modelMode)) throw new Error('--model-mode must be stub or gateway');
  const envFile = path.resolve(file),
    env = readEnvFile(envFile);
  for (const key of [
    'COMPOSE_PROJECT_NAME',
    'SUPPORT_AGENT_INSTANCE',
    'NATIVE_IMAGE_TAG',
    'NATIVE_FRONTEND_SUBNET',
    'NATIVE_TOOLS_SUBNET',
    'NATIVE_DB_SUBNET',
    'SUPPORT_AGENT_SERVICE_TOKEN',
    'ADMIN_INTERNAL_TOKEN',
    'CLI_RUNTIME_TOKEN',
    'GITLAB_HOSTS',
    'SLACK_APP_TOKEN',
    'ADMIN_PUBLIC_URL',
    'ADMIN_HOST_PORT',
    'ADMIN_STORE_DIR',
    'ADMIN_STORE_KEY',
    'ADMIN_SESSION_KEY',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
  ]) {
    if (!env[key]?.trim() || /<operator:|placeholder/i.test(env[key]))
      throw new Error(`${key} is required`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(env.COMPOSE_PROJECT_NAME))
    throw new Error('COMPOSE_PROJECT_NAME is invalid');
  const subnets = ['NATIVE_FRONTEND_SUBNET', 'NATIVE_TOOLS_SUBNET', 'NATIVE_DB_SUBNET'];
  for (const key of subnets)
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(env[key])) throw new Error(`${key} is invalid`);
  if (new Set(subnets.map((key) => env[key])).size !== subnets.length)
    throw new Error('NATIVE_FRONTEND_SUBNET, NATIVE_TOOLS_SUBNET and NATIVE_DB_SUBNET must differ');
  if (!/^[1-9][0-9]{0,4}$/.test(env.ADMIN_HOST_PORT) || Number(env.ADMIN_HOST_PORT) > 65535)
    throw new Error('ADMIN_HOST_PORT is invalid');
  if (
    !path.isAbsolute(env.ADMIN_STORE_DIR) ||
    !fs.statSync(env.ADMIN_STORE_DIR, { throwIfNoEntry: false })?.isDirectory()
  )
    throw new Error('ADMIN_STORE_DIR must name an existing directory');
  if (
    env.NATIVE_OBSERVABILITY_SOURCE &&
    !['off', 'native'].includes(env.NATIVE_OBSERVABILITY_SOURCE)
  )
    throw new Error('NATIVE_OBSERVABILITY_SOURCE is invalid');
  if (env.NATIVE_OBSERVABILITY_SOURCE === 'native') {
    const file = env.NATIVE_OBSERVABILITY_PASSWORD_FILE;
    if (
      !path.isAbsolute(file ?? '') ||
      !fs.statSync(file, { throwIfNoEntry: false })?.isFile() ||
      fs.realpathSync(file) === fs.realpathSync(env.NATIVE_RUNTIME_PASSWORD_FILE)
    )
      throw new Error('separate NATIVE_OBSERVABILITY_PASSWORD_FILE required');
    // The application runs as root with DAC_OVERRIDE dropped.
    const secret = fs.statSync(file);
    const uid = 0;
    const readBit = secret.uid === uid ? 0o400 : secret.gid === uid ? 0o040 : 0o004;
    if (!(secret.mode & readBit))
      throw new Error('telemetry secret is unreadable by the selected container user');
  }
  if ([env.NATIVE_WEB_RUNTIME_URL, env.WEB_RUNTIME_TOKEN, env.NATIVE_WEB_NETWORK].some(Boolean)) {
    for (const key of ['NATIVE_WEB_RUNTIME_URL', 'WEB_RUNTIME_TOKEN', 'NATIVE_WEB_NETWORK'])
      if (!env[key]?.trim() || /<operator:|placeholder/i.test(env[key]))
        throw new Error(`${key} is required for direct web fetch`);
  }
  for (const key of [
    'ADMIN_PUBLIC_URL',
    ...(env.NATIVE_WEB_RUNTIME_URL ? ['NATIVE_WEB_RUNTIME_URL'] : []),
  ]) {
    let u;
    try {
      u = new URL(env[key]);
    } catch {
      throw new Error(`${key} is invalid`);
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
      throw new Error(`${key} is invalid`);
    if (key === 'ADMIN_PUBLIC_URL' && (u.protocol !== 'https:' || u.pathname !== '/'))
      throw new Error('ADMIN_PUBLIC_URL must be an HTTPS origin');
  }
  const catalog = parseModelCatalog(env.MODEL_CATALOG, env.MODEL_DEFAULT_KEY);
  if (
    Object.keys(env).some(
      (key) =>
        key.startsWith('AI_GATEWAY_') ||
        [
          'NATIVE_MODEL_STUB',
          'NATIVE_GATEWAY_KEYS_FILE',
          'CLAUDE_MODELS',
          'CLAUDE_DEFAULT_MODEL',
        ].includes(key),
    )
  )
    throw new Error('obsolete or synthetic model settings are forbidden in deployment env files');
  const connections = modelMode === 'stub' ? [] : activeModelConnections(catalog);
  if (connections.includes('vertex'))
    vertexModelLocation(env.NATIVE_VERTEX_PROJECT, env.NATIVE_VERTEX_LOCATION);
  for (const key of [
    'NATIVE_RUNTIME_PASSWORD_FILE',
    ...connections.map((connection) => PROVIDER_FILE[connection]),
  ]) {
    const filename = env[key];
    if (
      !path.isAbsolute(filename ?? '') ||
      !fs.statSync(filename, { throwIfNoEntry: false })?.isFile()
    )
      throw new Error(`${key} must name an existing secret file`);
  }
  if (['E2E_SLACK_SENDER_TOKEN', 'TEST_SLACK_SENDER_TOKEN'].some((k) => k in env))
    throw new Error('harness credentials are forbidden in application env');
  return {
    envFile,
    env,
    catalog,
    connections,
    overrides: modelMode === 'stub' ? { NATIVE_MODEL_STUB: '1' } : {},
    project: env.COMPOSE_PROJECT_NAME,
    modelMode,
  };
}
/** `extra` adds explicit interpolation values (they take precedence over the env file). */
export function docker(args, extra = {}) {
  const result = spawnSync('docker', args, {
    env: { ...composeHostEnvironment(), ...extra },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 ** 2,
    timeout: 240000,
  });
  // Docker errors/config can contain interpolated values: never print them.
  if (result.status !== 0) {
    const causes = [
      [/address pools|fully subnetted/i, 'Docker address pools exhausted'],
      [/pool overlaps/i, 'an instance subnet is already used by another Docker network'],
      [/no space left/i, 'Docker storage exhausted'],
      [/pull access denied|No such image|manifest unknown/i, 'required image unavailable'],
      [/permission denied/i, 'Docker permission refused'],
    ];
    const cause = causes.find(([pattern]) => pattern.test(result.stderr ?? ''))?.[1];
    throw new Error(cause ?? 'Docker operation failed; inspect the designated instance privately');
  }
  return result.stdout;
}
export function compose(d, args) {
  return docker(
    [
      'compose',
      '--env-file',
      d.envFile,
      '-p',
      d.project,
      '-f',
      path.join(repo, 'deploy/compose.yaml'),
      ...(d.modelMode === 'stub' ? ['--profile', 'stub'] : []),
      ...d.connections.flatMap((connection) => [
        '-f',
        path.join(repo, `deploy/compose.model-${connection}.yaml`),
      ]),
      ...(d.env.NATIVE_WEB_RUNTIME_URL
        ? ['-f', path.join(repo, 'deploy/compose.web-fetch.yaml')]
        : []),
      ...(d.env.NATIVE_OBSERVABILITY_SOURCE === 'native'
        ? ['-f', path.join(repo, 'deploy/compose.observability.yaml')]
        : []),
      ...args,
    ],
    d.overrides,
  );
}
export function services(d) {
  const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${d.project}`])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return ids.length
    ? JSON.parse(docker(['inspect', ...ids])).map((c) => ({
        id: c.Id,
        service: c.Config.Labels['com.docker.compose.service'],
        running: c.State.Running,
        image: c.Image,
      }))
    : [];
}
export function requireNativeProject(d) {
  const found = services(d);
  if (
    found.some(
      (c) =>
        ![
          'native-answer',
          'adapter',
          'native-postgres',
          'native-provision',
          'native-observability',
          'native-cli-runtime',
          'admin',
          'egress',
          'model-stub',
        ].includes(c.service),
    )
  )
    throw new Error('project contains legacy or unrelated services; automatic adoption refused');
  return found;
}
export function status(d) {
  const result = compose(d, [
    'exec',
    '-T',
    'native-answer',
    'node',
    '-e',
    "fetch('http://127.0.0.1:9879/native/status',{headers:{authorization:'Bearer '+process.env.SERVICE_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))",
  ]);
  const value = JSON.parse(result);
  if (
    value.runtime !== 'native-answer' ||
    typeof value.idle !== 'boolean' ||
    !Number.isSafeInteger(value.admitted) ||
    !Array.isArray(value.waits)
  )
    throw new Error('native status unavailable; drain refused');
  return value;
}
export async function drain(d, waitMs = 0) {
  const end = Date.now() + waitMs;
  for (;;) {
    const value = status(d);
    if (value.idle) return value;
    if (Date.now() >= end) throw new Error('native execution or uncertain delivery is not idle');
    await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
  }
}
export function marker(d, value) {
  const file = path.join(path.dirname(d.envFile), 'artifacts', 'deploy-drain', `${d.project}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      at: new Date().toISOString(),
      project: d.project,
      runtime: 'native-answer',
      activeRuns: 0,
      waits: value.waits.length,
    }),
    { mode: 0o600 },
  );
}
