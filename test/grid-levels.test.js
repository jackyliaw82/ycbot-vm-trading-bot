import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBoundaryLVNs, computeGridSetup } from '../grid-levels.js';

const lvns = [
  { priceLow: 96, priceHigh: 97, volume: 10 },   // below VAL
  { priceLow: 103, priceHigh: 104, volume: 8 },   // above VAH
  { priceLow: 90, priceHigh: 91, volume: 5 },     // farther below
];

test('pickBoundaryLVNs picks nearest LVN above VAH and below VAL', () => {
  const { upperLVN, lowerLVN } = pickBoundaryLVNs(lvns, 102, 98);
  assert.equal(upperLVN, 103.5); // midpoint of {103,104}
  assert.equal(lowerLVN, 96.5);  // midpoint of nearest-below {96,97}
});

test('computeGridSetup: adequate value area keeps VAH/VAL boundaries', () => {
  // VAH-VAL = 4 on anchor 100 => width 4%, N=5 => step 0.4% >= 0.25% floor
  const r = computeGridSetup({ vah: 102, val: 98, lvns, currentPrice: 100,
    gridLevelsPerSide: 5, minStepPct: 0.0025, maxWidthPct: 0.05 });
  assert.equal(r.viable, true);
  assert.equal(r.anchor, 100);
  assert.equal(r.upperBoundary, 102);
  assert.equal(r.lowerBoundary, 98);
  assert.equal(r.gridLines.length, 10);
  const outerShort = r.gridLines.find(l => l.direction === 'SHORT' && l.levelIndex === 5);
  assert.equal(outerShort.price, 102); // outermost short at VAH
  assert.equal(outerShort.state, 'EMPTY');
});

test('computeGridSetup: narrow value area widens toward LVNs', () => {
  // VAH-VAL = 0.4 on anchor 100 => width 0.4%, N=5 => step 0.04% < 0.25% floor -> widen
  const r = computeGridSetup({ vah: 100.2, val: 99.8, lvns, currentPrice: 100,
    gridLevelsPerSide: 5, minStepPct: 0.0025, maxWidthPct: 0.05 });
  assert.equal(r.viable, true);
  assert.equal(r.anchor, 100);
  // needs half-width >= N*minStepPct*anchor = 5*0.0025*100 = 1.25 -> boundaries 101.25 / 98.75,
  // capped by nearer LVN half-distance min(103.5-100, 100-96.5)=3.5 and maxWidth 5 -> 1.25 wins
  assert.ok(Math.abs(r.upperBoundary - 101.25) < 1e-9);
  assert.ok(Math.abs(r.lowerBoundary - 98.75) < 1e-9);
  assert.ok(r.stepPct >= 0.0025 - 1e-9);
});

test('computeGridSetup: LVNs too tight -> not viable', () => {
  const tight = [
    { priceLow: 100.25, priceHigh: 100.3, volume: 5 }, // upperLVN mid 100.275
    { priceLow: 99.7, priceHigh: 99.75, volume: 5 },   // lowerLVN mid 99.725
  ];
  const r = computeGridSetup({ vah: 100.1, val: 99.9, lvns: tight, currentPrice: 100,
    gridLevelsPerSide: 5, minStepPct: 0.0025, maxWidthPct: 0.05 });
  // max symmetric half-width capped at nearer LVN ~0.275 => step ~0.055% < 0.25% floor
  assert.equal(r.viable, false);
});

test('computeGridSetup: naturally-wide value area is NOT shrunk by maxWidthPct', () => {
  const wideLvns = [
    { priceLow: 113, priceHigh: 114, volume: 8 }, // above VAH 110
    { priceLow: 86, priceHigh: 87, volume: 8 },   // below VAL 90
  ];
  const r = computeGridSetup({ vah: 110, val: 90, lvns: wideLvns, currentPrice: 100,
    gridLevelsPerSide: 5, minStepPct: 0.0025, maxWidthPct: 0.05 });
  // h0 = 10; even though maxWidthPct*anchor = 5, the adequate VA must be kept
  assert.equal(r.viable, true);
  assert.equal(r.anchor, 100);
  assert.equal(r.upperBoundary, 110);
  assert.equal(r.lowerBoundary, 90);
});

test('computeGridSetup: current price outside the grid -> not viable', () => {
  const lv = [
    { priceLow: 103, priceHigh: 104, volume: 8 },
    { priceLow: 96, priceHigh: 97, volume: 8 },
  ];
  const r = computeGridSetup({ vah: 102, val: 98, lvns: lv, currentPrice: 105,
    gridLevelsPerSide: 5, minStepPct: 0.0025, maxWidthPct: 0.05 });
  assert.equal(r.priceInside, false);
  assert.equal(r.viable, false);
});
