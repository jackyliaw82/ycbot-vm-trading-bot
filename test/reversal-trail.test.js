import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailDistance, trailExitLevel } from '../reversal-trail.js';

const BULL = 104000, BEAR = 100000;

test('trailDistance: LONG measures from TREND arm down to bear', () => {
  assert.equal(trailDistance(105248, 'LONG', BULL, BEAR), 5248);
});

test('trailDistance: SHORT measures from bull down to the TREND arm', () => {
  assert.equal(trailDistance(98750, 'SHORT', BULL, BEAR), 5250);
});

test('trailDistance: rejects bad inputs rather than returning a nonsense width', () => {
  for (const args of [[NaN, 'LONG', BULL, BEAR], [105248, 'SIDEWAYS', BULL, BEAR],
                      [105248, 'LONG', NaN, BEAR], [105248, 'LONG', BULL, Infinity]]) {
    assert.equal(trailDistance(...args), null);
  }
});

test('trailExitLevel: LONG starts exactly at the bear level', () => {
  const d = trailDistance(105248, 'LONG', BULL, BEAR);
  assert.equal(trailExitLevel({ price: 105248, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: null }), BEAR);
});

test('trailExitLevel: LONG ratchets up as price rises', () => {
  const d = trailDistance(105248, 'LONG', BULL, BEAR);
  const a = trailExitLevel({ price: 107000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: BEAR });
  assert.equal(a, 101752);
  const b = trailExitLevel({ price: 108000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: a });
  assert.equal(b, 102752);
});

test('trailExitLevel: LONG never retreats when price falls back', () => {
  const d = trailDistance(105248, 'LONG', BULL, BEAR);
  const high = trailExitLevel({ price: 108000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: BEAR });
  const after = trailExitLevel({ price: 104500, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: high });
  assert.equal(after, high, 'the ratchet only turns one way');
});

test('trailExitLevel: LONG caps at the bull level and goes no further', () => {
  const d = trailDistance(105248, 'LONG', BULL, BEAR);
  const at = trailExitLevel({ price: 109248, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: 103000 });
  assert.equal(at, BULL);
  const beyond = trailExitLevel({ price: 120000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: BULL });
  assert.equal(beyond, BULL, 'capped — never above the entry level');
});

test('trailExitLevel: SHORT mirrors — starts at bull, ratchets down, caps at bear', () => {
  const d = trailDistance(98750, 'SHORT', BULL, BEAR);
  assert.equal(trailExitLevel({ price: 98750, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: null }), BULL);
  const a = trailExitLevel({ price: 97000, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: BULL });
  assert.equal(a, 102250);
  const back = trailExitLevel({ price: 99000, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: a });
  assert.equal(back, a, 'never retreats upward');
  const deep = trailExitLevel({ price: 90000, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: a });
  assert.equal(deep, BEAR, 'capped at bear');
});

test('trailExitLevel: a bad distance or side yields null, never a stray number', () => {
  for (const over of [{ distance: null }, { distance: NaN }, { side: 'X' }, { price: NaN }]) {
    const r = trailExitLevel({ price: 107000, distance: 5248, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: null, ...over });
    assert.equal(r, null);
  }
});

test('trailExitLevel: the level always sits inside the two levels', () => {
  const d = trailDistance(105248, 'LONG', BULL, BEAR);
  for (const price of [100000, 105248, 107000, 109248, 200000]) {
    const v = trailExitLevel({ price, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: null });
    assert.ok(v >= BEAR && v <= BULL, `${v} escaped [${BEAR}, ${BULL}] at price ${price}`);
  }
});
