import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKOUT_PCT, BREAKOUT_PCT_MIN, BREAKOUT_PCT_MAX,
  resolveBreakoutGeometry, deriveBreakoutLevels,
} from '../breakout-levels.js';

test('defaults and bounds are the agreed values', () => {
  assert.equal(BREAKOUT_PCT, 0.01);
  assert.equal(BREAKOUT_PCT_MIN, 0.003);
  assert.equal(BREAKOUT_PCT_MAX, 0.03);
});

test('resolveBreakoutGeometry: absent field falls back to the default', () => {
  assert.deepEqual(resolveBreakoutGeometry({}), { ok: true, breakoutPct: 0.01 });
  assert.deepEqual(resolveBreakoutGeometry(), { ok: true, breakoutPct: 0.01 });
  assert.deepEqual(resolveBreakoutGeometry({ breakoutPct: null }), { ok: true, breakoutPct: 0.01 });
  assert.deepEqual(resolveBreakoutGeometry({ breakoutPct: undefined }), { ok: true, breakoutPct: 0.01 });
});

test('resolveBreakoutGeometry: accepts values on and inside the bounds', () => {
  for (const v of [0.003, 0.005, 0.01, 0.02, 0.03]) {
    assert.deepEqual(resolveBreakoutGeometry({ breakoutPct: v }), { ok: true, breakoutPct: v });
  }
});

test('resolveBreakoutGeometry: rejects out-of-bounds values', () => {
  for (const v of [0.0029, 0.0301, 1, -0.01]) {
    const r = resolveBreakoutGeometry({ breakoutPct: v });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BREAKOUT_PCT_OUT_OF_BOUNDS');
    assert.match(r.error, /0\.30%.*3\.00%/);
  }
});

// The whole point of "strict, not coercing": these are NOT absent, so they must
// be REJECTED, never silently defaulted.
test('resolveBreakoutGeometry: rejects non-numbers instead of coercing them', () => {
  for (const v of ['0.01', '', 0 / 0, [], [0.01], {}, true, false, 0]) {
    const r = resolveBreakoutGeometry({ breakoutPct: v });
    assert.equal(r.ok, false, `${JSON.stringify(v)} must be rejected, not defaulted`);
  }
});

test('deriveBreakoutLevels: bull goes up, bear goes down', () => {
  const result = deriveBreakoutLevels(100, 98, 0.015);
  assert.ok(Math.abs(result.bullBreakout - 101.5) < 1e-9);
  assert.equal(result.bearBreakout, 96.53);
});

test('deriveBreakoutLevels: the levels bracket the band', () => {
  const { bullBreakout, bearBreakout } = deriveBreakoutLevels(104000, 100000, 0.01);
  assert.ok(bullBreakout > 104000);
  assert.ok(bearBreakout < 100000);
  assert.equal(bullBreakout, 105040);
  assert.equal(bearBreakout, 99000);
});

test('deriveBreakoutLevels: throws rather than returning a nonsense level', () => {
  assert.throws(() => deriveBreakoutLevels(NaN, 98, 0.01), /bullLevel/);
  assert.throws(() => deriveBreakoutLevels(100, 0, 0.01), /bearLevel/);
  assert.throws(() => deriveBreakoutLevels(98, 100, 0.01), /strictly above/);
  assert.throws(() => deriveBreakoutLevels(100, 98, 0.5), /breakoutPct/);
  assert.throws(() => deriveBreakoutLevels(100, 98, '0.01'), /breakoutPct/);
});
