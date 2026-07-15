// 24h volume profile — the ONLY survivor of ai-market-context.js.
// Chart-only: nothing in the bot reads vah/val/lvns any more; the ladder is
// anchored on live price with a fixed step. Kept backend so there is exactly
// one implementation feeding the chart histogram (binVolumes/priceMin/binWidth).

const VP_CACHE_TTL_MS = 10 * 60 * 1000;      // 10 min volume profile cache
const CANDLE_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min 1m-candle cache
const VP_24H_1M_BARS = 1440;                 // 1m × 1440 = 24h (fine profile source)
const VP_BIN_COUNT_24H = 200;                // 24h profile bins — supported by 1m data
const VP_VALUE_AREA_PCT = 0.70;              // 70% volume defines value area
// Hybrid HVN/LVN detection — local extrema (Pine-style) + absolute-significance gate.
const HVN_STRENGTH_FRAC = 0.05;              // HVN peak window = ±5% of bins (Pine strength, scaled to binCount)
const LVN_STRENGTH_FRAC = 0.075;             // LVN valley window = ±7.5% of bins
const HVN_MIN_POC_FRAC = 0.20;               // HVN peak kept only if ≥20% of POC volume (drops dead-zone micro-peaks)
const LVN_MAX_MEAN_FRAC = 0.50;              // LVN valley kept only if ≤50% of mean bin volume (genuine thin/void zone)

export function parseKlines(klines) {
  return klines.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    // Additional fields used by AI Reversal volume primitives.
    // Binance kline format index ref: 7=quoteAssetVolume, 9=takerBuyBaseVolume, 10=takerBuyQuoteVolume.
    quoteVolume: k[7] != null ? parseFloat(k[7]) : 0,
    takerBuyBaseVolume: k[9] != null ? parseFloat(k[9]) : 0,
    takerBuyQuoteVolume: k[10] != null ? parseFloat(k[10]) : 0,
  }));
}

/**
 * Build VPVR from candles. Each candle's volume is distributed across the
 * bin range its high/low spans (uniformly — TPO-style would be more
 * accurate but requires tick data).
 *
 * Returns:
 *   {
 *     priceMin, priceMax, binWidth,
 *     bins: [{ priceLow, priceHigh, volume }, ...],
 *     poc: { price, volume },        // Point of Control (highest-volume bin)
 *     vah: number, val: number,      // Value Area boundaries (70% volume)
 *     hvns: [{ priceLow, priceHigh, volume }, ...],
 *     lvns: [{ priceLow, priceHigh, volume }, ...],
 *     totalVolume,
 *   }
 */
