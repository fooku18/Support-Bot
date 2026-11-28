# Link earlier reports of the same problem

Status: Done

## Summary

Feedback and incident channels ask "is this a duplicate, who owns it" and
"did this happen before". The agent has Jira read (Slack message search turned
out to be off, see Verification) where assigned, but nothing told it to look for earlier reports, so it
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
- [x] Before/after on four replayed reports with a known earlier twin
- [x] Deployed with !26 (upstream `79f4c4a`)

## Verification

- Deterministic, on `cfa5868` (main with #26) plus this change, in
  `node:26.13.1-bookworm`: T0 (`typecheck:all`, `lint`, `format:check`)
  pass; T1 `test:packages` pass (agent 725 tests); T2 `npm test` 135 pass;
  T3 `application` passed, 82 test records.
- Live: four replayed reports with a known earlier twin, posted as the
  human side in #test-1234 (each says it is a replay and gives the original
  date). Twins: the 2026-09-09 VPN storefront thread in
  #lets-buy-at-kaufland and its yellow flag, the 2026-11-04 yellow flag "No
  checkouts finalized", the 2026-05-27 red flag, and the 2026-07-07 red flag
  plus the 2026-07-30 yellow flag on crawler traffic.

| Case                                 | Before (`73fb4dc`, 2026-11-27 23:32 UTC)         | After (`79f4c4a`, 2026-11-28 06:09 UTC)                                           |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Storefront pop-up (lets-buy, 11-06)  | run stopped ("Execution stopped or was refused") | linked Jira IS-3034, the fix ticket for the same pop-up, with date and match note |
| Checkouts at zero (red flag, 11-04)  | no search, no link                               | "none found in Jira", Slack unchecked                                             |
| Logins at zero (red flag, 11-10)     | no search, no link                               | run stopped at the 300 s limit                                                    |
| Search degradation (red flag, 07-30) | no search, no link                               | "none found in Jira (two short queries)", Slack unchecked                         |
| **Earlier report linked**            | **0 of 4**                                       | **1 of 4** (Jira); 2 of 4 said none found                                         |

The after column runs on the release that also carries #26 (playbook) and
the 25-step budget, so it measures the release, not this line alone.
Neither of those mentions earlier reports or Slack search.

**Slack message search is not available to the agent.** Every after-run
said it has no Slack search tool, and that is right: the native agent sets
`catalog.slackSearch: false` (`application/agent-service.ts`,
`application/bindings/read-services.ts`), and the Slack adapter does not
forward the event's `action_token` that `assistant.search.context` needs.
The search transport and tool exist (`integrations/slack/`,
`tool-runtime`) but are not wired into native runs. So the line works for
Jira today, and all three Slack twins stay out of reach. The earlier
assumption in this plan ("the agent has Slack message search") was wrong.

## Rollout

Merged as `79f4c4a` (#42) and deployed with deployment MR !26 together
with #26 and #50 (image `sha256:9d16dd8e…`, revision label `79f4c4a`).
Live check above, 2026-11-28 06:09–10:15 UTC.

## Open items

- [ ] T5 gateway suite on the designated test instance (BLOCKED: no gateway
      test instance with Slack search).
- [ ] Slack message search in native runs: forward the mention's
      `action_token`, enable `slackSearch`, and give the Slack app the Agents
      & AI Apps feature and `search:read.public` (reinstall). Needs an
      operator decision for the productive Slack app.
