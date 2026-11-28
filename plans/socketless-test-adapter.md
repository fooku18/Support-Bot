# Socketless adapter for shared test apps

Status: In progress

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

- Deterministic: T0, `apps/slack` tests (new `native-socket-mode.test.ts`),
  `native-deployment` and `native-live` integration tests.
- Live: not applicable to the stub or gateway suites (they refuse the switch).
  Operator check: a socketless stack next to the test app's own stack, Studio
  reaching its adapter, and the test app's stack still receiving every event.
- Evidence: below once run.

## Rollout

Merge only; nothing to deploy, production keeps the default.

## Open items

- [ ] Record the operator check.
