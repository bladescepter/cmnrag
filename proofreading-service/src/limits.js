// Local test guardrails. SDK costs are estimates, NOT a provider-side spending cap.
export const TEST_LIMITS = Object.freeze({
  maxDraftChars: 1200,
  maxCalls: 5,
  maxOutputTokensPerCall: 2048,
  maxTotalTokens: 160_000,
  maxEstimatedUsd: 0.05,
});

// Web execution tracks usage, but has no smoke-test token/dollar ceilings.
export function createWebBudget() {
  return createTestBudget({ maxCalls: Infinity, maxTotalTokens: Infinity, maxEstimatedUsd: Infinity }, false);
}

export function createTestBudget(limits = TEST_LIMITS, strictUsage = true) {
  let calls = 0;
  let totalTokens = 0;
  let estimatedUsd = 0;
  let invalid = false;
  return {
    beforeCall() {
      if (invalid || calls >= limits.maxCalls || totalTokens >= limits.maxTotalTokens || estimatedUsd >= limits.maxEstimatedUsd) throw new Error('test_budget_exceeded');
      calls++; // Reserve before contacting provider, including failed or interrupted requests.
    },
    record(message) {
      if (invalid || message?.role !== 'assistant' || !message.usage) { invalid = strictUsage; throw new Error('usage_unavailable'); }
      const usage = message.usage;
      const tokens = usage.totalTokens;
      const cost = usage.cost?.total;
      if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(cost) || cost < 0 || (cost === 0 && tokens > 0)) {
        invalid = strictUsage;
        throw new Error('usage_unavailable');
      }
      totalTokens += tokens;
      estimatedUsd += cost;
      // A completed response has already incurred its cost. Keep it; any configured
      // smoke-test ceiling prevents the NEXT request rather than discarding this one.
    },
    snapshot() { return { calls, totalTokens, estimatedUsd }; },
  };
}
