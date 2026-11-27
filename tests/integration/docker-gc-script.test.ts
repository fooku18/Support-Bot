/**
 * Deterministic tests of deploy/docker/docker-gc.sh, its systemd units and the image
 * label it relies on: a fake `docker` on PATH logs every call, so no
 * image or cache is touched. Running the script against the host's images is
 * the live evidence (docs/production-recovery.md, "Docker disk cleanup").
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'deploy/docker', 'docker-gc.sh');

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Fake docker: `image ls` prints FAKE_DANGLING dangling images before a prune
// and FAKE_LEFT after it, or the :ctest references in FAKE_CTEST (plus
// FAKE_OTHER_REFS, which the script must ignore); `ps` reports a container
// for the reference in FAKE_CTEST_IN_USE; `image rm` fails for FAKE_RM_FAIL.
// The prunes print Docker's totals (FAKE_EMPTY=1: nothing reclaimed) or fail
// with FAKE_PRUNE_FAIL=1.
const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  'image ls')
    if [[ "$*" == *reference=* ]]; then
      for ref in \${FAKE_CTEST:-} \${FAKE_OTHER_REFS:-}; do echo "$ref"; done
      exit 0
    fi
    if [ -f "$FAKE_STATE/pruned" ]; then n=\${FAKE_LEFT:-0}; else n=\${FAKE_DANGLING:-0}; fi
    for i in $(seq 1 "$n"); do echo "sha256:$i 2 days ago 1.2GB"; done
    exit 0 ;;
  'ps -aq')
    [ "$4" = "ancestor=\${FAKE_CTEST_IN_USE:-none}" ] && echo c0ffee
    exit 0 ;;
  'image rm')
    [ "$3" = "\${FAKE_RM_FAIL:-none}" ] && exit 1
    exit 0 ;;
  'image prune')
    touch "$FAKE_STATE/pruned"
    [ "\${FAKE_PRUNE_FAIL:-0}" = 1 ] && exit 1
    if [ "\${FAKE_EMPTY:-0}" = 1 ]; then echo 'Total reclaimed space: 0B'; exit 0; fi
    printf 'Deleted Images:\\ndeleted: sha256:1\\n\\nTotal reclaimed space: 1.5GB\\n'
    exit 0 ;;
  'builder prune')
    if [ "\${FAKE_EMPTY:-0}" = 1 ]; then printf 'Total:\\t0B\\n'; exit 0; fi
    if [ "$5" = until=168h ]; then size=12.3MB; else size=2GB; fi
    printf 'ID\\tRECLAIMABLE\\tSIZE\\tLAST ACCESSED\\nabc\\ttrue\\t%s\\t8 days ago\\nTotal:\\t%s\\n' $size $size
    exit 0 ;;
esac
exit 2
`;

const LIST =
  'image ls --no-trunc --filter dangling=true --filter label=org.support-agent.image=1 --format {{.ID}} {{.CreatedSince}} {{.Size}}';
const CTEST_LIST =
  'image ls --filter reference=support-agent/*:ctest --filter label=org.support-agent.image=1 --format {{.Repository}}:{{.Tag}}';
const IMAGE_PRUNE = 'image prune -f --filter label=org.support-agent.image=1';
const AGE_PRUNE = 'builder prune -f --filter until=168h';
const CAP_PRUNE = 'builder prune -f --max-used-space 10GB';
const RUNNER = 'support-agent/runner:ctest';
const AGENT = 'support-agent/native-coding:ctest';

function run(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'support-agent-docker-gc-'));
  scratch.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const log = path.join(root, 'docker.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: [bin, process.env.PATH].join(path.delimiter),
      FAKE_LOG: log,
      FAKE_STATE: root,
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// Nothing broader than dangling Support Agent images and old cache, ever.
function expectNarrow(calls: string[]) {
  for (const call of calls) {
    const words = call.split(' ');
    expect(words).not.toContain('-a');
    expect(words).not.toContain('--all');
    expect(words).not.toContain('--volumes');
    expect(call).not.toMatch(/\bsystem\b|\bvolume\b|\bcontainer\b|\bnetwork\b/);
    if (call.startsWith('image rm ')) {
      expect(words).not.toContain('-f');
      expect(words).not.toContain('--force');
      expect(words).toHaveLength(3);
      expect(words[2]).toMatch(/^support-agent\/[a-z-]+:ctest$/);
    }
  }
}

describe('deploy/docker/docker-gc.sh', () => {
  it('prunes dangling Support Agent images, unused :ctest images and old or excess build cache', () => {
    const result = run([], { FAKE_DANGLING: '3', FAKE_CTEST: `${RUNNER} ${AGENT}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      LIST,
      CTEST_LIST,
      `ps -aq --filter ancestor=${RUNNER}`,
      `ps -aq --filter ancestor=${AGENT}`,
      IMAGE_PRUNE,
      `image rm ${RUNNER}`,
      `image rm ${AGENT}`,
      AGE_PRUNE,
      CAP_PRUNE,
      LIST,
    ]);
    expectNarrow(result.calls);
    expect(result.stdout).toBe(
      'docker-gc: images_removed=3 ctest_removed=2 ctest_kept=0 image_bytes=1500000000 cache_bytes=2012300000\n',
    );
  });

  it('reports zero when nothing is reclaimable', () => {
    const result = run([], { FAKE_EMPTY: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([LIST, CTEST_LIST, IMAGE_PRUNE, AGE_PRUNE, CAP_PRUNE, LIST]);
    expect(result.stdout).toBe(
      'docker-gc: images_removed=0 ctest_removed=0 ctest_kept=0 image_bytes=0 cache_bytes=0\n',
    );
  });

  it('keeps :ctest images a container uses or Docker refuses to remove, and ignores other tags', () => {
    const result = run([], {
      FAKE_CTEST: `${RUNNER} ${AGENT} support-agent/admin:ctest`,
      FAKE_OTHER_REFS: 'support-agent/runner:local support-agent/runner:test',
      FAKE_CTEST_IN_USE: RUNNER,
      FAKE_RM_FAIL: AGENT,
    });
    expect(result.status, result.stderr).toBe(0);
    const removals = result.calls.filter((call) => call.startsWith('image rm '));
    expect(removals).toEqual([`image rm ${AGENT}`, 'image rm support-agent/admin:ctest']);
    expect(result.calls.join('\n')).not.toMatch(/:local|:test\b/);
    expectNarrow(result.calls);
    expect(result.stdout).toContain('ctest_removed=1 ctest_kept=1 ');
  });

  it('--dry-run lists the dangling Support Agent images and unused :ctest images and removes nothing', () => {
    const result = run(['--dry-run'], { FAKE_DANGLING: '2', FAKE_CTEST: RUNNER });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([LIST, CTEST_LIST, `ps -aq --filter ancestor=${RUNNER}`]);
    expect(result.stdout).toBe(
      [
        'docker-gc: dangling sha256:1 2 days ago 1.2GB',
        'docker-gc: dangling sha256:2 2 days ago 1.2GB',
        `docker-gc: ctest ${RUNNER}`,
        'docker-gc: dry-run images_dangling=2 ctest_unused=1',
        '',
      ].join('\n'),
    );
  });

  it.each([['--all'], ['-a'], ['--volumes'], ['--filter', 'until=1h'], ['system']])(
    'refuses any other argument (%j) before calling Docker',
    (...args) => {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('docker-gc: unknown argument');
      expect(result.calls).toEqual([]);
    },
  );

  it('fails visibly without a summary when a prune fails', () => {
    const result = run([], { FAKE_DANGLING: '1', FAKE_PRUNE_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docker-gc: docker image prune failed');
    expect(result.stdout).toBe('');
    expect(result.calls).toEqual([LIST, CTEST_LIST, IMAGE_PRUNE]);
  });
});

describe('Support Agent image label', () => {
  const dockerfile = readFileSync(path.join(REPO_ROOT, 'deploy/Dockerfile'), 'utf8');
  const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)$/gim)].map((m) => ({
    parent: m[1]!,
    name: m[2]!,
  }));

  it('is set in the base stage', () => {
    const start = dockerfile.search(/^FROM\s+\S+\s+AS\s+base$/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = dockerfile.slice(start + 1);
    const end = rest.search(/^FROM\s/m);
    const base = end === -1 ? rest : rest.slice(0, end);
    expect(base).toMatch(/^LABEL org\.support-agent\.image=1$/m);
  });

  it('reaches every stage: each one derives from base', () => {
    expect(stages[0]?.name).toBe('base');
    const derived = new Set(['base']);
    for (const stage of stages.slice(1)) {
      expect(derived.has(stage.parent), `${stage.name} FROM ${stage.parent}`).toBe(true);
      derived.add(stage.name);
    }
    expect(dockerfile.match(/^FROM\s/gim)).toHaveLength(stages.length);
  });
});

describe('docker cleanup callers', () => {
  const read = (...parts: string[]) => readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');

  it('runs the script daily without arguments through the timer', () => {
    const service = read('deploy', 'docker', 'support-agent-docker-gc.service');
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(
      /^ExecStart=\/bin\/bash \$\{SUPPORT_AGENT_REPO\}\/deploy\/docker\/docker-gc\.sh$/m,
    );
    const timer = read('deploy', 'docker', 'support-agent-docker-gc.timer');
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 04:00$/m);
    expect(timer).toMatch(/^RandomizedDelaySec=15min$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });
});
