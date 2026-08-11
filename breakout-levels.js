// Pure geometry for the breakout strategy. No I/O.
//
// Replaces ladder-levels.js (rung spacing, level counts, minimum sizing) and
// reversal-levels.js (buildReversalLadder). There are no rungs: a cycle has
// exactly two entry levels, each a fixed percentage beyond an AI-planned level.

// DEFAULT distance from bullLevel/bearLevel to the entry level.
//
// The FLOOR is 0.3%: below it the open/close round trip does not clear the fee
// floor (max(0.0025, FEE_RATE*3) = 0.25%) with any headroom, so shallow churn
// around the level is structurally lossy.
//
// The CEILING is 3%: `breakoutPct` is the stop distance, so a failed attempt
// costs breakoutPct x position size. Combined with the recovery multiplier
// (recoveryFactor/recoveryDistance = 40x notional per USDT of accumulated loss)
// a 3% stop fills the 8% harvest gauge in two failed attempts.
export const BREAKOUT_PCT = 0.01;
export const BREAKOUT_PCT_MIN = 0.003;
export const BREAKOUT_PCT_MAX = 0.03;

/**
 * The SINGLE definition of valid breakout geometry. Both the HTTP route
 * (app.js, which answers synchronously) and start() (which runs after the 200
 * has gone out) validate through this. Two copies of this rule drifted within
 * one task last time, and an input the route accepts but start() rejects is a
 * 200 followed by an invisible async failure.
 *
 * STRICT, not coercing: a numeric string is NOT a number. The `?? DEFAULT`
 * fallback applies ONLY to null/undefined (field genuinely absent). 0, NaN, '',
 * false, [0.01] are NOT absent — they fall through to validation and are
 * REJECTED, never silently defaulted. Unknown input must read as invalid.
 *
 * Pure: no I/O, throws nothing, always returns a result object.
 *
 * `input` itself is nullable, not just its fields — `{x} = {}` only applies
 * its default for `undefined`, and an explicit `null` (a plausible "no config
 * object" call) would still throw destructuring it. `input ?? {}` covers both.
 *
 * @param {{breakoutPct?: unknown}|null} [input]
 * @returns {{ok: true, breakoutPct: number} | {ok: false, code: string, error: string}}
 */
export function resolveBreakoutGeometry(input) {
  const { breakoutPct } = input ?? {};
  const pct = breakoutPct ?? BREAKOUT_PCT;

  if (typeof pct !== 'number' || !Number.isFinite(pct)
      || pct < BREAKOUT_PCT_MIN || pct > BREAKOUT_PCT_MAX) {
    return {
      ok: false,
      code: 'BREAKOUT_PCT_OUT_OF_BOUNDS',
      error:
        `Breakout distance (${typeof pct === 'number' && Number.isFinite(pct) ? (pct * 100).toFixed(2) + '%' : String(pct)}) must be a number between ` +
        `${(BREAKOUT_PCT_MIN * 100).toFixed(2)}% and ${(BREAKOUT_PCT_MAX * 100).toFixed(2)}%. ` +
        `Below ${(BREAKOUT_PCT_MIN * 100).toFixed(2)}% the open/close round trip does not clear fees; ` +
        `above ${(BREAKOUT_PCT_MAX * 100).toFixed(2)}% a single failed attempt fills the harvest gauge.`,
    };
  }
  return { ok: true, breakoutPct: pct };
}

/**
 * The two entry levels, derived from the AI-planned pair.
 *
 *   bullBreakout = bullLevel x (1 + breakoutPct)   — a LONG opens here
 *   bearBreakout = bearLevel x (1 - breakoutPct)   — a SHORT opens here
 *
 * bullLevel/bearLevel remain where the position CLOSES.
 *
 * THROWS rather than returning null: a caller that received a nonsense level
 * and carried on would place an order at an arbitrary price. Same contract as
 * the deleted buildReversalLadder.
 *
 * Returns RAW levels. Tick-size rounding belongs to the caller, which is the
 * only thing that knows the symbol's exchange info.
 */
export function deriveBreakoutLevels(bullLevel, bearLevel, breakoutPct) {
  if (!isPosFinite(bullLevel)) throw new Error(`bullLevel must be a positive finite level, got ${bullLevel}`);
  if (!isPosFinite(bearLevel)) throw new Error(`bearLevel must be a positive finite level, got ${bearLevel}`);
  if (bullLevel <= bearLevel) {
    throw new Error(`bullLevel (${bullLevel}) must be strictly above bearLevel (${bearLevel})`);
  }
  const g = resolveBreakoutGeometry({ breakoutPct });
  if (!g.ok) throw new Error(`breakoutPct: ${g.error}`);

  return {
    bullBreakout: bullLevel * (1 + g.breakoutPct),
    bearBreakout: bearLevel * (1 - g.breakoutPct),
  };
}

const isPosFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
