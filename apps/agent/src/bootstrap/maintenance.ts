import { postgresTransport } from '../infrastructure/storage/postgres-connection.js';
import { RuntimeConfigurationError } from '../infrastructure/configuration-error.js';
import { isAbsolute } from 'node:path';
import { readSecret } from '../infrastructure/secret.js';

/** Both maintenance roles operate as postgres and select the database themselves. */
export function maintenanceConnection(env: NodeJS.ProcessEnv) {
  const socket = env.NATIVE_PG_SOCKET?.trim();
  const host = env.NATIVE_PG_HOST?.trim();
  if (socket) {
    if (!isAbsolute(socket) || host)
      throw new RuntimeConfigurationError('configure NATIVE_PG_SOCKET or NATIVE_PG_HOST');
    return { host: socket, user: 'postgres', ...postgresTransport(env, socket) };
  }
  if (!host || host.includes('/'))
    throw new RuntimeConfigurationError('valid NATIVE_PG_HOST required');
  return {
    host,
    ...postgresTransport(env, host),
    user: 'postgres',
    password: readSecret(env, 'NATIVE_PG_ADMIN_PASSWORD'),
  };
}
