// The entry rule for the breakout strategy. Pure: no I/O, no state, nothing
// mutated. The strategy applies the returned decision; this module only makes it.
//
// ENTRY ONLY. The exits — a trail hit and the Final TP — are threshold
// comparisons against a single price and need no band logic, so they stay in
// the strategy where the position lives.
//
// Replaces planReversalActions. There are no rungs to fill, no scaling, and no
// reversal: a close leaves the strategy FLAT, and the opposite side opens only
// if price later reaches the opposite entry level.

const between = (v, a, b) => (a <= b ? v >= a && v <= b : v >= b && v <= a);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Decide whether this price move opens a position.
 *
 * @param {object} input
 * @param {number|null} input.prevPrice      last processed price; null on the first tick
 * @param {number} input.currentPrice
 * @param {number} input.bullBreakout        a LONG opens at or above this
 * @param {number} input.bearBreakout        a SHORT opens at or below this
 * @param {'LONG'|'SHORT'|null} input.heldSide
 * @param {'LONG'|'SHORT'|null} input.pendingEntry  gap latch set by the previous tick's close
 * @returns {{open: 'LONG'|'SHORT'|null, clearPending: boolean}}
 */
export function planBreakoutEntry({
  prevPrice,
  currentPrice,
  bullBreakout,
  bearBreakout,
  heldSide = null,
  pendingEntry = null,
} = {}) {
  const none = { open: null, clearPending: false };

  if (!finite(currentPrice)) return none;
  if (!finite(bullBreakout) || !finite(bearBreakout)) return none;

  // A held position blocks everything, including a pending entry. Clearing the
  // latch here would be wrong: `heldSide` non-null while a latch is set means
  // the close that set it did not actually leave us flat, and dropping the
  // latch would silently forget the intent.
  if (heldSide != null) return none;

  // The gap latch, resolved on the tick AFTER the close that set it. No
  // crossing is required — price is already beyond the level and will not cross
  // it again from the outside. Either way the latch is consumed: it is a
  // one-shot, and a latch that survived a tick where price returned inside the
  // band would fire on stale intent.
  if (pendingEntry === 'LONG')  return { open: currentPrice >= bullBreakout ? 'LONG' : null, clearPending: true };
  if (pendingEntry === 'SHORT') return { open: currentPrice <= bearBreakout ? 'SHORT' : null, clearPending: true };

  if (!finite(prevPrice)) return none;             // first tick: no band
  if (currentPrice === prevPrice) return none;

  // A crossing AND the landing side. The second half is load-bearing: a trailed
  // exit can close a LONG with price ABOVE bullBreakout, and price falling back
  // THROUGH bullBreakout is a crossing that must not open a LONG.
  //
  // The two branches are mutually exclusive (bullBreakout > bearBreakout), so a
  // band spanning both levels resolves to whichever side price landed on.
  if (between(bullBreakout, prevPrice, currentPrice) && currentPrice >= bullBreakout) {
    return { open: 'LONG', clearPending: false };
  }
  if (between(bearBreakout, prevPrice, currentPrice) && currentPrice <= bearBreakout) {
    return { open: 'SHORT', clearPending: false };
  }

  return none;
}
