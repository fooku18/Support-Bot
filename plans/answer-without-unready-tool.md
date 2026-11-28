# Answer without an unready tool

Status: Done

## Summary

The agent asks the CLI runtime's `/readyz` before each segment and checks
every assigned runtime tool (GitLab, Atlassian, Datadog, Cloudflare, Slack)
against it. Until now any failure refused the run before inference: a runtime
restart, a sync error, an instance not yet synced or a credential version the
runtime has not picked up yet failed every answer in the channel, tool-free
questions included. [bug-hunt-2026-11.md](bug-hunt-2026-11.md) finding 9
narrowed this to channels with a runtime tool and left the rest as an owner
decision. The operator chose (2026-11-28): answer without the unready tool,
log it, and let the answer say the tool was unavailable when the question
needed it. No retries, no new settings.

## Decisions and approach

- `nativeReadServices` qualifies each tool on its own. A failed `/readyz`
  fetch or a reported `syncError` leaves out every assigned runtime tool;
  a failed instance check leaves out only that tool. GitLab is gated like
  the others (`catalog.gitlab` and the `gitlab` service need the qualified
  binding).
- The binding returns the left-out tools with the check's message (at most
  200 characters, already sanitized by the runtime). The agent service logs
  each one as `native tool left out run_id=… tool=<kind> reason=…`.
- The model is told through a per-step system message from an input
  processor (`unavailable-tools` in `mastra/agents/shared.ts`): "These
  assigned tools are unavailable in this run: GitLab. If the request needs
  one of them, say that it is temporarily unavailable…". Not in the
  instructions: Mastra restores saved instructions on cold resume, so a
  readiness note there would outlive the outage. The message is the same on
  every step of a segment, so prompt caching within the run is unchanged.
- Why the bug hunt's first version (`570e397`, never merged) was dropped:
  T3 `application` failed only because
  `malformed-bound-readiness-refuses-before-inference` pinned the refusal as
  intended behaviour; the code itself had no defect. That version also gave
  the model no hint and logged nothing. This change adds both and updates
  the scenario instead of deleting it.
- Not ready is not the same as not allowed. Assignment and revocation come
  from the admin settings, not from readiness: an unassigned or disabled
  tool is absent from the profile, and `guard()` refuses a tool whose
  current assignment no longer matches the run's pin at every call
  (`service_binding_revoked`). Dropping a tool only ever removes capability.
  The execution policy hash is computed from the settings, so a dropped
  tool does not change it and a later segment with the tool ready again
  resumes normally. Mastra skips a loaded tool name that is missing from
  the catalog, so a follow-up whose context loaded the tool still runs.
- The coding path's GitLab binding (`bindings/coding.ts`) runs its own
  readiness check and still refuses; it is not deployed on Kubernetes.

## Work

- [x] Tests that fail on `main` first: three binding tests
      (`read-services-readiness.test.ts`: runtime 503, one tool not served,
      sync error) and the model note (`last-step.test.ts`).
- [x] Qualify each tool on its own, return and log the left-out tools,
      tell the model.
- [x] T3 scenario renamed to `malformed-bound-readiness-answers-without-the-tool`:
      the run answers after search → answer, GitLab is not offered, no
      service call, the system message names GitLab, one
      `native tool left out … tool=gitlab` warning.
- [x] `docs/native-answer.md`: tool readiness under settings and
      authorization changes.

## Verification

- Deterministic:
  - New tests failed on `main` `73fb4dc` (4 failed) and pass with the change.
  - T0: `typecheck:all`, `lint`, `knip`, `format:check` pass.
  - T1 and T2, Linux (`node:26.13.1-bookworm` container, `scripts/test-linux.ps1`
    in lumi): admin 142 and 1 skipped, agent 721, egress 31, model-stub 19,
    slack 212, root 135, all pass.
  - T3 `application`: 82 records pass, including
    `malformed-bound-readiness-answers-without-the-tool` (2 provider calls,
    0 service calls) and both `current-assignment-revoked-at-*` scenarios.
  - T3 `tools` (`cli-runtime` and `egress` images built from this branch):
    19 records pass.
- Live: T5 BLOCKED (inference path; the designated test instance has no
  gateway key with budget). T4 not run: the shared test instance was locked
  by another session, and the change touches neither the stack nor settings.
  Staging, #test-1234, 2026-11-27 23:59:57 UTC, image `6c8828b`: a top-level
  question about merge requests merged today in the deployment project was
  answered in 18 s from a GitLab read (it named !24), with no
  `native tool left out` line in the agent log for the three runs after the
  deploy. The unready case itself was not reproduced live: making a tool
  unready on staging needs an admin write. It is covered by the binding
  tests and T3 only.

## Rollout

No stored data, policy hash or compiled document changes. Follow the
deployment repository's rollout runbook with a drained deploy.

Merged as `f4e200a` (#45). Deployed to staging together with #43 (`6c8828b`)
through deployment MR !24 (merge `7bd5e5fd`, 2026-11-27 23:55 UTC, pods up
23:57 UTC, image `ghcr.io/fooku18/support-bot:main@sha256:cca1e7dc…`). Rollback:
pin the previous digest `sha256:17a7d175…` (upstream `4eca9d8`).

Behaviour operators can see: a channel with a runtime tool answers while
that tool, or the whole tool runtime, is unready, and says the tool is
unavailable when the question needs it; the agent log shows
`native tool left out`.

## Open items

- [ ] T5 gateway suite.
