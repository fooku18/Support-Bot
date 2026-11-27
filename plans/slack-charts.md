# Native Slack charts in answers

Status: In progress

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
- **Validate against Slack's limits before sending.** A fence that breaks a
  limit, and charts after the second, become a short note, never raw JSON.
- **Fallback on `invalid_blocks`.** It is a definite rejection (nothing was
  posted), so the adapter posts once more with notes in place of the charts.
  Every other failure keeps the existing one-shot classification.
- **Read back as the same fence.** `flattenOwnAnswer` turns a
  `data_visualization` block (ours or another app's) into the fence, so a
  fresh session sees the chart data in the model's own format.
- Rejected: rendering PNGs in the agent (native dependency, fonts, file
  upload, blocked in shared channels) and hosted chart services (send
  internal data out).

## Work

- [x] `apps/slack/src/charts.ts`: fence parser, validation, block builder.
- [x] `postMessage`/`replyBlocks`: chart blocks in place, chart-free
      notification text, one repost without charts on `invalid_blocks`.
- [x] `flattenOwnAnswer`/`flattenMessageContent`: `data_visualization` read
      back as a `chart` fence (contract and generated mirror).
- [x] Instructions paragraph with the format and limits.
- [x] Docs: [slack-files.md](../docs/slack-files.md#charts).
- [x] Tests: `apps/slack/test/charts.test.ts`.

## Verification

- Deterministic: pending.
- Manual Slack check (2026-11-27, sender app in the designated test
  workspace): `chat.postMessage` accepted a `markdown` block plus a line
  chart (3 series × 16 points) and a bar chart (3 × 9); the blocks read back
  intact.
- Live (T5): pending.

## Rollout

Pending.

## Open items

- [ ] Live check in the deployment's test channel after rollout.
