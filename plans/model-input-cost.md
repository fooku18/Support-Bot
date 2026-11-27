# Model input cost

Status: In progress

## Summary

About 99% of the answer agent's model cost is input tokens. Two causes:

1. **Each read-tool result with structured data reaches the model three times.** The bindings in
   `apps/agent/src/application/bindings/read-services.ts` return `output` (text) and `data` (the same records parsed).
   The shared catalog (`apps/agent/src/integrations/tools/service-catalog.ts`) wraps that as
   `{ result, content: [{ type: 'text', text }] }` and the Mastra read tool returned the whole envelope. The durable
   agent sent it as a JSON tool output, and `@ai-sdk/anthropic` stringified it into `tool_result.content`: every record
   once as data and twice as JSON-escaped text. One 36.7 KB GitLab search became 114 KB in a real replay.
2. **No prompt caching.** Nothing set `cache_control`, so every step resent the system prompt, tools and history at
   the full input price. The production gateway caches with both block-level and request-level
   `cache_control: { type: 'ephemeral' }`, and nothing without it.

Scope: send one copy of each read result to the model, and turn on prompt caching for the `anthropic` route. No
truncation or summarisation.

## Decisions and approach

- **One copy, chosen at the Mastra tool.** `createReadServiceTools` sets `toModelOutput` on every read tool
  (`apps/agent/src/mastra/tools/read-services.ts:73`) and returns the reply's text (`content[].text`) as a `text` model
  output. `execute` still returns the full `{ result, content }` envelope.
  - Why not at the source: Code Mode scripts call the same tools through `external_*` and read
    `.result.data` and `.result.ok` (`apps/agent/test/runtime/code-mode.test.ts`). Code Mode calls `execute` and never
    `toModelOutput`, so it keeps the structured result. Dropping `data` or `content` in the bindings or the catalog
    would break those scripts or the text the model reads.
  - The durable runtime stores the mapped output in `providerMetadata.mastra.modelOutput`, so the single copy also
    holds when memory replays the call on a later turn (tested).
  - Failures: a thrown read is still a tool error, and `toModelOutput` does not run for it. An `ok: false` reply
    reaches the model as its `failed (...)` text, as before, without the envelope.
  - Invalid arguments: Mastra returns its validation result (`{ error: true, validationErrors }`) instead of throwing,
    and the durable runtime maps it like a reply. Anything without a `content` array keeps the previous JSON output,
    so the model still sees the validation message and the run does not fail on the mapping (tested).
  - GitLab text: `renderGitlabResultText` pretty-printed the bounded data and cut it at 60,000 characters again, so a
    result that fit the bound as compact JSON could lose its last records without a marker. The model used to get all
    records through `data` as well. It now renders compact JSON (also fewer tokens) and marks a cut text as truncated
    (tested with 100 issues).
  - History recorded before this change is not projected again; it keeps its old envelope until it ages out.
- **Request-level prompt caching for the `anthropic` route.** `nativeAgentConfiguration` adds
  `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` to `defaultOptions` when the selected route
  is `anthropic` (`apps/agent/src/mastra/agents/shared.ts:127`). `@ai-sdk/anthropic` 4.0.107 emits it as the request's
  top-level `cache_control` (`anthropic-language-model.ts:1026`).
  - Studio: the attribution processor spreads the existing provider options and adds `supportAgent`, and `runBinding`
    strips only `supportAgent`, so `anthropic` survives (tested).
  - Other routes are unchanged: `openai` and `vertex-gemini` get no option. `vertex-claude` is left out on purpose.
    The Vertex Anthropic model also reads the canonical `anthropic` key and would send the top-level field, and it is
    not verified that Vertex accepts request-level `cache_control`. Block-level caching for Vertex Claude is a
    possible follow-up.
  - `search_tools` with `autoLoad` adds the top three matches to the request's tool list after a discovery. Tools come
    first in the cached prefix, so the next step writes a new cache instead of reading the old one, once per discovery.
    In the test fixture request 1 sends `search_tools, ask_user` and requests 2 and 3 send
    `search_tools, ask_user, search, searchJiraIssuesUsingJql, list_branches`.

## Work

- [x] `toModelOutput` on the read tools (`apps/agent/src/mastra/tools/read-services.ts`).
- [x] Request-level `cacheControl` for the `anthropic` route (`apps/agent/src/mastra/agents/shared.ts`).
- [x] Regression tests in `apps/agent/test/runtime/model-input.test.ts`: real durable agent and Anthropic adapter
      against a fake SSE server that records request bodies. The fake model calls `search_tools`, then the read, then
      answers. All six fail without the change.
  - GitLab `search` and Jira `searchJiraIssuesUsingJql` (a `reply()`-style result): the `tool_result` is exactly the
    service text with one copy of a marker record. Before: 12,162 bytes for a 3,703-byte GitLab text and 12,137 bytes
    for a 3,700-byte Jira text (3.3x). After: 3,703 and 3,700.
  - The same result replayed from memory on a follow-up turn is still one copy.
  - An `ok: false` read reaches the model as its failure text.
  - Every request carries `cache_control: { type: 'ephemeral' }`, with and without the Studio run binding, and no
    `supportAgent` option leaks into the body.
- [x] Review fixes (Astra review of `92bca50`): invalid arguments reach the model as the validation message
      (`model-input.test.ts`), and GitLab renders compact JSON with a marker when cut (`gitlab-operations.test.ts`).
      Both tests fail on `92bca50`.
- [ ] T3 `application` suite.
- [ ] T5 gateway acceptance on the designated test instance, with cache read tokens checked in usage.

## Verification

- Deterministic (Windows 11, node 26.13.1, revision `92bca50`): T0 `npm run typecheck:all`, `npm run lint` and
  `npm run format:check` pass. T1 `npm run test:packages`: 61 of 667 agent tests fail, and the other workspaces pass.
  T2 `npm test`: 31 of 122 fail. The same set fails with the two source files reverted to `03ec828`. The only
  difference is that the six new tests fail there too. The failures are environment-specific: Windows `fsync` EPERM
  and symlink handling in the publication and checkout tests, `C:\C:\` path doubling and bash exit 127 in the script
  tests, and Docker in the deployment tests. A Linux run is still needed for a clean T1/T2 record.
- Linux (node:26.13.1-bookworm container, clean `npm ci`, with the review fixes): T0 `typecheck:all` passes, T1
  `test:packages` passes in every workspace (agent 669 of 669), T2 `npm test` 134 of 135. The one failure is
  `agent-config.test.ts` "exposes every shared skill to Claude through a relative directory link", which fails the same
  way without this change (the skill links do not survive the copy into the container).
- Live: BLOCKED. T3 and T5 were not run: the shared test instance is locked by another session, and this change
  touches inference, which needs a T5 gateway run before release.
- Evidence: none retained yet.

## Rollout

Normal merge and deploy. No configuration or data migration. Watch cache read and write tokens in the first
deployed runs.

## Open items

- [ ] T3 and T5 runs, as above.
- [ ] Decide whether Vertex Claude gets block-level caching.
