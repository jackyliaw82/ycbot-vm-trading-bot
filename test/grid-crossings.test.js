import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCrossingActions } from '../grid-crossings.js';

function leg(direction, levelIndex, price, state = 'EMPTY') {
  return { direction, levelIndex, price, state, quantity: state === 'POSITION_OPEN' ? 1 : null };
}

// Grid geometry for the 0.3-spaced fixtures below (anchor 100, step 0.3);
// G1 is the 1.0-spaced geometry (anchor 100, step 1).
const G = { gridStep: 0.3, gridAnchor: 100 };
const G1 = { gridStep: 1, gridAnchor: 100 };

test('down-cross of a LONG level opens that LONG (no shorts open → no peel)', () => {
  const legs = [leg('LONG', 1, 99.7), leg('SHORT', 1, 100.3)];
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.6, legs, vwapLong: null, vwapShort: null, ...G });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['OPEN', 'ENTRY', 'LONG', 1]]);
});

test('up-cross peels the OUTERMOST open long (lowest price) while above VWAP, then opens crossed SHORT', () => {
  const legs = [
    leg('LONG', 1, 99.7, 'POSITION_OPEN'),
    leg('LONG', 2, 99.4, 'POSITION_OPEN'),
    leg('SHORT', 1, 100.3),
  ];
  // vwapLong = avg(99.7,99.4) = 99.55; crossed level S1 (100.3) is 0.75 ≥ 1 grid
  // above vwap → peel outermost long = L2 (99.4).
  const acts = planCrossingActions({ prevPrice: 100.2, currentPrice: 100.35, legs, vwapLong: 99.55, vwapShort: null, ...G });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'TP_PEEL', 'LONG', 2], ['OPEN', 'ENTRY', 'SHORT', 1]]);
});

test('up-move crossing two qualifying levels peels the two OUTERMOST longs (lowest first)', () => {
  const legs = [
    leg('LONG', 1, 99.7, 'POSITION_OPEN'),
    leg('LONG', 2, 99.4, 'POSITION_OPEN'),
    leg('LONG', 3, 99.1, 'POSITION_OPEN'),
    leg('SHORT', 1, 100.3),
  ];
  // vwapLong = avg(99.7,99.4,99.1) = 99.4; price rises through L1 (99.7, exactly 1
  // grid above vwap) then S1 (100.3, 0.9 above) → both qualify → peel L3 then L2.
  const acts = planCrossingActions({ prevPrice: 99.6, currentPrice: 100.35, legs, vwapLong: 99.4, vwapShort: null, ...G });
  const peeled = acts.filter(a => a.reason === 'TP_PEEL').map(a => a.leg.levelIndex);
  assert.deepEqual(peeled, [3, 2]);
  assert.deepEqual(acts.filter(a => a.kind === 'OPEN').map(a => [a.leg.direction, a.leg.levelIndex]), [['SHORT', 1]]);
});

test('crossed level within one grid of the VWAP does NOT peel (rule 2 buffer)', () => {
  const g = { gridStep: 1, gridAnchor: 100 };
  // S1=101, S2=102 open, vwapShort = 101.5. Crossing S1 is only 0.5 below the VWAP
  // (< 1 grid) → NO peel even though S1 is below the VWAP.
  let legs = [leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('SHORT', 2, 102, 'POSITION_OPEN'), leg('LONG', 1, 99)];
  const a1 = planCrossingActions({ prevPrice: 101.4, currentPrice: 100.9, legs, vwapLong: null, vwapShort: 101.5, ...g });
  assert.equal(a1.filter(x => x.kind === 'CLOSE').length, 0);
  // Continue down to L1 (99, which is 2.5 below the VWAP ≥ 1 grid) → peel outermost short S2 + open L1.
  legs = [leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('SHORT', 2, 102, 'POSITION_OPEN'), leg('LONG', 1, 99)];
  const a2 = planCrossingActions({ prevPrice: 99.5, currentPrice: 98.9, legs, vwapLong: null, vwapShort: 101.5, ...g });
  assert.deepEqual(a2.map(x => [x.kind, x.leg.direction, x.leg.levelIndex]),
    [['CLOSE', 'SHORT', 2], ['OPEN', 'LONG', 1]]);
});

