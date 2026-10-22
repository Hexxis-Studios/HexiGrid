import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCodexDeliveryReview, publicCodexDeliveries } from '../lib/codex-delivery-review.mjs';

function fixture(options = {}) {
  const job = { id: 'message-qa', threadId: 'qa-thread', delivery: 'delivery-uncertain', text: 'PRIVATE PROMPT', tokenHash: 'SECRET', observation: { cursor: 'PRIVATE CURSOR' } };
  const state = { codexRelayPending: [job], receipts: [] }, locks = new Set();
  let result, saves = 0;
  const ctx = { state, pathname: '/api/codex-deliveries/message-qa/dismiss', method: 'POST', json(_res, status, body) { result = { status, body }; },
    isOwner: () => options.owner !== false, policy: () => options.denied || null,
    readBody: async () => options.body || { decision: 'dismiss', expectedDelivery: 'delivery-uncertain', approved: true },
    isActive: () => options.active === true, isLocked: id => locks.has(id), lock: id => locks.add(id), unlock: id => locks.delete(id),
    addReceipt(receipt) { state.receipts.push(receipt); return receipt; }, async saveState() { saves++; if (options.failSave) throw Error('PRIVATE STORAGE DETAIL'); }
  };
  return { job, state, ctx, run: async () => { await handleCodexDeliveryReview({}, {}, ctx); return result; }, saves: () => saves };
}
test('pending projection exposes only safe standing, never contents or observation', () => {
  const { state } = fixture();
  const result = publicCodexDeliveries(state.codexRelayPending);
  assert.equal(result[0].reviewRequired, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|tokenHash|observation|text/);
});
test('dismiss removes only held tracking, writes a content-free receipt and never resends', async () => {
  const f = fixture(); f.state.codexRelayPending.push({ id: 'other', delivery: 'awaiting-reply' });
  assert.deepEqual((await f.run()).body, { dismissed: true, id: 'message-qa', resent: false, taskStopped: false });
  assert.deepEqual(f.state.codexRelayPending.map(j => j.id), ['other']); assert.equal(f.saves(), 1);
  assert.equal(f.state.receipts[0].status, 'cancelled'); assert.doesNotMatch(JSON.stringify(f.state.receipts), /PRIVATE|SECRET/);
  assert.equal((await f.run()).status, 404); assert.equal(f.saves(), 1);
});
for (const [name, opts, status] of [['non-owner', { owner: false }, 403], ['Plan', { denied: { denied: true } }, 403], ['unapproved', { denied: { denied: false } }, 409], ['active observer', { active: true }, 409], ['invalid decision', { body: { decision: 'retry' } }, 400]]) {
  test(`dismiss refuses ${name} and preserves job`, async () => { const f = fixture(opts); assert.equal((await f.run()).status, status); assert.equal(f.state.codexRelayPending[0], f.job); assert.equal(f.saves(), 0); assert.equal(f.state.receipts.length, 0); });
}
test('changed delivery standing cannot dismiss acknowledged tracking', async () => { const f = fixture(); f.job.delivery = 'awaiting-reply'; assert.equal((await f.run()).status, 409); assert.equal(f.saves(), 0); });
test('storage failure rolls back only this dismissal and its receipt', async () => {
  const f = fixture({ failSave: true }); const result = await f.run();
  assert.equal(result.status, 500); assert.doesNotMatch(result.body.error, /PRIVATE/); assert.equal(f.state.codexRelayPending[0], f.job); assert.equal(f.state.receipts.length, 0);
});
test('read is local-owner only and metadata only', async () => {
  const f = fixture(); f.ctx.pathname = '/api/codex-deliveries'; f.ctx.method = 'GET';
  assert.equal((await f.run()).status, 200); assert.equal(f.saves(), 0);
  assert.doesNotMatch(JSON.stringify((await f.run()).body), /PRIVATE|SECRET/);
});
