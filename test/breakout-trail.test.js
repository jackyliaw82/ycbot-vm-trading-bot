import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailDistance, trailExitLevel } from '../breakout-trail.js';

// bull 104000 / bear 100000, breakoutPct 1% -> entries at 105040 and 99000.
const LEVELS = { bullLevel: 104000, bearLevel: 100000, bullBreakout: 105040, bearBreakout: 99000 };
const { bullLevel: BULL, bearLevel: BEAR } = LEVELS;

test('trailDistance: LONG is the gap from the entry level down to the exit level', () => {
  assert.equal(trailDistance('LONG', LEVELS), 1040);
});

test('trailDistance: SHORT mirrors', () => {
  assert.equal(trailDistance('SHORT', LEVELS), 1000);
});

test('trailDistance: rejects bad inputs rather than returning a nonsense width', () => {
  assert.equal(trailDistance('SIDEWAYS', LEVELS), null);
  assert.equal(trailDistance('LONG', { ...LEVELS, bullBreakout: NaN }), null);
  assert.equal(trailDistance('LONG', { ...LEVELS, bullLevel: null }), null);
  assert.equal(trailDistance('SHORT', { ...LEVELS, bearBreakout: Infinity }), null);
  assert.equal(trailDistance('LONG', undefined), null);
});

// The unification: at entry the trail sits exactly on the exit level, so a
// disarmed trail and the near-level stop are the same number.
test('trailExitLevel: LONG starts exactly at bullLevel when price is at the entry', () => {
  const d = trailDistance('LONG', LEVELS);
  assert.equal(
    trailExitLevel({ price: LEVELS.bullBreakout, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: null }),
    BULL,
  );
});

test('trailExitLevel: SHORT starts exactly at bearLevel', () => {
  const d = trailDistance('SHORT', LEVELS);
  assert.equal(
    trailExitLevel({ price: LEVELS.bearBreakout, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: null }),
    BEAR,
  );
});

test('trailExitLevel: LONG ratchets up as price rises', () => {
  const d = trailDistance('LONG', LEVELS);
  const a = trailExitLevel({ price: 106000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: BULL });
  assert.equal(a, 104960);
  const b = trailExitLevel({ price: 108000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: a });
  assert.equal(b, 106960);
});

test('trailExitLevel: LONG never retreats when price falls back', () => {
  const d = trailDistance('LONG', LEVELS);
  const high = trailExitLevel({ price: 108000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: BULL });
  const after = trailExitLevel({ price: 105500, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: high });
  assert.equal(after, high, 'the ratchet only turns one way');
});

// THE CHANGE. The old module capped at bullLevel because closing above it would
// land price inside the LONG rungs and instantly refill. There are no rungs.
test('trailExitLevel: LONG rises above the entry level and locks profit', () => {
  const d = trailDistance('LONG', LEVELS);
  const v = trailExitLevel({ price: 112000, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: BULL });
  assert.equal(v, 110960);
  assert.ok(v > LEVELS.bullBreakout, 'above the entry — a genuine profit lock');
});

test('trailExitLevel: SHORT falls below the entry level and locks profit', () => {
  const d = trailDistance('SHORT', LEVELS);
  const v = trailExitLevel({ price: 92000, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: BEAR });
  assert.equal(v, 93000);
  assert.ok(v < LEVELS.bearBreakout, 'below the entry — a genuine profit lock');
});

test('trailExitLevel: LONG never falls below bullLevel, even before the ratchet', () => {
  const d = trailDistance('LONG', LEVELS);
  const v = trailExitLevel({ price: 104100, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: null });
  assert.equal(v, BULL, 'floored at the exit level');
});

test('trailExitLevel: SHORT never rises above bearLevel', () => {
  const d = trailDistance('SHORT', LEVELS);
  const v = trailExitLevel({ price: 99900, distance: d, side: 'SHORT', bullLevel: BULL, bearLevel: BEAR, previous: null });
  assert.equal(v, BEAR, 'ceilinged at the exit level');
});

test('trailExitLevel: a stale previous below the floor is pulled back up', () => {
  const d = trailDistance('LONG', LEVELS);
  const stale = 90000; // e.g. bullLevel was edited up mid-cycle
  assert.equal(
    trailExitLevel({ price: 104200, distance: d, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: stale }),
    BULL,
  );
});

test('trailExitLevel: a bad distance or side yields null, never a stray number', () => {
  for (const over of [{ distance: null }, { distance: NaN }, { side: 'X' }, { price: NaN }, { bullLevel: NaN }]) {
    const r = trailExitLevel({ price: 106000, distance: 1040, side: 'LONG', bullLevel: BULL, bearLevel: BEAR, previous: null, ...over });
    assert.equal(r, null);
  }
});
