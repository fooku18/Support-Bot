# Set up the live test instance

This runbook takes an operator from an empty Docker host to a passing live
scenario on the designated test instance. Follow the steps in order. The
authorization boundaries for live tests are in [live-test-rules.md](live-test-rules.md); read
them before starting the test stack.

## What runs

`npm run test:stack:up` starts the whole instance from
[`deploy/compose.yaml`](../deploy/compose.yaml):

| Service              | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `native-answer`      | The shared Mastra agent with its isolated coding workspace                |
| `adapter`            | The Slack Socket Mode connection                                          |
| `native-cli-runtime` | Holds tool credentials and runs GitLab, Jira and other service calls      |
| `native-postgres`    | Conversation and execution state                                          |
| `admin`              | The settings web UI: Slack pairing, channels, tool instances and tokens   |
| `egress`             | Outbound proxy for application traffic, with per-network host rules       |
| `model-stub`         | Scripted Messages API; replaces the direct model routes in stub mode only |

Compose creates the private networks itself. You provide the env file, the runtime password and active provider
credential files, a settings store directory, an HTTPS reverse proxy for the
settings UI and, in gateway mode, an operator-designated direct model connection.

## Choose the model mode

You choose the model mode when you start the stack:
`npm run test:stack:up -- --instance-dir "$D" --model-mode stub|gateway`.
The default is `gateway`. One instance runs both modes.

- **`gateway`**: direct model connections from `.env.testing`. This is the
  harness mode for live acceptance (T5). To use an Anthropic-compatible
  gateway, set `NATIVE_ANTHROPIC_BASE_URL` there.
- **`stub`**: the fixed Messages stub replaces the configured models for
  this start (T4). Use it to qualify the
  stack cheaply. Everything else is real: the Slack test app, the settings
  service, the egress proxy, PostgreSQL and the CLI runtime. The stub suite
  uses no tool instance, so it needs only Docker and the Slack test app.
  Replies are scripted and deterministic, and they cost nothing.

`up` records the mode in `$D/model-mode`. Stub startup selects the
fixed synthetic connection through a process-scoped override. To switch,
run `test:stack:down`, then `test:stack:up` with the other flag.

The instance **rests in gateway mode**. Run the stub suite with the driver's
`--switch-mode` (step 10): it switches to stub mode for the run and back
afterwards. If you switch by hand, return to gateway mode before you finish.

