# GitLab project path hints

Status: Human review

## Summary

In replays of 75 real support threads, GitLab reads often failed because the
model used a project path without its top-level group (`team/app` instead of
`top/team/app`) or the path of a moved project: `search` failed 9 times,
`get_merge_request` 8, `get_repository_file` 7 and `clone_repository` 13,
each with `not_found`. Every failure costs a model step, and a run has few.

A wrong or partial project path must be recoverable in one step, on any
GitLab instance, without new egress, credentials, caching or settings.

## Decisions and approach

- GitLab answers a request whose project it cannot find with
  `{"message":"404 Project Not Found"}`; a missing file, merge request or
  other item inside a found project has a different message. The
  normalization now reports that case as "GitLab project was not found" and
  every other 404 as before.
- On that answer, `hintProjectPaths` (`gitlab-rest-adapter.ts`) runs one
  `list_projects` read for the last path segment (membership-scoped, as
  `list_projects` already is; one page of 100) and appends to the
  `not_found` text the reachable projects with exactly that last segment, a
  full-path match (`…/team/app` for `team/app`) first, at most five. When
  none matches it says so and points at `list_projects`. A numeric project
  ID gets no hint. A failed or refused lookup leaves the result unchanged.
- A hint, not silent resolution: several projects can share a name, and the
  model picks the path with the thread context in view. The next call with
  the full path succeeds, so recovery takes one step.
- The lookup runs in the agent through the existing typed `list_projects`
  operation and the tool runtime's `/gitlab` route. The runtime, its
  contract (v6), the host pin and the credential boundary are unchanged.
- Wired into the read tools (`application/bindings/read-services.ts`) and
  `clone_repository` (`domain/publication/checkouts.ts`).
- The `projectArg` schema description now asks for the full path from the
  top-level group.
- YAGNI review: dropped the "project appears in the listing, so no hint"
  check (GitLab resolves paths case-insensitively, so that case needs an
  unusual permission state, and its only cost is one repeated path) and the
  same rewording of `PROJECT_NOTE` in every tool description (the schema
  description carries it). Kept: the full-path-first order (keeps the right
  path inside the cap), the numeric-ID guard, the zero-match sentence, the
  overflow marker and the lookup's failure guard.

## Work

- [x] Unit tests with fixture GitLab answers (`gitlab-operations.test.ts`)
- [x] Read tool end to end through the runtime handler (`cli-runtime.test.ts`)
- [x] `clone_repository` message (`checkouts.test.ts`)
- [x] Implementation and catalog description

## Verification

- Deterministic, branch `fix/gitlab-project-paths`:
  - T0 (`typecheck:all`, `lint`, `format:check`): pass on Windows.
  - T1 and T2 in `node:26.13.1-bookworm` (amd64), on the branch (`ecb3a37`) and
    `origin/main` (`8815054`): pass on both. T1 agent package 690 tests on the
    branch against 686 on main (the four new ones); every other package and
    T2 (135 tests) are the same on both.
  - T3 `tools`: **Blocked**. Not run for this change by operator instruction;
    the tool runtime and its contract are unchanged.
- Live: **Blocked**. T5 needs the designated test instance, which another
  session holds.

## Rollout

Agent-only change; the tool runtime is unchanged. Deploy with the next agent
release.

## Open items

- [ ] T3 `tools` on a Docker host with the branch images
- [ ] T5 GitLab read scenario with a partial project path on the test instance
