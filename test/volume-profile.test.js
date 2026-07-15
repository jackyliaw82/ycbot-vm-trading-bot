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
