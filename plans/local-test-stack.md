# Local test stack on Windows and through a model gateway

Status: Human review (upstream review and merge by fooku18)

## Summary

Three defects kept the Compose test stack from running on a Windows host
with Docker Desktop, or from reaching models through an
Anthropic-compatible gateway:

- `composeHostEnvironment` passed Docker only `PATH`, `HOME` and the
  `DOCKER_*` variables. On Windows the Docker CLI finds its compose plugin
  under `%ProgramFiles%`, so every compose call failed, which surfaced only
  as "Docker operation failed".
- The live harness requires `.env.e2e` to have POSIX mode `0600`. Node
  reports `0666` for every file on Windows whatever its ACL, so every
  scenario was refused with `harness_env_must_be_private`.
- `deploy/compose.yaml` forwarded `MODEL_CATALOG` but not
  `NATIVE_ANTHROPIC_BASE_URL`. A gateway-mode instance therefore always
  called `api.anthropic.com`, and the egress proxy admitted only that host.

Application code and images are unchanged.

## Decisions and approach

- **Only `ProgramFiles`.** With `PATH` plus `ProgramFiles`,
  `docker compose version`, `ps`, `test:stack:down` and `test:stack:up`
  all work, with or without `HOME`. `USERPROFILE` and `SystemRoot` were not needed.
- **Skip the mode check on Windows instead of reading ACLs.** The POSIX
  check cannot pass there. `docs/live-test-setup.md` tells Windows
  operators to restrict the env files with an ACL. The integration test
  keeps the check on other platforms.
- **Only the Anthropic base URL.** It is what a deployment behind an AI
  gateway uses. It is empty by default, which the agent and the egress
  policy treat as unset. The other gateway settings in
  `MODEL_SETTING_NAMES` (`NATIVE_ANTHROPIC_AUTH_MODE`,
  `NATIVE_OPENAI_BASE_URL`, `NATIVE_VERTEX_BASE_URL`,
  `NATIVE_VERTEX_AUTH_MODE`) are still not forwarded. Forwarding every
  non-secret model setting would fix that class at once; it was left out
  because nothing uses them yet.

## Work

- [x] Pass `ProgramFiles` to Docker.
- [x] Skip the `.env.e2e` mode check on win32 and document the ACL.
- [x] Forward `NATIVE_ANTHROPIC_BASE_URL` to `native-answer` and `egress`.

## Verification

All on revision `56865ee` unless noted.

- Reproduction (Windows 11, Docker Desktop, compose v5.7.1):
  `docker compose version` with the previous environment fails with
  `unknown command: docker compose` and passes with `ProgramFiles`. Before the
  harness fix, every scenario stopped at `harness_env_must_be_private`.
  Before the base URL fix, `answer-continuity` failed on its first turn
  with `native_request_not_successful`: the gateway key got `401` from
  `api.anthropic.com`.
- Deterministic (Linux, `node:26.13.1-bookworm`, from `git archive`):
  T0 `typecheck:all`, `lint`, `format:check`, T1 `test:packages` and T2
  `npm test` pass. The new assertion in
  `tests/integration/native-deployment.test.ts` fails with the previous
  `deploy/compose.yaml` and passes with this one.
- Stub suite (T4) on `e7ff2e3` (same code, before the docs and test edits),
  from gateway mode with `--switch-mode`: passed 8 of 8, mode restored to
  gateway.
- Live (operator's test instance on Windows, gateway mode through the
  Kaufland AI gateway, `claude-5.5-sonnet`): `answer-continuity` passed,
  4 turns and 4 model requests, all `200`. `gitlab-discovery` passed
  against the gitlab.com fixture project on an earlier revision of this
  branch that forwarded the same base URL: 2 turns, 9 model requests
  (budget 16), all `200`.
- Evidence: reports retained on the operator's test instance under
  `artifacts/native-live/` (`e10e6bfc…` answer-continuity, `suite-c6a2440c…`
  stub suite, `d4445f98…` gitlab-discovery).

## Rollout

Merge. Only the local test stack and the harness use these files; no
deployment is needed.

## Open items

- [ ] `tests/integration/native-deployment.test.ts` cannot run on Windows:
      its fake `docker` is a `#!/usr/bin/env node` script on a
      `:`-joined `PATH`. Out of scope here.
