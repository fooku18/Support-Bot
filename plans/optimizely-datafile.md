# Optimizely datafile read tool

Status: Done

## Summary

Support threads ask about Optimizely flags and A/B tests: is a flag rolled out
and where, which split, which variable values, which audience, is a test still
running, why the SDK logs "Feature key X is not in datafile". A survey of 66
such requests in one deployment's feedback channels (2026-05 to 2026-11) found
40 answerable from the Optimizely SDK **datafile** alone or with a code read,
9 needing the Optimizely REST API (results, metrics, change history) and 17
needing something else.

The datafile is the public JSON the SDKs download from
`https://cdn.optimizely.com/datafiles/<sdkKey>.json`. Per project environment it
holds every flag, its variables, its delivery rules in order with audiences and
traffic, the running experiments with variations and variable values, audiences
with conditions, events and attributes. It needs no credential.

Before this change the agent could read it only through `web_fetch`, which hands
a 390 KB JSON file to a second model. That worked in four live checks, but every
answer had to warn that the numbers came from a summary, questions across all
flags did not fit one page question, and Optimizely answers depended on the
general web reader being assigned.

Goal: a read-only `optimizely` tool kind that parses the configured datafiles in
the agent and returns exact, compact answers. Out of scope: the REST API (a
later extension of the same kind with an optional credential), deciding the
variation of a user ID (bucketing), any write.

## Decisions and approach

Reviewed by Sol (GPT-6.2 Sol) and Kimi (K3.1 Pro) on 2026-11-28; both "go with
changes". Their must-fix items are folded in below; disagreements are decided by
the request survey.

### Kind and settings

- New kind `optimizely`, title "Optimizely", policy code `op`. Not a credential,
  cli-runtime, web-runtime or MCP kind, no host. Ready when enabled (no probe),
  like `webFetch` and `codeMode`. Role generation is generic; no store migration.
- Settings: `datafiles`, 1 to 10 `{ name, sdkKey }` entries. `name` is what
  people call the project ("Shop", "Native app"), 1 to 64 printable characters;
  `sdkKey` matches `^[A-Za-z0-9]{10,64}$` and is unique. Environment and project
  ID come from the datafile itself. A channel can hold only one instance of a
  kind, so one instance lists every project environment. Keys live in the admin
  settings, never in code.
- Admin form: one textarea, `name sdkKey` per line (the key is the last word).
  The compiled assigned tool, the DTO and the assignment parser carry
  `datafiles`.

### Where it runs

In the agent process, through the native read services, like `web_fetch`'s
reader. SDK keys are not secrets, so the credential-owning cli-runtime adds
nothing. The agent's global `fetch` already goes through `EGRESS_PROXY_URL`.
The egress proxy admits the fixed host `cdn.optimizely.com` from the tools
network (agent and cli-runtime), like Slack's fixed hosts, so no env variable
and no env-parity change is needed. The staging Kubernetes agent pod reaches it
directly (HEAD 200, 2026-11-28).

