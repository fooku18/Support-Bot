# Model transport reconnect and failure logging

Status: Human review

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

- **Up to three reconnects, only for connection failures.** When `fetch`
  throws before a response and the system or undici code is one of
  `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `EAI_AGAIN`, `UND_ERR_SOCKET`,
  `UND_ERR_CLOSED` or `UND_ERR_CONNECT_TIMEOUT`, the transport dispatches
  again after 250 ms, 1 s and 3 s. One reconnect was not enough in production
  (see Verification): the gateway resets fresh connections in short bursts.
  Unknown errors, HTTP statuses and aborts do not retry, and neither does an
  expired request deadline (`UND_ERR_CONNECT_TIMEOUT` is a connect timeout and
  does retry while the deadline lasts). The SDK's `maxRetries: 0` stays, so
  streamed output is never replayed.
- **A reconnect is a new dispatch.** It runs `beforeDispatch` and, for hosted
  search, `authorizeSearch` again, so revoked authority stops it. It shares the
  original request deadline: a deadline that passes during back-off or
  re-authorization fails the request as a timeout, with no further dispatch.
  The ledger records each attempt as its own row.
- **Tradeoff:** after `ECONNRESET` or `UND_ERR_SOCKET`, the provider may have
  received the request, so each reconnect can bill a duplicate inference: up
  to three duplicates, and up to three extra hosted searches, per request.
  Model requests have no side effects beyond cost and a hosted search, and the
  search is re-authorized. Rare duplicates are cheaper than a lost run.
- **Logging.** Each failed dispatch logs one `model-transport` warning with the
  run ID, attempt, status and elapsed time. A failure without a response logs
  `status=0` with the error class, the system or undici code from the cause
  chain and the reconnect decision; an HTTP failure logs its status and
  whether it was redirected. A dispatch ended by an abort or the deadline logs
  no warning and leaves an `interrupted` ledger row. Error messages are never logged, because they can carry URLs or
  reflected text, which follows the stage-logger rules.

## Work

- [x] Reconnect on connection failures in `guardedModelFetch`: once at
      first, up to three times with growing delays after the production
      evidence of 2026-11-27.
- [x] Log failed dispatches with fixed identifiers only.
- [x] Unit tests: reconnect with re-authorization and per-attempt accounting;
      a burst of three resets is ridden out on the 250 ms, 1 s, 3 s schedule
      and a fourth gives up; a deadline during re-authorization is a timeout;
      no reconnect for unknown errors or HTTP failures; revoked authority
      stops the reconnect; messages stay out of logs.

## Verification

- Deterministic, first version (one reconnect): the provider tests passed (36)
  and the new tests failed against the previous transport.
- Deterministic, three reconnects, rebased on `8c0229a`, Windows with Node
  26.13.1: `npx vitest run test/integrations/providers/` in `apps/agent`
  passes (38 tests). The burst test fails with a `[250, 250, 250]` schedule,
  and the deadline test fails with the previous `throwIfAborted()` checks.
  `npm run typecheck:all`, `npm run lint` and `npm run format:check` pass.
  `apps/agent` `npm test`: 61 of 68 files pass; the 7 failures are the known
  Windows ones (`inspection.test.ts` and six `domain/publication` files).
  Root `npm test`: 31 failures in 6 files, the same on unmodified `main`.
- T3 `application` (Windows, Docker Desktop): 69 checks pass, including
  model dispatches through the synthetic gateway. The suite then stops at
  `input-context-tripwire-is-explicit-failure-without-delivery`, the stale
  fixture that stops it on `main` too (its 200 KB attachment now fits the
  context budget, see [context budget](context-budget.md)).
- Live: BLOCKED until a T5 gateway run on the test instance. Inference
  changes need T5 before release.
- Production, 2026-11-27, deployment `5806cf3` (one reconnect): two runs
  (13:35 and 13:37 UTC) failed. Each attempt was reset after 18 to 34 ms
  (`code=ECONNRESET`), the first on the pod's first model request, so no
  pooled connection was involved. An unauthenticated probe from the agent pod
  at 13:41 got one reset and then 401s; the next requests at 13:43 and 13:47
  succeeded. The same prompts sent with the test key returned 200, so the
  resets do not depend on content.
- Review: Astra (GPT-6.2 Astra, OpenAI account route, effort `high`) found no
  blocker. Fixed: the burst test now checks the real back-off schedule
  instead of injecting one, and a deadline that passes during
  re-authorization is a timeout instead of a raw `TimeoutError`. The plan now
  states the duplicate bound and what the logs show.
- Evidence: T3 run `artifacts/native/application/cd296ccd` on the
  development machine (not retained in Git).

## Rollout

Merge upstream, then deploy the agent from the published image through the
deployment repository's digest bump, a separate operator-approved step. No
settings, schema or credential change. Rollback: deploy the previous digest
or revert this change.

## Open items

- [x] Run T3 `application` on a Docker host: passes up to the stale fixture
      that stops `main` too.
- [ ] Run T5 gateway acceptance on the test instance.
- [ ] Operator: approve the deployment repository's digest bump that carries
      this change.
- [x] After rollout, confirm from `model-transport` warnings which codes cause
      `status=0` failures: `ECONNRESET` on fresh connections, in bursts.
- [ ] After the next rollout, confirm that bursts end within the backoff.
