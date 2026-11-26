import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { readSecret } from '../../src/infrastructure/secret.js';
import { maintenanceConnection } from '../../src/bootstrap/maintenance.js';
import {
  holdExecutionLease,
  startNativeAnswerProcess,
  watchIdleConnections,
} from '../../src/bootstrap/application.js';

it('resolves one secret source and reports only variable names on failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-config-'));
  const file = join(root, 'synthetic');
  try {
    for (const value of ['', '  ', '<operator: fixture>', 'change-me', 'placeholder-value']) {
      writeFileSync(file, value);
      for (const env of [{ KEY: value }, { KEY_FILE: file }])
        expect(() => readSecret(env, 'KEY')).toThrow('KEY or KEY_FILE requires a secret');
    }
    writeFileSync(file, 'fixture\n');
    expect(readSecret({ KEY_FILE: file }, 'KEY')).toBe('fixture');
    expect(readSecret({ KEY: 'fixture' }, 'KEY')).toBe('fixture');
    expect(readSecret({ KEY: '  ', KEY_FILE: file }, 'KEY')).toBe('fixture');
    expect(readSecret({ KEY: 'fixture', KEY_FILE: '  ' }, 'KEY')).toBe('fixture');
    expect(() => readSecret({ KEY: 'private', KEY_FILE: file }, 'KEY')).toThrow(
      /^configure only one of KEY and KEY_FILE$/,
    );
    expect(() => readSecret({ KEY_FILE: 'relative' }, 'KEY')).toThrow('absolute path');
    expect(() => readSecret({ KEY_FILE: file + 'missing' }, 'KEY')).toThrow(
      /^KEY_FILE unreadable$/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

it('keeps socket maintenance distinct from authenticated TCP', () => {
  const env = { NATIVE_PG_HOST: 'pg', NATIVE_PG_PORT: '5433', NATIVE_PG_ADMIN_PASSWORD: 'fixture' };
  expect(maintenanceConnection(env)).toEqual({
    host: 'pg',
    port: 5433,
    ssl: false,
    user: 'postgres',
    password: 'fixture',
  });
  expect(maintenanceConnection({ NATIVE_PG_SOCKET: '/run/pg', NATIVE_PG_HOST: '  ' })).toEqual({
    host: '/run/pg',
    port: 5432,
    ssl: false,
    user: 'postgres',
  });
  expect(() => maintenanceConnection({ ...env, NATIVE_PG_SOCKET: '/run/pg' })).toThrow(
    'or NATIVE_PG_HOST',
  );
  expect(() => maintenanceConnection({ ...env, NATIVE_PG_PORT: '0' })).toThrow('NATIVE_PG_PORT');
  expect(() => maintenanceConnection({ NATIVE_PG_HOST: 'pg' })).toThrow('NATIVE_PG_ADMIN_PASSWORD');
});

it.each([
  { CLI_RUNTIME_URL: 'http://cli' },
  { CLI_RUNTIME_TOKEN: 'fixture' },
  { NATIVE_CODING_STORE: tmpdir() },
])('refuses incomplete CLI configuration before connecting', async (env) => {
  await expect(startNativeAnswerProcess(env)).rejects.toThrow(
    'CLI_RUNTIME_URL and CLI_RUNTIME_TOKEN',
  );
});

it('defaults blank TCP settings and validates the port and TLS policy', () => {
  const env = {
    NATIVE_PG_SOCKET: ' ',
    NATIVE_PG_HOST: 'pg',
    NATIVE_PG_ADMIN_PASSWORD: 'fixture',
    NATIVE_PG_PORT: ' ',
  };
  expect(maintenanceConnection(env)).toMatchObject({ port: 5432, ssl: false });
  for (const port of ['0', '65536', 'invalid', '1e3', '5432.1'])
    expect(() => maintenanceConnection({ ...env, NATIVE_PG_PORT: port })).toThrow(
      /^NATIVE_PG_PORT must be a TCP port$/,
    );
  for (const mode of ['require', 'verify-full'])
    expect(maintenanceConnection({ ...env, NATIVE_PG_SSLMODE: mode }).ssl).toEqual({
      rejectUnauthorized: true,
    });
  expect(maintenanceConnection({ ...env, PGSSLMODE: 'verify-ca' }).ssl).toMatchObject({
    rejectUnauthorized: true,
    checkServerIdentity: expect.any(Function),
  });
  expect(() => maintenanceConnection({ ...env, NATIVE_PG_SSLMODE: 'no-verify' })).toThrow(
    'unsupported',
  );
  expect(() => maintenanceConnection({ ...env, NATIVE_PG_SSLROOTCERT: 'private-path' })).toThrow(
    /^NATIVE_PG_SSLROOTCERT requires TLS$/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'runtime-ca-'));
  try {
    const file = join(dir, 'ca.pem');
    const tls = { ...env, NATIVE_PG_SSLMODE: 'verify-full', NATIVE_PG_SSLROOTCERT: file };
    expect(() => maintenanceConnection(tls)).toThrow(/^NATIVE_PG_SSLROOTCERT unreadable$/);
    writeFileSync(file, 'synthetic CA contents');
    expect(maintenanceConnection(tls).ssl).toEqual({
      rejectUnauthorized: true,
      ca: 'synthetic CA contents',
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

it('logs idle connection failures and exits on purpose when the execution lease is lost', () => {
  const lines: string[] = [];
  const log = { info: () => undefined, warn: () => undefined, error: (m: string) => lines.push(m) };
  const pool = new EventEmitter();
  watchIdleConnections(pool as unknown as Pool, log);
  pool.emit(
    'error',
    Object.assign(new Error('terminating connection host=secret'), { code: '57P01' }),
  );
  expect(lines).toEqual(['idle database connection failed reason=Error']);

  lines.length = 0;
  const exits: number[] = [];
  let closing = false;
  const lease = new EventEmitter();
  holdExecutionLease(
    lease as unknown as PoolClient,
    log,
    () => closing,
    (code) => exits.push(code),
  );
  lease.emit('error', new Error('Connection terminated unexpectedly'));
  expect(lines).toEqual(['execution lease lost reason=Error']);
  expect(exits).toEqual([1]);

  lines.length = 0;
  closing = true;
  lease.emit('error', new Error('Connection terminated unexpectedly'));
  expect(lines).toEqual([]);
  expect(exits).toEqual([1]);
});
