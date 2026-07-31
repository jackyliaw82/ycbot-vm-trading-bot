import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVolumeProfile } from '../volume-profile.js';

// Candle shape per parseKlines: { open, high, low, close, volume, ... }
const candle = (low, high, volume) => ({ open: low, high, low, close: high, volume });

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
