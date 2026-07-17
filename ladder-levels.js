// Pure ladder geometry. No I/O.
//
// Replaces grid-levels.js's VP-derived geometry (computeGridSetup /
// pickBoundaryLVNs), which is deleted in Task 11. The ladder is anchored on the
// LIVE mark price with a fixed step — nothing here is volume-profile derived.

// DEFAULT anchor->level spacing, and the HARD FLOOR for the user-configurable
// `ladderStepPct`. 0.3% clears the round-trip fee floor
// (max(0.0025, FEE_RATE*3) = 0.25%) with headroom. BELOW the floor every
// anchor-flatten round trip loses to fees BY CONSTRUCTION, so start() refuses
// rather than running a structurally lossy ladder — this is a reject, not a warning.
export const LADDER_STEP_PCT = 0.003;
export const LADDER_STEP_PCT_MIN = 0.003;
// Ceiling: at 10 levels a 2% step puts the outermost 20% from the anchor —
// unreachable in a session, so the cycle would never arm a Final TP.
export const LADDER_STEP_PCT_MAX = 0.02;

// DEFAULT levels per side. Anchor -> outermost = levelsPerSide * stepPct
// (default 5 * 0.3% = 1.5%; L5 -> S5 span = 3%). Filling the OUTERMOST leg is
// what flips the cycle to TREND, so this sets how far price must travel to arm
// a Final TP.
export const LADDER_LEVELS_PER_SIDE = 5;
// 2 is barely a ladder and trips TREND almost immediately; 10 caps the required
// minimum initial size at 100 USDT.
export const LADDER_LEVELS_MIN = 3;
export const LADDER_LEVELS_MAX = 10;

// The real rule: every leg is initialSize / levelsPerSide, and each leg must
// clear the typical 5 USDT minNotional with headroom. So the minimum initial
// size SCALES with the level count — at the default 5 levels this is 50 USDT,
// exactly the old flat minimum. Below it a strategy is rejected outright rather
// than silently running a thinner ladder.
export const MIN_LEG_USDT = 10;
export const minInitialSizeUSDT = (levelsPerSide) => levelsPerSide * MIN_LEG_USDT;

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
