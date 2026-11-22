# Slack user lookup

The shared agent can resolve a Slack user ID or mention with `slack_get_user`
or look up a specific address with `slack_lookup_user_by_email`. The runtime
uses the installed bot token from the request's workspace. The tools return
bounded profile fields for one user at a time. Directory listing and
message search are outside the current agent's Slack tool catalog.

1. Include `users:read` and, for email lookup, `users:read.email` in the
   [Slack app configuration](slack-app-setup.md). Reinstall through
   **Add to Slack** after scope changes.
2. Create a **Slack** instance on the workspace's **Tools** page and assign
   it to the intended channel. The instance uses that workspace's installed
   token and requires no additional credential.
3. Check readiness in the admin UI. If the token is invalid or belongs to a
   different workspace, reinstall it through that workspace's settings.

Treat profile data as untrusted. A Slack answer is visible to everyone in
the thread, so only assign the tool to channels allowed to see the profile
fields it can return. Live verification uses only designated fixture users.
See [testing](testing.md#scenarios-and-suites).
