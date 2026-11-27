# Bug hunt, November 2026

Status: In progress

## Summary

A bug hunt over the deployed answer path on `main` at `8d2c2fb` (after the
review cleanup, #13; rebased on `2af60bf`): agent runtime and bindings, the
read integrations, the Slack adapter, the admin and the CLI runtime with
egress. Each finding below was reproduced by a failing test before its fix,
and each fix is its own commit with that test.

Out of scope: findings already tracked elsewhere (durable-run cancel and
retain, the ToolSearch guard per step, the policy hash over tool status,
health probes scanning all tasks, thread intake refusals, GitLab credential
binding, admin login hardening, the step-limit failure notice).

## Findings and fixes

| #   | Area      | Defect                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                           |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Slack     | A thread reply also sent to the channel (`thread_broadcast`) was dropped without a follow-up. The message copy of a mention beyond the 16 KiB flattened content cap looked unmentioned and started a second run.                                                                                                         | Accept `thread_broadcast`; look for the mention in the message flattened without the 16 KiB cap (`flattenMessageContent` takes the cap as a parameter).                                                       |
| 2   | Slack     | Decider input was bounded by UTF-16 length and could carry a lone surrogate.                                                                                                                                                                                                                                             | Drop a trailing high surrogate after each cut.                                                                                                                                                                |
| 3   | Admin     | Costs, audit and config pages read their live version after their data, so a commit in between left the page stale without the reload offer.                                                                                                                                                                             | Read the versions first.                                                                                                                                                                                      |
| 4   | Admin     | `count` rendered 999,500 as `1000k` and 9,995,000 as `10.00M`.                                                                                                                                                                                                                                                           | Choose the unit from the rounded value.                                                                                                                                                                       |
| 5   | Datadog   | Every schema compile stayed in the global Ajv scope, and each probe or run brought new catalog objects, so validators accumulated in the CLI runtime and the runner. The MCP client also cached an output validator per tool on every `tools/list`. A root cause of the CLI runtime's heap exhaustion under replay load. | Cache validators by canonical schema content, compile from a copy, share the cache with the client, and replace cache and Ajv past 2,000 schemas.                                                             |
| 6   | Datadog   | A canceled or timed-out call left its upstream request running. Every completed call sent a stray `notifications/cancelled` when its timeout fired later. JSON-RPC InvalidParams and InvalidRequest errors were reported as server or permission failures.                                                               | Pass the per-call signal to the guarded fetch; give each call a controller that is never aborted after it settles; map those codes to tool errors with the bounded message.                                   |
| 7   | Atlassian | The 12,000-byte cap cut the JSON mid-item and dropped the paging field without telling the model (20 comments delivered 8, no `nextStartAt`). Code macro bodies (CDATA) vanished from Confluence pages. ADF inline cards, mentions, emoji, status and dates rendered as nothing.                                         | Drop whole items, report `omittedCount` and continue at the first item left out (search pages withhold the token and say how to re-read); mark cut bodies; keep CDATA text; render inline nodes from `attrs`. |
| 8   | GitLab    | A page over 60 KB was cut mid-JSON and encoded twice, while `next_page` still pointed past every row (20 diff files delivered 4, the model was sent to page 2).                                                                                                                                                          | Drop whole rows, keep `data` structured, and name the omitted rows with a page size and page that resume at the first of them.                                                                                |
| 9   | Agent     | Every run fetched the CLI runtime's readiness and rethrew any failure, so a runtime restart or sync error failed every answer, also in channels without a runtime-backed tool.                                                                                                                                           | Fetch readiness only when the channel has a runtime-backed tool. Channels with one still refuse before inference (see Open items).                                                                            |
| 10  | Agent     | The output `TokenLimiterProcessor` counts text across all steps, so a multi-step run whose steps together exceeded the step limit was aborted and its answer lost.                                                                                                                                                       | Remove it; `maxOutputTokens` caps each step.                                                                                                                                                                  |

## Decisions and approach

- One pull request, one commit per fix with its test, so each can be
  reviewed or reverted on its own. Findings 6 and 7 bundle defects that
  share one function and its test hunk.
- Finding 9 first left out a tool whose readiness or instance check failed
  and answered without it. T3 `application` showed that upstream
  deliberately refuses such a run before inference
  (`malformed-bound-readiness-refuses-before-inference`), so the fix is
  narrowed to channels without a runtime-backed tool. Whether a channel
  with tools should answer without an unready tool is left to the owner
  (Open items).
- A hunt finding that every file part counted as a flat 1,600 tokens in
  the context budget was fixed upstream in #30 while this branch was open;
  its commit was dropped in the rebase.
- Not fixed: a `webSearch` instance stored in the retired provider shape
  cannot be disabled, because a status change re-validates its settings.
  The project carries no compatibility paths, and no such row should exist.

## Work

- [x] Hunt and failing repro tests for every finding.
- [x] Fixes 1 to 10.
- [x] T0 to T2 on Linux.
- [x] T3 `application` and `tools`.
- [x] T4 stub suite (Slack intake changes): 7 of 8, the eighth fails on `main` too.
- [x] Review of the branch diff by a separate reviewer. Folded into the
      fixes: finding 1 keeps the flattened-content check, so mentions in
      section blocks and attachments stay copies; finding 5 compiles with
      `validateSchema: false` like the SDK, so schemas that declare a
      draft 2020-12 `$schema` validate; finding 7 always keeps the first
      item and puts paging fields before `items`, so one oversized comment
      cannot pin the continuation.
- [x] Cleanup pass (reuse, simplification, efficiency, altitude), folded
      into the fixes: one uncapped flatten for the mention check, the
      readiness gate reads `CLI_RUNTIME_KINDS`, the Atlassian page fit
      searches by bisection instead of re-rendering per dropped item and
      shares one token-page projection, the Datadog validator cache keys
      once per tool, and the GitLab resume hint picks the largest page size
      that lands on the first omitted row. Left for a follow-up: one shared
      "fit whole items" and byte-cut helper for Atlassian, GitLab, Slack
      search and Cloudflare (Slack search still keeps `nextPage` past
      dropped messages).

## Verification

- Deterministic:
  - Every new test failed on `main` before its fix and passes with it.
  - Every commit: `npm run typecheck:all`, `npm run lint` and
    `npm run format:check` pass (on `301940c`).
  - Head, Linux (`node:26.13.1-bookworm` container): `npm run test:packages`
    and `npm test` pass (admin 142 and 1 skipped, agent 716, egress 31,
    model-stub 19, slack 210, root 135) after the rebase on `2af60bf`
    (slack 183 on `62610da`, before #32 added its chart tests).
  - T3 `tools` (Linux, `cli-runtime` and `egress` images from the branch):
    19 records pass. T3 `application` (Windows host): 82 records pass,
    including `input-context-tripwire-is-explicit-failure-without-delivery`
    (stale before #30) and `malformed-bound-readiness-refuses-before-inference`.
  - T4 (`--suite stub --run --switch-mode`, images from this branch on
    `2af60bf` after the cleanup pass, local test instance): 7 of 8 scenarios pass (summary
    `suite-47539568-…`; before the cleanup `suite-ab18000e-…`). `stub-cancel-control-stops-a-held-run` fails with
    `expected_answer_fact_missing`: the request after the cancel runs but its
    answer is not observed. It fails the same way on `cccd7a9` and on
    `97efb3c` and `8d2c2fb` without this branch (twice each), though
    `8d2c2fb` passed it at the #13 T4, so the cause is the test instance
    state, not this change.
- Live: T5 is required before release for findings 1, 2 and 10 (Slack
  intake, inference). BLOCKED until the designated test instance has a
  gateway key with budget.

## Rollout

No stored data, policy hash or compiled document changes. Follow the
deployment repository's rollout runbook with a drained deploy.

Behaviour changes operators can see:

- A channel without runtime-backed tools answers while the tool runtime is
  down or restarting, instead of with the failure notice.
- Atlassian and GitLab reads over their bound return fewer whole items with
  an omission note instead of cut JSON.

## Open items

- [ ] T5 gateway suite for findings 1, 2 and 10.
- [ ] Owner decision: should a channel with tools answer without a tool
      whose readiness or instance check fails (and log it), instead of
      refusing the run before inference? Today one unsynced or mismatched
      tool, or a CLI runtime restart, fails every answer in that channel.
      Changing it means updating
      `malformed-bound-readiness-refuses-before-inference`.
