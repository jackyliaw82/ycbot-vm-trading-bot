import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReversalActions, averageOpenEntry } from '../reversal-crossings.js';
import { buildReversalLadder } from '../reversal-levels.js';

const BULL = 104000, BEAR = 100000, STEP = 0.003, N = 5;
const fresh = () => buildReversalLadder(BULL, BEAR, STEP, N);
const fill = (legs, direction, ...indices) =>
  legs.map(l => (l.direction === direction && indices.includes(l.index) ? { ...l, state: 'POSITION_OPEN' } : l));
const plan = (over) => planReversalActions({
  prevPrice: null, currentPrice: null, bullLevel: BULL, bearLevel: BEAR,
  legs: fresh(), heldSide: null, levelsPerSide: N, ...over,
});
const ids = (r) => r.fills.map(f => `${f.direction[0]}${f.index}`);

test('dead zone: no crossing, flat -> nothing happens', () => {
  const r = plan({ prevPrice: 102000, currentPrice: 103000 });
  assert.deepEqual(r, { reverse: false, side: null, fills: [], enterTrend: false });
});

test('dead zone: no crossing while HOLDING -> nothing happens', () => {
  const r = plan({ prevPrice: 103000, currentPrice: 101000, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1) });
  assert.equal(r.fills.length, 0);
  assert.equal(r.reverse, false);
});

test('Rule 1: flat, band crosses bull -> opens L1 only', () => {
  const r = plan({ prevPrice: 103000, currentPrice: 104050 });
  assert.equal(r.reverse, false);
  assert.equal(r.side, 'LONG');
  assert.deepEqual(ids(r), ['L1']);
  assert.equal(r.enterTrend, false);
});

test('Rule 1: flat, band crosses bear -> opens S1 only', () => {
  const r = plan({ prevPrice: 100500, currentPrice: 99950 });
  assert.equal(r.side, 'SHORT');
  assert.deepEqual(ids(r), ['S1']);
});

test('Rule 3: scaling fills every empty rung in the band, innermost first', () => {
  const r = plan({
    prevPrice: 104050, currentPrice: 104700, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1),
  });
  assert.equal(r.reverse, false);
  assert.deepEqual(ids(r), ['L2', 'L3'], 'L2=104312, L3=104624 both inside the band');
});

test('Rule 3: an already-filled rung is not re-filled', () => {
  const r = plan({
    prevPrice: 104700, currentPrice: 104050, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1, 2, 3),
  });
  assert.deepEqual(ids(r), [], 'band re-crosses filled rungs downward — nothing to do');
});

test('Rule 3: filling the OUTERMOST rung arms TREND', () => {
  const r = plan({
    prevPrice: 104900, currentPrice: 105300, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1, 2, 3, 4),
  });
  assert.deepEqual(ids(r), ['L5']);
  assert.equal(r.enterTrend, true);
});

test('Rule 3: filling a non-outermost rung does not arm TREND', () => {
  const r = plan({
    prevPrice: 104050, currentPrice: 104400, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1),
  });
  assert.equal(r.enterTrend, false);
});

test('Rule 2: LONG held, band crosses bear -> reverse and open S1 the SAME tick', () => {
  const r = plan({
    prevPrice: 100500, currentPrice: 99950, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1, 2),
  });
  assert.equal(r.reverse, true);
  assert.equal(r.side, 'SHORT');
  assert.deepEqual(ids(r), ['S1']);
});

test('Rule 2: SHORT held, band crosses bull -> reverse to LONG', () => {
  const r = plan({
    prevPrice: 103900, currentPrice: 104100, heldSide: 'SHORT', legs: fill(fresh(), 'SHORT', 1, 2, 3),
  });
  assert.equal(r.reverse, true);
  assert.equal(r.side, 'LONG');
  assert.deepEqual(ids(r), ['L1']);
});

test('Rule 2: a reversal can arm TREND on a deep gap', () => {
  const r = plan({
    prevPrice: 100500, currentPrice: 98700, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1),
  });
  assert.equal(r.reverse, true);
  assert.equal(r.side, 'SHORT');
  assert.deepEqual(ids(r), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.equal(r.enterTrend, true);
});

