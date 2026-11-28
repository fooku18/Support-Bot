import { describe, expect, it } from 'vitest';
import { cidrContains, isPrivateAddress, normalizeAddress, parseCidr } from '../src/net.js';
import { decide, policyFromEnv, sourceOf, type Policy } from '../src/policy.js';

const ENV: Record<string, string> = {
  SUPPORT_AGENT_FRONTEND_SUBNET: '172.30.20.0/24',
  SUPPORT_AGENT_TOOLS_SUBNET: '172.30.21.0/24',
  SUPPORT_AGENT_WEB_SUBNET: '172.30.30.0/24',
  MODEL_CATALOG: JSON.stringify([{ key: 'anthropic', route: 'anthropic', model: 'claude-test' }]),
  MODEL_DEFAULT_KEY: 'anthropic',
  OPERATIONS_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
  THREAD_REPLY_DECIDER_URL: 'https://decider.example.org/v1/systemone',
  SUPPORT_AGENT_EGRESS_EXTRA_HOSTS: 'extra.example.org, Bad Host',
  GITLAB_HOSTS: 'gitlab.com',
  ATLASSIAN_SITES: 'example.atlassian.net',
  DATADOG_SITES: 'datadoghq.eu',
  CLOUDFLARE_HOSTS: 'api.cloudflare.com',
  EXECUTOR_EGRESS_HOSTS: '',
};

function policy(overrides: Record<string, string> = {}): Policy {
  const env = { ...ENV, ...overrides };
  return policyFromEnv((name) => env[name]);
}

describe('policyFromEnv', () => {
  it('derives the pinned sets from the env file', () => {
    const p = policy();
    expect([...p.frontendHosts].sort()).toEqual([
      'decider.example.org',
      'extra.example.org',
      'files.slack.com',
      'hooks.slack.com',
      'slack.com',
      'wss-backup.slack.com',
      'wss-primary.slack.com',
    ]);
    for (const host of [
      'gitlab.com',
      'api.atlassian.com',
      'mcp.datadoghq.eu',
      'api.cloudflare.com',
      'cdn.optimizely.com',
      'registry.npmjs.org',
      'proxy.golang.org',
      'slack.com',
    ])
      expect(p.toolsHosts.has(host), host).toBe(true);
    expect(p.problems).toEqual([
      'SUPPORT_AGENT_EGRESS_EXTRA_HOSTS: "bad host" is not a host name; not admitted',
    ]);
  });

  it('admits nothing optional when the lists are empty and reports unset subnets', () => {
    const p = policy({
      ATLASSIAN_SITES: '',
      DATADOG_SITES: '',
      CLOUDFLARE_HOSTS: '',
      GITLAB_HOSTS: '',
      SUPPORT_AGENT_EGRESS_EXTRA_HOSTS: '',
      OPERATIONS_WEBHOOK_URL: '',
      THREAD_REPLY_DECIDER_URL: '',
      SUPPORT_AGENT_WEB_SUBNET: '',
    });
    expect(p.frontendHosts.has('decider.example.org')).toBe(false);
    expect(p.toolsHosts.has('api.atlassian.com')).toBe(false);
    expect(p.toolsHosts.has('api.cloudflare.com')).toBe(false);
    expect(p.toolsHosts.has('gitlab.com')).toBe(false);
    expect(p.frontendHosts.has('cdn.optimizely.com')).toBe(false);
    expect(p.toolsHosts.has('cdn.optimizely.com')).toBe(true);
    expect(p.frontendHosts.has('hooks.slack.com')).toBe(true); // always a Slack host
    expect(p.subnets.web).toBeNull();
    expect(p.problems).toContain(
      'SUPPORT_AGENT_WEB_SUBNET: unset; clients of that network are treated as unknown',
    );
  });

  it('allows only active provider hosts on the tools subnet', () => {
    const p = policy({
      EXECUTOR_EGRESS_HOSTS: 'registry.example.com',
      MODEL_CATALOG: JSON.stringify([
        { key: 'gpt', route: 'openai', model: 'gpt-test' },
        { key: 'gemini', route: 'vertex-gemini', model: 'gemini-test' },
      ]),
      MODEL_DEFAULT_KEY: 'gpt',
      NATIVE_VERTEX_PROJECT: 'fixture-project',
      NATIVE_VERTEX_LOCATION: 'europe-west1',
    });
    for (const host of [
      'api.openai.com',
      'europe-west1-aiplatform.googleapis.com',
      'oauth2.googleapis.com',
    ]) {
      expect(p.toolsHosts.has(host), host).toBe(true);
      expect(p.frontendHosts.has(host), host).toBe(false);
    }
    for (const host of [
      'api.anthropic.com',
      'aiplatform.googleapis.com',
      'metadata.google.internal',
      'registry.npmjs.org',
    ])
      expect(p.toolsHosts.has(host), host).toBe(false);
    expect(p.toolsHosts.has('registry.example.com')).toBe(true);
  });

  it('admits only the selected gateway hosts for model traffic', () => {
    const p = policy({
      MODEL_CATALOG: JSON.stringify(
        ['anthropic', 'openai', 'vertex-claude', 'vertex-gemini'].map((route) => ({
          route,
          key: route,
          model: 'fixture',
        })),
      ),
      NATIVE_ANTHROPIC_BASE_URL: 'https://claude.gateway.test/v1',
      NATIVE_OPENAI_BASE_URL: 'https://responses.gateway.test',
      NATIVE_VERTEX_BASE_URL: 'https://vertex.gateway.test/vertex/publishers',
    });
    expect([...p.modelHosts].sort()).toEqual([
      'claude.gateway.test',
      'responses.gateway.test',
      'vertex.gateway.test',
    ]);
    for (const host of p.modelHosts) {
      expect(p.toolsHosts.has(host)).toBe(true);
      expect(p.frontendHosts.has(host)).toBe(false);
    }
    for (const host of [
      'oauth2.googleapis.com',
      'aiplatform.googleapis.com',
      'api.anthropic.com',
      'api.openai.com',
    ])
      expect(p.toolsHosts.has(host)).toBe(false);
  });

  it('leaves external provider hosts unavailable in stub mode', () => {
    const p = policy({ NATIVE_MODEL_STUB: '1' });
    expect(p.toolsHosts.has('api.anthropic.com')).toBe(false);
    expect(p.toolsHosts.has('model-stub')).toBe(false);
  });
});

