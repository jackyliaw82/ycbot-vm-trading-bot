// Abnormality thresholds — metric is included in AI prompt only when exceeded.
// FLOORS only — the actual threshold is max(floor, symbol-relative baseline)
// computed in _computeSymbolBaselines (M4 + M5 fix). The constants below
// guarantee BTC won't flag every 0.5% OI swing as "abnormal", and ensure
// extremely quiet symbols still have a meaningful trip threshold.
const OI_CHANGE_1H_THRESHOLD = 2;          // floor: |oiChange1h| > 2%
const LIQ_VOLUME_15M_THRESHOLD = 1_000_000; // floor: liqs > $1M in 15m
const VOLUME_RATIO_HIGH = 3.0;             // already symbol-relative (ratio)
const VOLUME_RATIO_LOW = 0.3;              // already symbol-relative (ratio)
const TAKER_RATIO_HIGH = 1.5;              // floor: hard ceiling regardless of baseline
const TAKER_RATIO_LOW = 0.6;               // floor: hard floor regardless of baseline

// M4 + M5 — symbol-relative scaling. Recomputed every 6h.
const SYMBOL_BASELINE_TTL_MS = 6 * 60 * 60 * 1000;
const LIQ_VOLUME_PCT_OF_15M_VOLUME = 0.05;   // flag liqs > 5% of typical 15m volume

// Liquidation-aware DCA sizing (Phase 2 hard ceiling, Phase 1 soft target).
// Each ADD must keep that leg's projected liq distance >= MIN_LIQ_DISTANCE_PCT.
// 8% leaves a meaningful safety margin even with sub-second adverse moves.
const MIN_LIQ_DISTANCE_PCT = 8;

// Paired-trigger DCA (v2.0.0+): hedge-ratio band and shadow trigger distance.
// Shadow qty is clamped at the executor layer so post-fill ratio stays within
// the band on a one-sided fill. Shadow distance defines the gap between a
// primary trigger and its paired shadow on the opposite leg (1×ATR).
const RATIO_BAND_LOWER = 0.85;
const RATIO_BAND_UPPER = 1.15;
const SHADOW_DISTANCE_ATR = 1;

