import { expect, it } from 'vitest';
import { admitModelRequest } from '../../../src/integrations/providers/request-budget.js';

const request = (blocks: unknown[]) =>
  Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: blocks }], max_tokens: 32000 }));

it('admits large text history without treating bytes as tokens', () => {
  expect(() =>
    admitModelRequest(request([{ type: 'text', text: 'x'.repeat(300000) }])),
  ).not.toThrow();
});
it('raises the serialized body cap from 24 to 32 MiB', () => {
  expect(() =>
    admitModelRequest(request([{ type: 'text', text: 'x'.repeat(25 * 1024 ** 2) }])),
  ).not.toThrow();
  expect(() => admitModelRequest(Buffer.alloc(32 * 1024 ** 2 + 1))).toThrow('model_request_bytes');
});
it('retains image, document, nesting and JSON safeguards with distinct reasons', () => {
  expect(() =>
    admitModelRequest(request(Array.from({ length: 20 }, () => ({ type: 'image' })))),
  ).not.toThrow();
  expect(() =>
    admitModelRequest(request(Array.from({ length: 21 }, () => ({ type: 'image' })))),
  ).toThrow('model_request_images');
  expect(() => admitModelRequest(request([{ type: 'document' }]))).toThrow(
    'model_request_document',
  );
  let nested: unknown = 'text';
  for (let i = 0; i < 105; i++) nested = [nested];
  expect(() => admitModelRequest(request([nested]))).toThrow('model_request_nesting');
  expect(() => admitModelRequest(Buffer.from('{'))).toThrow('model_request_json');
});
it('admits only bounded inline text documents when the native answer caller enables them', () => {
  const document = {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: 'source fact' },
  };
  expect(() => admitModelRequest(request([document]))).toThrow('model_request_document');
  expect(() => admitModelRequest(request([document]), true)).not.toThrow();
  for (const source of [
    { type: 'url', media_type: 'text/plain', url: 'https://arbitrary.invalid' },
    { type: 'base64', media_type: 'application/pdf', data: 'abc' },
    { type: 'text', media_type: 'text/plain', data: 'x'.repeat(200 * 1024 + 1) },
  ])
    expect(() => admitModelRequest(request([{ type: 'document', source }]), true)).toThrow(
      'model_request_document',
    );
});
