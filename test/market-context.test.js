import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLevelContext } from '../market-context.js';

const profile = {
  poc: { price: 100.5 }, vah: 102, val: 99,
  rangeVoids: [{ priceLow: 97, priceHigh: 97.8 }, { priceLow: 104, priceHigh: 105 }],
  hvns: [{ priceLow: 100, priceHigh: 101 }],
};
const okVp = { getVoidProfile: async () => ({ window: '24h', profile, pair: { bullLevel: 104, bearLevel: 97.8 } }) };
const okMm = {
  getVolatility: async () => ({ atr: 0.9, atrPercent: 0.9 }),
  getCvd: async () => ({ cvd: -1200, cvdTrend: 'FALLING' }),
  getOrderbookDepth: async () => ({ bidVolume: 10, askVolume: 12, imbalance: -0.09 }),
  getFundingRate: async () => ({ rate: 0.0001, nextFundingTime: 'in 3h 0m' }),
  getOpenInterestChange: async () => ({ oiChange5m: 0.4, oiChange1h: 3.2, oiTrend: 'RISING' }),
};
const okPrecision = { getPrecisionData: () => ({ tickSize: 0.1 }) };
const args = (over = {}) => ({ symbol: 'BTCUSDT', currentPrice: 101, volumeProfile: okVp, marketMetrics: okMm, precision: okPrecision, ...over });

test('buildLevelContext: assembles every field in the Phase 2a shape', async () => {
  const c = await buildLevelContext(args());
  assert.equal(c.symbol, 'BTCUSDT');
  assert.equal(c.currentPrice, 101);
  assert.equal(c.atr, 0.9);
  assert.equal(c.tickSize, 0.1);
  assert.equal(c.cvd, -1200, 'must unwrap the number, not pass the CVD object');
  assert.equal(c.fundingRate, 0.0001, 'must unwrap the rate');
  assert.equal(c.openInterestChangePct, 3.2, 'uses the 1h change');
  assert.deepEqual(c.profile.rangeVoids, profile.rangeVoids);
  assert.equal(c.profile.poc, 100.5, 'poc must be the NUMBER, not the {price} object');
  assert.deepEqual(c.voidPair, { bullLevel: 104, bearLevel: 97.8 });
  assert.ok(c.depth);
});

test('buildLevelContext: one failing source does not fail the whole context', async () => {
  const mm = { ...okMm, getFundingRate: async () => { throw new Error('down'); } };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  assert.equal(c.symbol, 'BTCUSDT');
  assert.equal(c.atr, 0.9, 'other sources must survive');
  assert.equal(c.fundingRate, undefined, 'the failed field is omitted, not null');
});

test('buildLevelContext: every source failing still yields a usable minimal context', async () => {
  const dead = new Proxy({}, { get: () => async () => { throw new Error('x'); } });
  const c = await buildLevelContext(args({ volumeProfile: dead, marketMetrics: dead }));
  assert.equal(c.symbol, 'BTCUSDT');
  assert.equal(c.currentPrice, 101);
  assert.equal(c.profile, undefined);
});

test('buildLevelContext: sets a note when the void chain is exhausted', async () => {
  const vp = { getVoidProfile: async () => ({ window: '7d', profile, pair: null }) };
  const c = await buildLevelContext(args({ volumeProfile: vp }));
  assert.equal(c.voidPair, undefined);
  assert.match(c.note, /no .*void/i);
  assert.match(c.note, /7d/, 'the note should say how far we widened');
});

test('buildLevelContext: omits tickSize when precision is not cached', async () => {
  const c = await buildLevelContext(args({ precision: { getPrecisionData: () => null } }));
  assert.equal(c.tickSize, undefined);
});

test('buildLevelContext: never emits a non-finite number', async () => {
  const mm = {
    ...okMm,
    getVolatility: async () => ({ atr: NaN }),
    getCvd: async () => ({ cvd: Infinity }),
    getOpenInterestChange: async () => ({ oiChange1h: NaN }),
  };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  for (const k of ['atr', 'cvd', 'openInterestChangePct']) {
    assert.equal(c[k], undefined, `${k} must be omitted when non-finite`);
  }
});

