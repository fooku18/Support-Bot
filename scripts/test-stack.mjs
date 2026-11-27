#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  deployment,
  compose,
  requireNativeProject,
  drain,
  readModelMode,
  writeModelMode,
} from '../deploy/lib/native-deployment.mjs';
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'instance-dir': { type: 'string' },
      provision: { type: 'boolean' },
      'model-mode': { type: 'string' },
    },
  });
  const action = positionals[0];
  if (positionals.length !== 1 || !['up', 'ps', 'down'].includes(action))
    throw new Error(
      'usage: test-stack.mjs up|ps|down --instance-dir path [--model-mode stub|gateway] [--provision]',
    );
  if (values.provision && action !== 'up') throw new Error('provision requires up');
  if (values['model-mode'] !== undefined && action !== 'up')
    throw new Error('--model-mode requires up');
  if (!values['instance-dir'])
    throw new Error('--instance-dir is required; configuration lives outside the checkout');
  const dir = path.resolve(values['instance-dir']);
  // `up` chooses the mode (default gateway); `ps` and `down` use the recorded one.
  let mode = action === 'up' ? (values['model-mode'] ?? 'gateway') : readModelMode(dir);
  if (!['stub', 'gateway', null].includes(mode))
    throw new Error('--model-mode must be stub or gateway');
  const load = () => {
    // The stub accepts only synthetic keys. The env file and the real keys
    // file stay untouched; the overrides apply to this command only.
    return deployment(path.join(dir, '.env.testing'), { modelMode: mode ?? 'gateway' });
  };
  let d = load();
  compose(d, ['config', '--quiet']);
  const found = requireNativeProject(d);
  if (action === 'ps') console.log(compose(d, ['ps']));
  else if (action === 'down') {
    // A running stub is always stopped, whatever the record says.
    if (mode !== 'stub' && found.some((c) => c.service === 'model-stub' && c.running)) {
      mode = 'stub';
      d = load();
    }
    compose(d, ['stop', 'adapter']);
    if (found.some((c) => c.service === 'native-answer' && c.running))
      await drain(d, 35 * 60 * 1000);
    compose(d, [
      'stop',
      'native-answer',
      ...(mode === 'stub' ? ['model-stub'] : []),
      'native-cli-runtime',
      ...(d.env.NATIVE_OBSERVABILITY_SOURCE === 'native' ? ['native-observability'] : []),
      'native-postgres',
      'admin',
      'egress',
    ]);
    console.log('Test services stopped; containers, volumes, stores and model mode retained.');
  } else {
    if (found.some((c) => c.service === 'adapter' && c.running))
      throw new Error('stop intake with test:stack:down before recreation');
    if (found.some((c) => c.service === 'model-stub' && c.running))
      throw new Error('stop the model stub with test:stack:down before recreation');
    if (found.some((c) => c.service === 'native-answer' && c.running)) await drain(d);
    if (values.provision) {
      if (found.length) throw new Error('fresh provisioning requires an empty project');
      compose(d, ['up', '-d', '--no-build', '--pull', 'never', '--wait', 'native-postgres']);
      compose(d, ['run', '--no-deps', 'native-provision']);
    }
    compose(d, ['run', '--rm', '--pull', 'never', 'native-upgrade']);
    // Recorded before the start: containers may carry this mode's configuration
    // even if the start fails.
    writeModelMode(dir, mode);
    compose(d, [
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '180',
      'egress',
      'admin',
      'native-postgres',
      ...(mode === 'stub' ? ['model-stub'] : []),
      'native-answer',
      'adapter',
    ]);
    console.log(`Native test services ready (model mode ${mode}).`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Native test operation refused');
  process.exitCode = 2;
}
