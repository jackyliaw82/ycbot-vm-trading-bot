import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLadderActions, averageOpenEntry } from '../ladder-crossings.js';
import { buildLadder } from '../ladder-levels.js';

const fresh = () => buildLadder(100, 0.003, 5); // L: 100.3..101.5, S: 99.7..98.5

test('rising price fills the LONG leg it crosses', () => {
  const legs = fresh();
  const r = planLadderActions({ prevPrice: 100, currentPrice: 100.35, anchor: 100, legs });
  assert.equal(r.flatten, false);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].direction, 'LONG');
  assert.equal(r.fills[0].levelIndex, 1);
});

test('falling price fills the SHORT leg it crosses', () => {
  const legs = fresh();
  const r = planLadderActions({ prevPrice: 100, currentPrice: 99.65, anchor: 100, legs });
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].direction, 'SHORT');
  assert.equal(r.fills[0].levelIndex, 1);
});

test('a gap fills EVERY level it jumped, not just the outermost', () => {
  const legs = fresh();
  const r = planLadderActions({ prevPrice: 100, currentPrice: 100.95, anchor: 100, legs });
  assert.equal(r.fills.length, 3, 'L1, L2 and L3 are all inside the band');
  assert.deepEqual(r.fills.map(l => l.levelIndex).sort(), [1, 2, 3]);
  assert.ok(r.fills.every(l => l.direction === 'LONG'));
});

test('an already-filled leg is not re-filled', () => {
  const legs = fresh();
  legs.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  const r = planLadderActions({ prevPrice: 100, currentPrice: 100.65, anchor: 100, legs });
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].levelIndex, 2);
});

test('retreating within the ladder does nothing — legs only reset at the anchor', () => {
  const legs = fresh();
  legs.filter(l => l.direction === 'LONG' && l.levelIndex <= 3).forEach(l => { l.state = 'POSITION_OPEN'; });
  const r = planLadderActions({ prevPrice: 100.95, currentPrice: 100.35, anchor: 100, legs });
  assert.equal(r.flatten, false);
  assert.equal(r.fills.length, 0, 'no TP peel exists in this design');
});

test('crossing the anchor flattens', () => {
  const legs = fresh();
  legs.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  const r = planLadderActions({ prevPrice: 100.35, currentPrice: 99.9, anchor: 100, legs });
  assert.equal(r.flatten, true);
});

test('crossing the anchor flattens and fills NOTHING — the two-tick rule', () => {
  const legs = fresh();
  legs.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  // +0.5% -> -0.4%: crosses the anchor AND S1 in one tick.
  const r = planLadderActions({ prevPrice: 100.5, currentPrice: 99.6, anchor: 100, legs });
  assert.equal(r.flatten, true);
  assert.equal(r.fills.length, 0, 'S1 must wait for the NEXT tick');
});

test('landing exactly on the anchor counts as crossing it', () => {
  const legs = fresh();
  legs.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  assert.equal(planLadderActions({ prevPrice: 100.35, currentPrice: 100, anchor: 100, legs }).flatten, true);
});

test('an unchanged price does nothing', () => {
  const r = planLadderActions({ prevPrice: 100.35, currentPrice: 100.35, anchor: 100, legs: fresh() });
  assert.equal(r.flatten, false);
  assert.equal(r.fills.length, 0);
});

test('a null prevPrice does nothing (first tick has no band)', () => {
  const r = planLadderActions({ prevPrice: null, currentPrice: 100.35, anchor: 100, legs: fresh() });
  assert.equal(r.flatten, false);
  assert.equal(r.fills.length, 0);
});

test('averageOpenEntry uses the ACTUAL fill price, not the level price', () => {
  const legs = fresh();
  const l1 = legs.find(l => l.direction === 'LONG' && l.levelIndex === 1);
  const l2 = legs.find(l => l.direction === 'LONG' && l.levelIndex === 2);
  Object.assign(l1, { state: 'POSITION_OPEN', quantity: 10, fillPrice: 100.31 }); // slipped
  Object.assign(l2, { state: 'POSITION_OPEN', quantity: 10, fillPrice: 100.62 });
  const avg = averageOpenEntry(legs, 'LONG');
  assert.ok(Math.abs(avg - 100.465) < 1e-9, `expected the fill-weighted average, got ${avg}`);
  assert.equal(averageOpenEntry(legs, 'SHORT'), null, 'no open SHORT legs');
});

test('averageOpenEntry falls back to the level price when fillPrice is missing', () => {
  const legs = fresh();
  const l1 = legs.find(l => l.direction === 'LONG' && l.levelIndex === 1);
  Object.assign(l1, { state: 'POSITION_OPEN', quantity: 10, fillPrice: null });
  assert.ok(Math.abs(averageOpenEntry(legs, 'LONG') - 100.3) < 1e-9);
});
