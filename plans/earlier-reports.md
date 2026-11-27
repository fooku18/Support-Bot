# Link earlier reports of the same problem

Status: In progress

## Summary

Feedback and incident channels ask "is this a duplicate, who owns it" and
"did this happen before". The agent has Slack message search (and Jira read
where assigned), but nothing tells it to look for earlier reports, so it
investigates every report as new.

Goal: for a bug or incident report, or a "known or duplicate" question,
the agent searches Slack (and Jira where assigned) for earlier reports of
the same problem, links the best one to three with a one-line note each, and
says when it found none.

## Decisions and approach

- One line appended to `supportPlaybook`
  (`apps/agent/src/application/instructions.ts`), no code. Slack search
  results already carry channel, date and a permalink
  (`integrations/slack/slack-api-adapter.ts`), and bot posts such as
  incident cards are searchable through their blocks.
- "Ignore the current thread": the report itself is the best search hit.
- The playbook length guard rises from 2,000 to 2,400 characters (now
  2,278).
- Measured on staging in #test-1234, not on the local replay instance:
  the local Slack test app lives in another workspace and has no Slack
  search, so the replay eval cannot show this.

## Work

- [x] Playbook line and unit test (`apps/agent/test/application/instructions.test.ts`)
- [ ] Before/after on four replayed reports with a known earlier twin

## Verification

- Deterministic, on `2bd3455` (#26) plus this change, in
  `node:26.13.1-bookworm`: T0 (`typecheck:all`, `lint`, `format:check`)
  pass; T1 `test:packages` pass (agent 725 tests); T2 `npm test` 135 pass;
  T3 `application` passed, 82 test records.
- Live: four replayed reports with a known earlier twin, posted as the
  human side in #test-1234 (each says it is a replay and gives the original
  date). Twins: the 2026-09-09 VPN storefront thread in
  #lets-buy-at-kaufland and its yellow flag, the 2026-11-04 yellow flag "No
  checkouts finalized", the 2026-05-27 red flag, and the 2026-07-07 red flag
  plus the 2026-07-30 yellow flag on crawler traffic.

| Case                                 | Before (`73fb4dc`, 2026-11-27 23:32 UTC)         | After |
| ------------------------------------ | ------------------------------------------------ | ----- |
| Storefront pop-up (lets-buy, 11-06)  | run stopped ("Execution stopped or was refused") |       |
| Checkouts at zero (red flag, 11-04)  | no Slack search; Datadog analysis, no link       |       |
| Logins at zero (red flag, 11-10)     | no Slack search, no link                         |       |
| Search degradation (red flag, 07-30) | no Slack search, no link                         |       |
| **Earlier report linked**            | **0 of 4**                                       |       |

The after column runs on the release that also carries #26 (playbook) and
the 25-step budget, so it measures the release, not this line alone.
Neither of those mentions earlier reports or Slack search.

## Rollout

Merge to `main` after #26, then the image digest bump in the deployment
repository, batched with the #26 rollout if timing allows.

## Open items

- [ ] T5 gateway suite on the designated test instance (BLOCKED: no gateway
      test instance with Slack search).
