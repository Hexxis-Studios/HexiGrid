import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { completeWithProvider } from '../lib/providers.mjs';

test('provider recovers when a loopback model stub becomes available during retry', { timeout: 5000 }, async () => {
  let available = false;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (!available) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const result = await completeWithProvider({ baseUrl: `http://127.0.0.1:${port}/v1` }, '', 'synthetic-model', 'Say ready', {
      maxAttempts: 2,
      sleep: async ms => { await delay(ms); available = true; }
    });

    assert.equal(result.content, 'ready');
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
