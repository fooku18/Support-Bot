# Application settings and Mastra Studio

Use **Application settings** to control who can use the bot and which connected
services are available. Use **Mastra Studio** to try the shared agent and inspect their
execution, metrics, traces and logs.

| Task                                                                | Where                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Pair a Slack workspace; enable channels and people                  | Application settings                                              |
| Configure service instances and their credentials                   | Application settings                                              |
| Assign tools to a channel                                           | Application settings                                              |
| Set a channel's model, additional instructions or automatic replies | Application settings, or `@Support Agent !config` where permitted |
| Inspect configuration changes and Gateway accounting                | Application settings                                              |
| Try the agent, inspect Workspace files, answer an agent question    | Mastra Studio                                                     |
| Inspect execution timing, token usage, traces and safe logs         | Mastra Studio                                                     |

The settings service remains the source of channel authorization and service
bindings. Studio uses those same settings; it does not grant extra permissions
or own another copy of the configuration. Credentials stay in the settings
store and credential-owning integrations. They are not entered into agent
instructions or exposed in Studio telemetry.

## Channel configuration

An authorized channel member can send `@Support Agent !config` to receive a private
configuration button. The modal changes the supported channel settings through
the same audited configuration service as the web console. Sending the command
does not start an agent or consume model tokens.

Turning off automatic replies stops new unmentioned follow-ups from starting
work. Explicit mentions and commands remain available. Current authorization is
checked when settings are opened and saved, and when new agent work is admitted.

Agent templates and their baseline execution options are defined with Mastra in
code. Channel instructions and model choices are application-specific overrides.
Mastra Editor is not enabled as a competing configuration source. See
[Mastra's Editor guidance](https://mastra.ai/docs/studio/editor) and the
[development guide](development.md) for template ownership.

## Configuration retention

The settings database contains Slack installation records, channel settings,
tool assignments, encrypted credential records, accounts and configuration
history. Keep the same database and encryption and session keys when replacing
the settings image. Replacing an image does not require re-entering
configuration or reinstalling the Slack app.

For production, follow the [PostgreSQL backup and restore procedure](settings-deployment.md#back-up-and-restore).
For Compose (SQLite) deployments, keep `ADMIN_STORE_DIR` and use the
[admin snapshot script](../deploy/docker/admin-backup.sh).
Keep the encryption key separately in the protected instance configuration.

Mastra owns execution telemetry. Direct-provider reports record attempts and available token usage. Billed USD is unavailable for those requests. Historical Gateway cost records remain available.

See [Studio](mastra-studio.md) for telemetry access and privacy,
[Kubernetes credential configuration](settings-deployment.md#kubernetes-credential-configuration)
for Secret wiring, and [deployment and recovery](production-recovery.md)
for operational procedures.
