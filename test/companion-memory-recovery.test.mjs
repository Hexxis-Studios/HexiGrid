import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('bundled companion preserves memory recovery data and closes its client on failure', async () => {
  const source = await readFile(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs', import.meta.url), 'utf8');
  const command = source.slice(source.indexOf('async function command('), source.indexOf('async function signedRequest('));
  const emitted = [];
  let closed = 0;
  const error = { code: -32000, message: 'Memory context project is invalid.',
    data: { reason: 'request-rejected', automaticRetries: 0, discovery: { method: 'tools/list' } } };
  const context = { process: { exitCode: 0 }, output: value => emitted.push(value),
    openSaved: async () => ({ client: { linkRequest: async () => ({ ok: true, status: 200,
      body: { jsonrpc: '2.0', id: 1, error } }), close: async () => { closed++; } } }) };
  vm.createContext(context);
  vm.runInContext(command, context);
  await context.command({}, '/agent-link/v1/memory-mcp', {});
  assert.equal(context.process.exitCode, 1);
  assert.equal(emitted[0].ok, false);
  assert.deepEqual(emitted[0].result.error, error);
  assert.equal(closed, 1);
});
