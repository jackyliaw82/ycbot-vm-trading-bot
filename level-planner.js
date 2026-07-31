import { selectVoidPair } from './volume-profile.js';
import { LEVELS_SYSTEM_PROMPT, buildPlanUserMessage, buildAskUserMessage } from './ai-levels-prompt.js';

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

  // Rounding can turn a huge-but-finite raw input into Infinity (e.g.
  // 1e308 / 0.1 overflows), and Infinity sails through every relational
  // check below (it is > currentPrice, < currentPrice, and "separated" by
  // any finite ATR). Re-check finiteness AFTER rounding, not just on the
  // raw input, or this module fails open on exactly the hazard its own
  // doc comment above warns about.
  if (!finitePos(bullLevel) || !finitePos(bearLevel)) {
    return { ok: false, reason: `level is not finite after tick-rounding: bullLevel=${bullLevel}, bearLevel=${bearLevel}` };
  }

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

/**
 * Produce a validated { bullLevel, bearLevel } for a cycle.
 *
 * Two routes, in order: the AI, then the mechanical void edges. The fallback is
 * NOT a lesser path to be skipped when the AI answers — an AI pair that fails
 * validation is discarded and the fallback runs anyway, because an unvalidated
 * level becomes a real order trigger.
 *
 * Returns null only when neither route yields a valid pair. That is a genuine
 * "cannot start" and the caller must treat it as one, not substitute a guess.
 */
export async function planLevels({ planner, context, mode = 'plan', question } = {}) {
  const c = context || {};
  const opts = { currentPrice: c.currentPrice, atr: c.atr, tickSize: c.tickSize };
  let usage = null;
  let error = null;

  if (planner && typeof planner.consult === 'function') {
    try {
      const userMessage = mode === 'ask'
        ? buildAskUserMessage(c, question)
        : buildPlanUserMessage(c);
      const { json, usage: u } = await planner.consult(LEVELS_SYSTEM_PROMPT, userMessage);
      usage = u || null;
      const verdict = validateLevels(json, opts);
      if (verdict.ok) {
        return {
          bullLevel: verdict.bullLevel,
          bearLevel: verdict.bearLevel,
          source: 'ai',
          rationale: typeof json?.rationale === 'string' ? json.rationale : null,
          confidence: typeof json?.confidence === 'number' ? json.confidence : null,
          usage,
          error: null,
        };
      }
      error = `AI levels rejected: ${verdict.reason}`;
      console.error(`[level-planner] ${error}`);
    } catch (e) {
      error = e.message;
      console.error(`[level-planner] consult failed: ${e.message}`);
    }
  } else {
    error = 'no planner supplied';
  }

  // Mechanical fallback — the void edges from Phase 1, run through the SAME
  // validation. A fallback nobody checked is just a different way to place a
  // bad order.
  const pair = selectVoidPair(c.profile, c.currentPrice);
  if (!pair) return null;
  const verdict = validateLevels(pair, opts);
  if (!verdict.ok) {
    console.error(`[level-planner] fallback also rejected: ${verdict.reason}`);
    return null;
  }
  return {
    bullLevel: verdict.bullLevel,
    bearLevel: verdict.bearLevel,
    source: 'fallback',
    rationale: null,
    confidence: null,
    usage,
    error,
  };
}
