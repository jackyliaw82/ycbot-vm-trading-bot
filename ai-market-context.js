// Abnormality thresholds — metric is included in AI prompt only when exceeded.
// FLOORS only — the actual threshold is max(floor, symbol-relative baseline)
// computed in _computeSymbolBaselines. The constants below guarantee BTC won't
// flag every 0.5% OI swing as "abnormal", and ensure extremely quiet symbols
// still have a meaningful trip threshold.
const OI_CHANGE_1H_THRESHOLD = 2;          // floor: |oiChange1h| > 2%
const LIQ_VOLUME_15M_THRESHOLD = 1_000_000; // floor: liqs > $1M in 15m

// Symbol-relative scaling. Recomputed every 6h.
const SYMBOL_BASELINE_TTL_MS = 6 * 60 * 60 * 1000;
const LIQ_VOLUME_PCT_OF_15M_VOLUME = 0.05;   // flag liqs > 5% of typical 15m volume

// Liquidation-aware sizing soft target. Reversal reports each leg's projected
// liq distance >= MIN_LIQ_DISTANCE_PCT as a safety reference in its context.
// 8% leaves a meaningful safety margin even with sub-second adverse moves.
const MIN_LIQ_DISTANCE_PCT = 8;

// AI Reversal Strategy — volume profile, CVD, orderbook depth.
const DEPTH_CACHE_TTL_MS = 30 * 1000;       // 30s depth snapshot cadence
const DEPTH_LIMIT = 100;                     // top-100 levels each side
const VP_CACHE_TTL_MS = 10 * 60 * 1000;      // 10 min volume profile cache
const VP_24H_BARS = 288;                     // 5m × 288 = 24h
const VP_7D_BARS = 168;                      // 1h × 168 = 7d
const VP_BIN_COUNT = 100;                    // 100 price bins per profile
const VP_VALUE_AREA_PCT = 0.70;              // 70% volume defines value area
const CVD_LOOKBACK_BARS = 24;                // 24 × 5m = 2h CVD window
const CVD_TREND_THRESHOLD_PCT = 0.05;        // 5% slope threshold for rising/falling

/**
 * AiMarketContext — builds market context for AI plan generation.
 *
 * Gathers: price candles (5m/15m/1h), ATR volatility,
 * support/resistance with 15m → 1h cascade fallback,
 * OI change, taker ratio, global L/S ratio, funding rate, liquidations,
 * relative volume, and margin info.
 */
class AiMarketContext {
  constructor(strategy) {
    this.strategy = strategy;

    // 5m candle cache
    this._cachedCandles = null;
    this._candleCacheTime = 0;
    this._candleCacheTTL = 5 * 60 * 1000;

    // 15m candle cache (for ATR + initial S/R)
    this._cached15mCandles = null;
    this._candle15mCacheTime = 0;
    this._candle15mCacheTTL = 15 * 60 * 1000;

    // 1h candle cache (for broader trend + S/R cascade fallback rung)
    this._cached1hCandles = null;
    this._candle1hCacheTime = 0;
    this._candle1hCacheTTL = 30 * 60 * 1000;

    // Funding rate cache
    this._cachedFundingRate = null;
    this._fundingRateCacheTime = 0;
    this._fundingRateCacheTTL = 5 * 60 * 1000;

    // OI history cache
    this._cachedOIHistory = null;
    this._oiCacheTime = 0;
    this._oiCacheTTL = 5 * 60 * 1000;

    // M4 + M5 — symbol-relative threshold cache. Refreshed every 6h.
    this._symbolBaselines = null;
    this._symbolBaselinesAt = 0;

    // AI Reversal — 24h 5m candle cache (fuller window than _getRecentCandles).
    // 288 bars × 5m = 24h volume profile lookback.
    this._cached24hCandles5m = null;
    this._candle24hCacheTime = 0;
    this._candle24hCacheTTL = 5 * 60 * 1000;

    // AI Reversal — volume profile cache (keyed by `${symbol}:${windowKey}`).
    this._vpCache = new Map();

    // AI Reversal — orderbook depth snapshot cache.
    this._cachedDepth = null;
    this._depthCacheTime = 0;
  }

