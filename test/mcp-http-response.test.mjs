import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readMcpHttpResponse } from '../lib/mcp-http-response.mjs';

function response(contentType, chunks) {
  const stream = Readable.from(chunks);
  stream.headers = { 'content-type': contentType };
  return stream;
}

function rpcFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

test('parses complete multiline SSE events, ignoring comments, notifications, and other ids', async () => {
  const source = [
    ': keepalive\n\n',
    'data:\n\n',
    'data: {"jsonrpc":"2.0",\ndata: "method":"notifications/initialized"}\n\n',
    'data: {"jsonrpc":"2.0",\ndata: "id":41,\ndata: "result":{"ignored":true}}\n\n',
    'retry: 2500\nx-trace: ignored\nevent: message\n',
    'data: {"jsonrpc":"2.0",\ndata: "id":42,\ndata: "result":{"value":"ready"}}\n\n',
  ].join('');
  const bytes = Buffer.from(source);
  const actual = await readMcpHttpResponse(response('text/event-stream; charset=utf-8', [bytes.subarray(0, 23), bytes.subarray(23, 91), bytes.subarray(91)]), 42);
  assert.deepEqual(actual, { jsonrpc: '2.0', id: 42, result: { value: 'ready' } });
});

test('preserves UTF-8 characters split between response chunks', async () => {
  const bytes = Buffer.from(rpcFrame({ jsonrpc: '2.0', id: 7, result: { text: 'Møbius 🌌' } }));
  const emoji = bytes.indexOf(Buffer.from('🌌'));
  const actual = await readMcpHttpResponse(response('text/event-stream', [bytes.subarray(0, emoji + 1), bytes.subarray(emoji + 1)]), 7);
  assert.equal(actual.result.text, 'Møbius 🌌');
});

test('returns on the first matching event and destroys a still-open response', async () => {
  let sent = false;
  const stream = new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(Buffer.from(`${rpcFrame({ jsonrpc: '2.0', id: 8, result: { done: true } })}data: {bad}\n\n`));
    },
  });
  stream.headers = { 'content-type': 'text/event-stream' };
  const actual = await readMcpHttpResponse(stream, 8);
  assert.equal(actual.result.done, true);
  assert.equal(stream.destroyed, true);
});

test('rejects malformed SSE JSON-RPC data and responses without a result or error', async (t) => {
  await t.test('malformed JSON', async () => {
    await assert.rejects(readMcpHttpResponse(response('text/event-stream', ['data: {bad}\n\n']), 3), { message: 'The MCP server returned invalid JSON-RPC data.' });
  });
  await t.test('missing result and error', async () => {
    await assert.rejects(readMcpHttpResponse(response('text/event-stream', [rpcFrame({ jsonrpc: '2.0', id: 3 })]), 3), { message: 'The MCP server returned invalid JSON-RPC data.' });
  });
});

test('rejects EOF without the exact expected response id', async () => {
  const body = rpcFrame({ jsonrpc: '2.0', id: '9', result: {} });
  await assert.rejects(readMcpHttpResponse(response('text/event-stream', [body]), 9), { message: 'The MCP server did not return the expected JSON-RPC response.' });
});

test('bounds raw response bytes', async () => {
  const body = rpcFrame({ jsonrpc: '2.0', id: 4, result: { value: 'x'.repeat(100) } });
  await assert.rejects(readMcpHttpResponse(response('text/event-stream', [body]), 4, { maxBytes: 64 }), { message: 'The MCP server response exceeded the safe output limit.' });
});

test('destroys a pending response and reports cancellation', async () => {
  const stream = new Readable({ read() {} });
  stream.headers = { 'content-type': 'text/event-stream' };
  const controller = new AbortController();
  const pending = readMcpHttpResponse(stream, 5, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { message: 'The MCP request was cancelled.' });
  assert.equal(stream.destroyed, true);
});

test('parses ordinary JSON responses and preserves the expected id', async () => {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 12, result: { text: '雪' } }));
  const actual = await readMcpHttpResponse(response('application/json', [bytes.subarray(0, 39), bytes.subarray(39)]), 12);
  assert.deepEqual(actual.result, { text: '雪' });
  await assert.rejects(readMcpHttpResponse(response('application/json', [JSON.stringify({ jsonrpc: '2.0', id: '12', result: {} })]), 12), { message: 'The MCP server did not return the expected JSON-RPC response.' });
});
