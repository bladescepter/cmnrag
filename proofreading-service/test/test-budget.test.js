import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_LIMITS, createTestBudget, createWebBudget } from '../src/limits.js';
const usage = (totalTokens, cost) => ({ role: 'assistant', usage: { totalTokens, cost: { total: cost } } });

test('single-draft test caps requests at the configured maximum and records estimated usage', () => {
  const budget = createTestBudget();
  for (let n = 0; n < TEST_LIMITS.maxCalls; n++) {
    budget.beforeCall();
    budget.record(usage(1000, 0.003));
  }
  assert.deepEqual(budget.snapshot(), { calls: TEST_LIMITS.maxCalls, totalTokens: TEST_LIMITS.maxCalls * 1000, estimatedUsd: TEST_LIMITS.maxCalls * 0.003 });
  assert.throws(() => budget.beforeCall(), /test_budget_exceeded/);
  assert.equal(TEST_LIMITS.maxOutputTokensPerCall, 2048);
});

test('stops before another request once token or estimated cost ceiling is reached', () => {
  const byTokens = createTestBudget();
  byTokens.beforeCall();
  byTokens.record(usage(TEST_LIMITS.maxTotalTokens, 0.02));
  assert.throws(() => byTokens.beforeCall(), /test_budget_exceeded/);
  const byCost = createTestBudget();
  byCost.beforeCall();
  assert.doesNotThrow(() => byCost.record(usage(1000, 0.06))); // Keep the already-paid response.
  assert.equal(byCost.snapshot().estimatedUsd, 0.06);
  assert.throws(() => byCost.beforeCall(), /test_budget_exceeded/);
});

test('web usage has no call, token or cost ceiling; native tool loops may run many rounds', () => {
  const budget = createWebBudget();
  for (let i = 0; i < 12; i++) {
    budget.beforeCall();
    budget.record(usage(100000, 0.06));
  }
  const snapshot = budget.snapshot();
  assert.equal(snapshot.calls, 12);
  assert.equal(snapshot.totalTokens, 1200000);
  assert.ok(Math.abs(snapshot.estimatedUsd - 0.72) < 1e-9);
  budget.beforeCall(); // A thirteenth round is allowed; the web path records, it does not cap.
  budget.record(usage(1, 0.001));
  assert.equal(budget.snapshot().calls, 13);
  assert.equal(TEST_LIMITS.maxCalls, 5); // Only the explicit CLI experiment keeps the small stop-loss.
});

test('missing usage on the web path no longer fails closed', () => {
  const budget = createWebBudget();
  budget.beforeCall();
  budget.record(usage(1000, 0.003));
  assert.throws(() => budget.record(usage(0, 0)), /usage_unavailable/); // Signals the bookkeeping gap…
  budget.beforeCall();
  budget.record(usage(1000, 0.003)); // …but the runner catches it and keeps executing.
  assert.equal(budget.snapshot().calls, 2);
  assert.equal(budget.snapshot().totalTokens, 2000);
  assert.throws(() => createTestBudget().record(usage(0, 0)), /usage_unavailable/); // CLI experiments stay strict.
  const strict = createTestBudget();
  strict.beforeCall();
  assert.throws(() => strict.record(usage(0, 0)), /usage_unavailable/);
  assert.throws(() => strict.beforeCall(), /test_budget_exceeded/); // Strict mode poisons the budget; web mode does not.
});

test('crossing a configured ceiling on the final response keeps the response', () => {
  const budget = createTestBudget();
  for (let i = 0; i < 5; i++) {
    budget.beforeCall();
    budget.record(usage(1000, i === 4 ? 0.06 : 0.001));
  }
  assert.equal(budget.snapshot().calls, 5);
  assert.ok(budget.snapshot().estimatedUsd > TEST_LIMITS.maxEstimatedUsd);
});

test('missing, zero or invalid usage fails closed, including model errors', () => {
  const budget = createTestBudget();
  budget.beforeCall();
  assert.throws(() => budget.record(usage(0, 0)), /usage_unavailable/);
  assert.throws(() => budget.beforeCall(), /test_budget_exceeded/);
  assert.throws(() => createTestBudget().record({ role: 'assistant', usage: { totalTokens: 5, cost: { total: NaN } } }), /usage_unavailable/);
});
