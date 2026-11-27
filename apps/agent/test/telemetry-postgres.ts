/** Run by `npm run test:native:integration -- --suite telemetry` against a
 * fresh PostgreSQL container: `setup`, then `qualify` after the maintenance
 * entrypoint has provisioned telemetry. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { SpanType } from '@mastra/core/observability';
import {
  provisionNativeApplication,
  nativeStore,
  checkNativeStorage,
} from '../src/infrastructure/storage/native-store.js';
import {
  checkTelemetryStorage,
  provisionTelemetry,
  withTelemetryStore,
} from '../src/infrastructure/storage/telemetry-store.js';
import { studioStore } from '../src/infrastructure/storage/studio-store.js';
import { createStudioDiagnostics } from '../src/mastra/studio-observability.js';
import { nativeTelemetryScenario, privateMarker } from './telemetry-scenario.js';

const root = process.env.NATIVE_TEST_ROOT!;
const socket = process.env.NATIVE_TEST_PG_SOCKET!;
const host = process.env.NATIVE_TEST_PG_HOST!;
const port = Number(process.env.NATIVE_TEST_PG_PORT);
assert(
  root?.startsWith('/') && socket?.startsWith('/') && host && port,
  'native test run required',
);
const maintenance = { host: socket, user: 'postgres', max: 1 };
const cluster = new Pool({ ...maintenance, database: 'postgres' });
const admin = new Pool({ ...maintenance, database: 'native_answer' });
const password = 'synthetic-telemetry-only-fixture-password';
const application = new Pool({
  host,
  port,
  database: 'native_answer',
  user: 'native_answer',
  password,
  max: 3,
});
const telemetry = new Pool({
  host,
  port,
  database: 'native_answer',
  user: 'native_observability',
  password,
  max: 2,
});
const phase = process.argv[2];
const report = `${root}/result.json`;
try {
  if (phase === 'setup') {
    await cluster.query(
      "CREATE ROLE native_answer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'synthetic-telemetry-only-fixture-password'",
    );
    await cluster.query('CREATE DATABASE native_answer OWNER postgres');
    await admin.query('REVOKE ALL ON DATABASE native_answer FROM PUBLIC');
    await provisionNativeApplication(admin);
    await admin.query(`INSERT INTO native_agents.tasks(task_key,owner) VALUES ('preserved', $1)`, [
      randomUUID(),
    ]);
    // Retained local Studio history, separate from shared telemetry.
    const local = studioStore(admin);
    await (await local.getStore('observability'))!.init();
    const localMastra = new Mastra({
      storage: local,
      ...createStudioDiagnostics(['fixture']),
      recovery: { durableAgents: 'off', workflows: 'off' },
    });
    localMastra.observability
      .getDefaultInstance()!
      .startSpan({ type: SpanType.AGENT_RUN, name: 'historical' })
      .end();
    await localMastra.shutdown({ drainTimeout: 30000 });
    const snapshot = (
      await admin.query(`SELECT n.nspname,c.relname,c.relkind,c.relacl::text,
      obj_description(n.oid,'pg_namespace') AS seal FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('framework','native_agents','studio_observability') ORDER BY 1,2`)
    ).rows;
    fs.writeFileSync(`${root}/primary-before.json`, JSON.stringify(snapshot));
    fs.writeFileSync(`${root}/telemetry-password`, password, { mode: 0o644 });
    console.log('fresh synthetic native application and historical Studio telemetry prepared');
  } else {
    await checkNativeStorage(application);
    await checkTelemetryStorage(telemetry);
    await admin.query('ALTER ROLE native_observability CREATEDB');
    try {
      await assert.rejects(checkTelemetryStorage(telemetry), /identity/);
    } finally {
      await admin.query('ALTER ROLE native_observability NOCREATEDB');
    }
    for (const sql of [
      'SELECT * FROM native_agents.tasks',
      'SELECT * FROM framework.mastra_messages',
      'CREATE TABLE native_observability.forbidden(id int)',
      'CREATE SCHEMA forbidden',
      'SET ROLE native_answer',
      'DELETE FROM native_observability.mastra_span_events',
    ])
      await assert.rejects(telemetry.query(sql), /permission denied/);
    const wrongIdentity = new Pool({
      host,
      port,
      database: 'native_answer',
      user: 'postgres',
      password,
      connectionTimeoutMillis: 1000,
    });
    try {
      await assert.rejects(wrongIdentity.query('SELECT 1'), /pg_hba/);
    } finally {
      await wrongIdentity.end();
    }
    const store = withTelemetryStore(nativeStore(application), application, telemetry);
    const result = await nativeTelemetryScenario(store);
    const spans = (await telemetry.query('SELECT * FROM native_observability.mastra_span_events'))
      .rows;
    const metrics = (
      await telemetry.query('SELECT * FROM native_observability.mastra_metric_events')
    ).rows;
    const logs = (await telemetry.query('SELECT * FROM native_observability.mastra_log_events'))
      .rows;
    for (const rows of [spans, metrics, logs]) {
      assert(rows.length > 0);
      const bytes = JSON.stringify(rows);
      assert(!bytes.includes(privateMarker));
      assert(!bytes.includes(result.identity.threadId));
      assert(!bytes.includes(result.identity.resourceId));
      assert(bytes.includes('support-agent-slack'));
      assert(bytes.includes(result.runId));
    }
    assert(JSON.stringify(metrics).includes('mastra_model_total_input_tokens'));
    assert(JSON.stringify(logs).includes('native.segment.ended'));
    // Studio's official domain uses this same restricted pool while its primary
    // memory/chat domain stays separate. No runtime primary credential is needed.
    const studioPrimary = new InMemoryStore();
    const studioPrimaryPool = new Pool({
      host: 'unreachable-studio-primary.invalid',
      password: 'studio-local-only',
    });
    const studio = withTelemetryStore(studioPrimary, studioPrimaryPool, telemetry);
    assert.equal(await studio.getStore('memory'), await studioPrimary.getStore('memory'));
    const domain = (await studio.getStore('observability'))!;
    const traces = await domain.listTraces({ pagination: { page: 0, perPage: 50 } });
    assert(JSON.stringify(traces).includes(result.runId));
    const from = new Date(Date.now() - 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);
    const aggregate = await domain.getMetricAggregate({
      name: ['mastra_model_total_input_tokens'],
      aggregation: 'sum',
      filters: { timestamp: { start: from, end: to }, runId: result.runId },
    });
    assert.equal(aggregate.value, 9);
    const serviceNames = await domain.getServiceNames({});
    assert(JSON.stringify(serviceNames).includes('support-agent-slack'));
    const studioMastra = new Mastra({
      storage: studio,
      ...createStudioDiagnostics(['fixture']),
      recovery: { durableAgents: 'off', workflows: 'off' },
    });
    // The stock Studio server starts workers explicitly, even with runtime DDL disabled.
    await studioMastra.startWorkers();
    studioMastra.getLogger().info('studio.request.completed');
    studioMastra.observability
      .getDefaultInstance()!
      .startSpan({ type: SpanType.AGENT_RUN, name: privateMarker, input: privateMarker })
      .end();
    await studioMastra.shutdown({ drainTimeout: 30000 });
    assert.equal(studioPrimaryPool.totalCount, 0);
    await studioPrimaryPool.end();
    assert(
      (
        await telemetry.query(
          `SELECT 1 FROM native_observability.mastra_log_events WHERE "serviceName"='support-agent-studio'`,
        )
      ).rowCount,
    );
    // Repeated additive maintenance must preserve all primary objects/ACL/seal,
    // old Studio traces, shared telemetry, and the existing role password.
    const repeated = await provisionTelemetry(
      admin,
      'different-file-must-never-rotate-existing-password',
    );
    await repeated.ensurePartitions();
    await checkNativeStorage(application);
    const snapshot = (
      await admin.query(`SELECT n.nspname,c.relname,c.relkind,c.relacl::text,
      obj_description(n.oid,'pg_namespace') AS seal FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('framework','native_agents','studio_observability') ORDER BY 1,2`)
    ).rows;
    assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(`${root}/primary-before.json`, 'utf8')));
    assert.equal(
      (await admin.query('SELECT count(*)::int n FROM native_agents.tasks')).rows[0].n,
      1,
    );
    assert.deepEqual(
      (
        await admin.query(
          'SELECT count(DISTINCT "spanId")::int spans, count(*)::int events FROM studio_observability.mastra_span_events',
        )
      ).rows[0],
      { spans: 1, events: 2 },
    );
    const reconnect = new Pool({
      host,
      port,
      database: 'native_answer',
      user: 'native_observability',
      password,
    });
    await checkTelemetryStorage(reconnect);
    await reconnect.end();
    const partitions = (
      await admin.query(
        `SELECT count(*)::int n FROM pg_inherits i JOIN pg_class p ON p.oid=i.inhparent JOIN pg_namespace n ON n.oid=p.relnamespace WHERE n.nspname='native_observability'`,
      )
    ).rows[0].n;
    assert(partitions >= 5 * 15);
    fs.writeFileSync(
      report,
      JSON.stringify(
        {
          outcome: 'pass',
          mode: 'real pinned durable Agent/Postgres VNext; synthetic Gateway only',
          counts: { spans: spans.length, metrics: metrics.length, logs: logs.length, partitions },
          checks: [
            'privacy at persisted rows',
            'official Studio reads and metrics aggregate',
            'restricted telemetry role and HBA',
            'primary domains/ACL/seal unchanged',
            'historical Studio telemetry retained',
            'additive idempotent provisioning without password rotation',
            'no automatic replay',
            'graceful official exporter shutdown',
          ],
        },
        null,
        2,
      ),
    );
    console.log(fs.readFileSync(report, 'utf8'));
  }
} finally {
  await telemetry.end();
  await application.end();
  await admin.end();
  await cluster.end();
}
