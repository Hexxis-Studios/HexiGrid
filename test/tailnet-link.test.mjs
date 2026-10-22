import test from 'node:test';
import assert from 'node:assert/strict';
import { TailnetLink, isPrivateTailnetHost } from '../lib/tailnet-link.mjs';

test('private tailnet host detection accepts only ts.net names', () => {
  assert.equal(isPrivateTailnetHost('exampleowner.example.ts.net'), true);
  assert.equal(isPrivateTailnetHost('exampleowner.example.ts.net:443'), true);
  assert.equal(isPrivateTailnetHost('127.0.0.1:4318'), false);
  assert.equal(isPrivateTailnetHost('example.com'), false);
});

test('tailnet adapter starts and stops only its loopback Serve mapping', async () => {
  const target = 'http://127.0.0.1:4318';
  let serve = {};
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'version') return '1.90.0';
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'exampleowner.tail.test.ts.net.' } });
    if (args[0] === 'serve' && args[1] === 'status') return JSON.stringify(serve);
    if (args[0] === 'serve' && args[1] === '--bg') { serve = { Web: { 'exampleowner.tail.test.ts.net:443': { Handlers: { '/': { Proxy: target } } } } }; return '';
    }
    if (args[0] === 'serve' && args[1] === 'reset') { serve = {}; return ''; }
    throw new Error(`Unexpected call: ${args.join(' ')}`);
  };
  const link = new TailnetLink({ port: 4318, candidates: ['tailscale-test'], runner });
  assert.equal((await link.inspect()).running, false);
  assert.equal((await link.start()).url, 'https://exampleowner.tail.test.ts.net');
  assert.equal((await link.inspect()).running, true);
  assert.equal((await link.stop()).running, false);
  assert.ok(calls.some((args) => args.join(' ') === 'serve --bg --yes http://127.0.0.1:4318'));
});

test('tailnet adapter refuses to overwrite another Serve target', async () => {
  const runner = async (_command, args) => {
    if (args[0] === 'version') return '1.90.0';
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'exampleowner.tail.test.ts.net.' } });
    if (args[0] === 'serve' && args[1] === 'status') return JSON.stringify({ Web: { host: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } });
    throw new Error('The conflicting configuration must not be changed.');
  };
  const link = new TailnetLink({ port: 4318, candidates: ['tailscale-test'], runner });
  await assert.rejects(() => link.start(), /different configuration/);
});
