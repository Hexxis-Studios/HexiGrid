import test from 'node:test';
import assert from 'node:assert/strict';
import { usageBudgetFeedback } from '../lib/budget-feedback.mjs';

test('7-day token budget reports remaining amount and flips flags after consumption', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const records = [{ createdAt: new Date(now - 1000).toISOString(), inputTokens: 20, outputTokens: 10 }];
  assert.deepEqual(usageBudgetFeedback(100, records, now), { window: '7d', limit: 100, used: 30, remaining: 70, flag: 'under-budget' });
  records.push({ createdAt: new Date(now).toISOString(), inputTokens: 70, outputTokens: 10 });
  assert.equal(usageBudgetFeedback(100, records, now).remaining, 0);
  assert.equal(usageBudgetFeedback(100, records, now).flag, 'exhausted');
});