A stub run qualifies intake, delivery, context assembly, policy, channel
settings, the Slack route through the egress proxy and the cost ledger. Tool
reads through the CLI runtime and the egress proxy are T3
([the `tools` suite](testing.md#native-integration-suites-t3)) and, with the
real services, T5. A stub run never counts as live acceptance of model,
coding or publication behavior (see [live-test-rules.md](live-test-rules.md)).
Stub scenarios live in `tests/live/scenarios/stub/` and steer the stub with
directives such as `STUB_REPLY` and `STUB_RECALL` (see
[the model stub](../apps/model-stub/README.md)).

## 1. What you need

- A Linux Docker host with Docker Compose 2.24 or newer. The coding sandbox
  needs the host capabilities described in
  [native-answer.md](native-answer.md#native-deployment-with-a-coding-workspace).
- Node 26 and npm, with `npm ci` run once in the checkout.
- A Slack workspace where you may create two apps and a test channel.
- For gateway mode, the operator supplies the designated direct test
  connection credentials. Anthropic and OpenAI each use a file with one
  API key. Vertex uses a Google Cloud service-account JSON file.
  Stub mode needs the settings UI HTTPS origin and runtime password. Only gateway mode needs provider credentials for the active routes.
- For the gateway suite (T5) only: a GitLab test group and project. See
  [gitlab.md](gitlab.md).
- An HTTPS origin and a reverse proxy on the host for the settings UI. Slack's
  OAuth callback must reach it.

The full gateway suite also requires the four instances and fixtures in the
[service-tools prerequisites](testing.md#service-tools-prerequisites). Setup is covered by
[atlassian.md](atlassian.md), [datadog.md](datadog.md),
[cloudflare.md](cloudflare.md) and [slack-tool.md](slack-tool.md).

## 2. Create the instance directory

Keep the instance outside the checkout. Every `test:stack:*` and
`test:native:live` command names it with `--instance-dir`.

```text
/absolute/test-instance/
├── .env.testing      application env of the test instance       (0600)
├── .env.e2e          harness sender and fixtures, driver only   (0600)
├── secrets/          runtime password and model provider credentials (step 5)
├── admin-store/      settings SQLite store (step 5)
├── model-mode        mode of the last test:stack:up (written by it)
└── artifacts/        reports written by the driver
```

```sh
D=/absolute/test-instance
mkdir -p "$D" && chmod 0700 "$D"
cp .env.example "$D/.env.testing"
cp .env.e2e.example "$D/.env.e2e"
chmod 0600 "$D"/.env*
```

The driver refuses a `.env.e2e` that others can read. It checks this only
where the instance directory's file system keeps POSIX permission bits; it
probes for them, and NTFS on Windows does not keep them. There, restrict
both env files to your account with an ACL, for example
`icacls <file> /inheritance:r /grant:r "${env:USERNAME}:F"`.

`.env.testing` must carry the same variable names as `.env.example`.
`npm run env:parity -- --instance-dir "$D"` checks this.

Before any live or stub run, the operator confirms the test Slack app token
and GitLab and Atlassian hosts are separate from production. Record confirmation
without values. Env-name parity does not check isolation.

## 3. Create the Slack apps

You need two Slack apps in the same workspace.

**The app under test.** Every contributor needs their own test app: Slack
splits a Socket Mode app's events between all connected adapters, so two test
stacks on one app would each see only part of a conversation. Its OAuth
callback is also specific to your `ADMIN_PUBLIC_URL`.

1. Set `ADMIN_PUBLIC_URL` (the HTTPS origin of your settings UI, step 7) and
   `SUPPORT_AGENT_INSTANCE` in `.env.testing`.
2. Generate your manifest. It fills the callback and names the app
   `support-agent-<SUPPORT_AGENT_INSTANCE>`; `--name` picks another name:

   ```sh
   npm run -s slack:manifest -- --instance-dir "$D" > "$D/slack-app-manifest.json"
   ```

3. On api.slack.com/apps, choose **Create New App → From a manifest** and
   paste the file. For an existing app, paste it on the app's **App Manifest**
   page instead; its tokens and credentials stay valid.
4. Under **Basic Information → App-Level Tokens**, create a token with the
   `connections:write` scope. It is `SLACK_APP_TOKEN` (`xapp-…`).
5. Under **Basic Information → App Credentials**, copy the **Client ID** and
   **Client Secret** into `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`. Do not
   install the app here; the settings service installs it in step 9.

If you change `ADMIN_PUBLIC_URL` later, regenerate the manifest and paste it
again.

**The harness sender.** The live driver posts as a **separate Slack app's
bot**. It cannot post as a user or as the app under test. Create a minimal app
with these bot token scopes:

| Scope                                                     | Used for                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `chat:write`                                              | Posting scenario prompts; editing and deleting the sender's own messages (stub `message-lifecycle.json`) |
| `channels:history` (public) or `groups:history` (private) | Reading the thread with `conversations.replies`                                                          |
| `files:write`, `files:read`                               | Uploading inputs and downloading exports (`coding-files`) and `answer.md` (`long-reply`)                 |

Install it to the workspace and keep its bot token (`xoxb-…`) for `.env.e2e`
only. Create a test channel and invite both bots to it.

Record the sender's IDs; the settings service needs them in step 9. Keep the
token out of the command line:

```sh
umask 077; T=$(mktemp -d)
read -rs -p 'Sender bot token: ' TOK; echo
printf 'Authorization: Bearer %s\n' "$TOK" > "$T/h"; unset TOK
curl -sS -H @"$T/h" https://slack.com/api/auth.test | grep -o '"\(team_id\|user_id\|bot_id\)":"[^"]*"'
rm -rf "$T"
```

`team_id` is `E2E_SLACK_TEAM_ID`. `bot_id` (`B…`) and `user_id` (`U…`) are the
sender's IDs. The test channel's ID (`C…` or `G…`, from the channel details)
is `E2E_SLACK_CHANNEL_ID`.

## 4. Build the images

Build every image with the same tag, one at a time. Check free disk space first:

```sh
TAG=$(git rev-parse --short=12 HEAD) # build from a clean checkout
for target in native-coding adapter cli-runtime admin egress model-stub; do
  docker build -f deploy/Dockerfile --target "$target" -t "support-agent/$target:$TAG" .
done
docker pull postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
```

`test:stack:up` never builds or pulls. Every image must exist locally. The
`model-stub` image is needed in stub mode only.

## 5. Secrets and the settings store

The agent runs as UID 0 without `DAC_OVERRIDE`, so its secret files must be
owned by root. The settings image runs as UID 1000.

```sh
umask 077
mkdir -p "$D/secrets" "$D/admin-store"
openssl rand -hex 24 > "$D/secrets/runtime-password"   # at least 24 characters
"${EDITOR:-vi}" "$D/secrets/anthropic"                  # operator enters one test API key
sudo chown -R root:1000 "$D/secrets" && sudo chmod 0750 "$D/secrets"
sudo chmod 0640 "$D/secrets/"*
sudo chown 1000:1000 "$D/admin-store"
```

The operator enters one API key in the editor. Keep it out of chat and
command lines. The stub uses a fixed synthetic credential for its internal
endpoint. The settings store keeps the Slack installation and encrypted tool
credentials. Back it up with the
[admin snapshot script](../deploy/docker/admin-backup.sh); never delete it as
part of testing.

## 6. Fill `.env.testing`

Generate the internal tokens and keys with `openssl rand -hex 32`. Use a
separate value for each.

| Key                                                                                 | Value                                                                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `COMPOSE_PROJECT_NAME`                                                              | e.g. `support-agent-test`; lowercase, distinct from any other instance                    |
| `SUPPORT_AGENT_INSTANCE`                                                            | Instance name, e.g. `test`                                                                |
| `NATIVE_IMAGE_TAG`                                                                  | `$TAG` from step 4                                                                        |
| `NATIVE_FRONTEND_SUBNET`, `NATIVE_TOOLS_SUBNET`, `NATIVE_DB_SUBNET`                 | Three distinct unused private subnets, e.g. `172.30.10.0/24`, `…11.0/24`, `…12.0/24`      |
| `GITLAB_HOSTS`                                                                      | Test GitLab host (required)                                                               |
| `ATLASSIAN_SITES`, `DATADOG_SITES`, `CLOUDFLARE_HOSTS`                              | Optional; see the tool guides                                                             |
| `NATIVE_RUNTIME_PASSWORD_FILE`                                                      | `$D/secrets/runtime-password`                                                             |
| `NATIVE_ANTHROPIC_API_KEY_FILE`                                                     | Host path to the test Anthropic key file when Anthropic is active                         |
| `NATIVE_OPENAI_API_KEY_FILE`                                                        | Host path to the test OpenAI key file when GPT is active                                  |
| `NATIVE_VERTEX_CREDENTIALS_FILE`, `NATIVE_VERTEX_PROJECT`, `NATIVE_VERTEX_LOCATION` | Test service-account JSON, project and location such as `global` when Vertex is active    |
| `SUPPORT_AGENT_SERVICE_TOKEN`, `ADMIN_INTERNAL_TOKEN`, `CLI_RUNTIME_TOKEN`          | Random tokens                                                                             |
| `SLACK_APP_TOKEN`                                                                   | Test app's `xapp-…` token                                                                 |
| `MODEL_CATALOG`                                                                     | One JSON array, e.g. `[{"key":"sonnet","route":"anthropic","model":"claude-sonnet-5-5"}]` |
| `MODEL_DEFAULT_KEY`                                                                 | One of the keys, e.g. `sonnet`                                                            |
| `ADMIN_PUBLIC_URL`                                                                  | The settings UI's HTTPS origin, e.g. `https://admin-test.example.com`                     |
| `ADMIN_HOST_PORT`                                                                   | Loopback port for your reverse proxy, e.g. `9883`                                         |
| `ADMIN_STORE_DIR`                                                                   | `$D/admin-store`                                                                          |
| `ADMIN_STORE_KEY`, `ADMIN_SESSION_KEY`                                              | Two different 64-hex-character keys                                                       |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`                                            | Test app's OAuth client ID and secret                                                     |
| `NATIVE_WEB_RUNTIME_URL`, `WEB_RUNTIME_TOKEN`, `NATIVE_WEB_NETWORK`                 | Empty unless you have a web runtime (all three or none)                                   |
| `NATIVE_OBSERVABILITY_SOURCE`, `NATIVE_OBSERVABILITY_PASSWORD_FILE`                 | Empty, or see [shared telemetry](native-answer.md#shared-telemetry)                       |

For direct fetch, supply the existing isolated service's base URL, its transport
token and the existing external Docker network on which the agent can reach
it. The service must accept authenticated `POST /fetch` requests and be able
to fetch the scenario URL. Compose attaches the agent to that network.
For hosted search, enable `"webSearch":true` on the selected model's catalog
entry and assign the ready `webSearch` instance (the managed driver does the
assignment). These scenarios have independent prerequisites.

Values are literal. Leave no `<operator: …>` placeholders: the tooling refuses
them as missing. Keep `ADMIN_STORE_KEY` safe outside the instance as well:
losing it makes every stored credential unreadable. Never put the harness
sender token in this file.

```sh
npm run env:parity -- --instance-dir "$D"
```

Leave the inactive connection settings empty. Use `anthropic`, `openai`,
`vertex-claude` or `vertex-gemini` as the route. Both Vertex routes use
the same project, location and JSON file. `webSearch` defaults off.
Vertex Claude hosted search requires authorization for downstream Brave
processing and project policy that permits the feature. Gemini grounding
is unavailable in this release.

## 7. HTTPS for the settings UI

The `admin` service publishes its UI on `127.0.0.1:$ADMIN_HOST_PORT` only.
Point your reverse proxy at it:

- Serve `ADMIN_PUBLIC_URL` over HTTPS and forward with
  `X-Forwarded-Proto: https`.
- Never forward `/internal/*`: the agent, adapter and CLI runtime use those
  routes over the private network (see [authorization.md](authorization.md#ingress)).
- In the test Slack app, register `<ADMIN_PUBLIC_URL>/slack/oauth/callback`.

## 8. Provision and start

For a fresh project only:

```sh
npm run test:stack:up -- --instance-dir "$D" --provision
npm run test:stack:ps -- --instance-dir "$D"
```

This starts PostgreSQL, provisions the `native_answer` database and role once,
then starts the egress proxy, the settings service, the agent, adapter and
CLI runtime in gateway mode. A project that already has containers, or a
database that already exists, is refused. Inspect it instead of resetting it.

Later starts use `test:stack:up` without `--provision`. Add
`--model-mode stub` to start `model-stub` before the agent instead of using
the direct providers. The driver's `--switch-mode` does this for a stub run and
returns to gateway mode afterwards:

```sh
npm run test:stack:up -- --instance-dir "$D" --model-mode stub
```

Stop with `test:stack:down`, which drains first, stops the stub after the
agent and keeps every volume, store and the recorded mode. See
[testing.md](testing.md#the-test-instance-t4-and-t5).

Run exactly one adapter per Slack app. Never start a second Socket Mode
receiver for the test app.

## 9. Configure the settings service

Create the first administrator in the test admin container listed by
`test:stack:ps`. Set `COMPOSE_PROJECT_NAME` in this shell to the test project
name from step 6. The command prompts for the password:

```sh
docker exec -it "$COMPOSE_PROJECT_NAME-admin-1" node apps/admin/dist/cli.js create-admin test-admin
```

Sign in at `ADMIN_PUBLIC_URL`, then:

1. **Pair the workspace:** **Workspaces → Add to Slack**, then whitelist the
   installation. Only whitelisted installations reach the application.
2. **Enable the test channel** in the workspace's channel settings.
3. **Register the harness sender:** on **Workspaces**, open **Test sender for
   <workspace>** and enter the sender's bot ID (`B…`), user ID (`U…`) and the
   test channel ID from step 3. The application then accepts that one bot in
   that one channel as if it were a person. The app's own bot is refused.
   Leave this empty in production.
4. **Create tool instances (gateway suite only)** on the workspace's
   **Tools** page, one test instance per kind you want to test, with test
   credentials. The stub suite needs none. Use [gitlab.md](gitlab.md) for the
   GitLab instance and the other tool guides as needed. Wait for `ready`.
   Keep one ready instance per kind (GitLab: one per host); if there are
   more, assign the one to use to the test channel.
5. **Create the API token for the driver:** on **API tokens**, create a token
   named for example `e2e-<device>` and copy the value shown once into
   `.env.e2e` as `E2E_ADMIN_TOKEN` (step 10). Both suites need it: the stub
   suite's `channel-settings.json` changes the channel's settings with it,
   and the driver gives the test channel each scenario's tools (none for a
   stub scenario) and restores the assignment afterwards; you do not assign
   tools by hand. Without it, `channel-settings.json` is BLOCKED; assign
   tools yourself and run only the gateway scenarios that match (`--tools`).

## 10. Run the scenarios

Fill `.env.e2e` (see [`.env.e2e.example`](../.env.e2e.example)): the sender
token, team and channel IDs from step 3 and `E2E_ADMIN_TOKEN` from step 9;
for the gateway suite also the GitLab test project (step 11) (see
[scenario prerequisites](testing.md#scenario-prerequisites)).
`channel-settings.json` also needs two model keys with different model IDs in
`.env.testing`'s `MODEL_CATALOG`. The file must stay mode 0600. First
validate the configuration for the recorded mode (gateway after step 8) without contacting Docker, Slack or the providers. A missing fetch transport blocks the fetch scenario even during configuration validation:

```sh
npm run test:native:live -- --instance-dir "$D" --suite gateway
```

The stub suite (T4) on the instance in its resting gateway mode: the driver
switches to stub mode, runs the suite and switches back:

```sh
npm run test:native:live -- --instance-dir "$D" --suite stub --run --switch-mode
```

The gateway suite (T5), after the designated provider is confirmed available:

```sh
npm run test:native:live -- --instance-dir "$D" --suite gateway --run --gateway-ready
```

To qualify a non-default route, the operator selects its key on the test
channel or its workspace default before running the scenario. Supply
`--model-key <key>` to verify that selection. The report records the
resolved route, model, connection identity and inference observations.

In the gateway suite, add `--tools none` to run only the scenarios without
tools, or `--tools gitlab` (a comma list of kinds) to add the scenarios that
need only those kinds (see [tool scopes](testing.md#tool-scopes)). Every stub
scenario runs without tools.

If the driver prints `MODEL MODE NOT RESTORED`, the instance stays in the
state it names. Wait until `test:stack:ps` shows it idle and run the two
commands it prints (`test:stack:down`, then `test:stack:up` with the original
mode).

A suite writes `$D/artifacts/native-live/suite-<id>/summary.json` with a link
to each scenario report. It skips a scenario that already passed with the
same resolved scenario, image IDs and selected model identity; add `--rerun` to run it anyway. To run one
scenario, use `--scenario <file>` instead of `--suite`. Exit code 0 means
passed, skipped or configuration valid, 1 failed and 2 blocked.

Each mode runs only its own scenarios. Without `--switch-mode`, a stub start
blocks a gateway scenario (`gateway_mode_required`), and a gateway start
refuses a stub scenario (`stub_mode_required`), because directives sent to a
real model prove nothing. The report records `modelMode` and
`modelRequests`; a stub report also says `deterministic, not live
acceptance`.

The driver checks that the stack is running and idle (it waits up to 120 s
for an earlier run's work to settle), and that the settings
service authorizes the exact sender and channel. It compares `auth.test` with
the registered bot and user IDs, then posts as the sender. With
`E2E_ADMIN_TOKEN` it first gives the test channel exactly the ready tool
instances the scenario needs (none for a stub scenario) and restores the
original assignment at the end,
also after a failure or Ctrl-C (see
[tools per scenario](testing.md#tools-per-scenario)). Without the token, a
missing or not ready assignment is BLOCKED.

Which scenarios need which tools, tokens and fixtures, and what each shows,
is listed under [scenario prerequisites](testing.md#scenario-prerequisites).

`message-lifecycle.json` edits and deletes only messages the sender posted
in the same run. The report keeps each message's timestamp and hash from
before the change.

`channel-settings.json` disables the channel, blocks the sender, switches to
another model key and sets a channel prompt, one step at a time. The driver
reads the exact settings first and restores them at the end, also after a
failure. The report keeps both states. If the restore cannot be confirmed,
the run fails with `channel_settings_restore_unconfirmed`, and the report's
`channelSettings.restoreByHand` names the values to set by hand.

The answer scenarios (every stub scenario) need a channel without tools, the
gateway tool scenarios a channel with them. With `E2E_ADMIN_TOKEN` the driver
sets this per scenario. Without it, a suite blocks the scenarios whose
assignments do not match; run the matching gateway group with `--tools`.
Coding scenarios leave an unmerged merge request in the test project. Keep it
as evidence. Never merge it or delete messages other than the stub suite's own-message
steps (see [live-test-rules.md](live-test-rules.md)).

## 11. The GitLab test project

For the gateway suite only. The coding scenarios name the project through
placeholders:
`{{gitlab.host}}`, `{{gitlab.project}}`, `{{gitlab.projectId}}` and
`{{gitlab.targetBranch}}`. The driver fills them from `.env.e2e`:

```dotenv
E2E_GITLAB_HOST=gitlab.example.com
E2E_GITLAB_PROJECT=group/project
E2E_GITLAB_PROJECT_ID=12345
E2E_GITLAB_TARGET_BRANCH=main
```

`gitlab-discovery.json` also needs `{{gitlab.traceJobId}}`,
`{{gitlab.traceHeadMarker}}` and `{{gitlab.traceTailMarker}}`: a finished CI
job of the project whose trace is longer than 48000 bytes, and one marker line
only in its first and one only in its last 48000 bytes
(`E2E_GITLAB_TRACE_JOB_ID`, `E2E_GITLAB_TRACE_HEAD_MARKER`, `E2E_GITLAB_TRACE_TAIL_MARKER`). A scenario that uses a placeholder whose value is
missing is BLOCKED (`missing_E2E_GITLAB_*`). The host must be in `GITLAB_HOSTS` and match the
channel's GitLab instance. The project ID is on the project's overview page.

The discovery scenario expects the target branch to be the project’s default branch. Each fixture marker line must begin with `trace-marker`. Protect the target branch against direct pushes. Its
verification must run without network access and without installing
dependencies (see [gitlab.md](gitlab.md#publication)).

## The egress proxy

The `egress` service decides by the source network of each connection, on
port 443 only:

- **From the frontend network** (adapter, settings service): the configured Slack hosts.
- **From the tools network** (agent, CLI runtime): the above plus the configured model-provider hosts in gateway mode,
  `GITLAB_HOSTS`, `api.atlassian.com` when `ATLASSIAN_SITES` is set,
  `mcp.<site>` for `DATADOG_SITES`, `CLOUDFLARE_HOSTS` and the package
  registries.

The agent and CLI runtime reach it as `egress-tools`, an alias that exists
only on the tools network, so their tunnels get the tools policy. In stub
mode the agent reaches `model-stub` directly on the tools network, as it does
every Compose service name; the proxy never admits it. When you change a host
list, recreate the stack with `test:stack:down` and `test:stack:up`.

## Troubleshooting

| Error                                                                            | Cause and fix                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<KEY> is required`                                                              | Empty or placeholder value in `.env.testing`                                                                                                                                          |
| `<KEY> is invalid`                                                               | Malformed subnet, port or URL                                                                                                                                                         |
| `gateway_mode_required` / `stub_mode_required`                                   | The scenario's `model` does not match the mode of the last `test:stack:up`; add `--switch-mode`                                                                                       |
| `model_mode_switch_failed`                                                       | `test:stack:down` or `up` failed during `--switch-mode`; the summary's `modelModeSwitch.error` names it. The driver still tried to restore the mode                                   |
| `MODEL MODE NOT RESTORED`                                                        | The switch back failed; the instance is in `modelModeSwitch.leftIn`. Wait until it is idle and run the printed `restoreByHand` commands                                               |
| `native_test_work_not_idle`                                                      | Earlier work did not settle within 120 s; the report's `before` shows what is active. Check `test:stack:ps`, wait or inspect the run                                                  |
| `native_inspection_message_identity_missing`                                     | The agent's inspection has no `messageTs`; rebuild the `native-coding` image used by the `native-answer` service from the current checkout                                            |
| `native_answer_timeout_no_retry`                                                 | The step's own run did not deliver in time; `inspectionRefused` on the attempt names a refusal code if inspection was refused                                                         |
| `interrupted`                                                                    | Ctrl-C or SIGTERM; the driver restored tools, settings and mode (check the report)                                                                                                    |
| `model_mode_unknown_start_with_test_stack_up`                                    | No mode is recorded yet; start the stack with `test:stack:up`                                                                                                                         |
| `model_stub_running_in_gateway_mode`                                             | A stub from an earlier stub start still runs; `test:stack:down`, then `test:stack:up`                                                                                                 |
| `gateway_gate_fields_required`, `invalid_gate_*`, `gateway_turn_budget_exceeded` | A gateway scenario lacks a valid `covers` or `budget` (see [the gate](testing.md#the-live-scenario-gate-t5))                                                                          |
| `model_request_budget_exceeded`                                                  | The run used more model requests than the scenario's budget: a failed run, not a prerequisite                                                                                         |
| `model_request_count_unavailable` / `model_request_count_unsettled`              | The settings service's cost ledger did not answer or did not settle; check the agent's ledger posts                                                                                   |
| `gateway_covers_duplicate`                                                       | Two gateway scenarios claim the same `covers` entry; merge them                                                                                                                       |
| `expected_answer_fact_missing`                                                   | Compare the delivered answer with the scenario's expected fixture and verify that the token account can find it. Readiness can pass on an empty project or space.                     |
| `native_request_not_successful`                                                  | Inspect the retained attempt, tool invocation and delivery receipt to find the last completed step. A failure before dispatch gives no evidence that the upstream token was rejected. |
| `selected_model_hosted_search_unavailable`                                       | Enable hosted search on the selected test model and use a supported route for the web-search scenario.                                                                                |
| `ready_<kind>_instance_required`                                                 | Gateway suite: no ready instance of that kind (GitLab: on `E2E_GITLAB_HOST`) exists; create one with test credentials and wait for `ready`                                            |
| `stub_scenario_needs_no_tools`                                                   | A stub scenario names a tool (`requires`, `webSearch`, `webFetch` or a publication); tool reads belong in T3 `tools` or a gateway scenario                                            |
| `ambiguous_<kind>_instance`                                                      | Several ready instances of that kind; assign the one to use to the test channel                                                                                                       |
| `channel_tool_assignment_unconfirmed`                                            | The settings service did not show the assignment the driver set; the driver restored the original                                                                                     |
| `channel_tools_unreadable` / `tool_instances_unreadable`                         | The settings service API returned an unexpected view; check the driver and admin API versions together. Use the current driver and rebuild the test images from the same revision     |
| `no_scenario_in_tool_scope`                                                      | `--tools` selects no scenario of the suite                                                                                                                                            |
| `ready_<kind>_assignment_required`                                               | Gateway suite without `E2E_ADMIN_TOKEN`: assign a ready instance of that tool kind to the test channel, or use `--tools`                                                              |
| `missing_E2E_ADMIN_TOKEN` / `admin_api_http_<status>`                            | Create an API token in the test settings service and put it in `.env.e2e` (`channel-settings.json` and managed tools need it)                                                         |
| `channel_tool_restore_unconfirmed`                                               | The driver could not confirm the original tool assignment; set the report's `toolAssignment.restoreByHand` in the settings service                                                    |
| `channel_settings_restore_unconfirmed`                                           | Set the values in the report's `channelSettings.restoreByHand` in the settings service by hand                                                                                        |
| `alternate_model_required`                                                       | `MODEL_CATALOG` needs a second key with a different model ID                                                                                                                          |
| `stub_suite_only_step`                                                           | Message edits, deletes, refusals and channel settings run only in stub scenarios                                                                                                      |
| `answer_file_*`                                                                  | The long answer's `answer.md` is missing, not shared in the thread or has other bytes than the retained answer                                                                        |
| `… must differ`                                                                  | Two of the three subnets are equal                                                                                                                                                    |
| `ADMIN_STORE_DIR must name an existing directory`                                | Create it (step 5)                                                                                                                                                                    |
| `required image unavailable`                                                     | Build or pull the images (step 4)                                                                                                                                                     |
| Slack: "redirect_uri did not match any configured URIs"                          | The app lacks your callback; regenerate the manifest (step 3) and paste it on the app's **App Manifest** page                                                                         |
| `harness_env_must_be_private`                                                    | `chmod 0600 "$D/.env.e2e"`                                                                                                                                                            |
| `missing_E2E_SLACK_*`, `missing_E2E_GITLAB_*`                                    | Value missing or malformed in `.env.e2e`                                                                                                                                              |
| `sender_credential_not_harness_only`                                             | The sender token also appears in `.env.testing`                                                                                                                                       |
| `designated_channel_not_trusted`                                                 | The test sender's channel in the settings service differs from `E2E_SLACK_CHANNEL_ID`                                                                                                 |
| `sender_identity_not_designated`                                                 | `auth.test` team, bot or user ID differs from the registered sender, or the token is the app's own                                                                                    |
| `answer_fixture_requires_channel_without_tools`                                  | Without `E2E_ADMIN_TOKEN`: unassign all tools from the test channel, or add the token                                                                                                 |
| `coding_fixture_requires_publication_verification`                               | Without `E2E_ADMIN_TOKEN`: assign exactly one ready GitLab instance whose host matches the scenario                                                                                   |
| `ready_search_assignment_required` / `ready_fetch_assignment_required`           | Without `E2E_ADMIN_TOKEN`: assign a ready `webSearch` / `webFetch` instance                                                                                                           |
| `direct_fetch_transport_required`                                                | Provide the isolated fetch service and all three transport settings in step 6                                                                                                         |
| `invalid_native_scenario`                                                        | A malformed scenario, or a prompt containing `<operator:`, `<@` or `<!`                                                                                                               |
