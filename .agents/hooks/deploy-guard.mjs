#!/usr/bin/env node
// PreToolUse hook (Bash): refuse a production command that stops or
// recreates an execution owner or its transport/storage while work may be active. Recreating the
// runner inside a model call strands the thread in `needs_recovery`.
//
// Guarded (production only, never the live-test instance):
//   docker compose … up|restart|stop|down|rm|kill   naming no service or `runner`
//   docker [container] restart|stop|kill|rm …        naming a `…runner…` container
// Allowed when the command carries SUPPORT_AGENT_DEPLOY_DRAINED=1 (operator override)
// or a drain marker of the target project is younger than 10 minutes and
// recorded no active run (or an explicit --allow-active override). The marker
// is written by `node scripts/deploy-preflight.mjs --env-file <env>` next to
// the env file: artifacts/deploy-drain/<COMPOSE_PROJECT_NAME>.json.
// `--dry-run` commands change nothing and are not guarded.
//
// Exit 2 blocks the tool call and shows stderr to the agent. Any error of
// the hook itself exits 0: it never blocks on its own failure.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestStack, shellWords, simpleCommands } from './shell-commands.mjs';

const MARKER_MAX_AGE_MS = 10 * 60_000;
const STATEFUL = ['runner', 'native-answer', 'native-postgres', 'adapter'];
const GUARDED = new Set(['up', 'restart', 'stop', 'down', 'rm', 'kill']);
const COMPOSE_GLOBAL_VALUES = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--env-file',
  '--profile',
  '--project-directory',
  '--ansi',
  '--progress',
  '--parallel',
]);
const COMPOSE_SUB_VALUES = new Set([
  '-t',
  '--timeout',
  '--scale',
  '--pull',
  '--exit-code-from',
  '--attach',
  '--no-attach',
  '--wait-timeout',
  '-s',
  '--signal',
  '--rmi',
]);
const DOCKER_VALUES = new Set(['-t', '--time', '--timeout', '-s', '--signal']);

function option(word) {
  const eq = word.indexOf('=');
  return word.startsWith('--') && eq !== -1
    ? { name: word.slice(0, eq), inline: word.slice(eq + 1) }
    : { name: word, inline: undefined };
}

/** A guarded `docker compose` command, or null. */
function composeTarget(words, cwd) {
  let i = words[0] === 'docker-compose' ? 1 : 2;
  const envFiles = [];
  let project;
  let projectDirectory;
  for (; i < words.length && words[i].startsWith('-'); i += 1) {
    const { name, inline } = option(words[i]);
    if (!COMPOSE_GLOBAL_VALUES.has(name)) continue;
    const value = inline ?? words[(i += 1)];
    if (name === '--env-file') envFiles.push(value);
    else if (name === '-p' || name === '--project-name') project = value;
    else if (name === '--project-directory') projectDirectory = value;
  }
  const subcommand = words[i];
  if (!GUARDED.has(subcommand) || words.includes('--dry-run')) return null;
  const services = [];
  let scalesRunner = false;
  for (let j = i + 1; j < words.length; j += 1) {
    const { name, inline } = option(words[j]);
    if (COMPOSE_SUB_VALUES.has(name)) {
      const value = inline ?? words[(j += 1)] ?? '';
      if (name === '--scale' && STATEFUL.some((service) => value.startsWith(service + '=')))
        scalesRunner = true;
    } else if (!name.startsWith('-')) {
      services.push(name);
    }
  }
  if (
    services.length > 0 &&
    !services.some((service) => STATEFUL.includes(service)) &&
    !scalesRunner
  )
    return null;
  const base = projectDirectory === undefined ? cwd : path.resolve(cwd, projectDirectory);
  const envFile = path.resolve(base, envFiles.at(-1) ?? '.env');
  const envProject = readEnv(envFile).COMPOSE_PROJECT_NAME;
  return {
    what: `docker compose ${subcommand}${services.length === 0 ? ' (all services)' : ` ${services.join(' ')}`}`,
    envFile,
    project: project ?? envProject ?? path.basename(base).toLowerCase(),
    native:
      services.length === 0 ||
      services.some((service) => ['native-answer', 'native-postgres', 'adapter'].includes(service)),
  };
}

