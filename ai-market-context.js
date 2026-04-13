/**
 * AiMarketContext — builds market context for AI plan generation.
 *
 * Gathers current price, positions, recent candles, ATR volatility,
 * and assembles them into the context object the AI planner needs.
 */
class AiMarketContext {
  constructor(strategy) {
    this.strategy = strategy; // Reference to AiHedgeStrategy (extends TradingBase)

    // 5m candle cache
    this._cachedCandles = null;
    this._candleCacheTime = 0;
    this._candleCacheTTL = 5 * 60 * 1000; // 5 minutes

    // 15m candle cache (for ATR)
    this._cached15mCandles = null;
    this._candle15mCacheTime = 0;
    this._candle15mCacheTTL = 15 * 60 * 1000; // 15 minutes
  }

  /**
   * Build the full context object for the AI planner.
   * @param {object} strategyState — current state from the hedge strategy
   * @returns {object} — context ready for AiPlanner.generatePlan()
   */
  async buildContext(strategyState) {
    const {
      longPosition,
      shortPosition,
      hedgeGap,
      lockedProfit,
      desiredProfitUSDT,
      breakeven,
      effectiveTarget,
      walletBalance,
      positionSizeUSDT,
      accumulatedRealizedPnL,
      accumulatedTradingFees,
      previousPlan,
      planHistory,
    } = strategyState;

    // Fetch candles and calculate ATR in parallel
    const [recentCandles, volatility] = await Promise.all([
      this._getRecentCandles(),
      this._getVolatility(),
    ]);

    return {
      symbol: this.strategy.symbol,
      currentPrice: this.strategy.currentPrice,
      walletBalance: walletBalance || 0,
      positionSizeUSDT: positionSizeUSDT || 0,
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
      desiredProfitUSDT: desiredProfitUSDT || null,
      breakeven: breakeven || 0,
      effectiveTarget: effectiveTarget || null,

      accumulatedRealizedPnL: accumulatedRealizedPnL || 0,
      accumulatedTradingFees: accumulatedTradingFees || 0,

      volatility,
      recentCandles,
      previousPlan: previousPlan || null,
      planHistory: planHistory || [],
    };
  }

  /**
   * Calculate ATR-based volatility from 15-minute candles.
   * @returns {{ atr: number, atrPercent: number, interpretation: string }}
   */
  async _getVolatility() {
    try {
      const candles = await this._get15mCandles();
      if (!candles || candles.length < 15) {
        return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
      }

      const atrData = this._calculateATR(candles, 14);
      return atrData;
    } catch (error) {
      console.error(`Failed to calculate ATR: ${error.message}`);
      return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
    }
  }

  /**
   * Calculate ATR (Average True Range) from candle data.
   * @param {Array} candles — array of { open, high, low, close } objects
   * @param {number} period — ATR period (default 14)
   * @returns {{ atr: number, atrPercent: number, interpretation: string }}
   */
  _calculateATR(candles, period = 14) {
    if (candles.length < period + 1) {
      return { atr: 0, atrPercent: 0, interpretation: 'unknown' };
    }

    // Calculate True Range for each candle (starting from index 1)
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    // Calculate ATR as SMA of last `period` true ranges
    const recentTR = trueRanges.slice(-period);
    const atr = recentTR.reduce((sum, tr) => sum + tr, 0) / recentTR.length;

    const currentPrice = this.strategy.currentPrice || candles[candles.length - 1].close;
    const atrPercent = (atr / currentPrice) * 100;

    // Interpret volatility level
    let interpretation;
    if (atrPercent < 0.5) {
      interpretation = 'low';
    } else if (atrPercent < 1.0) {
      interpretation = 'moderate';
    } else if (atrPercent < 2.0) {
      interpretation = 'high';
    } else {
      interpretation = 'extreme';
    }

    return { atr, atrPercent, interpretation };
  }

  /**
   * Fetch recent 15-minute candles from Binance (for ATR calculation).
   * Results are cached for 15 minutes.
   */
  async _get15mCandles() {
    const now = Date.now();
    if (this._cached15mCandles && (now - this._candle15mCacheTime) < this._candle15mCacheTTL) {
      return this._cached15mCandles;
    }

    try {
      const klines = await this.strategy.makeProxyRequest(
        '/fapi/v1/klines',
        'GET',
        {
          symbol: this.strategy.symbol,
          interval: '15m',
          limit: 100,
        },
        false,
        'futures'
      );

      this._cached15mCandles = klines.map(k => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      }));

      this._candle15mCacheTime = now;
      return this._cached15mCandles;
    } catch (error) {
      console.error(`Failed to fetch 15m candles: ${error.message}`);
      return this._cached15mCandles || [];
    }
  }

  /**
   * Fetch recent 5-minute candles from Binance.
   * Results are cached for 5 minutes to avoid excessive API calls.
   */
  async _getRecentCandles() {
    const now = Date.now();
    if (this._cachedCandles && (now - this._candleCacheTime) < this._candleCacheTTL) {
      return this._cachedCandles;
    }

    try {
      const klines = await this.strategy.makeProxyRequest(
        '/fapi/v1/klines',
        'GET',
        {
          symbol: this.strategy.symbol,
          interval: '5m',
          limit: 100,
        },
        false,
        'futures'
      );

      this._cachedCandles = klines.map(k => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      }));

      this._candleCacheTime = now;
      return this._cachedCandles;
    } catch (error) {
      console.error(`Failed to fetch candles: ${error.message}`);
      return this._cachedCandles || []; // Return stale cache or empty
    }
  }

  /**
   * Invalidate all candle caches (e.g., after a significant event).
   */
  invalidateCache() {
    this._cachedCandles = null;
    this._candleCacheTime = 0;
    this._cached15mCandles = null;
    this._candle15mCacheTime = 0;
  }
}

export { AiMarketContext };
export default AiMarketContext;
