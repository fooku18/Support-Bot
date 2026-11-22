import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { build, type Metafile } from 'esbuild';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
const manifest = read('apps/agent/package.json');
const locked = read('package-lock.json').packages;
function lockedPackage(workspace: string, name: string) {
  return locked[`apps/${workspace}/node_modules/${name}`] ?? locked[`node_modules/${name}`];
}

async function graph(entryPoints: string[]) {
  return (
    await build({
      absWorkingDir: repo,
      entryPoints,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node26',
      outdir: 'artifacts/dependency-probe',
      metafile: true,
      write: false,
    })
  ).metafile!;
}
function packages(meta: Metafile) {
  return [
    ...new Set(
      Object.values(meta.outputs)
        .flatMap((o) => o.imports)
        .filter((i) => i.external && !isBuiltin(i.path))
        .map((i) =>
          i.path
            .split('/')
            .slice(0, i.path.startsWith('@') ? 2 : 1)
            .join('/'),
        ),
    ),
  ].sort();
}
function assertNativeGraph(meta: Metafile, codeMode = false) {
  expect(Object.keys(meta.inputs).filter((f) => /(?:^|\/)slack-runner\//.test(f))).toEqual([]);
  expect(
    Object.keys(meta.inputs).filter((f) =>
      /(?:executor-coding|run-turn|sdk-process|clarification-tool)\.ts$|\/code-mode\//.test(f),
    ),
  ).toEqual([]);
  // Only the agent runs Code Mode, in Mastra's isolated-vm transport.
  const banned = codeMode ? /claude-agent-sdk/ : /claude-agent-sdk|isolated-vm/;
  for (const output of Object.values(meta.outputs))
    expect(output.imports.filter((i) => banned.test(i.path))).toEqual([]);
}

describe('native package ownership', () => {
  it('owns the production graph and every external dependency at an exact locked version', async () => {
    const meta = await graph([
      'apps/agent/src/bootstrap/main.ts',
      'apps/agent/src/bootstrap/provision.ts',
    ]);
    assertNativeGraph(meta, true);
    for (const file of [
      'mastra/agents/coding.ts',
      'mastra/agents/shared.ts',
      'mastra/runtime/agent.ts',
      'mastra/runtime/segment.ts',
      'mastra/tools/coding.ts',
      'mastra/tools/code-mode.ts',
      'mastra/tools/read-services.ts',
      'application/agent-service.ts',
      'domain/publication/publish-project.ts',
      'domain/authorization/policy.ts',
      'domain/delivery/register-export.ts',
      'integrations/gitlab/gitlab-operations.ts',
      'integrations/tools/runtime-client.ts',
    ])
      expect(Object.keys(meta.inputs), file).toContain(`apps/agent/src/${file}`);
    expect(Object.keys(meta.inputs).filter((f) => !f.startsWith('apps/agent/src/'))).toEqual([]);
    const names = packages(meta);
    expect(names).toEqual(Object.keys(manifest.dependencies).sort());
    for (const name of names) {
      const entry = lockedPackage('agent', name);
      expect(entry.dev).not.toBe(true);
      expect(manifest.dependencies[name]).toBe(entry.version);
      expect(entry.integrity).toMatch(/^sha512-/);
    }
    expect(names).toContain('@mastra/isolated-vm');
    expect(Object.keys(locked).filter((name) => /claude-agent-sdk|quickjs/.test(name))).toEqual([]);
    // The V8 isolate addon is a production dependency of the agent. Node 26
    // needs isolated-vm 7, pinned by the root override.
    const isolate = lockedPackage('agent', 'isolated-vm');
    expect(isolate.dev).not.toBe(true);
    expect(isolate.version).toBe(read('package.json').overrides['isolated-vm']);
    expect(
      Object.keys(locked)
        .filter((n) => /(?:^|\/)isolated-vm$/.test(n))
        .sort(),
    ).toEqual(['node_modules/@mastra/isolated-vm', 'node_modules/isolated-vm']);
  });

  it('uses the deployed agent definition in the conventional Studio entrypoint', async () => {
    const meta = await graph(['apps/agent/src/mastra/index.ts']);
    assertNativeGraph(meta, true);
    expect(Object.keys(meta.inputs)).toContain('apps/agent/src/mastra/agents/coding.ts');
  });

  it('packages the credential-owning CLI service independently without framework dependencies', async () => {
    const meta = await graph(['apps/tool-runtime/src/main.ts']);
    assertNativeGraph(meta);
    const manifest = read('apps/tool-runtime/package.json');

    expect(packages(meta)).toEqual(Object.keys(manifest.dependencies).sort());
    expect(packages(meta).some((name) => /@mastra|claude-agent-sdk|isolated-vm/.test(name))).toBe(
      false,
    );
    expect(
      Object.keys(meta.inputs).filter((f) =>
        /apps\/agent\/src\/(?:mastra|application|bootstrap)\//.test(f),
      ),
    ).toEqual([]);
    for (const name of packages(meta)) {
      expect(manifest.dependencies[name]).toBe(lockedPackage('tool-runtime', name).version);
      for (const field of ['version', 'integrity', 'resolved'])
        expect(lockedPackage('tool-runtime', name)[field]).toEqual(
          lockedPackage('agent', name)[field],
        );
    }
    const docker = fs.readFileSync(path.join(repo, 'deploy/Dockerfile'), 'utf8');
    expect(docker).toContain(
      'COPY --from=tools-build /build/apps/tool-runtime/dist ./apps/tool-runtime/dist',
    );
    expect(docker).toContain(
      'npm ci --omit=dev --workspace @support-agent/agent --include-workspace-root=false',
    );
    expect(docker).not.toMatch(/COPY slack-runner\//);
  });

  it('packages the Slack receiver without a second agent execution authority', async () => {
    const meta = await graph(['apps/slack/src/index.ts']);
    assertNativeGraph(meta);
    expect(
      Object.keys(meta.inputs).filter((f) =>
        /apps\/agent\/src\/(?:mastra|application|bootstrap)\//.test(f),
      ),
    ).toEqual([]);
  });

  it('removes retired package source roots and the old conditional template module', () => {
    for (const file of [
      'coordinator-app',
      'admin-app',
      'slack-adapter',
      'egress-proxy',
      'tool-runtime',
      'lifecycle',
      'apps/lifecycle',
      'slack-runner/src',
      'apps/agent/src/mastra/agents/runtime.ts',
      'apps/agent/src/mastra/agents/answer.ts',
    ])
      expect(fs.existsSync(path.join(repo, file)), file).toBe(false);
  });
});

it.each([
  ['slack', 'src/index.ts'],
  ['admin', 'src/index.ts'],
  ['egress', 'src/index.ts'],
])('declares the complete %s production graph in its workspace', async (workspace, entry) => {
  const owner = read(`apps/${workspace}/package.json`);
  const meta = await graph([`apps/${workspace}/${entry}`]);
  expect(packages(meta)).toEqual(Object.keys(owner.dependencies ?? {}).sort());
  for (const name of packages(meta)) {
    const dependency = lockedPackage(workspace, name);
    expect(owner.dependencies[name]).toBe(dependency.version);
    expect(dependency.dev).not.toBe(true);
  }
});

it('installs every executable workspace from one lock without root production dependencies', () => {
  const root = read('package.json');
  expect(root.dependencies).toBeUndefined();
  expect(root.workspaces).toEqual(['apps/*']);
  for (const workspace of ['agent', 'slack', 'admin', 'tool-runtime', 'egress']) {
    const manifest = read(`apps/${workspace}/package.json`);
    expect(manifest.name).toBe(`@support-agent/${workspace}`);
    expect(locked[`apps/${workspace}`].name).toBe(manifest.name);
    expect(fs.existsSync(path.join(repo, `apps/${workspace}/package-lock.json`))).toBe(false);
  }
});

describe('Studio workspace deployment', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'support-agent-studio-workspaces-'));
  let create: string[];
  let maintenance: string[];
  beforeAll(async () => {
    fs.writeFileSync(path.join(state, 'password'), 'synthetic');
    fs.writeFileSync(
      path.join(state, 'resources.json'),
      JSON.stringify({
        pg: 'synthetic-pg',
        network: 'synthetic-db',
        uiNetwork: 'synthetic-ui',
        socket: 'synthetic-socket',
        provisioned: true,
        history: [],
      }),
    );
    const env = Object.fromEntries(
      [
        'NATIVE_IMAGE_TAG',
        'SUPPORT_AGENT_SERVICE_TOKEN',
        'ADMIN_INTERNAL_TOKEN',
        'CLI_RUNTIME_TOKEN',
        'MODEL_CATALOG',
        'MODEL_DEFAULT_KEY',
        'SUPPORT_AGENT_INSTANCE',
        'NATIVE_ANTHROPIC_API_KEY_FILE',
      ].map((key) => [key, 'synthetic']),
    );
    vi.doMock('../../../deploy/lib/native-deployment.mjs', () => ({
      repo,
      readModelMode: () => 'stub',
      deployment: (_file: string, { modelMode }: { modelMode: string }) => {
        expect(modelMode).toBe('stub');
        return {
          env,
          project: 'synthetic',
          connections: [],
          overrides: { NATIVE_MODEL_STUB: '1' },
        };
      },
      docker: (args: string[]) => {
        if (args[0] === 'run' && args.includes('STUDIO_OBSERVABILITY_READY=/ready/ready.json')) {
          maintenance = args;
          fs.writeFileSync(
            path.join(state, 'observability/ready.json'),
            JSON.stringify({ ready: true }),
          );
        }
        if (args[0] === 'create') {
          create = args;
          throw new Error('captured Studio create; no containers started');
        }
        if (args[0] === 'ps') return 'synthetic';
        if (args[0] === 'inspect') return args.includes('{{.Name}}') ? '/synthetic' : 'true';
        return '';
      },
    }));
    vi.doMock('../../../deploy/lib/env-contract.mjs', () => ({
      readEnvFile: () => ({ E2E_SLACK_TEAM_ID: 'TTEST', E2E_SLACK_CHANNEL_ID: 'CTEST' }),
    }));
    const argv = process.argv;
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.argv = [
        process.execPath,
        'studio.mjs',
        'start',
        '--instance-dir',
        state,
        '--state-dir',
        state,
      ];
      // @ts-expect-error operational entrypoint is JavaScript
      await import('../../../scripts/studio.mjs');
      expect(error).toHaveBeenCalledWith('captured Studio create; no containers started');
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      error.mockRestore();
      vi.doUnmock('../../../deploy/lib/native-deployment.mjs');
      vi.doUnmock('../../../deploy/lib/env-contract.mjs');
    }
    // Model only the driver's dependency bind mounts. Preserve symlink paths in
    // the Node probes so host realpaths cannot hide missing container ancestors.
    for (let i = 0; i < create.length; i++) {
      if (create[i] !== '-v') continue;
      const [source, target] = create[i + 1]!.split(':');
      if (!target?.endsWith('/node_modules')) continue;
      const destination = path.join(state, path.relative('/studio', target));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source!, destination);
    }
  });

  const probe = (source: string) =>
    spawnSync(
      process.execPath,
      [
        '--max-old-space-size=48',
        '--preserve-symlinks',
        '--preserve-symlinks-main',
        '--experimental-import-meta-resolve',
        '--input-type=module',
        '-e',
        source,
      ],
      { cwd: state, encoding: 'utf8' },
    );

  it('uses the recorded synthetic connection without binding model credentials', () => {
    const runtime = fs.readFileSync(path.join(state, 'runtime.env'), 'utf8');
    expect(runtime.split('\n')).toContain('NATIVE_MODEL_STUB=1');
    expect(runtime).not.toMatch(/NATIVE_(ANTHROPIC|OPENAI|VERTEX)_/);
    expect(create.some((arg) => /native_(anthropic|openai|vertex)/.test(arg))).toBe(false);
  });

  it('resolves hoisted, app-owned and nested CLI dependencies at their locked identities', () => {
    const cli = create[create.indexOf('--entrypoint') + 3]!;
    const cwd = create[create.indexOf('-w') + 1]!;
    const app = path.join(state, path.relative('/studio', cwd));
    const entry = path.join(state, path.relative('/studio', cli));
    const checks = [
      ['mastra', path.join(app, 'src/mastra/runtime.mjs'), 'apps/agent/node_modules/mastra'],
      ['posthog-node', entry, 'node_modules/posthog-node'],
      ['@mastra/core', path.join(app, 'src/mastra/runtime.mjs'), 'node_modules/@mastra/core'],
      [
        '@ai-sdk/anthropic',
        path.join(app, 'src/mastra/runtime.mjs'),
        'node_modules/@ai-sdk/anthropic',
      ],
      [
        '@hono/node-server',
        path.join(app, 'node_modules/@mastra/deployer/dist/index.js'),
        'apps/agent/node_modules/@mastra/deployer/node_modules/@hono/node-server',
      ],
    ];
    const result = probe(`
      import fs from 'node:fs';
      import path from 'node:path';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const checks = ${JSON.stringify(checks)};
      console.log(JSON.stringify(checks.map(([name, parent]) => {
        const resolved = import.meta.resolve(name, pathToFileURL(parent));
        let dir = path.dirname(fileURLToPath(resolved));
        while (dir !== path.dirname(dir)) {
          const manifest = path.join(dir, 'package.json');
          if (fs.existsSync(manifest)) {
            const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            if (pkg.name === name) return { name, version: pkg.version, dir };
          }
          dir = path.dirname(dir);
        }
        throw new Error('missing package identity: ' + name);
      })));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      checks.map(([name, , location]) => ({
        name,
        version: locked[location!].version,
        dir: path.join(state, location!),
      })),
    );
  });

  it('isolates partition maintenance from runtime credentials and network', () => {
    expect(maintenance[maintenance.indexOf('--network') + 1]).toBe('none');
    expect(maintenance).toContain('synthetic-socket:/run/native-postgres');
    expect(create.join(' ')).not.toContain('/run/native-postgres');
    expect(maintenance).not.toContain('--env-file');
    expect(maintenance.join(' ')).not.toMatch(/runtime_password|gateway_keys|runtime\.env/);
    expect(maintenance).not.toContain(`${state}:/studio`);
    expect(maintenance).toContain(`${repo}/node_modules:/studio/node_modules:ro`);
  });

  it('executes the generated ESM banner with a bound CommonJS require', () => {
    const cwd = create[create.indexOf('-w') + 1]!;
    const runtime = path.join(state, path.relative('/studio', cwd), 'src/mastra/runtime.mjs');
    const banner = fs.readFileSync(runtime, 'utf8').split('\n')[0];
    const file = path.join(path.dirname(runtime), 'banner-probe.mjs');
    fs.writeFileSync(file, `${banner}\nif (require('node:path').sep !== '/') process.exit(1);\n`);
    const result = probe(`await import(${JSON.stringify(pathToFileURL(file).href)});`);
    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps root and application manifests in their npm workspace locations', () => {
    expect(create).toContain(`${repo}/node_modules:/studio/node_modules:ro`);
    expect(create).toContain(`${repo}/apps/agent/node_modules:/studio/apps/agent/node_modules:ro`);
    expect(create[create.indexOf('-w') + 1]).toBe('/studio/apps/agent');
    expect(create[create.indexOf('--root') + 1]).toBe('/studio/apps/agent');
    expect(JSON.parse(fs.readFileSync(path.join(state, 'package.json'), 'utf8'))).toEqual(
      read('package.json'),
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(state, 'apps/agent/package.json'), 'utf8')),
    ).toEqual(manifest);
  });
});
