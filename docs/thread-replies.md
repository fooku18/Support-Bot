# Automatic thread replies

Mention the bot in an enabled Slack channel to start a conversation.
After a confirmed answer, the same requester can continue in the
original thread without another mention when **Automatic thread replies**
is enabled. Configure the setting in the admin UI or with
[`!config`](channel-commands.md#configure). Changes apply at admission,
including to existing threads. Already admitted work continues.

The adapter checks the original thread, requester and current channel
access. It ignores unrelated messages, copies of explicit mentions and
unmentioned `!` commands. Other participants can make an explicit mention
subject to channel policy.

Use `continue <answer>`, `cancel` and `status` for
[request controls](agent-progress.md). These controls are available when
automatic replies are off. The same requester and current authorization
are required.

The [Slack app manifest](../deploy/slack-app-settings.json) includes the
public and private channel message events used by this feature. See the
[setup guide](slack-app-setup.md) for installation and reinstallation.
