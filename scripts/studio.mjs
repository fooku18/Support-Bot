#!/usr/bin/env node
/** Isolated, retained Mastra dev instance; never starts a Slack receiver. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { deployment, docker, readModelMode, repo } from '../deploy/lib/native-deployment.mjs';
import { readEnvFile } from '../deploy/lib/env-contract.mjs';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'instance-dir': { type: 'string' },
    'state-dir': { type: 'string' },
    'observability-source': { type: 'string' },
    port: { type: 'string', default: '4111' },
    'public-origin': { type: 'string' },
    'traefik-network': { type: 'string' },
  },
});
const action = positionals[0] ?? 'start';
try {
  if (!['start', 'stop', 'status'].includes(action) || !values['instance-dir'])
    throw new Error(
      'Usage: npm run studio -- [start|stop|status] --instance-dir <test instance> [--port 4111]',
    );
  const instance = path.resolve(values['instance-dir']);
  // Studio follows the instance's recorded model mode: in stub mode it uses
  // the same fixed synthetic connection as the agent.
  const d = deployment(path.join(instance, '.env.testing'), {
    modelMode: readModelMode(instance) ?? 'gateway',
  });
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('invalid port');
  const root = path.resolve(values['state-dir'] ?? path.join(instance, 'studio'));
  const manifest = path.join(root, 'resources.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o770 });
  fs.chmodSync(root, 0o770);
  let state = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : undefined;
  const observabilitySource =
    values['observability-source'] ?? state?.observabilitySource ?? 'studio';
  if (!['studio', 'native'].includes(observabilitySource))
    throw new Error('--observability-source must be studio or native');
  if (
    action === 'start' &&
    observabilitySource === 'native' &&
    d.env.NATIVE_OBSERVABILITY_SOURCE !== 'native'
  )
    throw new Error(
      'native telemetry must be explicitly configured and provisioned on the designated instance',
    );
  const publicOrigin = values['public-origin'] ?? state?.publicOrigin;
  const traefikNetwork = values['traefik-network'] ?? state?.traefikNetwork;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('--public-origin must be an HTTPS origin without credentials or a path');
  }
  if (traefikNetwork && (!publicOrigin || !/^[a-zA-Z0-9_-]+$/.test(traefikNetwork)))
    throw new Error('--traefik-network requires --public-origin and a valid network name');
  const save = () => fs.writeFileSync(manifest, JSON.stringify(state, null, 2), { mode: 0o600 });
  const ready = async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
        signal: AbortSignal.timeout(2000),
      });
      const agents = await response.json();
      return response.ok && Object.keys(agents).length === 1 && !!agents.coding;
    } catch {
      return false;
    }
  };
  const running = (name) => {
    if (!docker(['ps', '-aq', '--filter', `name=^/${name}$`]).trim()) return false;
    return JSON.parse(docker(['inspect', '--format', '{{json .State.Running}}', name]));
  };
  if (action === 'status') {
    console.log(
      state
        ? JSON.stringify({
            studio: state.studio && running(state.studio),
            postgres: running(state.pg),
            observabilitySource: state.observabilitySource ?? 'studio',
            localObservability: state.observability && running(state.observability),
            retainedLocalTelemetry: { postgres: state.pg, schema: 'studio_observability' },
            url: state.publicOrigin ?? `http://localhost:${state.port}`,
          })
        : 'Studio has not been provisioned',
    );
  } else if (action === 'stop') {
    if (state?.studio && running(state.studio)) docker(['stop', '-t', '45', state.studio]);
    if (state?.observability && running(state.observability))
      docker(['stop', '-t', '30', state.observability]);
    if (state && running(state.pg)) docker(['stop', '-t', '30', state.pg]);
    console.log('Studio stopped; chats, workspace, database and containers retained.');
  } else {
    if (state?.studio && running(state.studio)) {
      if (observabilitySource !== (state.observabilitySource ?? 'studio'))
        throw new Error(
          'Stop Studio before changing its observability source; both histories are retained',
        );
      if (publicOrigin !== state.publicOrigin || traefikNetwork !== state.traefikNetwork)
        throw new Error('Stop Studio before changing its public route');
      if (!(await ready(state.port)))
        throw new Error(
          'Studio process is running but not ready; inspect its logs, then stop/start after correcting test prerequisites',
        );
      console.log(
        `Studio is already running at ${state.publicOrigin ?? `http://localhost:${state.port}`}`,
      );
      process.exit(0);
    }
    const stat = fs.statfsSync(root);
    if (stat.bavail * stat.bsize < 2 * 1024 ** 3 + 512 * 1024 ** 2)
      throw new Error('Studio needs 2 GiB reserve plus 512 MiB headroom');
    const harness = readEnvFile(path.join(instance, '.env.e2e'));
    for (const key of ['E2E_SLACK_TEAM_ID', 'E2E_SLACK_CHANNEL_ID'])
      if (!harness[key] || /<operator:/.test(harness[key]))
        throw new Error(`${key} must be configured in the test harness`);
    const service = (name) => {
      const ids = docker([
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${d.project}`,
        '--filter',
        `label=com.docker.compose.service=${name}`,
      ])
        .trim()
        .split('\n')
        .filter(Boolean);
      if (ids.length !== 1) throw new Error(`Exactly one running test ${name} is required`);
      return docker(['inspect', '--format', '{{.Name}}', ids[0]]).trim().replace(/^\//, '');
    };
    const adapter = service('adapter'),
      cli = service('native-cli-runtime');
    const image = `support-agent/native-answer:${d.env.NATIVE_IMAGE_TAG}`;
    docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    // Preserve npm's root/app hierarchy: CLI transitives may be hoisted,
    // while conflicting application and nested CLI versions must stay local.
    const app = path.join(root, 'apps/agent');
    fs.mkdirSync(path.join(app, 'src/mastra'), { recursive: true });
    // mastra dev writes .mastra and src/mastra/public; the container has the
    // group, not DAC_OVERRIDE.
    for (const dir of [app, path.join(app, 'src'), path.join(app, 'src/mastra')])
      fs.chmodSync(dir, 0o770);
    // Native runtime factory imports are bundled from THIS checkout; packages
    // resolve from the exact workspace lock, including the pinned Mastra CLI.
    await build({
      entryPoints: [path.join(repo, 'apps/agent/src/mastra/index.ts')],
      outfile: path.join(app, 'src/mastra/runtime.mjs'),
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node26',
      sourcemap: true,
      banner: {
        js: "import { build } from 'esbuild'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    fs.writeFileSync(
      path.join(app, 'src/mastra/index.ts'),
      "export { mastra } from './runtime.mjs';\n",
    );
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(root, 'package.json'));
    fs.copyFileSync(path.join(repo, 'apps/agent/package.json'), path.join(app, 'package.json'));
    fs.writeFileSync(path.join(root, 'empty.env'), '', { mode: 0o640 });
    fs.chmodSync(path.join(root, 'empty.env'), 0o640);
    if (!state) {
      const id = randomUUID().slice(0, 8);
      state = {
        pg: `support-agent-studio-${id}-pg`,
        volume: `support-agent-studio-${id}-data`,
        socket: `support-agent-studio-${id}-socket`,
        port,
        history: [],
      };
      fs.writeFileSync(path.join(root, 'password'), randomBytes(32).toString('hex'), {
        mode: 0o600,
      });
      save();
    }
    if (!state.network) {
      // A private runtime network uses the same authenticated HBA as deployment.
      // Only the separate provisioner receives the maintenance socket.
      const prior = docker(['ps', '-aq', '--filter', `name=^/${state.pg}$`]).trim();
      if (prior) {
        if (running(state.pg)) docker(['stop', '-t', '30', state.pg]);
        state.history.push(state.pg);
        state.pg += '-restricted';
      }
      state.network = `${state.pg}-network`;
      docker(['network', 'create', '--internal', state.network]);
      docker([
        'run',
        '-d',
        '--name',
        state.pg,
        '--network',
        state.network,
        '--network-alias',
        'studio-postgres',
        '--memory',
        '256m',
        '--pids-limit',
        '64',
        '-e',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        '-v',
        `${state.volume}:/var/lib/postgresql/data`,
        '-v',
        `${state.socket}:/var/run/postgresql`,
        '-v',
        `${repo}/deploy/docker/native-answer-pg-hba.conf:/etc/postgresql/studio-hba.conf:ro`,
        'postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3',
        'postgres',
        '-c',
        'hba_file=/etc/postgresql/studio-hba.conf',
      ]);
      save();
    } else if (!running(state.pg)) docker(['start', state.pg]);
    for (let i = 0; i < 60; i++) {
      try {
        docker([
          'exec',
          state.pg,
          'sh',
          '-c',
          'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres',
        ]);
        break;
      } catch {
        if (i === 59) throw new Error('Studio PostgreSQL did not become ready');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const mounts = [
      '-v',
      `${root}/password:/run/secrets/native_runtime_password:ro`,
      '-v',
      `${state.socket}:/run/native-postgres`,
    ];
    if (!state.provisioned) {
      const name = `${state.pg}-provision-${Date.now()}`;
      state.history.push(name);
      save();
      docker([
        'run',
        '--name',
        name,
        '--network',
        'none',
        ...mounts,
        '-e',
        'NATIVE_PG_SOCKET=/run/native-postgres',
        '-e',
        'NATIVE_PG_PASSWORD_FILE=/run/secrets/native_runtime_password',
        image,
        'provision',
      ]);
      state.provisioned = true;
      save();
    }
    let telemetryNetwork;
    if (observabilitySource === 'native') {
      const pg = service('native-postgres');
      const networks = JSON.parse(
        docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', pg]),
      );
      const names = Object.keys(networks);
      if (names.length !== 1)
        throw new Error('native PG must have exactly its isolated database network');
      const network = JSON.parse(docker(['network', 'inspect', names[0]]))[0];
      if (
        network.Labels?.['com.docker.compose.project'] !== d.project ||
        network.Labels?.['com.docker.compose.network'] !== 'nativedb'
      )
        throw new Error('native telemetry network identity refused');
      telemetryNetwork = names[0];
      // This maintenance service is owned by the native stack, never Studio.
      service('native-observability');
    }
    if (state.observability && running(state.observability))
      docker(['stop', '-t', '30', state.observability]);
    if (observabilitySource === 'studio') {
      // The restricted Studio process gets DML only. Mastra's native partitions
      // are maintained separately over the isolated Unix socket, without a network
      // or application credentials. Old telemetry and chat state are retained.
      await build({
        entryPoints: [path.join(repo, 'apps/agent/src/bootstrap/studio-observability.ts')],
        outfile: path.join(app, 'studio-observability.mjs'),
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        target: 'node26',
        banner: {
          js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
      });
      fs.mkdirSync(path.join(root, 'observability'), { recursive: true, mode: 0o770 });
      fs.chmodSync(path.join(root, 'observability'), 0o770);
      const observabilityReady = path.join(root, 'observability/ready.json');
      if (fs.existsSync(observabilityReady))
        fs.renameSync(observabilityReady, `${observabilityReady}.${Date.now()}`);
      state.observability = `${state.pg}-observability-${Date.now()}`;
      state.history.push(state.observability);
      save();
      docker([
        'run',
        '-d',
        '--name',
        state.observability,
        '--user',
        `0:${process.getgid?.() ?? 0}`,
        '--init',
        '--network',
        'none',
        '--memory',
        '256m',
        '--pids-limit',
        '64',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '-v',
        `${state.socket}:/run/native-postgres`,
        '-v',
        `${app}/studio-observability.mjs:/studio/apps/agent/studio-observability.mjs:ro`,
        '-v',
        `${root}/observability:/ready`,
        '-v',
        `${repo}/node_modules:/studio/node_modules:ro`,
        '-v',
        `${repo}/apps/agent/node_modules:/studio/apps/agent/node_modules:ro`,
        '-e',
        'NATIVE_STUDIO=testing',
        '-e',
        'NATIVE_PG_SOCKET=/run/native-postgres',
        '-e',
        'STUDIO_OBSERVABILITY_READY=/ready/ready.json',
        '--entrypoint',
        'node',
        image,
        '/studio/apps/agent/studio-observability.mjs',
      ]);
      for (let attempt = 0; !fs.existsSync(observabilityReady); attempt++) {
        if (attempt >= 59 || !running(state.observability))
          throw new Error(
            `Studio observability not ready; retained container ${state.observability}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // Only explicit application/test values. Never pass the harness sender token
    // or ambient shell environment, nor read tool-instance credentials.
    const providerMounts = d.connections.map(
      (connection) =>
        ({
          anthropic: {
            env: 'NATIVE_ANTHROPIC_API_KEY_FILE',
            target: '/run/secrets/native_anthropic_api_key',
          },
          openai: {
            env: 'NATIVE_OPENAI_API_KEY_FILE',
            target: '/run/secrets/native_openai_api_key',
          },
          vertex: {
            env: 'NATIVE_VERTEX_CREDENTIALS_FILE',
            target: '/run/secrets/native_vertex_credentials',
          },
        })[connection],
    );
    const env = {
      NATIVE_STUDIO: 'testing',
      NATIVE_OBSERVABILITY_SOURCE: observabilitySource === 'native' ? 'native' : 'off',
      ...(observabilitySource === 'native'
        ? {
            NATIVE_OBSERVABILITY_HOST: 'native-postgres',
            NATIVE_OBSERVABILITY_PASSWORD_FILE: '/run/secrets/native_observability_password',
          }
        : {}),
      STUDIO_PORT: String(port),
      ...(publicOrigin ? { STUDIO_PUBLIC_ORIGIN: new URL(publicOrigin).origin } : {}),
      STUDIO_TEAM_ID: harness.E2E_SLACK_TEAM_ID,
      STUDIO_CHANNEL_ID: harness.E2E_SLACK_CHANNEL_ID,
      NATIVE_PG_HOST: 'studio-postgres',
      NATIVE_PG_PASSWORD_FILE: '/run/secrets/native_runtime_password',
      NATIVE_ADAPTER_URL: `http://${adapter}:9881`,
      NATIVE_APPLICATION_PORT: '9879',
      SERVICE_TOKEN: d.env.SUPPORT_AGENT_SERVICE_TOKEN,
      ADMIN_URL: 'http://admin:9883',
      ADMIN_INTERNAL_TOKEN: d.env.ADMIN_INTERNAL_TOKEN,
      CLI_RUNTIME_URL: `http://${cli}:9877`,
      CLI_RUNTIME_TOKEN: d.env.CLI_RUNTIME_TOKEN,
      ...(d.env.NATIVE_WEB_RUNTIME_URL
        ? {
            WEB_RUNTIME_URL: d.env.NATIVE_WEB_RUNTIME_URL,
            WEB_RUNTIME_TOKEN: d.env.WEB_RUNTIME_TOKEN,
          }
        : {}),
      ...Object.fromEntries(providerMounts.map(({ env, target }) => [env, target])),
      ...(d.connections.includes('vertex')
        ? {
            NATIVE_VERTEX_PROJECT: d.env.NATIVE_VERTEX_PROJECT,
            NATIVE_VERTEX_LOCATION: d.env.NATIVE_VERTEX_LOCATION,
          }
        : {}),
      EGRESS_PROXY_URL: 'http://egress-tools:3128',
      STUDIO_SLACK_PROXY_URL: 'http://egress:3128',
      MODEL_CATALOG: d.env.MODEL_CATALOG,
      MODEL_DEFAULT_KEY: d.env.MODEL_DEFAULT_KEY,
      ...(d.overrides.NATIVE_MODEL_STUB === '1' ? { NATIVE_MODEL_STUB: '1' } : {}),
      SUPPORT_AGENT_INSTANCE: `${d.env.SUPPORT_AGENT_INSTANCE}-studio`,
      NODE_ENV: 'development',
      // Code Mode's isolated-vm needs it; this file replaces the image's value.
      NODE_OPTIONS: '--no-node-snapshot',
      MASTRA_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
    };
    fs.writeFileSync(
      path.join(root, 'runtime.env'),
      Object.entries(env)
        .map(([k, v]) => {
          if (typeof v !== 'string' || /[\r\n]/.test(v))
            throw new Error(`invalid Studio value: ${k}`);
          return `${k}=${v}`;
        })
        .join('\n'),
      { mode: 0o600 },
    );
    fs.chmodSync(path.join(root, 'password'), 0o640);
    if (
      !state.uiNetwork ||
      !docker(['network', 'ls', '-q', '--filter', `name=^${state.uiNetwork}$`]).trim()
    ) {
      state.uiNetwork = `${state.pg}-ui`;
      docker(['network', 'create', state.uiNetwork]);
      save();
    }
    const name = `support-agent-studio-${Date.now()}`;
    state.studio = name;
    state.observabilitySource = observabilitySource;
    state.port = port;
    state.publicOrigin = publicOrigin;
    state.traefikNetwork = traefikNetwork;
    state.history.push(name);
    save();
    docker([
      'create',
      '--name',
      name,
      '--init',
      '--user',
      `0:${process.getgid?.() ?? 0}`,
      '--memory',
      '1536m',
      '--pids-limit',
      '256',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--network',
      state.uiNetwork,
      '-p',
      `127.0.0.1:${port}:${port}`,
      ...(traefikNetwork
        ? [
            '--label',
            'traefik.enable=true',
            '--label',
            `traefik.docker.network=${traefikNetwork}`,
            '--label',
            `traefik.http.routers.${state.pg}-studio.rule=Host(\`${new URL(publicOrigin).hostname}\`)`,
            '--label',
            `traefik.http.routers.${state.pg}-studio.entrypoints=web`,
            '--label',
            `traefik.http.routers.${state.pg}-studio.service=${state.pg}-studio`,
            '--label',
            `traefik.http.services.${state.pg}-studio.loadbalancer.server.port=${port}`,
          ]
        : []),
      '--env-file',
      path.join(root, 'runtime.env'),
      ...mounts.slice(0, 2),
      ...(observabilitySource === 'native'
        ? [
            '-v',
            `${d.env.NATIVE_OBSERVABILITY_PASSWORD_FILE}:/run/secrets/native_observability_password:ro`,
          ]
        : []),
      ...providerMounts.flatMap(({ env, target }) => ['-v', `${d.env[env]}:${target}:ro`]),
      '-v',
      `${root}:/studio`,
      '-v',
      `${repo}/node_modules:/studio/node_modules:ro`,
      '-v',
      `${repo}/apps/agent/node_modules:/studio/apps/agent/node_modules:ro`,
      '-w',
      '/studio/apps/agent',
      '--entrypoint',
      'node',
      image,
      '/studio/apps/agent/node_modules/mastra/dist/index.js',
      'dev',
      '--dir',
      'src/mastra',
      '--root',
      '/studio/apps/agent',
      '--env',
      '/studio/empty.env',
    ]);
    // Compose names the instance's own networks <project>_<network>.
    docker(['network', 'connect', `${d.project}_frontend`, name]);
    if (traefikNetwork) docker(['network', 'connect', traefikNetwork, name]);
    docker(['network', 'connect', state.network, name]);
    if (telemetryNetwork) docker(['network', 'connect', telemetryNetwork, name]);
    docker(['network', 'connect', `${d.project}_tools`, name]);
    if (d.env.NATIVE_WEB_NETWORK) docker(['network', 'connect', d.env.NATIVE_WEB_NETWORK, name]);
    docker(['start', name]);
    for (let attempt = 0; !(await ready(port)); attempt++) {
      if (attempt >= 59 || !running(name))
        throw new Error(`Studio did not become ready; retained container ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log(
      `Studio ready at ${publicOrigin ?? `http://localhost:${port}`}; logs: docker logs ${name}\nSeparate chats/workspace retained in ${root}. No Slack receiver started. Telemetry source: ${observabilitySource}. Local history remains in ${state.pg}/studio_observability; select --observability-source studio to view it.`,
    );
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Studio refused');
  process.exitCode = 1;
}
