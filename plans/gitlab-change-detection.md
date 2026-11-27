# GitLab change detection

Status: Human review

## Summary

Incident and feedback threads keep asking "what changed?" (before an alert,
since yesterday, in the last two hours). The GitLab tool cannot answer it:
`list_merge_requests` filters by creation and update time, not by merge time,
there is no commit list, and deployments are not readable. The model ends up
guessing from `updated_at`, which a later comment moves.

Goal: GitLab reads that show what changed in a project in a time window:
commits (optionally on a ref or under a path), merge requests merged in the
window, and deployments to an environment. Build on the GitLab REST tool
([gitlab-rest.md](gitlab-rest.md)): no new credentials, token scopes, settings
or tool kinds. A `read_api` token covers every read here.

Checked against the GitLab the Kubernetes deployment uses (19.6, read-only):
`merged_after` and `merged_before` filter the merge-request list;
`repository/commits` takes `ref_name`, `path`, `since` and `until`;
`deployments` takes `environment`, `status` and `updated_after`/`updated_before`,
and refuses the update window unless `order_by=updated_at`; SPL pipelines
record a deployment per environment (`staging`, `prod`).

## Decisions and approach

1. **`list_commits`** (new read): `GET projects/:id/repository/commits` with
   `ref_name` (`ref`), `path`, `since`, `until`, `page`, `per_page`. Rows:
   `id`, `short_id`, `title`, `author_name`, `committed_date`, `web_url`.
   No `author_email` or `message` in a list (personal data and size);
   `get_commit` has both.
2. **Merge window on `list_merge_requests`**: `merged_after` and
   `merged_before` (RFC 3339). Without `state` they imply `state: merged`
   (the default `opened` with a merge window would always be empty); with
   `state` it must be `merged` or `all`. A merge window does not narrow an
   instance-wide list: that still needs a person, search, label or milestone
   filter.
3. **`list_deployments`** (new read): `GET projects/:id/deployments` with
   `environment` (name), `updated_after`, `updated_before`, always
   `order_by=updated_at&sort=desc` (GitLab requires the order for the window;
   newest first is what "what changed" wants). Rows: `id`, `iid`, `ref`,
   `sha`, `status`, `created_at`, `updated_at`, `environment` (`name`), `user`
   (person fields), and `deployable` reduced to the job's `id`, `status`,
   `finished_at`, `web_url` and its `pipeline` `id`. The full payload carries
   the commit, runner and artifacts; none of it reaches the model. At most 20
   per page: a real row is about 3.9 KB before projection, so 100 rows would
   overrun the tool runtime's 200 000-byte capture and arrive as malformed
   JSON.
4. The GitLab contract stays v6. The change only adds operations and
   arguments, and the tool runtime re-validates every request strictly: an
   older runtime refuses a new operation or argument explicitly, and only
   that read fails.
5. Tool descriptions say which read answers "what changed" so the model picks
   them without a prompt change.
6. A window whose start is later than its end is refused: GitLab would
   answer an empty list, which reads as "nothing changed".
7. A full list page (as many rows as `per_page`) sets `next_page` and warns
   the model to read it before treating the list as complete. This applies
   to every GitLab list.
8. The Mastra GitLab tools use strict input schemas. Before, `z.object`
   stripped unknown keys, so `list_commits({ ref_name })` silently read the
   default branch; now the call is refused and the model sees why.

## YAGNI pass

Run with the `yagni` skill on this plan before building. Cut or deferred,
each with the reason:

- **`list_environments`**: cut. Every deployment row names its environment,
  and `list_deployments` without `environment` shows which ones exist.
- **`list_commits` `author`, `first_parent`, `with_stats`**: cut. The question is
  what changed in a window, not who; `first_parent` matters only for
  merge-heavy histories, and the merged-MR list already gives that view.
- **`order_by: merged_at` on merge requests**: cut. A merge updates `updated_at`,
  so the default order is close enough inside a merge window.
- **`finished_after`/`finished_before` on deployments**: cut. GitLab ties them
  to `status=success` and `order_by=finished_at`; the update window covers
  every status, including failed and canceled deployments, which incident
  threads also need.
- **Group-wide commits or deployments**: cut. GitLab has no group endpoint for
  either; the model names a project (from `list_projects` or the thread).
