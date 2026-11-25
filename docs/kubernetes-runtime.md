# Kubernetes runtime image

GitHub Actions publishes the unified `linux/amd64` runtime to `ghcr.io/fooku18/support-bot`. A push to `main` that changes runtime build inputs or the publish checks triggers the workflow. Pushing a release tag such as `v1.2.3` also triggers it. For an on-demand publish, select **Actions → Publish runtime image → Run workflow** and choose the ref to publish.

After a successful run, copy the `FROM` line from the job summary into your downstream deployment Dockerfile if you build a wrapper image (or let Renovate track the tag and update the pinned digest automatically). The digest pins the exact single-platform manifest that passed the runtime smoke test.

```dockerfile
FROM ghcr.io/fooku18/support-bot:1.2.3@sha256:<digest>
```

The package publishes a `sha-<full-commit>` tag on every build, a `main` tag for default-branch publishes, and semver tags (`1.2.3`, `1.2`, `1`) plus `latest` on stable `v*.*.*` release tags (`latest` is never moved by raw `main` pushes or prereleases). For a private GHCR package, configure the downstream CI builder's registry authentication for `ghcr.io` using an account with package read access and a read-only GitHub personal access token (classic) scoped to `read:packages`. Store it as a masked CI credential.

Use the published image (or a downstream wrapper image built from it) as the container image for each workload. Keep the image entrypoint and select each process with the container's `args`.

| Workload                | Container args       | Purpose                                                                                                 |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| Agent Deployment        | `["agent"]`          | Answer-only execution. Use one replica and a Recreate rollout for the singleton lease.                  |
| Adapter Deployment      | `["adapter"]`        | Defaults to `--process-env`. Run one Slack Socket Mode receiver per app. Use Recreate to avoid overlap. |
| Admin Deployment        | `["admin"]`          | Settings service. Mount writable storage at `/var/lib/support-agent-admin` for local state.             |
| Admin Job               | `["admin-cli", ...]` | Pass admin CLI arguments as separate strings.                                                           |
| Provision Job           | `["provision"]`      | Explicit fresh-install hook for database and role creation.                                             |
| Telemetry Deployment    | `["telemetry"]`      | Optional long-running partition maintenance.                                                            |
| Tool runtime Deployment | `["cli-runtime"]`    | Starts the REST/MCP service with `--serve`. Explicit arguments replace that default.                    |

Use `runAsNonRoot: true`, `runAsUser: 1000`, a read-only root filesystem, dropped capabilities and a writable `emptyDir` at `/tmp`. Set volume ownership for UID/GID 1000. Configure agent probes to send its service bearer token to `/healthz` and `/readyz` (for example via an exec probe reading the container environment). Set each workload's own env and service ports using [the Compose roles](../deploy/compose.yaml) as a reference. Omit `EGRESS_PROXY_URL` when cluster policy handles outbound traffic. Restrict ingress, egress and Secret references per role.

Leave `NATIVE_CODING_STORE` unset. The unified image supports answer-only execution and REST/MCP tools. REST/MCP tools include GitLab reads: set `GITLAB_HOSTS` on the tool runtime. The privileged coding workspace uses its dedicated Compose target. For plain Slack and Studio answers omit both `CLI_RUNTIME_URL` and `CLI_RUNTIME_TOKEN`; configure both to use the tool service. Assigned CLI-backed tools are unavailable without it. Web fetch independently uses `WEB_RUNTIME_URL` and `WEB_RUNTIME_TOKEN`.

Supply `NATIVE_PG_PASSWORD`, `NATIVE_ANTHROPIC_API_KEY`, `NATIVE_OPENAI_API_KEY`, `NATIVE_VERTEX_CREDENTIALS` (service account JSON) and `NATIVE_OBSERVABILITY_PASSWORD` as needed via `valueFrom.secretKeyRef` or their respective `_FILE` variables pointing to absolute mounted paths. Select one source per secret. Provider credentials belong only in the agent and only active provider routes require them.

For TCP provisioning set `NATIVE_PG_HOST`, optional `NATIVE_PG_PORT` (default 5432), `NATIVE_PG_ADMIN_PASSWORD` or its `_FILE`, and the new runtime role's `NATIVE_PG_PASSWORD` or its `_FILE`. The Job connects as `postgres` to database `postgres` and initializes `native_answer`. Socket maintenance uses `NATIVE_PG_SOCKET` instead. The telemetry maintainer uses the same maintenance connection and its own observability password. Keep maintenance credentials out of the agent Deployment.

Enable the provision hook only for a fresh install. An existing role or database causes refusal, including on a retry after partial creation. Disable this hook for upgrades to an initialized store. If your cluster uses a service mesh sidecar, configure database connectivity and Job completion accordingly.

