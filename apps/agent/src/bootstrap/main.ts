import { RuntimeConfigurationError } from '../infrastructure/configuration-error.js';
import { startNativeAnswerProcess } from './application.js';
import { CodeModeRuntimeError } from '../mastra/tools/code-mode.js';

let application: Awaited<ReturnType<typeof startNativeAnswerProcess>> | undefined;
let stopping = false;
const shutdown = () => {
  stopping = true;
  void application?.close().catch(() => {
    process.exitCode = 1;
  });
};
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
try {
  application = await startNativeAnswerProcess(process.env);
  if (stopping) await application.close();
} catch (error) {
  // Other startup errors can carry configuration values; print only this one.
  console.error(
    error instanceof RuntimeConfigurationError || error instanceof CodeModeRuntimeError
      ? `native answer startup refused: ${error.message}`
      : 'native answer startup refused; storage, configuration or authority unavailable',
  );
  process.exitCode = 1;
}
