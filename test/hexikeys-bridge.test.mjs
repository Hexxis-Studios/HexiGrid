import assert from 'node:assert/strict';
import net from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createHexiKeysBridgeClient,
  validateHexiKeysCaptureRequest,
  MAX_HEXKEYS_BRIDGE_FRAME_BYTES,
} from '../lib/hexikeys-bridge.mjs';

const key = Buffer.from(Array.from({ length: 32 }, (_unused, index) => index));

function captureRequest() { return { requestId: 'a'.repeat(32), title: 'Synthetic API credential', category: 'API key', fieldLabel: 'Token', requestedBy: 'Owner agent Link fixture', expiresAt: Math.floor(Date.now() / 1000) + 30 }; }
test('capture accepts only bounded nonsecret form intent with a short host-derived expiry', () => {
  assert.equal(Object.isFrozen(validateHexiKeysCaptureRequest(captureRequest())), true);
  for (const request of [{ ...captureRequest(), value: 'must-not-be-accepted' }, { ...captureRequest(), category: 'unsupported' }, { ...captureRequest(), title: 'x'.repeat(121) }, { ...captureRequest(), fieldLabel: 'line\nbreak' }, { ...captureRequest(), expiresAt: 0 }, { ...captureRequest(), expiresAt: Math.floor(Date.now() / 1000) + 120 }]) assert.throws(() => validateHexiKeysCaptureRequest(request));
});

test('requires a strict local pipe identity and caller-supplied key', () => {
  assert.throws(() => createHexiKeysBridgeClient({ pipeId: 'server/pipe', key }));
  assert.throws(() => createHexiKeysBridgeClient({ pipeId: `hexikeys-${'A'.repeat(32)}`, key }));
  assert.throws(() => createHexiKeysBridgeClient({ pipeId: `hexikeys-${'a'.repeat(32)}`, key: Buffer.alloc(16) }));
});

function responseEnvelope(responseKey, nonce, payload, { responseNonce = nonce } = {}) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const mac = createHmac('sha256', responseKey)
    .update(`res\0v1\0${responseNonce}\0${payloadB64}`, 'utf8')
    .digest('hex');
  return Buffer.from(JSON.stringify({ v: 1, nonce: responseNonce, payload: payloadB64, mac }), 'utf8');
}

