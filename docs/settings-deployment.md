# Settings service deployment

The native application uses the settings service as its external settings
authority. For new production deployments, use [PostgreSQL](#postgresql).

## Compose deployment

`deploy/compose.yaml` runs the settings service as `admin` next to the
application. Its SQLite store is the bind-mounted `ADMIN_STORE_DIR`, owned by
UID 1000. The service publishes its UI on `127.0.0.1:$ADMIN_HOST_PORT` for the
host's HTTPS reverse proxy; the application reaches it as `http://admin:9883`
on the private frontend network. Configuration comes from the instance env file;
see the [live test setup](live-test-setup.md). Replacing the image keeps the
store and needs no reconfiguration, provided `ADMIN_STORE_KEY` and
`ADMIN_SESSION_KEY` stay the same. Back up the store with the
[admin snapshot script](../deploy/docker/admin-backup.sh).

## Kubernetes credential configuration

The settings container reads its startup credentials from environment
variables. Populate a Kubernetes Secret through the cluster's approved
secret management process. Reference individual keys with
`env[].valueFrom.secretKeyRef` in the containers that consume them.
Keep Secret values out of Helm values, ConfigMaps and Git. Limit access
with RBAC and enable encryption of Kubernetes Secrets at rest.
[Kubernetes Secret guidance](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)

| Key                    | Containers that need it                        | Purpose                                                                                       |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ADMIN_STORE_KEY`      | Settings                                       | 32-byte key as 64 hex characters for encrypted tool credentials and Slack installation tokens |
| `ADMIN_SESSION_KEY`    | Settings                                       | Separate 32-byte key as 64 hex characters for admin sessions and OAuth state                  |
| `ADMIN_DATABASE_URL`   | Settings                                       | PostgreSQL connection URL for the runtime role                                                |
| `SLACK_CLIENT_SECRET`  | Settings                                       | Slack installation OAuth secret                                                               |
| `ADMIN_INTERNAL_TOKEN` | Settings, agent, Slack adapter and CLI runtime | Authenticates calls to the private settings API                                               |
| `SLACK_APP_TOKEN`      | Slack adapter                                  | Socket Mode app token                                                                         |

For example, this entry belongs in the settings container's `env` list.
It references a key in an existing Secret.

```yaml
- name: ADMIN_STORE_KEY
  valueFrom:
    secretKeyRef:
      name: support-agent-settings
      key: ADMIN_STORE_KEY
```

Set `SLACK_CLIENT_ID` to the app's OAuth client ID and `ADMIN_PUBLIC_URL`
to the HTTPS origin for the settings UI. Register that origin's
`/slack/oauth/callback` with Slack and keep `/internal/*` private to
authorized workloads. Create and rotate per-tool credentials on the
workspace's **Tools** page, then assign ready instances to the channels
that need them. The settings database holds those encrypted credentials.

Keep `ADMIN_STORE_KEY` stable across pod replacements and database restores.
Retain it separately from database backups. Replacing the key alone makes
existing ciphertext unreadable. For Secrets consumed as environment
variables, roll the affected pods when the value changes.

## PostgreSQL

Use a dedicated settings database, with separate credentials from Mastra.
Create a schema owner and a runtime login role. Use the owner as the database
owner and give the runtime role `CONNECT` on the settings database and `USAGE`
on its `public` schema. Keep schema creation restricted to the owner.

Run this command once from the settings image on the database network. Inject
the owner's PostgreSQL URL as `ADMIN_DATABASE_URL` into the provisioning process.

```sh
node apps/admin/dist/cli.js provision-postgres
```

The command creates the initial schema transactionally and can be rerun for
the same schema. For releases that change the schema, back up the database and
apply the release's schema update with the owner role before the settings
rollout. Apply the following grants as the owner, substituting your runtime
role for `settings_runtime`. Repeat them when an update adds tables or sequences.

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO settings_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO settings_runtime;
```

The direct-provider release adds the `provider_requests` table for inference
accounting. For an existing PostgreSQL settings store, rerun provisioning
and repeat the runtime grants before startup. Existing gateway observations
stay in their original table and direct-provider reports use the new table.

Supply the runtime role's URL through the settings pod's Secret and omit
`ADMIN_DB`. Use a TLS connection with server identity verification and make
the database server's CA available to the container as needed. The settings
process reads the provisioned schema and initializes the empty configuration on startup.
Use `/healthz` for readiness. Begin with one settings replica because change
notices and immediate WebSocket session revocation use process-local state.
The surrounding deployment repository owns the Job, service, probes and
network policy. The settings pod can run without a settings PVC in this mode.

Use SQLite via `ADMIN_DB` for local work and the [Compose deployment](#compose-deployment).
A new PostgreSQL database starts unpaired. Configure the workspace and tools
on that deployment when it is first set up. From the settings container, run
`node apps/admin/dist/cli.js create-admin <name>` to create the first admin.
The command reads the password from the terminal or standard input.

### Back up and restore

Include the settings database in PostgreSQL backups. The database holds
configuration versions, encrypted tool and Slack credentials, admin accounts,
channel memory, and audit and cost history. Keep the original
`ADMIN_STORE_KEY` in your secret management system separately from the backup.
Retain `ADMIN_SESSION_KEY` if existing sessions need to survive recovery.

For a logical backup, run `pg_dump --format=custom --file=settings.dump` with
the connection parameters supplied by your PostgreSQL tooling. Restore with
`pg_restore --exit-on-error --no-owner --no-privileges --dbname=settings_restore settings.dump`
into a fresh database as its schema owner. Reapply the runtime grants above,
attach the original store key and check readiness and configuration hash.
Verify that a designated fixture tool can read its existing credential without
exposing the value. Complete these checks in staging before switching the
production settings URL. Store database archives in protected storage.
