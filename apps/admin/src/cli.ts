/**
 * Operator CLI, run inside the admin container:
 *
 *   node apps/admin/dist/cli.js create-admin <name>
 *   node apps/admin/dist/cli.js set-password <name>
 *   node apps/admin/dist/cli.js create-api-token <name>
 *   node apps/admin/dist/cli.js provision-postgres
 *
 * Passwords are read from the terminal (or stdin when it is not a terminal),
 * never from the command line. A new API token is printed once on stdout.
 */

import { createInterface } from 'node:readline';
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  newApiToken,
  tokenHash,
  validAdminName,
} from './auth.js';
import { ConfigError, isPostgresUrl, loadConfig } from './config.js';
import { AdminStore, StoreError } from './store.js';
import { provisionSettingsDatabase } from './database.js';

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0]?.replace(/\r$/, '') ?? '';
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  const rl = createInterface({ input: process.stdin, terminal: false });
  return await new Promise((resolve) => {
    let value = '';
    process.stdin.on('data', (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stderr.write('\n');
          rl.close();
          resolve(value);
          return;
        }
        if (char === '\u0003') process.exit(130);
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    });
  });
}

async function readPassword(): Promise<string> {
  const password = await readSecret('Password: ');
  if (process.stdin.isTTY && (await readSecret('Repeat: ')) !== password) {
    throw new ConfigError('the passwords differ');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return password;
}

async function main(): Promise<void> {
  const [command, name] = process.argv.slice(2);
  if (command === 'provision-postgres' && name === undefined) {
    const connectionString = process.env.ADMIN_DATABASE_URL?.trim();
    if (!connectionString || !isPostgresUrl(connectionString)) {
      throw new ConfigError(
        'ADMIN_DATABASE_URL must name the PostgreSQL database as the schema owner',
      );
    }
    await provisionSettingsDatabase(connectionString);
    return;
  }
  if (command === undefined || name === undefined || !validAdminName(name)) {
    throw new ConfigError(
      'usage: node dist/cli.js create-admin|set-password|create-api-token <name> or provision-postgres',
    );
  }
  const config = loadConfig((key) => process.env[key]);
  const store = await AdminStore.open(config.database, config.storeKey);
  try {
    switch (command) {
      case 'create-admin':
        await store.createAdmin('cli', name, await hashPassword(await readPassword()));
        console.error(`admin ${name} created`);
        break;
      case 'set-password':
        if ((await store.adminByName(name)) === null)
          throw new ConfigError(`no admin named ${name}`);
        await store.setAdminPassword('cli', name, await hashPassword(await readPassword()));
        console.error(`password of ${name} changed`);
        break;
      case 'create-api-token': {
        const token = newApiToken();
        await store.createApiToken('cli', name, tokenHash(token));
        console.log(token);
        break;
      }
      default:
        throw new ConfigError(`unknown command ${command}`);
    }
  } finally {
    await store.close();
  }
}

await main().catch((err: unknown) => {
  console.error(
    err instanceof ConfigError || err instanceof StoreError
      ? err.message
      : 'settings operation failed',
  );
  process.exitCode = 1;
});
