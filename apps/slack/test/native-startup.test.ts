import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '..');
const root = path.join(
  process.env.SUPPORT_AGENT_TEST_ARTIFACT_ROOT ?? path.join(repo, 'artifacts', 'native-startup'),
  randomUUID(),
);
let bundle: string;

beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(repo, 'node_modules')), path.join(root, 'node_modules'));
  bundle = path.join(root, 'index.mjs');
  const result = await build({
    absWorkingDir: repo,
    entryPoints: ['src/index.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node26',
    outfile: bundle,
    metafile: true,
  });
  fs.writeFileSync(path.join(root, 'metafile.json'), JSON.stringify(result.metafile));
  const contributing = Object.entries(result.metafile.outputs).flatMap(([, output]) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([name]) => name),
  );
  for (const name of ['context', 'outbox', 'operations', 'scan', 'interactions'])
    expect(contributing).not.toContain(`src/${name}.ts`);
});

function start(env: NodeJS.ProcessEnv, args = ['--process-env']) {
  return new Promise<{ code: number | string | undefined; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bundle, ...args],
      { env, timeout: 5000 },
      (error, stdout, stderr) => {
        const result = { code: error?.code, stderr };
        fs.writeFileSync(
          path.join(root, `${randomUUID()}.json`),
          JSON.stringify({ ...result, stdout }),
        );
        resolve(result);
      },
    );
  });
}

describe('native-only adapter startup', () => {
  it('refuses incomplete configuration without calling the agent or Socket Mode', async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests++;
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const result = await start({
        SERVICE_TOKEN: 'synthetic-legacy-token',
        ADMIN_URL: url,
        ADMIN_INTERNAL_TOKEN: 'synthetic-admin-token',
        SLACK_APP_TOKEN: 'xapp-synthetic',
        SLACK_API_URL: `${url}/api/`,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Native adapter startup refused');
      expect(result.stderr).not.toContain('synthetic-legacy-token');
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses gated coding and missing native settings without fallback', async () => {
    for (const env of [{ SERVICE_TOKEN: 'synthetic-private' }, {}]) {
      const result = await start(env);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain('synthetic-private');
    }
  });

  it('rejects ambiguous or unknown startup arguments before loading any environment', async () => {
    for (const args of [
      ['--process-env', '--env', path.join(os.tmpdir(), 'unused.env')],
      ['--old-runtime'],
    ])
      expect((await start({}, args)).code).toBe(1);
  });
});
