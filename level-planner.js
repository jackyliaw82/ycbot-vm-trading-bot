// Validation for AI-proposed entry levels. This is the last gate before a
// number becomes a real order trigger, so it is deliberately fail-closed:
// anything it cannot positively verify is rejected, and the caller falls back
// to the mechanical void edges rather than trading on a value nothing checked.

// Carried over from the original system prompt: levels closer together than
// 1.5x ATR put the dead zone inside ordinary noise, which is the churn this
// strategy exists to avoid.
export const ATR_SEPARATION_MULT = 1.5;

const finitePos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Snap to the exchange tick grid. A zero/absent tick is a passthrough — the
 * alternative is a divide-by-zero producing Infinity, which would sail through
 * a naive finite check downstream.
 */
export function roundToTick(price, tickSize) {
  if (!finitePos(tickSize)) return price;
  if (typeof price !== 'number' || !Number.isFinite(price)) return price;
  const ticks = Math.round(price / tickSize);
  // toPrecision(15), not toFixed(decimalsOfTick): ticks * 0.1 reintroduces
  // binary float error (100.10000000000001) that would otherwise be sent as a
  // price. Deriving decimals from String(tickSize) looks equivalent but breaks
  // on exponential notation — String(0.00000001) is "1e-8", which has no '.',
  // so every price on a small-tick pair would round to a whole number.
  // 15 significant digits is inside the ~17 a double carries, so it scrubs the
  // crumb without touching a legitimate value.
  return Number((ticks * tickSize).toPrecision(15));
}

/**
 * Returns { ok: true, bullLevel, bearLevel } with both values tick-rounded, or
 * { ok: false, reason }.
 *
 * Rounding happens BEFORE the invariant is re-checked, because rounding can
 * move a level onto or across current price — a bull 0.04 above price on a 0.1
 * tick rounds down onto it, and an order there fires instantly.
 */
export function validateLevels(levels, { currentPrice, atr, tickSize } = {}) {
  if (!levels || typeof levels !== 'object') return { ok: false, reason: 'no levels object' };
  if (!finitePos(currentPrice)) return { ok: false, reason: 'currentPrice is not a positive number' };

  let { bullLevel, bearLevel } = levels;
  if (!finitePos(bullLevel)) return { ok: false, reason: `bullLevel is not a positive number: ${bullLevel}` };
  if (!finitePos(bearLevel)) return { ok: false, reason: `bearLevel is not a positive number: ${bearLevel}` };

  bullLevel = roundToTick(bullLevel, tickSize);
  bearLevel = roundToTick(bearLevel, tickSize);

  if (bullLevel <= currentPrice) {
    return { ok: false, reason: `bullLevel ${bullLevel} must be above current price ${currentPrice}` };
  }
  if (bearLevel >= currentPrice) {
    return { ok: false, reason: `bearLevel ${bearLevel} must be below current price ${currentPrice}` };
  }

  if (finitePos(atr)) {
    const minSep = ATR_SEPARATION_MULT * atr;
    const sep = bullLevel - bearLevel;
    if (sep < minSep) {
      return { ok: false, reason: `separation ${sep.toFixed(6)} below ${ATR_SEPARATION_MULT}x ATR (${minSep.toFixed(6)})` };
    }
  }

  return { ok: true, bullLevel, bearLevel };
}