/**
 * AiMarketContext — builds market context for AI plan generation.
 *
 * Gathers: price candles (5m/15m/1h, plus 4h/1d on S/R cascade fire),
 * ATR volatility, support/resistance with multi-TF cascade fallback,
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

    // 1h candle cache (for broader trend + S/R cascade rung 2)
    this._cached1hCandles = null;
    this._candle1hCacheTime = 0;
    this._candle1hCacheTTL = 30 * 60 * 1000;

    // 4h candle cache (S/R cascade rung 3)
    this._cached4hCandles = null;
    this._candle4hCacheTime = 0;
    this._candle4hCacheTTL = 60 * 60 * 1000;

    // 1d candle cache (S/R cascade rung 4 + prior-week H/L floor)
    this._cached1dCandles = null;
    this._candle1dCacheTime = 0;
    this._candle1dCacheTTL = 6 * 60 * 60 * 1000;

    // Funding rate cache
    this._cachedFundingRate = null;
    this._fundingRateCacheTime = 0;
    this._fundingRateCacheTTL = 5 * 60 * 1000;

    // OI history cache
    this._cachedOIHistory = null;
    this._oiCacheTime = 0;
    this._oiCacheTTL = 5 * 60 * 1000;

    // Taker buy/sell ratio cache
    this._cachedTakerRatio = null;
    this._takerRatioCacheTime = 0;
    this._takerRatioCacheTTL = 5 * 60 * 1000;

    // Global long/short account ratio cache
    this._cachedGlobalLSRatio = null;
    this._globalLSRatioCacheTime = 0;
    this._globalLSRatioCacheTTL = 5 * 60 * 1000;

    // M4 + M5 — symbol-relative threshold cache. Refreshed every 6h.
    this._symbolBaselines = null;
    this._symbolBaselinesAt = 0;
  }

  /**
   * M4 + M5 — compute symbol-relative thresholds from recent baseline data.
   * Cached for SYMBOL_BASELINE_TTL_MS. Each threshold is `max(floor, baseline)`
   * so very low-vol symbols still have meaningful trip thresholds and very
   * high-vol symbols don't flag every routine fluctuation.
   *
   * Sources:
   *   - liquidation threshold ← /fapi/v1/ticker/24hr quoteVolume / 96 (15m windows)
   *   - taker ratio band      ← /futures/data/takerlongshortRatio period=1h, limit=24
   *
   * Caller (buildContext) awaits this before evaluating any abnormality flags.
   */
  async _computeSymbolBaselines() {
    const now = Date.now();
    if (this._symbolBaselines && (now - this._symbolBaselinesAt) < SYMBOL_BASELINE_TTL_MS) {
      return this._symbolBaselines;
    }
    const symbol = this.strategy.symbol;
    const baselines = {
      liqVolumeThreshold: LIQ_VOLUME_15M_THRESHOLD,
      takerRatioHigh: TAKER_RATIO_HIGH,
      takerRatioLow: TAKER_RATIO_LOW,
    };
    try {
      const [ticker24h, takerHistory] = await Promise.all([
        this.strategy.makeProxyRequest('/fapi/v1/ticker/24hr', 'GET', { symbol }, false, 'futures').catch(() => null),
        this.strategy.makeProxyRequest('/futures/data/takerlongshortRatio', 'GET', { symbol, period: '1h', limit: 24 }, false, 'futures').catch(() => null),
      ]);

      // M4: liquidation threshold = max($1M floor, 5% of typical 15m quote volume).
      if (ticker24h && ticker24h.quoteVolume) {
        const quoteVolume24h = parseFloat(ticker24h.quoteVolume);
        const typical15m = quoteVolume24h / 96;
        const scaled = typical15m * LIQ_VOLUME_PCT_OF_15M_VOLUME;
        baselines.liqVolumeThreshold = Math.max(LIQ_VOLUME_15M_THRESHOLD, scaled);
      }

      // M5: taker ratio band = max(floor, p90)/min(floor, p10) of 24h history.
      // Memecoins routinely sit at 1.5+ baseline; this lifts the trip line so
      // we only flag when CURRENT taker ratio exceeds even the symbol's own
      // recent extremes. Conservative buffer (+/- 0.1) keeps a ceiling.
      if (Array.isArray(takerHistory) && takerHistory.length >= 12) {
        const ratios = takerHistory
          .map(d => parseFloat(d.buySellRatio))
          .filter(r => Number.isFinite(r) && r > 0)
          .sort((a, b) => a - b);
        if (ratios.length >= 12) {
          const p10 = ratios[Math.floor(ratios.length * 0.10)];
          const p90 = ratios[Math.floor(ratios.length * 0.90)];
          baselines.takerRatioHigh = Math.max(TAKER_RATIO_HIGH, p90 + 0.1);
          baselines.takerRatioLow = Math.min(TAKER_RATIO_LOW, p10 - 0.1);
        }
      }

      this._symbolBaselines = baselines;
      this._symbolBaselinesAt = now;
    } catch (err) {
      console.error(`[BASELINES] failed for ${symbol}: ${err.message}`);
    }
    return baselines;
  }

  /**
   * Build the full context object for the AI planner.
   */
  async buildContext(strategyState) {
    const {
      phase,
      longPosition,
      shortPosition,
      hedgeGap,
      lockedProfit,
      totalPnL,
      desiredProfitUSDT,
      effectiveTarget,
      walletBalance,
      positionSizeUSDT,
      minNotional,
      accumulatedRealizedPnL,
      accumulatedTradingFees,
      accumulatedFundingFees,
      previousPlan,
      planHistory,
      firstPositionPrice,
    } = strategyState;

    // Fetch all market data in parallel
    const [recentCandles, candles15m, volatility, fundingRate, marginInfo, hourlyTrend, oiChange, liquidations, globalLSRatio] = await Promise.all([
      this._getRecentCandles(),
      this._get15mCandles(),
      this._getVolatility(),
      this._getFundingRate(longPosition, shortPosition),
      this._getMarginInfo(),
      this._getHourlyTrend(),
      this._getOIChange(),
      this._getLiquidations(),
      this._getGlobalLSRatio(),
    ]);

    // M5: ATR-relative OI threshold — high-vol symbols tolerate bigger 1h
    // swings before flagging as abnormal. ATR percentage of price is a clean
    // proxy for "normal" hourly fluctuation magnitude.
    if (oiChange && volatility?.atrPercent != null) {
      const oiThreshold = Math.max(OI_CHANGE_1H_THRESHOLD, volatility.atrPercent);
      oiChange.threshold = oiThreshold;
      oiChange.isAbnormal = Math.abs(oiChange.oiChange1h) > oiThreshold;
    }

    // Compute price direction from candles for taker ratio divergence detection
    let priceDirection = null;
    if (recentCandles && recentCandles.length >= 2) {
      const firstClose = recentCandles[0].close;
      const lastClose = recentCandles[recentCandles.length - 1].close;
      priceDirection = lastClose > firstClose ? 'UP' : 'DOWN';
    }

    // Taker ratio depends on price direction
    const takerRatio = await this._getTakerRatio(priceDirection);

    // Volume ratio computed from already-fetched candles (no API call)
    const volumeRatio = this._getVolumeRatio(recentCandles);

    // S/R levels — 15m native with per-side cascade fallback to 1h → 4h → 1d → prior-week H/L,
    // then synthetic ±5x ATR if everything else is rejected. Every emitted level is guaranteed
    // ≥3x ATR from current price (data-layer filter inside the cascade).
    const supportResistance = await this._computeSRWithCascade(candles15m, volatility?.atr || 0);

    return {
      symbol: this.strategy.symbol,
      currentPrice: this.strategy.currentPrice,
      phase: phase || 'INITIAL',
      walletBalance: walletBalance || 0,
      positionSizeUSDT: positionSizeUSDT || 0,
      minNotional: minNotional || 5,
      maxPositionSizeUSDT: this.strategy.maxPositionSizeUSDT || 0,

      longPosition: longPosition ? {
        avgEntry: longPosition.entryPrice || longPosition.avgEntry,
        quantity: longPosition.quantity,
        notional: longPosition.notional,
        unrealizedPnl: longPosition.unrealizedPnl || 0,
      } : null,

      shortPosition: shortPosition ? {
        avgEntry: shortPosition.entryPrice || shortPosition.avgEntry,
        quantity: shortPosition.quantity,
        notional: shortPosition.notional,
        unrealizedPnl: shortPosition.unrealizedPnl || 0,
      } : null,

      hedgeGap: hedgeGap || 0,
      lockedProfit: lockedProfit || 0,
      totalPnL: totalPnL || 0,
      desiredProfitUSDT: desiredProfitUSDT || null,
      effectiveTarget: effectiveTarget || null,
      firstPositionPrice: firstPositionPrice || null,

      accumulatedRealizedPnL: accumulatedRealizedPnL || 0,
      accumulatedTradingFees: accumulatedTradingFees || 0,
      accumulatedFundingFees: accumulatedFundingFees || 0,

      volatility,
      recentCandles,
      candles15m,
      fundingRate,
      marginInfo,
      hourlyTrend,
      oiChange,
      liquidations,
      volumeRatio,
      takerRatio,
      globalLSRatio,
      supportResistance,
      previousPlan: previousPlan || null,
      planHistory: planHistory || [],

      // Liquidation-aware sizing caps. Computed per-leg from current
      // liqDistance + leg notional. Phase 1 (no positions) skips this and
      // uses the leverage-based projection in the system prompt instead.
      liquidationCaps: this._computeLiquidationCaps(longPosition, shortPosition, marginInfo),
      minLiqDistancePct: MIN_LIQ_DISTANCE_PCT,

      // Paired-trigger DCA constants surfaced for the prompt + executor.
      // The AI uses these to pre-clamp shadow qty proposals; the executor
      // re-clamps as a safety net.
      ratioBand: { lower: RATIO_BAND_LOWER, upper: RATIO_BAND_UPPER },
      shadowDistanceATR: SHADOW_DISTANCE_ATR,
      shadowDistance: (volatility?.atr || 0) * SHADOW_DISTANCE_ATR,
    };
  }

  /**
   * Per-leg max safe ADD notional that keeps projected liq distance
   * >= MIN_LIQ_DISTANCE_PCT.
   *
   * Two cases per leg:
   *
   * 1. **Binding leg** — the side whose Binance-reported liq price is on the
   *    correct side of current price (LONG liq < currentPrice, SHORT liq >
   *    currentPrice). This is the side that would actually liquidate if price
   *    moved against it. Cap by the inverse-notional approximation:
   *      projectedLiqDistance ≈ currentDist × legNotional / (legNotional + addNotional)
   *      maxAdd = legNotional × (currentDist - minDist) / minDist
   *
   * 2. **Non-binding leg** — the side whose reported liq is on the WRONG
   *    side of current price (LONG liq ≥ currentPrice, OR SHORT liq ≤
   *    currentPrice). This happens in cross-margin hedge mode when both
   *    legs are open and Binance reports the WALLET's combined liq price
   *    (which is on the dominant net-exposure side) for both per-side
   *    entries. The non-binding leg is the OFFSET — adding to it shrinks
   *    net exposure and IMPROVES liquidation safety, not worsens it.
   *    Cap only by remaining max-position-size capacity.
   *
   * Without this distinction (v1.0.27 bug), the bot computed a negative
   * liq distance for the non-binding leg (e.g. SHORT at 84.04 with reported
   * liq 43.35 → distance = (43.35 - 84.04)/84.04 = -48%) and treated that
   * as "below the 8% floor", blocking the only safe action. Fixed in v1.0.28.
   *
   * Returns null fields when the leg has no current liq data (e.g. the leg
   * doesn't exist yet, or Binance hasn't returned a liq price).
   */
  _computeLiquidationCaps(longPosition, shortPosition, marginInfo) {
    if (!marginInfo) return null;
    const minDist = MIN_LIQ_DISTANCE_PCT;
    const currentPrice = this.strategy.currentPrice || 0;
    const maxTotal = this.strategy.maxPositionSizeUSDT || 0;

    let maxAddLongUSDT = null;
    let maxAddShortUSDT = null;
    let longBinding = false;
    let shortBinding = false;

    const longNotional = longPosition?.notional || 0;
    const shortNotional = shortPosition?.notional || 0;
    const totalNotional = longNotional + shortNotional;
    const remainingCapacity = Math.max(0, maxTotal - totalNotional);

    const longLiqPrice = marginInfo.longLiqPrice;
    const shortLiqPrice = marginInfo.shortLiqPrice;
    const longDist = marginInfo.longLiqDistancePct;
    const shortDist = marginInfo.shortLiqDistancePct;

    // LONG leg: binding when liq price is BELOW current price (the natural direction).
    if (longNotional > 0) {
      longBinding = longLiqPrice != null && longLiqPrice > 0 && currentPrice > 0
        && longLiqPrice < currentPrice;
      if (longBinding && longDist != null) {
        maxAddLongUSDT = longDist <= minDist
          ? 0
          : Math.max(0, longNotional * (longDist - minDist) / minDist);
      } else {
        // Non-binding (or no data) — fall back to position-size cap only.
        maxAddLongUSDT = remainingCapacity;
      }
      // Always also bounded by remaining capacity, never above it.
      maxAddLongUSDT = Math.min(maxAddLongUSDT, remainingCapacity);
    }

    // SHORT leg: binding when liq price is ABOVE current price.
    if (shortNotional > 0) {
      shortBinding = shortLiqPrice != null && shortLiqPrice > 0 && currentPrice > 0
        && shortLiqPrice > currentPrice;
      if (shortBinding && shortDist != null) {
        maxAddShortUSDT = shortDist <= minDist
          ? 0
          : Math.max(0, shortNotional * (shortDist - minDist) / minDist);
      } else {
        maxAddShortUSDT = remainingCapacity;
      }
      maxAddShortUSDT = Math.min(maxAddShortUSDT, remainingCapacity);
    }

    return { maxAddLongUSDT, maxAddShortUSDT, longBinding, shortBinding };
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

  async _get4hCandles() {
    const now = Date.now();
    if (this._cached4hCandles && (now - this._candle4hCacheTime) < this._candle4hCacheTTL) {
      return this._cached4hCandles;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol: this.strategy.symbol, interval: '4h', limit: 120 }, false, 'futures');
      this._cached4hCandles = this._parseKlines(klines);
      this._candle4hCacheTime = now;
      return this._cached4hCandles;
    } catch (error) {
      console.error(`Failed to fetch 4h candles: ${error.message}`);
      return this._cached4hCandles || [];
    }
  }

  async _get1dCandles() {
    const now = Date.now();
    if (this._cached1dCandles && (now - this._candle1dCacheTime) < this._candle1dCacheTTL) {
      return this._cached1dCandles;
    }
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol: this.strategy.symbol, interval: '1d', limit: 60 }, false, 'futures');
      this._cached1dCandles = this._parseKlines(klines);
      this._candle1dCacheTime = now;
      return this._cached1dCandles;
    } catch (error) {
      console.error(`Failed to fetch 1d candles: ${error.message}`);
      return this._cached1dCandles || [];
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
    }));
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
   * S/R cascade: 15m native → 1h → 4h → 1d → prior-week H/L → synthetic ±5x ATR.
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
   * Last-resort: if cascade is exhausted (including prior-week H/L) on a
   * side, emit a synthetic level at currentPrice ± 5x ATR with source
   * 'atr_5x_fallback' so the AI always has a usable trigger.
   *
   * Returns { supports: [...], resistances: [...] } where each level is
   * { price, source, rank }. `source` is one of:
   *   '15m', '1h_fallback', '4h_fallback', '1d_fallback',
   *   'prior_week_low', 'prior_week_high', 'atr_5x_fallback'.
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

    // Rung 2-4: cascade per-side. Only fetch a higher TF if at least one
    // side is still empty.
    if (out.supports.length === 0 || out.resistances.length === 0) {
      const ladder = [
        { tf: '1h', source: '1h_fallback', L: 3, fetch: () => this._get1hCandles() },
        { tf: '4h', source: '4h_fallback', L: 3, fetch: () => this._get4hCandles() },
        { tf: '1d', source: '1d_fallback', L: 2, fetch: () => this._get1dCandles() },
      ];
      for (const rung of ladder) {
        if (out.supports.length > 0 && out.resistances.length > 0) break;
        try {
          const candles = await rung.fetch();
          const sr = this._computeSRLevels(candles, rung.L, rung.source, atrFloor);
          if (!sr) continue;
          if (out.supports.length === 0    && sr.supports.length)    out.supports    = sr.supports;
          if (out.resistances.length === 0 && sr.resistances.length) out.resistances = sr.resistances;
        } catch (e) {
          console.error(`S/R cascade rung ${rung.tf} failed: ${e.message}`);
        }
      }
    }

    // Rung 5: deterministic floor — prior-week H/L from last 7 daily candles.
    // Same 3x ATR distance filter applies; if the prior-week H/L is closer than
    // that to current price, treat as not found.
    if (out.supports.length === 0 || out.resistances.length === 0) {
      try {
        const dailyCandles = await this._get1dCandles();
        const last7 = (dailyCandles || []).slice(-7);
        if (last7.length > 0) {
          const wkHigh = Math.max(...last7.map(c => c.high));
          const wkLow  = Math.min(...last7.map(c => c.low));
          if (out.supports.length === 0 && wkLow > 0 && wkLow < currentPrice
              && (currentPrice - wkLow) >= atrFloor) {
            out.supports = [{ price: wkLow, source: 'prior_week_low', rank: 1 }];
          }
          if (out.resistances.length === 0 && wkHigh > 0 && wkHigh > currentPrice
              && (wkHigh - currentPrice) >= atrFloor) {
            out.resistances = [{ price: wkHigh, source: 'prior_week_high', rank: 1 }];
          }
        }
      } catch (e) {
        console.error(`Prior-week H/L derivation failed: ${e.message}`);
      }
    }

    // Last resort: synthetic ±5x ATR. Fires only when no qualifying level
    // (≥3x ATR away) was found anywhere in the cascade — including the
    // prior-week H/L. Guarantees the AI always sees a usable trigger.
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

      // Per-leg liquidation prices + distances from current price.
      // Binance reports a separate liquidationPrice for each side in hedge
      // mode; we surface both so the AI can size each DCA defensively.
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

  // ——— Relative Volume Ratio ————————————————————————————————————————

  _getVolumeRatio(recentCandles) {
    if (!recentCandles || recentCandles.length < 21) return null;

    const avgWindow = recentCandles.slice(-21, -1);
    const avgVolume = avgWindow.reduce((sum, c) => sum + c.volume, 0) / avgWindow.length;
    if (avgVolume === 0) return null;

    const latestVolume = recentCandles[recentCandles.length - 1].volume;
    const volumeRatio = latestVolume / avgVolume;

    const last5 = recentCandles.slice(-5);
    const aboveAvgCount = last5.filter(c => c.volume > avgVolume).length;
    let volumeTrend = 'STABLE';
    if (aboveAvgCount >= 3) volumeTrend = 'RISING';
    else if (last5.filter(c => c.volume < avgVolume * 0.5).length >= 3) volumeTrend = 'FALLING';

    return { volumeRatio, volumeTrend, isAbnormal: volumeRatio > VOLUME_RATIO_HIGH || volumeRatio < VOLUME_RATIO_LOW };
  }

  // ——— Taker Buy/Sell Ratio ————————————————————————————————————————

  async _getTakerRatio(priceDirection) {
    const now = Date.now();
    // M5: symbol-relative high/low band, recomputed every 6h.
    const baselines = await this._computeSymbolBaselines();
    const hi = baselines.takerRatioHigh;
    const lo = baselines.takerRatioLow;
    if (this._cachedTakerRatio && (now - this._takerRatioCacheTime) < this._takerRatioCacheTTL) {
      const cached = { ...this._cachedTakerRatio };
      cached.divergence = this._checkTakerDivergence(cached.takerRatio, priceDirection);
      cached.thresholdHigh = hi;
      cached.thresholdLow = lo;
      cached.isAbnormal = cached.takerRatio > hi || cached.takerRatio < lo || cached.divergence;
      return cached;
    }
    try {
      const data = await this.strategy.makeProxyRequest('/futures/data/takerlongshortRatio', 'GET', { symbol: this.strategy.symbol, period: '5m', limit: 6 }, false, 'futures');
      if (!data || data.length < 2) return null;

      const takerRatio = parseFloat(data[data.length - 1].buySellRatio);
      const firstHalf = data.slice(0, 3).map(d => parseFloat(d.buySellRatio));
      const secondHalf = data.slice(-3).map(d => parseFloat(d.buySellRatio));
      const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

      let takerTrend = 'STABLE';
      if (secondAvg > firstAvg * 1.1) takerTrend = 'BUYING_INCREASING';
      else if (secondAvg < firstAvg * 0.9) takerTrend = 'SELLING_INCREASING';

      const divergence = this._checkTakerDivergence(takerRatio, priceDirection);
      const result = { takerRatio, takerTrend, divergence, thresholdHigh: hi, thresholdLow: lo, isAbnormal: takerRatio > hi || takerRatio < lo || divergence };
      this._cachedTakerRatio = result;
      this._takerRatioCacheTime = now;
      return result;
    } catch (error) {
      console.error(`Failed to fetch taker ratio: ${error.message}`);
      return null;
    }
  }

  _checkTakerDivergence(takerRatio, priceDirection) {
    if (!priceDirection) return false;
    return (priceDirection === 'UP' && takerRatio < 0.8) || (priceDirection === 'DOWN' && takerRatio > 1.2);
  }

  // ——— Global Long/Short Account Ratio ——————————————————————————————

  async _getGlobalLSRatio() {
    const now = Date.now();
    if (this._cachedGlobalLSRatio && (now - this._globalLSRatioCacheTime) < this._globalLSRatioCacheTTL) {
      return this._cachedGlobalLSRatio;
    }
    try {
      const data = await this.strategy.makeProxyRequest('/futures/data/globalLongShortAccountRatio', 'GET', { symbol: this.strategy.symbol, period: '5m', limit: 6 }, false, 'futures');
      if (!data || data.length < 2) return null;

      const latest = data[data.length - 1];
      const longAccount = parseFloat(latest.longAccount);
      const shortAccount = parseFloat(latest.shortAccount);
      const longShortRatio = parseFloat(latest.longShortRatio);

      // Trend: compare first half vs second half
      const firstHalf = data.slice(0, 3).map(d => parseFloat(d.longShortRatio));
      const secondHalf = data.slice(-3).map(d => parseFloat(d.longShortRatio));
      const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

      let trend = 'STABLE';
      if (secondAvg > firstAvg * 1.05) trend = 'MORE_LONGS';
      else if (secondAvg < firstAvg * 0.95) trend = 'MORE_SHORTS';

      // Extreme positioning (contrarian signal)
      const isExtreme = longAccount > 0.65 || shortAccount > 0.65;

      const result = { longAccount, shortAccount, longShortRatio, trend, isExtreme };
      this._cachedGlobalLSRatio = result;
      this._globalLSRatioCacheTime = now;
      return result;
    } catch (error) {
      console.error(`Failed to fetch global L/S ratio: ${error.message}`);
      return null;
    }
  }

  // ——— Cache Management ————————————————————————————————————————————

  invalidateCache() {
    this._cachedCandles = null;
    this._candleCacheTime = 0;
    this._cached15mCandles = null;
    this._candle15mCacheTime = 0;
    this._cached1hCandles = null;
    this._candle1hCacheTime = 0;
    this._cached4hCandles = null;
    this._candle4hCacheTime = 0;
    this._cached1dCandles = null;
    this._candle1dCacheTime = 0;
    this._cachedFundingRate = null;
    this._fundingRateCacheTime = 0;
    this._cachedOIHistory = null;
    this._oiCacheTime = 0;
    this._cachedTakerRatio = null;
    this._takerRatioCacheTime = 0;
    this._cachedGlobalLSRatio = null;
    this._globalLSRatioCacheTime = 0;
  }
}

export { AiMarketContext };
export default AiMarketContext;
