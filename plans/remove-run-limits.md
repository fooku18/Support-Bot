# Remove the run-limits setting

Status: Human review

## Summary

The admin Configuration page and the admin API (`GET`/`PUT /api/run-limits`)
let an operator set six deployment-wide run limits (tool calls, estimated
cost, active time, pause wait, tool timeout, output cap). The admin compiles
them into the configuration document's `runLimits` section, the agent
validates the section and copies it into
`coordinatorRunConfiguration().runLimits`, and nothing reads it there. The
soft-limit pause that the page describes does not exist in the native agent.
The execution policy hash and the run itself use the fixed `options.limits`
(`outputTokens`, `maxSteps`, `timeoutMs`) from `bootstrap/application.ts`.
An operator who changes a limit changes nothing, so the setting misleads.

The operator decided to remove the setting, not to enforce it. Remove it end
to end: admin UI, admin API, admin store and schema, compiled document,
agent document contract, agent run configuration, DTOs, generated clients
and tests. Keep the fixed `options.limits`.

The deployment is productive. Its settings database holds a compiled
document with `runLimits` and possibly a `run_limits` row. Both must keep
loading after the change.

## Decisions and approach

- **Stored settings.** The admin already handles a retired document section:
  on start, `AdminStore.open` recompiles when the stored document's sections
  differ from the compiler's (`compileCandidate`, `sections(current) !==
