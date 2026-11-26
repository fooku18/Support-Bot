import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envNames } from './env-contract.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function applicationVariables() {
  const deploy = path.join(repo, 'deploy');
  const names = new Set(envNames(path.join(repo, '.env.example')));
  for (const file of fs.readdirSync(deploy).filter((f) => /^compose.*\.ya?ml$/.test(f)))
    for (const [, name] of fs
      .readFileSync(path.join(deploy, file), 'utf8')
      .matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g))
      names.add(name);
  return new Set([...names].map((name) => name.toUpperCase()));
}

/** Compose interpolation takes application values from the designated env file.
 * The host environment is inherited without any application variable or
 * Compose setting, so Docker finds its plugins, contexts and credentials on
 * every platform. Explicit operation settings (such as a candidate secret
 * reference) are added by the caller. */
export function composeHostEnvironment(source = process.env) {
  const blocked = applicationVariables();
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (value && !name.startsWith('COMPOSE_') && !blocked.has(name)) env[key] = value;
  }
  return env;
}