  /**
   * Compute the symbol-relative liquidation-volume threshold from recent
   * baseline data. Cached for SYMBOL_BASELINE_TTL_MS. The threshold is
   * `max(floor, 5% of typical 15m quote volume)` so very low-vol symbols still
   * have a meaningful trip line and very high-vol symbols don't flag routine
   * fluctuations.
   *
   * Source: liquidation threshold ← /fapi/v1/ticker/24hr quoteVolume / 96 (15m windows)
   *
   * Caller (_getLiquidations) awaits this before evaluating the abnormality flag.
   */
  async _computeSymbolBaselines() {
    const now = Date.now();
    if (this._symbolBaselines && (now - this._symbolBaselinesAt) < SYMBOL_BASELINE_TTL_MS) {
      return this._symbolBaselines;
    }
    const symbol = this.strategy.symbol;
    const baselines = {
      liqVolumeThreshold: LIQ_VOLUME_15M_THRESHOLD,
    };
    try {
      const ticker24h = await this.strategy.makeProxyRequest('/fapi/v1/ticker/24hr', 'GET', { symbol }, false, 'futures').catch(() => null);

      // Liquidation threshold = max($1M floor, 5% of typical 15m quote volume).
      if (ticker24h && ticker24h.quoteVolume) {
        const quoteVolume24h = parseFloat(ticker24h.quoteVolume);
        const typical15m = quoteVolume24h / 96;
        const scaled = typical15m * LIQ_VOLUME_PCT_OF_15M_VOLUME;
        baselines.liqVolumeThreshold = Math.max(LIQ_VOLUME_15M_THRESHOLD, scaled);
      }

      this._symbolBaselines = baselines;
      this._symbolBaselinesAt = now;
    } catch (err) {
      console.error(`[BASELINES] failed for ${symbol}: ${err.message}`);
    }
    return baselines;
  }

  // ——— ATR Volatility ————————————————————————————————————————————————————

  async _getVolatility() {
    try {
      const candles = await this._get15mCandles();
      if (!candles || candles.length < 15) {
        return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
      }
      return this._calculateATR(candles, 14);
    } catch (error) {
      console.error(`Failed to calculate ATR: ${error.message}`);
      return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
    }
  }

  _calculateATR(candles, period = 14) {
    if (candles.length < period + 1) {
      return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
    }

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    const recentTR = trueRanges.slice(-period);
    const atr = recentTR.reduce((sum, tr) => sum + tr, 0) / recentTR.length;
    const currentPrice = this.strategy.currentPrice || candles[candles.length - 1].close;
    const atrPercent = (atr / currentPrice) * 100;

    let interpretation;
    if (atrPercent < 0.5) interpretation = 'low';
    else if (atrPercent < 1.0) interpretation = 'moderate';
    else if (atrPercent < 2.0) interpretation = 'high';
    else interpretation = 'extreme';

    return { atr, atrPercent, interpretation };
  }

  // ——— Candle Fetchers ——————————————————————————————————————————————————