Fetch: `GET https://cdn.optimizely.com/datafiles/<sdkKey>.json` for configured
keys only, `redirect: 'error'`, 10 s deadline (the fetch is shared between concurrent callers and not
canceled with one caller's run; each caller stops waiting when its run is canceled),
streaming 5 MB cap, JSON with `version` `"4"` and the arrays the summaries read.
Fresh-only cache per key for 5 minutes (the SDKs' polling interval); no stale
fallback, because "is it running now?" must not be answered from an old copy.
A datafile that fails is named in the answer as unavailable; the others still
answer.

### Model-facing tool

One tool, `optimizely_lookup({ query })`, in Code Mode as
`external_optimizely_lookup` through the same guarded read catalog:

- An exact flag key, rule key, rule ID or variation ID returns each matching flag
  per datafile: variables with type and default; rules in evaluation order
  (experiments by `experimentIds`, resolved against top-level and grouped
  experiments, then the rollout's delivery rules, the last labelled "everyone
  else"); per rule the audience logic (`audienceConditions`, else `audienceIds`)
  with audience names, each audience's conditions (typed audiences take
  precedence, legacy conditions are JSON text), the traffic per variation from
  successive `endOfRange` deltas, the allocated share, variations with
  `featureEnabled` and variable overrides by variable key, and the number of
  whitelisted users. The answer names the datafiles without the flag.
- Any other text is a case-insensitive substring search over experiment, flag,
  delivery rule, audience and event keys (50 matches, total count).
  Experiments come first with their status, running ones first, so "which
  tests are running for X" survives the cap. No hit returns a note that
  a missing key is usually archived or deleted, and that the datafile cannot
  tell which or when.
- An empty query lists the datafiles (name, environment, project ID, revision,
  counts).

Output is JSON, at most 48 KB (extra flags are dropped with a note), variable
values capped at 2,000 characters. Whitelisted user IDs are never returned and
condition values of user ID and e-mail attributes are hidden. The description
says what the datafile lacks and that a disabled variation gets the defaults.

### Review decisions

| Topic            | Sol                                        | Kimi                                    | Decision                                                         |
| ---------------- | ------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------- |
| Tools            | one exact lookup                           | one query tool                          | One `optimizely_lookup`                                          |
| Names per key    | drop                                       | keep                                    | Keep: a project ID means nothing to the model                    |
| Substring search | drop                                       | keep keys, drop similar-key suggestions | Keep search, no fuzzy suggestions: people rarely give exact keys |
| Events           | drop                                       | drop                                    | Keep in search: 3 of the 40 requests ask about event keys        |
| Cache            | start uncached                             | 5 min                                   | 5 min fresh-only; Code Mode can call 50 times                    |
| Stale fallback   | drop                                       | drop                                    | Dropped                                                          |
| Conditions       | names only                                 | resolve                                 | Names plus readable conditions, personal values hidden           |
| Egress           | forward `SUPPORT_AGENT_EGRESS_EXTRA_HOSTS` | same                                    | Fixed host in the tools set instead: no env-parity churn         |

### Rejected alternatives

- `web_fetch` plus a prompt (live since 2026-11-27): lossy, cannot search,
  depends on the web reader, and a channel prompt replaces the workspace prompt.
- A cli-runtime kind: runtime protocol, readiness probe and an allowlist
  variable for a credential-free public read.
- `@optimizely/optimizely-sdk`: only needed for bucketing, out of scope.

## Work

- [x] Contracts (`tool-kinds.ts`, `dto.ts`), generated admin and Slack mirrors.
- [x] Admin: form field and parsing, compile `datafiles`; tests.
- [x] Agent: `integrations/optimizely/datafile.ts`, tool profile, service catalog,
      read-service binding, Mastra allowlist, discovery, assignment parser,
      admin-document fields; tests.
- [x] Egress: `cdn.optimizely.com` in the tools set; test.
- [x] Docs: `docs/optimizely.md`, `docs/authorization.md`,
      `docs/kubernetes-runtime.md`.

## Verification

- Deterministic (rebased on `main` after #41): T0 typecheck, lint and
  format pass; knip reports only `bootstrap/upgrade.ts` from #41. T1 and T2
  pass on Linux; T3 `application` (82 records,
  `artifacts/native/application/b73ef2ee`) and T3 `tools` (19 records,
  `artifacts/native/tools/2586dc26`) pass. T4 stub suite: 7 of 8 pass
  (`suite-a3672d82`); `stub-cancel-control-stops-a-held-run` fails with
  `expected_answer_fact_missing`, as on every `main` revision since
  2026-11-27 evening, including #41's own run.
- Live (staging, deployment `0c0722b1` = upstream `8a7a85d`, tool in
  #test-1234 only, 2026-11-28 06:03 UTC): "is `mp_enable_one_webview`
  rolled out in the native app in production" answered correctly in 24 s
  (both platform rules at 100 % `on`, audiences resolved, everyone else
  `off`). "Which running shop tests have pdp in their key" found three of
  the four in 72 s and missed `ed_pdp__test_route_to_block_enable`: the
  search ranked 167 flag hits ahead of the experiments and cut at 50, so the
  model fell back to `web_fetch`. Fixed by listing experiments first.
  The deployment's workspace prompt still points at `web_fetch` for the
  datafile URLs, which is why the model reached for it first.
- Evidence: Slack threads `1795845832.143459` and `1795845873.201879` in
  #test-1234.

## Rollout

Merge to `main`; the deployment bumps the image digest. Then create one
`optimizely` instance in the admin with the deployment's datafiles and assign it
to the test channel first. No database migration, no new secret.

## Open items

- [ ] REST extension (results, metrics, change history) with an optional token.
- [ ] Bucketing ("which variation does user X get").
