# Slack adapter

The adapter connects one Socket Mode receiver to the native Mastra application.
It verifies each configured workspace and bot identity with the admin service,
checks current channel membership, and acknowledges relevant events after durable
acceptance. An ordinary thread reply can continue a conversation when the native
application recognizes the thread and its owner.

The native application owns conversation state, execution and delivery receipts.
The adapter checks current Slack authority before presenting replies or transferring
files. It sends a full Markdown block and a bounded notification preview. Direct
channel commands and their dialogs are handled through the admin service.

## Configuration

| Variable                                  | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `SLACK_APP_TOKEN`                         | Socket Mode app token with `connections:write`                       |
| `ADMIN_URL`, `ADMIN_INTERNAL_TOKEN`       | Private admin endpoint and bearer credential                         |
| `NATIVE_APPLICATION_URL`, `SERVICE_TOKEN` | Private agent endpoint and shared service credential                 |
| `NATIVE_ADAPTER_PORT`, `NATIVE_BIND_HOST` | Authority and delivery listener. The bind host defaults to `0.0.0.0` |
| `EGRESS_PROXY_URL`                        | Optional proxy for Slack API and Socket Mode traffic                 |
| `SLACK_API_URL`                           | Slack API override for synthetic tests                               |

The Compose file maps `SUPPORT_AGENT_SERVICE_TOKEN` from the instance environment to the
adapter’s `SERVICE_TOKEN`.

## Run and verify

Use the root workspace lockfile to install dependencies. The Compose `adapter`
service starts with `--process-env`. For local development, pass the private
adapter environment file with `npm run dev --workspace @support-agent/slack -- --env <path>`.

```sh
npm run typecheck --workspace @support-agent/slack
npm test --workspace @support-agent/slack
npm run test:native:integration -- --suite application
```

See the [testing guide](../../docs/testing.md) for the designated test stack and
the [Slack setup guide](../../docs/slack-app-setup.md) for app configuration.
