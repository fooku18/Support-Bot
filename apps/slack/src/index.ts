import { runNativeAdapter } from './native-application.js';
import {
  ConfigError,
  defaultEnvFilePath,
  findNativeEnvFileArg,
  loadEnvironment,
  parseEnvFileArgs,
} from './config.js';

async function main() {
  const nativeEnvFileArg = findNativeEnvFileArg(process.execArgv);
  if (nativeEnvFileArg !== undefined)
    throw new ConfigError('Use --env <path> or --process-env, not the Node --env-file flag.');
  const { envFilePath, processEnv, unknownArgs } = parseEnvFileArgs(process.argv.slice(2));
  if (unknownArgs.length)
    throw new ConfigError('Usage: node dist/index.js [--env <path>] [--process-env]');
  if (!processEnv) loadEnvironment(envFilePath ?? defaultEnvFilePath());
  await runNativeAdapter(process.env);
}

main().catch(() => {
  // Configuration may contain credentials. Native startup never falls back to
  // the agent or logs raw SDK, service or environment errors.
  console.error(
    'Native adapter startup refused; check native configuration and service readiness.',
  );
  process.exitCode = 1;
});
