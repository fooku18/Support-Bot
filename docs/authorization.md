# Authorization

The settings service decides which Slack workspaces, channels and members
can use the bot, and which tools are available in each channel. Slack
messages, model output, repository files and skills cannot change those
permissions.

## Workspace and channel access

1. Pair the workspace through **Workspaces → Add to Slack** and whitelist
   the installation. See [Slack app setup](slack-app-setup.md).
2. Invite the bot to the channels it should serve and enable those channels
   in the settings service. Configure an optional blocklist of exact Slack
   user IDs. The app checks current Slack channel membership as well as the
   application policy.
3. Assign ready workspace tool instances to the channels that need them.

Both U- and W-prefixed Slack IDs can appear in Slack's membership roster.
The installation and actual channel membership determine access. Incomplete
membership or unknown sharing status fails closed where source authority is
required, including file transfer. The live harness has a separate exact
trusted sender restriction described in [testing](testing.md).

The application and adapter synchronize the compiled settings document.
The application requires validated configuration before admission.
An unavailable settings service can delay policy updates. Current
membership, source and policy checks guard provider dispatch, service calls,
publication and delivery. Changes to authority do not erase existing
messages or confirmed effects.

The original requester owns the [current thread's controls](agent-progress.md).
An authorized channel member can start a new request with an explicit
mention. An ordinary reply continues work only under the
[automatic reply rules](thread-replies.md).

## Admin service

The service stores installed credentials and policy in its settings database.
Keep its database connection, session key and credential encryption key in
private instance configuration. See [settings deployment](settings-deployment.md)
for PostgreSQL and Compose (SQLite) deployments. Follow
[application settings](application-settings.md) for the admin and Studio
responsibilities.

### Ingress

Terminate HTTPS at the reverse proxy and forward the admin origin to the
service's private port with `X-Forwarded-Proto: https`. The settings deployment
retains the ingress labels and network identity. The public admin origin
must match the Slack OAuth callback. Application, tools and PostgreSQL
endpoints remain private. Forward neither internal settings routes nor the
agent's authenticated operations endpoints to the public internet.

## Tools

Create instances in the workspace's **Tools** page, check readiness and
assign them per channel. The settings and CLI runtime hold credentials
outside model context and coding workspaces.

| Integration                         | Channel configuration                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| [GitLab](gitlab.md)                 | Scope the token to the projects the channel may use; there is no allowlist.   |
| [Jira and Confluence](atlassian.md) | Set the site and cloud ID and use scoped read-only credentials.               |
| [Datadog](datadog.md)               | Use a PAT or SAT with `mcp_read` and required read scopes.                    |
| [Cloudflare](cloudflare.md)         | Use an account or zone-scoped Read token.                                     |
| [Slack](slack-tool.md)              | Reuse the installed workspace bot token for linked messages and lookup.       |
| Web search                          | Assign the provider search tool. Requests use the selected model connection.  |
| Web fetch                           | Assign the read tool and enable the isolated web runtime.                     |
| Code Mode                           | Assign it next to read tools. With a coding workspace it is always available. |
| Coding and files                    | Use the isolated workspace and explicit export or publication tools.          |

Service endpoints and allowed names are bounded by the deployment
configuration. A ready tool in another workspace or channel does not grant
access. Web fetch uses the public-only egress boundary. The target receives
no private service credentials. Provider search authority is checked at
dispatch.

## Model and instructions

Channel settings can choose an available model and standing instructions.
Channel values take precedence over workspace defaults, with the deployment
default as the final model fallback. Use the settings UI or the authorized
[channel commands](channel-commands.md). Model instructions do not alter
the compiled permissions or the isolated workspace boundary.

## GitLab publication

The assigned GitLab instance and the current authorization bound the clone
and publication targets. Scope its credential to the projects the bot should
work on and protect their default branches. Publication requires an explicitly
requested, verified tree and targets the task's branch and review request.
The bot does not merge. Unknown external effects are retained for operator
inspection and are not automatically replayed.

Check changes to these boundaries using the
[designated test configuration](testing.md). Preserve the audit trail and
use retained evidence to distinguish a verified effect from an attempted one.
