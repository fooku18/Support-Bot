import { describe, expect, it } from 'vitest';
import {
  CLI_RUNTIME_KINDS,
  CREDENTIAL_KINDS,
  MCP_KINDS,
  TOOL_KIND_CODES,
  WEB_RUNTIME_KINDS,
  kindNeedsProbe,
  validateToolCredential,
  validateToolInstance,
} from '../src/generated/tool-kinds.js';

describe('Cloudflare tool kind', () => {
  it('is a credential kind of the cli-runtime, authorized as an MCP kind, probed', () => {
    expect(CREDENTIAL_KINDS).toContain('cloudflare');
    expect(CLI_RUNTIME_KINDS).toContain('cloudflare');
    expect(MCP_KINDS).toContain('cloudflare');
    expect(TOOL_KIND_CODES.cloudflare).toBe('cf');
    expect(kindNeedsProbe('cloudflare')).toBe(true);
  });

  it('defaults the host to the API host and normalizes account and zones', () => {
    expect(validateToolInstance({ kind: 'cloudflare', label: 'Cloudflare' })).toEqual({
      kind: 'cloudflare',
      label: 'Cloudflare',
      host: 'api.cloudflare.com',
      settings: { accountId: null, zones: null },
    });
    expect(
      validateToolInstance({
        kind: 'cloudflare',
        label: 'Cloudflare',
        host: 'API.cloudflare.com',
        settings: {
          accountId: 'ABCDEF0123456789abcdef0123456789',
          zones: ['Shop.Example.com', ' cloud.example.com '],
        },
      }),
    ).toMatchObject({
      host: 'api.cloudflare.com',
      settings: {
        accountId: 'abcdef0123456789abcdef0123456789',
        zones: ['cloud.example.com', 'shop.example.com'],
      },
    });
    // Empty values mean "none" / "every zone".
    expect(
      validateToolInstance({
        kind: 'cloudflare',
        label: 'Cloudflare',
        settings: { accountId: '', zones: [] },
      }).settings,
    ).toEqual({ accountId: null, zones: null });
  });

  it('refuses other hosts, malformed IDs and zone names, duplicates and unknown fields', () => {
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ host: 'api.cloudflare.com.evil.example' }, /host must be api\.cloudflare\.com/],
      [{ host: 'mcp.cloudflare.com' }, /host must be api\.cloudflare\.com/],
      [{ settings: { accountId: 'abc' } }, /accountId must be a Cloudflare account ID/],
      [{ settings: { zones: 'example.com' } }, /zones must be a list/],
      [{ settings: { zones: ['example.com:443'] } }, /zone names such as example\.com/],
      [{ settings: { zones: ['localhost'] } }, /zone names/],
      [{ settings: { zones: ['a.example.com', 'A.example.com'] } }, /duplicate "a\.example\.com"/],
      [{ settings: { token: 'x' } }, /unknown field settings\.token/],
      [
        { settings: { zones: Array.from({ length: 201 }, (_, i) => `z${i}.example.com`) } },
        /at most 200 zones/,
      ],
    ];
    for (const [input, message] of refused)
      expect(() =>
        validateToolInstance({ kind: 'cloudflare', label: 'Cloudflare', ...input }),
      ).toThrow(message);
  });

  it('takes one token without assuming a prefix', () => {
    expect(validateToolCredential('cloudflare', ' abcdEFGH_1234-token ')).toBe(
      'abcdEFGH_1234-token',
    );
    expect(() => validateToolCredential('cloudflare', 'short')).toThrow(/8 to 4096/);
    expect(() => validateToolCredential('cloudflare', 'has a space in it')).toThrow(/8 to 4096/);
  });
});

describe('Slack tool kind', () => {
  it("is a cli-runtime and MCP kind without an operator credential (the workspace's bot token)", () => {
    expect(CREDENTIAL_KINDS).not.toContain('slack');
    expect(CLI_RUNTIME_KINDS).toContain('slack');
    expect(MCP_KINDS).toContain('slack');
    expect(TOOL_KIND_CODES.slack).toBe('sl');
    expect(kindNeedsProbe('slack')).toBe(true);
    expect(() => validateToolCredential('slack', 'xoxb-some-token-0001')).toThrow(
      "a slack instance uses the workspace's bot token; it takes no credential",
    );
  });

  it('fixes the host to slack.com and takes no settings', () => {
    expect(validateToolInstance({ kind: 'slack', label: 'Slack' })).toEqual({
      kind: 'slack',
      label: 'Slack',
      host: 'slack.com',
      settings: {},
    });
    expect(
      validateToolInstance({ kind: 'slack', label: 'Slack', host: 'Slack.com' }),
    ).toMatchObject({ host: 'slack.com', settings: {} });
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ host: 'files.slack.com' }, /host must be slack\.com/],
      [{ host: 'slack.com.evil.example' }, /host must be slack\.com/],
      [{ settings: { exposeEmail: true } }, /unknown field settings\.exposeEmail/],
      [{ settings: { channels: ['C1'] } }, /unknown field settings\.channels/],
    ];
    for (const [input, message] of refused)
      expect(() => validateToolInstance({ kind: 'slack', label: 'Slack', ...input })).toThrow(
        message,
      );
  });
});

describe('Web search tool kind', () => {
  it('is credential-free, settings-free and needs no runtime probe (searches run through the AI Gateway)', () => {
    expect(CREDENTIAL_KINDS).not.toContain('webSearch');
    expect(WEB_RUNTIME_KINDS).toEqual(['webFetch']);
    expect(kindNeedsProbe('webSearch')).toBe(false);
    expect(TOOL_KIND_CODES.webSearch).toBe('ws');
    expect(() => validateToolCredential('webSearch', 'provider-api-key-0001')).toThrow(
      'a webSearch instance takes no credential',
    );
    expect(validateToolInstance({ kind: 'webSearch', label: 'Web search' })).toEqual({
      kind: 'webSearch',
      label: 'Web search',
      host: null,
      settings: {},
    });
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [
        { settings: { endpoint: 'https://search.example.com/v1' } },
        /unknown field settings\.endpoint/,
      ],
      [{ host: 'search.example.com' }, /host/],
    ];
    for (const [input, message] of refused)
      expect(() =>
        validateToolInstance({ kind: 'webSearch', label: 'Web search', ...input }),
      ).toThrow(message);
  });
});

describe('Code Mode tool kind', () => {
  it('is a credential-free kind without a runtime probe, authorized as a plain tool', () => {
    expect(CREDENTIAL_KINDS).not.toContain('codeMode');
    expect(CLI_RUNTIME_KINDS).not.toContain('codeMode');
    expect(MCP_KINDS).not.toContain('codeMode');
    expect(WEB_RUNTIME_KINDS).not.toContain('codeMode');
    expect(kindNeedsProbe('codeMode')).toBe(false);
    expect(TOOL_KIND_CODES.codeMode).toBe('cm');
    expect(() => validateToolCredential('codeMode', 'anything')).toThrow(
      'a codeMode instance takes no credential',
    );
    expect(validateToolInstance({ kind: 'codeMode', label: 'Code Mode' })).toEqual({
      kind: 'codeMode',
      label: 'Code Mode',
      host: null,
      settings: {},
    });
    expect(() =>
      validateToolInstance({ kind: 'codeMode', label: 'Code Mode', host: 'example.com' }),
    ).toThrow('a codeMode instance takes no host');
    expect(() =>
      validateToolInstance({ kind: 'codeMode', label: 'Code Mode', settings: { x: 1 } }),
    ).toThrow('unknown field settings.x');
  });
});
