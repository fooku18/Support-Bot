import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const deploy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const keys = (entries) =>
  Array.isArray(entries)
    ? entries.map((entry) => String(entry).split('=')[0])
    : Object.keys(entries ?? {});

function applicationVariables() {
  const names = new Set();
  for (const file of fs.readdirSync(deploy).filter((f) => /^compose.*\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(deploy, file), 'utf8');
    for (const [, name] of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(name);
    for (const service of Object.values(parse(text)?.services ?? {}))
      for (const name of [...keys(service?.environment), ...keys(service?.build?.args)])
        names.add(name);
  }
  return new Set([...names].map((name) => name.toUpperCase()));
}

/** Compose interpolation takes application values from the designated env file.
 * The host environment is inherited without any variable the Compose files
 * interpolate or pass through and without any Compose setting, so Docker finds
 * its plugins, contexts and credentials on every platform. Explicit operation
 * settings (such as a candidate secret reference) are added by the caller. */
export function composeHostEnvironment(source = process.env) {
  const blocked = applicationVariables();
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (value && !name.startsWith('COMPOSE_') && !blocked.has(name)) env[key] = value;
  }
  return env;
}
