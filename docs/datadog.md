# Setting up Datadog access

Assign a read-only Datadog instance. The CLI runtime connects to the
configured Datadog MCP service with the scoped credential.

## What the agent can do

The tools come from Datadog's MCP server (`?toolsets=all` by default, 256
read tools on `datadoghq.eu` in September 2026). Their schemas total about 0.5 MB, too much
to send with every model request, so the agent gets two tools instead:

| Tool                                         | Use                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `datadog_describe_tools(search)` / `(names)` | Search the catalog by keyword, or Datadog's own description and argument schema of tools |
| `datadog_call(tool, arguments)`              | One read, e.g. `search_datadog_logs`; arguments are checked against its schema           |

The instructions give the catalog size and a few entry tools
(`search_datadog_logs`, `search_datadog_monitors`, …); the agent finds the
rest through the search. Answers and the live tests refer to a tool as
`datadog_<tool>`, e.g. `datadog_search_datadog_logs`.

Datadog already hides write tools from an `mcp_read` token. Anything that
still looks mutating (`execute_code`, names starting with `create_`,
`update_`, `delete_` and similar, unless Datadog marks them read-only) or has
an unusable name is excluded; `/readyz` lists them under `excludedTools`.

There is no approval button: Datadog reads are always available in a thread
whose tool config enables them. The agent sees everything the token's owner
can see in Datadog.

## Checklist

