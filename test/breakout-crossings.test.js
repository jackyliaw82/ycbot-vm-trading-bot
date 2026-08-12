import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBreakoutEntry } from '../breakout-crossings.js';

// bull 100 / bear 98 with breakoutPct 1.5% -> entries at 101.5 and 96.53.
const UP = 101.5, DOWN = 96.53;
const plan = (over) => planBreakoutEntry({
  prevPrice: null, currentPrice: null,
  bullBreakout: UP, bearBreakout: DOWN,
  heldSide: null, pendingEntry: null, ...over,
});
const NOTHING = { open: null, clearPending: false };

test('first tick has no band, so nothing can be decided', () => {
  assert.deepEqual(plan({ prevPrice: null, currentPrice: 102 }), NOTHING);
});

test('inside the band nothing happens, however far price wanders', () => {
  for (const [a, b] of [[97, 101], [101, 97], [99, 99.5], [96.6, 101.4]]) {
    assert.deepEqual(plan({ prevPrice: a, currentPrice: b }), NOTHING, `${a}->${b}`);
  }
});

test('crossing bullBreakout upward opens a LONG', () => {
  assert.deepEqual(plan({ prevPrice: 101, currentPrice: 101.6 }),
    { open: 'LONG', clearPending: false });
});

test('crossing bearBreakout downward opens a SHORT', () => {
  assert.deepEqual(plan({ prevPrice: 97, currentPrice: 96.4 }),
    { open: 'SHORT', clearPending: false });
});

test('landing exactly ON the level counts as a crossing', () => {
  assert.deepEqual(plan({ prevPrice: 101, currentPrice: UP }),
    { open: 'LONG', clearPending: false });
  assert.deepEqual(plan({ prevPrice: 97, currentPrice: DOWN }),
    { open: 'SHORT', clearPending: false });
});

// The direction guard. Once trailing can carry an exit ABOVE the entry, a
// position closes with price above bullBreakout; price then falling back
// THROUGH bullBreakout is a crossing, and without the guard it opens a LONG on
// a downward move.
test('crossing bullBreakout DOWNWARD does not open a LONG', () => {
  assert.deepEqual(plan({ prevPrice: 103, currentPrice: 101.4 }), NOTHING);
});

test('crossing bearBreakout UPWARD does not open a SHORT', () => {
  assert.deepEqual(plan({ prevPrice: 95, currentPrice: 96.6 }), NOTHING);
});

// The equality trap. Mark prices are tick-rounded, so landing EXACTLY on a
// level is a real input. A symmetric `between(level, prev, current)` test
// returns true here for any prevPrice — an endpoint is always between its own
// bounds — and would open a LONG on a fall from far above.
test('falling from above onto bullBreakout EXACTLY does not open a LONG', () => {
  assert.deepEqual(plan({ prevPrice: 200, currentPrice: UP }), NOTHING);
  assert.deepEqual(plan({ prevPrice: 101.6, currentPrice: UP }), NOTHING);
});

test('rising from below onto bearBreakout EXACTLY does not open a SHORT', () => {
  assert.deepEqual(plan({ prevPrice: 50, currentPrice: DOWN }), NOTHING);
  assert.deepEqual(plan({ prevPrice: 96.4, currentPrice: DOWN }), NOTHING);
});

test('sitting exactly ON a level and staying there opens nothing', () => {
  assert.deepEqual(plan({ prevPrice: UP, currentPrice: UP }), NOTHING);
  assert.deepEqual(plan({ prevPrice: DOWN, currentPrice: DOWN }), NOTHING);
});

test('no entry while a position is already held', () => {
  assert.deepEqual(plan({ prevPrice: 101, currentPrice: 101.6, heldSide: 'LONG' }), NOTHING);
  assert.deepEqual(plan({ prevPrice: 101, currentPrice: 101.6, heldSide: 'SHORT' }), NOTHING);
});

// Price already past a level at start/resume: today's behaviour is to wait for
// a fresh crossing, because there is no band on the first tick and afterwards
// the level is not between prev and current.
test('price sitting beyond a level without crossing it does nothing', () => {
  assert.deepEqual(plan({ prevPrice: 102, currentPrice: 103 }), NOTHING);
  assert.deepEqual(plan({ prevPrice: 95, currentPrice: 94 }), NOTHING);
});

// A gap can carry price from above bullLevel to below bearBreakout in one tick.
// The strategy closes the LONG and latches _pendingEntry='SHORT'; this module
// resolves the latch on the NEXT tick.
test('pending SHORT opens when price is still beyond bearBreakout', () => {
  assert.deepEqual(plan({ prevPrice: 96, currentPrice: 95.5, pendingEntry: 'SHORT' }),
    { open: 'SHORT', clearPending: true });
});

test('pending SHORT opens even with no crossing on this tick', () => {
  assert.deepEqual(plan({ prevPrice: 95.5, currentPrice: 95.4, pendingEntry: 'SHORT' }),
    { open: 'SHORT', clearPending: true });
});

test('pending SHORT is dropped when price came back inside the band', () => {
  assert.deepEqual(plan({ prevPrice: 96, currentPrice: 99, pendingEntry: 'SHORT' }),
    { open: null, clearPending: true });
});

test('pending LONG mirrors', () => {
  assert.deepEqual(plan({ prevPrice: 102, currentPrice: 103, pendingEntry: 'LONG' }),
    { open: 'LONG', clearPending: true });
  assert.deepEqual(plan({ prevPrice: 102, currentPrice: 100, pendingEntry: 'LONG' }),
    { open: null, clearPending: true });
});

test('a held position beats a pending entry and clears nothing', () => {
  assert.deepEqual(plan({ prevPrice: 96, currentPrice: 95.5, pendingEntry: 'SHORT', heldSide: 'SHORT' }),
    NOTHING);
});

// A single tick spanning BOTH levels: act on the side price landed on. The two
// conditions are mutually exclusive because bullBreakout > bearBreakout.
test('a band spanning both levels acts on the side price landed on', () => {
  assert.deepEqual(plan({ prevPrice: 96, currentPrice: 102 }),
    { open: 'LONG', clearPending: false });
  assert.deepEqual(plan({ prevPrice: 102, currentPrice: 96 }),
    { open: 'SHORT', clearPending: false });
});

test('non-finite inputs decide nothing rather than guessing', () => {
  for (const over of [
    { currentPrice: NaN }, { prevPrice: NaN }, { currentPrice: Infinity },
    { bullBreakout: NaN }, { bearBreakout: null },
  ]) {
    assert.deepEqual(plan({ prevPrice: 101, currentPrice: 101.6, ...over }), NOTHING);
  }
});

test('an unchanged price decides nothing', () => {
  assert.deepEqual(plan({ prevPrice: UP, currentPrice: UP }), NOTHING);
});

// `{x} = {}` only defaults for `undefined` — an explicit `null` call must not throw.
test('planBreakoutEntry(null) does not throw and decides nothing', () => {
  assert.deepEqual(planBreakoutEntry(null), NOTHING);
});
