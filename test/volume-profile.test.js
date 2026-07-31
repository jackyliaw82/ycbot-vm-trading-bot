import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVolumeProfile, selectVoidPair, VolumeProfile, WINDOWS } from '../volume-profile.js';

// Candle shape per parseKlines: { open, high, low, close, volume, ... }
const candle = (low, high, volume) => ({ open: low, high, low, close: high, volume });

const profileWithVoids = (voids) => ({ rangeVoids: voids });

// Minimal strategy double — VolumeProfile only duck-types makeProxyRequest.
const fakeStrategy = (onCall) => ({ makeProxyRequest: onCall });
const kline = (v) => [0, '100', '101', '99', '100.5', String(v), 0, '0', 0, '0', '0', '0'];

// Raw kline index order per parseKlines: [openTime, open, high, low, close, volume, ...].
// computeVolumeProfile only reads low/high, but keep open/close well-formed so
// the fixture is not misleading to anyone who reads it later.
const rawKline = (low, high, volume) =>
  [0, String(low), String(high), String(low), String(high), String(volume), 0, '0', 0, '0', '0', '0'];

// Heavy middle tapering to thin tails, centred wherever the caller asks — lets a
// test place live price inside the range (straddled) or far outside it (breakout).
//
// CRITICAL: coverage must be CONTINUOUS with no zero-volume gaps. `rangeVoids` is
// a bottom-20%-BY-VOLUME rule, so literal empty bins between clusters outrank
// merely-thin tail bins and the voids land in the INTERIOR instead of at the
// edges. A gapped fixture therefore tests the opposite of what it looks like it
// tests. Volume here decreases monotonically with distance from centre and never
// reaches zero, so the thinnest bins genuinely are the two tails.
const tailedKlines = (centre) => Array.from({ length: 61 }, (_, i) => {
  const lo = centre - 3 + i * 0.1;
  const dist = Math.abs(lo + 0.05 - centre);
  return rawKline(lo, lo + 0.1, Math.max(1, Math.round(100 - dist * 30)));
});

test('computeVolumeProfile: POC lands on the heaviest price bin', () => {
  const candles = [
    ...Array.from({ length: 10 }, () => candle(100, 100.5, 1)),
    ...Array.from({ length: 10 }, () => candle(102, 102.5, 50)), // the heavy one
    ...Array.from({ length: 10 }, () => candle(104, 104.5, 1)),
  ];
  const vp = computeVolumeProfile(candles, 50);
  assert.ok(vp.poc.price >= 102 && vp.poc.price <= 102.5, `POC was ${vp.poc.price}`);
});

test('computeVolumeProfile: value area brackets the POC and sits inside the range', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(100 + i * 0.1, 100 + i * 0.1 + 0.05, 10 + i));
  const vp = computeVolumeProfile(candles, 50);
  assert.ok(vp.val <= vp.poc.price && vp.poc.price <= vp.vah);
  assert.ok(vp.priceMin <= vp.val && vp.vah <= vp.priceMax);
});

test('computeVolumeProfile: emits the compact chart arrays', () => {
  const candles = Array.from({ length: 30 }, () => candle(100, 101, 5));
  const vp = computeVolumeProfile(candles, 40);
  assert.equal(vp.binVolumes.length, 40);
  assert.ok(vp.binWidth > 0);
  assert.ok(Number.isFinite(vp.priceMin));
  assert.ok(vp.totalVolume > 0);
});

test('computeVolumeProfile: empty input returns null rather than throwing', () => {
  assert.equal(computeVolumeProfile([], 50), null);
});

test('computeVolumeProfile: rangeVoids land on the range EDGES', () => {
  // Thin tails, heavy middle — the shape the bottom-20% rule is meant to read.
  // Use a continuous price range (no gaps) so bottom 20% by volume are the tails.
  const candles = Array.from({ length: 100 }, (_, i) => {
    const price = 100 + i * 0.05;
    // Thin at extremes (i < 10 or i >= 90), heavy in middle (20 <= i < 80)
    const volume = (i < 10 || i >= 90) ? 1 : (i < 20 || i >= 80) ? 10 : 100;
    return candle(price, price + 0.05, volume);
  });
  const vp = computeVolumeProfile(candles, 50);
  assert.ok(vp.rangeVoids.length >= 1, `expected at least one void, got ${vp.rangeVoids.length}`);
  // With continuous volume distribution and volume-order selection,
  // rangeVoids should land on the thin regions (extremes in this shape).
  const first = vp.rangeVoids[0];
  assert.ok(first.priceLow >= vp.priceMin && first.priceLow <= vp.priceMin + vp.binWidth * 5,
    `first void should be near range min, got ${first.priceLow}`);
});