test('buildLevelContext: an ATR flagged interpretation:"unknown" is omitted, not sent as 0', async () => {
  // Critical-1 fix: computeATR's not-enough-data answer is
  // { atr: 0, interpretation: 'unknown' }. The 0 is a sentinel, not a real
  // reading — sending it through as ctx.atr = 0 would print "ATR: 0" into the
  // prompt and delete the 1.5x ATR separation gate downstream (level-planner
  // treats a present, finite, positive atr as the only usable case).
  const mm = { ...okMm, getVolatility: async () => ({ atr: 0, atrPercent: 0, interpretation: 'unknown' }) };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  assert.equal(c.atr, undefined, 'an unknown-interpretation ATR must not reach the context, not even as 0');
});

test('buildLevelContext: atr: 0 without an "unknown" flag is still omitted, not treated as real zero volatility', async () => {
  // Belt-and-suspenders: even absent the interpretation flag, a non-positive
  // ATR is unusable for the separation check and must not survive into the
  // context as a number the model or level-planner could act on.
  const mm = { ...okMm, getVolatility: async () => ({ atr: 0, atrPercent: 0 }) };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  assert.equal(c.atr, undefined);
});

test('buildLevelContext: preserves legitimate zero and negative values', async () => {
  const mm = {
    ...okMm,
    getCvd: async () => ({ cvd: 0 }),
    getFundingRate: async () => ({ rate: -0.0005 }),
    getOpenInterestChange: async () => ({ oiChange1h: 0 }),
  };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  assert.equal(c.cvd, 0, 'zero CVD is real data');
  assert.equal(c.fundingRate, -0.0005, 'negative funding is routine');
  assert.equal(c.openInterestChangePct, 0);
});

test('buildLevelContext: rejects a bad currentPrice rather than building on it', async () => {
  await assert.rejects(() => buildLevelContext(args({ currentPrice: 0 })));
  await assert.rejects(() => buildLevelContext(args({ currentPrice: NaN })));
});

test('buildLevelContext: never throws when a source returns a malformed shape', async () => {
  const mm = new Proxy({}, { get: () => async () => 'not-an-object' });
  const vp = { getVoidProfile: async () => 'nope' };
  const c = await buildLevelContext(args({ marketMetrics: mm, volumeProfile: vp }));
  assert.equal(c.symbol, 'BTCUSDT');
});

test('buildLevelContext: a half-non-finite void pair is omitted entirely, not half-written', async () => {
  const vp = { getVoidProfile: async () => ({ window: '24h', profile, pair: { bullLevel: NaN, bearLevel: 97.8 } }) };
  const c = await buildLevelContext(args({ volumeProfile: vp }));
  assert.equal(c.voidPair, undefined, 'a pair with one non-finite side must not survive at all');
});

test('buildLevelContext: a source resolving to an array is treated as malformed, not a plain object', async () => {
  const mm = { ...okMm, getOrderbookDepth: async () => [1, 2, 3] };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  assert.equal(c.depth, undefined, 'an array must never survive as ctx.depth');
});

test('buildLevelContext: a source method that throws SYNCHRONOUSLY (not async) only omits its own field', async () => {
  // A source whose method is a plain (non-async) function that throws never
  // produces a rejected promise for Promise.allSettled to catch — the whole
  // Promise.all/allSettled array construction would throw synchronously
  // instead, failing every field, not just this one. call() in
  // market-context.js wraps the invocation in its own try/catch specifically
  // to convert that synchronous throw into a resolved-undefined entry. This
  // guard was mutated away in a prior review pass with no test catching it —
  // this pins it down.
  const mm = {
    ...okMm,
    getVolatility: () => { throw new Error('sync boom'); },  // NOT async
  };
  const c = await buildLevelContext(args({ marketMetrics: mm }));
  assert.equal(c.symbol, 'BTCUSDT', 'the whole context must still build');
  assert.equal(c.atr, undefined, 'only the synchronously-throwing field is omitted');
  assert.equal(c.cvd, -1200, 'other fields must be unaffected');
});
