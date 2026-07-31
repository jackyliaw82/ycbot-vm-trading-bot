import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS_SYSTEM_PROMPT, buildPlanUserMessage, buildAskUserMessage } from '../ai-levels-prompt.js';

const ctx = () => ({
  symbol: 'BTCUSDT',
  currentPrice: 101000,
  atr: 900,
  tickSize: 0.1,
  profile: {
    poc: 100500,
    vah: 102000,
    val: 99000,
    rangeVoids: [{ priceLow: 97000, priceHigh: 97800 }, { priceLow: 104000, priceHigh: 105000 }],
    hvns: [{ priceLow: 100000, priceHigh: 101000 }],
  },
  voidPair: { bullLevel: 104000, bearLevel: 97800 },
  cvd: -1200,
  fundingRate: 0.0001,
  openInterestChangePct: 3.2,
});

test('system prompt states the hard level constraints', () => {
  for (const rule of ['bullLevel > current_price', 'bearLevel < current_price', '1.5']) {
    assert.ok(LEVELS_SYSTEM_PROMPT.includes(rule), `missing constraint: ${rule}`);
  }
});

test('system prompt demands JSON only and names both required keys', () => {
  assert.ok(/JSON only/i.test(LEVELS_SYSTEM_PROMPT));
  assert.ok(LEVELS_SYSTEM_PROMPT.includes('"bullLevel"'));
  assert.ok(LEVELS_SYSTEM_PROMPT.includes('"bearLevel"'));
});

test('system prompt states levels are frozen for the cycle', () => {
  assert.ok(/frozen|permanent/i.test(LEVELS_SYSTEM_PROMPT));
});

test('buildPlanUserMessage: declares the PLAN context and carries the numbers', () => {
  const m = buildPlanUserMessage(ctx());
  assert.ok(m.includes('CONTEXT: PLAN'));
  assert.ok(m.includes('BTCUSDT'));
  assert.ok(m.includes('101000'));
  assert.ok(m.includes('97800'), 'the void pair should be surfaced');
});

test('buildPlanUserMessage: omits absent sections instead of printing undefined', () => {
  const m = buildPlanUserMessage({ symbol: 'ETHUSDT', currentPrice: 3000 });
  assert.ok(!/undefined|NaN|null/.test(m), `leaked a placeholder:\n${m}`);
  assert.ok(m.includes('ETHUSDT'));
});

test('buildPlanUserMessage: passes a no-void note through so the model knows why', () => {
  const m = buildPlanUserMessage({ ...ctx(), voidPair: null, note: 'no void above price after widening to 7d' });
  assert.ok(m.includes('no void above price'));
});

test('buildAskUserMessage: declares ASK and includes the question verbatim', () => {
  const m = buildAskUserMessage(ctx(), 'Should I move bull tighter?');
  assert.ok(m.includes('CONTEXT: ASK'));
  assert.ok(m.includes('Should I move bull tighter?'));
});

test('builders never throw on a null context', () => {
  assert.doesNotThrow(() => buildPlanUserMessage(null));
  assert.doesNotThrow(() => buildAskUserMessage(null, 'x'));
});
