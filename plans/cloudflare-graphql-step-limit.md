# Cloudflare GraphQL refusal and last-step answers

Status: Done

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

- Deterministic, on Windows 11 with Node 26.13.1:
  - Both new tests fail on `dcb297b` (`unknown argument datasets`; last
    request `tool_choice` `auto`) and pass with the change.
  - T0 (typecheck, lint, format) passes. T1 `test:packages`: 56 agent tests
    fail in `domain/publication/*` and `application/inspection.test.ts`,
    the same files that fail on unmodified `dcb297b` on Windows (symlinks,
    Git transport, a Windows module path); `code-mode.test.ts` failed once
    on timing under load and passes alone. Every other package passes.
    T2 passes.
  - T3 `application`: passed, 75 records, with the `inputs-corrections`
    phase left out by a local edit. That phase fails on `main` already: its
    200 KB tripwire fixture now fits the 64,000-token budget.
  - T3 `tools`: BLOCKED. The driver calls `process.getuid`, which Windows
    lacks, and this machine has no Linux Docker host. The round-trip unit
    test runs the same `validateCloudflareRequest` the tool runtime uses.
- Live, 2026-11-27 16:15 UTC on the deployment (upstream `97efb3c`): the
  same traffic question in the test channel was answered in 107 s from
  Cloudflare GraphQL counts for nine zones, 10 model requests, all
  successful. The run finished in 10 of 12 steps, so the last-step path was
  not exercised live; the tests above cover it. T5 is not run (no gateway
  test instance for these tools).
- Seen in the same run and left for follow-up: the text of a tool-calling
  step is joined to the answer without a separator, and Code Mode reads
  return nested JSON strings that cost the model several steps to unwrap.

## Rollout

Merged as `97efb3c` (#25) and deployed together with #24 and #13 by
deployment MR !16 (`f4537ba9`, 2026-11-27 15:57 UTC; pipeline 2842177).
Rollback: pin the previous image digest `sha256:0d599f40…` (upstream
`8815054`) in the deployment repository.

## Open items

- [ ] T3 `tools` on a Linux Docker host.
