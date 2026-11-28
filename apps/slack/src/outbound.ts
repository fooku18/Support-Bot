/**
 * Outbound HTTP through the instance's egress proxy.
 * The adapter sits on an internal Compose network with no route out; its
 * Slack traffic tunnels through the proxy as CONNECT requests:
 *
 * - `createOutboundDispatcher`: the undici dispatcher for the Slack Web API
 *   client, Slack file transfers and the Socket Mode websocket.
 * - `configureOutbound`: undici's global dispatcher for `fetch` (the
 *   interaction response_url on hooks.slack.com). Requests to Compose service
 *   names (no dot: native-answer, admin, fake-slack) and loopback stay direct.
 */

import { Agent, Dispatcher, ProxyAgent, fetch, setGlobalDispatcher } from 'undici';

/** Dotted host names and IP literals leave through the proxy; service names and loopback do not. */
export function proxiedHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return false;
  return host.includes('.') || host.includes(':');
}

export class RoutingDispatcher extends Dispatcher {
  constructor(
    private readonly proxy: Dispatcher,
    private readonly direct: Dispatcher,
  ) {
    super();
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = options.origin;
    const hostname =
      typeof origin === 'string' ? new URL(origin).hostname : (origin?.hostname ?? '');
    return (proxiedHost(hostname) ? this.proxy : this.direct).dispatch(options, handler);
  }

  override async close(): Promise<void> {
    await Promise.all([this.proxy.close(), this.direct.close()]);
  }

  override async destroy(): Promise<void> {
    await Promise.all([this.proxy.destroy(), this.direct.destroy()]);
  }
}

/** Routes the global fetch through the proxy when a proxy URL is configured. */
export function configureOutbound(proxyUrl: string | undefined): RoutingDispatcher | undefined {
  if (proxyUrl === undefined) return undefined;
  const dispatcher = new RoutingDispatcher(new ProxyAgent(proxyUrl), new Agent());
  setGlobalDispatcher(dispatcher);
  return dispatcher;
}

/** CONNECT dispatcher for the Slack Web API client, file transfers and the Socket Mode websocket; undefined is direct. */
export function createOutboundDispatcher(proxyUrl: string | undefined): Dispatcher | undefined {
  if (proxyUrl === undefined) return undefined;
  return new ProxyAgent({ uri: proxyUrl, proxyTunnel: true });
}

export function dispatchedFetch(dispatcher: Dispatcher | undefined): typeof fetch {
  return (input, init) => fetch(input, { ...init, ...(dispatcher ? { dispatcher } : {}) });
}
