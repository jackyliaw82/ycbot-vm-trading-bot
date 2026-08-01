// Trailing exit for ReversalLadder's TREND mode. Pure.
//
// The level starts at the OPPOSITE level and walks toward the entry level as
// price runs, capped there. That cap is deliberate and has a consequence worth
// stating plainly: trailing can never lock in a profit. Its best outcome is
// roughly the entry level, which on a fully-scaled ladder is a small loss
// against the average entry. It is a give-back limiter, not a profit lock —
// profit comes only from Final TP, and profit PROTECTION from Close & stop.
//
// The cap is also what keeps the exit out of the ladder: closing above the bull
// level would leave price inside the LONG rungs, which would immediately refill
// the position just closed.

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Fixed once, when TREND arms: the gap from the arming price to the opposite
 * level. Parameter-free by construction — the trail therefore begins exactly at
 * the opposite level and moves 1:1 with price, so it needs no tuning knob and
 * self-scales across symbols.
 */
export function trailDistance(trendStartPrice, side, bullLevel, bearLevel) {
  if (!finite(trendStartPrice) || !finite(bullLevel) || !finite(bearLevel)) return null;
  if (side === 'LONG') return trendStartPrice - bearLevel;
  if (side === 'SHORT') return bullLevel - trendStartPrice;
  return null;
}

/**
 * The current exit level. Ratchets toward the entry level only — `previous` is
 * the last value and is never given back.
 */
export function trailExitLevel({ price, distance, side, bullLevel, bearLevel, previous = null } = {}) {
  if (!finite(price) || !finite(distance) || !finite(bullLevel) || !finite(bearLevel)) return null;
  if (side !== 'LONG' && side !== 'SHORT') return null;

  const raw = side === 'LONG' ? price - distance : price + distance;
  const clamped = Math.min(bullLevel, Math.max(bearLevel, raw));

  if (!finite(previous)) return clamped;
  // One-way ratchet: LONG only ever rises, SHORT only ever falls.
  return side === 'LONG' ? Math.max(previous, clamped) : Math.min(previous, clamped);
}
