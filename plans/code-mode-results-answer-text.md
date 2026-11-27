# Code Mode read results and answer text

Status: In progress

## Summary

Two follow-ups from the live check of
[cloudflare-graphql-step-limit.md](cloudflare-graphql-step-limit.md).

- **Code Mode reads came back in the model-facing shape.** A script's
  `external_cloudflare_get` call returned `{ result: { ok, output,
operationId, data }, content: [{ type: 'text', text }] }`: the same response
  three times, `output` as a JSON string, and no stated shape. In both runs of
  the same traffic question the model spent 4 to 5 of its steps unwrapping
  it, and an unpaged `/zones` listing exceeded the 48 kB script output limit.
- **Narration was glued onto the answer.** The delivered text is
  `output.text`, the text of every step joined without a separator. A
  sentence the model wrote before a tool call ("Too slow sequentially; I'll
  parallelize.") ran into the first sentence of the answer.

## Decisions and approach

- **One compact read result for scripts.** The Code Mode transport maps each
  read reply to `{ ok: true, data }` (the adapter's `data`, or the parsed
  `output`) or to `{ ok, output }` for non-JSON text and failed reads. The
  tool description states the shape. GitLab passes its `warnings` (a full
  page, a truncated collection) as `warnings`, so a script does not take a
  partial list as complete. A refused read still rejects, and the description
  says so. A value without the reply shape passes through unchanged. Direct
  tool calls keep their model output.
- **Deliver the final step's text.** `runNativeSegment` returns the last
  step's text, and the joined text only when the last step has none.
  Tradeoff: an answer written in a step that also called a tool, followed by
  a final step with more text, loses the earlier part. That pattern did not
  appear in the runs read for this change; narration before tool calls did.

## Work

- [x] `codeModeReadResult` in the Code Mode transport, the shape in the tool
      description and in [code-mode.md](../docs/code-mode.md); scripts in
      tests and the image fixture use it.
- [x] `runNativeSegment` delivers the final step's text.
- [x] Second opinion (GPT-6.2 Sol, read-only): no blockers; GitLab paging
      warnings and the rejection note came from it.

## Verification

- Deterministic: the new tests fail without the source changes (the script
  sees the reply shape; the answer reads "Too slow; I will
  parallelize.Traffic is up 9% on yesterday.") and pass with them. T0 passes
  on Windows. T1 and T2 pass in a Linux container (agent 697 of 697). T3
  `application` passed (75 records) before the rebase onto `a9f17db`, with
  `inputs-corrections` left out: it fails on `main` already (stale 200 KB
  fixture). T3 `coding` and `tools`: BLOCKED on this machine (the image
  suites call `process.getuid`).
- Live: pending. The deployment check repeats the traffic question.

## Rollout

Merge to `main`, then the deployment repository's digest bump.

## Open items

- [ ] Verification and live check.