| Setting         | Value                                               | Where                                            |
| --------------- | --------------------------------------------------- | ------------------------------------------------ |
| Site (host)     | Bare site, e.g. `datadoghq.eu`, `us3.datadoghq.com` | Your Datadog URL                                 |
| Token           | PAT or SAT: `mcp_read` plus read scopes, no writes  | [Step 1](#1-create-the-token)                    |
| Toolsets        | `all` (default) or a comma list, e.g. `core,apm`    | [Step 2](#2-create-the-instance-in-the-admin-ui) |
| Tools to deny   | Optional exact upstream names                       | [Step 2](#2-create-the-instance-in-the-admin-ui) |
| `DATADOG_SITES` | The site, in the env file (egress allowlist)        | [Step 3](#3-admit-the-site)                      |

Never use a token with `mcp_write`, an API key or an application key. Gov
sites (`ddog-gov.com`) are not supported by Datadog's MCP server.

## 1. Create the token

1. In Datadog, open **Organization Settings → Access Tokens** and create a
   **Personal Access Token** (needs the `user_app_keys` permission).
2. Select the scope `mcp_read` **and** the read scopes of the data the bot
   should see. `mcp_read` alone only opens the MCP server: every data tool
   then fails with `user lacks required permissions` (verified 2026-09-28).
   Datadog names the permission each tool needs, for example:

   | Data                     | Scopes                                   |
   | ------------------------ | ---------------------------------------- |
   | Logs (search)            | `logs_read_data`, `logs_read_index_data` |
   | Logs (analyze/aggregate) | the above plus `timeseries_query`        |
   | Monitors                 | `monitors_read`                          |
   | Metrics                  | `metrics_read`, `timeseries_query`       |
   | APM spans and traces     | `apm_read`                               |
   | Error tracking           | `error_tracking_read`                    |
   | Dashboards               | `dashboards_read`                        |
   | Incidents                | `incident_read`                          |
   | Events                   | `events_read`, `timeseries_query`        |
   | Hosts                    | `hosts_read`, `timeseries_query`         |
   | RUM                      | `rum_apps_read`                          |

   Never select a `*_write` scope or `mcp_write`. When the bot reports a
   missing permission, it quotes Datadog's list; add those read scopes (a PAT
   cannot be edited: create a new one).

3. Choose an expiry (at least 24 hours, at most one year) and **note the date**:
   the expiry cannot be changed later.
4. Copy the token (`ddpat_…`); Datadog shows it once.

A PAT dies with its owner's account. The durable option is a **Service Access
Token** on a service account (`ddsat_…`, may be non-expiring; needs
`service_account_write` or `org_app_keys_write`, usually an IT request). It is
a drop-in replacement: same variable, same header, no code change.

## 2. Create the instance in the admin UI

On the workspace's **Tools** page, create an instance of kind **Datadog**:
a label (the model sees it, e.g. `Datadog (prod)`), the site (e.g.
`datadoghq.eu`; the runtime derives the endpoint, a URL or unknown site is
refused), the toolsets (`all` by default), optional **tools to deny** (exact
upstream names without the `datadog_` prefix, e.g.
`search_datadog_rum_events`) and the token. Paste the token only into this
form, never into chat, tickets or commits; afterwards the form shows only
`set (v1)`.

Assign the instance on the **Tools** page of each channel that should use it.
The compiled policy grants `tool.use` and `mcp.use` on `datadog` in those
channels only (see [authorization.md](authorization.md)).

Live tests require a test tool instance with a dedicated read-only token and access scoped to test data. Assert only the query, tool call and counts.

## 3. Admit the site

The operator admits Datadog sites in the env file; an instance on another
site stays `blocked: host not admitted`:

```dotenv
DATADOG_SITES=datadoghq.eu
```

The CLI runtime needs outbound HTTPS to `mcp.<site>` only. The instance's
egress proxy admits it from the tools network for every site in
`DATADOG_SITES`. Apply allowlist changes through the instance's egress deployment procedure.
Check readiness through the settings service before using the integration.
For application restarts, follow the [deployment runbook](production-recovery.md).

## 4. Check readiness

Within seconds of saving, the Tools page shows the instance `ready` with its
catalog size, or the failure category. The runtime's `/readyz` lists the
instance with the site and endpoint, the server version, `tools` (the allowed
names), `excludedTools`, `toolCatalogHash` and a `credentialFingerprint`.
Readiness is re-checked after every change, every `TOOL_INSTANCE_PROBE_MS`
(default 5 minutes) and at most every 60 seconds while the application checks readiness, so an
expired or revoked token turns it not-ready with `invalid_auth`. Then ask the
bot in an assigned channel, e.g. "@bot which services logged errors in prod
in the last 15 minutes?".

## Checking a token by hand

From your own shell, before entering the token in the admin UI. The token
goes into a private file, never onto the command line:

```sh
umask 077; T=$(mktemp -d); U='https://mcp.datadoghq.eu/v1/mcp?toolsets=all'
read -rs -p 'Datadog token: ' TOK; echo
printf 'Authorization: Bearer %s\n' "$TOK" > "$T/h"; unset TOK
A='Accept: application/json, text/event-stream'; J='Content-Type: application/json'
curl -sS -D "$T/d" -o /dev/null -w 'initialize: %{http_code}\n' -H @"$T/h" -H "$A" -H "$J" "$U" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
S=$(grep -i '^mcp-session-id:' "$T/d" | tr -d '\r' | cut -d' ' -f2)
curl -sS -o /dev/null -H @"$T/h" -H "$A" -H "$J" -H "Mcp-Session-Id: $S" "$U" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -sS -H @"$T/h" -H "$A" -H "$J" -H "Mcp-Session-Id: $S" "$U" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | head
rm -rf "$T"
```

Expected: `initialize: 200` and a list of tool names. `401` means the token is
wrong, expired or revoked.

## Rotation and revocation

1. Create the replacement token (step 1) before the old one expires.
2. Replace the credential on the instance's edit form in the admin UI (the
   credential version goes up; no restart).
3. Check readiness (new `credentialFingerprint`), then revoke the old token
   under **Organization Settings → Access Tokens**. Revocation takes effect
   within seconds.

A token change or an upstream catalog change starts fresh agent sessions in
existing threads; history and workspace are kept.

## Troubleshooting

| Symptom                                                    | Cause                                                     | Fix                                            |
| ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| Not ready: `missing_config`                                | A setting is empty or malformed (the detail names it)     | Fix the instance in the admin UI               |
| `blocked: host not admitted`                               | The site is not in `DATADOG_SITES`                        | Admit it, recreate `egress` (step 3)           |
| Not ready: `invalid_auth`                                  | Token wrong, expired or revoked                           | Check by hand; create a new token              |
| Not ready: `forbidden_scope`                               | Token lacks `mcp_read`, or its owner lacks Datadog access | Recreate with scope `mcp_read`                 |
| Answer: `forbidden_scope`, "Missing Datadog permission(s)" | The token lacks the named read scope                      | New token with those read scopes (step 1)      |
| Not ready: `empty_catalog`                                 | The toolsets expose no read tool                          | Set the instance's toolsets to `all`           |
| Not ready: `network` / `timeout`                           | The egress proxy does not admit `mcp.<site>`              | Check the proxy's `denied` lines (step 3)      |
| Runner: catalog hash mismatch                              | Datadog changed its tool catalog during qualification     | Ask again                                      |
| `rate_limit` in an answer                                  | Fair-use limit (50 calls per 10 s, 100 000 per month)     | Wait; lower the channel's max tool calls       |
| `output_limit` or `[truncated: …]`                         | Very large result                                         | Ask for a shorter time window or a lower limit |

## Verification

Use the [designated test instance](testing.md#scenarios-and-suites).
Use the approved read-only instance. The T5 logs turn needs `search_datadog_logs`
in the assigned catalog and the log-search permissions in step 1. Catalog
readiness alone only proves discovery. Inspect the tool call and answer
receipt when diagnosing failures. Record the call and count without quoting log content.
[Datadog MCP access](https://docs.datadoghq.com/mcp_server/setup/) · [Log permissions](https://docs.datadoghq.com/logs/guide/logs-rbac-permissions/)

The T3 [`tools` suite](testing.md#native-integration-suites-t3) runs a
`search_datadog_logs` call through the real CLI runtime and egress proxy
against a synthetic MCP server on `mcp.datadoghq.eu`, and checks that a write
tool stays out of the pinned catalog and is refused. The gateway
scenario [`service-tools.json`](../tests/live/scenarios/service-tools.json)
checks against the real test instance that a real model chooses it (T5). It
needs the Atlassian, Datadog, Cloudflare and Slack instances; a missing one is
BLOCKED (see [live test setup](live-test-setup.md#10-run-the-scenarios)). The
stub suite (T4) uses no tool.
