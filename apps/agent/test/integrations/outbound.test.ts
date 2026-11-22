import { afterEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import {
  RoutingDispatcher,
  configureOutbound,
  egressProxyUrlFromEnv,
  egressProxyUrlProblem,
  outboundProxyUrl,
  proxiedHost,
  sandboxProxyEnv,
} from '../../src/infrastructure/outbound.js';

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

const original = getGlobalDispatcher();
afterEach(() => {
  configureOutbound(undefined);
  setGlobalDispatcher(original);
});

describe('proxiedHost', () => {
  it('sends dotted names and IP literals through the proxy, service names and loopback direct', () => {
    for (const host of [
      'gateway.example.com',
      'gitlab.com',
      'api.atlassian.com',
      'mcp.datadoghq.eu',
      '93.184.216.34',
      '[2606:4700::1111]',
    ])
      expect(proxiedHost(host), host).toBe(true);
    for (const host of [
      'native-answer',
      'admin',
      'executor',
      'cli-runtime',
      'web-runtime',
      'egress',
      'localhost',
      '127.0.0.1',
      '::1',
    ])
      expect(proxiedHost(host), host).toBe(false);
  });
});

describe('RoutingDispatcher', () => {
  it('routes the Gateway upstream through the proxy and internal services direct', () => {
    const calls: string[] = [];
    const dispatcher = new RoutingDispatcher(recorder('proxy', calls), recorder('direct', calls));
    const handler = {} as Dispatcher.DispatchHandler;
    dispatcher.dispatch(
      { origin: 'https://gateway.example.com', path: '/v1', method: 'POST' },
      handler,
    );
    dispatcher.dispatch(
      { origin: 'http://executor:9878', path: '/healthz', method: 'GET' },
      handler,
    );
    dispatcher.dispatch(
      { origin: new URL('http://127.0.0.1:41234'), path: '/', method: 'POST' },
      handler,
    );
    expect(calls).toEqual([
      'proxy:https://gateway.example.com',
      'direct:http://executor:9878',
      'direct:http://127.0.0.1:41234/',
    ]);
  });
});

describe('EGRESS_PROXY_URL', () => {
  it('accepts empty (direct) and http(s) URLs, refuses anything else by name only', () => {
    expect(egressProxyUrlProblem('')).toBeNull();
    expect(egressProxyUrlProblem('http://egress:3128')).toBeNull();
    expect(egressProxyUrlProblem('socks5://egress:1080')).toMatch(/http\(s\) URL/);
    expect(egressProxyUrlProblem('egress:3128')).toMatch(/http\(s\) URL/);
    expect(egressProxyUrlFromEnv({})).toBeUndefined();
    expect(egressProxyUrlFromEnv({ EGRESS_PROXY_URL: '  ' })).toBeUndefined();
    expect(egressProxyUrlFromEnv({ EGRESS_PROXY_URL: 'http://egress:3128' })).toBe(
      'http://egress:3128',
    );
    expect(() => egressProxyUrlFromEnv({ EGRESS_PROXY_URL: 'ftp://x' })).toThrow(
      /^EGRESS_PROXY_URL must be/,
    );
  });
});

describe('configureOutbound', () => {
  it('installs the routing dispatcher only with a proxy and remembers the URL', () => {
    expect(configureOutbound(undefined)).toBeUndefined();
    expect(getGlobalDispatcher()).toBe(original);
    expect(outboundProxyUrl()).toBeUndefined();
    const dispatcher = configureOutbound('http://egress:3128');
    expect(dispatcher).toBeInstanceOf(RoutingDispatcher);
    expect(getGlobalDispatcher()).toBe(dispatcher);
    expect(outboundProxyUrl()).toBe('http://egress:3128');
    // The process environment is never changed (the SDK subprocess inherits nothing).
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.https_proxy).toBeUndefined();
  });
});

describe('sandboxProxyEnv', () => {
  it('is empty without a proxy', () => {
    expect(sandboxProxyEnv(undefined)).toEqual({});
  });

  it('gives sandboxes the proxy in both spellings and keeps loopback and service names direct', () => {
    const env = sandboxProxyEnv('http://egress:3128');
    expect(env.HTTPS_PROXY).toBe('http://egress:3128');
    expect(env.HTTP_PROXY).toBe('http://egress:3128');
    expect(env.https_proxy).toBe('http://egress:3128');
    expect(env.http_proxy).toBe('http://egress:3128');
    expect(env.NO_PROXY).toBe(env.no_proxy);
    const noProxy = (env.NO_PROXY ?? '').split(',');
    for (const host of [
      'localhost',
      '127.0.0.1',
      '::1',
      'native-answer',
      'admin',
      'executor',
      'egress',
    ])
      expect(noProxy).toContain(host);
    expect(noProxy.some((host) => host.includes('.') && !/^\d/.test(host))).toBe(false);
  });

  it('defaults to the configured proxy', () => {
    configureOutbound('http://egress:3128');
    expect(sandboxProxyEnv().HTTPS_PROXY).toBe('http://egress:3128');
  });
});
