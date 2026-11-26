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

## Reply decider

With a decision model configured, the requester's unmentioned message
starts a follow-up only when the model judges it meant for the bot: a
request, a question, a correction or an answer. Thanks, reactions, remarks
and small talk stay silent. A message that mentions someone else, a user
group, `@channel`, `@here` or `@everyone` stays silent without a model call.
Files without text and the request controls above skip the model, and so
does a message that would not start a follow-up anyway (replies disabled, or
the current answer not yet delivered). When the
model fails or takes longer than 2 seconds, the message stays silent; a
mention still starts a run.

The decider is any model that serves the Jev API (`POST /v1/systemone`),
such as Jev or a self-hosted clone like clef-flash. Configure it on the
adapter:

| Variable                         | Value                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `THREAD_REPLY_DECIDER_URL`       | Full endpoint URL, such as `https://decider.example/v1/systemone`. Unset turns the decider off. |
| `THREAD_REPLY_DECIDER_MODEL`     | Model name, such as `clef-flash`. Required with the URL.                                        |
| `THREAD_REPLY_DECIDER_CLIENT_ID` | Optional `x-client-id` header.                                                                  |

The URL must use `https`. The adapter sends only the message text, up to
2,000 characters. It logs the decision, its probability and a failure code
(`http_<status>`, `timeout`, `network`, `malformed`) without the text. In
Compose, the egress proxy admits the decider's host on port 443 from the
frontend network; recreate both `adapter` and `egress` after a change.
