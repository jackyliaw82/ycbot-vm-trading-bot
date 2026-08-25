// Balance / contraction reading from the 24h candle set. Pure.
//
// WHAT THIS ANSWERS: is the market coiling (Market Profile "balance" — two-sided
// rotation into a narrowing value area, which historically precedes a range
// expansion), or is it merely asleep?
//
// WHY IT IS DERIVED, NOT ACCUMULATED: contraction is a trend, so it needs a
// history. The obvious build is a ring buffer sampled on the 5-minute refresh —
// but that lives in the Node heap, so a redeploy (PM2 restart, VM self-update)
// throws it away and the signal goes blind for hours while it refills. Instead
// every sample is recomputed from the SAME 1440x1m candle array
// `VolumeProfile._getCandles` already caches for the 24h profile. No stored
// state, no schema field, nothing to drift, correct on the first refresh after
// a restart. Measured cost: ~0.6ms per sub-window profile, ~7ms for the set.
//
// THE VOLUME TEST IS THE POINT. A value area narrowing on HELD volume is
// balance. The same narrowing on COLLAPSED volume is a quiet session — and on a
// market-hours instrument like CL (crude), whose volume drains outside US pit
// hours, that happens every night. Without `volumeRatio` this would fire daily
// and mean nothing. The two cases are geometrically identical; only volume
// separates them, which is why `QUIET` is its own regime rather than a footnote.

import { computeVolumeProfile } from './volume-profile.js';

export const BALANCE_DEFAULTS = {
  windowBars: 240,        // bars per sub-window profile (240 x 1m = 4h)
  stepBars: 100,          // gap between consecutive samples (100m)
  sampleCount: 12,        // samples taken, newest first  -> spans ~22h of the 24h set
  bins: 60,               // bins per sub-window. Coarser than the 200-bin 24h
                          // profile ON PURPOSE: a 4h slice holds a sixth of the
                          // volume, and 200 bins over it resolves noise into
                          // spurious value-area edges.
  contractingBelow: 0.75, // current VA width <= 75% of the widest sample -> narrowing
  expandingAbove: 1.25,   // current VA width >= 125% of the widest -> widening
  quietVolumeRatio: 0.55, // recent volume / earlier volume below this -> session lull
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const sum = (a) => a.reduce((s, v) => s + v, 0);

/**
 * @param {Array<{high:number, low:number, volume:number}>} candles  oldest first
 * @param {object} [opts]  overrides for BALANCE_DEFAULTS
 * @returns {{
 *   vaWidthPct: number, vaWidthSeries: number[], contraction: number,
 *   volumeRatio: number, regime: 'BALANCED_CONTRACTING'|'QUIET'|'EXPANDING'|'NEUTRAL',
 *   samples: number
 * } | null}
 *   null when there is not enough data to say anything — never a fabricated
 *   reading. Callers must handle null (see `_refreshVolumeSnapshot`, which keeps
 *   the previous snapshot rather than blanking the panel).
 */
export function computeBalance(candles, opts = {}) {
  const cfg = { ...BALANCE_DEFAULTS, ...opts };
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const span = cfg.windowBars + cfg.stepBars * (cfg.sampleCount - 1);
  // Two samples is the minimum that can express a direction at all.
  const minBars = cfg.windowBars + cfg.stepBars;
  if (candles.length < minBars) return null;

  // Only the trailing `span` matters. Anything older is outside the lookback and
  // must not influence the reading — a wide morning does not make a quiet night
  // read as contracted once it has aged past the window.
  const tape = candles.length > span ? candles.slice(candles.length - span) : candles;

  // Newest first: sample k ends `k * stepBars` before the live edge.
  const vaWidthSeries = [];
  for (let k = 0; k < cfg.sampleCount; k++) {
    const end = tape.length - k * cfg.stepBars;
    const start = end - cfg.windowBars;
    if (start < 0) break;
    const profile = computeVolumeProfile(tape.slice(start, end), cfg.bins);
    // A degenerate slice (every bar at one price) yields no profile. Skip it
    // rather than substituting a zero, which would read as maximum contraction.
    if (!profile || !finite(profile.vah) || !finite(profile.val)) continue;
    const centre = profile.poc?.price;
    if (!finite(centre) || centre <= 0) continue;
    vaWidthSeries.push(((profile.vah - profile.val) / centre) * 100);
  }

  if (vaWidthSeries.length < 2) return null;

  // Reference = the MEDIAN of the older samples, not the max of all of them.
  //
  // Dividing by `Math.max(...vaWidthSeries)` was the first attempt and is wrong
  // in a way that hides itself: the newest sample is IN that set, so the ratio
  // can never exceed 1 and EXPANDING is unreachable by construction. A test
  // fixture that clearly widened still scored exactly 1.000.
  //
  // Median rather than mean because the samples straddling a regime change span
  // both the old and the new range and read wide; a mean lets those transition
  // windows drag the reference around, while the median ignores them.
  const vaWidthPct = vaWidthSeries[0];
  const older = vaWidthSeries.slice(1).sort((a, b) => a - b);
  const mid = Math.floor(older.length / 2);
  const reference = older.length % 2 ? older[mid] : (older[mid - 1] + older[mid]) / 2;
  if (!finite(reference) || reference <= 0) return null;
  const contraction = vaWidthPct / reference;

  // Volume: the newest window against everything older in the span. Compared as
  // a PER-BAR rate, so an uneven split cannot masquerade as a volume change.
  const recent = tape.slice(tape.length - cfg.windowBars);
  const earlier = tape.slice(0, tape.length - cfg.windowBars);
  const recentRate = sum(recent.map((c) => c.volume || 0)) / Math.max(1, recent.length);
  const earlierRate = earlier.length
    ? sum(earlier.map((c) => c.volume || 0)) / earlier.length
    : recentRate;
  const volumeRatio = earlierRate > 0 ? recentRate / earlierRate : 1;

  let regime = 'NEUTRAL';
  if (contraction >= cfg.expandingAbove) {
    regime = 'EXPANDING';
  } else if (contraction <= cfg.contractingBelow) {
    // Narrowing. Volume decides which KIND of narrowing this is.
    regime = volumeRatio < cfg.quietVolumeRatio ? 'QUIET' : 'BALANCED_CONTRACTING';
  }

  return {
    vaWidthPct,
    vaWidthSeries,
    contraction,
    volumeRatio,
    regime,
    samples: vaWidthSeries.length,
  };
}