For managed PostgreSQL over TCP, set `NATIVE_PG_SSLMODE=verify-full` on the agent and both maintenance workloads. The telemetry reader uses the same port and TLS settings. Both `require` and `verify-full` validate the certificate chain and hostname. Use `verify-ca` only when chain validation without hostname verification is intentional. Set `NATIVE_PG_SSLROOTCERT` to an absolute mounted CA bundle path for private trust, or extend Node's default trust via `NODE_EXTRA_CA_CERTS`. An unset native mode honors `PGSSLMODE`, then defaults to `disable`. Unix socket maintenance uses disabled TLS. Blank secret sources, host and socket settings count as unset, and a blank port defaults to 5432.

## Model gateways

Choose the catalog route by the HTTP API the gateway exposes. A Claude model backed by Vertex can use the `anthropic` route when the gateway exposes Anthropic Messages. For example, this agent environment configures Messages and OpenAI Responses on the same gateway using separate mounted Kubernetes Secrets.

```yaml
env:
  - name: MODEL_DEFAULT_KEY
    value: claude
  - name: MODEL_CATALOG
    value: >-
      [{"key":"claude","route":"anthropic","model":"vertex_ai/claude-sonnet-5-5"},
       {"key":"gpt","route":"openai","model":"gpt-5"}]
  - name: NATIVE_ANTHROPIC_BASE_URL
    value: https://ai-gateway.example.com/anthropic
  - name: NATIVE_ANTHROPIC_AUTH_MODE
    value: bearer
  - name: NATIVE_ANTHROPIC_API_KEY_FILE
    value: /run/secrets/anthropic/key
  - name: NATIVE_OPENAI_BASE_URL
    value: https://ai-gateway.example.com/openai/v1
  - name: NATIVE_OPENAI_API_KEY_FILE
    value: /run/secrets/openai/key
```

The example sends POST requests to `/anthropic/v1/messages` and `/openai/v1/responses`. A blank base selects the public provider. Trailing slashes are removed and a final `/v1` is used once. Anthropic accepts `x-api-key` (default) or `bearer`. OpenAI uses bearer authentication.

For a Vertex-compatible gateway, use the same connection for both publishers. This example reads the gateway key from a Kubernetes Secret.

```yaml
env:
  - name: MODEL_DEFAULT_KEY
    value: claude
  - name: MODEL_CATALOG
    value: >-
      [{"key":"claude","route":"vertex-claude","model":"claude-sonnet-4-5@20250929"},
       {"key":"gemini","route":"vertex-gemini","model":"gemini-2.5-pro"}]
  - name: NATIVE_VERTEX_BASE_URL
    value: https://ai-gateway.example.com/vertex
  - name: NATIVE_VERTEX_PROJECT
    value: example-project
  - name: NATIVE_VERTEX_LOCATION
    value: global
  - name: NATIVE_VERTEX_API_KEY
    valueFrom:
      secretKeyRef:
        name: vertex-gateway
        key: api-key
```

The resulting base is `https://ai-gateway.example.com/vertex/v1/projects/example-project/locations/global/publishers`. You can set that entire URL as `NATIVE_VERTEX_BASE_URL` and omit project and location. If supplied with the full URL, those settings must match it. A complete resource path may also start with `v1beta1/projects` after the gateway prefix. If the proxy injects project and location, set the base to its publisher root (for example, `https://ai-gateway.example.com/vertex/v1/publishers` or `https://ai-gateway.example.com/vertex/publishers`) and omit both settings. The agent appends `/anthropic/models/<model>:rawPredict` or `:streamRawPredict` for Claude, and `/google/models/<model>:generateContent` or `:streamGenerateContent?alt=sse` for Gemini.

Set exactly one of `NATIVE_VERTEX_API_KEY` and `NATIVE_VERTEX_API_KEY_FILE` together with the gateway URL. Omit both service-account credential variables. Set `NATIVE_VERTEX_AUTH_MODE` to match the gateway. The default `bearer` sends `Authorization: Bearer <key>`. The modes `x-goog-api-key` and `x-api-key` send the key in the named header. Both Vertex routes send only the selected credential and need no OAuth or metadata access. A key alone is rejected. The Gemini SDK's Express Mode uses a different endpoint and the `x-goog-api-key` header. For direct Vertex access, use the service account, project and location.

Use a trusted HTTPS DNS name and a nonsecret path prefix. The normalized base is part of the conversation identity and cost records. Switching paths or hosts starts fresh model history. If using the application egress proxy, give its container the same catalog and nonsecret URL and location settings. It admits the selected host on port 443. With cluster-managed egress, allow traffic to the configured gateway through your cluster policy. These optional Kubernetes settings are supplied on the workloads and do not require additional entries in the Compose env parity files.
