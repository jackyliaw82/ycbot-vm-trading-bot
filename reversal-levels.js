import {
  LADDER_STEP_PCT,
  LADDER_STEP_PCT_MIN,
  LADDER_STEP_PCT_MAX,
  LADDER_LEVELS_PER_SIDE,
  LADDER_LEVELS_MIN,
  LADDER_LEVELS_MAX,
} from './ladder-levels.js';

// Geometry for ReversalLadder. Unlike the anchor ladder, there is no single
// centre: two independent levels each anchor their own one-sided ladder, and
// the gap between them is the dead zone the position is held across.
//
// The step floor, ceiling and level bounds are IMPORTED rather than restated —
// they are one policy (the 0.3% floor clears the round-trip fee floor), and a
// second copy would drift from the first the moment either is tuned.

/** The rung whose fill arms TREND. */
export function outermostIndex(levelsPerSide) {
  return levelsPerSide;
}

/**
 * Build both ladders.
 *
 *   L1 = bullLevel,  Lk = bullLevel × (1 + step×(k−1))     — at and ABOVE bull
 *   S1 = bearLevel,  Sk = bearLevel × (1 − step×(k−1))     — at and BELOW bear
 *
 * The trigger level IS the first rung. Nothing is ever placed between the two
 * levels: that gap is the dead zone, and a rung inside it would reintroduce the
 * churn this design exists to remove.
 */
export function buildReversalLadder(
  bullLevel,
  bearLevel,
  stepPct = LADDER_STEP_PCT,
  levelsPerSide = LADDER_LEVELS_PER_SIDE,
) {
  if (!isPosFinite(bullLevel)) throw new Error(`bullLevel must be a positive finite level, got ${bullLevel}`);
  if (!isPosFinite(bearLevel)) throw new Error(`bearLevel must be a positive finite level, got ${bearLevel}`);
  if (bullLevel <= bearLevel) {
    throw new Error(`bullLevel (${bullLevel}) must be strictly above bearLevel (${bearLevel})`);
  }
  if (!Number.isFinite(stepPct) || stepPct < LADDER_STEP_PCT_MIN || stepPct > LADDER_STEP_PCT_MAX) {
    throw new Error(`step ${stepPct} outside [${LADDER_STEP_PCT_MIN}, ${LADDER_STEP_PCT_MAX}]`);
  }
  if (!Number.isInteger(levelsPerSide) || levelsPerSide < LADDER_LEVELS_MIN || levelsPerSide > LADDER_LEVELS_MAX) {
    throw new Error(`levelsPerSide ${levelsPerSide} outside [${LADDER_LEVELS_MIN}, ${LADDER_LEVELS_MAX}]`);
  }

  const legs = [];
  for (let k = 1; k <= levelsPerSide; k++) {
    legs.push({ direction: 'LONG', index: k, price: bullLevel * (1 + stepPct * (k - 1)), state: 'EMPTY' });
  }
  for (let k = 1; k <= levelsPerSide; k++) {
    legs.push({ direction: 'SHORT', index: k, price: bearLevel * (1 - stepPct * (k - 1)), state: 'EMPTY' });
  }
  return legs;
}

const isPosFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
