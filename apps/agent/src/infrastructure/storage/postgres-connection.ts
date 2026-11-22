import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RuntimeConfigurationError } from '../configuration-error.js';

/** Explicit pg options keep TLS policy and port parsing consistent across roles. */
export function postgresTransport(env: NodeJS.ProcessEnv, host: string) {
  const raw = env.NATIVE_PG_PORT?.trim() || '5432';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535)
    throw new RuntimeConfigurationError('NATIVE_PG_PORT must be a TCP port');
  const mode = env.NATIVE_PG_SSLMODE?.trim() || env.PGSSLMODE?.trim() || 'disable';
  const file = env.NATIVE_PG_SSLROOTCERT?.trim();
  if (mode === 'disable') {
    if (file) throw new RuntimeConfigurationError('NATIVE_PG_SSLROOTCERT requires TLS');
    return { port, ssl: false as const };
  }
  if (!['require', 'verify-ca', 'verify-full'].includes(mode))
    throw new RuntimeConfigurationError('unsupported NATIVE_PG_SSLMODE or PGSSLMODE');
  if (isAbsolute(host)) throw new RuntimeConfigurationError('PostgreSQL TLS requires a TCP host');
  let ca: string | undefined;
  if (file) {
    if (!isAbsolute(file))
      throw new RuntimeConfigurationError('NATIVE_PG_SSLROOTCERT requires an absolute path');
    try {
      ca = readFileSync(file, 'utf8');
    } catch {
      throw new RuntimeConfigurationError('NATIVE_PG_SSLROOTCERT unreadable');
    }
    if (!ca.trim()) throw new RuntimeConfigurationError('NATIVE_PG_SSLROOTCERT is empty');
  }
  return {
    port,
    ssl: {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
    },
  };
}
