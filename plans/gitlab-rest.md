# GitLab tool over REST

Status: Human review

## Summary

The tool runtime ran GitLab operations through `glab` inside a bubblewrap
sandbox. That needed a root container with `SYS_ADMIN` and unconfined
seccomp/AppArmor, so the unified Kubernetes image could not serve GitLab: the
binary and the sandbox are not in it. GitLab is now reached like Atlassian,
Datadog and Cloudflare: HTTPS from Node.

## Decisions and approach

- The typed operations, their validation and the request builder are
  unchanged. `sendGitlabRequest` replaces `glab api`.
- The token travels only in `PRIVATE-TOKEN` to `https://<instance host>/api/v4/`.
  A URL that parsing would move off that path (e.g. `..`) is refused.
- A read follows at most three redirects, only within the same origin's
  `/api/v4/` (GitLab redirects reads of a renamed project). A write follows none.
- The HTTP status classifies a failure. Before, words anywhere in the output did.
- A 2xx answer whose connection drops is a failure, never data. Bodies, error
  bodies and job traces stay bounded.
- The runtime response carries `httpStatus` and `error` instead of `exitCode`
  and `stderr`; the GitLab contract is v6. Agent and tool runtime must come
  from the same revision.
- Removed: `glab`, the tool sandbox scripts, the CLI manifest, process-group
  supervision and the sandbox proxy variables. The Compose `cli-runtime` runs
  as `node` with all capabilities dropped and default seccomp/AppArmor.
- The coding workspace keeps its own sandbox and privileges.

## Work

- [x] REST transport, readiness probe and runtime handler
- [x] Agent bindings and contract v6
- [x] Dockerfile, Compose, T3 `tools` and documentation

## Verification

- Deterministic, branch `feat/gitlab-rest` on `5750faf`:
  - T0: pass.
  - T1 and T2 in `node:26-bookworm` (arm64): one failure each, `code-mode`
    "enforces the memory limit" and `native-dependencies` "Studio workspace
    deployment". Both fail the same way on `5750faf`.
  - T3 `tools` (arm64): pass, 19 records, with the new unprivileged runtime.
  - `runtime-image.sh` on the unified image (arm64): pass.
  - T3 `application` and `coding`: **Blocked**. No Linux Docker host: PostgreSQL
    did not start on macOS, and the Docker VM disk was full, so
    `native-coding` could not be built.
- Live: **Blocked**. T4 and T5 need the designated test instance.

## Rollout

Deploy agent and tool runtime from the same image. Operators that use the
unified image set `GITLAB_HOSTS` on the tool runtime.

## Open items

- [ ] T3 `application` and `coding` on a Linux Docker host
- [ ] T5 GitLab scenarios (reads and publication) on the test instance
