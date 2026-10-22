import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const begin = source.indexOf("  if (pathname === '/api/live/realtime/call' && method === 'POST') {");
const end = source.indexOf("  if (pathname === '/api/live/custom-voice'", begin);
assert.ok(begin >= 0 && end > begin);
const route = source.slice(begin, end);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ key = async () => 'synthetic-key', handshake } = {}) {
  const res = new EventEmitter(); res.writableEnded = false;
  const receipts = [], responses = [], calls = [];
  const provider = { id: 'synthetic', enabled: true, hasKey: true, name: 'Synthetic', capabilities: ['realtime'], modelIds: ['model'] };
  const state = { providers: [provider], settings: { approvalPolicy: 'full', workMode: 'converse' }, receipts };
  const run = vm.runInNewContext(`(async () => { ${route} })`, { pathname: '/api/live/realtime/call', method: 'POST', req: {}, res, state, AbortController,
    readBody: async () => ({ providerId: provider.id, model: 'model', agentId: 'agent', sdp: 'offer' }), cleanString: value => String(value || ''),
    findAgent: () => ({ name: 'Synthetic agent', useGlobalCommunication: false }), evaluatePolicy: () => ({ decision: 'allow' }),
    credentialVault: { get: key }, createRealtimeCall: async (...args) => { calls.push(args); return handshake ? handshake(...args) : { answerSdp: 'answer' }; },
    addReceipt: receipt => receipts.unshift(receipt), addActivity() {}, saveState: async () => {},
    json: (_res, status, body) => { res.writableEnded = true; responses.push({ status, body }); }
  });
  const disconnect = () => res.emit('close');
  return { res, receipts, responses, calls, run, disconnect };
}

test('disconnect before vault lookup completes prevents provider dispatch', async () => {
  const key = deferred(); const f = fixture({ key: () => key.promise });
  const done = f.run(); await tick(); f.disconnect(); key.resolve('synthetic-key'); await done;
  assert.equal(f.calls.length, 0); assert.equal(f.responses.length, 0);
  assert.equal(f.receipts[0].status, 'cancelled'); assert.equal(f.res.listenerCount('close'), 0);
});

test('disconnect aborts exact provider handshake and a late result cannot claim success', async () => {
  const answer = deferred(); const f = fixture({ handshake: () => answer.promise });
  const done = f.run(); await tick(); const signal = f.calls[0][3].signal;
  assert.equal(signal.aborted, false); f.disconnect(); assert.equal(signal.aborted, true);
  answer.resolve({ answerSdp: 'late' }); await done;
  assert.equal(f.responses.length, 0); assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].status, 'cancelled'); assert.match(f.receipts[0].detail, /may still incur usage/);
  assert.equal(f.res.listenerCount('close'), 0);
});

test('normal success and genuine provider failure retain truthful receipts and remove listeners', async () => {
  const normal = fixture(); await normal.run();
  assert.equal(normal.responses[0].status, 201); assert.equal(normal.receipts[0].status, 'completed');
  normal.disconnect(); assert.equal(normal.calls[0][3].signal.aborted, false);
  const failure = fixture({ handshake: async () => { throw new Error('Provider unreachable'); } }); await failure.run();
  assert.equal(failure.responses[0].status, 502); assert.equal(failure.receipts[0].status, 'failed');
  assert.equal(failure.res.listenerCount('close'), 0);
});
