import { outermostIndex } from './reversal-levels.js';

// Tick rules for ReversalLadder. Pure: no I/O, no state, nothing mutated.
// The strategy applies the returned plan; this module only decides it.
//
// Two levels and a dead zone between them. A position is opened at a level,
// held across the whole dead zone, and only ever changed at the OTHER level.
// That is the entire anti-churn mechanism, so every rule below exists to keep
// the dead zone inert.

const between = (v, a, b) => (a <= b ? v >= a && v <= b : v >= b && v <= a);

/**
 * Decide what a single price move does.
 *
 * Returns { reverse, side, fills, enterTrend } where `reverse: true` means the
 * caller must close the whole position and reset the ABANDONED side's legs to
 * EMPTY before applying `fills`.
 */
export function planReversalActions({
  prevPrice,
  currentPrice,
  bullLevel,
  bearLevel,
  legs,
  heldSide = null,
  levelsPerSide,
} = {}) {
  const none = { reverse: false, side: null, fills: [], enterTrend: false };

  if (prevPrice == null || !Number.isFinite(prevPrice)) return none;      // first tick: no band
  if (!Number.isFinite(currentPrice) || currentPrice === prevPrice) return none;
  if (!Number.isFinite(bullLevel) || !Number.isFinite(bearLevel)) return none;
  if (!Array.isArray(legs)) return none;

  const crossedBull = between(bullLevel, prevPrice, currentPrice);
  const crossedBear = between(bearLevel, prevPrice, currentPrice);

  // Which ladder is this move about?
  let side;
  if (crossedBull && crossedBear) {
    // RULE 0 — the band straddles both levels (a gap). Act ONLY on the side we
    // landed on and ignore the level we passed through. Without this, a
    // reversal resets the abandoned ladder and this same band immediately
    // re-fills it — reopening the position that was just closed, at prices the
    // ledger would record as the rung's, not the fill's.
    side = currentPrice >= bullLevel ? 'LONG' : 'SHORT';
  } else if (crossedBull || crossedBear) {
    side = crossedBull ? 'LONG' : 'SHORT';
  } else {
    // No level crossed. Inside the dead zone nothing happens; outside it, this
    // is RULE 3 scaling on the side already held.
    if (!heldSide) return none;
    side = heldSide;
  }

  // RULE 2 — the crossed level belongs to the OTHER ladder while a position is
  // open. Note this is asymmetric with the anchor flatten it replaces: a
  // reversal opens immediately, on the same tick, rather than waiting one.
  const reverse = heldSide != null && heldSide !== side;

  // RULE 1 / 3 — every empty rung of `side` inside the band, innermost first so
  // the fill order matches the path price actually took. After a reversal the
  // caller resets the abandoned side, never this one, so its EMPTY state is
  // already correct here.
  const fills = legs
    .filter(l => l && l.direction === side && l.state === 'EMPTY' && Number.isFinite(l.price)
      && between(l.price, prevPrice, currentPrice))
    .sort((a, b) => a.index - b.index);

  const outermost = outermostIndex(levelsPerSide);
  const enterTrend = fills.some(l => l.index === outermost);

  return { reverse, side, fills, enterTrend };
}
