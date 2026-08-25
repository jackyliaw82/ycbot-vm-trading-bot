import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBalance, BALANCE_DEFAULTS } from '../balance-metrics.js';

// ─── synthetic candle builders ──────────────────────────────────────────────
//
// Deterministic on purpose: no Math.random, so a failure is reproducible and
// a threshold change shows up as the same diff every time.

/**
 * `spec` is a list of segments, OLDEST first, each { bars, halfRange, volume }.
 * Every bar in a segment straddles `centre` by ±halfRange, so the segment's
 * contribution to the profile is a band of exactly that width carrying that
 * volume. Narrowing halfRange over segments = a contracting value area;
 * dropping volume at the same time = the session-lull case.
 */
function candlesFrom(spec, centre = 85) {
  const out = [];
  for (const seg of spec) {
    for (let i = 0; i < seg.bars; i++) {
      // OSCILLATE across the band with a period far shorter than windowBars, so
      // EVERY sub-window sees the full width. A linear walk (the first attempt)
      // meant a 240-bar window covered only a slice of the band, so the measured
      // width depended on where the window happened to land rather than on the
      // band itself — the fixture, not the code, was deciding the result.
      const phase = (i % 40) / 40;                     // 40-bar zig-zag
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;   // 0..1..0
      const mid = centre - seg.halfRange + 2 * seg.halfRange * tri;
      out.push({ high: mid + seg.halfRange * 0.05, low: mid - seg.halfRange * 0.05, volume: seg.volume });
    }
  }
  return out;
}

const W = BALANCE_DEFAULTS.windowBars;      // bars per sub-window
const N = BALANCE_DEFAULTS.sampleCount;
const SPAN = BALANCE_DEFAULTS.windowBars + BALANCE_DEFAULTS.stepBars * (N - 1);

// ─── contract ───────────────────────────────────────────────────────────────

test('too few candles yields null rather than a fabricated reading', () => {
  assert.equal(computeBalance([]), null);
  assert.equal(computeBalance(null), null);
  assert.equal(computeBalance(candlesFrom([{ bars: 10, halfRange: 0.5, volume: 100 }])), null);
});

test('a degenerate flat tape reports NEUTRAL, never throws', () => {
  // Every bar identical -> priceMax === priceMin -> computeVolumeProfile returns null.
  const flat = Array.from({ length: SPAN }, () => ({ high: 85, low: 85, volume: 100 }));
  const r = computeBalance(flat);
  assert.ok(r === null || r.regime === 'NEUTRAL', `expected null or NEUTRAL, got ${r && r.regime}`);
});

test('a narrowing range on HELD volume reads BALANCED_CONTRACTING', () => {
  const c = candlesFrom([
    { bars: SPAN - W, halfRange: 1.2, volume: 100 },   // older: wide
    { bars: W,        halfRange: 0.2, volume: 105 },   // recent: tight, volume intact
  ]);
  const r = computeBalance(c);
  assert.equal(r.regime, 'BALANCED_CONTRACTING');
  assert.ok(r.contraction < 1, `contraction ${r.contraction} should be below 1`);
  assert.ok(r.volumeRatio > BALANCE_DEFAULTS.quietVolumeRatio,
    `volumeRatio ${r.volumeRatio} should clear the quiet threshold`);
});

test('the SAME narrowing on COLLAPSED volume reads QUIET, not balance', () => {
  // This is the CL overnight case. Identical geometry to the test above —
  // only the recent volume differs — so it pins the discriminator itself.
  const c = candlesFrom([
    { bars: SPAN - W, halfRange: 1.2, volume: 100 },
    { bars: W,        halfRange: 0.2, volume: 8 },     // volume gone
  ]);
  const r = computeBalance(c);
  assert.equal(r.regime, 'QUIET');
  assert.ok(r.contraction < 1, 'the range still narrowed');
  assert.ok(r.volumeRatio < BALANCE_DEFAULTS.quietVolumeRatio);
});

test('a widening range reads EXPANDING', () => {
  const c = candlesFrom([
    { bars: SPAN - W, halfRange: 0.2, volume: 100 },
    { bars: W,        halfRange: 1.5, volume: 110 },
  ]);
  const r = computeBalance(c);
  assert.equal(r.regime, 'EXPANDING');
  assert.ok(r.contraction > 1, `contraction ${r.contraction} should exceed 1`);
});

test('a steady range reads NEUTRAL', () => {
  const c = candlesFrom([{ bars: SPAN, halfRange: 0.6, volume: 100 }]);
  const r = computeBalance(c);
  assert.equal(r.regime, 'NEUTRAL');
});

test('the series is newest-first and no longer than sampleCount', () => {
  const c = candlesFrom([{ bars: SPAN, halfRange: 0.6, volume: 100 }]);
  const r = computeBalance(c);
  assert.ok(Array.isArray(r.vaWidthSeries));
  assert.ok(r.vaWidthSeries.length <= BALANCE_DEFAULTS.sampleCount);
  assert.ok(r.vaWidthSeries.length >= 2, 'a usable reading needs at least two points');
  assert.equal(r.vaWidthPct, r.vaWidthSeries[0], 'vaWidthPct is the newest sample');
});

test('every emitted number is finite — no NaN reaches the wire', () => {
  const c = candlesFrom([
    { bars: SPAN - W, halfRange: 1.2, volume: 100 },
    { bars: W,        halfRange: 0.2, volume: 105 },
  ]);
  const r = computeBalance(c);
  for (const k of ['vaWidthPct', 'contraction', 'volumeRatio']) {
    assert.ok(Number.isFinite(r[k]), `${k} = ${r[k]}`);
  }
  for (const v of r.vaWidthSeries) assert.ok(Number.isFinite(v));
});

test('extra candles beyond the span are ignored, not averaged in', () => {
  const tail = candlesFrom([{ bars: SPAN, halfRange: 0.6, volume: 100 }]);
  const withHistory = candlesFrom([{ bars: 400, halfRange: 9, volume: 100 }]).concat(tail);
  const a = computeBalance(tail);
  const b = computeBalance(withHistory);
  assert.equal(b.regime, a.regime, 'older bars outside the span must not change the reading');
});
