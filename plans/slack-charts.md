# Native Slack charts in answers

Status: Human review

## Summary

Asked to "visualize this as line charts" in #test-1234, the deployment
answered with Unicode sparklines: answer-only Kubernetes has no tool that
makes an image or a file. Slack added the `data_visualization` Block Kit
block on 2026-06-16 (pie, bar, area and line; up to 12 series of 20 points;
two per message; only `chat:write`). Answers should use it.

## Decisions and approach

- **A fenced `chart` block in the answer text, rendered by the adapter.** No
  tool, no table and no protocol change. The application store has only
  fresh-store provisioning, so a new table could not reach the deployment
  without a migration step. With the chart in the text, thread memory, the
  answer hash, delivery reconciliation and the long-answer file work
  unchanged.
- **Model-friendly JSON**: `categories` plus `series[].values`, one number
  per category. The adapter builds Slack's `data` points and pie
  `segments`.
- **One module owns the format.** `apps/agent/src/domain/delivery/slack-charts.ts`
  holds the limits, the parser, the block builder and the instruction
  paragraph built from the same limits; it is generated into the adapter.
- **Validate against Slack's limits before sending.** A fence that breaks a
  limit, and charts after the second, become "Chart not shown", never raw
  JSON. One note for every case: the reason does not help the reader.
- **Fallback on `invalid_blocks`.** It is a definite rejection (nothing was
  posted), so the adapter posts once more with notes in place of the charts.
  Every other failure keeps the existing one-shot classification.
- **Read back as `[Chart: <title>]`.** Thread memory keeps the full answer
  with the fence; only thread context and a fresh session read the posted
  message, and the key numbers stay in the text. A full read-back of the
  chart data (YAGNI review) would add a second format direction and up to
  about 700 tokens per chart on every read. Add it if follow-ups in fresh
  sessions need the chart data.
- Rejected: rendering PNGs in the agent (native dependency, fonts, file
  upload, blocked in shared channels) and hosted chart services (send
  internal data out).

## Work

- [x] `apps/agent/src/domain/delivery/slack-charts.ts` (mirrored to
      `apps/slack/src/generated/`): fence parser, validation, block builder,
      instruction paragraph.
- [x] `postMessage`/`replyBlocks`: chart blocks in place, chart-free
      notification text, one repost without charts on `invalid_blocks`.
- [x] `flattenOwnAnswer`/`flattenMessageContent`: `data_visualization` read
      back as `[Chart: <title>]`.
- [x] Instructions paragraph with the format and limits.
- [x] Review pass: simplify (4 angles) and YAGNI; fixes applied.
- [x] Docs: [slack-files.md](../docs/slack-files.md#charts).
- [x] Tests: `apps/slack/test/charts.test.ts`.

## Verification

- Deterministic, head `38a72e2` on `62610da`:
  - T0 on Windows 11, Node 26.13.1: `typecheck:all`, `lint`, `format:check`,
    `generate-protocol-clients --check` pass.
  - T1 `test:packages` and T2 `npm test` in a Linux container
    (`node:26.13.1-bookworm`): pass (slack 21 files with
    `charts.test.ts`, agent 72, admin 15, egress 3, model-stub 2, root 9).
  - T3 `test:native:integration -- --suite application`: 81 records pass.
- Manual Slack check (2026-11-27, sender app in the designated test
  workspace): `chat.postMessage` accepted a `markdown` block plus a line
  chart (3 series × 16 points) and a bar chart (3 × 9); the blocks read back
  intact.
- T4 stub suite and T5 gateway: BLOCKED. The shared test instance is
  locked by another session (PR #26 replay panel) until 19:27 UTC. Live
  acceptance moves to the first chart request in the deployment's test
  channel after rollout.

## Rollout

Merge to `main` publishes the image; the deployment repo's digest bump
deploys it, with the operator's approval (given for this change).

## Open items

- [ ] Live check in the deployment's test channel after rollout.
