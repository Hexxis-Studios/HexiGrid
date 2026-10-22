import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLinkPreviewRequest } from '../lib/link-preview-routes.mjs';

function harness({ method = 'POST', pathname = '/api/link-preview', policy = null, fetchPreview } = {}) {
  const output = {};
  const receipts = [];
  const handled = handleLinkPreviewRequest({}, {}, {
    method, pathname,
    readBody: async () => ({ url: 'https://provider.example/article', approved: true }),
    connectorPolicy: () => policy,
    fetchPreview,
    addReceipt: (receipt) => receipts.push(receipt),
    json: (_res, status, body) => { output.status = status; output.body = body; }
  });
  return { handled, output, receipts };
}

test('link preview route returns sanitized metadata and short-lived cache hits', async () => {
  let calls = 0;
  const fetchPreview = async (url) => { calls += 1; return { url, title: '<safe>', description: 'bounded', image: '', fetchedAt: '2026-09-18T00:00:00.000Z' }; };
  const first = harness({ fetchPreview });
  assert.equal(await first.handled, true);
  assert.equal(first.output.status, 200);
  assert.equal(first.output.body.cached, false);
  assert.equal(calls, 1);
  const second = harness({ fetchPreview });
  assert.equal(await second.handled, true);
  assert.equal(second.output.status, 200);
  assert.equal(second.output.body.cached, true);
  assert.equal(calls, 1);
  assert.equal(first.receipts[0].detail.includes('provider.example'), true);
});

test('link preview route respects the active policy and does not dispatch a denied fetch', async () => {
  let called = false;
  const result = harness({ policy: { denied: true, error: 'network denied' }, fetchPreview: async () => { called = true; return {}; } });
  assert.equal(await result.handled, true);
  assert.equal(result.output.status, 403);
  assert.equal(called, false);
  assert.deepEqual(result.receipts, []);
});
