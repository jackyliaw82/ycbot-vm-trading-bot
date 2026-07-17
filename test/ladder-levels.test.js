import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLadder,
  LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE,
  LADDER_STEP_PCT_MIN, LADDER_STEP_PCT_MAX,
  LADDER_LEVELS_MIN, LADDER_LEVELS_MAX,
  MIN_LEG_USDT, minInitialSizeUSDT,
} from '../ladder-levels.js';

test('defaults are the spec values', () => {
  assert.equal(LADDER_STEP_PCT, 0.003);
  assert.equal(LADDER_LEVELS_PER_SIDE, 5);
});

test('geometry bounds are the spec values', () => {
  assert.equal(LADDER_STEP_PCT_MIN, 0.003);
  assert.equal(LADDER_STEP_PCT_MAX, 0.02);
  assert.equal(LADDER_LEVELS_MIN, 3);
  assert.equal(LADDER_LEVELS_MAX, 10);
});

test('minInitialSizeUSDT scales with the level count', () => {
  assert.equal(MIN_LEG_USDT, 10);
  assert.equal(minInitialSizeUSDT(5), 50);  // identical to the old flat minimum
  assert.equal(minInitialSizeUSDT(3), 30);
  assert.equal(minInitialSizeUSDT(10), 100);
});

test('buildLadder: LONG above the anchor, SHORT below — the inversion', () => {
  const legs = buildLadder(100, 0.003, 5);
  assert.equal(legs.length, 10);
  for (const leg of legs) {
    if (leg.direction === 'LONG') assert.ok(leg.price > 100, `LONG leg at ${leg.price} must be ABOVE the anchor`);
    if (leg.direction === 'SHORT') assert.ok(leg.price < 100, `SHORT leg at ${leg.price} must be BELOW the anchor`);
  }
});

test('buildLadder: level prices are anchor +/- k * stepPct * anchor', () => {
  const legs = buildLadder(100, 0.003, 5);
  const L = (k) => legs.find(l => l.direction === 'LONG' && l.levelIndex === k);
  const S = (k) => legs.find(l => l.direction === 'SHORT' && l.levelIndex === k);
  assert.ok(Math.abs(L(1).price - 100.3) < 1e-9);
  assert.ok(Math.abs(L(5).price - 101.5) < 1e-9); // outermost = anchor + 1.5%
  assert.ok(Math.abs(S(1).price - 99.7) < 1e-9);
  assert.ok(Math.abs(S(5).price - 98.5) < 1e-9);  // outermost = anchor - 1.5%
});

test('buildLadder: every leg starts EMPTY with no fill data', () => {
  for (const leg of buildLadder(4321.5, 0.003, 5)) {
    assert.equal(leg.state, 'EMPTY');
    assert.equal(leg.quantity, null);
    assert.equal(leg.fillPrice, null);
  }
});

test('buildLadder: no leg sits on the anchor', () => {
  // k starts at 1, so the anchor is never a level. The anchor is the FLATTEN
  // price — a leg there would open and close on the same tick.
  assert.ok(buildLadder(100, 0.003, 5).every(l => l.price !== 100));
});

test('buildLadder: the ladder is symmetric about the anchor', () => {
  const legs = buildLadder(68000, 0.003, 5);
  for (let k = 1; k <= 5; k++) {
    const up = legs.find(l => l.direction === 'LONG' && l.levelIndex === k).price;
    const dn = legs.find(l => l.direction === 'SHORT' && l.levelIndex === k).price;
    assert.ok(Math.abs((up - 68000) - (68000 - dn)) < 1e-6, `level ${k} is asymmetric`);
  }
});

test('buildLadder: rejects a non-positive anchor', () => {
  assert.throws(() => buildLadder(0, 0.003, 5), /anchor/i);
  assert.throws(() => buildLadder(NaN, 0.003, 5), /anchor/i);
});

test('buildLadder: honours non-default geometry', () => {
  const legs = buildLadder(200, 0.005, 8);
  assert.equal(legs.length, 16, '8 per side');
  const longs = legs.filter(l => l.direction === 'LONG').map(l => l.price).sort((a, b) => a - b);
  const shorts = legs.filter(l => l.direction === 'SHORT').map(l => l.price).sort((a, b) => b - a);
  assert.equal(longs.length, 8);
  assert.equal(shorts.length, 8);
  assert.equal(longs[0], 201);    // 200 + 1 * 0.005 * 200
  assert.equal(longs[7], 208);    // 200 + 8 * 0.005 * 200
  assert.equal(shorts[0], 199);
  assert.equal(shorts[7], 192);
  // The inversion holds at any geometry: LONG above, SHORT below.
  assert.ok(longs.every(p => p > 200));
  assert.ok(shorts.every(p => p < 200));
});
