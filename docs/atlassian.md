# Setting up Jira and Confluence access

Assign a read-only Jira or Confluence instance to the channels that
need it. The tool runtime keeps credentials outside model context.

## What the agent can do

| Tool                       | Use                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `searchJiraIssues`         | Full-text search over issue summary, description and comments, optionally within one project        |
| `searchJiraIssuesUsingJql` | Search with a JQL query the agent writes                                                            |
| `getJiraIssue`             | Read one issue by key                                                                               |
| `listJiraIssueComments`    | Read an issue's comments                                                                            |
| `listJiraProjects`         | List visible projects                                                                               |
| `searchConfluencePages`    | Full-text search over pages (same engine as the Confluence search box), optionally within one space |
| `getConfluencePage`        | Read one page by ID                                                                                 |

Search is keyword-based with relevance ranking, not semantic. The agent
reformulates a query (synonyms, fewer terms, German/English) when the first
search finds nothing useful, then reads the best hits.

The agent sees everything the token's user can see. Use an account whose
Jira and Confluence permissions match what the bot's users may read.

## Checklist

| Setting           | Value                                                    | Where                                                                               |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Site (host)       | Bare hostname, e.g. `example.atlassian.net`              | Your Jira/Confluence URL                                                            |
| Cloud ID          | Site UUID                                                | [Step 3](#3-find-the-cloud-id)                                                      |
| Email             | Email of the token's Atlassian account                   | [Atlassian profile](https://id.atlassian.com/manage-profile/profile-and-visibility) |
| Jira token        | Scoped token, app **Jira**, read scopes                  | [Step 1](#1-create-the-jira-read-token)                                             |
| Confluence token  | Scoped token, app **Confluence**, read and search scopes | [Step 2](#2-create-the-confluence-read-token)                                       |
| Operations        | The operations the channel may use                       | [Step 4](#4-create-the-instance-in-the-admin-ui)                                    |
| `ATLASSIAN_SITES` | The site, in the env file (egress allowlist)             | [Step 5](#5-admit-the-site)                                                         |

Do **not** use an unscoped API token ("Create API token" without scopes) or
an "Atlassian MCP" token. There are no `ATLASSIAN_*` credential variables;
the tokens belong only in the admin form.

## 1. Create the Jira read token

1. Log in to <https://id.atlassian.com> with the account the bot should read
   as.
2. Open **Security → API tokens**
   (<https://id.atlassian.com/manage-profile/security/api-tokens>).
3. Choose **Create API token with scopes**.
4. Name it, e.g. `support-agent-jira-read`, and pick an expiry. Tokens last at most
   one year; note the date for [rotation](#rotation-and-revocation).
5. Select the app **Jira**. Not "Atlassian MCP", not "Atlassian MCP V2":
   those tokens only work against Atlassian's MCP server, which the bot does
   not use.
6. Select only these scopes:
   - `read:jira-work`: issues, search, comments, projects
   - `read:jira-user`: account and user fields
7. Select no `write:`, `delete:` or `manage:` scope.
8. Create the token and copy it immediately; it is shown only once.

## 2. Create the Confluence read token

Repeat step 1 with:

- name `support-agent-confluence-read`
- app **Confluence**
- scopes:
  - `read:space:confluence`: required by the [v2 spaces readiness probe](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/#api-spaces-get)
  - `search:confluence`: [CQL search](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/)
  - `read:page:confluence`: [read a page by ID](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-get)

Existing tokens may also include `read:confluence-content.all` and
`read:confluence-space.summary`. The v2 spaces and page endpoints require
their granular scopes even with those classic read scopes.

Each token covers one app, so the full gateway scenario needs both. A product without a token is
unavailable; the other one still works.

## 3. Find the cloud ID

The site's cloud ID is public:

```sh
curl -s https://<site>/_edge/tenant_info
# {"cloudId":"<uuid>"}
```

The runtime's readiness probe checks that this cloud ID belongs to the
instance's site and reports a mismatch (`site_mismatch`).

## 4. Create the instance in the admin UI

On the workspace's **Tools** page, create an instance of kind **Atlassian**:

- label, e.g. `Jira/Confluence (example)` (the model sees it),
- site: `example.atlassian.net`,
- cloud ID from step 3 and the token account's email,
- the operations the channels may use (all by default),
- the Jira and/or Confluence token. Paste them only into this form; never
  into chat, tickets or commits. After saving, the form shows only
  `set (v1)`.

Then assign the instance on the **Tools** page of each channel that should
use it. The compiled policy grants `tool.use` and `mcp.use` on `atlassian`
in those channels only (see [authorization.md](authorization.md)). Each
environment has its own admin service: production's instance points at the
production site, the live-test instance's at the test site.

## 5. Admit the site

The operator admits Atlassian sites in the env file; an instance on another
site stays `blocked: host not admitted`:

```dotenv
ATLASSIAN_SITES=example.atlassian.net
```

The CLI runtime needs outbound HTTPS to `api.atlassian.com` only. The
instance's egress proxy admits it from the tools network when
`ATLASSIAN_SITES` admits a site. Apply allowlist changes through the instance's egress deployment procedure.
Check readiness through the settings service before using the integration.
For application restarts, follow the [deployment runbook](production-recovery.md).

## 6. Check readiness

Within seconds of saving, the Tools page shows the instance `ready` (or the
failing product with a category such as `invalid_auth`). The runtime re-probes
every `TOOL_INSTANCE_PROBE_MS` (default 5 minutes) and after every change.
Check Jira and Confluence separately. A ready Jira probe permits Jira reads even if the Confluence spaces probe reports `insufficient_scope`. The five-turn gateway scenario needs both products and searchable fixtures.
Then mention the bot in an assigned channel, e.g. "@bot find the Jira issue
about the release checklist".

## Rotation and revocation

1. Create the replacement token (steps 1–2) before the old one expires.
2. Replace the credential on the instance's edit form in the admin UI (the
   credential version goes up; no restart). A new Atlassian credential
   replaces both product tokens, so enter both.
3. Check readiness on the Tools page, then revoke the old token at
   <https://id.atlassian.com/manage-profile/security/api-tokens>.

A token change starts fresh agent sessions in existing threads; the thread
history and workspace are kept.

## Troubleshooting

| Symptom                                              | Cause                                                                        | Fix                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Unauthorized` (plain)                               | Wrong token, wrong email, or token revoked/expired                           | Check the instance's email; test the token by hand; create a new one                      |
| `Unauthorized; scope does not match` on a read       | Token lacks a scope, or is for the wrong app                                 | Recreate with the scopes from steps 1–2                                                   |
| `You don't have permission to connect via API token` | You used an Atlassian MCP token; the org blocks API-token access through MCP | Use Jira/Confluence scoped tokens instead                                                 |
| Instance not ready: `site_mismatch`                  | The cloud ID belongs to another site                                         | Look it up again (step 3)                                                                 |
| Instance `blocked: host not admitted`                | The site is not in `ATLASSIAN_SITES`                                         | Admit it, recreate `egress` and `cli-runtime` (step 5)                                    |
| Timeouts / network errors                            | The egress proxy does not admit `api.atlassian.com`                          | Check `ATLASSIAN_SITES` and the proxy's `denied` lines (step 5)                           |
| Search finds nothing                                 | Keyword search, not semantic; or the user lacks permission                   | Ask with other words or name the project/space; check the account's access in the browser |
| `rate_limit`                                         | Atlassian rate limit                                                         | Wait and ask again                                                                        |

## Verification

Use the [designated test instance](testing.md#scenarios-and-suites).
Use a separate test site and scoped read-only credentials.

The T3 [`tools` suite](testing.md#native-integration-suites-t3) runs a Jira
search through the real CLI runtime and egress proxy against a synthetic
`api.atlassian.com`, and checks that each product token reaches only its own
paths and that a write operation is refused. The gateway
scenario [`service-tools.json`](../tests/live/scenarios/service-tools.json)
checks against the real test instance that a real model chooses it (T5). It
needs the Atlassian, Datadog, Cloudflare and Slack instances; a missing one is
BLOCKED (see [live test setup](live-test-setup.md#10-run-the-scenarios)). The
stub suite (T4) uses no tool.

For the T5 fixture, an operator creates one issue in the approved test Jira
project with the summary `lunar lighthouse handoff`, and publishes one page
in the approved test Confluence space with the same title. Use synthetic
content. Verify that the token account can open both. Jira assigns the issue
key and Confluence assigns the numeric page ID. If they differ from the
expected values in `tests/live/scenarios/service-tools.json`, record the
operator-confirmed key and ID there before running T5. Keep the discovery
prompts free of those identifiers.