sections(candidate)`), and stores one new version with an audit row
  `config.recompile`. A stored document with `runLimits` therefore becomes a
  new version without it on the first start. `currentDocument()` parses the
  stored JSON without a schema, so reading the old row does not fail. The
  settings-preservation test proves this the same way it proves the retired
  `feedbackIssues` section: the fixture writes the legacy `run_limits` table
  and row and a stored document carrying `runLimits`; the reopened store
  serves a document without the section, leaves every other table
  unchanged and renders `/config`. A second test stores the previous
  release's exact document shape (its only extra section is `runLimits`,
  with a valid previous-format hash) and shows one recompile, the kept
  `run_limits` row and no further version on the next start; it fails on
  the previous admin code.
- **The `run_limits` table stays in existing databases.** The schema stops
  creating it, and no code reads it. Dropping it would be a migration with
  data loss for no gain; upstream keeps no migration code. A fresh database
  has no such table.
- **The agent keeps the strict contract.** `parseCoordinatorAdminDocument`
  accepts exactly the sections the current compiler writes, so it refuses a
  document that still carries `runLimits`. The agent stores no admin
  document (it holds the current one in memory and pulls it from the admin
  at every authority boundary), so nothing persisted needs to parse. The
  only exposure is rollout skew: all roles run one image and the Helm
  release recreates every Deployment at once. A new agent that starts
  before the new admin has recompiled fails its startup readiness
  (`readiness-configuration`) and exits; its container restarts until the
  admin serves the new document, the same path as an admin that is not up
  yet. Production is drained before the rollout. No compatibility path is
  added.
- **No replacement setting.** The fixed limits stay code constants. The Code
  Mode description on the Tools page no longer claims nested calls count
  against run limits.
- **Overlap with PR #13** (`refactor/review-cleanup`): it deletes the unused
  `RunClaimResponse` DTO (which has a `runLimits` field) and other soft-limit
  DTOs, and touches imports next to the lines removed here. This change
  removes only the `runLimits` field of that DTO and `RunLimitsDto`; the
  soft-limit vocabulary stays with PR #13. Expect small import and DTO
  conflicts for whichever lands second.

### YAGNI review

Run on this plan before implementation. Goal: the dead setting is gone end
to end; standing decisions: remove, do not enforce, no compatibility paths,
stored settings keep loading.

| Item                                     | Verdict  | Reason                                                                                                                                         |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Replacement setting or enforcement       | Drop     | None planned; the fixed `options.limits` stay code constants.                                                                                  |
| Agent tolerance for a legacy `runLimits` | Drop     | The agent persists no admin document; the only exposure is seconds of rollout skew on a drained deployment.                                    |
| Migration dropping `run_limits`          | Drop     | Data loss for no gain; the kept row also lets a rollback recompile the old values. Cost to add later: one `DROP TABLE`.                        |
| Code Mode sentence                       | Simplify | Delete the sentence; do not restate Code Mode's own limits there.                                                                              |
| `RunClaimResponse` and soft-limit DTOs   | Keep out | Unused, but PR #13 deletes them; only the `runLimits` field goes here so `RunLimitsDto` can go.                                                |
| Preservation-test extension              | Keep     | It is the evidence the brief requires that a stored document with the old section still loads; it reuses the existing retired-section pattern. |

Result: the removal is complete and adds no setting, path or table.

## Work

- [x] Preservation test first: the fixture stores the legacy section and row;
      the reopened store drops `runLimits` from the served document (red).
- [x] Admin: remove the Run limits card and its form route, the
      `/api/run-limits` routes, the store methods, the compiled section and
      its hash inputs, the `run_limits` table from the schema, and the Code
      Mode sentence.
- [x] Agent: remove the `runLimits` contract (`RunLimits`,
      `DEFAULT_RUN_LIMITS`, `RUN_LIMIT_BOUNDS`, `validateRunLimits`),
      `domain/authorization/run-limits.ts`, the document section,
      `CoordinatorRunConfiguration.runLimits`, `RunLimitsDto` and the stale
      tool-profile comment.
- [x] Regenerate the admin and Slack clients (`npm run generate:protocol`).
- [x] Update the admin and agent tests that used the section.
- [x] T0 to T2, T3 `application`.

## Verification

- Deterministic, on Windows with Node 26.13.1, against base `fc35a2d` (rebased; the first run on `299f98b` matched):
  - TDD: `apps/admin/test/settings-preservation.test.ts` failed first
    (`expected { version: 10, …(5) } to not have property "runLimits"`),
    then passed after the removal. The `runLimits`-only test added after
    review fails on the previous admin source (`expected 1 to be 2`, no
    recompile) and passes on this change.
  - T0: `typecheck:all` (including `generate:protocol --check`), `lint` and
    `format:check` pass.
  - T1: admin 134 passed, Slack 176, egress 30, model stub 19. Agent 55
    failed and 616 passed; the 55 are the Windows baseline (publication
    checkouts, guard, transfer links, candidate store, publisher, and the
    inspection subprocess test), none in configuration or contracts.
  - T2: 31 failed, 86 passed, the Windows baseline (fake `docker` and shell
    script tests).
  - T3 `application`: 69 checks pass, then it stops at
    `input-context-tripwire-is-explicit-failure-without-delivery`, the
    known stale fixture on `main`. The settings-change and policy phases,
    which compile documents with the admin compiler and parse them in the
    agent, pass.
- Live: T4 BLOCKED: the shared local test instance is locked by another
  session. The change touches the settings service, so T4 is the tier that
  applies; the preservation test and the T3 `application` suite (which
  compiles documents with the admin compiler and parses them in the agent)
  cover the contract. T5 does not apply: no intake, delivery,
  orchestration, context or inference change.
- Evidence: local T3 run `artifacts/native/application/53335e77` (not in
  Git).

## Rollout

Merge upstream. No deployment from this work order; the deployment repo's
digest bump is a separate, operator-approved step. On that rollout, expect
one `config.recompile` audit row with reason `startup` and a new config
version without `runLimits`, and no other settings change. The orphan
`run_limits` table remains. Rolling the upgraded database back to the
previous image needs no data step: its admin sees the missing section on
start and recompiles once, taking the limits from the kept `run_limits` row
(or its defaults), and its agent accepts that document. A PostgreSQL
database first provisioned by the new image has no `run_limits` table; the
previous image's owner provisioning must run before its admin starts there.

## Review

Astra (GPT-6.2 Astra, OpenAI account route, effort `high`) reviewed
`origin/main...HEAD` read-only. It found no runtime blocker for the
upgraded production database.

- T4 not run (blocker for the testing rules): kept BLOCKED with the reason
  above; an open item.
- The rollout note claimed a new agent recovers at its next pull; it exits
  at startup readiness and restarts instead. Corrected under the agent
  decision.
- The fixture added `runLimits` next to `feedbackIssues`, so a recompiler
  that only knew `feedbackIssues` would pass. Added the `runLimits`-only
  test with a previous-format hash.
- Rollback on a database first provisioned by the new image needs the
  previous image's provisioning. Qualified above.

## Open items

- [ ] T4 on the test instance once it is free.
- [ ] Deployment through the deployment repo's digest bump, approved by the
      operator; then record it here and set the status to Done.
