// Pure ladder geometry. No I/O.
//
// Replaces grid-levels.js's VP-derived geometry (computeGridSetup /
// pickBoundaryLVNs), which is deleted in Task 11. The ladder is anchored on the
// LIVE mark price with a fixed step — nothing here is volume-profile derived.

// The anchor->level spacing. 0.3% clears the round-trip fee floor
// (max(0.0025, FEE_RATE*3) = 0.25%) with headroom.
export const LADDER_STEP_PCT = 0.003;

// Fixed. Anchor -> outermost = 5 * 0.3% = 1.5%; L5 -> S5 span = 3%.
export const LADDER_LEVELS_PER_SIDE = 5;

// Each leg is initialSize / 5, so 50 USDT gives 10 USDT legs — clear of the
// typical 5 USDT minNotional. Below this a strategy is rejected outright rather
// than silently running a thinner ladder.
export const MIN_INITIAL_SIZE_USDT = 50;

/**
 * Build the ladder as EMPTY legs around a fixed anchor.
 *
 * THE INVERSION: LONG levels sit ABOVE the anchor and SHORT levels BELOW —
 * the opposite of the old mean-reversion grid. This is what makes one-way
 * position mode viable: price is either above the anchor or below it, so only
 * one side can ever hold inventory. Do not "fix" this to match the old grid.
 */
export function buildLadder(anchor, stepPct = LADDER_STEP_PCT, levelsPerSide = LADDER_LEVELS_PER_SIDE) {
  if (!Number.isFinite(anchor) || anchor <= 0) {
    throw new Error(`buildLadder: anchor must be a positive finite number (got ${anchor})`);
  }
  const step = stepPct * anchor;
  const legs = [];
  // k starts at 1 — the anchor itself is never a level; it is the FLATTEN price.
  for (let k = 1; k <= levelsPerSide; k++) {
    legs.push({ levelIndex: k, direction: 'LONG',  price: anchor + k * step, state: 'EMPTY', quantity: null, fillPrice: null });
    legs.push({ levelIndex: k, direction: 'SHORT', price: anchor - k * step, state: 'EMPTY', quantity: null, fillPrice: null });
  }
  return legs;
}
