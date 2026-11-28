# Mastra Studio on the test configuration

Studio exposes **Support Agent**, the same Mastra agent that handles Slack conversations.
It uses the designated test channel's current model, instructions, tool assignments
and trusted harness identity. Studio conversations stay in Studio.

With the designated test stack running and workspace dependencies
installed, start it from the repository root:

```sh
npm run studio -- start --instance-dir /absolute/test-instance
```

Open **http://localhost:4111** and open **Support Agent**. The published port
is restricted to host loopback; use an SSH tunnel when accessing a remote host.
The port can be changed with `--port`.

For access through the development environment's Traefik gateway:

```sh
npm run studio -- start --instance-dir /absolute/test-instance --state-dir /absolute/studio-state \
  --public-origin https://mastra-studio.example.test --traefik-network traefik-public
```

Use the actual hostname assigned to your environment. The launcher registers a
host-specific Traefik route on its `web` entrypoint; the upstream gateway must
provide HTTPS. Mastra advertises that public HTTPS address while its container
still listens on the local Studio port. Only that exact origin and the two
loopback origins are allowed. The chosen route is retained with the Studio state
for subsequent starts; stop Studio before changing it.

Studio uses the fixed test identity and has no separate user login. Expose it
only behind the development environment's access-controlled gateway, not as an
anonymous public service. Every admitted visitor can use the configured test
tools and Gateway budget. Stopping Studio also removes its active Traefik route.

```sh
npm run studio -- status --instance-dir /absolute/test-instance
npm run studio -- stop --instance-dir /absolute/test-instance
```

Stopping retains conversations, PostgreSQL volumes and resource
records under the instance's `studio/` directory. Starting again preserves that
state. Source edits require stop/start to regenerate the entrypoint bundle.

## What is shared

Slack and Studio share the agent definition, durable execution, memory and tools.
The agent discovers assigned read tools as needed, and Code Mode when it is
assigned. Studio uses the configured real Gateway and test tool services;
requests can consume Gateway budget.

Identity and policy are fixed server-side. Browser overrides of model,
instructions, tools, execution limits or authority are refused. The stock UI may
echo the agent's exact server-defined limits; changed values are refused,
including nested stream options. If trusted
configuration changes, restart Studio and start a fresh chat. Older conversations
remain retained; runs pinned to a previous configuration cannot be resumed under
new instructions.

The Slack/admin transport uses the frontend proxy. CLI operations use the
separate tools-network proxy. Successful Slack access does not establish
GitLab routing; the launcher preserves both configured endpoints and their
allowlists.

## Differences from Slack

Studio has its own PostgreSQL database; it does not attach to active Slack
executions. The stock UI may show an `ANTHROPIC_API_KEY` hint even when the
configured Gateway works; do not add a placeholder key to hide it.

Slack-origin attachment checks, Slack reactions, automatic thread participation
and Slack delivery must still be tested in the test Slack app. Studio provides
the framework chat surface, not a simulation of those Slack transports.

Execution defaults retain bounded steps/tokens/time, serial tool calls, disabled
background tasks and disabled automatic suspended-tool resumption. Durable
recovery is disabled, also across Studio restarts.

## Metrics, traces and logs

Studio records new activity using Mastra's observability exporter and its
PostgreSQL observability backend. Open **Observability → Metrics**, **Traces** or
**Logs** after running an agent. Data is retained across Studio restarts; earlier
runs made with telemetry disabled are not backfilled.

Traces show execution structure, timings, outcomes and token usage. Metrics
include native duration and token measurements. Logs show bounded request events
and redacted framework events. Prompts, answers, tool arguments/results, file
contents and arbitrary metadata are omitted from these three telemetry signals.
Conversation history is still retained separately by Mastra Memory. Delivery
receipts, not traces, remain authoritative for external writes.

The launcher provisions `studio_observability` beside the existing chat schema.
A network-disabled maintenance container uses the Studio PostgreSQL Unix socket
to create Mastra's daily partitions on startup and every six hours. The Studio
runtime keeps its restricted database role and receives no schema-creation grant
or maintenance socket. `studio status` reports the maintenance process;
`studio stop` stops it as well. No automatic telemetry deletion is configured.

To inspect the Slack application's new activity in the same dashboard, enable
its optional [shared telemetry store](native-answer.md#shared-telemetry), stop
Studio, then select it explicitly:

```sh
npm run studio -- start --instance-dir /absolute/test-instance --state-dir /absolute/studio-state --observability-source native
```

Studio continues to use its own conversation storage. Only the
observability domain points to the native telemetry schema through a separate
restricted role. Signals identify their source as `support-agent-slack` or
`support-agent-studio`; Slack correlation is hashed. Studio does not receive the
native application's storage password or PostgreSQL maintenance socket.

To view earlier local Studio telemetry, stop Studio and restart with
`--observability-source studio`. Both histories remain retained; changing the
source neither migrates nor deletes them. The native stack owns shared partition
maintenance, so stopping Studio does not stop that service.

The narrow exporter projection is necessary because the pinned framework's span
formatter does not sanitize its separate metric and log events. Mastra still
owns storage, buffering, queries and the dashboard.