test('Rule 0: a band straddling BOTH levels acts only on the landing side', () => {
  // 104500 -> 99500 spans bull AND bear. LONG is held.
  const r = plan({
    prevPrice: 104500, currentPrice: 99500, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1, 2),
  });
  assert.equal(r.reverse, true);
  assert.equal(r.side, 'SHORT', 'landed below bear');
  assert.ok(ids(r).every(i => i.startsWith('S')), `LONG rungs must not re-open: ${ids(r)}`);
  assert.deepEqual(ids(r), ['S1', 'S2'], 'S1=100000, S2=99700 in band; S3=99400 is not');
});

test('Rule 0: straddle upward from SHORT lands on LONG', () => {
  const r = plan({
    prevPrice: 99500, currentPrice: 104500, heldSide: 'SHORT', legs: fill(fresh(), 'SHORT', 1, 2),
  });
  assert.equal(r.reverse, true);
  assert.equal(r.side, 'LONG');
  assert.deepEqual(ids(r), ['L1', 'L2'], 'L1=104000, L2=104312 in band; L3=104624 is not');
});

test('Rule 0: straddle while FLAT still opens only the landing side', () => {
  const r = plan({ prevPrice: 104500, currentPrice: 99500, heldSide: null });
  assert.equal(r.reverse, false, 'nothing to close when flat');
  assert.equal(r.side, 'SHORT');
  assert.ok(ids(r).every(i => i.startsWith('S')));
});

test('crossing the held side\'s OWN level downward is scaling, not a reversal', () => {
  // LONG held, price falls back through bull but stays above bear.
  const r = plan({
    prevPrice: 104100, currentPrice: 103500, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1),
  });
  assert.equal(r.reverse, false, 'bull is the LONG side\'s own trigger, not the opposite one');
  assert.deepEqual(ids(r), [], 'L1 already filled');
});

test('guards: a first tick, an unchanged price, or a bad level yields nothing', () => {
  assert.deepEqual(plan({ prevPrice: null, currentPrice: 104050 }).fills, []);
  assert.deepEqual(plan({ prevPrice: 104050, currentPrice: 104050 }).fills, []);
  assert.deepEqual(plan({ prevPrice: 103000, currentPrice: 104050, bullLevel: NaN }).fills, []);
  assert.deepEqual(plan({ prevPrice: 103000, currentPrice: 104050, bearLevel: undefined }).fills, []);
  assert.deepEqual(plan({ prevPrice: 103000, currentPrice: 104050, legs: null }).fills, []);
});

test('guards: an unchanged price never reverses', () => {
  const r = plan({ prevPrice: 99950, currentPrice: 99950, heldSide: 'LONG' });
  assert.equal(r.reverse, false);
});

test('enterTrend derives the outermost rung from legs, ignoring a stale/wrong levelsPerSide', () => {
  const r = plan({
    prevPrice: 104900, currentPrice: 105300, heldSide: 'LONG', legs: fill(fresh(), 'LONG', 1, 2, 3, 4),
    levelsPerSide: 3, // deliberately wrong -- must not affect the result; legs actually have 5 rungs/side
  });
  assert.deepEqual(ids(r), ['L5']);
  assert.equal(r.enterTrend, true, 'outermost must come from legs (index 5), not the levelsPerSide argument');
});

test('enterTrend is false and nothing throws when the acting side has no legs at all', () => {
  const legsNoLong = fresh().filter(l => l.direction !== 'LONG'); // only SHORT legs present
  assert.doesNotThrow(() => {
    const r = plan({ prevPrice: 103000, currentPrice: 104050, legs: legsNoLong });
    assert.equal(r.side, 'LONG');
    assert.deepEqual(r.fills, []);
    assert.equal(r.enterTrend, false);
  });
});

test('heldSide: 0 is treated the same (not as flat) on a dead-zone tick and a crossing tick', () => {
  // Dead zone: no level crossed. heldSide=0 must NOT be silently read as flat
  // (the old `!heldSide` falsy check did exactly that) -- it must take the
  // same "some held side" path any other non-null heldSide would.
  const deadZone = plan({ prevPrice: 102000, currentPrice: 103000, heldSide: 0 });
  assert.notDeepEqual(deadZone, { reverse: false, side: null, fills: [], enterTrend: false },
    'heldSide=0 must not collapse to the flat sentinel on a dead-zone tick');

  // Crossing tick: heldSide=0 must be read as "some held side" here too (the
  // `heldSide != null` reverse check), consistent with the dead-zone tick --
  // not flat in one branch and held in the other for the same input value.
  const crossing = plan({ prevPrice: 103000, currentPrice: 104050, heldSide: 0 });
  assert.equal(crossing.reverse, true, 'heldSide=0 !== side, and both branches use the same != null test');
});

