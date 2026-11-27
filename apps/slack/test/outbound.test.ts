import { describe, expect, it } from 'vitest';
import { ProxyAgent, type Dispatcher } from 'undici';
import { RoutingDispatcher, createOutboundDispatcher, proxiedHost } from '../src/outbound.js';

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
  it('is undefined without a proxy and a CONNECT dispatcher with one', async () => {
    expect(createOutboundDispatcher(undefined)).toBeUndefined();
    const dispatcher = createOutboundDispatcher('http://egress:3128');
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    await dispatcher?.close();
  });
});
