# Local test stack on Windows and through a model gateway

Status: Done

## Summary

Three defects kept the Compose test stack from running on a Windows host
with Docker Desktop, or from reaching models through an
Anthropic-compatible gateway:

- `composeHostEnvironment` passed Docker only an allowlist of POSIX
  variables (`PATH`, `HOME`, `DOCKER_*`, ...). On Windows the Docker CLI
  finds its compose plugin under `%ProgramFiles%`, so every compose call
  failed, which surfaced only as "Docker operation failed".
- The live harness requires `.env.e2e` to have POSIX mode `0600`. NTFS
  keeps no POSIX permission bits, and Node reports `0666` for every file
  whatever its ACL, so every scenario was refused with
  `harness_env_must_be_private`.
- `deploy/compose.yaml` forwarded `MODEL_CATALOG` but not
  `NATIVE_ANTHROPIC_BASE_URL`. A gateway-mode instance therefore always
  called `api.anthropic.com`, and the egress proxy admitted only that host.

Application code and images are unchanged.

## Decisions and approach

- **Inherit the host environment minus application names, not a
  per-platform allowlist.** The allowlist exists so that Compose
  interpolates application values only from the designated env file.
  `composeHostEnvironment` now enforces exactly that: it passes the host
  environment without any variable the `deploy/compose*.yaml` files
  interpolate, any service `environment` or `build.args` key (which would
  pass a host value through), and any `COMPOSE_*` setting, compared
  case-insensitively because Windows names are. Docker then finds its
  plugins, contexts and credential helpers on every platform without the
  code naming one. Every `docker run -e` passes an explicit `KEY=value`, so
  no other host value reaches a container. The Docker process can now see
  unrelated host variables; Compose uses none of them.
- **Probe the file system instead of naming the OS.** `keepsPermissionBits`
  creates a `0600` probe next to the resolved `.env.e2e` and reads its mode
  back. Where the bits survive (Linux, macOS), or the directory cannot be
  written, the `.env.e2e` check is enforced. Where they do not (NTFS, drvfs
  mounts without metadata), it is skipped and `docs/live-test-setup.md`
  tells operators to use an ACL. The integration test compares the probe
  with what `chmod` does to `.env.e2e` itself and asserts the matching
  behaviour.
- **Only the Anthropic base URL.** It is what a deployment behind an AI
  gateway uses. It is empty by default, which the agent and the egress
  policy treat as unset. `.env.example` carries it, so `env:parity`
  accepts an `.env.testing` that sets it. The other gateway settings in
  `MODEL_SETTING_NAMES` (`NATIVE_ANTHROPIC_AUTH_MODE`,
  `NATIVE_OPENAI_BASE_URL`, `NATIVE_VERTEX_BASE_URL`,
  `NATIVE_VERTEX_AUTH_MODE`) are still not forwarded. Forwarding every
  non-secret model setting would fix that class at once; it was left out
  because nothing uses them yet.

## Work

- [x] Inherit the host environment without application or Compose names.
- [x] Enforce the `.env.e2e` mode check where the file system keeps
      permission bits, and document the ACL elsewhere.
- [x] Forward `NATIVE_ANTHROPIC_BASE_URL` to `native-answer` and `egress`.

## Verification

All on the commit that adds this text unless noted. Review: an
independent model review and a YAGNI pass ran on `bf5906c`; their
findings (the `.env.example` entry, pass-through keys, the probe location,
test gaps) are fixed here.

- Reproduction (Windows 11, Docker Desktop, compose v5.7.1), on earlier
  revisions: with the old allowlist `docker compose version` failed with
  `unknown command: docker compose`. Before the harness fix, every
  scenario stopped at `harness_env_must_be_private`. Before the base URL
  fix, `answer-continuity` failed on its first turn with
  `native_request_not_successful`: the gateway key got `401` from
  `api.anthropic.com`.
- Deterministic (Linux, `node:26.13.1-bookworm`, from `git archive` of the
  working tree): T0 `typecheck:all`, `lint`, `format:check`, T1
  `test:packages` and T2 `npm test` pass. `native-deployment.test.ts`
  checks that a host-only variable reaches Docker and that `COMPOSE_*`,
  lowercase application names and pass-through keys do not. Its base URL
  assertion fails with the previous `deploy/compose.yaml`.
- Windows host: `test:stack:up` and `test:stack:ps` work with the new
  environment. `native-live.test.ts` passes its privacy case through the
  no-bits branch; three of its driver tests, and all of
  `native-deployment.test.ts`, fail on Windows exactly as on `main` (see
  open items).
- Stub suite (T4), from gateway mode with `--switch-mode --rerun`: 8 of 8
  passed, mode restored to gateway (`suite-9b1ee8b9…`).
- Live (operator's test instance on Windows, gateway mode through the
  Kaufland AI gateway, `claude-5.5-sonnet`): `answer-continuity` passed
  (`9b6a0843…`). The attempt before it passed three turns and failed the
  fourth on a gateway `521` (`be5462b2…`). `gitlab-discovery` passed on an
  earlier revision that forwarded the same base URL: 2 turns, 9 model
  requests (budget 16), all `200` (`d4445f98…`).
- Evidence: reports retained on the operator's test instance under
  `artifacts/native-live/`.

## Rollout

Merge. Only the local test stack and the harness use these files; no
deployment is needed.

## Open items

- [x] The fake `docker` of `native-deployment.test.ts` and `native-live.test.ts`
      no longer depends on `PATH` or a shebang; see
      [portable tests](portable-tests.md).
