import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPracticeServer } from '../scripts/serve-agent-practice.mjs';

test('practice app serves only its two fixed assets on a separate loopback origin', async () => {
  const server = await createPracticeServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /HexiGrid Agent Practice/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(page.headers.get('content-security-policy'), /form-action 'none'/);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${origin}/practice.js`)).status, 200);
    assert.equal((await fetch(origin, { method: 'POST', body: 'discard this' })).status, 405);
    for (const pathname of ['/api/agent-links', '/server.mjs', '/data/.runtime.json', '/%2e%2e/server.mjs']) assert.equal((await fetch(origin + pathname)).status, 404);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(origin, { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
