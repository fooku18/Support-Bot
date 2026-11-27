import childProcess, { type SpawnSyncOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const spawnSync = childProcess.spawnSync;

export const fakeDockerImport = import.meta.url;

function route(script: string): void {
  childProcess.spawnSync = ((command: string, args: string[], options: SpawnSyncOptions) =>
    command === 'docker'
      ? spawnSync(process.execPath, [script, ...args], options)
      : spawnSync(command, args, options)) as typeof spawnSync;
  syncBuiltinESMExports();
}

export function routeDocker(script: string): () => void {
  const saved = { FAKE_DOCKER: process.env.FAKE_DOCKER, NODE_OPTIONS: process.env.NODE_OPTIONS };
  process.env.FAKE_DOCKER = script;
  process.env.NODE_OPTIONS = [saved.NODE_OPTIONS, `--import=${fakeDockerImport}`]
    .filter(Boolean)
    .join(' ');
  route(script);
  return () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    childProcess.spawnSync = spawnSync;
    syncBuiltinESMExports();
  };
}

if (process.env.FAKE_DOCKER) route(process.env.FAKE_DOCKER);
