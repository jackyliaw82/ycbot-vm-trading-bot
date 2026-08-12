// Volume Analytics primitives — CVD, orderbook depth, ATR volatility, funding
// rate, open interest. Salvaged from ai-market-context.js (dca19c0) when the
// AI stack was deleted; these fed the AI prompt then, and feed the frontend's
// Volume Analytics panel now.
//
// NOT display-only. Every fetcher in this file ALSO feeds
// buildLevelContext -> planLevels (level-planner.js) for the breakout
// strategy, which turns these values into real bullLevel/bearLevel exits
// (entries are DERIVED from them via breakoutPct) — a trading path.
// "Best effort: log and return the last snapshot (or null) rather than
// throw" is still the right default (a Binance hiccup must not crash a cycle
// start), but it is no longer an AUTOMATICALLY SAFE default the way it was
// when this module only drew a chart panel. An unknown reading must be
// representable as ABSENT downstream — null, or a sentinel a caller is
// forced to check (computeATR's `interpretation: 'unknown'`) — never as a
// bare zero or a silently-stale cache entry standing in for live data. A
// fetcher that hands the level planner a real-looking number for "I don't
// know" turns a display-grade tradeoff into a fail-open on a live order.

import { parseKlines } from './volume-profile.js';

const CANDLE_15M_CACHE_TTL_MS = 15 * 60 * 1000;  // 15m candle cache (ATR source)
const CANDLE_5M_CACHE_TTL_MS = 5 * 60 * 1000;    // 5m candle cache (CVD source)
const ATR_15M_BARS = 300;                        // 15m × 300 — well over the 14-period ATR window
const ATR_PERIOD = 14;                           // Wilder's default
const CVD_24H_5M_BARS = 288;                     // 5m × 288 = 24h (CVD source)
const CVD_LOOKBACK_BARS = 24;                    // 24 × 5m = 2h CVD window
const CVD_TREND_THRESHOLD_PCT = 0.05;            // 5% slope threshold for rising/falling
const DEPTH_CACHE_TTL_MS = 30 * 1000;            // 30s depth snapshot cadence
const DEPTH_LIMIT = 100;                         // top-100 levels each side
const FUNDING_CACHE_TTL_MS = 5 * 60 * 1000;   // funding settles 8-hourly; 5 min is ample
const OI_CACHE_TTL_MS = 5 * 60 * 1000;        // OI history is 5m-bucketed
const STALE_CACHE_MULTIPLIER = 3;             // serve a failed-fetch cache up to 3x its TTL old, then null

/**
 * ATR (Average True Range) over the last `period` candles, plus the same value
 * as a percentage of price and a coarse band label.
 *
 * `currentPrice` is the live mark when available; it falls back to the last
 * close so the maths still works on a cold cache.
 *
 * Returns { atr, atrPercent, interpretation } — never null, because the
 * caller renders it directly. `interpretation: 'unknown'` with zeroes is the
 * not-enough-data answer.
 */
