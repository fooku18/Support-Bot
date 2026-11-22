import { describe, expect, it } from 'vitest';
import { findNativeEnvFileArg, parseEnvFileArgs } from '../src/config.js';

describe('parseEnvFileArgs', () => {
  it('supports the separated and equals forms', () => {
    expect(parseEnvFileArgs(['--env', '/tmp/other.env'])).toEqual({
      envFilePath: '/tmp/other.env',
      processEnv: false,
      unknownArgs: [],
    });
    expect(parseEnvFileArgs(['--env=/tmp/other.env'])).toEqual({
      envFilePath: '/tmp/other.env',
      processEnv: false,
      unknownArgs: [],
    });
  });

  it('reports missing and unknown arguments', () => {
    expect(parseEnvFileArgs(['--env'])).toEqual({
      envFilePath: undefined,
      processEnv: false,
      unknownArgs: ['--env'],
    });
    expect(parseEnvFileArgs(['--env=', '--watch'])).toEqual({
      envFilePath: undefined,
      processEnv: false,
      unknownArgs: ['--env=', '--watch'],
    });
  });

  it('treats the Node-native --env-file flag as unknown so it is never silently honored', () => {
    expect(parseEnvFileArgs(['--env-file=/tmp/other.env']).unknownArgs).toContain(
      '--env-file=/tmp/other.env',
    );
    expect(findNativeEnvFileArg(['--env-file=/tmp/other.env'])).toBe('--env-file=/tmp/other.env');
    expect(findNativeEnvFileArg(['--env=/tmp/other.env'])).toBeUndefined();
  });

  it('selects the process-environment startup mode with --process-env', () => {
    expect(parseEnvFileArgs(['--process-env'])).toEqual({
      envFilePath: undefined,
      processEnv: true,
      unknownArgs: [],
    });
  });

  it('rejects combining --process-env with --env', () => {
    for (const argv of [
      ['--process-env', '--env', '/tmp/other.env'],
      ['--env=/tmp/other.env', '--process-env'],
    ]) {
      expect(() => parseEnvFileArgs(argv), `argv: ${argv.join(' ')}`).toThrow(/--process-env/);
    }
  });
});
