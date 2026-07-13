import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCrossingActions } from '../grid-crossings.js';

function leg(direction, levelIndex, price, state = 'EMPTY') {
  return { direction, levelIndex, price, state, quantity: state === 'POSITION_OPEN' ? 1 : null };
}

test('down-cross of a LONG level opens that LONG', () => {
  const legs = [leg('LONG', 1, 99.7), leg('SHORT', 1, 100.3)];
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.6, legs, vwapLong: null, vwapShort: null });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['OPEN', 'ENTRY', 'LONG', 1]]);
});

test('up-cross closes deepest open LONG (opposite-territory TP), then opens crossed SHORT', () => {
  const legs = [
    leg('LONG', 1, 99.7, 'POSITION_OPEN'),
    leg('LONG', 2, 99.4, 'POSITION_OPEN'),
    leg('SHORT', 1, 100.3),
  ];
  const acts = planCrossingActions({ prevPrice: 100.2, currentPrice: 100.35, legs, vwapLong: null, vwapShort: null });
  // deepest open long = L2 (99.4) closes; SHORT S1 opens
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'TP_OPP', 'LONG', 2], ['OPEN', 'ENTRY', 'SHORT', 1]]);
});

test('same-territory TP closes open LONG legs above VWAP on an up-move', () => {
  const legs = [
    leg('LONG', 1, 99.7, 'POSITION_OPEN'),
    leg('LONG', 2, 99.4, 'POSITION_OPEN'),
    leg('LONG', 3, 99.1, 'POSITION_OPEN'),
  ];
  // vwapLong 99.1; price rises through 99.4 then 99.7. L2/L1 above vwap -> same-territory TP.
  const acts = planCrossingActions({ prevPrice: 99.35, currentPrice: 99.75, legs, vwapLong: 99.1, vwapShort: null });
  const same = acts.filter(a => a.reason === 'TP_SAME').map(a => a.leg.levelIndex).sort();
  assert.deepEqual(same, [1, 2]);
});

test('multi-level down-cross with one open SHORT closes it only once', () => {
  const legs = [ leg('LONG', 1, 99.7), leg('LONG', 2, 99.4), leg('SHORT', 1, 100.3, 'POSITION_OPEN') ];
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.35, legs, vwapLong: null, vwapShort: null });
  const closes = acts.filter(a => a.kind === 'CLOSE' && a.reason === 'TP_OPP');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].leg.levelIndex, 1);
  const opens = acts.filter(a => a.kind === 'OPEN').map(a => a.leg.levelIndex).sort();
  assert.deepEqual(opens, [1, 2]);
});

test('down-cross closes deepest open SHORT (opposite-territory), then opens crossed LONG', () => {
  const legs = [ leg('SHORT', 1, 100.3, 'POSITION_OPEN'), leg('SHORT', 2, 100.6, 'POSITION_OPEN'), leg('LONG', 1, 99.7) ];
  const acts = planCrossingActions({ prevPrice: 99.8, currentPrice: 99.65, legs, vwapLong: null, vwapShort: null });
  assert.deepEqual(acts.map(a => [a.kind, a.reason, a.leg.direction, a.leg.levelIndex]),
    [['CLOSE', 'TP_OPP', 'SHORT', 2], ['OPEN', 'ENTRY', 'LONG', 1]]);
});

test('same-territory TP closes open SHORT legs below VWAP on a down-move', () => {
  const legs = [ leg('SHORT', 1, 100.3, 'POSITION_OPEN'), leg('SHORT', 2, 100.6, 'POSITION_OPEN'), leg('SHORT', 3, 100.9, 'POSITION_OPEN') ];
  const acts = planCrossingActions({ prevPrice: 100.65, currentPrice: 100.25, legs, vwapLong: null, vwapShort: 100.9 });
  const same = acts.filter(a => a.reason === 'TP_SAME').map(a => a.leg.levelIndex).sort();
  assert.deepEqual(same, [1, 2]);
});

test('planCrossingActions does not mutate the caller legs', () => {
  const legs = [ leg('LONG', 1, 99.7, 'POSITION_OPEN'), leg('SHORT', 1, 100.3, 'POSITION_OPEN') ];
  const snapshot = JSON.parse(JSON.stringify(legs));
  planCrossingActions({ prevPrice: 100.2, currentPrice: 100.35, legs, vwapLong: null, vwapShort: null });
  assert.deepEqual(JSON.parse(JSON.stringify(legs)), snapshot);
});
