// Trailing exit for the breakout strategy. Pure.
//
// The trail and the near-level stop are ONE mechanism. The level starts exactly
// at the exit level (bullLevel for a LONG) and ratchets away from it as price
// runs. With trailing disarmed the strategy simply never ratchets it, so it
// stays pinned there and behaves as a plain stop.
//
// Unlike the ladder version, the trail is NOT capped at the entry level. That
// cap existed because closing above the bull level would leave price inside the
// LONG rungs and immediately refill the position just closed — there are no
// rungs now, so the trail can ratchet past the entry and lock a real profit.

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Fixed once, at entry: the gap from the entry level to the exit level. Equal
 * to breakoutPct of the exit level by construction, but derived from the two
 * ACTUAL levels so the trail starts exactly on the exit level after tick-size
 * rounding rather than a hair off it.
 *
 * Parameter-free, so it needs no tuning knob and self-scales across symbols.
 *
 * @param {'LONG'|'SHORT'} side
 * @param {{bullLevel: number, bearLevel: number, bullBreakout: number, bearBreakout: number}} levels
 * @returns {number|null}
 */
export function trailDistance(side, levels) {
  if (!levels) return null;
  const { bullLevel, bearLevel, bullBreakout, bearBreakout } = levels;
  if (side === 'LONG') {
    if (!finite(bullLevel) || !finite(bullBreakout)) return null;
    const d = bullBreakout - bullLevel;
    return d > 0 ? d : null;
  }
  if (side === 'SHORT') {
    if (!finite(bearLevel) || !finite(bearBreakout)) return null;
    const d = bearLevel - bearBreakout;
    return d > 0 ? d : null;
  }
  return null;
}

/**
 * The current exit level. Ratchets away from the exit level only — `previous`
 * is the last value and is never given back.
 *
 * Floored (LONG) / ceilinged (SHORT) at the exit level so the very first call
 * lands exactly there even with no `previous`, and so a stale value restored
 * from a snapshot taken before a level edit is pulled back into range instead
 * of being preserved forever. There is deliberately NO bound on the profitable
 * side.
 */
export function trailExitLevel({ price, distance, side, bullLevel, bearLevel, previous = null } = {}) {
  if (!finite(price) || !finite(distance)) return null;
  if (side !== 'LONG' && side !== 'SHORT') return null;

  const floor = side === 'LONG' ? bullLevel : bearLevel;
  if (!finite(floor)) return null;

  const raw = side === 'LONG' ? price - distance : price + distance;
  const clamped = side === 'LONG' ? Math.max(floor, raw) : Math.min(floor, raw);

  if (!finite(previous)) return clamped;
  const clampedPrevious = side === 'LONG' ? Math.max(floor, previous) : Math.min(floor, previous);
  // One-way ratchet: LONG only ever rises, SHORT only ever falls.
  return side === 'LONG' ? Math.max(clampedPrevious, clamped) : Math.min(clampedPrevious, clamped);
}
