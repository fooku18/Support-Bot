/** Exercise configured hooks with synthetic input; never execute the input commands. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'support-agent hooks '));
afterAll(() => {
  if (process.env.SUPPORT_AGENT_TEST_RETAIN_EVIDENCE !== '1')
    rmSync(scratch, { recursive: true, force: true });
});

type HookConfig = {
  disableAllHooks?: boolean;
  allowManagedHooksOnly?: boolean;
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string; timeout: number }>;
    }>;
  };
};
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const fixtures = readJson('tests/fixtures/hook-commands.json').commands as Array<{
  command: string;
  guard: 'block' | 'allow';
}>;

it('exposes every shared skill to Claude through a relative directory link', () => {
  const shared = path.join(root, '.agents/skills');
  const claude = path.join(root, '.claude/skills');
  const names = readdirSync(shared).sort();
  expect(readdirSync(claude).sort()).toEqual(names);
  for (const name of names) {
    const source = path.join(shared, name);
    const link = path.join(claude, name);
    expect(lstatSync(source).isDirectory()).toBe(true);
    expect(readlinkSync(link)).toBe(path.relative(claude, source));
    expect(realpathSync(path.join(link, 'SKILL.md'))).toBe(path.join(source, 'SKILL.md'));
  }
});

it('keeps AGENTS.md as the single project instruction entrypoint', () => {
  expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain(
    '.agents/skills/plan/SKILL.md',
  );
  // Claude Code supports AGENTS.md fallback. A competing file would shadow it.
  for (const file of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) {
    expect(existsSync(path.join(root, file)), `${file} would shadow AGENTS.md`).toBe(false);
  }
});

it('enables Codex hooks without a project MCP configuration', () => {
  expect(readFileSync(path.join(root, '.codex/config.toml'), 'utf8').trim()).toBe(
    '[features]\nhooks = true',
  );
  expect(readdirSync(root)).not.toContain('.mcp.json');
  expect(readJson('.claude/settings.json')).not.toHaveProperty('enabledMcpjsonServers');
});

it('registers the same synchronous deployment guard in both clients', () => {
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = readJson(file) as HookConfig;
    expect(config.disableAllHooks).not.toBe(true);
    expect(config.allowManagedHooksOnly).not.toBe(true);
    expect(Object.keys(config.hooks)).toEqual(['PreToolUse']);
    const groups = config.hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(new RegExp(groups[0]!.matcher).test('Bash')).toBe(true);
    expect(groups[0]!.hooks).toHaveLength(1);
    expect(groups[0]!.hooks[0]).toMatchObject({ type: 'command', timeout: 10 });
    expect(groups[0]!.hooks[0]).not.toHaveProperty('async', true);
    expect(groups[0]!.hooks[0]!.command).toContain('/.agents/hooks/deploy-guard.mjs');
  }
  expect(existsSync(path.join(root, '.agents/hooks/deploy-guard.mjs'))).toBe(true);
});

describe.each([
  ['Claude', '.claude/settings.json'],
  ['Codex', '.codex/hooks.json'],
])('%s configured hooks', (provider, configPath) => {
  const config = readJson(configPath!) as HookConfig;
  const repo = path.join(scratch, provider!);
  const nested = path.join(repo, 'nested');
  mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  mkdirSync(path.join(repo, '.agents'));
  symlinkSync(path.join(root, '.agents/hooks'), path.join(repo, '.agents/hooks'), 'dir');
  writeFileSync(path.join(repo, '.env'), 'COMPOSE_PROJECT_NAME=support-agent\n');
  writeFileSync(path.join(repo, '.env.testing'), 'COMPOSE_PROJECT_NAME=support-agent-test\n');

  function guardCommand(command: string) {
    const commands = config.hooks.PreToolUse.filter(({ matcher }) =>
      new RegExp(matcher).test('Bash'),
    ).flatMap(({ hooks }) => hooks.map(({ command }) => command));
    expect(commands).toHaveLength(1);
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    if (provider === 'Claude') env.CLAUDE_PROJECT_DIR = repo;
    return spawnSync('sh', ['-c', commands[0]!], {
      // Both a path with spaces and a session started below the Git root.
      cwd: nested,
      env,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: command.replaceAll('{dir}', repo) },
        cwd: repo,
      }),
      timeout: 10_000,
    });
  }

  it('blocks undrained production commands and allows safe/test commands', () => {
    for (const { command, guard } of fixtures) {
      const result = guardCommand(command);
      expect(result.error).toBeUndefined();
      expect(result.status, `${command}: ${result.stderr}`).toBe(guard === 'block' ? 2 : 0);
      if (guard === 'block') expect(result.stderr).toContain('deploy guard:');
    }
  });

  it('finds a drain marker at the project root from a nested working directory', () => {
    const markerDir = path.join(repo, 'artifacts/deploy-drain');
    mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'support-agent.json');
    try {
      writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), activeRuns: 0 }));
      const result = guardCommand('cd nested && docker restart support-agent-runner-1');
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(marker);
    }
  });

  it('requires a native drain receipt for the native owner and storage', () => {
    const markerDir = path.join(repo, 'artifacts/deploy-drain');
    mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'support-agent.json');
    const old = { at: new Date().toISOString(), activeRuns: 0 };
    writeFileSync(marker, JSON.stringify(old));
    expect(guardCommand('docker restart support-agent-native-answer-1').status).toBe(2);
    writeFileSync(path.join(markerDir, 'legacy-receipt.json'), JSON.stringify(old));
    writeFileSync(marker, JSON.stringify({ ...old, runtime: 'native-answer' }));
    expect(guardCommand('docker restart support-agent-native-answer-1').status).toBe(0);
    expect(guardCommand('docker compose stop native-postgres').status).toBe(0);
  });
});
