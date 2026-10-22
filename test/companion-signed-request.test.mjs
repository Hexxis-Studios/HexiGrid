import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs', import.meta.url));
const source = await fs.readFile(script, 'utf8');
function fixture(input = '', response = { ok: true, status: 200, body: { safe: true } }) {
  const f = { calls: [], opened: 0, closed: 0, packets: [] };
  const fakeProcess = { stdin: Readable.from([Buffer.from(input)]), exitCode: 0 };
  const context = vm.createContext({ fs, Buffer, TextDecoder, process: fakeProcess,
    requireFlag(flags, name) { if (typeof flags[name] !== 'string' || !flags[name].trim()) throw Error(`Supply --${name}`); return flags[name].trim(); },
    validConnectionId(value) { assert.match(value, /^link-[A-Za-z0-9-]+$/); return value; },
    output(value) { f.packets.push(JSON.parse(JSON.stringify(value))); },
    async openSaved(_flags, options) {
      f.opened++; assert.equal(options.automaticControl, false);
      return { record: { lastSequence: 123 }, client: {
        async linkRequest(pathname, options) { f.calls.push({ pathname, options: JSON.parse(JSON.stringify(options)) }); return response; },
        async close() { f.closed++; }
      } };
    } });
  vm.runInContext(source.slice(source.indexOf('async function command(flags'), source.indexOf('async function desktopFrame(flags)')), context);
  f.run = flags => context.signedRequest({ connection: 'link-synthetic-request', ...flags });
  f.process = fakeProcess;
  return f;
}
test('generic signed GET and stdin MCP request reuse passive transport and retain HTTP status', async () => {
  const get = fixture(); await get.run({ path: '/agent-link/v1/usage' });
  assert.deepEqual(get.calls, [{ pathname: '/agent-link/v1/usage', options: { method: 'GET', headers: {}, body: null } }]);
  assert.deepEqual(get.packets, [{ ok: true, status: 200, result: { safe: true } }]);
  assert.equal(get.closed, 1);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const post = fixture(JSON.stringify(body)); await post.run({ method: 'post', path: '/agent-link/v1/memory-mcp', stdin: true });
  assert.equal(post.calls[0].options.method, 'POST'); assert.deepEqual(post.calls[0].options.body, body);
  assert.equal(post.calls[0].options.headers['content-type'], 'application/json'); assert.equal(post.closed, 1);
});
test('owner paths, URL/path confusion and unknown flags fail before credentials or dispatch', async () => {
  for (const pathname of ['/api/settings', 'https://owner.test/agent-link/v1/usage', '//owner.test/agent-link/v1/usage',
    '/agent-link/v1/../api/settings', '/agent-link/v1/%2e%2e/api/settings', '/agent-link/v1/usage?secret=x',
    '/agent-link/v1/usage#fragment', '/agent-link/v1//usage', '/agent-link/v1/usage\\other']) {
    const f = fixture(); await assert.rejects(f.run({ path: pathname }), /exact.*endpoint/); assert.equal(f.opened, 0);
  }
  for (const flags of [{ method: 'TRACE' }, { stdin: 'yes' }, { stdin: true, file: 'not-read' },
    { method: 'GET', stdin: true }, { authorization: 'private-token' }]) {
    const f = fixture(); await assert.rejects(f.run({ path: '/agent-link/v1/usage', ...flags })); assert.equal(f.opened, 0);
  }
});
test('input is bounded UTF-8 JSON object; parse errors do not echo private text', async () => {
  for (const input of ['{"PRIVATE-PARSE-MARKER"', '[]', 'null', 'true', '', '{"tokens":1e400}', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    const f = fixture(input);
    await assert.rejects(f.run({ method: 'POST', path: '/agent-link/v1/memory-mcp', stdin: true }), error => {
      assert.doesNotMatch(error.message, /PRIVATE-PARSE-MARKER/); return true;
    });
    assert.equal(f.opened, 0);
  }
  const invalid = fixture(); invalid.process.stdin = Readable.from([Buffer.from([0xff])]);
  await assert.rejects(invalid.run({ method: 'POST', path: '/agent-link/v1/memory-mcp', stdin: true }), /UTF-8 JSON/);
  assert.equal(invalid.opened, 0);
});
test('local JSON files are validated before opening the Link and temporary fixture cleans up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-request-'));
  try {
    const file = path.join(dir, 'body.json'); await writeFile(file, '{"tokens":100,"expectedTokens":null}');
    const f = fixture(); await f.run({ method: 'PUT', path: '/agent-link/v1/usage/budget', file });
    assert.deepEqual(f.calls[0].options.body, { tokens: 100, expectedTokens: null });
    await writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    const oversized = fixture(); await assert.rejects(oversized.run({ method: 'PUT', path: '/agent-link/v1/usage/budget', file }), /8 MiB/);
    assert.equal(oversized.opened, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('HTTP and MCP denials remain failures, expose status and close the session exactly once', async () => {
  for (const response of [{ ok: false, status: 403, body: { error: 'Current grant denies this operation.' } },
    { ok: true, status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid arguments.' } } }]) {
    const f = fixture('', response); await f.run({ path: '/agent-link/v1/usage' });
    assert.equal(f.packets[0].ok, false); assert.equal(f.packets[0].status, response.status);
    assert.equal(f.process.exitCode, 1); assert.equal(f.opened, 1); assert.equal(f.closed, 1); assert.equal(f.calls.length, 1);
  }
});
test('real CLI rejects invalid paths and malformed stdin without touching a saved connection', () => {
  const help = spawnSync(process.execPath, [script, 'request', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /--stdin.*--file/); assert.match(help.stdout, /Current signed authority/);
  const invalid = spawnSync(process.execPath, [script, 'request', '--connection', 'link-unused', '--path', '/api/settings'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /exact.*endpoint/);
  const malformed = spawnSync(process.execPath, [script, 'request', '--connection', 'link-unused', '--method', 'POST', '--path', '/agent-link/v1/memory-mcp', '--stdin'], { input: '{"PRIVATE-CLI-MARKER"', encoding: 'utf8' });
  assert.equal(malformed.status, 1); assert.match(malformed.stderr, /UTF-8 JSON/); assert.doesNotMatch(malformed.stderr, /PRIVATE-CLI-MARKER|ENOENT|vault/i);
});
