/** Model stub entry point. Listens on MODEL_STUB_PORT (default 9877). */

import { startStub } from './server.js';

const raw = Number.parseInt(process.env.MODEL_STUB_PORT ?? '', 10);
const port = Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 9877;
const log = (line: Record<string, unknown>) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));

const stub = await startStub({ port, log });
log({ event: 'listening', port });
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    log({ event: 'stopping', requests: stub.requests() });
    void stub.close().then(() => process.exit(0));
  });
