# Setting up GitLab access

Assign a GitLab instance to channels that should read GitLab. Plain answers
and other read tools still work without one.

## What the agent can do

The tool runtime sends typed operations to the GitLab REST API over HTTPS. The
model never supplies a URL, host, endpoint or credential. A read follows a
redirect only within the instance host's API (GitLab redirects reads of a
renamed project).

Answers and Code Mode scripts get the same bounded results: selected fields,
at most 100 items, long texts cut with a marker, at most 60 000 bytes per
result. `get_repository_file` returns the decoded
text of the file, cut at 12 000 characters. A binary file, or a file larger
than 60 000 bytes, comes back without content and with a `content_note`. The
tool runtime decodes the file before it redacts credentials from the result.

| Kind | Operations                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read | `get_project`, `list_projects`, `get_issue`, `list_issues`, `get_issue_notes`, `search`, `list_branches`, `list_merge_requests`, `get_merge_request`, `get_merge_request_diffs`, `get_merge_request_commits`, `get_merge_request_notes`, `get_merge_request_pipelines`, `list_pipelines`, `get_pipeline`, `get_pipeline_jobs`, `get_job`, `get_job_trace`, `list_repository_tree`, `get_repository_file`, `get_commit`, `list_commits`, `list_deployments` |

"What changed" in a project and a time window takes three reads:
`list_commits` (`since`, `until`, optionally a `ref` and a `path`),
`list_merge_requests` with `merged_after` and `merged_before` (the state then
defaults to `merged`), and `list_deployments` (`environment`,
`updated_after`, `updated_before`, newest first, at most 20 per page because
each deployment carries its job). A reversed window is refused instead of
answering an empty list. A full page says which page to read next, so a busy
window is not taken as complete. GitLab has no group-wide commit or
deployment list, so these name one project. The tools refuse an argument
they do not know instead of dropping it, so a misspelled filter never widens
a read.

The contract has no write operations: the agent cannot comment, open or
change issues or merge requests, merge, retry jobs, start pipelines, or
change branches, tags, CI variables or project settings.

**The token is the permission boundary.** An instance has no project
allowlist and no operation list. The agent can read every project the
token's user can reach. Scope the token to the projects the channel may use.

## Checklist

| Setting        | Value                                                        | Where                         |
| -------------- | ------------------------------------------------------------ | ----------------------------- |
| Host           | Bare hostname, e.g. `gitlab.example.com`, served on port 443 | Your GitLab URL               |
| Token          | Group, project or personal access token: `read_api`          | [Step 1](#1-create-the-token) |
| Role           | Reporter on the projects the bot may read                    | [Step 1](#1-create-the-token) |
| `GITLAB_HOSTS` | The host, in the env file (egress allowlist)                 | [Step 4](#4-admit-the-host)   |

## 1. Create the token

Prefer a **group access token** on a group that contains only the projects
the bot may use. A project access token limits the bot to one project. A
personal access token works too, but it inherits everything its user can
see and dies with the account.

1. Open the group (or project) → **Settings → Access tokens → Add new token**.
2. Name it, e.g. `support-agent-gitlab`, and set an expiry. Note the date for
   [rotation](#rotation-and-revocation).
3. Select the role **Reporter**. The agent only reads; do not select a
   higher role.
4. Select the scope `read_api`.
5. Create the token and copy it immediately; GitLab shows it once.

Never use a CI job token. The credential belongs only in the admin form.

The readiness probe calls `GET /user` only. **It does not check scopes or
expiry.** [GitLab access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)

## 2. Check the token by hand

Check the token from your own shell before entering it. The token goes into
a private file, never onto the command line:

```sh
umask 077; T=$(mktemp -d); H=gitlab.example.com
read -rs -p 'GitLab token: ' TOK; echo
printf 'PRIVATE-TOKEN: %s\n' "$TOK" > "$T/h"; unset TOK
curl -sS -H @"$T/h" "https://$H/api/v4/user" | grep -o '"username":"[^"]*"'
curl -sS -H @"$T/h" "https://$H/api/v4/personal_access_tokens/self" | grep -o '"scopes":\[[^]]*\]'
rm -rf "$T"
```

Expected: a username and scopes that include `read_api`. `401` means the
token is wrong, expired or revoked.

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

## Rotation and revocation

1. Create the replacement token (step 1) before the old one expires and check
   it (step 2).
2. Replace the credential on the instance's edit form in the admin UI. The
   credential version goes up; no restart is needed.
3. Check readiness on the Tools page, then revoke the old token in GitLab.

## Troubleshooting

| Symptom                                          | Cause                                                           | Fix                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- |
| `blocked: host not admitted`                     | The host is not in `GITLAB_HOSTS`                               | Admit it, recreate `egress` and `cli-runtime` (step 4)     |
| Form: "host must be a bare hostname … (no port)" | The host has a port or scheme                                   | Enter the bare hostname; GitLab must be served on port 443 |
| Not ready: `invalid_auth`                        | Token wrong, expired or revoked                                 | Check it by hand (step 2); create a new one                |
| Not ready: `forbidden`                           | The token's user is blocked or lacks API access                 | Check the user and token in GitLab                         |
| Not ready: `unreachable`                         | The egress proxy refuses the host, or GitLab is not on port 443 | Check the proxy's `denied` lines and the host              |

## Verification

Use the [designated test instance](live-test-setup.md) and the test GitLab
group named in the scenario fixtures. Run
[`gitlab-discovery.json`](../tests/live/scenarios/gitlab-discovery.json)
against the selected release revision before recording a live pass. It
covers the typed reads and a long job trace. Without a model, the T3
[`tools` suite](testing.md#native-integration-suites-t3) runs a read through
the CLI runtime and the egress proxy against a synthetic
GitLab host. Set the test project in `.env.e2e` (see
[the GitLab test project](live-test-setup.md#11-the-gitlab-test-project)).