  async _get15mCandles() {
    const now = Date.now();
    if (this._cached15mCandles && (now - this._candle15mCacheTime) < this._candle15mCacheTTL) {
      return this._cached15mCandles;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol: this.strategy.symbol, interval: '15m', limit: 300 }, false, 'futures');
      this._cached15mCandles = this._parseKlines(klines);
      this._candle15mCacheTime = now;
      return this._cached15mCandles;
    } catch (error) {
      console.error(`Failed to fetch 15m candles: ${error.message}`);
      return this._cached15mCandles || [];
    }
  }

  async _getRecentCandles() {
    const now = Date.now();
    if (this._cachedCandles && (now - this._candleCacheTime) < this._candleCacheTTL) {
      return this._cachedCandles;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol: this.strategy.symbol, interval: '5m', limit: 100 }, false, 'futures');
      this._cachedCandles = this._parseKlines(klines);
      this._candleCacheTime = now;
      return this._cachedCandles;
    } catch (error) {
      console.error(`Failed to fetch 5m candles: ${error.message}`);
      return this._cachedCandles || [];
    }
  }

  async _get1hCandles() {
    const now = Date.now();
    if (this._cached1hCandles && (now - this._candle1hCacheTime) < this._candle1hCacheTTL) {
      return this._cached1hCandles;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol: this.strategy.symbol, interval: '1h', limit: 168 }, false, 'futures');
      this._cached1hCandles = this._parseKlines(klines);
      this._candle1hCacheTime = now;
      return this._cached1hCandles;
    } catch (error) {
      console.error(`Failed to fetch 1h candles: ${error.message}`);
      return this._cached1hCandles || [];
    }
  }

  _parseKlines(klines) {
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

  // ——— AI Reversal: 24h 5m candle fetcher ——————————————————————————————
  // Separate cache from _getRecentCandles (which only fetches 100 bars).
  // 288 bars × 5m = exactly 24h — used as the lookback window for the
  // short-window volume profile and CVD snapshot.

  async _get24hCandles5m() {
    const now = Date.now();
    if (this._cached24hCandles5m && (now - this._candle24hCacheTime) < this._candle24hCacheTTL) {
      return this._cached24hCandles5m;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol: this.strategy.symbol, interval: '5m', limit: VP_24H_BARS }, false, 'futures');
      this._cached24hCandles5m = this._parseKlines(klines);
      this._candle24hCacheTime = now;
      return this._cached24hCandles5m;
    } catch (error) {
      console.error(`Failed to fetch 24h (5m) candles: ${error.message}`);
      return this._cached24hCandles5m || [];
    }
  }

  // ——— AI Reversal: Volume Profile (VPVR) ——————————————————————————————
  // Bins candle volume into price buckets across the window, computes POC,
  // Value Area High/Low, and surfaces HVN/LVN ranges. Two windows are used
  // by the reversal planner:
  //   '24h' — 5m candles × 288 bars (intraday structure)
  //   '7d'  — 1h candles × 168 bars (multi-day structure)

  async _getVolumeProfile(windowKey = '24h') {
    const cacheKey = `${this.strategy.symbol}:${windowKey}`;
    const cached = this._vpCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.at) < VP_CACHE_TTL_MS) {
      return cached.profile;
    }
    try {
      const candles = windowKey === '7d' ? await this._get1hCandles() : await this._get24hCandles5m();
      if (!candles || candles.length === 0) return null;
      const profile = this._computeVolumeProfile(candles);
      this._vpCache.set(cacheKey, { profile, at: now });
      return profile;
    } catch (error) {
      console.error(`Failed to compute volume profile (${windowKey}): ${error.message}`);
      return null;
    }
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
  _computeVolumeProfile(candles) {
    if (!candles || candles.length === 0) return null;
    const priceMin = Math.min(...candles.map(c => c.low));
    const priceMax = Math.max(...candles.map(c => c.high));
    if (priceMax <= priceMin) return null;
    const binWidth = (priceMax - priceMin) / VP_BIN_COUNT;
    const bins = new Array(VP_BIN_COUNT).fill(0).map((_, i) => ({
      priceLow: priceMin + i * binWidth,
      priceHigh: priceMin + (i + 1) * binWidth,
      volume: 0,
    }));

    // Distribute each candle's volume uniformly across the bins its range covers.
    for (const c of candles) {
      const lowIdx = Math.max(0, Math.floor((c.low - priceMin) / binWidth));
      const highIdx = Math.min(VP_BIN_COUNT - 1, Math.floor((c.high - priceMin) / binWidth));
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

    // HVN / LVN classification — top/bottom 20% bins by volume.
    // Bins are sorted into "magnetic" (HVN) and "void" (LVN) categories.
    const sortedByVol = bins.map((b, i) => ({ ...b, idx: i })).sort((a, b) => b.volume - a.volume);
    const hvnCutoff = Math.ceil(bins.length * 0.20);
    const lvnCutoffStart = bins.length - Math.ceil(bins.length * 0.20);
    const hvnSet = new Set(sortedByVol.slice(0, hvnCutoff).map(b => b.idx));
    const lvnSet = new Set(sortedByVol.slice(lvnCutoffStart).map(b => b.idx));

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
    };
  }

  // ——— AI Reversal: Cumulative Volume Delta (CVD) ——————————————————————

  async _getCvdSnapshot() {
    try {
      const candles = await this._get24hCandles5m();
      if (!candles || candles.length < CVD_LOOKBACK_BARS) return null;
      const window = candles.slice(-CVD_LOOKBACK_BARS);
      let cvd = 0;
      const cvdSeries = [];
      for (const c of window) {
        const takerBuy = c.takerBuyBaseVolume;
        const takerSell = c.volume - takerBuy;
        cvd += (takerBuy - takerSell);
        cvdSeries.push(cvd);
      }
      // Slope of the second half vs first half — relative to total absolute volume.
      const half = Math.floor(cvdSeries.length / 2);
      const firstHalfDelta = cvdSeries[half - 1] - cvdSeries[0];
      const secondHalfDelta = cvdSeries[cvdSeries.length - 1] - cvdSeries[half - 1];
      const totalVol = window.reduce((s, c) => s + c.volume, 0);
      const normalizedDelta = totalVol > 0 ? secondHalfDelta / totalVol : 0;
      let cvdTrend = 'flat';
      if (normalizedDelta > CVD_TREND_THRESHOLD_PCT) cvdTrend = 'rising';
      else if (normalizedDelta < -CVD_TREND_THRESHOLD_PCT) cvdTrend = 'falling';
      return {
        cvd,
        cvdTrend,
        firstHalfDelta,
        secondHalfDelta,
        lookbackBars: CVD_LOOKBACK_BARS,
        lookbackMinutes: CVD_LOOKBACK_BARS * 5,
      };
    } catch (error) {
      console.error(`Failed to compute CVD: ${error.message}`);
      return null;
    }
  }

  // ——— AI Reversal: Orderbook Depth Snapshot ——————————————————————————

  async _getOrderbookSnapshot() {
    const now = Date.now();
    if (this._cachedDepth && (now - this._depthCacheTime) < DEPTH_CACHE_TTL_MS) {
      return this._cachedDepth;
    }
    try {
      const depth = await this.strategy.makeProxyRequest('/fapi/v1/depth', 'GET', { symbol: this.strategy.symbol, limit: DEPTH_LIMIT }, false, 'futures');
      if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) return null;
      // Sum volume in base asset across the snapshot's top levels.
      const bidVolume = depth.bids.reduce((s, [, qty]) => s + parseFloat(qty), 0);
      const askVolume = depth.asks.reduce((s, [, qty]) => s + parseFloat(qty), 0);
      const totalVolume = bidVolume + askVolume;
      const imbalance = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;
      // Top-of-book pressure (top 10 levels) — short-term flow signal.
      const top10Bids = depth.bids.slice(0, 10).reduce((s, [, qty]) => s + parseFloat(qty), 0);
      const top10Asks = depth.asks.slice(0, 10).reduce((s, [, qty]) => s + parseFloat(qty), 0);
      const top10Total = top10Bids + top10Asks;
      const top10Imbalance = top10Total > 0 ? (top10Bids - top10Asks) / top10Total : 0;
      const result = {
        bidVolume,
        askVolume,
        imbalance,                  // -1..+1, positive = bid-heavy
        top10Bids,
        top10Asks,
        top10Imbalance,
        levels: DEPTH_LIMIT,
      };
      this._cachedDepth = result;
      this._depthCacheTime = now;
      return result;
    } catch (error) {
      console.error(`Failed to fetch orderbook depth: ${error.message}`);
      return null;
    }
  }

  // ——— AI Reversal: Build full context for the reversal planner ——————————
  // Generic market state plus the volume primitives + reversal cycle state.

  async buildReversalContext(strategyState) {
    const {
      currentSide,
      currentPosition,
      bullLevel,
      bearLevel,
      finalTpPrice,
      cycleAccumulatedLoss,
      reversalCount,
      harvestCount,
      initialCapital,
      currentInitialSize,
      walletBalance,
      positionSizeUSDT,
      minNotional,
      accumulatedRealizedPnL,
      accumulatedTradingFees,
      accumulatedFundingFees,
      previousPlan,
      planHistory,
      vetoMode,                  // Context 2 flag — bot is asking for size approval
      proposedNewSize,           // for Context 2
      consultContext,            // 'plan' | 'veto' | 'harvest_price' | 'user_question' | 'reversal_tightening'
      userQuestion,              // Context 4 — free-form question from Ask AI panel
      tighteningBounds,          // Context 5 — { low, high } price band for the refined opposite level
    } = strategyState;

    // Fetch parallel.
    const [vp24h, vp7d, cvd, depth, recentCandles, candles15m, volatility, fundingRate, marginInfo, hourlyTrend, oiChange, liquidations] = await Promise.all([
      this._getVolumeProfile('24h'),
      this._getVolumeProfile('7d'),
      this._getCvdSnapshot(),
      this._getOrderbookSnapshot(),
      this._getRecentCandles(),
      this._get15mCandles(),
      this._getVolatility(),
      this._getFundingRate(currentSide === 'LONG' ? currentPosition : null, currentSide === 'SHORT' ? currentPosition : null),
      this._getMarginInfo(),
      this._getHourlyTrend(),
      this._getOIChange(),
      this._getLiquidations(),
    ]);

    const supportResistance = await this._computeSRWithCascade(candles15m, volatility?.atr || 0);

    return {
      strategyType: 'reversal',
      consultContext: consultContext || 'plan',
      symbol: this.strategy.symbol,
      currentPrice: this.strategy.currentPrice,
      walletBalance: walletBalance || 0,
      positionSizeUSDT: positionSizeUSDT || 0,
      minNotional: minNotional || 5,
      maxPositionSizeUSDT: this.strategy.maxPositionSizeUSDT || 0,

      // Cycle state.
      currentSide: currentSide || null,
      currentPosition: currentPosition ? {
        side: currentSide,
        avgEntry: currentPosition.entryPrice || currentPosition.avgEntry,
        quantity: currentPosition.quantity,
        notional: currentPosition.notional,
        unrealizedPnl: currentPosition.unrealizedPnl || 0,
      } : null,
      bullLevel: bullLevel || null,
      bearLevel: bearLevel || null,
      finalTpPrice: finalTpPrice || null,
      cycleAccumulatedLoss: cycleAccumulatedLoss || 0,
      reversalCount: reversalCount || 0,
      harvestCount: harvestCount || 0,
      initialCapital: initialCapital || 0,
      currentInitialSize: currentInitialSize || 0,

      // Accumulators — included for AI awareness.
      accumulatedRealizedPnL: accumulatedRealizedPnL || 0,
      accumulatedTradingFees: accumulatedTradingFees || 0,
      accumulatedFundingFees: accumulatedFundingFees || 0,

      // Volume primitives — the core of reversal decision-making.
      volumeProfile24h: vp24h,
      volumeProfile7d: vp7d,
      cvd,
      orderbookDepth: depth,

      // Generic market state.
      volatility,
      recentCandles,
      fundingRate,
      marginInfo,
      hourlyTrend,
      oiChange,
      liquidations,
      supportResistance,

      // Consult-context-specific fields.
      vetoMode: !!vetoMode,
      proposedNewSize: proposedNewSize || null,
      // Context 4 — user's free-form question text. Read by
      // ai-planner._buildReversalUserMessage to inject under the
      // "USER QUESTION" footer. Forgetting this propagation makes the
      // AI respond with "no question text was provided by the user".
      userQuestion: userQuestion || null,
      // Context 5 — { low, high } price band the refined opposite reversal
      // level must fall within. Used by the planner footer + risk-guard.
      tighteningBounds: tighteningBounds || null,

      // History.
      previousPlan: previousPlan || null,
      planHistory: planHistory || [],

      // Reversal-strategy constants surfaced for the prompt.
      minLevelSpacingATR: 1.5,
      minLiqDistancePct: MIN_LIQ_DISTANCE_PCT,
    };
  }

  // ——— Support & Resistance ————————————————————————————————————————————

  _computeSRLevels(candles, lookback = 5, source = '15m', atrFloor = 0) {
    const currentPrice = this.strategy.currentPrice || 0;
    if (!currentPrice || !candles || candles.length < lookback * 2 + 1) return null;

    const swings = this._findSwingLevels(candles, lookback);

    // atrFloor enforces a hard minimum distance: every emitted support is
    // currentPrice - p >= atrFloor; every resistance is p - currentPrice >= atrFloor.
    // Levels closer than that are rejected here so the cascade can promote.
    const supports = swings.supports
      .filter(p => p < currentPrice && (currentPrice - p) >= atrFloor)
      .sort((a, b) => b - a)
      .filter((s, i, arr) => i === 0 || Math.abs(s - arr[i - 1]) / arr[i - 1] > 0.001)
      .slice(0, 3)
      .map((p, i) => ({ price: p, source, rank: i + 1 }));

    const resistances = swings.resistances
      .filter(p => p > currentPrice && (p - currentPrice) >= atrFloor)
      .sort((a, b) => a - b)
      .filter((r, i, arr) => i === 0 || Math.abs(r - arr[i - 1]) / arr[i - 1] > 0.001)
      .slice(0, 3)
      .map((p, i) => ({ price: p, source, rank: i + 1 }));

    return { supports, resistances };
  }

  /**
   * S/R cascade: 15m native → 1h → synthetic ±5x ATR.
   *
   * Distance filter (data-layer guarantee): every emitted level is ≥3x ATR
   * from current price. Levels closer than 3x ATR are rejected at each
   * rung so the cascade can promote to the next TF. This makes the rule
   * "S/R must be ≥3x ATR away from price" deterministic at the data layer
   * — the AI no longer needs to filter the levels itself.
   *
   * Per-side: supports and resistances cascade independently. If 15m has
   * 2 qualifying supports + 0 qualifying resistances, keep the 2 supports
   * as-is and only run the cascade for resistances. Within a single side,
   * the cascade replaces the whole side at the first non-empty rung (no
   * cross-TF backfill of missing slots).
   *
   * Last-resort: if 15m and 1h both fail to produce a qualifying level on
   * a side, emit a synthetic level at currentPrice ± 5x ATR with source
   * 'atr_5x_fallback' so the AI always has a usable trigger.
   *
   * Returns { supports: [...], resistances: [...] } where each level is
   * { price, source, rank }. `source` is one of:
   *   '15m', '1h_fallback', 'atr_5x_fallback'.
   */
  async _computeSRWithCascade(candles15m, atr = 0) {
    const out = { supports: [], resistances: [] };
    const currentPrice = this.strategy.currentPrice || 0;
    const atrFloor = atr * 3;  // both legs require S/R ≥3x ATR away from price

    // Rung 1: 15m native (300 bars, L=5 → ~3 days lookback)
    const native = this._computeSRLevels(candles15m, 5, '15m', atrFloor);
    if (native) {
      if (native.supports.length)    out.supports    = native.supports;
      if (native.resistances.length) out.resistances = native.resistances;
    }

    // Rung 2: 1h fallback per-side. Only fetch if at least one side is empty.
    if (out.supports.length === 0 || out.resistances.length === 0) {
      try {
        const candles1h = await this._get1hCandles();
        const sr = this._computeSRLevels(candles1h, 3, '1h_fallback', atrFloor);
        if (sr) {
          if (out.supports.length === 0    && sr.supports.length)    out.supports    = sr.supports;
          if (out.resistances.length === 0 && sr.resistances.length) out.resistances = sr.resistances;
        }
      } catch (e) {
        console.error(`S/R cascade rung 1h failed: ${e.message}`);
      }
    }

    // Last resort: synthetic ±5x ATR. Fires only when neither 15m nor 1h
    // produced a qualifying level (≥3x ATR away) on a side. Guarantees
    // the AI always sees a usable trigger.
    if ((out.supports.length === 0 || out.resistances.length === 0)
        && currentPrice > 0 && atr > 0) {
      if (out.supports.length === 0) {
        out.supports = [{ price: currentPrice - 5 * atr, source: 'atr_5x_fallback', rank: 1 }];
      }
      if (out.resistances.length === 0) {
        out.resistances = [{ price: currentPrice + 5 * atr, source: 'atr_5x_fallback', rank: 1 }];
      }
    }

    return out;
  }

  _findSwingLevels(candles, lookback = 5) {
    const supports = [];
    const resistances = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
      const window = candles.slice(i - lookback, i + lookback + 1);
      const isSwingLow = window.every((c, j) => j === lookback || c.low >= candles[i].low);
      const isSwingHigh = window.every((c, j) => j === lookback || c.high <= candles[i].high);
      if (isSwingLow) supports.push(candles[i].low);
      if (isSwingHigh) resistances.push(candles[i].high);
    }
    return { supports, resistances };
  }

  // ——— Funding Rate ————————————————————————————————————————————————————

  async _getFundingRate(longPosition, shortPosition) {
    const now = Date.now();
    if (this._cachedFundingRate && (now - this._fundingRateCacheTime) < this._fundingRateCacheTTL) {
      return this._enrichFundingRate(this._cachedFundingRate, longPosition, shortPosition);
    }
    try {
      const premiumIndex = await this.strategy.makeProxyRequest('/fapi/v1/premiumIndex', 'GET', { symbol: this.strategy.symbol }, false, 'futures');
      const rate = parseFloat(premiumIndex.lastFundingRate);
      const nextFundingTimeMs = parseInt(premiumIndex.nextFundingTime);
      const hoursUntilFunding = Math.max(0, (nextFundingTimeMs - now) / (1000 * 60 * 60));
      const nextFundingTime = `in ${Math.floor(hoursUntilFunding)}h ${Math.floor((hoursUntilFunding % 1) * 60)}m`;

      this._cachedFundingRate = { rate, nextFundingTime, nextFundingTimeMs };
      this._fundingRateCacheTime = now;
      return this._enrichFundingRate(this._cachedFundingRate, longPosition, shortPosition);
    } catch (error) {
      console.error(`Failed to fetch funding rate: ${error.message}`);
      return null;
    }
  }

  _enrichFundingRate(cached, longPosition, shortPosition) {
    const longNotional = longPosition?.notional || 0;
    const shortNotional = shortPosition?.notional || 0;
    let estimatedHourlyCost = null;
    if (longNotional > 0 || shortNotional > 0) {
      const netFundingPer8h = cached.rate * (longNotional - shortNotional);
      estimatedHourlyCost = netFundingPer8h / 8;
    }
    return { rate: cached.rate, nextFundingTime: cached.nextFundingTime, estimatedHourlyCost };
  }

  // ——— Margin Info —————————————————————————————————————————————————————

  async _getMarginInfo() {
    try {
      const [accountInfo, riskMap] = await Promise.all([
        this.strategy.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures'),
        this.strategy.getPositionRiskMap(),
      ]);
      const totalMarginBalance = parseFloat(accountInfo.totalMarginBalance);
      const totalMaintMargin = parseFloat(accountInfo.totalMaintMargin);
      const availableBalance = parseFloat(accountInfo.availableBalance);
      const totalPositionInitialMargin = parseFloat(accountInfo.totalPositionInitialMargin);

      const marginUsagePercent = totalMarginBalance > 0 ? (totalPositionInitialMargin / totalMarginBalance) * 100 : 0;
      let liquidationDistance = null;
      if (totalMaintMargin > 0 && totalMarginBalance > 0) {
        liquidationDistance = ((1 - totalMaintMargin / totalMarginBalance) * 100);
      }

      // Per-side liquidation prices + distances from current price.
      // Binance reports a liquidationPrice per position side via the risk map;
      // we surface both so the AI can reason about liquidation risk defensively.
      const currentPrice = this.strategy.currentPrice;
      const longLiqPrice = (riskMap?.LONG && riskMap.LONG > 0) ? riskMap.LONG : null;
      const shortLiqPrice = (riskMap?.SHORT && riskMap.SHORT > 0) ? riskMap.SHORT : null;
      const longLiqDistancePct = (currentPrice > 0 && longLiqPrice)
        ? ((currentPrice - longLiqPrice) / currentPrice) * 100
        : null;
      const shortLiqDistancePct = (currentPrice > 0 && shortLiqPrice)
        ? ((shortLiqPrice - currentPrice) / currentPrice) * 100
        : null;

      return {
        marginUsagePercent,
        availableBalance,
        liquidationDistance,
        longLiqPrice,
        shortLiqPrice,
        longLiqDistancePct,
        shortLiqDistancePct,
      };
    } catch (error) {
      console.error(`Failed to fetch margin info: ${error.message}`);
      return null;
    }
  }

  // ——— Hourly Trend ———————————————————————————————————————————————————

  async _getHourlyTrend() {
    try {
      const candles = await this._get1hCandles();
      if (!candles || candles.length < 20) return null;

      const closes = candles.map(c => c.close);
      const sma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
      const currentPrice = this.strategy.currentPrice || closes[closes.length - 1];
      const priceVsSma = ((currentPrice - sma20) / sma20) * 100;

      let direction;
      if (priceVsSma > 1.0) direction = 'BULLISH';
      else if (priceVsSma > 0.2) direction = 'MILDLY BULLISH';
      else if (priceVsSma > -0.2) direction = 'NEUTRAL';
      else if (priceVsSma > -1.0) direction = 'MILDLY BEARISH';
      else direction = 'BEARISH';

      const high = Math.max(...candles.map(c => c.high));
      const low = Math.min(...candles.map(c => c.low));
      const change = ((closes[closes.length - 1] - candles[0].close) / candles[0].close) * 100;

      return { direction, priceVsSma, high, low, change };
    } catch (error) {
      console.error(`Failed to calculate hourly trend: ${error.message}`);
      return null;
    }
  }

  // ——— Open Interest Change ——————————————————————————————————————————

  async _getOIChange() {
    const now = Date.now();
    if (this._cachedOIHistory && (now - this._oiCacheTime) < this._oiCacheTTL) {
      return this._cachedOIHistory;
    }
    try {
      const data = await this.strategy.makeProxyRequest('/futures/data/openInterestHist', 'GET', { symbol: this.strategy.symbol, period: '5m', limit: 12 }, false, 'futures');
      if (!data || data.length < 3) return null;

      const latest = parseFloat(data[data.length - 1].sumOpenInterestValue);
      const secondLatest = parseFloat(data[data.length - 2].sumOpenInterestValue);
      const oldest = parseFloat(data[0].sumOpenInterestValue);

      const oiChange5m = ((latest - secondLatest) / secondLatest) * 100;
      const oiChange1h = ((latest - oldest) / oldest) * 100;

      const last3 = data.slice(-3).map(d => parseFloat(d.sumOpenInterestValue));
      let oiTrend = 'FLAT';
      if (last3[2] > last3[1] && last3[1] > last3[0]) oiTrend = 'RISING';
      else if (last3[2] < last3[1] && last3[1] < last3[0]) oiTrend = 'FALLING';

      const result = { oiChange5m, oiChange1h, oiTrend, isAbnormal: Math.abs(oiChange1h) > OI_CHANGE_1H_THRESHOLD };
      this._cachedOIHistory = result;
      this._oiCacheTime = now;
      return result;
    } catch (error) {
      console.error(`Failed to fetch OI history: ${error.message}`);
      return null;
    }
  }

  // ——— Liquidations —————————————————————————————————————————————————
  // Data source: in-memory buffer in trading-base.js fed by the <symbol>@forceOrder WS stream.
  // See connectLiquidationWebSocket() + getLiquidationSnapshot() in trading-base.js.

  async _getLiquidations() {
    const snap = this.strategy.getLiquidationSnapshot();
    if (!snap) return null;
    const totalVol = snap.longLiqVolume15m + snap.shortLiqVolume15m;
    // M4: symbol-relative threshold (5% of typical 15m volume), floored at $1M.
    const baselines = await this._computeSymbolBaselines();
    const threshold = baselines.liqVolumeThreshold;
    return {
      ...snap,
      threshold,
      isAbnormal: totalVol > threshold || snap.cascadeActive,
    };
  }

  // ——— Cache Management ————————————————————————————————————————————

  invalidateCache() {
    this._cachedCandles = null;
    this._candleCacheTime = 0;
    this._cached15mCandles = null;
    this._candle15mCacheTime = 0;
    this._cached1hCandles = null;
    this._candle1hCacheTime = 0;
    this._cachedFundingRate = null;
    this._fundingRateCacheTime = 0;
    this._cachedOIHistory = null;
    this._oiCacheTime = 0;
    // AI Reversal caches.
    this._cached24hCandles5m = null;
    this._candle24hCacheTime = 0;
    this._vpCache = new Map();
    this._cachedDepth = null;
    this._depthCacheTime = 0;
  }
}

export { AiMarketContext };
export default AiMarketContext;
