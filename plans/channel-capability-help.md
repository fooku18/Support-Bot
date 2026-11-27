# Channel capability help

Status: Human review

## Summary

Answer “help” and “what can you do here?” when directly mentioned, at the channel root or in a thread.

## Decisions and approach

Reuse the authorized channel command and durable reply path. Use ready tools in the current compiled channel assignment, existing kind titles and one example per kind. Charts and thread summaries work without a tool. Keep `!help` for command syntax.

## Verification

The admin command regression failed on `f4e200a` with “Not a channel command”. It checks both questions before and after assigning web search, plus a normal request starting with “help”.

T0–T3 passed with the change on `f4e200a`, including 135 root tests and 82 application records (`artifacts/native/application/dc071087`). T4 and T5 are blocked: another session holds the designated instance lock.

## Rollout

Live acceptance blocked pending the shared test instance; staging smoke check pending deployment.
