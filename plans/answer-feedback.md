# Answer feedback buttons

Status: Human review

## Summary

Answer quality is judged only from the replay panel. Real users' votes show
which answers helped, which matters once lumi serves the E&D channels. Every
final answer now ends with **Helpful** and **Not helpful** buttons; a click is
stored and the Costs page shows the counts.

## Decisions and approach

- **Reuse the click path of #38.** Interactivity is on and the receiver already
  routes `interactive` envelopes after its channel membership check, so there is
  no new scope, event or reinstall. Any channel member may vote.
- **The buttons.** The agent passes `feedbackRunId` with the final answer only
  (not with notices or questions). `postMessage` appends one `actions` block
  (`block_id` `answer_feedback`, `action_id` `answer_feedback:up|down`, `value`
  the run ID). `flattenOwnAnswer` ignores it, so thread context is unchanged.
- **The click** (`feedbackClick` in `native-application.ts`) is acknowledged,
  checked (team, vote, run ID shape, channel, message and thread ts) and sent to
  the admin through the existing `CommandClient` as
  `/internal/channel-commands/feedback`. The clicker gets a private
  "Thanks, your vote was saved: Helpful." (or "could not be saved").
  Ephemeral, not `chat.update`: the answer message is shared, the confirmation
  is per person.
- **Storage.** The admin settings database already holds run data
  (`provider_requests`, `cost_runs`). New table `answer_feedback` with primary
  key `(run_id, user_id)`; a later click upserts the vote. The bootstrap Job runs
  `provision-postgres` (`CREATE TABLE IF NOT EXISTS`) and the runtime grants on
  every deploy, so the migration is additive. The agent store (`native_agents`)
  has no migration path, so it was not used.
- **Counts.** The Costs page gets an "Answer feedback" table: the 50 most
  recently voted answers with channel, answer ts, run ID, helpful and not
  helpful counts and the last vote time.
- YAGNI: no comment box, analytics, setting, permalinks or removal of votes.

## Work

- [x] `feedbackRunId` on the final answer delivery; feedback block in `postMessage`.
- [x] `feedbackClick` in the adapter, private confirmation.
- [x] Admin route, `answer_feedback` table, store upsert and aggregate.
- [x] Costs page table; `docs/native-answer.md`.
- [x] Tests: blocks, click routing (stored body, invalid vote and run ID, admin
      refusal), admin route (upsert, validation, token), page render, agent
      delivery passes the run ID.
- [x] T0 to T3 `application`, PR.
- [ ] Deploy, live click in #test-1234.

## Verification

- Deterministic (2026-11-28): T0 passes. T1 and T2 pass in a Linux container
  (agent 742 tests, Slack 218, root 135; rerun after rebasing onto `6c8828b`). T3 `application` passes (82 records)
  after the vertical's footer checks moved to the second-last block; its
  discovery answer now also asserts both buttons carry the run ID.
- T4: not run. The shared local instance was locked by another session
  (`playbook-budget`, until 02:45 UTC), and the stub suite cannot click a button.
- Live: T5 BLOCKED (no gateway test instance with the needed tools). Staging check pending.

## Rollout

Pending.
