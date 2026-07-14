import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCrossingActions } from '../grid-crossings.js';

function leg(direction, levelIndex, price, state = 'EMPTY') {
  return { direction, levelIndex, price, state, quantity: state === 'POSITION_OPEN' ? 1 : null };
}

test('down-cross of a LONG level opens that LONG (no shorts open → no peel)', () => {
  const legs = [leg('LONG', 1, 99.7), leg('SHORT', 1, 100.3)];
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.6, legs, vwapLong: null, vwapShort: null });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['OPEN', 'ENTRY', 'LONG', 1]]);
});

test('up-cross peels the OUTERMOST open long (lowest price) while above VWAP, then opens crossed SHORT', () => {
  const legs = [
    leg('LONG', 1, 99.7, 'POSITION_OPEN'),
    leg('LONG', 2, 99.4, 'POSITION_OPEN'),
    leg('SHORT', 1, 100.3),
  ];
  // vwapLong = avg(99.7,99.4) = 99.55; price 100.35 > vwap → peel outermost long = L2 (99.4).
  const acts = planCrossingActions({ prevPrice: 100.2, currentPrice: 100.35, legs, vwapLong: 99.55, vwapShort: null });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'TP_PEEL', 'LONG', 2], ['OPEN', 'ENTRY', 'SHORT', 1]]);
});

test('up-move crossing two long levels peels the two OUTERMOST longs (lowest first)', () => {
  const legs = [
    leg('LONG', 1, 99.7, 'POSITION_OPEN'),
    leg('LONG', 2, 99.4, 'POSITION_OPEN'),
    leg('LONG', 3, 99.1, 'POSITION_OPEN'),
  ];
  // vwapLong 99.4; price rises through 99.4 then 99.7 → 2 crossings, peel L3 then L2 (outermost first).
  const acts = planCrossingActions({ prevPrice: 99.35, currentPrice: 99.75, legs, vwapLong: 99.4, vwapShort: null });
  const peeled = acts.filter(a => a.reason === 'TP_PEEL').map(a => a.leg.levelIndex);
  assert.deepEqual(peeled, [3, 2]);
});

test('multi-level down-cross peels each open SHORT at most once (outermost first)', () => {
  const legs = [ leg('LONG', 1, 99.7), leg('LONG', 2, 99.4), leg('SHORT', 1, 100.3, 'POSITION_OPEN') ];
  // one short open (vwap 100.3); price 99.35 < vwap → peel it once even though 2 long levels cross.
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.35, legs, vwapLong: null, vwapShort: 100.3 });
  const closes = acts.filter(a => a.kind === 'CLOSE' && a.reason === 'TP_PEEL');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].leg.direction, 'SHORT');
  assert.equal(closes[0].leg.levelIndex, 1);
  const opens = acts.filter(a => a.kind === 'OPEN').map(a => a.leg.levelIndex).sort();
  assert.deepEqual(opens, [1, 2]);
});

test('down-cross of a LONG level peels the OUTERMOST open short (highest price), then opens the LONG', () => {
  const legs = [ leg('SHORT', 1, 100.3, 'POSITION_OPEN'), leg('SHORT', 2, 100.6, 'POSITION_OPEN'), leg('LONG', 1, 99.7) ];
  // vwapShort = avg(100.3,100.6) = 100.45; price 99.65 < vwap → peel outermost short = S2 (100.6).
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.65, legs, vwapLong: null, vwapShort: 100.45 });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'TP_PEEL', 'SHORT', 2], ['OPEN', 'ENTRY', 'LONG', 1]]);
});

test('down-move below VWAP peels the OUTERMOST shorts first (S3,S2 — leaves S1)', () => {
  const legs = [ leg('SHORT', 1, 100.3, 'POSITION_OPEN'), leg('SHORT', 2, 100.6, 'POSITION_OPEN'), leg('SHORT', 3, 100.9, 'POSITION_OPEN') ];
  // vwap 100.9; price falls through 100.6 then 100.3 (2 crossings, both below vwap) → peel S3 then S2, S1 stays.
  const acts = planCrossingActions({ prevPrice: 100.65, currentPrice: 100.25, legs, vwapLong: null, vwapShort: 100.9 });
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
  const a1 = planCrossingActions({ prevPrice: 101.5, currentPrice: 100.9, legs, vwapLong: null, vwapShort: 102 });
  assert.deepEqual(a1.filter(x => x.kind === 'CLOSE').map(x => [x.leg.direction, x.leg.levelIndex]), [['SHORT', 3]]);

  // S1,S2 open (vwap 101.5); hit L1 (99) → peel outermost = S2, and open L1.
  legs = mk(); legs[2].state = 'EMPTY'; legs[2].quantity = null; // S3 already closed
  const a2 = planCrossingActions({ prevPrice: 99.5, currentPrice: 98.9, legs, vwapLong: null, vwapShort: 101.5 });
  assert.deepEqual(a2.map(x => [x.kind, x.leg.direction, x.leg.levelIndex]),
    [['CLOSE', 'SHORT', 2], ['OPEN', 'LONG', 1]]);

  // only S1 open (vwap 101), L1 now open; hit L2 (98) → peel outermost = S1, open L2 (L1 long is NOT peeled going down).
  legs = mk();
  legs[1].state = 'EMPTY'; legs[1].quantity = null; legs[2].state = 'EMPTY'; legs[2].quantity = null; // S2,S3 closed
  legs[3].state = 'POSITION_OPEN'; legs[3].quantity = 1; // L1 open
  const a3 = planCrossingActions({ prevPrice: 98.5, currentPrice: 97.9, legs, vwapLong: 99, vwapShort: 101 });
  assert.deepEqual(a3.filter(x => x.kind === 'CLOSE').map(x => [x.leg.direction, x.leg.levelIndex]), [['SHORT', 1]]);
  assert.deepEqual(a3.filter(x => x.kind === 'OPEN').map(x => [x.leg.direction, x.leg.levelIndex]), [['LONG', 2]]);
});

test('no peel while price is still above the short VWAP', () => {
  const legs = [ leg('SHORT', 1, 101, 'POSITION_OPEN'), leg('SHORT', 2, 102, 'POSITION_OPEN'), leg('SHORT', 3, 103, 'POSITION_OPEN') ];
  // price crosses S3(103) down to 102.5, still ABOVE vwap 102 → no peel.
  const acts = planCrossingActions({ prevPrice: 103.5, currentPrice: 102.5, legs, vwapLong: null, vwapShort: 102 });
  assert.equal(acts.filter(a => a.kind === 'CLOSE').length, 0);
});

test('planCrossingActions does not mutate the caller legs', () => {
  const legs = [ leg('LONG', 1, 99.7, 'POSITION_OPEN'), leg('SHORT', 1, 100.3, 'POSITION_OPEN') ];
  const snapshot = JSON.parse(JSON.stringify(legs));
  planCrossingActions({ prevPrice: 100.2, currentPrice: 100.35, legs, vwapLong: 99.7, vwapShort: null });
  assert.deepEqual(JSON.parse(JSON.stringify(legs)), snapshot);
});
