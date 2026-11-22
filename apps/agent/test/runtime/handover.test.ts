import { testModel, testSelection } from '../model-fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { createReleaseSummaryRuntime } from '../../src/mastra/agents/release-summary.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';

type Request = {
  tools: Array<{ name: string }>;
  messages: unknown[];
};
type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, string> };

function response(part: Part) {
  const events: string[] = [];
  const send = (type: string, data: object) =>
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', {
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'synthetic',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    index: 0,
    content_block: part.type === 'text' ? { type: 'text', text: '' } : { ...part, input: {} },
  });
  send('content_block_delta', {
    index: 0,
    delta:
      part.type === 'text'
        ? { type: 'text_delta', text: part.text }
        : { type: 'input_json_delta', partial_json: JSON.stringify(part.input) },
  });
  send('content_block_stop', { index: 0 });
  send('message_delta', {
    delta: { stop_reason: part.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send('message_stop', {});
  return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

it.each([false, true])(
  'discovers assigned read tools with a coding workspace bound: %s',
  async (withWorkspace) => {
    const root = path.resolve('artifacts/native-handover', randomUUID());
    await fs.mkdir(root, { recursive: true });
    const requests: Request[] = [];
    let reads = 0;
    let denied = false;
    let revokeAtRead = false;
    let mode: 'release' | 'recall' | 'code' = 'release';
    const fact = `release-${randomUUID()}`;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Request;
      requests.push(request);
      const names = request.tools.map((t) => t.name);
      expect(names).toContain('ask_user');
      expect(names).toContain('search_tools');
      if (withWorkspace) {
        expect(names).toContain('task_write');
        expect(names).toContain('mastra_workspace_read_file');
      } else {
        expect(names.every((n) => ['ask_user', 'search_tools', 'read_release'].includes(n))).toBe(
          true,
        );
      }
      const content = JSON.stringify(request.messages);
      if (mode === 'code') {
        if (!names.includes('execute_typescript'))
          return response({
            type: 'tool_use',
            id: randomUUID(),
            name: 'search_tools',
            input: { query: 'execute_typescript' },
          });
        expect(JSON.stringify(request.tools)).toContain('declare function external_fixture');
        return response({ type: 'text', text: 'Code Mode discovered.' });
      }
      if (mode === 'recall')
        return response({
          type: 'text',
          text: content.includes(fact) ? fact : 'No prior release.',
        });
      if (!names.includes('read_release'))
        return response({
          type: 'tool_use',
          id: randomUUID(),
          name: 'search_tools',
          input: { query: 'read_release' },
        });
      if (!content.includes(fact)) {
        if (revokeAtRead) denied = true;
        return response({ type: 'tool_use', id: randomUUID(), name: 'read_release', input: {} });
      }
      return response({ type: 'text', text: fact });
    });
    const workspace = new Workspace({
      id: randomUUID(),
      filesystem: new LocalFilesystem({ basePath: root }),
    });
    const runtime = createReleaseSummaryRuntime({
      ...(withWorkspace && {
        coding: {
          workspace,
          tools: {},
          codeMode: {
            execute_typescript: createTool({
              id: 'execute_typescript',
              description:
                'Run TypeScript using these tools: declare function external_fixture(): void;',
              inputSchema: z.object({ code: z.string() }),
              execute: async () => 'synthetic',
            }),
          },
        },
      }),
      storage: new InMemoryStore({ id: randomUUID() }),
      model: testModel('http://127.0.0.1:9999', 'synthetic', testSelection('test', 'synthetic')),
      beforeDispatch: async () => {
        if (denied) throw new Error('revoked');
      },
      readRelease: async () => {
        reads++;
        return { version: '1.2.3', summary: fact };
      },
      contextTokens: 8000,
      outputTokens: 1000,
      maxSteps: 5,
    });
    const run = async (thread: string, resource: string) =>
      runNativeSegment(
        await runtime.agent.stream(
          mode === 'recall' ? 'Recall the prior release.' : 'Read the assigned release.',
          {
            runId: randomUUID(),
            memory: { thread, resource },
            closeOnSuspend: true,
            autoResumeSuspendedTools: false,
            disableBackgroundTasks: true,
            modelSettings: { maxOutputTokens: 1000, maxRetries: 0 },
          },
        ),
      );
    try {
      const first = await run('thread-a', 'tenant-a');
      expect(first.uncertain).toBe(false);
      expect(first.text).toBe(fact);
      expect(reads).toBe(1);
      expect(requests).toHaveLength(3);
      expect(Object.keys(runtime.mastra.listAgents())).toEqual(['coding']);
      expect(requests[0]!.tools.map((t) => t.name)).not.toContain('read_release');
      expect(JSON.stringify(requests[0])).not.toContain('declare function external_fixture');
      if (withWorkspace) {
        mode = 'code';
        expect((await run('thread-a', 'tenant-a')).text).toBe('Code Mode discovered.');
      }
      mode = 'recall';
      expect((await run('thread-a', 'tenant-a')).text).toBe(fact);
      expect((await run('thread-b', 'tenant-b')).text).toBe('No prior release.');
      expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain(fact);
      expect(reads).toBe(1);
      mode = 'release';
      revokeAtRead = true;
      let refusal = '';
      await expect(
        run('thread-c', 'tenant-c').catch((error: Error) => {
          refusal = error.message;
          throw error;
        }),
      ).rejects.toThrow('revoked');
      expect(reads).toBe(1);
      await fs.writeFile(
        path.join(root, 'outcomes.json'),
        JSON.stringify(
          {
            first,
            refusal,
            reads,
            checks: [
              'native discovery',
              'service-dependent answer',
              'follow-up memory',
              'thread/resource isolation',
              'revoked tool refused',
            ],
            limitation:
              'Synthetic provider and InMemoryStore; no live/model or process-restart claim.',
          },
          null,
          2,
        ),
      );
    } finally {
      await fs.writeFile(
        path.join(root, 'synthetic-provider-requests.json'),
        JSON.stringify(requests, null, 2),
      );
      await runtime.mastra.shutdown();
      if (withWorkspace) await workspace.stop();
      vi.unstubAllGlobals();
    }
  },
);