test('multi-level down-cross peels each open SHORT at most once (outermost first)', () => {
  const legs = [ leg('LONG', 1, 99.7), leg('LONG', 2, 99.4), leg('SHORT', 1, 100.3, 'POSITION_OPEN') ];
  // one short open (vwap 100.3); crossed levels L1/L2 are ≥ 1 grid below → peel it
  // once even though 2 long levels cross.
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.35, legs, vwapLong: null, vwapShort: 100.3, ...G });
  const closes = acts.filter(a => a.kind === 'CLOSE' && a.reason === 'TP_PEEL');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].leg.direction, 'SHORT');
  assert.equal(closes[0].leg.levelIndex, 1);
  const opens = acts.filter(a => a.kind === 'OPEN').map(a => a.leg.levelIndex).sort();
  assert.deepEqual(opens, [1, 2]);
});

test('down-cross of a LONG level peels the OUTERMOST open short (highest price), then opens the LONG', () => {
  const legs = [ leg('SHORT', 1, 100.3, 'POSITION_OPEN'), leg('SHORT', 2, 100.6, 'POSITION_OPEN'), leg('LONG', 1, 99.7) ];
  // vwapShort = avg(100.3,100.6) = 100.45; crossed L1 (99.7) is 0.75 ≥ 1 grid below
  // vwap → peel outermost short = S2 (100.6).
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.65, legs, vwapLong: null, vwapShort: 100.45, ...G });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'TP_PEEL', 'SHORT', 2], ['OPEN', 'ENTRY', 'LONG', 1]]);
});

test('down-move below VWAP peels the OUTERMOST shorts first (S3,S2 — leaves S1)', () => {
  const legs = [ leg('SHORT', 1, 100.3, 'POSITION_OPEN'), leg('SHORT', 2, 100.6, 'POSITION_OPEN'), leg('SHORT', 3, 100.9, 'POSITION_OPEN') ];
  // vwapShort chosen at 100.9 so both crossed levels (100.6, 100.3) are ≥ 1 grid
  // below it; price falls through both → peel S3 then S2 (outermost first), S1 stays.
  const acts = planCrossingActions({ prevPrice: 100.65, currentPrice: 100.25, legs, vwapLong: null, vwapShort: 100.9, ...G });
  const peeled = acts.filter(a => a.reason === 'TP_PEEL').map(a => a.leg.levelIndex);
  assert.deepEqual(peeled, [3, 2]);
});

test('close-outermost: sequential crossings peel S3 at S1, S2 at L1, S1 at L2', () => {
  // anchor 100; S1=101, S2=102, S3=103; VWAP≈102(S2); L1=99, L2=98.
  const mk = () => [
    leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('SHORT', 2, 102, 'POSITION_OPEN'), leg('SHORT', 3, 103, 'POSITION_OPEN'),
    leg('LONG', 1, 99), leg('LONG', 2, 98),
  ];

  // hit S1 (101) with price below VWAP → peel the outermost short = S3.
  let legs = mk();
  const a1 = planCrossingActions({ prevPrice: 101.5, currentPrice: 100.9, legs, vwapLong: null, vwapShort: 102, ...G1 });
  assert.deepEqual(a1.filter(x => x.kind === 'CLOSE').map(x => [x.leg.direction, x.leg.levelIndex]), [['SHORT', 3]]);

  // S1,S2 open (vwap 101.5); hit L1 (99) → peel outermost = S2, and open L1.
  legs = mk(); legs[2].state = 'EMPTY'; legs[2].quantity = null; // S3 already closed
  const a2 = planCrossingActions({ prevPrice: 99.5, currentPrice: 98.9, legs, vwapLong: null, vwapShort: 101.5, ...G1 });
  assert.deepEqual(a2.map(x => [x.kind, x.leg.direction, x.leg.levelIndex]),
    [['CLOSE', 'SHORT', 2], ['OPEN', 'LONG', 1]]);

  // only S1 open (vwap 101), L1 now open; hit L2 (98) → peel outermost = S1, open L2 (L1 long is NOT peeled going down).
  legs = mk();
  legs[1].state = 'EMPTY'; legs[1].quantity = null; legs[2].state = 'EMPTY'; legs[2].quantity = null; // S2,S3 closed
  legs[3].state = 'POSITION_OPEN'; legs[3].quantity = 1; // L1 open
  const a3 = planCrossingActions({ prevPrice: 98.5, currentPrice: 97.9, legs, vwapLong: 99, vwapShort: 101, ...G1 });
  assert.deepEqual(a3.filter(x => x.kind === 'CLOSE').map(x => [x.leg.direction, x.leg.levelIndex]), [['SHORT', 1]]);
  assert.deepEqual(a3.filter(x => x.kind === 'OPEN').map(x => [x.leg.direction, x.leg.levelIndex]), [['LONG', 2]]);
});

