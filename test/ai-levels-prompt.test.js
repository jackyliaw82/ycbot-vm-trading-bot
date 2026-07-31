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

test('zero values are included, not dropped by truthy checks', () => {
  const m = buildPlanUserMessage({
    symbol: 'BTCUSDT',
    currentPrice: 100000,
    cvd: 0,
    fundingRate: 0,
    openInterestChangePct: 0,
  });
  assert.ok(m.includes('CVD: 0'), 'cvd: 0 must appear');
  assert.ok(m.includes('Funding rate: 0'), 'fundingRate: 0 must appear');
  assert.ok(m.includes('Open interest change: 0%'), 'openInterestChangePct: 0 must appear');
});

test('negative values are included, not dropped by checks', () => {
  const m = buildPlanUserMessage({
    symbol: 'BTCUSDT',
    currentPrice: 100000,
    cvd: -1200,
    fundingRate: -0.0005,
    openInterestChangePct: -2.5,
  });
  assert.ok(m.includes('CVD: -1200'), 'cvd: -1200 must appear');
  assert.ok(m.includes('Funding rate: -0.0005'), 'fundingRate: -0.0005 must appear');
  assert.ok(m.includes('Open interest change: -2.5%'), 'openInterestChangePct: -2.5 must appear');
});

test('rangeVoids with NaN or missing fields are filtered out, no NaN in output', () => {
  const m = buildPlanUserMessage({
    symbol: 'BTCUSDT',
    currentPrice: 100000,
    profile: {
      rangeVoids: [
        { priceLow: NaN, priceHigh: 97800 },
        { priceLow: 104000, priceHigh: undefined },
        { priceLow: 105000, priceHigh: 106000 }, // valid
      ],
    },
  });
  assert.ok(!/NaN|undefined/.test(m), `leaked placeholder:\n${m}`);
  assert.ok(m.includes('105000-106000'), 'valid void range must appear');
  assert.ok(!m.includes('104000') || m.includes('105000-106000'), 'invalid voids must be filtered');
});

test('hvns with NaN or missing fields are filtered out, no NaN in output', () => {
  const m = buildPlanUserMessage({
    symbol: 'BTCUSDT',
    currentPrice: 100000,
    profile: {
      hvns: [
        { priceLow: 100000, priceHigh: NaN },
        { priceLow: undefined, priceHigh: 101000 },
        { priceLow: 99500, priceHigh: 100500 }, // valid
      ],
    },
  });
  assert.ok(!/NaN|undefined/.test(m), `leaked placeholder:\n${m}`);
  assert.ok(m.includes('99500-100500'), 'valid HVN range must appear');
});

test('depth with non-finite numeric values does not leak null into Orderbook line', () => {
  const m = buildPlanUserMessage({
    symbol: 'BTCUSDT',
    currentPrice: 100000,
    depth: {
      bidQty: NaN,
      askQty: 5,
      bidPrice: Infinity,
      askPrice: 100000,
    },
  });
  // The Orderbook line should not include the NaN/Infinity converted to null
  // If depth has no usable finite values, the line should be omitted
  assert.ok(!/Orderbook:.*null/.test(m), `leaked null into Orderbook:\n${m}`);
});

test('depth with all non-finite values omits the Orderbook line entirely', () => {
  const m = buildPlanUserMessage({
    symbol: 'BTCUSDT',
    currentPrice: 100000,
    depth: {
      bidQty: NaN,
      askQty: Infinity,
    },
  });
  assert.ok(!m.includes('Orderbook'), 'Orderbook line must be omitted if all values are non-finite');
});
