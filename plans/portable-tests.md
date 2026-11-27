# Portable tests

Status: Done

## Summary

On a Windows host, 31 root tests (T2) and 55 agent package tests (T1) failed
on unmodified `main`, and the image suites of T3 could not start. Worse, the
`native-deployment` and `native-live` fixtures joined `PATH` with `:`, missed
their fake `docker` and drove the real Docker daemon: each `npm test` run left
four to six `native-mode-*` networks behind until Docker ran out of address
pools.

Goal: host tooling tests pass on any OS, every other test passes on its
supported host, and a missed fake fails instead of reaching the real Docker
daemon. No platform branches. Windows stays unsupported for the Linux-only
tests (agent Workspace, `admin-backup.sh`); there they run in a Linux
container.

## Decisions and approach

- The fake `docker` no longer depends on `PATH` or a shebang.
  [`tests/integration/fake-docker.ts`](../tests/integration/fake-docker.ts)
  routes `spawnSync('docker', …)` to `node <fake>` in the test process, and
  through `--import` in every Node child that inherits `FAKE_DOCKER`. T2 sets
  `DOCKER_HOST` to a closed port, so a call that misses the fake fails.
- Repository paths come from `fileURLToPath` and child `PATH`s are joined
  with `path.delimiter`. Module specifiers are file URLs. Volume specs are
  parsed at the last `:/` so a drive letter cannot split them.
- Hook tests run the configured command with `sh` from `PATH`, as the
  agents do.
- `scripts/studio.mjs` uses group 0 where the host has no POSIX group.
- The agent's Workspace and publication code runs only in the Linux image. It
  needs POSIX symlinks and directory `fsync`; `deploy/docker/admin-backup.sh`
  is a Linux VM script. Their tests stay as they are. T1 and T2 need a Linux
  host ([testing](../docs/testing.md#t0-to-t2)), and on Windows
  they run in a Linux container.
- The T3 driver reads `NATIVE_TEST_DOCKER_LOOPBACK` (default `127.0.0.1`), the
  address at which it reaches ports the daemon publishes on loopback. That
  lets the driver run in a container on the host's Docker socket.

## Work

- [x] Fake `docker` routing for `native-deployment` and `native-live`
- [x] Path, `PATH`, module URL and volume-spec fixes
- [x] Studio group fallback
- [x] `NATIVE_TEST_DOCKER_LOOPBACK` and the platform notes in `docs/testing.md`

## Verification

- Deterministic, Windows 11 with Node 26.13.1, revision `a6a1199`:
  - T0 clean.
  - T2 natively: 130 of 135 pass; the five failures are `admin-backup.sh`
    refusing Windows paths, as designed. No `native-mode-*` network was
    created.
  - T1 and T2 in `node:26.13.1-bookworm` on Docker Desktop: all pass
    (1,049 and 135 tests).
  - T3 in the same container on the host socket with images from earlier
    branches (`native-coding:review`, `cli-runtime`/`egress:g5-change`) and
    `NATIVE_TEST_DOCKER_LOOPBACK=host.docker.internal`: `discovery`,
    `telemetry`, `coding`, `backup` and `tools` pass; `application` stops at
    `input-context-tripwire-is-explicit-failure-without-delivery`, as on
    `main` ([context budget](context-budget.md)).
- Live: not needed; only tests, the Studio launcher and the T3 driver change.

## Rollout

Merge. No deployment.
