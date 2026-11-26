# Model transport reconnect and failure logging

Status: In progress

## Summary

A deployment lost an answer run when one model request failed before any
response arrived. The cost ledger recorded `status=0`, `outcome=failed` after
about 20 ms, after six successful requests in the same run. The transport maps
every fetch exception to `transient`. The model settings use `maxRetries: 0`,
so the run ended and the requester got the generic failure notice. The agent
logged only `native.segment.failed` with `errorCount: 1`, and the transport
dropped the underlying error. The deployment's ledger shows two such failures
in thirteen requests. Both took under 40 ms, which points to a refused or
already-closed connection rather than a provider error.

Scope: `guardedModelFetch` in
[`transport.ts`](../apps/agent/src/integrations/providers/transport.ts). The
change covers failures before a response. HTTP error statuses, timeouts and
failures during streaming keep their current behavior.

## Decisions and approach

- **One reconnect, only for connection failures.** When `fetch` throws before
  a response and the system or undici code is one of `ECONNRESET`,
  `ECONNREFUSED`, `EPIPE`, `EAI_AGAIN`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED` or
  `UND_ERR_CONNECT_TIMEOUT`, the transport dispatches once more after 250 ms.
  Unknown errors, HTTP statuses, aborts and timeouts do not retry. The SDK's
  `maxRetries: 0` stays, so streamed output is never replayed.
- **A reconnect is a new dispatch.** It runs `beforeDispatch` and, for hosted
  search, `authorizeSearch` again, so revoked authority stops it. It shares the
  original request deadline. The ledger records each attempt as its own row.
- **Tradeoff:** after `ECONNRESET` or `UND_ERR_SOCKET`, the provider may have
  received the request, so the reconnect can bill one duplicate inference.
  Model requests have no side effects beyond cost and a hosted search, and the
  search is re-authorized. One duplicate is cheaper than a lost run.
- **Logging.** Each failed dispatch logs one `model-transport` warning with the
  run ID, attempt, HTTP status (0 when there was no response), error class,
  system or undici code from the cause chain, elapsed time and the reconnect
  decision. Error messages are never logged, because they can carry URLs or
  reflected text, which follows the stage-logger rules.

## Work

- [x] Reconnect once on connection failures in `guardedModelFetch`.
- [x] Log failed dispatches with fixed identifiers only.
- [x] Unit tests: reconnect with re-authorization and per-attempt accounting;
      no second reconnect; no reconnect for unknown errors or HTTP failures;
      revoked authority stops the reconnect; messages stay out of logs.

## Verification

- Deterministic: `npx vitest run test/integrations/providers/` in
  `apps/agent` passes (36 tests). The three new tests fail against the
  previous transport. `npm run typecheck:all`, `npm run lint` and
  `npm run format:check` pass. `npm run test:packages` and `npm test` fail
  only in `code-mode`, `publication/checkouts`, `publication/transfer-links`,
  `admin-backup-script` and `docker-gc-script`. Those tests fail the same way
  on unmodified `main` on the macOS development machine.
- T3 `application`: not run yet.
- Live: BLOCKED until a T5 gateway run on the test instance. Inference
  changes need T5 before release.
- Evidence: —

## Rollout

Merge, publish the runtime image and let the deployment pick up the new
digest. Rollback: revert this change.

## Open items

- [ ] Run T3 `application` on a Docker host.
- [ ] Run T5 gateway acceptance on the test instance.
- [ ] After rollout, confirm from `model-transport` warnings which codes cause
      `status=0` failures, and adjust the reconnect list if needed.
