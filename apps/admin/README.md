# Application settings

The admin service manages Slack installations, workspace/channel/member policy,
tool instances and credential bindings, model/prompt/channel settings, automatic
replies, channel commands and memory, accounts, API tokens and audit history.
Gateway cost accounting remains available at `/costs`, `/api/costs`, `/costs.csv`
and the internal `/internal/costs` ingestion endpoint.

Agent management and monitoring belong to Mastra Studio. Set the optional
`ADMIN_STUDIO_URL` to its public HTTPS origin to show a **Mastra Studio** link to
signed-in administrators. The value must have no credentials, path, query or
fragment. Empty or absent values hide the link. This is navigation only: the
admin service does not proxy Studio, authorize its users or ingest its telemetry.

The internal configuration API serves the compiled configuration and ETags.
The authenticated `/live` socket carries cost, configuration and audit
change notices. Pages offer a reload while retaining current form input.

Use `ADMIN_DATABASE_URL` for production PostgreSQL. Retained SQLite
installations keep their existing `ADMIN_DB` mount. Keep `ADMIN_STORE_KEY`
and `ADMIN_SESSION_KEY` when replacing the settings image. See
[settings deployment](../../docs/settings-deployment.md#postgresql).

Run bounded checks without a deployed instance:

```sh
npm run typecheck --workspace @support-agent/admin
npm run test --workspace @support-agent/admin
npx eslint apps/admin
npx prettier --check apps/admin
```

The preservation test generates a populated SQLite fixture and a key in a
temporary directory. It checks the schema, rows, configuration, and encrypted
credentials across two reopens. The database is created at test time.

The PostgreSQL acceptance test needs a fresh, disposable database named
`support_agent_settings_test`. Create an owner login for that database and a separate
login named `settings_test_runtime` that can connect and use the `public`
schema. The test provisions the schema, applies the runtime grants and
retains the resulting data for inspection. Supply those two fixture URLs as
`ADMIN_TEST_POSTGRES_OWNER_URL` and `ADMIN_TEST_POSTGRES_RUNTIME_URL`, then run
`npm run test --workspace @support-agent/admin -- test/postgres.test.ts`.
