# Run status line in the thread

Status: In progress

## Summary

A run takes 60 to 110 s on staging. Until now the requester saw only the
hourglass reaction on their message. Now lumi posts one short status message in
the thread while it works ("Thinking…", "Checking Datadog…", "Reading merge
request !123…"), edits it as the run calls tools, and deletes it once the answer
or question is posted.

## Decisions and approach

- **From tool calls only.** `runNativeSegment` passes each `tool-call` chunk of
  the Mastra stream to a callback. `toolStatus` maps the tool name to a fixed
  line. Only a positive integer IID or a Jira key (`ABC-123`) from the arguments
  goes into the line; nothing else the model wrote reaches Slack. `ask_user`
  shows nothing, unknown tools show "Working…". No model-written narration.
- **Throttle in the agent.** `createRunStatus` sends at most one line per 3 s
  and 8 per segment, skips a repeat, and drops a failed send. The first line,
  "Thinking…", goes out when the segment starts. The segment waits for the
  pending sends before it returns, so no status arrives after the answer.
- **Adapter route `/native-status`.** Same bearer token and task-key identity
  check as `/native-delivery`; the first line of a run also checks requester
  membership and source authority, later lines only the current installation.
  The first line posts with `chat.postMessage` (a context block in italics),
  later lines `chat.update` it. Errors return 503 and the agent ignores them.
- **Delete, not replace.** The answer path (blocks, footer, charts, long-answer
  files, question buttons, feedback buttons from the parallel thread) stays
  untouched. `present()` deletes the status message in its `finally`, next to
  the hourglass removal, after the answer or question has posted. Replacing the
  status with the answer would have meant a second delivery path.
- No new Slack scope (`chat:write` covers post, update and delete of own
  messages), no setting, no table.
- Not handled (YAGNI): an adapter restart mid-run leaves the status message
  behind; a status post notifies thread followers once.

## Work

- [x] `toolStatus` and `createRunStatus` (`apps/agent/src/domain/delivery/run-status.ts`).
- [x] `runNativeSegment` tool-call callback; agent service wires it to `options.status`.
- [x] Bootstrap sends to the adapter's `/native-status` (10 s timeout).
- [x] Adapter `createRunStatuses` (`apps/slack/src/run-status.ts`), route, delete in `present()`.
- [x] Tests: labels, throttle, segment callback, route (post, update, refusals, failed post), clear.
- [ ] T0 to T3 `application`, PR.
- [ ] Deploy, live check in #test-1234.

## Verification

- Deterministic (2026-11-28): T0 passes. T1 and T2 pass in a Linux container
  (agent 740 tests, Slack 216, admin 142, root 135). T3 `application` passes
  (82 records).
- T4: not run. The shared local test instance is locked by another session until
  02:45 UTC.
- Live: T5 BLOCKED (no gateway test instance with the needed tools). Staging
  check in #test-1234 after the deploy: pending.

## Rollout

Pending.
