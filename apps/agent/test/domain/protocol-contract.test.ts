import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(AGENT_PACKAGE_DIR, '../..');

const MIRRORS = ['apps/slack/src/generated/protocol.ts'];

const CONTRACT_CONSUMERS = ['apps/slack/src/intake.ts', 'apps/slack/src/slackclient.ts'];

function canonicalDtoNames(): string[] {
  const dto = readFileSync(path.join(AGENT_PACKAGE_DIR, 'src/contracts/dto.ts'), 'utf8');
  const names: string[] = [];
  for (const match of dto.matchAll(/^export (?:interface|type) (\w+)/gm)) {
    names.push(match[1] as string);
  }
  return names;
}

describe('shared protocol contract', () => {
  it('pins a single protocol version across canonical source and record', () => {
    const protocol = readFileSync(
      path.join(AGENT_PACKAGE_DIR, 'src/contracts/protocol.ts'),
      'utf8',
    );
    const versionMatch = /export const PROTOCOL_VERSION = (\d+);/.exec(protocol);
    expect(versionMatch, 'PROTOCOL_VERSION in apps/agent/src/contracts/protocol.ts').not.toBeNull();
    const record = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'apps/agent/src/contracts/version.json'), 'utf8'),
    ) as { protocolVersion: number };
    expect(record.protocolVersion).toBe(Number(versionMatch?.[1]));
  });

  it('regenerates byte-identical mirrors (no drift, no hand edits)', () => {
    const output = execFileSync('node', ['scripts/generate-protocol-clients.mjs', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(output).toMatch(/up to date/);
    for (const mirror of MIRRORS) {
      const content = readFileSync(path.join(REPO_ROOT, mirror), 'utf8');
      expect(content).toMatch(/GENERATED from the shared application contract/);
      expect(content).toMatch(/Regenerate with:\n \*+\n \* +npm run generate:protocol/);
    }
  });

  it('exports every canonical DTO name from every mirror', () => {
    for (const name of canonicalDtoNames()) {
      for (const mirror of MIRRORS) {
        const content = readFileSync(path.join(REPO_ROOT, mirror), 'utf8');
        expect(
          content.includes(`interface ${name}`) || content.includes(`type ${name}`),
          `${mirror} exports ${name}`,
        ).toBe(true);
      }
    }
  });

  it('uses generated DTOs in the Slack adapter', () => {
    for (const name of canonicalDtoNames()) {
      for (const client of CONTRACT_CONSUMERS) {
        const content = readFileSync(path.join(REPO_ROOT, client), 'utf8');
        const declaration = new RegExp(`^export\\s+(?:interface|type)\\s+${name}\\b`, 'm');
        expect(declaration.test(content), `${client} must not redeclare ${name}`).toBe(false);
      }
    }
    for (const client of CONTRACT_CONSUMERS) {
      const content = readFileSync(path.join(REPO_ROOT, client), 'utf8');
      expect(content).toMatch(/generated\/protocol\.js/);
    }
  });

  it('vendors the canonical Slack message flattener into the receiver', () => {
    const canonical = readFileSync(
      path.join(REPO_ROOT, 'apps/agent/src/contracts/slack-message-content.ts'),
      'utf8',
    );
    const copies = ['apps/slack/src/generated/slack-message-content.ts'].map((mirror) =>
      readFileSync(path.join(REPO_ROOT, mirror), 'utf8'),
    );
    for (const copy of copies) {
      expect(copy).toMatch(
        /GENERATED verbatim from apps\/agent\/src\/contracts\/slack-message-content\.ts/,
      );
      expect(copy.endsWith(canonical)).toBe(true);
    }
    // No hand copy next to the generated one.
    expect(existsSync(path.join(REPO_ROOT, 'apps/slack/src/message-content.ts'))).toBe(false);
  });
});
