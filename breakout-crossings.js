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

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Decide whether this price move opens a position.
 *
 * `input` itself is nullable, not just its fields — `{x} = {}` only applies
 * its default for `undefined`, and an explicit `null` would still throw
 * destructuring it. `input ?? {}` covers both.
 *
 * @param {object|null} [input]
 * @param {number|null} input.prevPrice      last processed price; null on the first tick
 * @param {number} input.currentPrice
 * @param {number} input.bullBreakout        a LONG opens at or above this
 * @param {number} input.bearBreakout        a SHORT opens at or below this
 * @param {'LONG'|'SHORT'|null} input.heldSide
 * @param {'LONG'|'SHORT'|null} input.pendingEntry  gap latch set by the previous tick's close
 * @returns {{open: 'LONG'|'SHORT'|null, clearPending: boolean}}
 */
export function planBreakoutEntry(input) {
  const {
    prevPrice,
    currentPrice,
    bullBreakout,
    bearBreakout,
    heldSide = null,
    pendingEntry = null,
  } = input ?? {};
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

  // A DIRECTIONAL crossing: price was strictly on the inside and ended on or
  // beyond the level. Both halves are load-bearing: while FLAT, price can
  // legitimately sit beyond an entry level — a harvest closes at an arbitrary
  // live price and the re-plan lands a tick or more later — and price falling
  // back onto that level must not open a position.
  //
  // Do NOT express this with a symmetric `between(level, prev, current)` test.
  // An endpoint is always "between" its own bounds, so `between` returns true
  // for ANY prevPrice when currentPrice lands exactly ON the level — and mark
  // prices are tick-rounded, so exact equality is a real input, not a corner
  // case. A fall from 200 to exactly 101.5 would open a LONG.
  //
  // The two branches are mutually exclusive (bullBreakout > bearBreakout), so a
  // band spanning both levels resolves to whichever side price landed on.
  if (prevPrice < bullBreakout && currentPrice >= bullBreakout) {
    return { open: 'LONG', clearPending: false };
  }
  if (prevPrice > bearBreakout && currentPrice <= bearBreakout) {
    return { open: 'SHORT', clearPending: false };
  }

  return none;
}
