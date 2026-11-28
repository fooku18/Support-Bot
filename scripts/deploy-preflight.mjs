#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  deployment,
  compose,
  requireNativeProject,
  drain,
  marker,
} from '../deploy/lib/native-deployment.mjs';
try {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'no-docker': { type: 'boolean' },
      'wait-idle': { type: 'boolean' },
    },
  });
  const d = deployment(values['env-file']);
  if (d.socketMode !== 'on')
    throw new Error(
      'SLACK_SOCKET_MODE=off is for test instances only; production needs Socket Mode',
    );
  if (values['no-docker'])
    console.log('Native configuration validated; no runtime inspection or drain marker.');
  else {
    compose(d, ['config', '--quiet']);
    const found = requireNativeProject(d);
    if (!found.some((c) => c.service === 'native-answer' && c.running))
      throw new Error('native application is not running; drain cannot be established');
    const value = await drain(d, values['wait-idle'] ? 35 * 60 * 1000 : 0);
    marker(d, value);
    console.log('Native application idle; retained waits preserved; drain marker written.');
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Native preflight refused');
  process.exitCode = 2;
}