/** A guarded plain `docker restart|stop|kill|rm` of a runner container, or null. */
function dockerTarget(words) {
  const start = words[1] === 'container' ? 2 : 1;
  if (!GUARDED.has(words[start]) || words[start] === 'up' || words[start] === 'down') return null;
  const containers = [];
  for (let j = start + 1; j < words.length; j += 1) {
    const { name, inline } = option(words[j]);
    if (DOCKER_VALUES.has(name)) {
      if (inline === undefined) j += 1;
    } else if (!name.startsWith('-')) {
      containers.push(name);
    }
  }
  const runner = containers.find((name) =>
    /(?:runner|native-answer|native-postgres|adapter)/.test(name),
  );
  if (runner === undefined) return null;
  const project = /^(.+?)[-_](?:runner|native-answer|native-postgres|adapter)(?:[-_]\d+)?$/.exec(
    runner,
  )?.[1];
  return {
    what: `docker ${words[start]} ${runner}`,
    envFile: undefined,
    project,
    native: !/runner/.test(runner),
  };
}

/** Plain KEY=VALUE parsing (comments and matching quotes), like the services. */
function readEnv(file) {
  const values = {};
  if (file === undefined || !existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (trimmed.startsWith('#') || eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    values[trimmed.slice(0, eq).trim()] = value;
  }
  return values;
}

/** The newest drain marker of the project among the candidate directories. */
function freshMarker(project, dirs, nowMs, native) {
  let best = null;
  for (const dir of dirs) {
    const file = path.join(dir, 'artifacts', 'deploy-drain', `${project}.json`);
    if (!existsSync(file)) continue;
    let marker;
    try {
      marker = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const at = Date.parse(marker?.at ?? '');
    if (!Number.isFinite(at)) continue;
    if (best === null || at > best.at) best = { file, at, marker };
  }
  if (best === null) return { ok: false, reason: 'no drain marker exists' };
  const ageMs = nowMs - best.at;
  if (ageMs > MARKER_MAX_AGE_MS || ageMs < -60_000) {
    return {
      ok: false,
      reason: `the drain marker is ${Math.round(ageMs / 60_000)} min old (at most 10 min)`,
    };
  }
  if (native && best.marker.runtime !== 'native-answer')
    return { ok: false, reason: 'native drain marker required' };
  if (best.marker.activeRuns === 0 || best.marker.override === true) return { ok: true };
  return { ok: false, reason: `the drain marker records ${best.marker.activeRuns} active run(s)` };
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.tool_name !== 'Bash') return 0;
  const cmd = String(input.tool_input?.command ?? '');
  if (cmd.length === 0) return 0;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  let cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const drained = /(?:^|[\s;&|(])SUPPORT_AGENT_DEPLOY_DRAINED=1(?:\s|$)/.test(cmd);

  for (const command of simpleCommands(cmd)) {
    const words = shellWords(command);
    if (words[0] === 'cd' && words[1] !== undefined) {
      cwd = path.resolve(cwd, words[1].replace(/^~(?=\/|$)/, os.homedir()));
      continue;
    }
    if (isTestStack(command)) continue;
    let target = null;
    if (words[0] === 'docker-compose' || (words[0] === 'docker' && words[1] === 'compose')) {
      target = composeTarget(words, cwd);
    } else if (words[0] === 'docker') {
      target = dockerTarget(words);
    }
    if (target === null) continue;
    const homeDir = target.envFile === undefined ? cwd : path.dirname(target.envFile);
    const testEnv = readEnv(path.join(homeDir, '.env.testing'));
    if (target.project !== undefined && target.project === testEnv.COMPOSE_PROJECT_NAME) continue;

    if (drained) {
      process.stdout.write(
        JSON.stringify({
          systemMessage: `deploy guard: ${target.what} runs with SUPPORT_AGENT_DEPLOY_DRAINED=1 (operator override); active execution or delivery may become uncertain.`,
        }),
      );
      return 0;
    }
    const dirs = [...new Set([homeDir, cwd, projectDir].filter((dir) => dir !== undefined))];
    const verdict =
      target.project === undefined
        ? { ok: false, reason: 'the Compose project of the container is unknown' }
        : freshMarker(target.project, dirs, Date.now(), target.native);
    if (verdict.ok) continue;
    const envArg =
      target.envFile === undefined ? '.env' : path.relative(cwd, target.envFile) || '.env';
    process.stderr.write(
      `deploy guard: \`${target.what}\` would stop or recreate the production execution service` +
        `${target.project === undefined ? '' : ` of project ${target.project}`}, and ${verdict.reason}. ` +
        'Interrupting execution or delivery can leave an uncertain outcome. ' +
        `Run \`node scripts/deploy-preflight.mjs --env-file ${envArg} --wait-idle\` first: it waits until no run is active ` +
        'and writes the drain marker; then repeat the command within 10 minutes. ' +
        'Only if the operator explicitly accepts interrupting active runs: prefix the command with SUPPORT_AGENT_DEPLOY_DRAINED=1.\n',
    );
    return 2;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch {
  process.exitCode = 0;
}
