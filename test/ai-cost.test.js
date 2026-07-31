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

test('usageCostUsd: prototype-chain keys fall back to default model, not NaN', () => {
  // Test inherited properties that would poison with NaN if not guarded.
  const dangerous = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  const fallbackCost = usageCostUsd(usage(1000, 1000), 'deepseek-v4-flash');
  for (const key of dangerous) {
    const cost = usageCostUsd(usage(1000, 1000), key);
    assert.ok(Number.isFinite(cost) && cost > 0, `${key} should fall back, got ${cost}`);
    assert.equal(cost, fallbackCost, `${key} should match fallback cost`);
  }
});

test('usageCostUsd: null and undefined models fall back to default', () => {
  const fallbackCost = usageCostUsd(usage(1000, 1000), 'deepseek-v4-flash');
  assert.equal(usageCostUsd(usage(1000, 1000), null), fallbackCost);
  assert.equal(usageCostUsd(usage(1000, 1000), undefined), fallbackCost);
});

test('usageCostUsd: all four models produce exact expected costs', () => {
  const models = [
    { name: 'claude-sonnet-4-6', input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheRead: 0.30 },
    { name: 'claude-opus-4-7', input: 15.0, output: 75.0, cacheWrite5m: 18.75, cacheRead: 1.50 },
    { name: 'deepseek-v4-flash', input: 0.14, output: 0.28, cacheWrite5m: 0.14, cacheRead: 0.0028 },
    { name: 'deepseek-v4-pro', input: 0.435, output: 0.87, cacheWrite5m: 0.435, cacheRead: 0.003625 },
  ];
  // Test with 1M input tokens to check input rate.
  for (const m of models) {
    const cost = usageCostUsd(usage(1_000_000, 0, 0, 0), m.name);
    assert.ok(Math.abs(cost - m.input) < 1e-9, `${m.name} input rate: expected ${m.input}, got ${cost}`);
  }
  // Test with 1M output tokens to check output rate.
  for (const m of models) {
    const cost = usageCostUsd(usage(0, 1_000_000, 0, 0), m.name);
    assert.ok(Math.abs(cost - m.output) < 1e-9, `${m.name} output rate: expected ${m.output}, got ${cost}`);
  }
  // Test with 1M cacheRead tokens.
  for (const m of models) {
    const cost = usageCostUsd(usage(0, 0, 1_000_000, 0), m.name);
    assert.ok(Math.abs(cost - m.cacheRead) < 1e-9, `${m.name} cacheRead rate: expected ${m.cacheRead}, got ${cost}`);
  }
  // Test with 1M cacheCreation tokens (cacheWrite5m).
  for (const m of models) {
    const cost = usageCostUsd(usage(0, 0, 0, 1_000_000), m.name);
    assert.ok(Math.abs(cost - m.cacheWrite5m) < 1e-9, `${m.name} cacheWrite5m rate: expected ${m.cacheWrite5m}, got ${cost}`);
  }
});

test('usageCostUsd: negative token counts clamp to zero', () => {
  const zeroNegInput = usageCostUsd(usage(-1_000_000, 0), 'deepseek-v4-flash');
  assert.equal(zeroNegInput, 0);
  const zeroNegOutput = usageCostUsd(usage(0, -1_000_000), 'deepseek-v4-flash');
  assert.equal(zeroNegOutput, 0);
  const zeroNegCache = usageCostUsd(usage(0, 0, -1_000_000), 'deepseek-v4-flash');
  assert.equal(zeroNegCache, 0);
  const zeroNegCreation = usageCostUsd(usage(0, 0, 0, -1_000_000), 'deepseek-v4-flash');
  assert.equal(zeroNegCreation, 0);
});

test('AiUsageAccumulator.costUsd: prototype-chain keys fall back to default', () => {
  const acc = new AiUsageAccumulator();
  acc.add(usage(1000, 1000));
  const fallbackCost = acc.costUsd('deepseek-v4-flash');
  const constCost = acc.costUsd('constructor');
  assert.ok(Number.isFinite(constCost) && constCost > 0, `constructor should fall back, got ${constCost}`);
  assert.equal(constCost, fallbackCost);
});
