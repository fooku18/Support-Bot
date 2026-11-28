# Dependency update, November 2026

Status: Done

## Summary

Update Mastra and the other dependencies to their current releases:

- Mastra: `@mastra/core` 1.83.0 to 1.86.0, `@mastra/pg` 1.36.0 to 1.38.0,
  `@mastra/memory` 1.41.3, `@mastra/observability` 1.24.3,
  `@mastra/isolated-vm` 0.1.5 and the `mastra` CLI 1.40.2.
- The AI SDK providers, the MCP SDK, undici, ws, `@hono/node-server`, tsx,
  vitest 5.1, typescript-eslint 8.74 and prettier 3.10.
- Majors: ESLint 10 (with `@eslint/js` 10), globals 17, lint-staged 17,
  dotenv 18 and TypeScript 6.0.

TypeScript 7 is out of scope: typescript-eslint 8.74 supports TypeScript
below 6.1. The Slack SDK majors (`@slack/web-api` 8, `@slack/socket-mode` 3)
replace the HTTP and WebSocket transport and the proxy options. They are a
separate change.

## Decisions and approach

- **Existing stores need the new framework columns.** `@mastra/pg` 1.38 reads
  `framework.mastra_workflow_run_entries.first_seq` (before, it was a computed
  alias) and adds `stateSeq`, `statePatchCount`, `statePatchBytes` and
  `stateBytes` to `mastra_workflow_runs`. The runtime uses `disableInit` and
  has no DDL rights, and `provision` refuses an existing store. Without an
  upgrade, the startup check `checkNativeStorage` fails on
  `getWorkflowRunById`, and so does every run read.
- A new `upgrade` maintenance entrypoint (`support-agent upgrade`,
  `native-upgrade` in Compose) runs as the maintenance identity on an
  existing store sealed at `NATIVE_STORAGE_VERSION`. It calls the framework's
  own `init()`, which creates missing tables and indexes and adds missing
  columns (`ADD COLUMN IF NOT EXISTS`), and then grants the runtime DML on
  all framework tables and sequences. Application tables, roles and the seal
  stay unchanged. It is idempotent, so `test:stack:up` runs it on every start
  before the agent.
- Deployments outside Compose run `support-agent upgrade` with the new image
  before the agent starts (the Kubernetes deployment runs it in its
  PostgreSQL bootstrap Job).
- ESLint 10's recommended set adds `no-useless-assignment` and
  `preserve-caught-error`. The 11 findings are fixed in place.
- npm now hoists `mastra` and `@mastra/deployer` to the root
  `node_modules`. The Studio launcher starts the hoisted CLI.

## Work

- [x] Mastra and minor bumps; prettier 3.10 reformatting
- [x] ESLint 10, TypeScript 6.0, globals 17, lint-staged 17
- [x] dotenv 18 (the adapter's `dotenv.config` result keeps its shape)
- [x] Studio launcher path for the hoisted CLI
- [x] `upgrade` maintenance entrypoint, Compose service, stack start, docs
- [x] T3 `application`: upgrade refused without a store, upgrade of a store
      without `first_seq`, a repeat, the runtime grant and a foreign seal

## Verification

- Deterministic (2026-11-28, rebased on `main` `37d36b7`): T0 passes. T1
  and T2 pass in a Linux container. T3 passes all five suites: discovery 13,
  application 82, backup 18, telemetry 8, tools 19 records. Before the
  rebase, telemetry also passed three runs in a row.
  `tests/integration/runtime-image.sh` passes.
- Upgrade from the deployed store: a store provisioned by the published image
  `main@sha256:7e224c8…` had none of the five new framework columns. One
  deployment bootstrap with this branch's image added all five and granted
  them to the runtime. On the shared test instance, `test:stack:up` upgraded
  the retained store and the agent started healthy.
- T4 stub suite: 7 of 8. `stub-cancel-control-stops-a-held-run` fails as on
  `main` (lumi B75): the thread context repeats the cancelled
  `STUB_HOLD 60
STUB_REPLY …` prompt as JSON, and the stub's unanchored
  directive pattern reads `STUB_HOLD` from it. On `main` since #44, every
  T4 scenario failed with `unsupported_delivery_rendering` because the
  harness refused the feedback buttons' `actions` block; this branch skips
  it.
- T5 (AI Gateway, `claude-5.5-sonnet`): `answer-continuity` passed twice.
  `gitlab-discovery` passed 2 of 4 runs; the other two stopped at the second
  answer with `unsupported_delivery_rendering`, a model-formatted answer the
  harness cannot read back.
- Evidence: `instance/artifacts/native-live/` on the test device
  (`d2800355-…`, `9413912e-…`, `c3e38b85-…`, `ac4cede2-…`); not retained in
  Git.

## Rollout

Deployed to staging on 2026-11-28 01:25 UTC with the image from `1aa0251`.
The deployment's bootstrap Job ran `support-agent upgrade` in 27 s and added
the five framework columns; all workloads started without a restart, with one
Socket Mode connection.

## Open items

- [x] Deploy to staging with the bootstrap upgrade (deployment repo)
- [x] Live check in the test channel: on 2026-11-28 06:03 UTC, after the Slack
      SDK 8 deploy, a merge-request question was answered correctly in 16 s
