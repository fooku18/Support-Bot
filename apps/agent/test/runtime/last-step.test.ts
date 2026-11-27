import { testModel, testSelection } from '../model-fixture.js';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@mastra/core/storage';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';

type Request = {
  tools?: Array<{ name: string }>;
  tool_choice?: { type: string };
  system?: unknown;
};

type Part = { type: 'text'; text: string } | { type: 'tool_use'; query: string };

function stream(...parts: Part[]) {
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
  parts.forEach((part, index) => {
    send('content_block_start', {
      index,
      content_block:
        part.type === 'text'
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: randomUUID(), name: 'search_tools', input: {} },
    });
    send('content_block_delta', {
      index,
      delta:
        part.type === 'text'
          ? { type: 'text_delta', text: part.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify({ query: part.query }) },
    });
    send('content_block_stop', { index });
  });
  const calls = parts.some((part) => part.type === 'tool_use');
  send('message_delta', {
    delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send('message_stop', {});
  return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('answers without tools on the last step instead of ending on a tool call', async () => {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as Request;
    requests.push(request);
    return request.tool_choice?.type === 'none'
      ? stream({ type: 'text', text: 'Partial answer from what was found.' })
      : stream({ type: 'tool_use', query: `lookup ${requests.length}` });
  });
  const runtime = createNativeRuntime({
    storage: new InMemoryStore({ id: randomUUID() }),
    instructions: 'TRUSTED instructions',
    model: testModel('http://127.0.0.1:9999', 'synthetic', testSelection('test', 'synthetic')),
    tools: {},
    beforeDispatch: async () => {},
    contextTokens: 100_000,
    outputTokens: 64,
    maxSteps: 3,
  });
  try {
    const out = await runNativeSegment(
      await runtime.agent.stream('Look this up', { closeOnSuspend: true, maxSteps: 3 }),
    );
    expect(requests).toHaveLength(3);
    expect(requests.slice(0, 2).map((r) => r.tool_choice?.type ?? 'auto')).toEqual([
      'auto',
      'auto',
    ]);
    expect(requests[2]!.tool_choice).toEqual({ type: 'none' });
    expect(requests[2]!.tools?.map((t) => t.name)).toContain('search_tools');
    expect(JSON.stringify(requests[2]!.system)).toContain('last step of this run');
    expect(JSON.stringify(requests[1]!.system)).not.toContain('last step of this run');
    expect(out.text).toBe('Partial answer from what was found.');
    expect(out.uncertain).toBe(false);
  } finally {
    await runtime.mastra.shutdown();
  }
});

it('delivers the final step text without the narration of earlier tool steps', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', async () =>
    ++calls === 1
      ? stream(
          { type: 'text', text: 'Too slow; I will parallelize.' },
          { type: 'tool_use', query: 'q' },
        )
      : stream({ type: 'text', text: 'Traffic is up 9% on yesterday.' }),
  );
  const runtime = createNativeRuntime({
    storage: new InMemoryStore({ id: randomUUID() }),
    instructions: 'TRUSTED instructions',
    model: testModel('http://127.0.0.1:9999', 'synthetic', testSelection('test', 'synthetic')),
    tools: {},
    beforeDispatch: async () => {},
    contextTokens: 100_000,
    outputTokens: 64,
    maxSteps: 4,
  });
  try {
    const out = await runNativeSegment(
      await runtime.agent.stream('Look this up', { closeOnSuspend: true, maxSteps: 4 }),
    );
    expect(calls).toBe(2);
    expect(out.text).toBe('Traffic is up 9% on yesterday.');
    expect(out.uncertain).toBe(false);
  } finally {
    await runtime.mastra.shutdown();
  }
});

it('tells the model which assigned tools are unavailable in this run', async () => {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Request);
    return stream({ type: 'text', text: 'GitLab is unavailable right now.' });
  });
  const runtime = createNativeRuntime({
    storage: new InMemoryStore({ id: randomUUID() }),
    instructions: 'TRUSTED instructions',
    model: testModel('http://127.0.0.1:9999', 'synthetic', testSelection('test', 'synthetic')),
    tools: {},
    unavailableTools: ['gitlab', 'datadog'],
    beforeDispatch: async () => {},
    contextTokens: 100_000,
    outputTokens: 64,
    maxSteps: 3,
  });
  try {
    await runNativeSegment(
      await runtime.agent.stream('Which MRs merged today?', { closeOnSuspend: true, maxSteps: 3 }),
    );
    expect(JSON.stringify(requests[0]!.system)).toContain(
      'unavailable in this run: GitLab, Datadog',
    );
  } finally {
    await runtime.mastra.shutdown();
  }
});
