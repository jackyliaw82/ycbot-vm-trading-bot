import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundToTick, validateLevels, ATR_SEPARATION_MULT } from '../level-planner.js';

const opts = (over = {}) => ({ currentPrice: 100, atr: 2, tickSize: 0.1, ...over });

test('roundToTick: snaps to the nearest tick', () => {
  assert.equal(roundToTick(100.04, 0.1), 100.0);
  assert.equal(roundToTick(100.06, 0.1), 100.1);
  assert.equal(roundToTick(104.237, 0.01), 104.24);
});

test('roundToTick: a zero/absent tick size is a passthrough, not a divide-by-zero', () => {
  assert.equal(roundToTick(100.04, 0), 100.04);
  assert.equal(roundToTick(100.04, null), 100.04);
});

test('roundToTick: no floating-point crumbs', () => {
  assert.equal(roundToTick(0.1 + 0.2, 0.01), 0.3);
});

test('roundToTick: survives an exponential-notation tick size', () => {
  // String(0.00000001) is "1e-8" — any decimals-from-string approach rounds
  // every price on this pair to a whole number.
  assert.equal(roundToTick(0.000123456, 0.00000001), 0.00012346);
  assert.equal(roundToTick(1.23456789, 0.00000001), 1.23456789);
});

test('validateLevels: accepts a well-formed pair and returns it tick-rounded', () => {
  const r = validateLevels({ bullLevel: 104.037, bearLevel: 96.042 }, opts());
  assert.equal(r.ok, true);
  assert.equal(r.bullLevel, 104.0);
  assert.equal(r.bearLevel, 96.0);
});

test('validateLevels: rejects bull at or below current price', () => {
  assert.equal(validateLevels({ bullLevel: 100, bearLevel: 96 }, opts()).ok, false);
  assert.equal(validateLevels({ bullLevel: 99, bearLevel: 96 }, opts()).ok, false);
});

test('validateLevels: rejects bear at or above current price', () => {
  assert.equal(validateLevels({ bullLevel: 104, bearLevel: 100 }, opts()).ok, false);
  assert.equal(validateLevels({ bullLevel: 104, bearLevel: 101 }, opts()).ok, false);
});

test('validateLevels: enforces the 1.5x ATR separation floor', () => {
  // atr 2 -> minimum separation 3.
  assert.equal(validateLevels({ bullLevel: 101, bearLevel: 99 }, opts()).ok, false, 'sep 2 < 3');
  assert.equal(validateLevels({ bullLevel: 102, bearLevel: 98 }, opts()).ok, true, 'sep 4 >= 3');
  assert.equal(ATR_SEPARATION_MULT, 1.5);
});

test('validateLevels: a missing or non-finite ATR skips the separation check, not the invariant', () => {
  const r = validateLevels({ bullLevel: 101, bearLevel: 99 }, opts({ atr: null }));
  assert.equal(r.ok, true, 'unknown ATR must not block an otherwise valid pair');
  assert.equal(validateLevels({ bullLevel: 99, bearLevel: 101 }, opts({ atr: null })).ok, false);
});

test('validateLevels: rejects non-numeric, NaN and non-positive levels', () => {
  for (const bad of [{ bullLevel: 'x', bearLevel: 96 }, { bullLevel: NaN, bearLevel: 96 },
                     { bullLevel: 104, bearLevel: 0 }, { bullLevel: 104, bearLevel: -5 }, null]) {
    assert.equal(validateLevels(bad, opts()).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('validateLevels: rounding must not violate the invariant it just checked', () => {
  // bull 100.04 rounds DOWN to 100.0 == currentPrice, which is no longer valid.
  const r = validateLevels({ bullLevel: 100.04, bearLevel: 90 }, opts({ tickSize: 0.1 }));
  assert.equal(r.ok, false, 'a level that rounds onto current price must be rejected');
});

test('validateLevels: every rejection carries a reason', () => {
  const r = validateLevels({ bullLevel: 99, bearLevel: 96 }, opts());
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});
