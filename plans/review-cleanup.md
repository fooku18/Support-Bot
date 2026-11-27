# Review cleanup

Status: Human review

## Summary

A high-effort code review of `apps/agent`, `apps/admin`, `apps/slack`,
`apps/tool-runtime`, `apps/egress` and `scripts/`, plus architecture,
YAGNI and operations reviews, found defects and dead code across the
workspaces. A panel (architect, minimalist, operator, maintainer) then cut
the findings down to what this one pull request can prove at T0 to T3
without touching delivery, orchestration, context or authority semantics.

Constraints:

- The thread reply decider (#8, #9) landed while this was in progress. This
  change leaves its code alone: the reply path of
  `apps/slack/src/native-application.ts`, `apps/slack/src/reply-decider.ts`,
  `thread()` in `apps/agent/src/application/agent-service.ts` and the
  frontend host set in `apps/egress/src/policy.ts`.
- No change to the execution policy hash, the compiled admin document or
  stored data, so in-flight runs and pending questions survive the deploy.
- Deletions and fixes land in separate commits.

## Decisions and approach

In scope:

| ID  | Area         | Change                                                                                                |
| --- | ------------ | ----------------------------------------------------------------------------------------------------- |
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

- A CI workflow running T0 to T2 on pull requests: the contributor token
  cannot change workflow files. Separate change by the maintainer.
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
- Thread reply path defects (refusal notice on unmentioned chat, control
  words without a mention, acknowledged intake errors, unwired
  `reportSeen`) and the egress environment cleanup: Slack intake needs T4
  and T5, and the decider work was landing at the same time.
- Health probe scan of every task on each probe, pool sizing, admin login
  abuse, session id hashing, member pagination, adapter liveness endpoint,
  build provenance, shared contracts package: separate changes.
- Plan statuses of merged features: the owner flips them after live checks.

## Work

- [x] Q2 (plus the `LiveOptions['limits']` type the new test typecheck
      exposed)
- [x] A1 to A5
- [x] I1 to I7, I10, I18
- [x] E6, E7, S8, S15, T10
- [x] O3, O4 (segment and ingress failure reasons, warnings to stderr), C10
- [x] D1 to D4, D8 to D12. D1 also removed every other `protocol.ts` export
      without a reference; `PROTOCOL_VERSION` stays at 30 because the only
      wire types (`IntakeRequest`, `SlackFileDescriptorDto`) are unchanged.
      Mirrors are regenerated with `npm run generate:protocol` inside the
      commit that changes their source, so every commit passes the drift
      check.

Each behaviour fix carries its test in the same commit, and each new test
failed before its fix. A final review pass over the branch diff (`code-review`
high and `simplify`) found follow-ups in A3, A4, I4, I7, I18, O3 and O4; they
are folded into those commits.

## Verification

- Deterministic, Linux (`node:26.13.1-bookworm` container):
  - Every commit on the branch: `npm run typecheck:all`, `npm run lint` and
    `npm run format:check` pass.
  - Head: `npm run test:packages` and `npm test` pass (agent 664, admin 138
    and 1 skipped, slack 171, egress 31, model-stub 19, root 135).
  - Base `1365d82` (rebased over #11 and #12).
- Images: `runtime`, `cli-runtime`, `egress` and `native-coding` build from
  the branch head, and
  `tests/integration/runtime-image.sh --prebuilt` passes on the `runtime`
  image.
- T3 `tools` and `coding` (those images): pass.
- T3 `application` (Windows host; the container route cannot reach the
  published PostgreSQL port): every phase up to `inputs-corrections` passes.
  `inputs-corrections` then fails at
  `input-context-tripwire-is-explicit-failure-without-delivery`, the same
  way on unmodified `main` at `6f90d07`. The 200 KB fixture no longer trips
  the context budget since `fbf252f` raised the default to 64,000 tokens,
  and a 400 KB file already exceeds the input bounds. The later
  `application` phases did not run. See the open item.
- T4 stub suite: BLOCKED. The only local test instance was in use by
  another session's stack and Studio run, and its images would have to be
  rebuilt from this branch. Run `--suite stub --run --switch-mode` on the
  test instance before merging.
- T5: not required. No change touches Slack intake or delivery,
  orchestration, context, inference, coding or publication.

## Rollout

No stored data, policy hash or compiled document changes, so pending
questions and retained answers survive the deploy. Follow the deployment
repository's rollout runbook with a drained deploy.

Behaviour changes operators can see:

- The agent exits with code 1 and logs `execution lease lost` when its
  lease connection fails, instead of crashing with a stack trace. The pod
  restarts.
- The agent logs `native segment failed ... reason=` and
  `native ingress failed route=... reason=`. Warnings of the agent and the
  adapter go to stderr.
- Admin Slack listings in workspaces with more than 4,000 users or channels
  show the listing error instead of a silently partial list.
- The web reader refuses a question that contains a URL.
- The CLI runtime no longer refuses to start when a removed tool variable is
  set; it ignores it.

## Open items

- [ ] Fix the stale context tripwire fixture in
      `tests/integration/mastra/durable-answer-vertical.ts` under
      `plans/context-budget.md`, then run the whole `application` suite.
- [ ] `apps/agent/src/domain/delivery/replies.ts` still uses the narrow
      Bearer redaction that T10 fixed in the CLI runtime.
