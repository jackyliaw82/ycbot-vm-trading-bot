import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReversalLadder, outermostIndex } from '../reversal-levels.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('buildReversalLadder: L1 IS the bull level and S1 IS the bear level', () => {
  const legs = buildReversalLadder(104000, 100000, 0.003, 5);
  const l1 = legs.find(l => l.direction === 'LONG' && l.index === 1);
  const s1 = legs.find(l => l.direction === 'SHORT' && l.index === 1);
  assert.equal(l1.price, 104000);
  assert.equal(s1.price, 100000);
});

test('buildReversalLadder: LONG rungs ascend above bull, SHORT descend below bear', () => {
  const legs = buildReversalLadder(104000, 100000, 0.003, 5);
  const longs = legs.filter(l => l.direction === 'LONG');
  const shorts = legs.filter(l => l.direction === 'SHORT');
  assert.equal(longs.length, 5);
  assert.equal(shorts.length, 5);
  assert.ok(near(longs[1].price, 104000 * 1.003));
  assert.ok(near(longs[4].price, 104000 * 1.012));
  assert.ok(near(shorts[1].price, 100000 * 0.997));
  assert.ok(near(shorts[4].price, 100000 * 0.988));
  for (let i = 1; i < 5; i++) {
    assert.ok(longs[i].price > longs[i - 1].price, 'LONG must ascend');
    assert.ok(shorts[i].price < shorts[i - 1].price, 'SHORT must descend');
  }
});

test('buildReversalLadder: every leg starts EMPTY and carries its index', () => {
  const legs = buildReversalLadder(104000, 100000, 0.003, 5);
  assert.equal(legs.length, 10);
  assert.ok(legs.every(l => l.state === 'EMPTY'));
  assert.deepEqual(legs.filter(l => l.direction === 'LONG').map(l => l.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(legs.filter(l => l.direction === 'SHORT').map(l => l.index), [1, 2, 3, 4, 5]);
});

test('buildReversalLadder: no rung ever lands inside the dead zone', () => {
  const legs = buildReversalLadder(104000, 100000, 0.003, 5);
  for (const l of legs) {
    if (l.direction === 'LONG') assert.ok(l.price >= 104000, `LONG ${l.price} below bull`);
    else assert.ok(l.price <= 100000, `SHORT ${l.price} above bear`);
  }
});

test('buildReversalLadder: honours a different level count', () => {
  const legs = buildReversalLadder(104000, 100000, 0.003, 3);
  assert.equal(legs.length, 6);
  assert.equal(outermostIndex(3), 3);
});

test('buildReversalLadder: rejects an inverted or equal level pair', () => {
  assert.throws(() => buildReversalLadder(100000, 104000, 0.003, 5), /bull/i);
  assert.throws(() => buildReversalLadder(100000, 100000, 0.003, 5), /bull/i);
});

test('buildReversalLadder: rejects non-finite or non-positive levels', () => {
  for (const [bull, bear] of [[NaN, 100], [104, NaN], [0, -1], [-104, -100], [Infinity, 100]]) {
    assert.throws(() => buildReversalLadder(bull, bear, 0.003, 5), /level/i);
  }
});

test('buildReversalLadder: rejects a step outside the shared bounds', () => {
  assert.throws(() => buildReversalLadder(104000, 100000, 0.001, 5), /step/i);
  assert.throws(() => buildReversalLadder(104000, 100000, 0.05, 5), /step/i);
});

test('buildReversalLadder: rejects a level count outside the shared bounds', () => {
  assert.throws(() => buildReversalLadder(104000, 100000, 0.003, 2), /level/i);
  assert.throws(() => buildReversalLadder(104000, 100000, 0.003, 11), /level/i);
});

test('outermostIndex: is the last rung, which is what arms TREND', () => {
  assert.equal(outermostIndex(5), 5);
  assert.equal(outermostIndex(10), 10);
});