export function computeATR(candles, period = ATR_PERIOD, currentPrice = null) {
  // Need period+1 candles: each true range compares a candle to its predecessor.
  if (!candles || candles.length < period + 1) {
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
  const price = currentPrice || candles[candles.length - 1].close;
  const atrPercent = price > 0 ? (atr / price) * 100 : 0;

  let interpretation;
  if (atrPercent < 0.5) interpretation = 'low';
  else if (atrPercent < 1.0) interpretation = 'moderate';
  else if (atrPercent < 2.0) interpretation = 'high';
  else interpretation = 'extreme';

  return { atr, atrPercent, interpretation };
}

/**
 * Cumulative Volume Delta over the trailing CVD_LOOKBACK_BARS.
 *
 * Each bar contributes takerBuy − takerSell (taker sell is inferred as
 * volume − takerBuyBaseVolume; Binance only reports the buy side). The trend
 * compares the second half's delta to the first half's, normalized by total
 * volume so the threshold means the same thing on BTC and on a thin alt.
 *
 * Returns null when there is not a full window — a partial CVD reads as a
 * real number but means nothing.
 */
export function computeCvd(candles) {
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
}

/**
 * Reduce a raw Binance depth payload to the bid/ask volumes and imbalances the
 * panel shows. Returns null on a malformed payload rather than emitting NaNs.
 */
export function summarizeDepth(depth) {
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
  return {
    bidVolume,
    askVolume,
    imbalance,                  // -1..+1, positive = bid-heavy
    top10Bids,
    top10Asks,
    top10Imbalance,
    levels: DEPTH_LIMIT,
  };
}

/**
 * Bound how long a failed-fetch may keep serving its last cached value. A few
 * fetchers below (funding, OI) reuse the cache on error WITHOUT refreshing
 * its timestamp, so left unbounded that reading would be served forever
 * until the next success. Beyond `multiplier x ttlMs` old, treat it as gone.
 */
function staleCacheOrNull(cached, ttlMs, now, multiplier = STALE_CACHE_MULTIPLIER) {
  if (!cached) return null;
  return (now - cached.ts) < ttlMs * multiplier ? cached.value : null;
}

/**
 * MarketMetrics — market-data fetchers, keyed by symbol. Feeds BOTH the
 * frontend's display-only Volume Analytics panel AND buildLevelContext ->
 * planLevels for the breakout strategy (a trading path) — see the file header.
 * `strategy` supplies makeProxyRequest + currentPrice — the same duck-typed
 * surface VolumeProfile takes; this class does not invent a new transport.
 */
export class MarketMetrics {
  constructor(strategy) {
    this.strategy = strategy;
    this._candle15mCache = new Map();  // symbol -> { candles, ts }
    this._candle5mCache = new Map();   // symbol -> { candles, ts }
    this._depthCache = new Map();      // symbol -> { depth, ts }
    this._fundingCache = new Map();   // symbol -> { value, ts }
    this._oiCache = new Map();        // symbol -> { value, ts }
  }

  // ——— Candle fetchers ————————————————————————————————————————————————
  // Two separate windows because the two metrics need different resolutions:
  // ATR wants 15m bars (noise-tolerant), CVD wants a 24h 5m window. Each
  // returns the stale cache on a fetch failure — a display metric one refresh
  // out of date beats a hole in the panel.

  async _get15mCandles(symbol) {
    const now = Date.now();
    const cached = this._candle15mCache.get(symbol);
    if (cached && (now - cached.ts) < CANDLE_15M_CACHE_TTL_MS) return cached.candles;
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol, interval: '15m', limit: ATR_15M_BARS }, false, 'futures');
      const candles = parseKlines(klines);
      this._candle15mCache.set(symbol, { candles, ts: now });
      return candles;
    } catch (error) {
      console.error(`Failed to fetch 15m candles: ${error.message}`);
      return cached?.candles || [];
    }
  }

  async _get24hCandles5m(symbol) {
    const now = Date.now();
    const cached = this._candle5mCache.get(symbol);
    if (cached && (now - cached.ts) < CANDLE_5M_CACHE_TTL_MS) return cached.candles;
    try {
      const klines = await this.strategy.makeProxyRequest('/fapi/v1/klines', 'GET', { symbol, interval: '5m', limit: CVD_24H_5M_BARS }, false, 'futures');
      const candles = parseKlines(klines);
      this._candle5mCache.set(symbol, { candles, ts: now });
      return candles;
    } catch (error) {
      console.error(`Failed to fetch 24h (5m) candles: ${error.message}`);
      return cached?.candles || [];
    }
  }

  // ——— Metrics ————————————————————————————————————————————————————————

  async getVolatility(symbol) {
    try {
      const candles = await this._get15mCandles(symbol);
      return computeATR(candles, ATR_PERIOD, this.strategy.currentPrice);
    } catch (error) {
      console.error(`Failed to calculate ATR: ${error.message}`);
      return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
    }
  }

  async getCvd(symbol) {
    try {
      const candles = await this._get24hCandles5m(symbol);
      return computeCvd(candles);
    } catch (error) {
      console.error(`Failed to compute CVD: ${error.message}`);
      return null;
    }
  }

  async getOrderbookDepth(symbol) {
    const now = Date.now();
    const cached = this._depthCache.get(symbol);
    if (cached && (now - cached.ts) < DEPTH_CACHE_TTL_MS) return cached.depth;
    try {
      const raw = await this.strategy.makeProxyRequest('/fapi/v1/depth', 'GET', { symbol, limit: DEPTH_LIMIT }, false, 'futures');
      const depth = summarizeDepth(raw);
      if (depth) this._depthCache.set(symbol, { depth, ts: now });
      return depth;
    } catch (error) {
      console.error(`Failed to fetch orderbook depth: ${error.message}`);
      return cached?.depth || null;
    }
  }

  /**
   * Funding rate + time to next settlement. Restored from the deleted
   * ai-market-context.js (_getFundingRate), minus the position-notional
   * enrichment — the level planner reasons about the RATE, not this account's
   * exposure, and passing exposure in would leak position state into a prompt
   * that is supposed to describe the market.
   *
   * DEVIATION FROM THE ORIGINAL: the original returned null outright on a
   * failed fetch. This one serves the last cached value instead, bounded to
   * STALE_CACHE_MULTIPLIER x FUNDING_CACHE_TTL_MS (see staleCacheOrNull) —
   * funding settles 8-hourly, so a reading up to 15 minutes stale is still
   * representative. Beyond that bound, or with nothing cached, this returns
   * null; callers treat a null as "unknown" and omit the field, and funding is
   * one input among many that must never block a cycle start.
   */
  async getFundingRate(symbol) {
    const now = Date.now();
    const cached = this._fundingCache.get(symbol);
    if (cached && (now - cached.ts) < FUNDING_CACHE_TTL_MS) return cached.value;
    try {
      const premiumIndex = await this.strategy.makeProxyRequest('/fapi/v1/premiumIndex', 'GET', { symbol }, false, 'futures');
      const rate = parseFloat(premiumIndex?.lastFundingRate);
      if (!Number.isFinite(rate)) return null;
      const nextMs = parseInt(premiumIndex?.nextFundingTime, 10);
      let nextFundingTime = null;
      if (Number.isFinite(nextMs)) {
        const hours = Math.max(0, (nextMs - now) / 3_600_000);
        nextFundingTime = `in ${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`;
      }
      const value = { rate, nextFundingTime };
      this._fundingCache.set(symbol, { value, ts: now });
      return value;
    } catch (error) {
      console.error(`Failed to fetch funding rate: ${error.message}`);
      return staleCacheOrNull(cached, FUNDING_CACHE_TTL_MS, now);
    }
  }

  /**
   * Open-interest change over the last 5m and 1h, plus a coarse trend.
   * Restored from the deleted ai-market-context.js (_getOIChange).
   *
   * Every percentage divides by an earlier reading, so a zero baseline is
   * rejected outright rather than emitted as Infinity — an Infinity here would
   * reach the prompt as market data.
   *
   * DEVIATION FROM THE ORIGINAL: the original returned null outright on a
   * failed fetch. This one serves the last cached value instead, but ONLY up
   * to STALE_CACHE_MULTIPLIER x OI_CACHE_TTL_MS old (see staleCacheOrNull) —
   * unlike funding, OI's entire meaning is "change over the last 5m/1h", so
   * serving an hours-old reading as current would misrepresent it as fresh.
   * Beyond that bound, or with nothing cached, this returns null.
   */
  async getOpenInterestChange(symbol) {
    const now = Date.now();
    const cached = this._oiCache.get(symbol);
    if (cached && (now - cached.ts) < OI_CACHE_TTL_MS) return cached.value;
    try {
      const data = await this.strategy.makeProxyRequest('/futures/data/openInterestHist', 'GET', { symbol, period: '5m', limit: 12 }, false, 'futures');
      if (!Array.isArray(data) || data.length < 3) return null;

      const nums = data.map(d => parseFloat(d?.sumOpenInterestValue));
      if (nums.some(v => !Number.isFinite(v))) return null;

      const latest = nums[nums.length - 1];
      const secondLatest = nums[nums.length - 2];
      const oldest = nums[0];
      if (secondLatest === 0 || oldest === 0) return null;   // no Infinity into a prompt

      const last3 = nums.slice(-3);
      let oiTrend = 'FLAT';
      if (last3[2] > last3[1] && last3[1] > last3[0]) oiTrend = 'RISING';
      else if (last3[2] < last3[1] && last3[1] < last3[0]) oiTrend = 'FALLING';

      const value = {
        oiChange5m: ((latest - secondLatest) / secondLatest) * 100,
        oiChange1h: ((latest - oldest) / oldest) * 100,
        oiTrend,
      };
      this._oiCache.set(symbol, { value, ts: now });
      return value;
    } catch (error) {
      console.error(`Failed to fetch OI history: ${error.message}`);
      return staleCacheOrNull(cached, OI_CACHE_TTL_MS, now);
    }
  }

  invalidate(symbol) {
    this._candle15mCache.delete(symbol);
    this._candle5mCache.delete(symbol);
    this._depthCache.delete(symbol);
    this._fundingCache.delete(symbol);
    this._oiCache.delete(symbol);
  }
}
