import { testModel, testSelection } from './model-fixture.js';
/** Retained container probe; uses only its dedicated Studio store and synthetic files. */
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { registerNativeExport } from '../src/domain/delivery/register-export.js';
import { createNativeCodingBinding } from '../src/mastra/tools/coding.js';
import { createNativeAgent } from '../src/mastra/agents/coding.js';
import { InMemoryStore } from '@mastra/core/storage';

const password = (await fs.readFile(process.env.NATIVE_PG_PASSWORD_FILE!, 'utf8')).trim();
const pool = new Pool({
  host: process.env.NATIVE_PG_HOST,
  database: 'native_answer',
  user: 'native_answer',
  password,
});
const checks: string[] = [];
try {
  const elevated = new Pool({
    host: process.env.NATIVE_PG_HOST,
    database: 'native_answer',
    user: 'postgres',
    password,
    connectionTimeoutMillis: 2000,
  });
  await assert.rejects(elevated.query('SELECT current_user'), /pg_hba/);
  await elevated.end();
  checks.push('maintenance identity refused over runtime connection');
  const id = randomUUID();
  await pool.query(
    'INSERT INTO native_agents.requests(run_id,task_key,event_id,owner,accepted,execution_policy_hash) VALUES($1::uuid,$2,$1::uuid::text,$1::uuid,$3,$4)',
    [id, 'studio-probe', '{}', 'synthetic'],
  );
  const file = (name: string, content = name) => ({
    path: name,
    name,
    bytes: Buffer.from(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  const first = await registerNativeExport(pool, id, file('first.txt'));
  assert.deepEqual(await registerNativeExport(pool, id, file('first.txt')), first);
  await assert.rejects(
    registerNativeExport(pool, id, file('first.txt', 'changed')),
    /export_already_designated/,
  );
  for (const name of ['second.txt', 'third.txt', 'fourth.txt'])
    await registerNativeExport(pool, id, file(name));
  await assert.rejects(registerNativeExport(pool, id, file('fifth.txt')), /export_count_limit/);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM native_agents.exports WHERE run_id=$1', [id]))
      .rows[0].n,
    4,
  );
  checks.push('exact export idempotence, changed bytes refused, four-file limit retained');
  let serviceCalls = 0;
  const coding = await createNativeCodingBinding(
    {
      storageDir: '/var/lib/native-coding/studio-probe',
      workspaceId: createHash('sha256').update(id).digest('hex'),
      run: { runId: id, runSeq: 1, attempt: 1 },
      gitlabHost: 'gitlab.example',
      gitlabToken: 'synthetic',
      transfer: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
      authorize: async () => {},
      publication: async () => {
        throw new Error('not dispatched');
      },
      gitlab: async () => {
        serviceCalls++;
        throw new Error('not dispatched');
      },
      redact: (text) => text,
      log: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  try {
    const tool = coding.tools.clone_repository as {
      execute(input: unknown, context: { abortSignal: AbortSignal }): Promise<unknown>;
    };
    await assert.rejects(
      tool.execute(
        { project: 'synthetic/project' },
        { abortSignal: AbortSignal.abort(new Error('cancelled framework run')) },
      ),
      /cancelled framework run/,
    );
    assert.equal(serviceCalls, 0);
    checks.push('framework run cancellation reaches native domain tools before service dispatch');
  } finally {
    await coding.close();
  }
  const agent = createNativeAgent({
    storage: new InMemoryStore(),
    instructions: 'synthetic',
    model: testModel('http://127.0.0.1:1', 'synthetic', testSelection('test', 'synthetic')),
    tools: {},
    beforeDispatch: async () => {},
    contextTokens: 2000,
    outputTokens: 64,
    maxSteps: 3,
  });
  const defaults = await agent.getDefaultOptions();
  assert.equal(defaults.toolCallConcurrency, 1);
  assert.equal(defaults.disableBackgroundTasks, true);
  assert.equal(defaults.autoResumeSuspendedTools, false);
  assert.equal(defaults.modelSettings?.maxOutputTokens, 64);
  checks.push('Studio and Slack share serial tool dispatch and bounded native execution defaults');
  console.log(JSON.stringify({ checks, runId: id }));
} finally {
  await pool.end();
}
