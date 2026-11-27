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
  tool description states the shape. A value without the reply shape passes
  through unchanged. Direct tool calls keep their model output.
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

## Verification

- Deterministic: pending.
- Live: pending. The deployment check repeats the traffic question.

## Rollout

Merge to `main`, then the deployment repository's digest bump.

## Open items

- [ ] Verification and live check.
