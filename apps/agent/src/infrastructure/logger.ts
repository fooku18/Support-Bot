export interface StageLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Minimal stage logger. Callers pass pre-formatted strings containing only
 * sanitized identifiers (IDs, stage names); no helper accepts arbitrary
 * objects, so payloads and credentials cannot be dumped by accident.
 */
export function createStageLogger(scope: string): StageLogger {
  const write = (level: string, message: string, sink: (message: string) => void): void => {
    sink(`${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${message}`);
  };
  return {
    info: (message) => write('info', message, console.log),
    warn: (message) => write('warn', message, console.warn),
    error: (message) => write('error', message, console.error),
  };
}
