/**
 * Outbound HTTP through the instance's egress proxy.
 * The admin service sits on internal Compose networks with no route out;
 * its Slack calls (OAuth exchange, listings) tunnel through the proxy as
 * CONNECT requests. Requests to Compose service names (no dot) and loopback
 * stay direct. Installed once at process start as undici's global
 * dispatcher, so the global `fetch` needs no per-call changes.
 */

import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

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