test('computeVolumeProfile: rangeVoids is ascending and non-overlapping', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(100 + i * 0.1, 100 + i * 0.1 + 0.05, 10 + i));
  const vp = computeVolumeProfile(candles, 50);
  for (let i = 1; i < vp.rangeVoids.length; i++) {
    assert.ok(vp.rangeVoids[i].priceLow >= vp.rangeVoids[i - 1].priceHigh,
      'ranges must not overlap or go backwards');
  }
});

test('computeVolumeProfile: rangeVoids does NOT disturb the chart-facing fields', () => {
  const candles = [
    ...Array.from({ length: 5 },  () => candle(100, 100.5, 1)),
    ...Array.from({ length: 50 }, () => candle(102, 103, 100)),
    ...Array.from({ length: 5 },  () => candle(104.5, 105, 1)),
  ];
  const vp = computeVolumeProfile(candles, 50);
  assert.equal(vp.binVolumes.length, 50);
  assert.ok(Array.isArray(vp.lvns), 'Pine-style lvns must still exist');
  assert.ok(Array.isArray(vp.hvns));
  assert.ok(Number.isFinite(vp.vah) && Number.isFinite(vp.val));
  assert.ok(Number.isFinite(vp.poc.price));
  // The whole point: the two rules disagree. rangeVoids hugs the edges,
  // lvns (local-minimum + significance gate) does not.
  assert.notDeepEqual(vp.rangeVoids, vp.lvns);
});

test('computeVolumeProfile: rangeVoids uses volume-order, not price-position', () => {
  // INVERTED shape: heavy volume at the EXTREMES, thin/zero in the MIDDLE.
  // This distinguishes volume-order (correct: voids in middle) from
  // position-based (wrong: voids at edges).
  const candles = [
    ...Array.from({ length: 50 }, () => candle(100, 100.5, 100)),    // low extreme: heavy
    ...Array.from({ length: 5 },  () => candle(102, 103, 1)),        // middle: thin
    ...Array.from({ length: 50 }, () => candle(104.5, 105, 100)),    // high extreme: heavy
  ];
  const vp = computeVolumeProfile(candles, 50);
  assert.ok(vp.rangeVoids.length >= 1, 'expected at least one void');
  // The bottom 20% by VOLUME should be in the thin middle, NOT at the heavy extremes.
  // Check that no void is at the extremes.
  for (const void_ of vp.rangeVoids) {
    const atLow = Math.abs(void_.priceLow - vp.priceMin) < vp.binWidth * 2;
    const atHigh = Math.abs(void_.priceHigh - vp.priceMax) < vp.binWidth * 2;
    // Volume-order algorithm: voids should NOT be at the extremes
    assert.ok(
      !(atLow || atHigh),
      `void at price [${void_.priceLow.toFixed(2)}, ${void_.priceHigh.toFixed(2)}] is at an extreme (priceMin=${vp.priceMin}, priceMax=${vp.priceMax}), but should be in the middle`
    );
  }
});

test('selectVoidPair: picks the outermost void on each side of price', () => {
  const p = profileWithVoids([
    { priceLow: 98.0,  priceHigh: 98.5,  volume: 1 },   // outer lower
    { priceLow: 99.0,  priceHigh: 99.4,  volume: 1 },   // inner lower
    { priceLow: 103.0, priceHigh: 103.4, volume: 1 },   // inner upper
    { priceLow: 104.0, priceHigh: 104.6, volume: 1 },   // outer upper
  ]);
  const r = selectVoidPair(p, 101);
  assert.equal(r.lower.priceLow, 98.0, 'lower must be the OUTERMOST below price');
  assert.equal(r.upper.priceHigh, 104.6, 'upper must be the OUTERMOST above price');
  assert.equal(r.bearLevel, 98.5, 'bear is the void INNER edge');
  assert.equal(r.bullLevel, 104.0, 'bull is the void INNER edge');
});

test('selectVoidPair: returns null when every void is on one side', () => {
  const p = profileWithVoids([
    { priceLow: 98.0, priceHigh: 98.5, volume: 1 },
    { priceLow: 99.0, priceHigh: 99.4, volume: 1 },
  ]);
  assert.equal(selectVoidPair(p, 101), null);
});

test('selectVoidPair: a void containing price counts for neither side', () => {
  const p = profileWithVoids([
    { priceLow: 98.0,  priceHigh: 98.5,  volume: 1 },
    { priceLow: 100.5, priceHigh: 101.5, volume: 1 },   // straddles price
  ]);
  assert.equal(selectVoidPair(p, 101), null);
});

