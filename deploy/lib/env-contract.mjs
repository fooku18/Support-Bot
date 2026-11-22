/**
 * Configuration contract shared by the deployment tooling and the live
 * harness: every environment (production `.env`, live-test `.env.testing`,
 * reference `.env.example`) carries the same variable NAMES; only values
 * differ. Instance identity (Compose project, image tag, host port, URL,
 * subnets) is ordinary per-environment values of those variables.
 *
 * Diagnostics name variables only; values are never printed.
 */

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Parses an env file as data (never sourced). */
export function readEnvFile(file) {
  return parseEnv(readFileSync(file, 'utf8'));
}

/** Uncommented `NAME=` entries of an env file, in file order. */
export function envNames(file) {
  const names = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Compares the name sets of labelled env files. Returns one entry per name
 * that is not present in every file, with the labels that lack it.
 */
export function envParity(files) {
  const sets = files.map(({ label, names }) => ({ label, names: new Set(names) }));
  const all = new Set(sets.flatMap(({ names }) => [...names]));
  const differences = [];
  for (const name of [...all].sort()) {
    const missingIn = sets.filter(({ names }) => !names.has(name)).map(({ label }) => label);
    if (missingIn.length > 0) differences.push({ name, missingIn });
  }
  return differences;
}
