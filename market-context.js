import { precisionFormatter } from './precisionUtils.js';

/**
 * Assemble the market context the level planner reasons over.
 *
 * FAIL SOFT, ONE SOURCE AT A TIME. Each fetch is independent and its failure
 * omits only its own field. That asymmetry is deliberate: a missing funding
 * rate degrades the model's reasoning, while a thrown context blocks the cycle
 * from starting at all. The one exception is currentPrice — every other field
 * is interpreted relative to it, so a bad one poisons everything downstream and
 * is rejected outright.
 *
 * Fields are OMITTED rather than set to null when unavailable, because the
 * prompt builder prints any field it can read; an explicit null would surface
 * as market data.
 */
export async function buildLevelContext({
  symbol,
  currentPrice,
  volumeProfile,
  marketMetrics,
  precision = precisionFormatter,
} = {}) {
  if (typeof symbol !== 'string' || symbol === '') {
    throw new Error(`buildLevelContext: symbol must be a non-empty string, got ${symbol}`);
  }
  if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error(`buildLevelContext: currentPrice must be a positive finite number, got ${currentPrice}`);
  }

  const ctx = { symbol, currentPrice };

  const settled = await Promise.allSettled([
    call(volumeProfile, 'getVoidProfile', symbol, currentPrice),
    call(marketMetrics, 'getVolatility', symbol),
    call(marketMetrics, 'getCvd', symbol),
    call(marketMetrics, 'getOrderbookDepth', symbol),
    call(marketMetrics, 'getFundingRate', symbol),
    call(marketMetrics, 'getOpenInterestChange', symbol),
  ]);
  const [voidRes, atrRes, cvdRes, depthRes, fundingRes, oiRes] = settled.map(unwrap);

  // Volume profile — the one source that also carries the mechanical fallback
  // pair. Surfacing it to the model is deliberate: the planner computes the
  // same pair itself, and showing it means the model reasons about the
  // fallback rather than being silently overridden by it.
  if (isObj(voidRes) && isObj(voidRes.profile)) {
    const p = voidRes.profile;
    const profile = {};
    setNum(profile, 'poc', isObj(p.poc) ? p.poc.price : p.poc);
    setNum(profile, 'vah', p.vah);
    setNum(profile, 'val', p.val);
    if (Array.isArray(p.rangeVoids)) profile.rangeVoids = p.rangeVoids;
    if (Array.isArray(p.hvns)) profile.hvns = p.hvns;
    if (Object.keys(profile).length) ctx.profile = profile;

    if (isObj(voidRes.pair)) {
      const { bullLevel, bearLevel } = voidRes.pair;
      // A half-populated pair is worse than none — the fallback consumer
      // (selectVoidPair's caller) expects both sides, so an omission here
      // must be total, not per-field like the other setNum() writes.
      if (isFiniteNum(bullLevel) && isFiniteNum(bearLevel)) {
        ctx.voidPair = { bullLevel, bearLevel };
      }
    } else {
      // §9 of the design: after the widen chain is exhausted, tell the model
      // explicitly rather than letting it infer from an absent field.
      ctx.note = `No volume void straddles the current price after widening to ${voidRes.window ?? 'the longest window'}; propose levels from other structure.`;
    }
  }

  setNum(ctx, 'atr', isObj(atrRes) ? atrRes.atr : undefined);
  setNum(ctx, 'cvd', isObj(cvdRes) ? cvdRes.cvd : undefined);
  setNum(ctx, 'fundingRate', isObj(fundingRes) ? fundingRes.rate : undefined);
  setNum(ctx, 'openInterestChangePct', isObj(oiRes) ? oiRes.oiChange1h : undefined);
  if (isObj(depthRes)) ctx.depth = depthRes;

  const tickSize = safe(() => precision?.getPrecisionData?.(symbol)?.tickSize);
  setNum(ctx, 'tickSize', tickSize);

  return ctx;
}

// Excludes arrays deliberately: every call site expects a plain record to read
// named fields off (profile.poc, pair.bullLevel, depthRes.bidVolume, ...). An
// array is `typeof 'object'` but has none of those, so letting one through
// either reads as undefined (harmless) or, for a field assigned wholesale
// (ctx.depth), survives verbatim and renders as "Orderbook: [1,2,3]".
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Assign only finite numbers. A NaN or Infinity would print into the prompt. */
function setNum(target, key, value) {
  if (isFiniteNum(value)) target[key] = value;
}

/** Invoke a duck-typed source method; a missing source or method is not an error. */
function call(source, method, ...args) {
  if (!source || typeof source[method] !== 'function') return Promise.resolve(undefined);
  try {
    return Promise.resolve(source[method](...args));
  } catch (error) {
    // A source that throws SYNCHRONOUSLY never produces a rejected promise, so
    // Promise.allSettled would not catch it.
    return Promise.resolve(undefined);
  }
}

function unwrap(result) {
  if (result.status === 'fulfilled') return result.value;
  console.error(`[market-context] source failed: ${result.reason?.message}`);
  return undefined;
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}
