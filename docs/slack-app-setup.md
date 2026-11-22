# Set up the Slack app

The adapter receives events over Socket Mode. The settings service handles
workspace installation over OAuth and stores each installation's bot token.
Use the [Slack app manifest](../deploy/slack-app-settings.json) as the source
for scopes, event subscriptions and interactivity.

## Create the app

1. Generate the manifest for the instance and create the app from it:
   `npm run -s slack:manifest -- --instance-dir <instance>` reads
   `ADMIN_PUBLIC_URL` and `SUPPORT_AGENT_INSTANCE` from its `.env.testing` and fills
   the OAuth callback and the app name (`--name` overrides the name). Paste
   it into **Create New App → From a manifest**, or into an existing app's
   **App Manifest** page.
2. Create one app-level token with the `connections:write` scope. Set the
   instance's private `SLACK_APP_TOKEN` for the adapter.
3. Configure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and
   `ADMIN_PUBLIC_URL` on the settings service. The registered callback
   must be `<ADMIN_PUBLIC_URL>/slack/oauth/callback`. Keep all credentials
   in private instance configuration.
4. Keep the bot scopes of the manifest. `files:write` and `files:read`
   attach [long answers](slack-files.md#long-answers) as `answer.md` and
   deliver exports.
5. Keep Socket Mode and interactivity enabled. Subscribe to `app_mention`,
   `message.channels` and `message.groups`. The message events support
   [automatic thread replies](thread-replies.md), and interactivity
   supports the private channel settings modal.

## Install and authorize

Provision the [application and its dependencies](production-recovery.md).
For a new settings store, create the first administrator by running
`node apps/admin/dist/cli.js create-admin <name>` inside the settings
container. The command prompts for the password.

In the settings service, open **Workspaces → Add to Slack** and pair the
workspace. Whitelist the installation, invite the bot to the intended
channels, and enable those channels in admin. Assign optional tools only
to channels that need them. See [authorization](authorization.md).

When changing app scopes, reinstall through **Add to Slack** in the
settings service so it stores the updated installation token. Run one
Socket Mode adapter per app.

## Verify

Mention the bot in an enabled channel and check the reply in that thread.
For the designated test deployment, use its own Slack app and the exact
[authorized sender and channel](testing.md#scenarios-and-suites). The
[live test setup](live-test-setup.md#3-create-the-slack-apps) describes the
separate harness sender app and how to register it.
