import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE,
  LADDER_STEP_PCT_MIN, LADDER_STEP_PCT_MAX,
  LADDER_LEVELS_MIN, LADDER_LEVELS_MAX,
  MIN_LEG_USDT, minInitialSizeUSDT,
  resolveLadderGeometry,
} from '../ladder-levels.js';

test('defaults are the spec values', () => {
  assert.equal(LADDER_STEP_PCT, 0.003);
  assert.equal(LADDER_LEVELS_PER_SIDE, 5);
});

test('geometry bounds are the spec values', () => {
  assert.equal(LADDER_STEP_PCT_MIN, 0.003);
  assert.equal(LADDER_STEP_PCT_MAX, 0.02);
  assert.equal(LADDER_LEVELS_MIN, 3);
  assert.equal(LADDER_LEVELS_MAX, 10);
});

test('minInitialSizeUSDT scales with the level count', () => {
  assert.equal(MIN_LEG_USDT, 10);
  assert.equal(minInitialSizeUSDT(5), 50);  // identical to the old flat minimum
  assert.equal(minInitialSizeUSDT(3), 30);
  assert.equal(minInitialSizeUSDT(10), 100);
});

// ——— resolveLadderGeometry: the SINGLE gate app.js's route and start() ———
// ——— both validate through (Finding 1, task-2 review) ————————————————
//
// STRICT, not coercing: a numeric string is not a number, and unknown input
// must read as invalid, never as safe. This is what the route used to get
// wrong via `Number(...)` coercion while start() used strict
// Number.isFinite/Number.isInteger checks on the raw value — the two gates
// disagreed on four input classes, letting a caller get a 200 response
// followed by an invisible async start() failure.

test('resolveLadderGeometry: defaults both fields when absent', () => {
  const r = resolveLadderGeometry({});
  assert.equal(r.ok, true);
  assert.equal(r.stepPct, LADDER_STEP_PCT);
  assert.equal(r.levelsPerSide, LADDER_LEVELS_PER_SIDE);

  // Also with no argument at all.
  const r2 = resolveLadderGeometry();
  assert.equal(r2.ok, true);
  assert.equal(r2.stepPct, LADDER_STEP_PCT);
  assert.equal(r2.levelsPerSide, LADDER_LEVELS_PER_SIDE);
});

test('resolveLadderGeometry: accepts the boundary values 0.003 / 0.02 / 3 / 10', () => {
  const low = resolveLadderGeometry({ ladderStepPct: 0.003, ladderLevelsPerSide: 3 });
  assert.equal(low.ok, true);
  assert.equal(low.stepPct, 0.003);
  assert.equal(low.levelsPerSide, 3);

  const high = resolveLadderGeometry({ ladderStepPct: 0.02, ladderLevelsPerSide: 10 });
  assert.equal(high.ok, true);
  assert.equal(high.stepPct, 0.02);
  assert.equal(high.levelsPerSide, 10);
});

test('resolveLadderGeometry: rejects just outside the boundary — 0.0029 / 0.0201 / 2 / 11', () => {
  assert.equal(resolveLadderGeometry({ ladderStepPct: 0.0029 }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderStepPct: 0.0201 }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderLevelsPerSide: 2 }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderLevelsPerSide: 11 }).ok, false);
});

test('resolveLadderGeometry: rejects numeric STRINGS — "0.005" and "8" are not numbers', () => {
  const r1 = resolveLadderGeometry({ ladderStepPct: '0.005' });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'LADDER_STEP_OUT_OF_BOUNDS');

  const r2 = resolveLadderGeometry({ ladderLevelsPerSide: '8' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'LADDER_LEVELS_OUT_OF_BOUNDS');

  const r3 = resolveLadderGeometry({ ladderStepPct: '0.005', ladderLevelsPerSide: '8' });
  assert.equal(r3.ok, false);
});

test('resolveLadderGeometry: rejects an array — [8] is not a number', () => {
  const r = resolveLadderGeometry({ ladderLevelsPerSide: [8] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LADDER_LEVELS_OUT_OF_BOUNDS');
});

test('resolveLadderGeometry: rejects a non-integer level count — 5.5', () => {
  const r = resolveLadderGeometry({ ladderLevelsPerSide: 5.5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LADDER_LEVELS_OUT_OF_BOUNDS');
});

test('resolveLadderGeometry: rejects NaN', () => {
  assert.equal(resolveLadderGeometry({ ladderStepPct: NaN }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderLevelsPerSide: NaN }).ok, false);
});

test('resolveLadderGeometry: rejects 0 — not treated as "absent"', () => {
  // 0 is falsy but NOT null/undefined, so the ?? default must NOT kick in;
  // 0 is out of bounds for both fields and must be rejected, not defaulted.
  assert.equal(resolveLadderGeometry({ ladderStepPct: 0 }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderLevelsPerSide: 0 }).ok, false);
});

test('resolveLadderGeometry: only null/undefined default — other falsy values are rejected, not defaulted', () => {
  assert.equal(resolveLadderGeometry({ ladderStepPct: '' }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderStepPct: false }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderLevelsPerSide: '' }).ok, false);
  assert.equal(resolveLadderGeometry({ ladderLevelsPerSide: false }).ok, false);

  // null and undefined ARE treated as absent and DO default.
  assert.equal(resolveLadderGeometry({ ladderStepPct: null }).ok, true);
  assert.equal(resolveLadderGeometry({ ladderStepPct: undefined }).ok, true);
});

test('resolveLadderGeometry: error results carry a code and a human-readable message', () => {
  const r = resolveLadderGeometry({ ladderStepPct: 0.03 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LADDER_STEP_OUT_OF_BOUNDS');
  assert.match(r.error, /step/i);

  const r2 = resolveLadderGeometry({ ladderLevelsPerSide: 11 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'LADDER_LEVELS_OUT_OF_BOUNDS');
  assert.match(r2.error, /whole number between 3 and 10/);
});

// REGRESSION PIN for task-2's review Finding 1: app.js's route and
// ReversalLadderStrategy.start() both call this exact function now, so there is
// only one place a verdict can be computed — but pin the verdicts anyway so a
// future edit that reintroduces `Number(...)` coercion at either call site
// (instead of routing through here) gets caught by a table, not by a live
// 200-then-silent-failure. Every row is a case that DIVERGED before this fix:
// the route (via `Number(...)`) said ACCEPT, start() (strict) said REJECT.
test('resolveLadderGeometry: regression pin — inputs that used to diverge between the route and start() are now uniformly rejected', () => {
  const divergentInputs = [
    { ladderStepPct: '0.005' },                                  // numeric string step
    { ladderLevelsPerSide: '8' },                                // numeric string levels
    { ladderStepPct: '0.005', ladderLevelsPerSide: '8' },        // both as strings
    { ladderLevelsPerSide: [8] },                                // array levels
  ];
  for (const input of divergentInputs) {
    const verdict = resolveLadderGeometry(input);
    assert.equal(verdict.ok, false, `${JSON.stringify(input)} must be rejected — it is exactly the class that let a 200 be followed by a silent async start() failure`);
    // Calling it again (simulating the second call site) must yield the
    // identical verdict — there is no room for the two gates to disagree
    // when they share one pure function.
    const verdictAgain = resolveLadderGeometry(input);
    assert.deepEqual(verdict, verdictAgain, 'the verdict must be identical regardless of which caller invokes it');
  }
});
