import { describe, expect, it } from 'vitest';
import type { Dispatcher } from 'undici';
import { RoutingDispatcher, proxiedHost } from '../src/outbound.js';

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

describe('outbound routing', () => {
  it('sends Slack through the proxy and the agent direct', () => {
    expect(proxiedHost('slack.com')).toBe(true);
    expect(proxiedHost('native-answer')).toBe(false);
    expect(proxiedHost('127.0.0.1')).toBe(false);
    const calls: string[] = [];
    const dispatcher = new RoutingDispatcher(recorder('proxy', calls), recorder('direct', calls));
    const handler = {} as Dispatcher.DispatchHandler;
    dispatcher.dispatch(
      { origin: 'https://slack.com', path: '/api/oauth.v2.access', method: 'POST' },
      handler,
    );
    dispatcher.dispatch({ origin: 'http://native-answer:9879', path: '/', method: 'GET' }, handler);
    expect(calls).toEqual(['proxy:https://slack.com', 'direct:http://native-answer:9879']);
  });
});
