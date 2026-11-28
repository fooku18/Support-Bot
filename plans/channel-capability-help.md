# Channel capability help

Status: Human review

## Summary

Answer “help” and “what can you do here?” when directly mentioned, at the channel root or in a thread.

## Decisions and approach

Reuse the authorized channel command and durable reply path. Use ready tools in the current compiled channel assignment, existing kind titles and one example per kind. Charts and thread summaries work without a tool. Keep `!help` for command syntax.

## Verification

The admin command regression failed on `f4e200a` with “Not a channel command”. It checks both questions before and after assigning web search, plus a normal request starting with “help”.

T0–T3 passed with the change on `f4e200a`, including 135 root tests and 82 application records (`artifacts/native/application/dc071087`). On `e6a0e29`, T5 gateway (no external tools) passed (`suite-b86f6c7c-751c-4fc2-9b46-532f3e2bb0b2`). Seven of eight T4 scenarios passed across two runs; the cancel scenario failed twice with `expected_answer_fact_missing`, also observed on unmodified main. The lifecycle scenario passed on retry (`suite-3da8c78a-f97f-4daf-81be-18a84d9544d9`).

## Rollout

Test instance restored to the gateway baseline. Deployment and production smoke checks pending.
