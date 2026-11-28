import { describe, expect, it } from 'vitest';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import {
  RoutingDispatcher,
  createOutboundDispatcher,
  dispatchedFetch,
  proxiedHost,
} from '../src/outbound.js';

function recorder(name: string, calls: string[]): Dispatcher {
  return {
    dispatch: (options: Dispatcher.DispatchOptions) => {
      calls.push(`${name}:${String(options.origin)}`);
      return true;
    },
    close: async () => undefined,
    destroy: async () => undefined,
  } as unknown as Dispatcher;
}

describe('proxiedHost', () => {
  it('sends dotted names and IP literals through the proxy, service names and loopback direct', () => {
    for (const host of [
      'slack.com',
      'hooks.slack.com',
      'WSS-PRIMARY.SLACK.COM',
      '93.184.216.34',
      '[2606:4700::1111]',
    ])
      expect(proxiedHost(host), host).toBe(true);
    for (const host of [
      'native-answer',
      'admin',
      'fake-slack',
      'egress',
      'localhost',
      '127.0.0.1',
      '::1',
    ])
      expect(proxiedHost(host), host).toBe(false);
  });
});

describe('RoutingDispatcher', () => {
  it('routes by the request origin', () => {
    const calls: string[] = [];
    const dispatcher = new RoutingDispatcher(recorder('proxy', calls), recorder('direct', calls));
    const handler = {} as Dispatcher.DispatchHandler;
    dispatcher.dispatch({ origin: 'https://slack.com', path: '/api/x', method: 'POST' }, handler);
    dispatcher.dispatch(
      { origin: new URL('http://admin:9883'), path: '/internal', method: 'GET' },
      handler,
    );
    dispatcher.dispatch({ origin: 'http://native-answer:9879', path: '/', method: 'GET' }, handler);
    expect(calls).toEqual([
      'proxy:https://slack.com',
      'direct:http://admin:9883/',
      'direct:http://native-answer:9879',
    ]);
  });
});

describe('createOutboundDispatcher', () => {
  it('is undefined without a proxy', () => {
    expect(createOutboundDispatcher(undefined)).toBeUndefined();
  });

  it('tunnels plain HTTP through CONNECT, as the egress proxy requires', async () => {
    const target = http.createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const connects: string[] = [];
    const proxy = http.createServer((_req, res) => res.writeHead(405).end());
    proxy.on('connect', (req, client) => {
      connects.push(String(req.url));
      const upstream = net.connect((target.address() as AddressInfo).port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const dispatcher = createOutboundDispatcher(
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    );
    try {
      const port = (target.address() as AddressInfo).port;
      const response = await dispatchedFetch(dispatcher)(`http://127.0.0.1:${port}/api/auth.test`);
      expect(await response.text()).toBe('reached');
      expect(connects).toEqual([`127.0.0.1:${port}`]);
    } finally {
      await dispatcher?.close();
      proxy.closeAllConnections();
      target.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => target.close(resolve));
    }
  });
});
