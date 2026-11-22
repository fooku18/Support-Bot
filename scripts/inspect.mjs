#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { deployment, requireNativeProject, status } from '../deploy/lib/native-deployment.mjs';
try {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } });
  const d = deployment(values['env-file']);
  requireNativeProject(d);
  console.log(JSON.stringify(status(d), null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Native inspection refused');
  process.exitCode = 2;
}
