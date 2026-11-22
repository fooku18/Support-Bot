/**
 * the child-process fixtures picked the child's port by
 * opening and closing a port-0 listener, so the next port-0 listener (the
 * fixture's own admin servers, other tests) could receive the same
 * port before the child bound it. The port now comes from below the kernel's
 * ephemeral range, from a per-worker block.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHILD_PORT_BLOCK,
  CHILD_PORT_FLOOR,
  childPortBlock,
  childListenerPort,
  ephemeralPortRange,
} from '../../../tests/integration/helpers/child-port.js';

const opened: net.Server[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      opened.push(server);
      resolve(server);
    });
  });
}

describe('child test port', () => {
  it('reads the kernel ephemeral range and falls back to the IANA range', () => {
    expect(ephemeralPortRange('32768\t60999\n')).toEqual({ low: 32768, high: 60999 });
    expect(ephemeralPortRange('')).toEqual({ low: 49152, high: 65535 });
    expect(ephemeralPortRange('garbage')).toEqual({ low: 49152, high: 65535 });
  });

  it('gives each worker its own block, entirely below the ephemeral range', () => {
    const blocks = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => childPortBlock(String(id), 32768));
    for (const block of blocks) {
      expect(block.start).toBeGreaterThanOrEqual(CHILD_PORT_FLOOR);
      expect(block.end).toBeLessThan(32768);
      expect(block.end - block.start + 1).toBe(CHILD_PORT_BLOCK);
    }
    const ports = new Set(blocks.flatMap((b) => [b.start, b.end]));
    expect(ports.size).toBe(16);
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i]!.start).toBeGreaterThan(blocks[i - 1]!.end);
    }
    expect(() => childPortBlock('1', CHILD_PORT_FLOOR)).toThrow(/no child test ports/);
    expect(() => childPortBlock('49', 32768)).toThrow(/exceeds/);
    expect(childPortBlock('48', 32768).end).toBeLessThan(32768);
  });

  it('is never handed to port-0 listeners or outgoing connections afterwards', async () => {
    const { low } = ephemeralPortRange();
    const port = await childListenerPort();
    const block = childPortBlock(process.env.VITEST_POOL_ID, low);
    expect(port).toBeGreaterThanOrEqual(block.start);
    expect(port).toBeLessThanOrEqual(block.end);
    expect(port).toBeLessThan(low);
    // What the fixture does next (admin, proxy) and what other
    // tests do concurrently: none of it can take the chosen port.
    const target = await listen(0);
    const targetPort = (target.address() as net.AddressInfo).port;
    for (let i = 0; i < 100; i += 1) {
      const server = await listen(0);
      expect((server.address() as net.AddressInfo).port).not.toBe(port);
      const client = await new Promise<net.Socket>((resolve) => {
        const socket = net.connect(targetPort, '127.0.0.1', () => resolve(socket));
      });
      expect(client.localPort).not.toBe(port);
      client.destroy();
    }
    // the child can still bind it.
    await listen(port);
  });

  it('skips a port already held and does not repeat the previous port', async () => {
    const first = await childListenerPort();
    const held = await listen(first);
    const second = await childListenerPort();
    expect(second).not.toBe(first);
    await new Promise((r) => held.close(r));
  });
});