test('lone short does NOT peel at its own level — it waits and exits at L1', () => {
  // Only S1 open, so vwapShort == S1's price. Crossing S1 downward is NOT below
  // the VWAP → no same-territory peel (would be ~0 profit at its own level).
  let legs = [leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('LONG', 1, 99)];
  const down1 = planCrossingActions({ prevPrice: 101.5, currentPrice: 100.5, legs, vwapLong: null, vwapShort: 101, ...G1 });
  assert.equal(down1.filter(a => a.kind === 'CLOSE').length, 0);
  // Continue down through L1 (99) → S1 exits opposite-territory + L1 opens.
  legs = [leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('LONG', 1, 99)];
  const down2 = planCrossingActions({ prevPrice: 99.5, currentPrice: 98.5, legs, vwapLong: null, vwapShort: 101, ...G1 });
  assert.deepEqual(down2.map(a => [a.kind, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'SHORT', 1], ['OPEN', 'LONG', 1]]);
});

test('lone long does NOT peel at its own level — it waits and exits at the first short level', () => {
  let legs = [leg('LONG', 1, 99, 'POSITION_OPEN'), leg('SHORT', 1, 101)];
  const up1 = planCrossingActions({ prevPrice: 98.5, currentPrice: 99.5, legs, vwapLong: 99, vwapShort: null, ...G1 });
  assert.equal(up1.filter(a => a.kind === 'CLOSE').length, 0);
  legs = [leg('LONG', 1, 99, 'POSITION_OPEN'), leg('SHORT', 1, 101)];
  const up2 = planCrossingActions({ prevPrice: 100.5, currentPrice: 101.5, legs, vwapLong: 99, vwapShort: null, ...G1 });
  assert.deepEqual(up2.map(a => [a.kind, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'LONG', 1], ['OPEN', 'SHORT', 1]]);
});

test('no peel while price is still above the short VWAP', () => {
  const legs = [ leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('SHORT', 2, 102, 'POSITION_OPEN'), leg('SHORT', 3, 103, 'POSITION_OPEN') ];
  // price crosses S3(103) down to 102.5, still ABOVE vwap 102 → no peel.
  const acts = planCrossingActions({ prevPrice: 103.5, currentPrice: 102.5, legs, vwapLong: null, vwapShort: 102, ...G1 });
  assert.equal(acts.filter(a => a.kind === 'CLOSE').length, 0);
});

test('planCrossingActions does not mutate the caller legs', () => {
  const legs = [ leg('LONG', 1, 99.7, 'POSITION_OPEN'), leg('SHORT', 1, 100.3, 'POSITION_OPEN') ];
  const snapshot = JSON.parse(JSON.stringify(legs));
  planCrossingActions({ prevPrice: 100.2, currentPrice: 100.35, legs, vwapLong: 99.7, vwapShort: null, ...G });
  assert.deepEqual(JSON.parse(JSON.stringify(legs)), snapshot);
});
