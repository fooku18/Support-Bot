# Answer before the run deadline

Status: Human review

## Summary

A run that reaches its step limit gets a last step without tools and answers
from what it found (#25). A run that reaches its time limit (300 s for answers
since #50) is aborted instead, and the requester sees "No confirmed answer.
Execution stopped or was refused." Live in the staging test channel on
`79f4c4a`: a replayed "Marketplace Logins are down to 0" report ran 303 s and
ended that way.

Goal: a run that runs out of time answers like one that runs out of steps.

## Decisions and approach

- `answerBefore(deadline)` in `apps/agent/src/mastra/agents/shared.ts` is a
  per-call `prepareStep` hook. From the deadline on, the next step gets the
  same forced answer as the last step: `toolChoice: 'none'` plus the
  last-step system message. The last-step processor now shares that code.
- `agent-service.ts` passes it with the deadline 90 s before the time limit
  (`FINAL_ANSWER_MS`). A step that starts just before the deadline can still
  run its tools, and the answer step needs time too.
- The hard time limit stays as the backstop. A resumed segment gets its own
  deadline, like its own timer.

## Verification

- T0: typecheck, lint, format.
- T1/T2 on Linux. New test in `apps/agent/test/runtime/last-step.test.ts`:
  with the deadline passed after two tool steps, the third request has
  `tool_choice: none` and the last-step message, and its text is the answer.
- T5: BLOCKED as for earlier merges; live check after deploy.