test('selectVoidPair: tolerates a missing or empty profile', () => {
  assert.equal(selectVoidPair(null, 101), null);
  assert.equal(selectVoidPair({ rangeVoids: [] }, 101), null);
  assert.equal(selectVoidPair({}, 101), null);
});

test('WINDOWS: every window fits inside Binance\'s 1500-kline cap', () => {
  for (const w of WINDOWS) {
    assert.ok(w.bars <= 1500, `${w.key} asks for ${w.bars} bars`);
    assert.ok(w.bins > 0);
  }
  assert.deepEqual(WINDOWS.map(w => w.key), ['24h', '48h', '7d']);
});

test('_getCandles: caches per interval, so windows do not evict each other', async () => {
  const calls = [];
  const vp = new VolumeProfile(fakeStrategy(async (_p, _m, params) => {
    calls.push(params.interval);
    return [kline(5)];
  }));
  await vp._getCandles('BTCUSDT', '1m', 1440);
  await vp._getCandles('BTCUSDT', '5m', 576);
  await vp._getCandles('BTCUSDT', '1m', 1440);   // cached — must NOT refetch
  assert.deepEqual(calls, ['1m', '5m']);
});

test('_getCandles: invalidate purges the cache, so a later failed fetch has nothing to return', async () => {
  let fail = false;
  const vp = new VolumeProfile(fakeStrategy(async () => {
    if (fail) throw new Error('network');
    return [kline(7)];
  }));
  const first = await vp._getCandles('BTCUSDT', '1m', 1440);
  assert.equal(first.length, 1);
  fail = true;
  vp.invalidate('BTCUSDT');
  const second = await vp._getCandles('BTCUSDT', '1m', 1440);
  assert.deepEqual(second, [], 'invalidated cache + failure yields empty, never a throw');
});

test('_getCandles: a failed fetch returns the stale cache, not an empty profile', async () => {
  let fail = false;
  const vp = new VolumeProfile(fakeStrategy(async () => {
    if (fail) throw new Error('network');
    return [kline(7)];
  }));
  const first = await vp._getCandles('BTCUSDT', '1m', 1440);
  assert.equal(first.length, 1);
  // Force the cache entry to read as EXPIRED so the next call actually
  // attempts (and fails) the fetch, instead of short-circuiting on the
  // fresh-cache branch — otherwise this would pass for the wrong reason
  // without ever touching the catch block's fallback.
  vp._candleCache.get('BTCUSDT:1m:1440').ts = 0;
  fail = true;
  // No invalidate() here — the (now-expired) cache entry from the successful
  // fetch above must still be present in the Map for the catch block's
  // fallback to find.
  const second = await vp._getCandles('BTCUSDT', '1m', 1440);
  assert.deepEqual(second, first, 'a failed fetch must fall back to the stale cache, not go empty');
});

test('getVoidProfile: stops at 24h when it already straddles price', async () => {
  const seen = [];
  const vp = new VolumeProfile(fakeStrategy(async (_p, _m, params) => {
    seen.push(params.interval);
    return tailedKlines(100);
  }));
  const r = await vp.getVoidProfile('BTCUSDT', 100);
  assert.equal(r.window, '24h');
  assert.ok(r.pair, 'expected a straddling pair');
  assert.ok(r.pair.bullLevel > 100 && r.pair.bearLevel < 100);
  assert.deepEqual(seen, ['1m'], 'must not widen when 24h already works');
});

test('getVoidProfile: widens 24h -> 48h -> 7d in order', async () => {
  const seen = [];
  const vp = new VolumeProfile(fakeStrategy(async (_p, _m, params) => {
    seen.push(params.interval);
    // Every window is centred at 100, but price is far above every void,
    // so no window can ever straddle it.
    return tailedKlines(100);
  }));
  const r = await vp.getVoidProfile('BTCUSDT', 500);
  assert.deepEqual(seen, ['1m', '5m', '1h'], 'must try all three, in order');
  assert.equal(r.window, '7d', 'reports the last window tried');
  assert.equal(r.pair, null, 'no straddling pair anywhere — the breakout case');
  assert.ok(r.profile, 'still returns the widest profile for the AI to reason over');
});

test('getVoidProfile: returns null when no candles are available at all', async () => {
  const vp = new VolumeProfile(fakeStrategy(async () => { throw new Error('down'); }));
  assert.equal(await vp.getVoidProfile('BTCUSDT', 100), null);
});
