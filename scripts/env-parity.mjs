#!/usr/bin/env node
/**
 * Env parity: every environment file carries the same variable names.
 *
 *   node scripts/env-parity.mjs [--env-file FILE ...]
 *
 * With --instance-dir: root .env.example (reference list) and the selected
 * directory's .env.testing. Output lists names only, never values.
 * Exit codes: 0 equal, 1 names differ, 2 blocked (a file is missing).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { envNames, envParity } from '../deploy/lib/env-contract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_FILE = path.join(REPO_ROOT, '.env.example');

/** Returns { missing: [label], differences } for the given files. */
export function checkEnvParity(files, root = REPO_ROOT) {
  const missing = [];
  const present = [];
  for (const file of files) {
    const resolved = path.resolve(root, file);
    if (!existsSync(resolved)) missing.push(file);
    else present.push({ label: file, names: envNames(resolved) });
  }
  return { missing, differences: missing.length > 0 ? [] : envParity(present) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { 'env-file': { type: 'string', multiple: true }, 'instance-dir': { type: 'string' } },
  });
  if (!values['env-file']?.length && !values['instance-dir']) {
    console.error('blocked: --instance-dir or explicit --env-file arguments required');
    process.exit(2);
  }
  const files = values['env-file']?.length
    ? values['env-file']
    : [REFERENCE_FILE, path.resolve(values['instance-dir'], '.env.testing')];
  const { missing, differences } = checkEnvParity(files, process.cwd());
  if (missing.length > 0) {
    console.error(`blocked: env file missing: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (differences.length > 0) {
    for (const { name, missingIn } of differences)
      console.error(`${name}: missing in ${missingIn.join(', ')}`);
    console.error(`env parity failed: ${differences.length} name(s) differ`);
    process.exit(1);
  }
  console.log(`env parity ok: ${files.join(', ')}`);
}
