# Live and stub test rules

Read this before you write, change or run a scenario for the stub suite (T4)
or the gateway suite (T5). [testing.md](testing.md) explains how to run them;
[live-test-setup.md](live-test-setup.md) explains how to set up an instance.

## Where tests run

- Live and stub tests run only against the test environment: the application
  values in `.env.testing` and the harness sender in `.env.e2e`, on the
  Compose project named by `.env.testing`'s `COMPOSE_PROJECT_NAME`. Never run
  them, or any stack command for them, against `.env` or its project.
- Start, inspect and stop the test instance only with
  `npm run test:stack:up|ps|down`, or the driver's `--switch-mode`, which runs
  the same commands. `.env` and `.env.testing` carry the same variable names
  as `.env.example` (`npm run env:parity`); only values differ.
- Stub mode (`npm run test:stack:up -- --model-mode stub`) runs the stack with
  the `model-stub` service with a synthetic Messages route. The flag selects
  this route for that start and mounts no provider credentials. Stub results
  are deterministic qualification, not live acceptance: report them as stub
  results and keep live acceptance BLOCKED until a gateway-mode run passes.
- The test instance rests in gateway mode. Run the stub suite with
  `--switch-mode`, which switches to stub mode and back. If you switch by
  hand, switch back before you finish; if a switch back fails, tell the
  operator the instance's state and the commands that restore it.
- The tooling does not compare the test environment with production. Before
  running live tests, check yourself that `.env.testing` shares no Slack app
  token, `GITLAB_HOSTS` or `ATLASSIAN_SITES` host with production. The Slack
  workspace may for now be shared with production; use the test app and test
  channel only.

## What tests may do

The test environment's credentials and targets are authorized for bounded
feature testing without renewed permission. Stub and gateway runs follow the
same rules, except where a rule says "stub suite only".

- **Slack:** post only as the sender in `.env.e2e` (registered as the test
  installation's test sender in the test settings service), in its registered
  channel (`E2E_SLACK_CHANNEL_ID`), within `E2E_SLACK_TEAM_ID`.
- **Own messages (stub suite only):** a scenario may edit or delete a message
  the test sender posted in the same run, to test edit and delete handling.
  Record the message's timestamp and content hash in the report before
  changing it. Never edit or delete any other message.
- **Test channel tools (both suites):** through the test settings service's
  API (`E2E_ADMIN_TOKEN`), the driver may assign and unassign the
  workspace's existing tool instances in the test channel. In the stub suite
  it only unassigns: no stub scenario uses a tool. Read the exact prior
  assignment first and restore it at the end of the scenario, also after a
  failure or an interrupt. The report records both states. When the restore
  cannot be confirmed, the run fails and names what to restore by hand.
  Never create, edit or delete a tool instance, and never read or send a
  credential.
- **Test channel settings (stub suite only):** through the same API, a
  scenario may also change the test channel's enabled flag, model, prompt and
  blocked members, with the same read, restore and report rules.
- **Tool credentials** live in the test settings service's tool instances.
  Only the operator enters them; an agent never types, reads or copies a
  credential. The hosts they may reach are `.env.testing`'s `GITLAB_HOSTS`,
  `ATLASSIAN_SITES`, `DATADOG_SITES` and `CLOUDFLARE_HOSTS`. Only gateway
  scenarios use them: a stub scenario takes no tool
  (`stub_scenario_needs_no_tools`), and tool reads without a model are T3
  `tools`, against synthetic services.
- **GitLab:** read-only through the test GitLab instance assigned to the test
  channel. Its token is scoped to the test group. Assert only facts of the
  test projects named in the scenario fixtures.
- **Atlassian:** read-only through the test Atlassian instance (the test site,
  scoped Jira and Confluence read tokens) only. Never use an unscoped or MCP
  token, and never write to Jira or Confluence. Assert only the fixture facts
  recorded in the scenario files (see [atlassian.md](atlassian.md)).
- **Datadog:** read-only through the test Datadog instance (a PAT or SAT with
  `mcp_read` plus read scopes only). Use a dedicated test token scoped to test data. Never use a token with `mcp_write` or any `*_write` scope,
  or any API or application key, never write to Datadog, and assert only
  structure (query, tool call, counts), never production log content (see
  [datadog.md](datadog.md)).
- **Cloudflare:** read-only through the test Cloudflare instance (an API token
  with Read permissions only; no Edit permission, never the Global API Key).
  Use a dedicated test token scoped to approved test resources.
  Never write to Cloudflare, and assert only structure (query, tool call, row
  presence), never traffic values or zone content. The current scenario checks token status only. Readiness requires a visible approved zone (see [cloudflare.md](cloudflare.md)).
- **Slack tool:** the test app's bot token through the test settings
  service's Slack instance only. Look up only the fixture users named in the
  scenario files. The current scenario only looks up a user. Never list the
  directory. Any authorized search is limited to a scenario's fixture phrase
  in public channels only (see [slack-tool.md](slack-tool.md)).
- **Model:** only the direct provider route and model in the designated
  test instance's `MODEL_CATALOG` with operator-provided test credentials,
  or the instance's `model-stub` in stub mode. The operator preselects the
  model through the test channel's assignment or inherited default. Use
  `--model-key` for a preselected non-default route. The gateway suite
  verifies the selection before posting and checks it against the recorded
  attempts. It never edits the channel's model assignment.

## Writing scenarios

- Prove behaviour at the lowest tier that can prove it (see
  [the ladder](testing.md#the-test-ladder)). A stub scenario only covers what
  needs the real stack and the Slack test app, never a tool; a gateway
  scenario only what needs a real model or a real tool service.
- Gateway scenarios must pass [the live-scenario gate](testing.md#the-live-scenario-gate-t5):
  they need a real model, cover nothing another gateway scenario covers
  (extend a thread before adding a scenario), stay cheap (fewest turns,
  deployment default or an operator-preselected model for route acceptance,
  no web tools unless tested), assert
  service-dependent facts, and declare `covers` and `budget`. Do not rerun a
  scenario that passed unchanged; a suite skips it unless `--rerun` is given.
- Tool scenarios assert facts that depend on the service or the search. A
  scenario that only asserts structural reply text is underspecified.
- New CLI and web integrations need the binary and credential qualified
  before live enablement.
- A value or fixture marked `<operator: ...>`, or a missing one, is BLOCKED:
  stop and ask the operator instead of substituting a value. Missing
  designated credentials or approved targets are BLOCKED, never a skip.
- For bot-authored tests, register the sender's bot ID, user ID and channel
  ID as the test installation's test sender in the test settings service
  (empty in production). Keep the exact sender and workspace and channel
  restrictions; never allow arbitrary bots or the app itself. See
  [live-test-setup.md](live-test-setup.md).

## Evidence

- Retain test messages, reports and task state as evidence. Do not delete
  messages, reset volumes or clean remote artifacts as an implicit part of
  testing. The only exception is the own-message step
  above, whose snapshot the report keeps.
- Report the command, the model mode, the scenario or suite, the outcome and
  the report and Slack links. A missing prerequisite is BLOCKED, never a
  passing skip.
- Live evidence covers the tested scenarios only. Do not call a feature
  E2E-verified when only unit tests, fake services, the stub or an older
  image were tested. Add regression cases for failures found.
- Keep credentials out of logs, reports, commits and container images.