describe('sourceOf', () => {
  it('maps client addresses to the instance networks', () => {
    const p = policy();
    expect(sourceOf(p, '172.30.20.7')).toBe('frontend');
    expect(sourceOf(p, '::ffff:172.30.21.200')).toBe('tools');
    expect(sourceOf(p, '172.30.30.2')).toBe('web');
    expect(sourceOf(p, '172.30.0.2')).toBe('unknown');
    expect(sourceOf(p, '127.0.0.1')).toBe('unknown');
  });
});

describe('decide', () => {
  const p = policy();
  it('frontend: pinned hosts on 443 only', () => {
    expect(decide(p, 'frontend', 'slack.com', 443)).toEqual({ allow: true, mode: 'pinned' });
    expect(decide(p, 'frontend', 'WSS-PRIMARY.slack.com.', 443)).toEqual({
      allow: true,
      mode: 'pinned',
    });
    expect(decide(p, 'frontend', 'slack.com', 80)).toEqual({ allow: false, reason: 'port' });
    expect(decide(p, 'frontend', 'gitlab.com', 443)).toEqual({ allow: false, reason: 'host' });
    expect(decide(p, 'frontend', 'example.com', 443)).toEqual({ allow: false, reason: 'host' });
  });
  it('tools: the superset including GitLab, APIs and registries', () => {
    expect(decide(p, 'tools', 'gitlab.com', 443)).toEqual({ allow: true, mode: 'pinned' });
    expect(decide(p, 'tools', 'registry.npmjs.org', 443)).toEqual({ allow: true, mode: 'pinned' });
    expect(decide(p, 'tools', 'slack.com', 443)).toEqual({ allow: true, mode: 'pinned' });
    expect(decide(p, 'tools', 'example.com', 443)).toEqual({ allow: false, reason: 'host' });
  });
  it('web: any host name on 80/443, checked on the resolved addresses later', () => {
    expect(decide(p, 'web', 'example.com', 443)).toEqual({ allow: true, mode: 'public' });
    expect(decide(p, 'web', 'example.com', 80)).toEqual({ allow: true, mode: 'public' });
    expect(decide(p, 'web', 'example.com', 8080)).toEqual({ allow: false, reason: 'port' });
    expect(decide(p, 'web', '169.254.169.254', 80)).toEqual({ allow: false, reason: 'malformed' });
    expect(decide(p, 'web', 'localhost', 80)).toEqual({ allow: false, reason: 'malformed' });
  });
  it('unknown sources and malformed hosts are denied everywhere', () => {
    expect(decide(p, 'unknown', 'slack.com', 443)).toEqual({
      allow: false,
      reason: 'unknown-source',
    });
    expect(decide(p, 'frontend', 'slack.com/x', 443)).toEqual({
      allow: false,
      reason: 'malformed',
    });
    expect(decide(p, 'frontend', '', 443)).toEqual({ allow: false, reason: 'malformed' });
  });
});

describe('net helpers', () => {
  it('parses CIDRs and tests membership', () => {
    const cidr = parseCidr('10.255.0.0/24');
    expect(cidr).not.toBeNull();
    expect(cidrContains(cidr!, '10.255.0.9')).toBe(true);
    expect(cidrContains(cidr!, '10.255.1.9')).toBe(false);
    expect(parseCidr('10.255.0.0/33')).toBeNull();
    expect(parseCidr('fd00::/8')).toBeNull();
    expect(normalizeAddress('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
  it('refuses private, link-local, loopback, CGNAT, mapped and unparseable addresses', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      'nonsense',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '93.184.216.34'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
