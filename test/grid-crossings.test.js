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
