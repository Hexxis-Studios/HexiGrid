import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMcpCallToolResult } from '../lib/mcp-result.mjs';

const malformedMessage = 'The MCP server returned a malformed tool result.';

test('MCP call results retain supported content and extension fields', () => {
  const result = {
    content: [
      { type: 'text', text: 'hello', annotations: { audience: ['user'], priority: 0.5, vendor: 'kept' }, _meta: { trace: 'local' }, vendorBlock: { retained: true } },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'audio', data: 'BAUG', mimeType: 'audio/wav' },
      { type: 'resource_link', name: 'guide', uri: 'mcp-resource://guide', title: 'Guide', size: 42, icons: [{ src: 'mcp-resource://icon', sizes: ['32x32'], theme: 'dark' }] },
      { type: 'resource', resource: { uri: 'mcp-resource://embedded-text', mimeType: 'text/plain', text: 'embedded', vendorResource: true } },
      { type: 'resource', resource: { uri: 'mcp-resource://embedded-blob', mimeType: 'application/octet-stream', blob: 'AQID' } }
    ],
    structuredContent: { count: 6, vendorResult: 'kept' },
    isError: false,
    _meta: { server: 'synthetic' },
    vendorResult: { retained: true }
  };

  assert.strictEqual(validateMcpCallToolResult(result), result);
  assert.equal(result.content[0].vendorBlock.retained, true);
  assert.equal(result.vendorResult.retained, true);
});

test('MCP call results reject malformed envelopes and content blocks safely', () => {
  const invalid = [
    null,
    'text result',
    [],
    {},
    { content: {} },
    { content: ['text'] },
    { content: [{ type: 'unknown', payload: 'ignored' }] },
    { content: [{ type: 'text', text: 7 }] },
    { content: [{ type: 'image', data: 'AQID' }] },
    { content: [{ type: 'audio', data: 'AQID', mimeType: 12 }] },
    { content: [{ type: 'resource_link', name: 'missing-uri' }] },
    { content: [{ type: 'resource_link', name: 'icon', uri: 'mcp-resource://icon', icons: [{}] }] },
    { content: [{ type: 'resource', resource: { uri: 'mcp-resource://empty' } }] },
    { content: [{ type: 'resource', resource: { uri: 'mcp-resource://ambiguous', text: 'text', blob: 'AQID' } }] },
    { content: [{ type: 'text', text: 'x', annotations: { audience: ['system'] } }] },
    { content: [{ type: 'text', text: 'x', _meta: [] }] },
    { content: [], structuredContent: [] },
    { content: [], isError: 1 },
    { content: [], _meta: null }
  ];

  for (const value of invalid) assert.throws(() => validateMcpCallToolResult(value), { message: malformedMessage });
});

test('MCP result validation errors do not echo malformed payload data', () => {
  const payload = { content: [{ type: 'text', text: 7, vendorPayload: 'do-not-echo-marker' }] };
  assert.throws(() => validateMcpCallToolResult(payload), (error) => {
    assert.equal(error.message, malformedMessage);
    assert.equal(error.message.includes('do-not-echo-marker'), false);
    return true;
  });
});

test('HTTP MCP tool calls enforce result shape after reviewed discovery', async (t) => {
  const { default: http } = await import('node:http');
  const { discoverMcpServer, callMcpTool } = await import('../lib/mcp-client.mjs');
  let payload = { content: [{ type: 'text', text: 'ok' }] };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-shape', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
        : payload;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { transport: 'http', local: true, url: `http://127.0.0.1:${server.address().port}/mcp` };
  const discovered = await discoverMcpServer(config);
  const options = { expectedToolSetDigest: discovered.toolSetDigest, expectedToolDigest: discovered.tools[0].digest };
  assert.equal((await callMcpTool(config, {}, 'echo', {}, options)).content[0].text, 'ok');
  for (const invalid of [null, 'do-not-echo-marker', {}, { content: [{ type: 'text', text: 7 }] }]) {
    payload = invalid;
    await assert.rejects(callMcpTool(config, {}, 'echo', {}, options), { message: malformedMessage });
  }
});