test('enterTrend uses the ACTING SIDE\'s own outermost rung, not a max across both sides', () => {
  // Hand-built and deliberately ASYMMETRIC -- buildReversalLadder always gives
  // both sides the same rung count, so it can never produce this shape. LONG
  // has only 3 rungs; SHORT has 5. If the outermost derivation ever took the
  // max index across ALL legs instead of filtering to `side` first, SHORT's
  // index 5 would leak into LONG's result and TREND would never arm on LONG's
  // real outermost rung (index 3).
  const legs = [
    { direction: 'LONG', index: 1, price: 104000, state: 'POSITION_OPEN' },
    { direction: 'LONG', index: 2, price: 104312, state: 'POSITION_OPEN' },
    { direction: 'LONG', index: 3, price: 104624, state: 'EMPTY' },
    { direction: 'SHORT', index: 1, price: 100000, state: 'EMPTY' },
    { direction: 'SHORT', index: 2, price: 99700, state: 'EMPTY' },
    { direction: 'SHORT', index: 3, price: 99400, state: 'EMPTY' },
    { direction: 'SHORT', index: 4, price: 99100, state: 'EMPTY' },
    { direction: 'SHORT', index: 5, price: 98800, state: 'EMPTY' },
  ];
  const r = plan({ prevPrice: 104400, currentPrice: 104700, heldSide: 'LONG', legs });
  assert.deepEqual(ids(r), ['L3'], 'L3 is the only empty LONG rung inside the band');
  assert.equal(r.enterTrend, true,
    'L3 IS the LONG ladder\'s own outermost rung (3 LONG legs total), despite a SHORT rung carrying index 5');
});

// ——— averageOpenEntry (moved verbatim from ladder-crossings.test.js) ———

test('averageOpenEntry uses the ACTUAL fill price, not the level price', () => {
  const legs = fresh();
  const l1 = legs.find(l => l.direction === 'LONG' && l.index === 1);
  const l2 = legs.find(l => l.direction === 'LONG' && l.index === 2);
  Object.assign(l1, { state: 'POSITION_OPEN', quantity: 10, fillPrice: 104010 }); // slipped
  Object.assign(l2, { state: 'POSITION_OPEN', quantity: 10, fillPrice: 104322 });
  const avg = averageOpenEntry(legs, 'LONG');
  assert.ok(Math.abs(avg - 104166) < 1e-9, `expected the fill-weighted average, got ${avg}`);
  assert.equal(averageOpenEntry(legs, 'SHORT'), null, 'no open SHORT legs');
});

test('averageOpenEntry falls back to the level price when fillPrice is missing', () => {
  const legs = fresh();
  const l1 = legs.find(l => l.direction === 'LONG' && l.index === 1);
  Object.assign(l1, { state: 'POSITION_OPEN', quantity: 10, fillPrice: null });
  assert.ok(Math.abs(averageOpenEntry(legs, 'LONG') - BULL) < 1e-9);
});

test('mirror: SHORT acting with fewer rungs than LONG still arms TREND off its own outermost', () => {
  const legs = [
    { direction: 'LONG', index: 1, price: 104000, state: 'EMPTY' },
    { direction: 'LONG', index: 2, price: 104312, state: 'EMPTY' },
    { direction: 'LONG', index: 3, price: 104624, state: 'EMPTY' },
    { direction: 'LONG', index: 4, price: 104936, state: 'EMPTY' },
    { direction: 'LONG', index: 5, price: 105248, state: 'EMPTY' },
    { direction: 'SHORT', index: 1, price: 100000, state: 'POSITION_OPEN' },
    { direction: 'SHORT', index: 2, price: 99700, state: 'POSITION_OPEN' },
    { direction: 'SHORT', index: 3, price: 99400, state: 'EMPTY' },
  ];
  const r = plan({ prevPrice: 99500, currentPrice: 99300, heldSide: 'SHORT', legs });
  assert.deepEqual(ids(r), ['S3'], 'S3 is the only empty SHORT rung inside the band');
  assert.equal(r.enterTrend, true,
    'S3 IS the SHORT ladder\'s own outermost rung (3 SHORT legs total), despite a LONG rung carrying index 5');
});
