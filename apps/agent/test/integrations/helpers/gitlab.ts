import { randomBytes } from 'node:crypto';
import { createTextRetainer } from '../../../src/integrations/gitlab/gitlab-rest-adapter.js';
import { redactTraceOutput } from '../../../../tool-runtime/src/main.js';

/** The test that failed once and passed on retry in the fake trace. */
export const FAKE_FLAKY_TEST = 'filters.spec.ts:40:3 › filter by brand keeps selection';
/** A fake personal access token printed near the top of the fake trace. */
export const FAKE_TRACE_TOKEN = `glpat-${randomBytes(16).toString('hex')}`;
export const FAKE_TRACE_FILLER_LINES = 1500;

/**
 * A GitLab-shaped Playwright job log larger than MAX_TRACE_BYTES: ANSI
 * colours, GitLab section markers, `\r` progress overwrites, credentials
 * printed by the job, filler, and a reporter summary with one retried test.
 */
export function fakeJobTrace(fillerLines = FAKE_TRACE_FILLER_LINES): string {
  const lines = [
    '\x1b[0KRunning with gitlab-runner 17.4.0 (abcdef12)\x1b[0;m',
    'section_start:1760000000:prepare_executor\r\x1b[0K\x1b[0K\x1b[36;1mPreparing the "docker" executor\x1b[0;m',
    'Using Docker executor with image mcr.microsoft.com/playwright:v1.48.0 ...',
    'section_end:1760000004:prepare_executor\r\x1b[0K',
    'section_start:1760000005:step_script\r\x1b[0K\x1b[0K\x1b[36;1mExecuting "step_script" stage of the job script\x1b[0;m',
    `$ git clone https://ci-user:${FAKE_TRACE_TOKEN}@gitlab.example.test/g/p.git`,
    '$ curl -H "PRIVATE-TOKEN: hunter2-private-value" https://gitlab.example.test/api/v4/user',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'Downloading browsers 10%\rDownloading browsers 55%\rDownloading browsers 100%',
    'trace-head-marker start-of-log',
  ];
  for (let i = 1; i <= fillerLines; i += 1) lines.push(`filler line ${i} of the e2e setup output`);
  lines.push(
    'Running 42 tests using 4 workers',
    '  \x1b[32m✓\x1b[39m  1 [chromium] › search.spec.ts:12:5 › search shows results (2.1s)',
    `  \x1b[31m✘\x1b[39m  2 [chromium] › ${FAKE_FLAKY_TEST} (30.0s)`,
    `  \x1b[32m✓\x1b[39m  3 [chromium] › ${FAKE_FLAKY_TEST} (retry #1) (12.4s)`,
    '  1 flaky',
    `    [chromium] › ${FAKE_FLAKY_TEST}`,
    '  41 passed (3.2m)',
    'section_end:1760000200:step_script\r\x1b[0K',
    '\x1b[32;1mJob succeeded\x1b[0;m',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * What the credential-owning runtime answers for a trace body: the same
 * streaming retention and redaction, applied to an in-memory body.
 */
export function runtimeTraceAnswer(body: string, part: 'head' | 'tail', chunkBytes = 4096) {
  const retainer = createTextRetainer({ bytes: 48_000, part });
  const raw = Buffer.from(body, 'utf8');
  for (let at = 0; at < raw.length; at += chunkBytes) {
    if (retainer.push(raw.subarray(at, at + chunkBytes)) === 'cut') break;
  }
  const { text, meta } = retainer.finish();
  return {
    status: 'completed' as const,
    httpStatus: 200,
    output: redactTraceOutput(text),
    truncated: meta.cut || meta.returnedBytes < meta.totalBytes,
    textMeta: meta,
  };
}