export function computeVolumeProfile(candles, binCount = VP_BIN_COUNT_24H) {
  if (!candles || candles.length === 0) return null;
  const priceMin = Math.min(...candles.map(c => c.low));
  const priceMax = Math.max(...candles.map(c => c.high));
  if (priceMax <= priceMin) return null;
  const binWidth = (priceMax - priceMin) / binCount;
  const bins = new Array(binCount).fill(0).map((_, i) => ({
    priceLow: priceMin + i * binWidth,
    priceHigh: priceMin + (i + 1) * binWidth,
    volume: 0,
  }));

  // Distribute each candle's volume uniformly across the bins its range covers.
  for (const c of candles) {
    const lowIdx = Math.max(0, Math.floor((c.low - priceMin) / binWidth));
    const highIdx = Math.min(binCount - 1, Math.floor((c.high - priceMin) / binWidth));
    const span = Math.max(1, highIdx - lowIdx + 1);
    const perBin = c.volume / span;
    for (let i = lowIdx; i <= highIdx; i++) bins[i].volume += perBin;
  }

  // POC — bin with the highest volume.
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
  }
  const poc = {
    price: (bins[pocIdx].priceLow + bins[pocIdx].priceHigh) / 2,
    volume: bins[pocIdx].volume,
  };

  // Value area — expand from POC outward until 70% of volume is captured.
  const totalVolume = bins.reduce((s, b) => s + b.volume, 0);
  const targetVolume = totalVolume * VP_VALUE_AREA_PCT;
  let lo = pocIdx;
  let hi = pocIdx;
  let captured = bins[pocIdx].volume;
  while (captured < targetVolume && (lo > 0 || hi < bins.length - 1)) {
    const leftVol = lo > 0 ? bins[lo - 1].volume : -1;
    const rightVol = hi < bins.length - 1 ? bins[hi + 1].volume : -1;
    if (leftVol >= rightVol && lo > 0) {
      lo -= 1;
      captured += bins[lo].volume;
    } else if (hi < bins.length - 1) {
      hi += 1;
      captured += bins[hi].volume;
    } else if (lo > 0) {
      lo -= 1;
      captured += bins[lo].volume;
    } else {
      break;
    }
  }
  const val = bins[lo].priceLow;
  const vah = bins[hi].priceHigh;

  // HVN / LVN classification — hybrid local-extrema + absolute-significance gate.
  //   Shape:  a bin qualifies only if it is a local MAX (HVN) / MIN (LVN) over a
  //           ±strength window (strength scaled as a fraction of binCount, à la Pine).
  //   Gate:   HVN peaks must also be ≥ HVN_MIN_POC_FRAC of POC volume (drops
  //           insignificant micro-peaks sitting in low-volume tails); LVN valleys
  //           must be ≤ LVN_MAX_MEAN_FRAC of the mean bin volume (a genuine void,
  //           not merely a dip between two heavy peaks). Interior voids — the
  //           gaps price rips through — now surface instead of just the range edges.
  const meanVol = totalVolume / bins.length;
  const hvnStrength = Math.max(2, Math.round(bins.length * HVN_STRENGTH_FRAC));
  const lvnStrength = Math.max(2, Math.round(bins.length * LVN_STRENGTH_FRAC));
  const hvnMinVol = poc.volume * HVN_MIN_POC_FRAC;
  const lvnMaxVol = meanVol * LVN_MAX_MEAN_FRAC;

  // Local extremum tests over a clamped ±reach window. Ties (plateaus) pass, so a
  // flat peak/valley run all qualifies and is merged into one range downstream.
  const isLocalMax = (i, reach) => {
    const v = bins[i].volume;
    const from = Math.max(0, i - reach);
    const to = Math.min(bins.length - 1, i + reach);
    for (let j = from; j <= to; j++) if (j !== i && bins[j].volume > v) return false;
    return true;
  };
  const isLocalMin = (i, reach) => {
    const v = bins[i].volume;
    const from = Math.max(0, i - reach);
    const to = Math.min(bins.length - 1, i + reach);
    for (let j = from; j <= to; j++) if (j !== i && bins[j].volume < v) return false;
    return true;
  };

  const hvnSet = new Set();
  const lvnSet = new Set();
  for (let i = 0; i < bins.length; i++) {
    if (bins[i].volume >= hvnMinVol && isLocalMax(i, hvnStrength)) hvnSet.add(i);
    if (bins[i].volume <= lvnMaxVol && isLocalMin(i, lvnStrength)) lvnSet.add(i);
  }

  // Merge consecutive HVN/LVN bins into contiguous ranges for AI readability.
  const mergeContiguous = (set) => {
    const idxList = [...set].sort((a, b) => a - b);
    const ranges = [];
    let cur = null;
    for (const i of idxList) {
      if (cur && i === cur.endIdx + 1) {
        cur.endIdx = i;
        cur.volume += bins[i].volume;
      } else {
        if (cur) ranges.push(cur);
        cur = { startIdx: i, endIdx: i, volume: bins[i].volume };
      }
    }
    if (cur) ranges.push(cur);
    return ranges.map(r => ({
      priceLow: bins[r.startIdx].priceLow,
      priceHigh: bins[r.endIdx].priceHigh,
      volume: r.volume,
    }));
  };

  return {
    priceMin,
    priceMax,
    binWidth,
    poc,
    vah,
    val,
    hvns: mergeContiguous(hvnSet),
    lvns: mergeContiguous(lvnSet),
    totalVolume,
    // Compact per-bin volume array for the frontend VP histogram overlay.
    // Rounded to integers — sub-unit precision is meaningless for a bar chart
    // and keeps the status payload lean (the frontend rebuilds each bin's
    // price range from priceMin + i*binWidth).
    binVolumes: bins.map(b => Math.round(b.volume)),
  };
}

/**
 * VolumeProfile — 24h VPVR for the chart histogram overlay, keyed by symbol.
 * `strategy` supplies makeProxyRequest — the same duck-typing AiMarketContext
 * used; this class does not invent a new transport.
 */
export class VolumeProfile {
  constructor(strategy) {
    this.strategy = strategy;
    this._vpCache = new Map();       // symbol -> { profile, at }
    this._candleCache = new Map();   // symbol -> { candles, ts }
  }

  // ——— 24h 1m candle fetcher ——————————————————————————————————————————
  // 1440 bars × 1m = exactly 24h, fetched in a single request (Binance klines
  // cap is 1500). Feeds the 24h volume profile — 5× finer than the 5m window,
  // which is what makes the 200-bin HVN/LVN resolution meaningful rather than
  // just slicing the same smear thinner.

  async _get24hCandles1m(symbol) {
    const now = Date.now();
    const cached = this._candleCache.get(symbol);
    if (cached && (now - cached.ts) < CANDLE_CACHE_TTL_MS) {
      return cached.candles;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol, interval: '1m', limit: VP_24H_1M_BARS }, false, 'futures');
      const candles = parseKlines(klines);
      this._candleCache.set(symbol, { candles, ts: now });
      return candles;
    } catch (error) {
      console.error(`Failed to fetch 24h (1m) candles: ${error.message}`);
      return cached?.candles || [];
    }
  }

  // ——— 24h Volume Profile (VPVR) ————————————————————————————————————————

  async get24h(symbol) {
    const cached = this._vpCache.get(symbol);
    const now = Date.now();
    if (cached && (now - cached.at) < VP_CACHE_TTL_MS) {
      return cached.profile;
    }
    try {
      const candles = await this._get24hCandles1m(symbol);
      if (!candles || candles.length === 0) return null;
      const profile = computeVolumeProfile(candles, VP_BIN_COUNT_24H);
      this._vpCache.set(symbol, { profile, at: now });
      return profile;
    } catch (error) {
      console.error(`Failed to compute volume profile (24h): ${error.message}`);
      return null;
    }
  }

  invalidate(symbol) {
    this._vpCache.delete(symbol);
    this._candleCache.delete(symbol);
  }
}
