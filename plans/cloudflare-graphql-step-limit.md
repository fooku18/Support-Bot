# Cloudflare GraphQL refusal and last-step answers

Status: In progress

## Summary

A deployment run asked about today's traffic on a page type. It made 12 model
requests, all successful and all tool calls. It then ended without text, and
the requester got the generic failure notice. Two defects caused it.

- **`cloudflare_graphql` refused every query** with `cloudflare_graphql:
unknown argument datasets`. The agent validates the call with
  `validateCloudflareGraphql` and sends the result to the tool runtime as
  `request`. The runtime validates it again
  (`cloudflare-api-provider.ts`), and the strict argument check accepts only
  `query` and `variables`. The validated result also carried `datasets`, an
  evidence field that nothing reads. Each side's unit tests passed because
  they never fed one side's output to the other. `cloudflare_get` was not
  affected: its validated shape has only accepted keys.
- **A run that used up `maxSteps` ended on a tool call.** The deployment runs
  with 12 steps. When every step calls a tool, no text is retained, and the
  delivery sends "No confirmed answer…", which names neither the cause nor
  what the run found.

## Decisions and approach

- **Remove `datasets`** from `ValidatedCloudflareGraphql`, along with the
  walker state that only fed it. The validated request then has the shape the
  runtime accepts. Stripping it at the call site would keep dead code and the
  same trap for the next caller. The security checks (one read operation,
  zone and account scope) are unchanged.
- **Answer on the last step.** An input processor sets `toolChoice: 'none'`
  on step `maxSteps - 1` and adds a system note to answer from what was
  found and to name what could not be checked. The run then ends with an
  answer instead of the failure notice. The changed system prompt and
  `tool_choice` miss the prompt cache on that one request, which is
  accepted.
- **One step limit.** The processor uses the configured `maxSteps`. Mastra
  honors a per-call `maxSteps` instead, so the two must match. Slack runs
  pass the same `limits.maxSteps` as the runtime configuration, and Studio
  refuses a different value. A cold resume keeps the step count (the OpenAI
  resume test asserts the resumed last step has `tool_choice: none`).

## Work

- [x] Remove `datasets` from the Cloudflare GraphQL validator; round-trip
      test: the runtime accepts the agent's validated request.
- [x] `answer-on-last-step` input processor in
      `apps/agent/src/mastra/agents/shared.ts`; test with a model that always
      calls a tool, and on a cold resume.
- [x] Second opinion (GPT-6.2 Sol, read-only): no blockers; the step-limit
      invariant and the cache note above came from it.

## Verification

- Deterministic: both new tests fail on `dcb297b` (`unknown argument
datasets`; last request `tool_choice` `auto`) and pass with the change.
  T0–T2 and T3 `application` and `tools`: pending.
- Live: pending. The deployment check repeats the traffic question in the
  test channel. T5 is not run (no gateway test instance for these tools).

## Rollout

Merge to `main`, then the deployment repository's digest bump.

## Open items

- [ ] Record T0–T3 results.
- [ ] Live check after deployment.
