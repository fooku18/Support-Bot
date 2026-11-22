import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_ENV_FILENAME = '.env.testing';
/**
 * The service root is the directory containing package.json. Resolved from
 * this module's own location so it does not depend on the shell's working
 * directory. Works both for `src/` under tsx and `dist/` under node.
 */
export function serviceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The project root is the parent of the service root; the default
 * environment file lives there.
 */
export function projectRoot(): string {
  return path.resolve(serviceRoot(), '..');
}

export function defaultEnvFilePath(): string {
  return path.join(projectRoot(), DEFAULT_ENV_FILENAME);
}

export interface EnvFileArgs {
  envFilePath?: string;
  /**
   * True when `--process-env` was passed: configuration is read from the
   * process environment only and no environment file is read (the container
   * startup mode).
   */
  processEnv: boolean;
  unknownArgs: string[];
}

/**
 * Supports `--env <path>`, `--env=<path>`, and the flag `--process-env` for
 * the environment-only startup mode used inside containers. Any other
 * argument is reported as unknown so the process fails fast instead of
 * running with surprising options. Combining `--process-env` with `--env` is
 * rejected: the two select different configuration sources.
 *
 * The file flag is deliberately spelled `--env`, not `--env-file`: Node.js
 * 20.6+ consumes `--env-file` natively before user code runs, which would
 * load the file with shell-environment-wins precedence (the opposite of what
 * this adapter documents) and bypass the friendly error for a missing file.
 */
export function parseEnvFileArgs(argv: readonly string[]): EnvFileArgs {
  const unknownArgs: string[] = [];
  let envFilePath: string | undefined;
  let processEnv = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--process-env') {
      processEnv = true;
    } else if (arg === '--env') {
      const next = argv[i + 1];
      if (next === undefined) {
        unknownArgs.push(arg);
      } else {
        envFilePath = next;
        i += 1;
      }
    } else if (arg.startsWith('--env=')) {
      const value = arg.slice('--env='.length);
      if (value.length > 0) {
        envFilePath = value;
      } else {
        unknownArgs.push(arg);
      }
    } else {
      unknownArgs.push(arg);
    }
  }
  if (processEnv && envFilePath !== undefined) {
    throw new ConfigError(
      '--process-env must not be combined with --env: they select different configuration sources (process environment vs. file). Pick one.',
    );
  }
  return { envFilePath, processEnv, unknownArgs };
}

/**
 * Detects Node's native `--env-file` flag, which Node itself consumes before
 * user code runs and which would silently apply different precedence than
 * documented.
 */
export function findNativeEnvFileArg(execArgv: readonly string[]): string | undefined {
  return execArgv.find((arg) => arg === '--env-file' || arg.startsWith('--env-file='));
}

/**
 * Loads a dotenv-format file with the `dotenv` parser (the file is parsed,
 * never executed as a shell script).
 *
 * Values from the file override any inherited shell environment so that
 * unrelated exported variables cannot silently win. The file path is chosen
 * explicitly (CLI flag or the default project-root location), never from the
 * working directory.
 */
export function loadEnvironment(envFilePath: string): Record<string, string> {
  const result = dotenv.config({ path: envFilePath, override: true, quiet: true });
  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new ConfigError(
        `Environment file not found: ${envFilePath}. Create it (see .env.example) or pass --env <path>.`,
      );
    }
    throw new ConfigError(
      `Failed to read environment file: ${envFilePath} (${err.code ?? err.name ?? 'unknown error'}). Values are never included in this message.`,
    );
  }
  return (result.parsed ?? {}) as Record<string, string>;
}
