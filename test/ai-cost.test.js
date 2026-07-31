import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRICING, usageCostUsd, AiUsageAccumulator } from '../ai-cost.js';

const usage = (i, o, cr = 0, cc = 0) => ({ inputTokens: i, outputTokens: o, cacheRead: cr, cacheCreation: cc });

test('usageCostUsd: prices a call at the per-million rates', () => {
  // deepseek-v4-flash: input 0.14, output 0.28 per 1M.
  const cost = usageCostUsd(usage(1_000_000, 1_000_000), 'deepseek-v4-flash');
  assert.ok(Math.abs(cost - 0.42) < 1e-9, `expected 0.42, got ${cost}`);
});

test('usageCostUsd: cache reads are billed far below fresh input', () => {
  const fresh  = usageCostUsd(usage(1_000_000, 0), 'deepseek-v4-flash');
  const cached = usageCostUsd(usage(0, 0, 1_000_000, 0), 'deepseek-v4-flash');
  assert.ok(cached < fresh / 10, `cache read ${cached} should be far under fresh ${fresh}`);
});

test('usageCostUsd: an unknown model falls back rather than returning NaN', () => {
  const cost = usageCostUsd(usage(1000, 1000), 'no-such-model');
  assert.ok(Number.isFinite(cost) && cost > 0, `got ${cost}`);
});

test('usageCostUsd: missing usage fields count as zero, never NaN', () => {
  assert.equal(usageCostUsd({}, 'deepseek-v4-flash'), 0);
  assert.equal(usageCostUsd(null, 'deepseek-v4-flash'), 0);
});

test('AiUsageAccumulator: sums across calls and prices the total', () => {
  const acc = new AiUsageAccumulator();
  acc.add(usage(1000, 500));
  acc.add(usage(2000, 250, 100));
  assert.equal(acc.totals.inputTokens, 3000);
  assert.equal(acc.totals.outputTokens, 750);
  assert.equal(acc.totals.cacheRead, 100);
  const expected = usageCostUsd(usage(3000, 750, 100), 'deepseek-v4-flash');
  assert.ok(Math.abs(acc.costUsd('deepseek-v4-flash') - expected) < 1e-12);
});

test('AiUsageAccumulator: tolerates a malformed usage object', () => {
  const acc = new AiUsageAccumulator();
  acc.add(null);
  acc.add({ inputTokens: 'x' });
  assert.equal(acc.totals.inputTokens, 0);
  assert.equal(acc.costUsd('deepseek-v4-flash'), 0);
});
