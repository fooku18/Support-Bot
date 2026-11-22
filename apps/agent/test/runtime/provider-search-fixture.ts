import { testModel, testSelection } from '../model-fixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const token = 'synthetic-attempt-search-only';
export const usage = {
  input_tokens: 13,
  output_tokens: 7,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 3,
  server_tool_use: { web_search_requests: 1 },
};
export const searchCall = (id = 'server-search') => ({
  type: 'server_tool_use',
  id,
  name: 'web_search',
  input: { query: 'RFC 2606' },
});
export const searchResult = (
  content: unknown = [
    {
      type: 'web_search_result',
      title: 'Reserved Top Level DNS Names',
      url: 'https://www.rfc-editor.org/rfc/rfc2606',
      encrypted_content: 'opaque-fixture-citation',
    },
  ],
  id = 'server-search',
) => ({ type: 'web_search_tool_result', tool_use_id: id, content });
export const text = (value: string) => ({ type: 'text', text: value });

export function send(
  res: http.ServerResponse,
  blocks: Record<string, unknown>[],
  stop = 'end_turn',
  counters: object = usage,
) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [],
      stop_reason: null,
      usage: counters,
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === 'server_tool_use' || block.type === 'tool_use') {
      event('content_block_start', { index, content_block: { ...block, input: {} } });
      event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === 'text') {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else event('content_block_start', { index, content_block: block });
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: counters });
  event('message_stop', {});
  res.end();
}

export async function fixture(
  respond?: (res: http.ServerResponse, index: number, body: Record<string, unknown>) => void,
) {
  const requests: {
    path: string | undefined;
    token: string | string[] | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, token: req.headers['x-api-key'], body });
    if (respond) respond(res, requests.length, body);
    else send(res, [searchCall(), searchResult(), text('RFC 2606, 1999: example.com.')]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = testModel(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    testSelection('test', 'fixture-search-model', true),
  );
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { request, requests, close };
}
