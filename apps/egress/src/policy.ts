/**
 * Egress policy: which `host:port` a client may tunnel to, by the network
 * the client connects from. The host sets are derived from the instance's
 * env file (the variables scripts/deploy-preflight.mjs validates) and
 * matched by hostname, never by resolved address; they are the sets the
 * retired host firewall pinned.
 *
 *   frontend: Slack, the operations webhook and reply decider hosts, extra hosts (443)
 *   tools:    the frontend set plus model endpoints, GitLab hosts, api.atlassian.com (when a
 *             site is admitted), mcp.<site> per Datadog site, api.cloudflare.com
 *             (when admitted), cdn.optimizely.com (public Optimizely datafiles) and the
 *             executor's package registries (443)
 *   web:      any hostname whose resolved addresses are all public (80, 443);
 *             the private-range check happens on the resolved addresses
 *   unknown:  denied
 */

import { modelEgressHosts, parseModelCatalog } from './generated/model-catalog.js';
import { type Cidr, cidrContains, parseCidr, parseIpv4 } from './net.js';

export const SLACK_HOSTS = [
  'slack.com',
  'wss-primary.slack.com',
  'wss-backup.slack.com',
  'files.slack.com',
  // interaction response_url (replacing an ephemeral after a click)
  'hooks.slack.com',
] as const;

const OPTIMIZELY_DATAFILE_HOST = 'cdn.optimizely.com';

export const DEFAULT_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'repo.packagist.org',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
] as const;

export type Source = 'frontend' | 'tools' | 'web' | 'unknown';

export interface Policy {
  subnets: { frontend: Cidr | null; tools: Cidr | null; web: Cidr | null };
  /** Pinned hosts admitted from the frontend network (port 443). */
  frontendHosts: ReadonlySet<string>;
  /** Pinned hosts admitted from the tools network (port 443); a superset of frontendHosts. */
  toolsHosts: ReadonlySet<string>;
  modelHosts: ReadonlySet<string>;
  /** Problems found while deriving the policy (reported, never fatal: a bad entry is simply not admitted). */
  problems: string[];
}

export type Decision =
  | { allow: true; mode: 'pinned' | 'public' }
  | { allow: false; reason: 'unknown-source' | 'port' | 'host' | 'malformed' };

export interface PolicyEnv {
  (name: string): string | undefined;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

const HOST_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A DNS host name with at least two labels; IP literals are not host names. */
export function isHostName(host: string): boolean {
  if (!HOST_PATTERN.test(host)) return false;
  if (parseIpv4(host) !== null) return false;
  const lastLabel = host.slice(host.lastIndexOf('.') + 1);
  return !/^\d+$/.test(lastLabel);
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => normalizeHost(v))
    .filter((v) => v.length > 0);
}

function urlHost(value: string | undefined, name: string, problems: string[]): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    const host = normalizeHost(parsed.hostname);
    // A Compose service name (no dot, such as the model stub) is reached
    // directly on the internal network and never through the proxy.
    if (!host.includes('.') && !host.includes(':')) return null;
    if (parsed.protocol !== 'https:') {
      problems.push(`${name}: not an https URL; its host is not admitted`);
      return null;
    }
    return host;
  } catch {
    problems.push(`${name}: not a URL; its host is not admitted`);
    return null;
  }
}

