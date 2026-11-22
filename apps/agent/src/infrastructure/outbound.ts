/**
 * Outbound HTTP through the instance's egress proxy.
 * The runner, executor, cli-runtime and web-runtime sit on internal Compose
 * networks with no route out; their external HTTPS tunnels through the
 * proxy as CONNECT requests:
 *
 * - `configureOutbound`: undici's global dispatcher for `fetch` (model providers, Atlassian/Datadog/Cloudflare/Slack tool calls). Requests to Compose service names (no dot:
 *   native-answer, admin, executor, cli-runtime, web-runtime) and loopback stay direct.
 * - `sandboxProxyEnv`: the HTTPS_PROXY/HTTP_PROXY/NO_PROXY triple for
 *   spawned sandboxes (glab, git, npm), which honor the variables.
 * - `outboundProxyUrl`: the configured proxy for git's `http.proxy` and the
 *   web runtime's CONNECT page transport.
 *
 */

import { lookup } from 'node:dns';
import { refusedModelAddress } from '../contracts/model-address.js';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Hosts a sandboxed CLI reaches directly: loopback and the Compose service
 * names of an instance (internal networks; the proxy admits no undotted name).
 */
export const NO_PROXY_HOSTS = [
  'localhost',
  '127.0.0.1',
  '::1',
  'native-answer',
  'admin',
  'adapter',
  'runner',
  'executor',
  'cli-runtime',
  'web-runtime',
  'egress',
] as const;

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

/** Validation problem of an EGRESS_PROXY_URL value, or null when usable (empty is direct). */
export function egressProxyUrlProblem(raw: string): string | null {
  if (raw.length === 0) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? null
      : 'must be an absolute http(s) URL of the egress proxy';
  } catch {
    return 'must be an absolute http(s) URL of the egress proxy';
  }
}

/** EGRESS_PROXY_URL from an environment (services without the runner config); throws by name only. */
export function egressProxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.EGRESS_PROXY_URL ?? '').trim();
  const problem = egressProxyUrlProblem(raw);
  if (problem !== null) throw new Error(`EGRESS_PROXY_URL ${problem}`);
  return raw.length > 0 ? raw : undefined;
}

let configuredProxyUrl: string | undefined;

/** Routes the global fetch through the proxy when a proxy URL is configured. */
export function configureOutbound(proxyUrl: string | undefined): RoutingDispatcher | undefined {
  configuredProxyUrl = proxyUrl;
  if (proxyUrl === undefined) return undefined;
  const dispatcher = new RoutingDispatcher(new ProxyAgent(proxyUrl), new Agent());
  setGlobalDispatcher(dispatcher);
  return dispatcher;
}

/** The proxy installed by `configureOutbound`, or undefined (direct). */
export function outboundProxyUrl(): string | undefined {
  return configuredProxyUrl;
}

/**
 * Proxy variables for a spawned sandbox (both spellings: curl/git read the
 * lowercase `http_proxy` only). Empty without a configured proxy.
 */
export function sandboxProxyEnv(
  proxyUrl: string | undefined = configuredProxyUrl,
): Record<string, string> {
  if (proxyUrl === undefined) return {};
  const noProxy = NO_PROXY_HOSTS.join(',');
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: noProxy,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    no_proxy: noProxy,
  };
}

const modelDispatcher = new Agent({
  connect: {
    lookup(host, options, callback) {
      lookup(host, { ...options, all: true }, (error, addresses) => {
        if (
          error ||
          !addresses?.length ||
          addresses.some(({ address }) => refusedModelAddress(address))
        ) {
          callback(error ?? new Error('Model destination refused'), []);
          return;
        }
        const first = addresses[0]!;
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      });
    },
  },
});

/** The CONNECT proxy checks its own DNS answers. Direct connections use the checked lookup. */
export const modelFetch: typeof fetch = (input, init) => {
  const options = configuredProxyUrl ? init : { ...init, dispatcher: modelDispatcher };
  return fetch(input, options);
};