async function fakePipe(reply) {
  const pipeId = `hexikeys-${randomBytes(16).toString('hex')}`;
  const pipePath = `\\\\.\\pipe\\${pipeId}`;
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    let done = false;
    socket.on('data', (chunk) => {
      if (done) return;
      input = Buffer.concat([input, chunk]);
      if (input.length < 4) return;
      const size = input.readUInt32BE(0);
      if (size < 1 || size > MAX_HEXKEYS_BRIDGE_FRAME_BYTES) {
        done = true;
        socket.destroy();
        return;
      }
      if (input.length < size + 4) return;
      done = true;
      const requestEnvelope = JSON.parse(input.subarray(4, size + 4).toString('utf8'));
      const body = reply(requestEnvelope);
      const frame = Buffer.allocUnsafe(body.length + 4);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      socket.end(frame);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  return { pipeId, server };
}

test('authenticated capture RPC sends metadata only and rejects secret-bearing replies', { skip: process.platform !== 'win32' }, async () => {
  for (const extra of [false, true]) {
    const { pipeId, server } = await fakePipe(envelope => {
      const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
      assert.equal(payload.op, 'request-new-item');
      assert.equal(Object.hasOwn(payload, 'value'), false);
      return responseEnvelope(key, envelope.nonce, { ok: true, opened: true, ...(extra ? { value: 'untrusted' } : {}) });
    });
    const client = createHexiKeysBridgeClient({ pipeId, key });
    try { if (extra) await assert.rejects(client.requestCapture(captureRequest())); else assert.deepEqual(await client.requestCapture(captureRequest()), { opened: true }); }
    finally { await client.close(); await new Promise(resolve => server.close(resolve)); }
  }
});

function consumeRequest() {
  return {
    grantId: 'a'.repeat(32), requestId: 'b'.repeat(32),
    connectorId: 'hexikeys', capabilityId: 'api-request', taskId: 'bridge-test-task',
    origin: 'https://api.example.invalid:443/', path: '/v1/records/42',
    method: 'get', header: 'authorization', prefix: '',
  };
}

function consumeReceipt(request) {
  return {
    grantId: request.grantId, requestId: request.requestId,
    connectorId: request.connectorId, capabilityId: request.capabilityId, taskId: request.taskId,
    origin: 'https://api.example.invalid', method: 'GET', usedAt: 1_800_000_000,
    status: 'authorized',
  };
}

test('binds every receipt scope to the submitted request snapshot', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const field of ['grantId', 'requestId', 'connectorId', 'capabilityId', 'taskId', 'origin', 'method']) {
    const request = consumeRequest();
    const receipt = consumeReceipt(request);
    receipt[field] = field === 'origin' ? 'https://other.example.invalid' : 'other';
    const { pipeId, server } = await fakePipe((envelope) => responseEnvelope(key, envelope.nonce, {
      ok: true, value: 'SYNTHETIC-ONLY-bridge-token', receipt,
    }));
    const client = createHexiKeysBridgeClient({ pipeId, key, timeoutMs: 1000 });
    try {
      await assert.rejects(client.consume(request), (error) => error.code === 'authentication');
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const request = consumeRequest();
  const receipt = consumeReceipt(request);
  const { pipeId, server } = await fakePipe((envelope) => {
    const submitted = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    assert.equal(submitted.prefix, '');
    return responseEnvelope(key, envelope.nonce, { ok: true, value: 'SYNTHETIC-ONLY-bridge-token', receipt });
  });
  const client = createHexiKeysBridgeClient({ pipeId, key, timeoutMs: 1000 });
  try {
    const pending = client.consume(request);
    request.requestId = 'c'.repeat(32);
    request.origin = 'https://other.example.invalid';
    assert.deepEqual((await pending).receipt, receipt);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cancellation and close promptly terminate pending pipe requests', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const action of ['abort', 'close']) {
    const pipeId = `hexikeys-${randomBytes(16).toString('hex')}`;
    let connected;
    const received = new Promise((resolve) => { connected = resolve; });
    const server = net.createServer((socket) => socket.once('data', connected));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(`\\\\.\\pipe\\${pipeId}`, resolve);
    });
    const client = createHexiKeysBridgeClient({ pipeId, key, timeoutMs: 30000 });
    const controller = new AbortController();
    try {
      const pending = client.status({ signal: controller.signal });
      const rejection = assert.rejects(pending, (error) => error.code === (action === 'abort' ? 'aborted' : 'transport'));
      await received;
      const startedAt = Date.now();
      if (action === 'abort') controller.abort();
      else await client.close();
      await rejection;
      assert.ok(Date.now() - startedAt < 1000);
      await client.close();
      await assert.rejects(client.status(), (error) => error.code === 'closed');
      assert.deepEqual(key, Buffer.from(Array.from({ length: 32 }, (_unused, index) => index)));
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('rejects status totals smaller than their returned page and negative counters', {
  skip: process.platform !== 'win32',
}, async () => {
  const grant = {
    id: 'a'.repeat(32), itemName: 'Fixture', fieldLabel: 'Token',
    connectorId: 'hexikeys', capabilityId: 'api-request', taskId: 'fixture',
    origin: 'https://api.example.invalid', pathPrefix: '/v1', methods: ['GET'],
    header: 'authorization', prefix: 'Bearer ', expiresAt: 1_800_000_000, maxUses: 1, uses: 0, revoked: false,
  };
  for (const payload of [
    { ok: true, unlocked: true, grants: [grant], total: 0, nextOffset: null },
    { ok: true, unlocked: true, grants: [{ ...grant, uses: -1 }], total: 1, nextOffset: null },
  ]) {
    const { pipeId, server } = await fakePipe((envelope) => responseEnvelope(key, envelope.nonce, payload));
    const client = createHexiKeysBridgeClient({ pipeId, key, timeoutMs: 1000 });
    try {
      await assert.rejects(client.status(), (error) => error.code === 'authentication');
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('rejects response MACs that fail authentication or reuse a different nonce', {
  skip: process.platform !== 'win32',
}, async () => {
  const status = { ok: true, unlocked: true, grants: [], total: 0, nextOffset: null };
  for (const mode of ['wrong-mac', 'wrong-nonce']) {
    const { pipeId, server } = await fakePipe((request) => {
      const responseKey = mode === 'wrong-mac' ? Buffer.alloc(32, 0x7f) : key;
      const options = mode === 'wrong-nonce' ? { responseNonce: 'f'.repeat(64) } : {};
      return responseEnvelope(responseKey, request.nonce, status, options);
    });
    const client = createHexiKeysBridgeClient({ pipeId, key, timeoutMs: 1000 });
    try {
      await assert.rejects(client.status(), (error) => error.code === 'authentication');
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('rejects authenticated status pages without progress and scope-mismatched receipts', {
  skip: process.platform !== 'win32',
}, async () => {
  const badPage = { ok: true, unlocked: true, grants: [], total: 4, nextOffset: 2 };
  const pagePipe = await fakePipe((request) => responseEnvelope(key, request.nonce, badPage));
  const pageClient = createHexiKeysBridgeClient({ pipeId: pagePipe.pipeId, key, timeoutMs: 1000 });
  try {
    await assert.rejects(pageClient.status(), (error) => error.code === 'authentication');
  } finally {
    await pageClient.close();
    await new Promise((resolve) => pagePipe.server.close(resolve));
  }

  const consumeRequest = {
    grantId: 'a'.repeat(32),
    requestId: 'b'.repeat(32),
    connectorId: 'hexikeys',
    capabilityId: 'api-request',
    taskId: 'bridge-test-task',
    origin: 'https://api.example.invalid:443/',
    path: '/v1/records/42',
    method: 'get',
    header: 'authorization',
    prefix: 'Bearer ',
  };
  const receipt = {
    grantId: consumeRequest.grantId,
    requestId: consumeRequest.requestId,
    connectorId: consumeRequest.connectorId,
    capabilityId: consumeRequest.capabilityId,
    taskId: consumeRequest.taskId,
    origin: 'https://other.example.invalid',
    method: 'GET',
    usedAt: 1_800_000_000,
    status: 'authorized',
  };
  const consumePipe = await fakePipe((request) => responseEnvelope(key, request.nonce, {
    ok: true,
    value: 'SYNTHETIC-ONLY-bridge-token',
    receipt,
  }));
  const consumeClient = createHexiKeysBridgeClient({ pipeId: consumePipe.pipeId, key, timeoutMs: 1000 });
  try {
    await assert.rejects(consumeClient.consume(consumeRequest), (error) => error.code === 'authentication');
  } finally {
    await consumeClient.close();
    await new Promise((resolve) => consumePipe.server.close(resolve));
  }
});

test('client deadline closes a connected peer that withholds a response', {
  skip: process.platform !== 'win32',
}, async () => {
  const pipeId = `hexikeys-${randomBytes(16).toString('hex')}`;
  const pipePath = `\\\\.\\pipe\\${pipeId}`;
  const server = net.createServer((socket) => socket.on('data', () => {}));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  const client = createHexiKeysBridgeClient({ pipeId, key, timeoutMs: 150 });
  const startedAt = Date.now();
  try {
    await assert.rejects(client.status(), (error) => error.code === 'timeout');
    assert.ok(Date.now() - startedAt < 1500);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
