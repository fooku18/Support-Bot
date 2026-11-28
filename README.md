# Support Agent

An AI assistant for Slack that helps teams find information and understand
code. Conversations, questions and results stay in the Slack thread where the
work began.

Slack and Studio run the same Mastra agent definition in separate runtimes. It
answers questions, explores repositories, and looks up information through
connected services. It reads only: it does not change code or write to the
connected services.

Available tools and actions depend on the channel's configuration and your
permissions. Connected services include GitLab, Jira, Confluence, Datadog,
Cloudflare and Slack, with optional web search and page fetching.

## Using the bot

Mention the bot in an enabled Slack channel with a specific request. For example:

> @Support Agent Explain how authentication works in this repository.
>
> @Support Agent Which merge requests changed the date formatting last week?
>
> @Support Agent Summarize this CSV.

Continue the conversation in the same thread to retain context. When automatic
thread replies are enabled, follow-up requests do not need another mention.
The bot shows a working indication and may ask a question before continuing.
You can [attach files](docs/slack-files.md).

Use `@Support Agent status` to inspect the current request, `@Support Agent cancel` to
stop it, or `@Support Agent continue <your answer>` to answer an outstanding question.

## Architecture

```mermaid
flowchart LR
    User[Team member] <-->|Messages and files| Slack[Slack app]
    Slack <-->|Requests and results| Adapter[Slack integration]

    Adapter <--> Runtime[Slack agent runtime]
    Studio[Mastra Studio] <--> StudioRuntime[Studio agent runtime]
    Admin[Application settings] --> Adapter
    Admin --> Runtime
    Admin --> StudioRuntime
    Runtime <--> State[(Slack conversation and execution state)]
    StudioRuntime <--> StudioState[(Studio conversations)]
    Runtime --> Tools[Credential-owning tool runtime]
    StudioRuntime --> Tools
    Tools -->|Scoped API calls via egress proxy| Services[GitLab and connected services]
    Runtime --> Model[Model provider or configured gateway]
    StudioRuntime --> Model
    Runtime -. Optional telemetry .-> Telemetry[(Shared telemetry store)]
    Studio -. Optional dashboard source .-> Telemetry
```

Mastra manages agent execution, tools and conversation memory. The application
checks access to channels, repositories and files, keeps service credentials out
of model context, and verifies delivery outcomes. Network access
is restricted through configured egress controls.

## Further reading

- **Set up an instance:** [Slack app setup](docs/slack-app-setup.md),
  [GitLab](docs/gitlab.md),
  [deployment and configuration](docs/native-answer.md), and
  [access control](docs/authorization.md).
- **Operate the app:** [application settings](docs/application-settings.md),
  [deployment and recovery](docs/production-recovery.md), and
  [backup and restore](docs/native-answer.md#quiesced-logical-backup-and-fresh-restore).
- **Explore or test it:** [Mastra Studio](docs/mastra-studio.md),
  [testing](docs/testing.md) and the
  [live test setup runbook](docs/live-test-setup.md).
- **Contribute:** Follow the [development guide](docs/development.md).
