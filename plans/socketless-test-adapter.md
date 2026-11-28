# Socketless adapter for shared test apps

Status: Human review

## Summary

A Slack app delivers each Socket Mode event to only one of its connected
adapters, so only one stack per test app may run, and Studio needs a running
adapter of its stack. Operators who run Studio replays next to the stub or
gateway suites therefore need one Slack test app per stack, or they wait.

`SLACK_SOCKET_MODE=off` starts the adapter without a Socket Mode receiver. It
still serves its HTTP routes (authority checks, reads, delivery), so Studio
works, and it receives no Slack events, so it never takes events from the
stack that owns the test app. Default `on` keeps today's behaviour.

## Decisions and approach

- One env setting, `SLACK_SOCKET_MODE`, `on` (default) or `off`. Anything
  else refuses startup.
- Fail closed: with `off`, `SLACK_APP_TOKEN` must be empty, so the switch can
  never be combined with a token by mistake. With `on`, the token stays
  required. Both the adapter and the deployment contract
  (`deploy/lib/native-deployment.mjs`) check this; Compose no longer requires
  the token itself.
- With `off` the adapter's `/readyz` no longer waits for a Socket Mode
  connection.
- The live harness refuses an instance with `off` (`slack_socket_mode_off`):
  stub and gateway scenarios need the Slack round trip.
- Production does not set it. It is for test instances that share a test app.

## Work

- [x] Adapter switch, readiness and startup log line
- [x] Compose and deployment contract
- [x] Live-harness refusal
- [x] Tests: adapter switch, contract, harness
- [x] `.env.example`, `docs/live-test-setup.md`

## Verification

- Deterministic (2026-11-28, `af5e86d`, Linux runner): lint, `typecheck:all`,
  `test:packages` (new `native-socket-mode.test.ts`), `npm test` (136, incl.
  the contract and harness cases) pass. T3 `application`: 82 records pass; a
  first run failed once in `input-bom-text/plain-explicit-refusal-before-persistence`
  (input decoding, unrelated), and passed on the rerun and on the base `cfa5868`.
- Operator check (2026-11-28, local Windows host): a socketless instance
  (`support-agent-r1`, images `af5e86d`) logged `Socket Mode off: this adapter
receives no Slack events`; Studio on it answered a replay case with 13 tool
  calls. Meanwhile the test app's own instance kept its Socket Mode connection
  and passed the gateway scenarios `answer-continuity` (4 turns, 00:34 UTC) and
  `gitlab-discovery` (00:37 UTC) through Slack. The same env file against a
  source without the switch fails with `SLACK_APP_TOKEN is required`.
- Live: not applicable; the stub and gateway suites refuse the switch.

## Rollout

Merge only; nothing to deploy, production keeps the default.

## Open items

- [x] Record the operator check.
