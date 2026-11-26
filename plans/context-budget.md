# Context budget that keeps the user's request

Status: In progress

## Summary

A follow-up in a thread got an answer that ignored the user's original request.
The model said the user's first message was empty. The thread held a long
investigation: a linked alert, tool discovery, and a Datadog log search of
about 16,000 estimated tokens. The input `TokenLimiterProcessor` ran with
`contextTokens: 24000` in `contiguous` mode. It kept the newest turns that fit
and dropped everything older. That removed the opening request and the alert
the bot had read, but kept the bot's own later tool calls. Mastra only inserts
a placeholder user turn for Google and Bedrock models, so the Anthropic request
started with an assistant turn. Stored memory was intact; only the prompt was
trimmed.

The same trim runs before every model call in a run, not only on follow-ups.
A single investigation that pulls about 20,000 tokens of tool output loses its
own question partway through.

Related: [model transport reconnect](model-transport-reconnect.md), the
transport failure that led to the follow-up.

## Decisions and approach

1. **Per-model budget.** `MODEL_CATALOG` entries take an optional
   `contextTokens`, from 8,000 to 1,000,000, with a default of 64,000.
   `contextTokens` is removed from the deployment-wide `limits`. The coordinator
   config validates and hashes the value with the rest of the model policy. The
   default is 2.7× the old budget. It stays well within a 200k window, since the
   estimate excludes tool schemas and the answer.
2. **`ContextBudgetProcessor` replaces the input `TokenLimiterProcessor`.** It
   runs at the prompt stage, so stored messages and memory keep everything.
   Over budget, it:
   - keeps the history window's opening user request, the current request and
     the latest step, which may be an active tool continuation;
   - first shrinks older tool results, oldest first, to a short receipt with
     the original size and a hint to call the tool again;
   - only then leaves out older turns, oldest first;
   - as a last resort, leaves out the opening request when it is not the
     current one;
   - refuses with a `TripWire` when the current request alone does not fit. The
     existing `processor_rejected` receipt covers this, as before.

   Tool calls and their results are kept or removed together.

3. **Explicit notes.** Each left-out range is replaced by one user-role note
   saying earlier messages were left out. A prompt whose history opens on an
   assistant turn gets a note in front, also when nothing was trimmed. This
   covers the `lastMessages: 40` memory window too.
4. **Estimate.** The processor uses characters / 3 per text and 1,600 tokens
   per image or file. That is deliberately higher than Mastra's estimator for
   JSON-heavy tool output, because under-counting is what pushed the old
   request to 37k real tokens against a 24k budget.

The output `TokenLimiterProcessor` (`strategy: 'abort'`) is unchanged.

## Work

- [x] Optional `contextTokens` in the model catalog, with regenerated mirrors.
- [x] Model selection supplies `contextTokens`; removed from `limits`.
- [x] Coordinator config validation and hash include `contextTokens`.
- [x] `ContextBudgetProcessor` with pinning, result shrinking, notes and
      assistant-first marking.
- [x] Unit tests, including the incident's shape, and a runtime test through the
      durable agent.
- [x] `docs/kubernetes-runtime.md` documents the field.

## Verification

- Deterministic: `npm run typecheck:all`, `npm run lint` and
  `npm run format:check` pass. `test/runtime/context-budget.test.ts` (6 tests)
  and `test/runtime/answer.test.ts` (10 tests) pass. The new runtime test fails
  with the previous `TokenLimiterProcessor`, which drops the opening request.
  `npm run test:packages` and `npm test` fail only in `code-mode`,
  `publication/checkouts`, `publication/transfer-links`, `admin-backup-script`
  and `docker-gc-script`, as on unmodified `main` on the macOS development
  machine.
- T3 `application`: not run yet.
- Live: BLOCKED until a T5 gateway run on the test instance. Context and
  inference changes need T5 before release.
- Evidence: —

## Rollout

Merge, publish the runtime image and let deployments pick up the new digest.
Deployments that keep the default need no configuration change. Raise or lower
`contextTokens` per catalog entry when cost or model windows require it.
Rollback: revert this change.

## Open items

- [ ] Run T3 `application` on a Docker host.
- [ ] Run T5 gateway acceptance, including a long tool investigation followed
      by a follow-up in the same thread.
- [ ] Decide whether very large single tool results should also be capped when
      they are produced, not only when old ones are shrunk.
