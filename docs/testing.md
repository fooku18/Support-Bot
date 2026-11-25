# Testing

The tests form a ladder of six tiers. Each tier makes more of the system real
and costs more to run. Run them from the bottom: a failure low on the ladder
is cheaper to find.

## The test ladder

| Tier                      | Command                                                                                                | Where it runs                                                    | What is real                                                                                                                                                                                           | Duration               | Cost                                   | When to run                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **T0** Static checks      | `npm run typecheck:all`, `npm run lint`, `npm run format:check`                                        | Any machine                                                      | Source, types and generated protocol clients                                                                                                                                                           | about 18 s             | Free                                   | Before every commit                                                                                                            |
| **T1** Package tests      | `npm run test:packages`                                                                                | Any machine                                                      | Units of every workspace; Slack, model providers and services are synthetic                                                                                                                            | about 46 s             | Free                                   | Before every commit                                                                                                            |
| **T2** Root tests         | `npm test`                                                                                             | Any machine                                                      | Compose files, env checks, agent hooks, stack and driver logic with a fake `docker`                                                                                                                    | about 5 s              | Free                                   | Before every commit                                                                                                            |
| **T3** Native integration | `npm run test:native:integration -- --suite <suite>` (see [the suites](#native-integration-suites-t3)) | A Docker host                                                    | PostgreSQL, the Mastra agent and durable runs; for some suites the `native-coding` image; for `tools` the `cli-runtime` and `egress` images. Slack, providers, Git and the tool services are synthetic | 10 s to 40 s per suite | Free                                   | Before a commit that changes the agent, storage, policy, Slack intake or delivery, a tool, the egress proxy or the CLI runtime |
| **T4** Stub stack         | `npm run test:native:live -- --instance-dir D --suite stub --run --switch-mode`                        | A test instance; the driver switches it to stub mode             | The whole Compose stack from the built images, the Slack test app and the settings service; no tool instances; the model is scripted                                                                   | a few minutes          | No model cost; real Slack calls        | After a change to Slack, delivery, settings or images, before you ask for review                                               |
| **T5** Gateway live       | `npm run test:native:live -- --instance-dir D --suite gateway --run --gateway-ready`                   | A test instance in gateway mode with direct test provider access | Everything, including the model                                                                                                                                                                        | minutes per scenario   | Model tokens; bounded by each `budget` | Before release of a change to intake, delivery, orchestration, context, inference, coding or publication                       |

The [runtime image workflow](../.github/workflows/publish-runtime-image.yml) builds, smoke-tests and publishes the unified image. Run the required tiers locally before each commit. The pre-commit hook only runs ESLint and Prettier on staged files.

### Which tiers a change needs

- Every commit: T0, T1 and T2 must pass on your machine.
- A change to the agent, storage, authorization, Slack intake or delivery: T3
  as well, at least the `application` suite. Add `coding` for coding,
  publication, exports or the Workspace, `backup` for the store schema or the
  Workspace layout, and `telemetry` for observability.
- A change to a tool, the egress proxy or the CLI runtime: T3 `tools`.
- A change to the stack, images or settings service: T4 on a test instance
  before review.
- A change to Slack intake or delivery, task orchestration, context,
  inference, coding or publication: T5 before release (see
  [AGENTS.md](../AGENTS.md)). Coding and publication changes need a coding
  scenario with published-file assertions.

T4 results are deterministic qualification, not live acceptance. Only T5
gives live acceptance. Keep live acceptance BLOCKED until a T5 run passes.

## What each tier needs

### T0 to T2

- Node 26 and npm.
- `npm ci` in the checkout.

### T3

- Everything for T0 to T2.
- Docker.
- The pinned PostgreSQL image in the local cache:
  `docker pull postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3`.
- 2 GiB of free disk space.
- For `coding`, `backup` and `telemetry`: a local `native-coding` image built
  from your checkout, and `openssl`. Use your own tag, not the tag of a
  running instance:
  `docker build -f deploy/Dockerfile --target native-coding -t support-agent/native-coding:<tag> .`
- For `tools`: local `cli-runtime` and `egress` images with one tag, built the
  same way (`--target cli-runtime`, `--target egress`), and `openssl`. No tool
  account, credential or network access is needed.

### T4

Follow the [live test setup runbook](live-test-setup.md):

- a test instance directory outside the checkout
  ([step 2](live-test-setup.md#2-create-the-instance-directory));
- your own Slack test app and the sender app
  ([step 3](live-test-setup.md#3-create-the-slack-apps));
- the built images, including `model-stub`
  ([step 4](live-test-setup.md#4-build-the-images));
- the secrets, the settings store, `.env.testing` and HTTPS for the settings
  UI ([steps 5 to 7](live-test-setup.md#5-secrets-and-the-settings-store));
- the stack started ([step 8](live-test-setup.md#8-provision-and-start)). It
  rests in gateway mode; `--switch-mode` switches it to stub mode for the
  suite and back (see [the test instance](#the-test-instance-t4-and-t5));
- the settings service paired and whitelisted, the test channel enabled and
  the sender registered ([step 9](live-test-setup.md#9-configure-the-settings-service));
- `.env.e2e` with the sender values and `E2E_ADMIN_TOKEN`
  ([step 10](live-test-setup.md#10-run-the-scenarios)).

T4 needs only Docker and the Slack test app: no stub scenario uses a tool
instance, a tool credential or a GitLab project, so it runs fully on any
device. Tool reads through the CLI runtime and the egress proxy are T3
`tools`; with real services they are T5.

`E2E_ADMIN_TOKEN` is still needed: `channel-settings.json` changes the test
channel's settings through the settings service's API and is BLOCKED
(`missing_E2E_ADMIN_TOKEN`) without it. With the token the driver also
unassigns any tool from the test channel for each stub scenario and restores
the assignment afterwards. The scenario also needs two `MODEL_CATALOG` keys
with different model IDs in `.env.testing`.

### T5

- Everything for T4, with the stack started in gateway mode.
- One operator-approved direct test connection used by `MODEL_CATALOG`
  ([steps 5 and 6](live-test-setup.md#6-fill-envtesting)).
- For the tool and coding scenarios: test tool instances with their test
  credentials, the GitLab test project and the service fixtures; see
  [scenario prerequisites](#scenario-prerequisites).

Without tool instances only `answer-continuity.json` runs (`--tools none`).

For route qualification, run the baseline gateway suite first. An operator
can preselect another catalog key in the designated channel and run the
applicable scenario with `--model-key <key>`. The driver checks its route,
model and nonsecret connection identity, and requires the same identity on
every run's inference observations. Prior passes are reused only when that
identity, scenario hash and image IDs match.

### Scenario prerequisites

Beyond the tier's base setup, scenarios need up to three more things. A
missing one makes the scenario BLOCKED (exit code 2), never skipped or
passed; the report names the missing item. Only the first applies to the
stub suite.

**1. The settings-service API token, `E2E_ADMIN_TOKEN` in `.env.e2e`.** The
driver uses it to call the test settings service's API as an automation
client: to give the test channel exactly the tools each scenario needs (see
[tools per scenario](#tools-per-scenario)), to change the channel's settings
in a stub step, and to restore both. `channel-settings.json` (stub) needs it.
Without it, the driver checks the channel as it is.

- To create it, sign in to the **test** settings service (`ADMIN_PUBLIC_URL`
  of `.env.testing`), open **API tokens**, create a token named for example
  `e2e-<device>`, and copy the value shown once into `.env.e2e` as
  `E2E_ADMIN_TOKEN=<value>`. The operator does this; an agent never handles
  the value.
- It is a token of the test settings service only, never of production, and
  it must appear in no other env file. Revoke it on the same page when a
  device stops running tests.

**2. Tool instances (gateway suite only).** Once, the operator creates one
test instance per tool kind the gateway suite should cover, with its test
credentials, on the
workspace's **Tools** page of the test settings service (see
[gitlab.md](gitlab.md), [atlassian.md](atlassian.md),
[datadog.md](datadog.md), [cloudflare.md](cloudflare.md),
[slack-tool.md](slack-tool.md)), and waits for `ready`. With
`E2E_ADMIN_TOKEN` the driver assigns them; the operator does not. Keep one
ready instance per kind (GitLab: one per host), or assign the one to use to
the test channel.

**3. Fixtures (gateway suite only).** GitLab project and trace values live in
`.env.e2e`. Use the designated test group or project token with Developer
access, `api` for REST and `write_repository` for Git over HTTPS. Verify the
project ID, default branch and finished trace job. [GitLab setup](live-test-setup.md#11-the-gitlab-test-project)

#### Service-tools prerequisites

One scenario requests all four tool kinds up front and runs five turns in
order. A failed turn stops the later turns. The checked-in scenario owns the
expected IDs and answer facts. [Scenario](../tests/live/scenarios/service-tools.json)

| Turn         | What the operator prepares                                                                                                                                                                                                                       | What the turn checks                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira         | Approved test site in `ATLASSIAN_SITES`, matching cloud ID and email, Jira-scoped token with `read:jira-work` and `read:jira-user`. The token account can find the issue by summary.                                                             | `KAN-1` and `lunar lighthouse handoff`.                                                                                                                 |
| Confluence   | Same site and account, separate Confluence-scoped token. Enable the v2 spaces probe, CQL search and v2 page reads. Publish a searchable page visible to that account. [Scope list and rotation](atlassian.md#2-create-the-confluence-read-token) | Page `123456` and title `lunar lighthouse handoff`.                                                                                                     |
| Datadog      | Approved bare site in `DATADOG_SITES`, read-only PAT or SAT with `mcp_read`, `logs_read_data` and `logs_read_index_data`. The assigned catalog must expose `search_datadog_logs`. [Token setup](datadog.md#1-create-the-token)                   | Search `env:prod status:error` over the last five minutes, at most 100 entries. Zero results are valid. Report query, window, count and tool name only. |
| Cloudflare   | `CLOUDFLARE_HOSTS=api.cloudflare.com`, Read-only API token, Zone Read and at least one visible zone. A configured account ID also needs account visibility. [Token setup and verify endpoints](cloudflare.md#verification)                       | Token status `active`. No traffic, DNS records or analytics fixture is needed.                                                                          |
| Slack lookup | Slack instance for the paired test workspace. Its installed app needs `users:read` and access to the approved fixture user. [Slack setup](slack-tool.md)                                                                                         | Look up the scenario's single user ID and return its real name. No directory or message search.                                                         |

For a different approved Atlassian fixture, the operator confirms its actual
key or numeric page ID and visibility. Update the expected facts before
running the test. Keep the IDs out of the discovery prompts.

#### Tools per scenario

Answer scenarios need a channel without tools, so that a real model must
answer from the conversation alone; tool and coding scenarios need theirs.
A scenario needs the kinds in its `requires`, `webSearch` or `webFetch` when
a step uses it, and `gitlab` when a step publishes. Only gateway scenarios
need tools: the driver refuses a stub scenario that needs one
(`stub_scenario_needs_no_tools`), so in the stub suite it only clears the
channel's tools and restores them.

**With `E2E_ADMIN_TOKEN`**, the driver does this for every scenario it runs:

1. It reads the test channel's exact current assignment and the workspace's
   existing tool instances through the settings service's API.
2. It picks one ready instance of each needed kind. For GitLab it takes the
   instance whose host is the scenario's (`E2E_GITLAB_HOST`). No ready
   instance is BLOCKED (`ready_<kind>_instance_required`). More than one is
   BLOCKED (`ambiguous_<kind>_instance`), unless the channel already has one
   of them assigned; then it uses that one. It never guesses.
3. It sets the channel's assignment to exactly that: nothing for an answer
   scenario, the picked instances for a tool or coding scenario.
4. At the end of the scenario, also after a failure or an interrupt, it
   restores the original assignment, including `codeMode`, `files` and `localExec` when present. The report's `toolAssignment` keeps
   `original`, `target`, `applied` and `restoredState`. If the restore
   cannot be confirmed, the scenario fails with
   `channel_tool_restore_unconfirmed`, and `toolAssignment.restoreByHand`
   lists the instances to assign and the kinds to unassign in the settings
   service.

It only assigns and unassigns existing instances. It never creates, edits or
deletes an instance and never reads or sends a credential.

**Without `E2E_ADMIN_TOKEN`**, the driver checks the channel as it is. An
answer scenario on a channel with tools is BLOCKED
(`answer_fixture_requires_channel_without_tools`), a tool scenario without a
ready assignment of its kind too (`ready_<kind>_assignment_required`). A
device without the token runs the scenarios without tools on a channel
without tools: `--tools none`.

#### Tool scopes

`--tools` chooses which scenarios of a suite run. It matters for the gateway
suite; every stub scenario needs no tool.

| `--tools`         | Runs                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `all` (default)   | Every scenario                                                            |
| `none`            | Only scenarios that need no tool                                          |
| `<kind>[,<kind>]` | Scenarios whose needed kinds are all in the list, and those without tools |

The kinds are `gitlab`, `atlassian`, `datadog`, `cloudflare`, `slack`,
`webSearch` and `webFetch`. The summary records the scope and lists each
other scenario as `not_selected` with reason `tools_outside_scope` and its
`needs`; it never counts as passed or blocked. A scope without any scenario
is BLOCKED (`no_scenario_in_tool_scope`).

```sh
# Without tools: no tool instances, and the lowest model cost.
npm run test:native:live -- --instance-dir D --suite gateway --run --gateway-ready --tools none
# A device with only a GitLab test instance.
npm run test:native:live -- --instance-dir D --suite gateway --run --gateway-ready --tools gitlab
# GitLab and web search.
npm run test:native:live -- --instance-dir D --suite gateway --run --gateway-ready --tools gitlab,webSearch
```

#### Scenario tables

The tools column names the kinds the driver assigns (the `--tools` kinds).

Stub suite (T4), `tests/live/scenarios/stub/`:

| Scenario                 | Tools | Also needs                                  | What it shows                                                                                            |
| ------------------------ | ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `answer-continuity.json` | None  |                                             | Earlier turns and a correction reach the model; another thread's do not                                  |
| `thread-followup.json`   | None  |                                             | Working indication, an unmentioned follow-up and a mention in a thread                                   |
| `ask-resume.json`        | None  |                                             | `ask_user` suspends the run; `continue <answer>` resumes it                                              |
| `cancel.json`            | None  |                                             | `cancel` stops a running request; no answer arrives; the next request works                              |
| `files.json`             | None  |                                             | A file and a bot-style message with attachment fields and blocks reach the model                         |
| `long-reply.json`        | None  |                                             | A 16000-character answer arrives as a preview and `answer.md`; a follow-up recalls a line past the limit |
| `message-lifecycle.json` | None  |                                             | An edited mention starts nothing; a deleted held request and a deleted root get no answer                |
| `channel-settings.json`  | None  | `E2E_ADMIN_TOKEN`, two `MODEL_CATALOG` keys | A disabled channel and a blocked sender are refused; a model and prompt change take effect               |

Tool reads through the CLI runtime and the egress proxy have no stub
scenario: T3 `tools` proves them with the real images against synthetic
services, and the gateway suite with the real services. That an unassigned
tool is gone at the next run and back once assigned again is T3
(`channel-assignment-applies-at-the-next-run-unassigned-then-restored`).

Gateway suite (T5), `tests/live/scenarios/`:

| Scenario                 | Tools                                         | Also needs                                                                               | What it shows, besides the stub suite                                              |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `answer-continuity.json` | None                                          |                                                                                          | The model applies a correction and keeps another thread out                        |
| `thread-followup.json`   | `gitlab`                                      | `E2E_GITLAB_*`, write access to the test project                                         | Coding, publication, an unmentioned follow-up, a question and its answer on one MR |
| `coding-files.json`      | `gitlab`                                      | `E2E_GITLAB_*`; sender with `files:read` and `files:write`                               | Attachments into a published change and exported files                             |
| `gitlab-discovery.json`  | `gitlab`                                      | `E2E_GITLAB_*` including the trace job                                                   | Typed GitLab reads and the head and tail of a long job trace                       |
| `service-tools.json`     | `atlassian`, `datadog`, `cloudflare`, `slack` | [Service-tools prerequisites](#service-tools-prerequisites)                              | The model picks each read-only service tool                                        |
| `web-search.json`        | `webSearch`                                   | Selected model route supports hosted search and its catalog entry sets `webSearch: true` | Hosted search within the selected provider                                         |
| `web-fetch.json`         | `webFetch`                                    | Reachable isolated fetch runtime, its token and external network (setup step 6)          | Direct page fetch                                                                  |

Coding scenarios leave an unmerged merge request in the test project; keep
it as evidence. The [troubleshooting table](live-test-setup.md#troubleshooting)
maps every BLOCKED code to its fix.

## Local checks (T0 to T3)

```sh
npm run typecheck:all
npm run lint
npm run format:check
SUPPORT_AGENT_TEST_RETAIN_EVIDENCE=1 npm run test:packages
SUPPORT_AGENT_TEST_RETAIN_EVIDENCE=1 npm test
npm run test:native:integration
npm run test:native:integration -- --suite application
npm run test:native:integration -- --suite coding --image-tag <tag>
npm run test:native:integration -- --suite backup --image-tag <tag>
npm run test:native:integration -- --suite telemetry --image-tag <tag>
npm run test:native:integration -- --suite tools --image-tag <tag>
```

For changes to the unified Kubernetes image or dispatcher, run
`sh tests/integration/runtime-image.sh support-agent/runtime:qualification`.
The script builds the `runtime` target, verifies UID 1000 and `isolated-vm`,
exercises all seven entrypoints and checks admin and CLI runtime health with a
read-only root filesystem and dropped capabilities. The Compose gateway suite
uses its own role images. [Runtime deployment guide](kubernetes-runtime.md)

Package tests cover the agent, Slack adapter, settings service, egress proxy
and model stub. Settings-store preservation tests reopen a populated database
from the previous implementation and compare its schema and every table,
including encrypted credential records. Root tests cover deployment refusal
and drain, both agent hooks, the model-mode flag, native runtime dependency
ownership, the scenario driver and shared policy.

### Native integration suites (T3)

`npm run test:native:integration -- --suite <suite>` runs one suite against
fresh PostgreSQL 17 containers. `discovery` is the default. For suites that use
Unix sockets, use a checkout with a short absolute path if the driver reports
that the PostgreSQL socket path is too long.

| Suite         | What runs                                                                                                                                                                                                                                                                                                                        | Needs                                              | Duration | Records |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------- | ------: |
| `discovery`   | Discovery and a cold restart, from source on the host                                                                                                                                                                                                                                                                            | PostgreSQL image                                   | 8 s      |      13 |
| `application` | `discovery`, plus admission, cancellation, policy, shutdown, file inputs, memory, a process killed during a model call and a question resumed in a new process                                                                                                                                                                   | PostgreSQL image                                   | 30 s     |      80 |
| `coding`      | The real provision, application and adapter entrypoints in the `native-coding` image: answers, a read, Code Mode and its limits while another run completes, a start refused without `--no-node-snapshot`, coding and publication to the same MR over HTTPS Git, file inputs and exports; Code Mode from the image's own install | `--image-tag`, `openssl`                           | 35 s     |      22 |
| `backup`      | Answers, questions, an uncertain delivery and coding exports in the image; dump, Workspace archive, restore into a fresh cluster and directory, then inspection and continuation                                                                                                                                                 | `--image-tag`, `openssl`                           | 24 s     |      22 |
| `telemetry`   | The image's telemetry maintenance entrypoint, then the restricted telemetry role, private rows, Studio reads and repeat provisioning                                                                                                                                                                                             | `--image-tag`                                      | 9 s      |       8 |
| `tools`       | The `cli-runtime` and `egress` images against a fake HTTPS upstream: one read per tool kind and five GitLab reads, the egress refusal, credential routing and redaction, foreign, revoked and unassigned instances, read-only refusals                                                                                           | `--image-tag` (`cli-runtime`, `egress`), `openssl` | 20 s     |      19 |

`discovery` and `application` bundle
[`durable-answer-vertical.ts`](../tests/integration/mastra/durable-answer-vertical.ts)
and run each phase in a new Node process. `application` adds:

- admission checks, cancellation, delivery under current authorization and
  shutdown;
- a disabled channel and a blocked member, a changed channel model and
  prompt, a settings change between admission and execution (the admitted
  request ends with the failure notice), a settings change during execution
  (the answer is delivered with the run's model in the footer), a disabled
  channel or blocked sender during execution or before delivery (refused or
  withheld, logged, nothing posted), and the global capacity limit;
- file inputs, their cold resume and corrections;
- a follow-up in a new process that still carries the earlier turns;
- a process killed during a model call (never restarted) and a question
  suspended before a kill and resumed in a new process.

`coding` and `backup` bundle the current entrypoints and
[`native-image-vertical.ts`](../tests/integration/mastra/native-image-vertical.ts).
Each phase runs in a new container of the image, with network `none` and the
same user, capabilities and security options as the Compose service. The
bundles replace the image's own application files, so the image supplies the
OS, Git, bubblewrap and the locked dependencies. PostgreSQL is reached through
a Unix socket in the run folder.

`backup` follows the
[restore recipe](native-answer.md#quiesced-logical-backup-and-fresh-restore):

1. Fill the source: answers, two questions, an uncertain delivery, coding
   exports and a coding question.
2. Compare rows and catalog before and after `pg_dump`. Archive the Workspace
   twice with GNU tar and compare.
3. Stop the source. Create a fresh cluster with a new `native_answer` login
   and a fresh secret, then `pg_restore --create`.
4. Compare rows and catalog with the source. Check that the archive holds no
   roles, passwords or credentials. Extract the Workspace into a fresh
   directory and compare its archive with the source archive.
5. Start the application on the restored store: no inference or send on
   start, current revocation applies, uncertain outcomes stay uncertain, and
   only the owner's explicit action continues a question, once.

`telemetry` bundles
[`telemetry-postgres.ts`](../apps/agent/test/telemetry-postgres.ts) and runs it
on the host. PostgreSQL uses the deployed HBA file.

`tools` bundles
[`native-tools-vertical.ts`](../tests/integration/mastra/native-tools-vertical.ts)
and runs four containers on two internal Docker networks, with the Compose
service's user, capabilities and security options where they are product
services:

- **`cli-runtime`** (the image as built) on the tools network. Its host lists
  admit one GitLab host the proxy does not (`gitlab-unapproved.example.com`).
- **`egress`** (the image as built) on the tools network as `egress-tools`
  and on the outbound network, with the tools policy for the tools subnet.
- **Upstream**: one fake HTTPS server on the outbound network, with the
  network aliases `gitlab.example.com`, `gitlab-unapproved.example.com`,
  `api.atlassian.com`, `mcp.datadoghq.eu`, `api.cloudflare.com` and
  `slack.com`. Its fixtures
  ([`native-tools-upstream.ts`](../tests/integration/mastra/native-tools-upstream.ts))
  hold only the fields the runtime reads. It records each request's method,
  path and query, and which credential the headers carried (names only).
- **Client**: the agent side and a synthetic settings service (`admin`). The
  CLI runtime syncs its instances and synthetic credentials from it and
  reports readiness back; the channel's assignment is compiled with the
  settings service's own compiler. The client calls the agent's real
  read-service binding and Mastra tools.

The run generates a CA and a certificate for those host names with
`openssl`. The CLI runtime trusts the CA through `NODE_EXTRA_CA_CERTS`. Nothing
test-specific is in product code: every test value is configuration.
The checks:

1. Every instance syncs and probes through the proxy: five are ready, the
   unapproved GitLab instance fails (the proxy refused its probe) and one
   outside `GITLAB_HOSTS` is blocked without a credential read.
2. The tool list follows the channel's assignment; an unassigned kind has no
   tool and its handler refuses.
3. One read per kind: Atlassian REST, Datadog MCP, Cloudflare and the Slack
   tool. GitLab has five reads: `get_project`,
   `list_projects`, `list_branches`, `list_merge_requests` and
   `get_repository_file`. Each GitLab case checks the method, the encoded
   path and the query the fake GitLab received, and that the request carried
   only the GitLab credential. `get_repository_file` reads a nested path with
   a space at a branch with a slash. GitLab and Slack echo the credential, and
   the result shows `[redacted]`.
4. Each credential reaches only its own host (and Jira and Confluence tokens
   only their product's paths).
5. The proxy answers `CONNECT` with 403 for the unapproved GitLab host and
   `example.org` from the tools network, and its log records each denial.
6. A foreign workspace, an unknown and a blocked instance are refused before
   any request.
7. A Datadog write tool (left out of the pinned catalog), an Atlassian write
   operation and a Cloudflare `post` are refused without a request.
8. A revoked (disabled) instance is refused at the next call of a running
   binding, and the next run no longer offers it.
9. No retained file holds any form of a credential (raw, base64, Basic).
   Then the synthetic credentials and keys are deleted.

The suite removes its two networks at the end (the stopped containers keep
their configuration in `*.container.json`), because each network takes an
address pool.

No designated credentials, real services or paid calls are used. Each run
writes logs, reports, a compressed logical dump per cluster and a
`summary.json` (pass, duration, record count, image ID) to
`artifacts/native/<suite>/<id>`. Containers and volumes are named
`native-test-<suite>-<id>-*`. They stay stopped; no cleanup runs. Files the
root-run containers create are given back to your user at the end.

Image builds, image scans and the lockfile audit are not automated yet.
Live qualification of the image against Slack and direct model providers is T4 and T5.

## The test instance (T4 and T5)

To set up a test instance from an empty host, follow the
[live test setup runbook](live-test-setup.md). `deploy/compose.yaml` runs the
whole instance: agent, Slack adapter, CLI runtime, PostgreSQL, settings
service and egress proxy, plus the model stub in stub mode.

```sh
npm run test:stack:up -- --instance-dir /absolute/test-instance
npm run test:stack:ps -- --instance-dir /absolute/test-instance
npm run test:stack:down -- --instance-dir /absolute/test-instance
```

`--model-mode` belongs to `up` and is `gateway` by default:

- **`gateway`** uses the direct provider catalog and its active connection files from `.env.testing`.
  The env file names the direct model connections. Stub mode uses a fixed synthetic credential and mounts none of their secret files.
- **`stub`** starts `model-stub` and points the agent at
  `http://model-stub:9877` for this start. The fixed synthetic credential
  is built into the stub and execution service for this mode.

`up` records the mode in `<instance-dir>/model-mode`; `down` keeps it, and
the scenario driver reads it. To switch modes, run `down`, then `up` with the
other flag. A running stub is always stopped by `down`.

An instance runs in one mode at a time. Stub and gateway mode share the
instance's Slack test app, and a second Socket Mode adapter for the same app
is not allowed, so the two cannot run side by side. Production never starts
the stub: only `test-stack.mjs` turns on its Compose profile.

**The instance rests in gateway mode,** so that anyone can test end to end in
the test app at any time. Run the stub suite with the driver's
`--switch-mode` (see [the mode switch](#the-mode-switch)): it switches to stub
mode for the run and back afterwards. If you switch by hand, run `down` and
`up` without `--model-mode` before you finish.

For a prepared **fresh** project only, add `--provision` to the first `up`.
It starts PostgreSQL, runs the maintenance provisioner, then starts the other
services. An existing or partially provisioned project is refused; inspect it
instead of resetting it.

These commands need an explicit external `--instance-dir` and use its
`.env.testing`. They refuse projects with old or unrelated services. They never
build, pull, purge, remove containers or volumes, or rewrite env files. `down`
stops intake, waits for native execution and delivery to become idle, then
stops the other services. If draining fails, intake stays stopped and the
error stays explicit.

The tooling does not compare the test instance with production. Keeping them
apart is the operator's job: use the test Slack app, test tool instances and
test hosts only (see [live-test-rules.md](live-test-rules.md)).

## Scenarios and suites

One driver, [`tests/live/run.mjs`](../tests/live/run.mjs), runs scenarios
against a running test instance. Gateway scenarios live in
`tests/live/scenarios/`, stub scenarios in `tests/live/scenarios/stub/`.

```sh
# Validate gateway configuration in resting gateway mode without contacting services.
npm run test:native:live -- --instance-dir D --suite gateway
# Run the stub suite (T4); switch to stub mode and back.
npm run test:native:live -- --instance-dir D --suite stub --run --switch-mode
# Run the gateway suite (T5) once the designated provider is confirmed available.
npm run test:native:live -- --instance-dir D --suite gateway --run --gateway-ready
# Run the gateway suite without tools only.
npm run test:native:live -- --instance-dir D --suite gateway --run --gateway-ready --tools none
# Run one scenario.
npm run test:native:live -- --instance-dir D --scenario tests/live/scenarios/stub/cancel.json --run --switch-mode
```

- A **suite** runs every scenario of its folder in name order and writes one
  summary, `artifacts/native-live/suite-<id>/summary.json`, that links each
  scenario report.
- A suite **skips** a scenario that already passed with the same scenario
  hash (after fixture values are filled in) and the same image IDs of the
  running services and the same selected model identity. `--rerun` runs it anyway. A changed scenario, fixture or
  image runs it again. A single `--scenario` run never skips.
- `--tools` limits a suite to scenarios whose tools are in scope; the others
  are `not_selected` (see [tool scopes](#tool-scopes)).
- With `E2E_ADMIN_TOKEN`, the driver gives the test channel exactly the tools
  each scenario needs (none in the stub suite) and restores the original
  afterwards (see
  [tools per scenario](#tools-per-scenario)).
- Each run reads the number of model requests of its runs from the settings
  service's cost ledger and records it as `modelRequests`.
- Exit code 0 means passed, skipped or configuration valid; 1 failed,
  including an interrupt and a model mode that could not be restored; 2
  blocked.
- Ctrl-C (or SIGTERM) ends the current wait. The driver then restores the
  channel's tools and settings and the model mode, and reports `interrupted`.
  A second Ctrl-C exits at once without restoring.

A scenario's `"model"` (`stub` or `gateway`, default `gateway`) must match the
recorded mode. A stub instance blocks a gateway scenario
(`gateway_mode_required`); a gateway instance refuses a stub scenario
(`stub_mode_required`). The report's and the summary's `hint` names
`--switch-mode`. Without a recorded mode the driver is blocked
(`model_mode_unknown_start_with_test_stack_up`). A stub report says
`deterministic, not live acceptance`. Stub scenarios steer the
[model stub](../apps/model-stub/README.md) with directives.

### The mode switch

`--switch-mode` (with `--run`) puts the instance into the mode the suite or
scenario needs and back:

1. If the recorded mode already matches, nothing changes.
2. Otherwise the driver runs `test:stack:down`, then
   `test:stack:up --model-mode <needed>`: the same script as
   `npm run test:stack:down|up`, never raw `docker compose` and never
   `--provision`. A switch to gateway mode also needs `--gateway-ready`. A
   failed switch is BLOCKED (`model_mode_switch_failed`).
3. It runs the suite or scenario.
4. It always runs `down` and `up` into the previously recorded mode, also
   after a failure, a block or an interrupt.

The summary (or the single scenario's report) records `modelModeSwitch`:
`from`, `to`, `switched`, `restored` and `restoredMode`. If the restore
fails, for example because `down` cannot drain a running request, the driver
prints `MODEL MODE NOT RESTORED` with the state it left the instance in
(`leftIn`, for example `stub mode, intake stopped`) and the two commands
that restore it (`restoreByHand`), and exits 1 even if every scenario passed.
Then check `npm run test:stack:ps`, wait until native execution is idle and
run the two commands. If they keep failing, tell the operator; never leave
the instance in stub mode.

Scenario fields beyond prompts and expected text:

| Field                 | Meaning                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requires`            | Gateway only: tool kinds the scenario needs besides those its steps imply (`webSearch`, `webFetch`, GitLab for a publication); see [tools per scenario](#tools-per-scenario) |
| `covers`, `budget`    | The gate fields of a gateway scenario (see below)                                                                                                                            |
| `question` / `resume` | The run asks with `ask_user`; the next step answers with `continue <answer>` and the same run resumes                                                                        |
| `wait: false`         | The step's run is not awaited; the next step must be `cancel`                                                                                                                |
| `cancel`              | Posts the `cancel` control; the held run must stop, post the Stopped notice and never deliver                                                                                |
| `channelSettings`     | Stub only: `enabled: false`, `blocked: true`, `model: "alternate"`, a `prompt` text, or `"restore"` each                                                                     |
| `refused`             | Stub only: the request must start no run and get no answer within `settleSeconds` (default 20)                                                                               |
| `edit`, `delete`      | Stub only: a step that edits or deletes an earlier step's message, then watches for `settleSeconds`                                                                          |
| `longAnswer`          | The answer arrives as a preview and `answer.md`; `previewContains` and `previewExcludes` check the preview                                                                   |
| `messageAttachments`  | Slack message attachments (fields, blocks) posted with the mention                                                                                                           |
| `attachments`         | Files uploaded with the mention                                                                                                                                              |
| `discovery`           | A gateway coding step without publication; like every step without `publication`, it must publish nothing                                                                    |
| `publication`         | Files the published commit must contain, read back from the test GitLab project                                                                                              |

`channelSettings` uses the settings service API with `E2E_ADMIN_TOKEN`. It reads the exact prior settings first and
restores them at the end, also after a failure; an unconfirmed restore fails
the run. `{{channel.modelId}}` in `contains` stands for the model ID of the
channel's current model. With `longAnswer`, `contains` and `excludes` apply to
the downloaded `answer.md`, whose hash must equal the retained answer.

The driver checks that the stack is running and idle, and that the settings
service authorizes the exact sender and channel. If an earlier run's work is
still settling (for example the last request of a failed scenario), it waits
up to 120 s, checking every 5 s, before it blocks with
`native_test_work_not_idle`; a suite and a single `--scenario` run wait
alike, and the report records `idleWaitMs`. A step accepts only the run the
agent admitted for the step's own posted message (inspection's `messageTs`),
or for a `resume` the suspended run of the question step; never another run
of the thread. A refused inspection, for example while a step has disabled
the channel or blocked the sender, is recorded on the attempt as
`inspectionRefused` and never read as an absent or earlier run. It posts only as the harness
sender in its channel. It never retries an uncertain write or replays
execution. It edits or deletes only the sender's own messages of the same
run, in stub `edit` and `delete` steps, and records their hash first. Reports and message timestamps stay under
`artifacts/native-live/<id>`; failed and interrupted attempts stay visible.
`--resume-report` rechecks a retained single-scenario report and continues
it; it never reposts an uncertain request.

## The live-scenario gate (T5)

A gateway scenario costs model tokens and minutes on every run. It is admitted
only when all of these hold:

1. **It needs a real model.** The behaviour depends on real model output or
   tool choice. If T0 to T4 can prove it, it belongs there.
2. **It is not covered elsewhere.** No other gateway scenario asserts the
   same behaviour. Extend an existing scenario's thread with a step before
   adding a new scenario.
3. **It is cheap by design.** Use the fewest turns, short prompts and the
   deployment default or an operator-preselected route for acceptance. Use
   coding, publication or web tools only when the scenario tests them.
4. **It has strong assertions.** Assert facts that depend on the model
   reading a real service or source. A reply-format check alone is not
   enough.
5. **It declares its purpose.** `covers` lists what it uniquely covers.
   `budget` gives its posted turns and an upper bound of model requests.

The driver enforces rule 5: it refuses a gateway scenario without `covers`
or `budget`, or with more turns than its budget. It fails a run whose model
requests exceed the budget, and it blocks a suite in which two gateway
scenarios claim the same `covers` entry. A suite does not rerun a scenario
that passed unchanged.

## Boundaries

Synthetic tests do not establish actual Slack or provider quality,
coding, publication or production cutover. Live tests use only the designated
test instance, app and channel and approved test tool instances. The sender
credential stays in `.env.e2e`. Keep all Slack messages, merge requests,
reports, workspaces and stores. Never start a second Socket Mode adapter for
the same app. Never substitute missing operator fixtures or print
credentials. See [live-test-rules.md](live-test-rules.md) for the complete authorization
boundaries.
