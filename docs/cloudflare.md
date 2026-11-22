# Setting up Cloudflare access

Assign a read-only Cloudflare instance for approved analytics and
metadata. The tool runtime owns the scoped API token.

## What the agent can do

| Tool                                   | Use                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare_graphql(query, variables)` | One read-only query against the GraphQL Analytics API, e.g. `httpRequestsAdaptiveGroups` (requests, bytes, cache and status) or `firewallEventsAdaptiveGroups` (WAF events by action) |
| `cloudflare_get(path, query)`          | One REST `GET` under `/zones` or `/accounts`: zone metadata, settings, DNS records, rulesets and similar                                                                              |

The instructions list the instance's zones with their zone IDs (the
`zoneTag` filter of every zone query; not secrets), the account if any, and
a short example query. The GraphQL schema is introspectable through
`cloudflare_graphql` (`__schema`, `__type`), so the agent can look up field
names. Query mistakes come back with Cloudflare's error message (bounded);
authentication and permission errors come back as fixed sentences only.

Limits the bot enforces on top of the token:

- zone IDs in paths and `zoneTag` filters must be zones of the instance;
  account IDs must be the instance's account;
- without an account ID, account-level paths and datasets are refused;
- with a zone list, every GraphQL `zones` selection must filter by `zoneTag`
  and `GET /zones` (listing) is refused;
- Logpush paths (`…/logpush/…`) are refused: job configurations carry
  destination credentials;
- query ≤ 16 KB, variables ≤ 8 KB, ≤ 16 REST query parameters, `per_page` ≤
  100; upstream responses ≤ 2 MB; results are capped per channel and marked
  `[truncated: …]`.

There is no approval button: Cloudflare reads are always available in a
channel with an assigned, ready Cloudflare instance (like Datadog). Results
are labelled untrusted data. Every call is recorded (tool, dataset or path
template, outcome, binding, duration, size), never the query text, variables
or results.

## Checklist

| Setting            | Value                                                     | Where                                            |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------ |
| Token              | API token, Read permissions only, prefer an account token | [Step 1](#1-create-the-token)                    |
| Account ID         | Optional: enables account-level datasets                  | [Step 2](#2-create-the-instance-in-the-admin-ui) |
| Zones              | Optional zone names; empty = every zone the token sees    | [Step 2](#2-create-the-instance-in-the-admin-ui) |
| `CLOUDFLARE_HOSTS` | `api.cloudflare.com` in the env file (egress allowlist)   | [Step 3](#3-admit-the-api-host)                  |

Never use a token with an `Edit` permission, and never the Global API Key.

## 1. Create the token

Prefer an **account token** (_Manage Account → Account API Tokens_) so the
integration does not die with a user; a **user token** (_My Profile → API
Tokens_) works the same. The bot assumes no token prefix or type.

Permissions, all `Read`:

| Scope   | Permission                | Needed for                              |
| ------- | ------------------------- | --------------------------------------- |
| Zone    | `Zone: Read`              | zone list, zone metadata, readiness     |
| Zone    | `Analytics: Read`         | `httpRequestsAdaptiveGroups` and others |
| Zone    | `Logs: Read`              | `firewallEventsAdaptiveGroups`          |
| Account | `Account Analytics: Read` | account-level datasets (optional)       |
| Account | `Account Settings: Read`  | `GET /accounts/{id}` (readiness)        |

Zone resources: the zones the bot may see (all zones of the account is
acceptable; never zones of another account). No client-IP filter. Set an
expiry and **note the date** for rotation. Copy the token; Cloudflare shows it
once.

Confirm the token has only the requested Read permissions before saving it.

## 2. Create the instance in the admin UI

On the workspace's **Tools** page, create an instance of kind **Cloudflare**:
a label (the model sees it, e.g. `Cloudflare (prod)`), an optional **account
ID** (32 hex characters; account-level datasets are then limited to it), an
optional **zone list** (one zone name per line; empty exposes every zone the
token can see, at most 200) and the token. The host is always
`api.cloudflare.com`. Paste the token only into this form, never into chat,
tickets or commits; afterwards the form shows only `set (v1)`.

Assign the instance on the **Tools** page of each channel that should use it.
The compiled policy grants `tool.use` and `mcp.use` on `cloudflare` in those
channels only (see [authorization.md](authorization.md)).

Live tests require a test tool instance with a dedicated read-only token scoped to approved test resources. The scenario requests token status. Readiness also checks the configured account and visible zones.

## 3. Admit the API host

The operator admits the API host in the env file; until then every
Cloudflare instance stays `blocked: host not admitted`:

```dotenv
CLOUDFLARE_HOSTS=api.cloudflare.com
```

`api.cloudflare.com` is the only legal value (`deploy-preflight` and the
egress proxy refuse anything else). Only the `cli-runtime` process reaches
it. Apply allowlist changes through the instance's egress deployment procedure.
Check readiness through the settings service before using the integration.
For application restarts, follow the [deployment runbook](production-recovery.md).
The proxy matches the host name and resolves it per tunnel, so the anycast
addresses need no re-resolution timer.

## 4. Check readiness

Within seconds of saving, the Tools page shows the instance `ready`, or the
failure category. The runtime's `/readyz` lists it with the endpoint, adapter
`cloudflare-api-v1`, contract `cloudflare-read-v1`, the account ID, the zones
(ID, name, status, plan), `zoneSetHash` and a `credentialFingerprint`.
Readiness is re-checked after every change, every `TOOL_INSTANCE_PROBE_MS`
(default 5 minutes) and at most every 60 seconds while the application checks readiness; a
rejected token turns it not-ready at once. A run that started with one
binding (zones, account, token) fails closed when resumed under another.

Then ask the bot in an assigned channel, e.g. "@bot hourly requests to
cloud.example.com over the last 24 hours, and the firewall events by action".

## Rotation and revocation

1. Create the replacement token (step 1) before the old one expires and
   qualify it.
2. Replace the credential on the instance's edit form in the admin UI (the
   credential version goes up; no restart).
3. Check readiness (new `credentialFingerprint`), then delete the old token
   in the Cloudflare dashboard.

A token, account or zone change starts fresh agent sessions in existing
threads; history and workspace are kept.

## Troubleshooting

| Symptom                              | Cause                                                               | Fix                                                 |
| ------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------- |
| `blocked: host not admitted`         | `CLOUDFLARE_HOSTS` is empty                                         | Admit `api.cloudflare.com`, recreate `egress`       |
| Not ready: `missing_config`          | Token empty or malformed, or a bad account ID                       | Fix the instance in the admin UI                    |
| Not ready: `invalid_auth`            | Token wrong, expired or deleted                                     | Qualify it; create a new token                      |
| Not ready: `account_not_visible`     | The account ID is wrong or the token lacks `Account Settings: Read` | Fix the account ID or the token                     |
| Not ready: `zone not visible …`      | A configured zone is not in the token's zone resources              | Fix the zone list or the token's zone resources     |
| Not ready: `no_zones`                | The token sees no zone (in the account)                             | Add zone resources to the token                     |
| Not ready: `network` / `timeout`     | The egress proxy does not admit `api.cloudflare.com`                | Check the proxy's `denied` lines (step 3)           |
| Answer: `forbidden_scope`            | The token lacks the permission for that dataset or path             | Add the Read permission (e.g. `Logs: Read`)         |
| Answer: `query_error` with a message | A wrong field, filter or argument in the query                      | The agent corrects it; otherwise ask more precisely |
| `rate_limit` in an answer            | 1 200 REST requests or 300 GraphQL queries per 5 minutes            | Wait; lower the channel's max tool calls            |
| `output_limit` or `[truncated: …]`   | Very large result                                                   | Ask for a shorter window or a lower limit           |

## Verification

Use the [designated test instance](testing.md#scenarios-and-suites).
For T5, the token must see at least one approved zone. Grant Zone Read for
the readiness listing. If the instance specifies an account ID, grant Account
Settings Read on that account for the account probe. Analytics and Logs
permissions are unnecessary for this scenario. User tokens verify through
`/user/tokens/verify`. For an account-owned token, configure its account ID so
the tool can use `/accounts/{account_id}/tokens/verify`.
[Cloudflare account token verification](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/)

The T3 [`tools` suite](testing.md#native-integration-suites-t3) runs
`cloudflare_get` (token status only) through the real CLI runtime and egress
proxy against a synthetic `api.cloudflare.com`, and checks that a revoked
instance is refused. The gateway
scenario [`service-tools.json`](../tests/live/scenarios/service-tools.json)
checks against the real test instance that a real model chooses it (T5). It
needs the Atlassian, Datadog, Cloudflare and Slack instances; a missing one is
BLOCKED (see [live test setup](live-test-setup.md#10-run-the-scenarios)). The
stub suite (T4) uses no tool.
