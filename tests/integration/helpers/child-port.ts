/**
 * Listener port for a child process a package test starts on a port it
 * chooses: a fake service and the fake Gateway.
 *
 * A child that cannot bind port 0 and does
 * not report a chosen port, so the test picks one. The former helpers asked
 * the kernel for a free ephemeral port, closed it and passed the number to
 * the child; in between, the fixture's own admin/proxy servers and
 * every other test listening on port 0 draw from the same ephemeral range
 * and can receive that very port (e.g. `bind --listen
 * 127.0.0.1:43407: Address already in use`).
 *
 * Ports below the kernel's ephemeral range are never handed out for port-0
 * listeners or outgoing connections, so only an explicit bind can take one.
 * Each worker in one Vitest invocation draws from its own bounded block.
 * Separate invocations reuse worker IDs: run package suites sequentially
 * on a shared host. A bind probe skips held ports, but cannot reserve the
 * handoff against unrelated explicit listeners.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';

/** Lowest port handed to test children (above common fixed service ports). */
export const CHILD_PORT_FLOOR = 20000;
/** Ports per Vitest worker. */
export const CHILD_PORT_BLOCK = 256;

/** The kernel's ephemeral port range (Linux `ip_local_port_range`, else IANA 49152-65535). */
export function ephemeralPortRange(procText: string | undefined = readProc()): {
  low: number;
  high: number;
} {
  const [low, high] = (procText ?? '').trim().split(/\s+/).map(Number);
  if (Number.isInteger(low) && Number.isInteger(high) && low! > 0 && high! >= low!) {
    return { low: low!, high: high! };
  }
  return { low: 49152, high: 65535 };
}

function readProc(): string | undefined {
  try {
    return readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');
  } catch {
    return undefined;
  }
}

/** The worker's block of candidate ports, entirely below the ephemeral range. */
export function childPortBlock(
  poolId: string | undefined,
  ephemeralLow: number,
): { start: number; end: number } {
  const blocks = Math.floor((ephemeralLow - CHILD_PORT_FLOOR) / CHILD_PORT_BLOCK);
  if (blocks < 1) {
    throw new Error(
      `no child test ports below the ephemeral range (starts at ${ephemeralLow}, floor ${CHILD_PORT_FLOOR})`,
    );
  }
  const worker = Math.max(0, Number.parseInt(poolId ?? '', 10) || 0);
  if (worker >= blocks)
    throw new Error(`Vitest worker ${worker} exceeds ${blocks} child-port blocks`);
  const start = CHILD_PORT_FLOOR + worker * CHILD_PORT_BLOCK;
  return { start, end: start + CHILD_PORT_BLOCK - 1 };
}

async function bindable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

let nextOffset: number | undefined;

/**
 * A port for the next test child of this worker. Successive calls walk
 * the block, so a just-stopped node's port is not reused at once.
 */
export async function childListenerPort(): Promise<number> {
  const { start, end } = childPortBlock(process.env.VITEST_POOL_ID, ephemeralPortRange().low);
  const size = end - start + 1;
  nextOffset ??= Math.floor(Math.random() * size);
  for (let tried = 0; tried < size; tried += 1) {
    const port = start + ((nextOffset + tried) % size);
    if (await bindable(port)) {
      nextOffset = (nextOffset + tried + 1) % size;
      return port;
    }
  }
  throw new Error(`no bindable child test port in ${start}-${end}`);
}
