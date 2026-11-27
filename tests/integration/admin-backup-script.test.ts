/**
 * Deterministic tests of deploy/docker/admin-backup.sh and its systemd units: a fake
 * `docker` on PATH stands in for the admin container, so no Docker, root or
 * real admin store is touched. Running the units on the VM is the live
 * evidence (docs/production-recovery.md, "Admin store backups").
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'deploy/docker', 'admin-backup.sh');
const SECRET = 'f'.repeat(64);

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Fake docker: `ps` prints a container id when FAKE_ADMIN_RUNNING=1 (and
// logs its filters); `exec` writes the snapshot the script names (its last
// argument) into the store, or fails when FAKE_EXEC_FAIL=1.
const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
case $1 in
  ps) [ "\${FAKE_ADMIN_RUNNING:-0}" = 1 ] && echo abc123 ; exit 0 ;;
  exec)
    [ "\${FAKE_EXEC_FAIL:-0}" = 1 ] && exit 1
    name=\${!#}
    printf 'snapshot-of-live-db' > "$FAKE_STORE_DIR/$name"
    exit 0 ;;
esac
exit 2
`;

interface Setup {
  root: string;
  store: string;
  out: string;
  envFile: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

function setup(envLines?: string[]): Setup {
  const root = mkdtempSync(path.join(os.tmpdir(), 'support-agent-admin-backup-'));
  scratch.push(root);
  const store = path.join(root, 'admin-store');
  mkdirSync(store);
  writeFileSync(path.join(store, 'admin.sqlite'), 'raw-db');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const envFile = path.join(root, 'instance.env');
  writeFileSync(
    envFile,
    (
      envLines ?? [
        'COMPOSE_PROJECT_NAME=support-agent-unit',
        `ADMIN_STORE_DIR="${store}"`,
        `ADMIN_STORE_KEY=${SECRET}`,
      ]
    ).join('\n') + '\n',
  );
  const log = path.join(root, 'docker.log');
  return {
    root,
    store,
    out: path.join(root, 'backups'),
    envFile,
    log,
    env: {
      PATH: [bin, process.env.PATH].join(path.delimiter),
      DOCKER_HOST: process.env.DOCKER_HOST,
      FAKE_LOG: log,
      FAKE_STORE_DIR: store,
    },
  };
}

function run(s: Setup, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', [SCRIPT, '--env-file', s.envFile, '--out', s.out, ...args], {
    encoding: 'utf8',
    env: { ...s.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function archives(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /^admin-.*\.tar\.gz$/.test(name))
    .sort();
}

function archiveEntries(file: string): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'support-agent-admin-extract-'));
  scratch.push(dir);
  const untar = spawnSync('tar', ['-xzf', file, '-C', dir], { encoding: 'utf8' });
  expect(untar.status, untar.stderr).toBe(0);
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]),
  );
}

describe('deploy/docker/admin-backup.sh', () => {
  it('snapshots the running admin container into a private archive', () => {
    const s = setup();
    const result = run(s, ['--reason', 'hourly'], { FAKE_ADMIN_RUNNING: '1' });
    expect(result.status, result.stderr).toBe(0);
    const [archive] = archives(s.out);
    expect(archive).toMatch(/^admin-\d{8}T\d{6}Z-hourly\.tar\.gz$/);
    expect(archiveEntries(path.join(s.out, archive!))).toEqual({
      'admin.sqlite': 'snapshot-of-live-db',
    });
    expect(statSync(s.out).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(s.out, archive!)).mode & 0o777).toBe(0o600);
    // Only this project's admin service is looked up, and the snapshot never
    // stays in the live store.
    const log = readFileSync(s.log, 'utf8');
    expect(log).toContain('label=com.docker.compose.project=support-agent-unit');
    expect(log).toContain('label=com.docker.compose.service=admin');
    expect(log).toMatch(/^exec -i abc123 node -e /m);
    expect(readdirSync(s.store)).toEqual(['admin.sqlite']);
    expect(result.stdout).toContain('mode=snapshot');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  it('copies the checkpointed files when the admin container is stopped', () => {
    const s = setup();
    writeFileSync(path.join(s.store, 'admin.sqlite-wal'), 'wal');
    const result = run(s, ['--reason', 'shutdown']);
    expect(result.status, result.stderr).toBe(0);
    const [archive] = archives(s.out);
    expect(archive).toMatch(/-shutdown\.tar\.gz$/);
    expect(archiveEntries(path.join(s.out, archive!))).toEqual({
      'admin.sqlite': 'raw-db',
      'admin.sqlite-wal': 'wal',
    });
    expect(result.stdout).toContain('mode=copy');
    expect(readFileSync(s.log, 'utf8')).not.toContain('exec');
  });

  it('fails without an archive when the snapshot inside the container fails', () => {
    const s = setup();
    const result = run(s, [], { FAKE_ADMIN_RUNNING: '1', FAKE_EXEC_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('snapshot inside the admin container failed');
    expect(archives(s.out)).toEqual([]);
    expect(readdirSync(s.out).filter((name) => name.startsWith('.work'))).toEqual([]);
  });

  it('prunes archives older than --keep-hours but always keeps the newest --keep-min', () => {
    const s = setup();
    mkdirSync(s.out, { mode: 0o700 });
    const old = Date.now() / 1000 - 4 * 24 * 3600;
    const recent = Date.now() / 1000 - 3600;
    const make = (name: string, mtime: number) => {
      writeFileSync(path.join(s.out, name), 'x');
      utimesSync(path.join(s.out, name), mtime, mtime);
    };
    for (let day = 1; day <= 8; day += 1)
      make(`admin-202609${10 + day}T000000Z-hourly.tar.gz`, old);
    make('admin-20260929T230000Z-hourly.tar.gz', recent);
    make('unrelated.txt', old);
    const result = run(s, ['--keep-hours', '72', '--keep-min', '3']);
    expect(result.status, result.stderr).toBe(0);
    const left = archives(s.out);
    // New archive + the recent one + the newest old one fill --keep-min 3;
    // the other seven old archives exceed 72 h and go.
    expect(left).toHaveLength(3);
    expect(left).toContain('admin-20260929T230000Z-hourly.tar.gz');
    expect(left).toContain('admin-20260918T000000Z-hourly.tar.gz');
    expect(existsSync(path.join(s.out, 'unrelated.txt'))).toBe(true);
    expect(result.stdout).toContain('pruned=7');

    // Every archive old: the newest --keep-min survive regardless of age.
    const all = setup();
    mkdirSync(all.out, { mode: 0o700 });
    for (let day = 1; day <= 5; day += 1)
      writeFileSync(path.join(all.out, `admin-202609${10 + day}T000000Z-hourly.tar.gz`), 'x');
    for (const name of archives(all.out)) utimesSync(path.join(all.out, name), old, old);
    rmSync(path.join(all.store, 'admin.sqlite'));
    // The run itself fails (nothing to back up) and prunes nothing.
    expect(run(all, ['--keep-min', '2']).status).toBe(1);
    expect(archives(all.out)).toHaveLength(5);
  });

  it.each([
    [['COMPOSE_PROJECT_NAME=support-agent-unit'], 'ADMIN_STORE_DIR must be an absolute path'],
    [
      ['COMPOSE_PROJECT_NAME=support-agent-unit', 'ADMIN_STORE_DIR=relative/dir'],
      'must be an absolute',
    ],
    [['COMPOSE_PROJECT_NAME=support-agent-unit', 'ADMIN_STORE_DIR=/a/../b'], 'must not contain ..'],
    [['ADMIN_STORE_DIR=/tmp'], 'COMPOSE_PROJECT_NAME is missing or invalid'],
  ])('refuses an env file without a valid project or store (%j)', (lines, message) => {
    const s = setup(lines);
    const result = run(s);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(existsSync(s.out)).toBe(false);
  });

  it('refuses an output directory inside the store and malformed options', () => {
    const s = setup();
    const inside = spawnSync(
      'bash',
      [SCRIPT, '--env-file', s.envFile, '--out', path.join(s.store, 'backups')],
      { encoding: 'utf8', env: s.env },
    );
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain('--out must not be inside ADMIN_STORE_DIR');
    expect(run(s, ['--reason', 'Bad Label']).stderr).toContain('--reason must be');
    expect(run(s, ['--keep-hours', '0']).stderr).toContain('--keep-hours must be');
    expect(run(s, ['--keep-min', 'x']).stderr).toContain('--keep-min must be');
  });
});

describe('admin backup systemd units', () => {
  const unit = (name: string) => readFileSync(path.join(REPO_ROOT, 'deploy/docker', name), 'utf8');

  it('backs up at shutdown before Docker stops the containers', () => {
    const shutdown = unit('admin-backup-shutdown@.service');
    // Units stop in reverse start order: After=docker.service stops first.
    expect(shutdown).toMatch(/^After=docker\.service$/m);
    expect(shutdown).toMatch(/^RemainAfterExit=yes$/m);
    expect(shutdown).toMatch(/^ExecStart=\/bin\/true$/m);
    expect(shutdown).toMatch(/^ExecStop=.*admin-backup\.sh .*--reason shutdown$/m);
    expect(shutdown).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it('backs up hourly through the timer', () => {
    expect(unit('admin-backup@.service')).toMatch(
      /^ExecStart=.*admin-backup\.sh .*--reason hourly$/m,
    );
    expect(unit('admin-backup@.timer')).toMatch(/^OnUnitActiveSec=1h$/m);
    expect(unit('admin-backup@.timer')).toMatch(/^Persistent=true$/m);
  });
});
