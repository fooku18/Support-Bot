---
name: plan
description: Plan and track repository work in checked-in Markdown. Use for designs, work orders, feasibility checks, status updates, and recording verification or deployment against an existing plan.
---

# Work plans

Keep one Markdown file per work item in `plans/<topic>.md`, using a short
lowercase, hyphenated topic name. Search existing plans first and update
the matching file. Link related plans when work is intentionally split.
Use the same file for decisions, implementation, verification and rollout.

Read the affected code and the current documentation before writing a plan.
Record open decisions with the tradeoffs. Record the operator's answer once
given. Link prerequisites, reports and review requests from the relevant
section. Keep credentials, private logs and message content out of Git.

## Template

Start with the following headings and include the sections the work needs.

```markdown
# <Work item>

Status: Proposed | In progress | Human review | Done | Canceled

## Summary

<Problem, desired result, scope and relevant constraints.>

## Decisions and approach

<Design, tradeoffs and any decisions awaiting an answer.>

## Work

- [ ] <An independently verifiable step>

## Verification

- Deterministic: <command, revision and outcome>
- Live: <scenario, revision and outcome, or missing prerequisite>
- Evidence: <report or other retained evidence>

## Rollout

<Merge or deployment requirements, approval, deployed revision and rollback record.>

## Open items

- [ ] <Remaining step or blocker>
```

## Update the record

- Use **Proposed** for work awaiting a decision, **In progress** while work
  is underway and **Human review** when a human step blocks completion.
  Name the decision or prerequisite and who needs to act. Use **Canceled**
  for abandoned or superseded work and link the successor where applicable.
- Update the plan as work changes. Record what landed, deviations and the
  exact revision and outcome of each verification. Follow
  [testing.md](../../../docs/testing.md) for required checks and distinguish
  synthetic verification from live acceptance. Mark missing prerequisites
  **Blocked** and name them.
- Before merging, fill the verification record, including the live outcome
  or why it was blocked or did not apply. Include the plan path in the merge
  or pull request. Use **Done** once the change is merged and any required
  production deployment has completed. For deployment, record the revision,
  time, rollback reference and evidence in the plan. Follow
  [production-recovery.md](../../../docs/production-recovery.md) for the
  deployment guard and recovery procedure.

For status questions, read the plan and verify it against current code,
test evidence or deployment records. Update stale status when the evidence
supports the correction.
