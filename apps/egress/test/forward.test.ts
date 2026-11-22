import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseForwards, startForwards, type Forwarder } from '../src/forward.js';
import { policyFromEnv } from '../src/policy.js';
import { childListenerPort } from '../../../tests/integration/helpers/child-port.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('parseForwards', () => {
  it('parses listenPort:host:targetPort entries and reports malformed ones', () => {
    const parsed = parseForwards('9880:native-answer:9879, 3000:fake-slack:3000,bad,70000:x:1');
    expect(parsed.forwards).toEqual([
      { listenPort: 9880, targetHost: 'native-answer', targetPort: 9879 },
      { listenPort: 3000, targetHost: 'fake-slack', targetPort: 3000 },
    ]);
    expect(parsed.problems).toEqual([
      'EGRESS_FORWARDS: "bad" is not listenPort:host:targetPort; ignored',
      'EGRESS_FORWARDS: "70000:x:1" is not listenPort:host:targetPort; ignored',
    ]);
    expect(parseForwards(undefined)).toEqual({ forwards: [], problems: [] });
  });
});

describe('startForwards', () => {
  it('relays bytes to the target and logs failed upstream connections', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => echo.close(() => r())));
    const target = (echo.address() as net.AddressInfo).port;
    const lines: Record<string, unknown>[] = [];
    // Listen on an ephemeral port by probing one first.
    // not a just-freed ephemeral port (see child-port.ts).
    const listenPort = await childListenerPort();
    const forwarder: Forwarder = await startForwards(
      [{ listenPort, targetHost: '127.0.0.1', targetPort: target }],
      { host: '127.0.0.1', log: (line) => lines.push(line) },
    );
    cleanup.push(() => forwarder.close());
    expect(lines[0]).toMatchObject({ event: 'forwarding', listenPort });

    const client = net.connect({ host: '127.0.0.1', port: listenPort });
    await new Promise<void>((r) => client.once('connect', () => r()));
    client.write('hello');
    const reply = await new Promise<string>((r) => client.once('data', (d) => r(d.toString())));
    expect(reply).toBe('hello');
    client.destroy();

    await forwarder.close();
    cleanup.pop();
    const dead = await startForwards([{ listenPort, targetHost: '127.0.0.1', targetPort: 1 }], {
      host: '127.0.0.1',
      log: (line) => lines.push(line),
    });
    cleanup.push(() => dead.close());
    const failing = net.connect({ host: '127.0.0.1', port: listenPort });
    failing.on('error', () => undefined);
    await new Promise<void>((r) => failing.once('close', () => r()));
    expect(lines.find((l) => l.event === 'forward-error')).toMatchObject({ target: '127.0.0.1:1' });
  });

  it('refuses clients from the instance subnets and admits unknown sources', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => echo.close(() => r())));
    const target = (echo.address() as net.AddressInfo).port;
    // not a just-freed ephemeral port (see child-port.ts).
    const listenPort = await childListenerPort();
    const lines: Record<string, unknown>[] = [];
    const policyEnv: Record<string, string> = {
      SUPPORT_AGENT_FRONTEND_SUBNET: '10.255.0.0/24',
      SUPPORT_AGENT_TOOLS_SUBNET: '127.0.0.0/8', // the test client is a "tools" client
      SUPPORT_AGENT_WEB_SUBNET: '10.255.2.0/24',
    };
    const refusing = await startForwards(
      [{ listenPort, targetHost: '127.0.0.1', targetPort: target }],
      { host: '127.0.0.1', policy: policyFromEnv((n) => policyEnv[n]), log: (l) => lines.push(l) },
    );
    cleanup.push(() => refusing.close());
    const refused = net.connect({ host: '127.0.0.1', port: listenPort });
    refused.on('error', () => undefined);
    await new Promise<void>((r) => refused.once('close', () => r()));
    expect(lines.find((l) => l.event === 'forward-refused')).toMatchObject({ source: 'tools' });
    await refusing.close();
    cleanup.pop();

    const openEnv = { ...policyEnv, SUPPORT_AGENT_TOOLS_SUBNET: '10.255.1.0/24' };
    const admitting = await startForwards(
      [{ listenPort, targetHost: '127.0.0.1', targetPort: target }],
      { host: '127.0.0.1', policy: policyFromEnv((n) => openEnv[n]), log: (l) => lines.push(l) },
    );
    cleanup.push(() => admitting.close());
    const client = net.connect({ host: '127.0.0.1', port: listenPort });
    await new Promise<void>((r) => client.once('connect', () => r()));
    client.write('ok');
    expect(await new Promise<string>((r) => client.once('data', (d) => r(d.toString())))).toBe(
      'ok',
    );
    client.destroy();
  });
});
