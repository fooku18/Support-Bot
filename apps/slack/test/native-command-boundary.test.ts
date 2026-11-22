import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('qualifies the actual native executable, retained admin and Slack HTTP/Socket Mode boundary', async () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const root = path.join(
    process.env.SUPPORT_AGENT_TEST_ARTIFACT_ROOT ?? path.join(repo, 'artifacts', 'native-commands'),
    randomUUID(),
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const common = {
    absWorkingDir: repo,
    bundle: true,
    packages: 'external' as const,
    platform: 'node' as const,
    format: 'esm' as const,
    target: 'node26',
    metafile: true,
  };
  const bundles = await Promise.all([
    build({ ...common, entryPoints: ['src/index.ts'], outfile: path.join(root, 'adapter.mjs') }),
    build({
      ...common,
      entryPoints: ['test/fixtures/native-command-boundary.ts'],
      outfile: path.join(root, 'boundary.mjs'),
    }),
  ]);
  const packages = new Set(
    bundles.flatMap((result) =>
      Object.values(result.metafile!.outputs)
        .flatMap((output) => output.imports)
        .filter((item) => item.external && !item.path.startsWith('node:'))
        .map((item) =>
          item.path
            .split('/')
            .slice(0, item.path.startsWith('@') ? 2 : 1)
            .join('/'),
        ),
    ),
  );
  for (const name of packages) {
    const source = [repo, path.join(repo, '../..')]
      .map((owner) => path.join(owner, 'node_modules', name))
      .find((file) => fs.existsSync(file));
    if (!source) throw new Error(`Missing locked dependency ${name}`);
    const target = path.join(root, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
  }
  const result = await promisify(execFile)(process.execPath, [path.join(root, 'boundary.mjs')], {
    env: {
      PATH: process.env.PATH,
      COMMAND_BOUNDARY_ROOT: root,
      COMMAND_BOUNDARY_ADAPTER: path.join(root, 'adapter.mjs'),
    },
    timeout: 30000,
  });
  fs.writeFileSync(path.join(root, 'stdout.log'), result.stdout + result.stderr);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'))).toMatchObject({
    ok: true,
    agentCalls: 0,
    connections: 1,
  });
}, 40000);