- **`status` and `sort` on `list_deployments`**: cut. Rows carry the status,
  and a bounded window wants newest first.
- **Contract v7**: cut (decision 4). A bump would turn a mismatched runtime
  into a failure of every GitLab read instead of the new ones.
- **New T3 `tools` cases**: cut. The tool runtime has no per-operation code
  (`apps/tool-runtime/src/main.ts`), so T1 proves the requests and rows and
  the existing T3 `tools` suite proves the runtime and egress path.
- **Datadog**: `docs/datadog.md` lists Events (`events_read`) in the read
  catalog behind `datadog_call`, so change events need no code when the
  token has that scope.
- **A combined "changes since" tool**: cut. Three plain reads compose in Code
  Mode or in two to three model steps; a fan-out tool would need its own
  bounds and error model.

## Work

- [x] `list_commits`: validation, request, row fields, catalog schema
- [x] Merge window on `list_merge_requests`
- [x] `list_deployments`: validation, request, row fields, catalog schema
- [x] Full-page hint, strict GitLab tool schemas (review)
- [x] `docs/gitlab.md`
- [x] T0–T2, T3 `tools` with images built from this branch

## Review

Astra (`openai/gpt-6.2-astra`, effort high, read-only) reviewed
`origin/main...HEAD`. Its findings and what was done:

1. Mastra's `z.object` strips unknown keys, so a misspelled filter widened a
   read. **Fixed** (decision 8), with a test through the model tool.
2. A full page looked complete. **Fixed** (decision 7).
3. A 100-row deployment page overruns the raw capture bound. **Fixed** by
   bounding the page to 20 (decision 3). A clearer error for a cut capture
   applies to every operation and is left out.
4. A window reversed by less than a millisecond passes the check. **Not
   fixed**: such a window is empty either way, and comparing nanoseconds
   would add code for no answer the model can get wrong.
5. The plan let a staging check stand in for live acceptance. **Fixed**:
   live acceptance stays Blocked until a gateway run; a post-deploy check is
   recorded separately.
6. The deployment description implied every row went live. **Fixed**: only a
   `success` row did, at `deployable.finished_at`.
7. The runner test fake ignores `merged_after`. **Not fixed**: no test sends a
   merge window to it; the request and validation are proven in
   `gitlab-operations.test.ts`.

It found nothing in URL construction or encoding, e-mail or job-data
exposure, runner/runtime re-validation, or operation lists in Code Mode, tool
profiles and readiness, and judged keeping contract v6 safe.

## Verification

- Deterministic, branch `feat/gitlab-change-detection` on `d6b0bce`, rebased onto `6c96ae6` (code
  identical to the merged commit; later edits touch only this plan), Windows
  11 with Node 26.13.1 and Docker Desktop:
  - T0: pass (`typecheck:all`, `lint`, `format:check`).
  - T1: `gitlab-operations.test.ts` 42 of 42. The agent package has 55
    failures, the same count as `main` on Windows: 54 publication tests
    (`EPERM` on `fsync`, `EINVAL` on `readlink`) and one inspection subprocess
    test. Every other package passes.
  - T2: 31 failures, the same count as `main` on Windows (backup, docker-gc,
    agent config, native deployment, native dependencies, native live).
  - T3 `tools`: pass, 19 records, 21 s, with `cli-runtime` and `egress`
    images built from `d6b0bce`. The runner needs a POSIX host
    (`process.getuid`, host paths bind-mounted at the same path), so it ran in
    a `node:26.13.1-bookworm` container with the Docker socket and a
    `git archive` export mounted at Docker Desktop's VM path for `C:`.
  - T3 `application` and `coding`: not required for this change (no agent,
    storage, policy or Slack change); not run.
- Live: **Blocked**. The shared local test instance is held by another
  session and its gateway budget is spent, so T4 and T5 cannot run. Live
  acceptance needs a gateway run on the designated test instance where the
  model answers "what changed in <project> since <time>" with these reads.
  A check in the deployment's test channel after an approved deploy is
  useful evidence but is not live acceptance.

## Rollout

Agent and tool runtime from the same image, as always. No settings, scope
or credential change. Deploying is a separate, approved step in the deployment
repository.

## Open items

- [ ] T5 on the designated test instance once it is free and has budget.
- [ ] After an approved deploy: ask the bot in the deployment's test channel
      what changed in a project in the last day and compare with GitLab.
