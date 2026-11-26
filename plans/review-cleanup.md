# Review cleanup

Status: In progress

## Summary

A high-effort code review of `apps/agent`, `apps/admin`, `apps/slack`,
`apps/tool-runtime`, `apps/egress` and `scripts/`, plus architecture,
YAGNI and operations reviews, found defects and dead code across the
workspaces. A panel (architect, minimalist, operator, maintainer) then cut
the findings down to what this one pull request can prove at T0 to T3
without touching delivery, orchestration, context or authority semantics.

Constraints:

- `feat/thread-reply-decider` is in progress. This change leaves its files
  and regions alone: the reply path of `apps/slack/src/native-application.ts`,
  `apps/slack/src/reply-decider.ts`, `thread()` in
  `apps/agent/src/application/agent-service.ts` and the frontend host set in
  `apps/egress/src/policy.ts`.
- No change to the execution policy hash, the compiled admin document or
  stored data, so in-flight runs and pending questions survive the deploy.
- Deletions and fixes land in separate commits.

## Decisions and approach

In scope:

| ID  | Area         | Change                                                                                                |
| --- | ------------ | ----------------------------------------------------------------------------------------------------- |
| Q1  | CI           | Run T0 to T2 on pull requests and pushes to `main`. Until now only the image publish workflow ran.    |
| Q2  | build        | Typecheck the tests of admin, slack and egress.                                                       |
| A1  | admin        | Saving unrelated channel settings no longer re-checks an unchanged stored model key.                  |
| A2  | admin        | Removing a workspace also removes its channel reply settings.                                         |
| A3  | admin        | Editing one Atlassian token keeps the other stored token.                                             |
| A4  | admin        | Slack listings report truncation instead of returning a partial list as complete.                     |
| A5  | admin        | The cost group error names the real groups.                                                           |
| I1  | integrations | Atlassian reads cap the upstream body separately from the model output bound.                         |
| I2  | integrations | A truncated GitLab JSON body reports its size instead of "malformed JSON".                            |
| I3  | integrations | GitLab results stay within the model bound and mark truncation.                                       |
| I4  | integrations | Datadog argument validation stops growing Ajv's schema cache on every catalog refresh.                |
| I5  | integrations | Datadog tool errors keep their text unless they are an exact refusal.                                 |
| I6  | integrations | A malformed tool instance listing keeps the previous listing and cannot crash the process.            |
| I7  | integrations | The web reader refuses questions that carry their own URLs.                                           |
| I10 | integrations | A malformed tool secret response raises a fixed error.                                                |
| I18 | integrations | CLI runtime readiness stops retrying authentication failures.                                         |
| E6  | egress       | The per-network tunnel limit holds under a burst.                                                     |
| E7  | egress       | `EGRESS_IDLE_TIMEOUT_MS` accepts values above 65535.                                                  |
| S8  | slack        | Slack transport errors count as ambiguous, so users are told to retry.                                |
| S15 | slack        | A clean shutdown no longer logs a Socket Mode disconnect warning.                                     |
| T10 | tool-runtime | Generic credential redaction covers base64 and keeps the scheme.                                      |
| O3  | agent        | Pool and lease connection errors are handled; the lease loss exits on purpose.                        |
| O4  | agent        | Segment failures and unexpected server errors log their reason; warnings go to stderr.                |
| C10 | agent        | A malformed request body answers 400, not 503.                                                        |
| D1  | contracts    | Remove unreferenced coordinator protocol types and helpers; the generator and version stay.           |
| D2  | all          | Remove unreferenced exports and files.                                                                |
| D3  | repo         | Remove the unused root `skills/` and its hash helpers.                                                |
| D4  | tool-runtime | Remove the removed-variable migration check; use `node:crypto` for token comparison.                  |
| D8  | contracts    | Tool kind lists come from `contracts/tool-kinds.ts`.                                                  |
| D9  | agent        | One failure category source; drop dead failure detail branches.                                       |
| D10 | repo         | Root test list and dependency alignment.                                                              |
| D11 | docs         | Fix comments and docs that describe code that no longer exists, including `docs/channel-commands.md`. |
| D12 | contracts    | The generator also mirrors the task key into `apps/slack/src/taskkey.ts`.                             |

Left out, with the reason:

- Delivery and run correctness (cancel after retain leaves a retained row,
  post-send recheck marks a sent answer uncertain, transient config failure
  after a finished segment, restarted deadline, context notes not counted):
  they need T5 before release. Separate change.
- ToolSearch filter running the full guard for every catalog tool: inference
  path, needs T5. Separate change.
- Policy hash covering tool readiness: changes authority semantics and fails
  pending questions at deploy.
- GitLab `credentialVersion` binding on reads: reads may follow the current
  credential on purpose. Needs the maintainer's call.
- Run limits (enforce or drop), `files`/`localExec`, `skill.use`/`mcp.use`,
  unused admission and inference config: product decisions or stored data.
- `isLegacyWebSearch`: a fail-closed guard, not a compatibility path.
- Thread reply path defects and the egress environment cleanup: they collide
  with `feat/thread-reply-decider`.
- Health probe scan of every task on each probe, pool sizing, admin login
  abuse, session id hashing, member pagination, adapter liveness endpoint,
  build provenance, shared contracts package: separate changes.
- Plan statuses of merged features: the owner flips them after live checks.

## Work

- [ ] Q1, Q2
- [ ] A1 to A5
- [ ] I1 to I18
- [ ] E6, E7, S8, S15, T10
- [ ] O3, O4, C10
- [ ] D1 to D12

## Verification

- Deterministic: not run yet.
- Live: not run yet.

## Rollout

No stored data, policy hash or compiled document changes. Follow the
deployment repository's rollout runbook with a drained deploy.

## Open items

- [ ] Record verification.
