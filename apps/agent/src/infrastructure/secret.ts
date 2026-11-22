import { RuntimeConfigurationError } from './configuration-error.js';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Resolve a role-scoped secret without exposing its contents or mount path. */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const fileName = name + '_FILE';
  const file = env[fileName]?.trim();
  let value = env[name]?.trim();
  if (file) {
    if (value) throw new RuntimeConfigurationError(`configure only one of ${name} and ${fileName}`);
    if (!isAbsolute(file))
      throw new RuntimeConfigurationError(`${fileName} requires an absolute path`);
    try {
      value = readFileSync(file, 'utf8');
    } catch {
      throw new RuntimeConfigurationError(`${fileName} unreadable`);
    }
  }
  value = value?.trim();
  if (!value || /^(<|placeholder|change-?me)/i.test(value))
    throw new RuntimeConfigurationError(`${name} or ${fileName} requires a secret`);
  return value;
}
