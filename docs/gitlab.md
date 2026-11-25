# Setting up GitLab access

Assign a GitLab instance to channels that should read GitLab or publish
code changes. The coding workspace and the publication tools need a ready
GitLab assignment. Plain answers and other read tools still work without one.

## What the agent can do

The tool runtime sends typed operations to the GitLab REST API over HTTPS. The
model never supplies a URL, host, endpoint or credential. A read follows a
redirect only within the instance host's API (GitLab redirects reads of a
renamed project); a write follows none.

Answers, Code Mode scripts and the coding workspace get the same bounded
results: selected fields, at most 100 items, long texts cut with a marker,
at most 60 000 bytes per result. `get_repository_file` returns the decoded
text of the file, cut at 12 000 characters. A binary file, or a file larger
than 60 000 bytes, comes back without content and with a `content_note`. The
tool runtime decodes the file before it redacts credentials from the result.

| Kind        | Operations                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read        | `get_project`, `list_projects`, `get_issue`, `list_issues`, `get_issue_notes`, `search`, `list_branches`, `list_merge_requests`, `get_merge_request`, `get_merge_request_diffs`, `get_merge_request_commits`, `get_merge_request_notes`, `get_merge_request_pipelines`, `list_pipelines`, `get_pipeline`, `get_pipeline_jobs`, `get_job`, `get_job_trace`, `list_repository_tree`, `get_repository_file`, `get_commit` |
| Write       | `create_merge_request_note`, `create_issue_note`, `create_issue`, `update_merge_request` (close or reopen only), `create_merge_request`, `retry_job`, `create_pipeline`                                                                                                                                                                                                                                                |
| Publication | Clone, verify and publish a branch with one merge request per task (see [Publication](#publication))                                                                                                                                                                                                                                                                                                                   |

Merging, branch or tag deletion, CI variables and project settings are not
part of the contract. Write operations have no approval step: they are
admitted like reads in a channel with a ready GitLab assignment.

**The token is the permission boundary.** An instance has no project
allowlist and no operation list. The agent can read and write every project
the token's user can reach. Scope the token to the projects the channel may
use.

## Checklist

| Setting        | Value                                                              | Where                                |
| -------------- | ------------------------------------------------------------------ | ------------------------------------ |
| Host           | Bare hostname, e.g. `gitlab.example.com`, served on port 443       | Your GitLab URL                      |
| Token          | Group, project or personal access token: `api`, `write_repository` | [Step 1](#1-create-the-token)        |
| Role           | Developer on the projects the bot may change                       | [Step 1](#1-create-the-token)        |
| Commit e-mail  | The token's user returns an e-mail from `GET /user`                | [Step 2](#2-check-the-token-by-hand) |
| `GITLAB_HOSTS` | The host, in the env file (egress allowlist)                       | [Step 4](#4-admit-the-host)          |

## 1. Create the token

Prefer a **group access token** on a group that contains only the projects
the bot may use. A project access token limits the bot to one project. A
personal access token works too, but it inherits everything its user can
see and dies with the account.

1. Open the group (or project) → **Settings → Access tokens → Add new token**.
2. Name it, e.g. `support-agent-gitlab`, and set an expiry. Note the date for
   [rotation](#rotation-and-revocation).
3. Select the role **Developer**. Developer can push branches, open merge
   requests, add notes and retry jobs. Do not select Maintainer or Owner.
4. Select the scopes:
   - `api`: the write operations and merge request creation. `read_api` is
     not enough.
   - `write_repository`: Git push over HTTPS for publication.

   An answer-only deployment (no coding workspace) offers read operations
   only: `read_api` and the role Reporter are enough.

5. Create the token and copy it immediately; GitLab shows it once.

Never use a CI job token. The runtime refuses `GITLAB_HOST` and
`GITLAB_TOKEN` in its environment; the credential belongs only in the admin
form.

The readiness probe calls `GET /user` only. **It does not check scopes or
expiry.** A successful probe does not establish push access. For the test group or project token, select both scopes above when creating it. For personal tokens, GitLab also includes Git-over-HTTP write access in `api`. [GitLab access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)

## 2. Check the token by hand

Publication authors commits as the token's user and needs that user's e-mail
address (`email`, `commit_email` or `public_email` from `GET /user`). Without
one, publication stops with "has no usable e-mail address". Check it from
your own shell before entering the token. The token goes into a private
file, never onto the command line:

```sh
umask 077; T=$(mktemp -d); H=gitlab.example.com
read -rs -p 'GitLab token: ' TOK; echo
printf 'PRIVATE-TOKEN: %s\n' "$TOK" > "$T/h"; unset TOK
curl -sS -H @"$T/h" "https://$H/api/v4/user" | grep -o '"\(username\|email\|commit_email\|public_email\)":"[^"]*"'
curl -sS -H @"$T/h" "https://$H/api/v4/personal_access_tokens/self" | grep -o '"scopes":\[[^]]*\]'
rm -rf "$T"
```

Expected: a username, at least one e-mail field, and scopes that include
`api` and `write_repository`. `401` means the token is wrong, expired or
revoked.

## 3. Create the instance in the admin UI

On the workspace's **Tools** page, create an instance of kind **GitLab**:

- a label (the model sees it, e.g. `GitLab (test group)`),
- the host, e.g. `gitlab.example.com`, without a scheme or port,
- the token. Paste it only into this form, never into chat, tickets or
  commits. After saving, the form shows only `set (v1)`.

Then assign the instance on the **Tools** page of each channel that should
use it. A channel has at most one GitLab instance; assigning another replaces
it. The compiled policy grants `tool.use` on `gitlab` in those channels only
(see [authorization.md](authorization.md)). Each environment has its own
admin service: production's instance points at the production host, the
live-test instance's at the test host.

## 4. Admit the host

The operator admits GitLab hosts in the env file; an instance on another host
stays `blocked: host not admitted`:

```dotenv
GITLAB_HOSTS=gitlab.example.com
```

`GITLAB_HOSTS` is a comma-separated list of bare hostnames. It is required in
every native env file. The [egress proxy](live-test-setup.md#the-egress-proxy)
admits each host from the tools network on port 443 only, so the admin form
refuses a host with a port. A test instance must not share a host with
production; the tooling does not check this. Apply allowlist changes by
recreating the stack and follow the
[deployment runbook](production-recovery.md) for application restarts.

## 5. Check readiness

Within seconds of saving, the Tools page shows the instance `ready`, or a
failure category. The runtime re-probes every `TOOL_INSTANCE_PROBE_MS`
(default 5 minutes) and after every change. Then ask the bot in an assigned
channel, e.g. "@bot list the open merge requests in group/project".

## Publication

When a request asks for a code change, the agent clones the project into its
isolated workspace, edits files, runs the project's verification command and
publishes:

- **Branch:** `support-agent/<workspace id prefix>`. Only that branch is ever
  pushed, with `--force-with-lease`.
- **Target:** the branch the checkout was cloned from, or the project's default
  branch. A `support-agent/` branch is never a target. The bot never writes to
  the target branch; protect default branches anyway.
- **Merge request:** one per task and project. A follow-up in the same thread
  pushes a new commit to the same branch and updates the same merge request.
  A merged, closed or retargeted merge request stops publication with
  "operator decision required".
- **Verification:** every declared verification command must have passed on
  the exact current tree. Each command has a 30-second limit and runs in a
  sandbox **without network access**, so it cannot install dependencies.
  Projects whose tests need packages must provide them in the repository.
- **Never merged:** the bot does not merge and sets
  `remove_source_branch: false`.

The publication receipt records the project, commit, tree, branch, target
branch, project ID and merge request IID and URL.

## Rotation and revocation

1. Create the replacement token (step 1) before the old one expires and check
   it (step 2).
2. Replace the credential on the instance's edit form in the admin UI. The
   credential version goes up; no restart is needed.
3. Check readiness on the Tools page, then revoke the old token in GitLab.

## Troubleshooting

| Symptom                                          | Cause                                                             | Fix                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `blocked: host not admitted`                     | The host is not in `GITLAB_HOSTS`                                 | Admit it, recreate `egress` and `cli-runtime` (step 4)             |
| Form: "host must be a bare hostname … (no port)" | The host has a port or scheme                                     | Enter the bare hostname; GitLab must be served on port 443         |
| Not ready: `invalid_auth`                        | Token wrong, expired or revoked                                   | Check it by hand (step 2); create a new one                        |
| Not ready: `forbidden`                           | The token's user is blocked or lacks API access                   | Check the user and token in GitLab                                 |
| Not ready: `unreachable`                         | The egress proxy refuses the host, or GitLab is not on port 443   | Check the proxy's `denied` lines and the host                      |
| Runtime refuses to start: obsolete variable      | `GITLAB_HOST` or `GITLAB_TOKEN` is set in the runtime environment | Remove it from the env file                                        |
| Publication: "has no usable e-mail address"      | `GET /user` returns no e-mail for the token's user                | Give the user an e-mail address, or use another token (step 2)     |
| Publication: push refused (`403`)                | Token lacks `write_repository`, or the role cannot push           | Recreate the token with the scopes and role from step 1            |
| Publication: "operator decision required"        | The task's merge request was merged, closed or retargeted         | Inspect the merge request; start a new request for further changes |
| Verification fails installing packages           | The sandbox has no network                                        | Vendor the dependencies, or use a test command that needs none     |

## Verification

Use the [designated test instance](live-test-setup.md) and the test GitLab
group named in the scenario fixtures. Run
[`thread-followup.json`](../tests/live/scenarios/thread-followup.json)
against the selected release revision before recording a live pass. It
checks the published files at the exact commit and a follow-up on the same
merge request; [`gitlab-discovery.json`](../tests/live/scenarios/gitlab-discovery.json)
covers the typed reads and a long job trace. Without a model, the T3
[`tools` suite](testing.md#native-integration-suites-t3) runs a read through
the CLI runtime and the egress proxy against a synthetic
GitLab host. Set the test project in `.env.e2e` (see
[the GitLab test project](live-test-setup.md#11-the-gitlab-test-project)).
