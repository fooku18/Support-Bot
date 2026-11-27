# Support playbook in the built-in instructions

Status: Human review

## Summary

The agent answers feedback, support and incident threads with five generic
paragraphs of instructions and no method. Replays of real resolved threads
under the staging limits (12 steps, 120 s, read tools only) gave few
acceptable answers and harmful ones, mostly in incidents: the red-flag
negative case repeatedly confirmed a checkout drop from Datadog alone while
the monitoring itself was broken.

Goal: a compact, team-neutral support method in the built-in instructions,
so every channel gets it without a channel prompt:

- classify the request (bug, question, data request, incident, routing or
  ownership, FYI) and investigate per type within the run budget;
- mark verified facts and hypotheses, and say what was not checked;
- incidents: never confirm or deny an outage or metric drop from one
  monitoring source, cross-check outside it, say when the monitoring itself
  may be broken, and leave severity to people;
- hand off (who or what to check next) instead of guessing.

Every token is sent on every step, so the text stays short. Channel prompts
still follow it and can refine it.

## Decisions and approach

- `supportPlaybook` (`apps/agent/src/application/instructions.ts`, 1,825
  characters, about 400 tokens) is the last block of the built-in
  instructions. Channel and memory instructions come after it, as before.
- `nativeInstructions` became a function of the run limits and ends with one
  line that states them: "Run budget: at most 12 steps and 120 seconds; each
  model turn with its tool calls is one step, and the last step allows no
  tool calls. Plan your reads to fit." The application and Studio pass the
  limits they execute with (12/120 without a coding store, 40/600 with one).
  Reason: without a channel prompt, 6 of 20 panel runs on `main` reached the
  step limit and returned a working note. #25 (`97efb3c`, merged while this
  branch was open) now forces an answer on the last step. The line was
  reworded to match it; it remains so the model can plan its reads.
- The playbook asks for one `search_tools` query per kind of source. On
  `main` two yellow-flag runs concluded after one search that only GitLab was
  available and asked the requester what to do.
- Iteration after the first panel run: the branch still confirmed the
  red-flag drop by cross-checking two Datadog metrics. The incident paragraph
  now says a monitoring reading shows what the monitor recorded, and that
  metrics, logs and traces from one monitoring system count as one source.
- Out of scope: personal-data redaction and team knowledge (G3) belong in
  channel prompts or later work; this text names no team, system or vendor.

## Work

- [x] `supportPlaybook` and the run-budget line, with unit tests
      (`apps/agent/test/application/instructions.test.ts`)
- [x] Callers pass the run limits (`bootstrap/application.ts`, `application/studio.ts`, two runtime tests)
- [x] Replay panel: `main` and the branch, then one iteration on a subset

## Verification

- Deterministic, head `aa31f2d` (rebased on `97efb3c`):
  - T0 (`typecheck:all`, `lint`, `format:check`): pass on Windows.
  - T1 `test:packages` and T2 `npm test` in `node:26.13.1-bookworm`: pass;
    agent package 703 tests (695 on `97efb3c`, the 8 new ones added), T2 135
    on both. On Windows both show the known environment failures (symlinks,
    bash scripts, Git hooks), also on `main`.
  - T3 `application`: 69 checks pass, then it stops at
    `input-context-tripwire-is-explicit-failure-without-delivery`, the stale
    fixture that fails the same way on `main` (`dcb297b`: 69 pass, same
    failure).
- Live: **BLOCKED.** This changes inference input, so release needs the T5
  gateway suite on the designated test instance; it was not run. The replay
  panel below is an offline quality measurement, not T5 evidence.
- Evidence: replay panel on the local instance through Mastra Studio,
  answer-only (12 steps, 120 s), no channel prompt, `claude-5.5-sonnet`, graded
  by `claude-5.5-sonnet` against the human resolution. Tools: GitLab, Jira,
  Confluence and Datadog of the local replay setup (staging has no
  Jira/Confluence). Runs `sp-main-ao` (`dcb297b`), `sp-branch-ao` (`b4d2b6e`:
  playbook and the first budget wording, on `dcb297b`), `sp-branch2-ao`
  (`fc0e3bd`: plus the incident iteration). Case data stays out of Git.

### Panel, 20 cases, one run each

| Run              | Acceptable (use ≥ 2) | Use 3 | Correct action | Fact recall | Harmful or `mustNot` | Input tokens | Est. cost | Median steps / s | Runs at 12 steps |
| ---------------- | -------------------- | ----- | -------------- | ----------- | -------------------- | ------------ | --------- | ---------------- | ---------------- |
| `main` `dcb297b` | 5                    | 2     | 2              | 12%         | 4                    | 3.65M        | $3.48     | 9 / 37           | 6                |
| branch `b4d2b6e` | 9                    | 3     | 4              | 23%         | 4                    | 4.20M        | $4.00     | 8 / 41           | 2                |

- Became acceptable: adtech, mp-app, payment, pdp-1792654212812799 (on
  `main` cut off at 12 steps; #25 now addresses that part),
  yellow-flag-1794491729200449 (on `main` asked the requester after 4 steps).
  Lost: search-1789033903120109 (2 to 1).
- Harmful only on `main`: copilot-1790658342300369, mp-app, search. Only on
  the branch: engage, pex, red-flag-1780393334395879 (the red-flag negative
  confirmed the Datadog drop; on `main` that run reached the step limit and
  returned only a working note, rated wrong). Both: pdp-1793103442836409.

### Iteration, the 10 incident or harmful cases

Both red-flag and yellow-flag cases plus every case rated harmful in either
full run. Chosen for being bad, so some regression to the mean is expected.

| Run              | Acceptable | Correct action | Fact recall | Harmful    |
| ---------------- | ---------- | -------------- | ----------- | ---------- |
| `main`           | 1          | 0              | 1%          | 4          |
| branch `b4d2b6e` | 2          | 0              | 3%          | 4          |
| branch `fc0e3bd` | 4          | 3              | 24%         | 1 (engage) |

- The red-flag negative is no longer harmful, but it still leads with a
  Datadog dip marked verified and names a metric gap only as one of several
  alternatives. The other red-flag case went to acceptable and correct.
- pdp-1793103442836409 and pex went to the best score, although the incident
  paragraph does not apply to them: that is the run-to-run noise.

### What this cannot show

- One run per configuration. Differences of one or two cases are within
  noise; harmful answers moved between cases from run to run.
- The final head is not panel-measured: it is rebased on `97efb3c` (#25,
  forced answer on the last step) with the budget line reworded, and the
  incident iteration was measured on 10 cases only. A full panel on the final
  head and on `97efb3c` would cost about $9.
- The local tools differ from staging (Jira and Confluence, the user's
  tokens), and the tools can read material written after the thread.
- Gateway spend for all runs and grading: $11.52 (key spend 506.77 to
  518.29; an upper bound, the key is shared).

## Rollout

Merge to `main`, then the usual image digest bump in the deployment
repository. Needs the T5 gateway suite on the designated test instance before
release.

## Open items

- [ ] T5 gateway suite on the designated test instance (BLOCKED).
- [ ] Full panel on the final head against `main` at the same base, ideally twice each, to separate the effect from noise.
