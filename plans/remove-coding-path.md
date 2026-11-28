# Remove the Compose-only coding path

Status: Done

## Summary

The agent could clone a GitLab project into a Mastra Workspace, edit files,
run verification commands in a bubblewrap sandbox, publish a merge request
and upload exported files to Slack. That path ran only in the privileged
Compose stack (`native-coding` image, `NATIVE_CODING_STORE`). The deployed
Kubernetes runtime is answer-only, so none of it served a user there, and it
made the admin show `files` and `localExec` tools as Ready that never worked.
The operator approved removing it (2026-11-28, "YAGNI and release").

What stays: every answer feature staging uses: GitLab, Datadog, Cloudflare,
Slack and Atlassian reads, web search, web fetch, Code Mode, charts,
`ask_user` with buttons, thread context, the reply decider, long answers as
`answer.md`, Studio, the egress proxy and the local Compose test stack.

## Decisions and approach

- Removed, not hidden: `apps/agent/src/domain/publication`, the coding
  binding, Workspace and task tools, file exports and their Slack upload, the
  `/agents/export-receipt` route, the `native-coding` image target and
  `deploy/docker/native-bwrap.sh`, the `coding` T3 suite, the
  `coding-files` and `thread-followup` gateway scenarios, the `files` and
  `localExec` tool kinds and the GitLab write operations (notes, issues,
  merge request edits, job retries, pipelines). The read catalog never
  offered the writes; only the coding binding registered them.
- Fresh stores get four application tables (`tasks`, `requests`, `actions`,
  `deliveries`). Existing stores keep their empty `publications` and
  `exports` tables: the runtime has no DDL rights, nothing reads them, and the
  seal stays `coding-application@2`, so no migration is needed.
- The memory thread identity and the Mastra agent ID `coding` are unchanged,
  so existing threads keep their history. The execution policy hash no longer
  carries a `coding` field and the tool lists change for channels that had
  `files` or `localExec`, so a question pending at the deploy cannot be
  answered; the user asks again. Staging traffic is tiny.
- Stored `files` and `localExec` rows: the admin deletes instances and
  assignments of tool kinds it does not know on startup and audits it as
  `tool.kind.remove`, then recompiles once. Without this the compiler would
  see kinds it no longer has.
- Compose runs the agent, provisioning and telemetry from the unprivileged
  `native-answer` image (no root, no added capabilities, no unconfined
  seccomp or AppArmor, no workspace volume). The agent limits are always
  the answer-only budget from #50 (25 steps, 300 s).
- The `backup` T3 suite now also runs the `answer-only` phase (startup
  refusals included) and the in-image Code Mode check that the `coding`
  suite ran. Code Mode's sandbox probes stay covered in
  `apps/agent/test/runtime/code-mode.test.ts`.
- Follow-up PR: the built-in instructions lose the coding, Workspace,
  export and publication sentences, and the run status line its
  `export_file` label. The live runner's `"mode": "coding"` becomes
  `"mode": "tools"` (a scenario on a channel with tools; each step still
  declares a discovery, search, fetch or question), and its publication and
  export fixtures, checks and read-back go.

## YAGNI review of the other candidates

| Item                                                                                      | Verdict          | Reason                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Egress proxy (`apps/egress`, Compose networks)                                            | Defer            | Compose-only, but it is the test stack's only route out. Removing it changes the shared instance's networks and needs T4. Trigger: the next change to the Compose stack. |
| Admin costs and audit views                                                               | Keep             | Operating staging reads the cost ledger and the audit log (tool secret reads, settings changes).                                                                         |
| Admin realtime views (`/live` WebSocket)                                                  | Defer            | A convenience for one operator. The dependency update (#41) rewrites the same views; revisit after it lands.                                                             |
| Durable run receipts (B35, B72)                                                           | Keep             | The receipts stop a lost or repeated Slack answer after a restart. A simpler model needs a T5 gateway run, which the shared instance cannot give tonight.                |
| Test-only helpers in `apps/agent/src` (`replies.ts`, `protocol.ts`, `release-summary.ts`) | Simplify, own PR | `knip --production` shows exports only tests import.                                                                                                                     |

## Work

- [x] Remove the coding binding, publication, exports, the coding image and the T3 suite.
- [x] Remove the `files` and `localExec` kinds; drop stored rows of unknown kinds on admin start.
- [x] Remove the GitLab write operations.
- [x] Update the docs.

## Verification

- Deterministic: see the pull request for revision and results (T0, T1,
  T2, T3 `discovery`, `application`, `backup`, `telemetry`, `tools`).
- Live: T4 and T5 were blocked for #51 (the shared test instance was
  locked). Staging live check after the deploy instead: 2026-11-28 06:03 UTC
  in #test-1234, GitLab read, line chart and `ask_user` buttons pass.
- Follow-up PR: T0, T1, T2 and the T4 stub suite on the local instance.

## Rollout

Merged as #51 (`37d36b7`) and deployed to staging on 2026-11-28 00:44 UTC.
On first start the admin removed 2 `files`/`localExec` instances and 6
assignments (audit `tool.kind.remove`, config v21 to v22). Rollback: the
previous digest; the removed rows come back only from a backup.

## Open items

None.