export function policyFromEnv(get: PolicyEnv): Policy {
  const problems: string[] = [];
  const subnet = (name: string): Cidr | null => {
    const raw = (get(name) ?? '').trim();
    if (raw.length === 0) {
      problems.push(`${name}: unset; clients of that network are treated as unknown`);
      return null;
    }
    const parsed = parseCidr(raw);
    if (parsed === null)
      problems.push(`${name}: not an IPv4 CIDR; clients of that network are treated as unknown`);
    return parsed;
  };
  const subnets = {
    frontend: subnet('SUPPORT_AGENT_FRONTEND_SUBNET'),
    tools: subnet('SUPPORT_AGENT_TOOLS_SUBNET'),
    web: subnet('SUPPORT_AGENT_WEB_SUBNET'),
  };

  const frontend = new Set<string>(SLACK_HOSTS);
  const webhook = urlHost(get('OPERATIONS_WEBHOOK_URL'), 'OPERATIONS_WEBHOOK_URL', problems);
  if (webhook !== null) frontend.add(webhook);
  const decider = urlHost(get('THREAD_REPLY_DECIDER_URL'), 'THREAD_REPLY_DECIDER_URL', problems);
  if (decider !== null) frontend.add(decider);
  for (const host of list(get('SUPPORT_AGENT_EGRESS_EXTRA_HOSTS'))) {
    if (isHostName(host)) frontend.add(host);
    else
      problems.push(`SUPPORT_AGENT_EGRESS_EXTRA_HOSTS: "${host}" is not a host name; not admitted`);
  }

  const modelHosts = new Set<string>();
  const tools = new Set<string>(frontend);
  if (get('MODEL_CATALOG') !== undefined && get('NATIVE_MODEL_STUB') !== '1') {
    try {
      const catalog = parseModelCatalog(get('MODEL_CATALOG'), get('MODEL_DEFAULT_KEY'));
      for (const host of modelEgressHosts(catalog, {
        NATIVE_ANTHROPIC_BASE_URL: get('NATIVE_ANTHROPIC_BASE_URL'),
        NATIVE_OPENAI_BASE_URL: get('NATIVE_OPENAI_BASE_URL'),
        NATIVE_VERTEX_BASE_URL: get('NATIVE_VERTEX_BASE_URL'),
        NATIVE_VERTEX_PROJECT: get('NATIVE_VERTEX_PROJECT'),
        NATIVE_VERTEX_LOCATION: get('NATIVE_VERTEX_LOCATION'),
      })) {
        tools.add(host);
        modelHosts.add(host);
      }
    } catch (error) {
      if (error instanceof Error) problems.push(error.message);
    }
  }
  for (const host of list(get('GITLAB_HOSTS'))) {
    if (isHostName(host)) tools.add(host);
    else problems.push(`GITLAB_HOSTS: "${host}" is not a host name; not admitted`);
  }
  if (list(get('ATLASSIAN_SITES')).length > 0) tools.add('api.atlassian.com');
  for (const site of list(get('DATADOG_SITES'))) {
    const host = `mcp.${site}`;
    if (isHostName(host)) tools.add(host);
    else problems.push(`DATADOG_SITES: "${site}" is not a site; not admitted`);
  }
  for (const host of list(get('CLOUDFLARE_HOSTS'))) {
    if (host === 'api.cloudflare.com') tools.add(host);
    else problems.push(`CLOUDFLARE_HOSTS: "${host}" is not api.cloudflare.com; not admitted`);
  }
  tools.add(OPTIMIZELY_DATAFILE_HOST);
  const registries = list(get('EXECUTOR_EGRESS_HOSTS'));
  for (const host of registries.length > 0 ? registries : [...DEFAULT_REGISTRY_HOSTS]) {
    if (isHostName(host)) tools.add(host);
    else problems.push(`EXECUTOR_EGRESS_HOSTS: "${host}" is not a host name; not admitted`);
  }

  return { subnets, frontendHosts: frontend, toolsHosts: tools, modelHosts, problems };
}

export function sourceOf(policy: Policy, clientAddress: string): Source {
  const { frontend, tools, web } = policy.subnets;
  if (frontend !== null && cidrContains(frontend, clientAddress)) return 'frontend';
  if (tools !== null && cidrContains(tools, clientAddress)) return 'tools';
  if (web !== null && cidrContains(web, clientAddress)) return 'web';
  return 'unknown';
}

/** The decision for one CONNECT target before resolution (host-level). */
export function decide(policy: Policy, source: Source, hostRaw: string, port: number): Decision {
  const host = normalizeHost(hostRaw);
  if (!isHostName(host)) return { allow: false, reason: 'malformed' };
  switch (source) {
    case 'frontend':
      if (port !== 443) return { allow: false, reason: 'port' };
      return policy.frontendHosts.has(host)
        ? { allow: true, mode: 'pinned' }
        : { allow: false, reason: 'host' };
    case 'tools':
      if (port !== 443) return { allow: false, reason: 'port' };
      return policy.toolsHosts.has(host)
        ? { allow: true, mode: 'pinned' }
        : { allow: false, reason: 'host' };
    case 'web':
      if (port !== 443 && port !== 80) return { allow: false, reason: 'port' };
      return { allow: true, mode: 'public' };
    default:
      return { allow: false, reason: 'unknown-source' };
  }
}
