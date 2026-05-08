import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import { AiPlanner } from './ai-planner.js';
import { AiPlanExecutor } from './ai-plan-executor.js';
import { AiRiskGuard, FEE_RATE } from './ai-risk-guard.js';
import { AiMarketContext } from './ai-market-context.js';
import fetch from 'node-fetch';

// Per-model pricing in USD per million tokens. Sourced from Anthropic published
// rates. Cache write 5m = 1.25× input rate; cache read = 0.1× input rate.
// Used to compute end-of-strategy AI usage cost — kept here so a model change
// only requires updating this table.
const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0, cacheWrite5m: 3.75,  cacheRead: 0.30 },
  'claude-opus-4-7':   { input: 15.0, output: 75.0, cacheWrite5m: 18.75, cacheRead: 1.50 },
};

function formatDuration(ms) {
  if (!ms || ms < 0) return 'N/A';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);
  let result = '';
  if (days > 0) result += `${days}d `;
  if (hours > 0 || days > 0) result += `${hours}h `;
  result += `${minutes}m ${seconds}s`;
  return result.trim();
}

/**
 * AiHedgeStrategy — AI-driven hedge position management with microstructure data.
 *
 * Phase 1 (INITIAL): Opens both LONG and SHORT at an S/R level with asymmetric sizing.
 * Phase 2 (DCA): Widens the hedge gap through DCA entries at unified S/R levels (15m native with cascade fallback to 1h/4h/1d/prior-week H/L).
 * Auto-stops when totalPnL >= effectiveTarget.
 */
class AiHedgeStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // Positions
    this.longPosition = null;
    this.shortPosition = null;

    // Hedge metrics
    this.hedgeGap = 0;
    this.lockedProfit = 0;
    this.desiredProfitUSDT = null;

    // Phase: 'INITIAL' or 'DCA'
    this.phase = 'INITIAL';
    this.executionState = 'IDLE';
    this.activePlan = null;
    this.planHistory = [];

    // Config
    this.positionSizeUSDT = 0;
    this.leverage = DEFAULT_LEVERAGE;
    this.maxPositionSizeUSDT = 0;
    // Raw config inputs (for display in Active Config panel; positionSize/desiredProfit are derived)
    this.initialHedgeMultiplier = null;
    this.profitPercent = null;

    // Trade tracking
    this.tradeCount = 0;
    this.strategyStartTime = null;
    this.strategyEndTime = null;
    this.timeTaken = null;
    this.initialWalletBalance = null;

    // Market data (updated on each plan request)
    this._lastVolatility = null;
    this._lastMicrostructure = null;

    // AI modules
    this.planner = null;
    this.executor = null;
    this.riskGuard = null;
    this.marketContext = null;

    // Price tracking
    this.lastProcessedPrice = null;
    this._lastReplanTime = 0;
    this._replanCooldownMs = 5000;

    // Paired-mode staleness timer — fires a replan if no fills happen for
    // STALENESS_TIMEOUT_MS. Cleared on every plan install.
    this._stalenessTimer = null;
    this._stalenessTimeoutMs = 4 * 60 * 60 * 1000; // 4 hours
    this.isTradingSequenceInProgress = false;

    // Single-leg guard: track price of first ever position
    this.firstPositionPrice = null;

    // HOLD replan timer
    this._holdReplanAt = null;

    // Auto-stop hysteresis: require sustained target hit (N consecutive
    // ticks AND min elapsed duration) before closing out. Defends against
    // single-tick wicks where a transient unrealized-PnL spike on one leg
    // would otherwise force a full close at a price that immediately
    // mean-reverts. Reset to null/0 on any tick where PnL drops below target.
    this._targetReachedSinceTs = null;
    this._targetReachedTickCount = 0;
    this._targetMinTicks = 3;
    this._targetMinDurationMs = 2500;

    // AI token usage tracking
    this.aiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, planCount: 0 };

    // Critical error
    this.criticalError = null;
  }

  // ——— Strategy lifecycle ——————————————————————————————————————————————

  async start(config = {}) {
    // Note: duplicate prevention is handled by app.js (checks activeStrategies by profileId)
    // isRunning may already be true (set by app.js for non-blocking start)

    // strategyId may already be set by app.js (non-blocking start)
    if (!this.strategyId) {
      this.strategyId = `ai_hedge_${this.profileId}_${Date.now()}`;
    }
    this.initFirestoreCollections(this.strategyId);

    this.symbol = config.symbol || 'BTCUSDT';
    this.positionSizeUSDT = config.positionSizeUSDT || 120;
    this.leverage = config.leverage || DEFAULT_LEVERAGE;
    this.desiredProfitUSDT = config.desiredProfitUSDT || null;
    this.priceType = config.priceType || 'MARK';
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || (this.positionSizeUSDT * 20);
    this.initialHedgeMultiplier = config.initialHedgeMultiplier ?? null;
    this.profitPercent = config.profitPercent ?? null;

    const anthropicApiKey = await this._fetchAnthropicApiKey();
    this.aiModel = config.aiModel || 'claude-sonnet-4-6';

    await this.addLog(`Starting AI Hedge Strategy for ${this.symbol}...`);
    await this.addLog(`Config: posSize=${this.positionSizeUSDT} USDT, leverage=${this.leverage}x, maxPos=${this.maxPositionSizeUSDT} USDT, model=${this.aiModel}`);

    try {
      await this.setLeverage(this.symbol, this.leverage);
      await this.setPositionMode(true);
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`ERROR: [SETUP_ERROR] ${error.message}`);
      throw error;
    }

    const minNotional = this.exchangeInfoCache[this.symbol]?.minNotional || 5;
    if (this.positionSizeUSDT < minNotional) {
      const msg = `Position size (${this.positionSizeUSDT} USDT) below minimum notional (${minNotional} USDT)`;
      await this.addLog(`ERROR: [VALIDATION_ERROR] ${msg}`);
      throw new Error(msg);
    }

    this.initialWalletBalance = await this.getWalletBalance();
    await this.addLog(`Wallet balance: ${this._formatNotional(this.initialWalletBalance)} USDT`);

    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      maxImbalanceRatio: 5.0,
      maxPriceDeviationPercent: 5.0,
      maxActionsPerHour: 20,
      minNotional,
      singleLegStopPercent: 5.0,
    });

    this.marketContext = new AiMarketContext(this);
    this.planner = new AiPlanner(anthropicApiKey, this.aiModel);
    this.executor = new AiPlanExecutor(this);

    this.isRunning = true;
    this.phase = 'INITIAL';
    this.strategyStartTime = new Date();

    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();
    this.connectLiquidationWebSocket();

    this.listenKeyRefreshInterval = setInterval(async () => {
      try {
        await this._retryListenKeyRequest(true);
      } catch (error) {
        console.error(`ListenKey refresh failed: ${error.message}`);
        await this.addLog(`ERROR: ListenKey refresh failed: ${error.message}`);
        if (this.listenKeyRefreshInterval) {
          clearInterval(this.listenKeyRefreshInterval);
          this.listenKeyRefreshInterval = null;
        }
        if (this.userDataWs && this.userDataWs.readyState === 1) {
          this.userDataWs.close(1000, 'Reconnecting due to listenKey failure');
        }
      }
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Periodic microstructure refresh (every 60s) for real-time frontend display
    this._microstructureInterval = setInterval(async () => {
      if (!this.isRunning || !this.marketContext) return;
      try {
        const [oiChange, liquidations, takerRatio, globalLSRatio] = await Promise.all([
          this.marketContext._getOIChange(),
          this.marketContext._getLiquidations(),
          this.marketContext._getTakerRatio(null),
          this.marketContext._getGlobalLSRatio(),
        ]);
        this._lastMicrostructure = { oiChange, liquidations, volumeRatio: this._lastMicrostructure?.volumeRatio || null, takerRatio, globalLSRatio };
      } catch (err) {
        // Silent — microstructure refresh is non-critical
      }
    }, 60 * 1000);

    await this.detectCurrentPosition(true);
    await this._refreshHedgePositions();

    // If positions already exist (strategy restart), go to DCA phase
    if (this.longPosition && this.shortPosition) {
      this.phase = 'DCA';
      this.firstPositionPrice = this.longPosition.entryPrice; // Best guess
      await this.addLog('Existing positions detected. Resuming in DCA phase.');
    }

    await this.addLog(`AI Hedge Strategy started in ${this.phase} phase. Waiting for first price tick...`);
    await this.saveState();
  }

  /**
   * C4 — restart recovery. Called by app.js boot scan when a Firestore
   * `strategies` doc has `isRunning: true` but the in-memory activeStrategies
   * map is empty (i.e. the process crashed and PM2 restarted us).
   *
   * Mirrors start() but: (a) restores config + state from the snapshot
   * instead of req.body, (b) discards any in-flight activePlan (it was
   * mid-trigger when we died — replan from scratch), (c) reconciles
   * positions against Binance as source of truth (snapshot positions may be
   * stale; positions may have been liquidated/closed during downtime).
   */
  async resume(snapshot) {
    // Restore identifiers FIRST so addLog can write under the right strategyId.
    this.strategyId = snapshot.strategyId;
    this.profileId = snapshot.profileId;
    this.userId = snapshot.userId;
    this.gcfProxyUrl = snapshot.gcfProxyUrl;
    this.sharedVmProxyGcfUrl = snapshot.sharedVmProxyGcfUrl;
    this.initFirestoreCollections(this.strategyId);

    if (!this.gcfProxyUrl || !this.sharedVmProxyGcfUrl) {
      const msg = `[RECOVERY] Cannot resume ${this.strategyId}: missing proxy URLs in snapshot (saved before C4 fix)`;
      console.error(msg);
      await this.addLog(msg).catch(() => {});
      this.isRunning = false;
      this.criticalError = 'recovery_missing_proxy_urls';
      await this.saveState().catch(() => {});
      try { this.onStopComplete?.(); } catch (_) { /* ignore */ }
      return;
    }

    await this.addLog(`[RECOVERY] Resuming strategy after restart...`);

    // Restore config
    this.symbol = snapshot.symbol;
    this.positionSizeUSDT = snapshot.positionSizeUSDT;
    this.maxPositionSizeUSDT = snapshot.maxPositionSizeUSDT;
    this.leverage = snapshot.leverage || DEFAULT_LEVERAGE;
    this.desiredProfitUSDT = snapshot.desiredProfitUSDT || null;
    this.priceType = snapshot.priceType || 'MARK';
    this.aiModel = snapshot.aiModel || 'claude-sonnet-4-6';
    this.initialHedgeMultiplier = snapshot.initialHedgeMultiplier ?? null;
    this.profitPercent = snapshot.profitPercent ?? null;

    // Restore state
    this.phase = snapshot.phase || 'INITIAL';
    this.executionState = 'IDLE';     // Drop in-flight execution state.
    this.activePlan = null;            // Discard in-flight plan; replan on first tick.
    this.tradeCount = snapshot.tradeCount || 0;
    this.firstPositionPrice = snapshot.firstPositionPrice || null;
    this.initialWalletBalance = snapshot.initialWalletBalance || null;
    const sst = snapshot.strategyStartTime;
    this.strategyStartTime = sst?.toDate ? sst.toDate() : (sst ? new Date(sst) : new Date());
    this.accumulatedRealizedPnL = snapshot.accumulatedRealizedPnL || 0;
    this.accumulatedTradingFees = snapshot.accumulatedTradingFees || 0;
    this.longAccumulatedRealizedPnL = snapshot.longAccumulatedRealizedPnL || 0;
    this.shortAccumulatedRealizedPnL = snapshot.shortAccumulatedRealizedPnL || 0;
    this.longTradingFees = snapshot.longTradingFees || 0;
    this.shortTradingFees = snapshot.shortTradingFees || 0;

    const anthropicApiKey = await this._fetchAnthropicApiKey();

    try {
      await this.setLeverage(this.symbol, this.leverage);
      await this.setPositionMode(true);
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`[RECOVERY] ERROR setup: ${error.message}`);
      throw error;
    }

    const minNotional = this.exchangeInfoCache[this.symbol]?.minNotional || 5;

    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      maxImbalanceRatio: 5.0,
      maxPriceDeviationPercent: 5.0,
      maxActionsPerHour: 20,
      minNotional,
      singleLegStopPercent: 5.0,
    });
    this.marketContext = new AiMarketContext(this);
    this.planner = new AiPlanner(anthropicApiKey, this.aiModel);
    this.executor = new AiPlanExecutor(this);

    this.isRunning = true;

    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();
    this.connectLiquidationWebSocket();

    this.listenKeyRefreshInterval = setInterval(async () => {
      try {
        await this._retryListenKeyRequest(true);
      } catch (error) {
        console.error(`ListenKey refresh failed: ${error.message}`);
        await this.addLog(`ERROR: ListenKey refresh failed: ${error.message}`);
        if (this.listenKeyRefreshInterval) {
          clearInterval(this.listenKeyRefreshInterval);
          this.listenKeyRefreshInterval = null;
        }
        if (this.userDataWs && this.userDataWs.readyState === 1) {
          this.userDataWs.close(1000, 'Reconnecting due to listenKey failure');
        }
      }
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    this._microstructureInterval = setInterval(async () => {
      if (!this.isRunning || !this.marketContext) return;
      try {
        const [oiChange, liquidations, takerRatio, globalLSRatio] = await Promise.all([
          this.marketContext._getOIChange(),
          this.marketContext._getLiquidations(),
          this.marketContext._getTakerRatio(null),
          this.marketContext._getGlobalLSRatio(),
        ]);
        this._lastMicrostructure = { oiChange, liquidations, volumeRatio: this._lastMicrostructure?.volumeRatio || null, takerRatio, globalLSRatio };
      } catch (err) { /* silent */ }
    }, 60 * 1000);

    // Reconcile against Binance — source of truth for current positions.
    await this.detectCurrentPosition(true);
    await this._refreshHedgePositions();

    const longExists = !!(this.longPosition && this.longPosition.quantity > 0);
    const shortExists = !!(this.shortPosition && this.shortPosition.quantity > 0);

    if (!longExists && !shortExists) {
      // Both legs gone — auto-stop fired during downtime, or user closed manually.
      await this.addLog('[RECOVERY] No positions on Binance — strategy was already closed during downtime. Marking stopped.');
      this.isRunning = false;
      this.criticalError = 'positions_closed_during_downtime';
      this.cleanupWebSockets();
      if (this._microstructureInterval) { clearInterval(this._microstructureInterval); this._microstructureInterval = null; }
      this.strategyEndTime = new Date();
      await this.saveState();
      try { this.onStopComplete?.(); } catch (_) { /* ignore */ }
      return;
    }

    if (longExists !== shortExists) {
      // Single leg — partial liquidation or partial close. Single-leg guard
      // would have stopped this normally; do the same here for safety.
      await this.addLog(`[RECOVERY] Only one leg present (LONG=${longExists}, SHORT=${shortExists}). Stopping for safety — single_leg_after_restart.`);
      this.criticalError = 'single_leg_after_restart';
      await this.stop('single_leg_after_restart');
      return;
    }

    // Both legs intact — resume in DCA phase.
    this.phase = 'DCA';
    if (!this.firstPositionPrice) this.firstPositionPrice = this.longPosition.entryPrice;
    await this.addLog(
      `[RECOVERY] Hedge intact. LONG ${this._formatNotional(this.longPosition.notional)} @ ${this._formatPrice(this.longPosition.entryPrice)}, ` +
      `SHORT ${this._formatNotional(this.shortPosition.notional)} @ ${this._formatPrice(this.shortPosition.entryPrice)}. ` +
      `Resuming in DCA phase. Will replan on first price tick.`
    );
    await this.saveState();
  }

  async stop(reason = 'manual') {
    if (!this.isRunning) return;

    this.isStopping = true;
    this.isRunning = false;
    this.executionState = 'IDLE';
    this._clearStalenessTimer();

    await this.addLog(`Stopping AI Hedge Strategy. Reason: ${reason}`);

    // Close positions if not already closed
    let longCloseOrderId = null;
    let shortCloseOrderId = null;
    if (reason !== 'hedge_closed') {
      try {
        await this._refreshHedgePositions();

        if (this.longPosition && this.longPosition.quantity > 0) {
          const qty = this.roundQuantity(this.longPosition.quantity);
          await this.addLog(`Closing LONG: SELL ${qty}`);
          const result = await this.placeMarketOrder(this.symbol, 'SELL', qty, 'LONG');
          longCloseOrderId = result?.orderId;
        }
        if (this.shortPosition && this.shortPosition.quantity > 0) {
          const qty = this.roundQuantity(this.shortPosition.quantity);
          await this.addLog(`Closing SHORT: BUY ${qty}`);
          const result = await this.placeMarketOrder(this.symbol, 'BUY', qty, 'SHORT');
          shortCloseOrderId = result?.orderId;
        }
      } catch (err) {
        await this.addLog(`ERROR: Failed to close positions: ${err.message}`);
      }

      // Synchronously recover fills for:
      //  (a) any pre-stop in-flight order whose deferred 5s REST-fallback timer
      //      hasn't fired yet (e.g. an ADD trade placed in the last 5s before
      //      stop), and
      //  (b) the closing orders just placed above.
      // Each call is idempotent — fast no-op when WS path already handled the
      // orderId, otherwise polls status to FILLED then fetches userTrades.
      // Without (a), the modal's Net PnL would understate the last add-trade's
      // fees by ~0.005 USDT per fill. Without (b), the closing PnL itself
      // would be missed when user-data WS is silent-stuck.
      try {
        const pending = Array.from(this._pendingRestFallback.entries());
        for (const [oid, meta] of pending) {
          await this._recoverOrderSync(oid, meta.symbol, meta.positionSide);
        }
        if (longCloseOrderId) {
          await this._recoverOrderSync(longCloseOrderId, this.symbol, 'LONG');
        }
        if (shortCloseOrderId) {
          await this._recoverOrderSync(shortCloseOrderId, this.symbol, 'SHORT');
        }
      } catch (err) {
        await this.addLog(`ERROR: Pending-fill recovery failed: ${err.message}`);
      }

      try {
        await this._refreshHedgePositions();
        const longRem = this.longPosition?.quantity || 0;
        const shortRem = this.shortPosition?.quantity || 0;
        if (longRem > 0 || shortRem > 0) {
          await this.addLog(`WARNING: Positions not fully closed. LONG: ${longRem}, SHORT: ${shortRem}`);
        } else {
          await this.addLog('All positions closed.');
        }
      } catch (err) {
        await this.addLog(`ERROR: Failed to verify position closure: ${err.message}`);
      }
    }

    if (this._microstructureInterval) {
      clearInterval(this._microstructureInterval);
      this._microstructureInterval = null;
    }
    this.cleanupWebSockets();
    this.strategyEndTime = new Date();
    this.timeTaken = this.strategyStartTime ? formatDuration(Date.now() - new Date(this.strategyStartTime).getTime()) : null;

    await this._refreshHedgePositions();
    this._updateUnrealizedPnL(this.currentPrice);

    // Platform fee
    const netPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;
    if (netPnL > 0) {
      await this.deductPlatformFee(netPnL);
    }

    await this.saveState();
    this.isStopping = false;

    // Log AI token usage summary. Rates come from MODEL_PRICING (above) keyed
    // by this.aiModel. Cache write/read tokens default to 0 since prompt
    // caching is disabled in v1.0.25 — but keep the math defensive in case
    // it's ever re-enabled or the API returns nonzero values.
    const u = this.aiTokenUsage;
    if (u.planCount > 0) {
      const rates = MODEL_PRICING[this.aiModel] || MODEL_PRICING['claude-sonnet-4-6'];
      const inputCost      = (u.inputTokens   || 0) / 1_000_000 * rates.input;
      const outputCost     = (u.outputTokens  || 0) / 1_000_000 * rates.output;
      const cacheWriteCost = (u.cacheCreation || 0) / 1_000_000 * rates.cacheWrite5m;
      const cacheReadCost  = (u.cacheRead     || 0) / 1_000_000 * rates.cacheRead;
      const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;
      await this.addLog(
        `AI Usage: ${u.planCount} plans, ${u.inputTokens.toLocaleString()} input + ${u.outputTokens.toLocaleString()} output ` +
        `(cache write: ${u.cacheCreation.toLocaleString()}, read: ${u.cacheRead.toLocaleString()}). ` +
        `Est. cost (${this.aiModel}): $${totalCost.toFixed(4)}`
      );
    }

    await this.addLog('AI Hedge Strategy stopped.');

    try {
      const elapsed = this.strategyStartTime ? formatDuration(Date.now() - new Date(this.strategyStartTime).getTime()) : 'N/A';
      await sendStrategyCompletionNotification(this.userId, {
        strategyId: this.strategyId,
        symbol: this.symbol,
        netPnL: this.totalPnL,
        profitPercentage: this.initialWalletBalance ? (this.totalPnL / this.initialWalletBalance) * 100 : 0,
        tradeCount: this.tradeCount,
        timeTaken: elapsed,
        realizedPnL: this.accumulatedRealizedPnL,
        tradingFees: this.accumulatedTradingFees,
      });
    } catch (e) {
      console.error('Notification failed:', e.message);
    }

    try { this.onStopComplete?.(); } catch (e) {
      console.error('onStopComplete hook failed:', e.message);
    }
  }

  // ——— Core price handler ——————————————————————————————————————————————

  async handleRealtimePrice(price) {
    if (!this.isRunning) return;

    const prevPrice = this.lastProcessedPrice;
    this.currentPrice = price;
    this.lastProcessedPrice = price;
    this._updateUnrealizedPnL(price);

    // Auto-stop check with hysteresis (C3): totalPnL >= effectiveTarget
    // must hold for N consecutive ticks AND a minimum elapsed duration
    // before stopping. Single-tick wicks reset the watermark.
    if (this.desiredProfitUSDT && this.phase === 'DCA') {
      const longNotional = this.longPosition?.notional || 0;
      const shortNotional = this.shortPosition?.notional || 0;
      const estimatedClosingFees = (longNotional + shortNotional) * FEE_RATE;
      const effectiveTarget = this.desiredProfitUSDT + estimatedClosingFees;

      if (this.totalPnL >= effectiveTarget) {
        if (this._targetReachedSinceTs === null) {
          this._targetReachedSinceTs = Date.now();
          this._targetReachedTickCount = 1;
          await this.addLog(`TARGET HIT: PnL ${this._formatNotional(this.totalPnL)} >= Target ${this._formatNotional(effectiveTarget)} — confirming for ${this._targetMinTicks} ticks / ${this._targetMinDurationMs}ms before stop`);
        } else {
          this._targetReachedTickCount++;
        }

        const elapsed = Date.now() - this._targetReachedSinceTs;
        if (this._targetReachedTickCount >= this._targetMinTicks && elapsed >= this._targetMinDurationMs) {
          await this.addLog(`TARGET CONFIRMED: PnL ${this._formatNotional(this.totalPnL)} >= Target ${this._formatNotional(effectiveTarget)} sustained ${this._targetReachedTickCount} ticks / ${elapsed}ms`);
          await this.stop('profit_target_reached');
          return;
        }
      } else if (this._targetReachedSinceTs !== null) {
        const sustainedFor = Date.now() - this._targetReachedSinceTs;
        await this.addLog(`TARGET LOST: PnL ${this._formatNotional(this.totalPnL)} < Target ${this._formatNotional(effectiveTarget)} after ${this._targetReachedTickCount} ticks / ${sustainedFor}ms — wick filtered, resetting watermark`);
        this._targetReachedSinceTs = null;
        this._targetReachedTickCount = 0;
      }
    }

    // Single-leg guard
    if (this.phase === 'DCA' && this.riskGuard) {
      const guard = this.riskGuard.checkSingleLegGuard(this.longPosition, this.shortPosition, price);
      if (guard.shouldStop) {
        await this.addLog(`RISK GUARD: ${guard.reason}`);
        this.criticalError = guard.reason;
        await this.stop('single_leg_guard');
        return;
      }
    }

    // Request initial plan on first tick
    if (!this.activePlan && this.executionState === 'IDLE') {
      this.executionState = 'WAITING_FOR_PLAN';
      await this._requestNewPlan('initial');
      return;
    }

    // Check triggers
    if (this.activePlan && this.executionState === 'EXECUTING_PLAN' && prevPrice !== null) {
      if (this.isTradingSequenceInProgress) return;

      const triggered = this.executor.checkTriggers(prevPrice, price);
      if (triggered) {
        this.isTradingSequenceInProgress = true;
        try {
          await this._executeTriggeredAction(triggered);
        } finally {
          this.isTradingSequenceInProgress = false;
        }
      }

      // HOLD replan timer
      if (this._holdReplanAt && Date.now() >= this._holdReplanAt) {
        this._holdReplanAt = null;
        await this.addLog('HOLD timer expired. Requesting fresh plan...');
        await this._requestNewPlan('hold_replan');
      }
    }
  }

  // ——— AI plan management ——————————————————————————————————————————————

  async _requestNewPlan(reason = 'execution_complete') {
    // Skip if the strategy is stopping or already stopped — the plan would
    // never execute (handleRealtimePrice short-circuits on !isRunning) and
    // the Anthropic API call would still bill. Also avoids the misleading
    // "AI Plan installed" log appearing after the stopped notification.
    if (this.isStopping || !this.isRunning) {
      return;
    }
    const now = Date.now();
    if (now - this._lastReplanTime < this._replanCooldownMs) return;
    this._lastReplanTime = now;

    this.executionState = 'WAITING_FOR_PLAN';
    await this.addLog(`Requesting AI plan... Phase: ${this.phase}, Reason: ${reason}`);

    try {
      const longNotional = this.longPosition?.notional || 0;
      const shortNotional = this.shortPosition?.notional || 0;
      const estimatedClosingFees = (longNotional + shortNotional) * FEE_RATE;
      const effectiveTarget = this.desiredProfitUSDT ? this.desiredProfitUSDT + estimatedClosingFees : null;

      const context = await this.marketContext.buildContext({
        phase: this.phase,
        longPosition: this.longPosition,
        shortPosition: this.shortPosition,
        hedgeGap: this.hedgeGap,
        lockedProfit: this.lockedProfit,
        totalPnL: this.totalPnL,
        desiredProfitUSDT: this.desiredProfitUSDT,
        effectiveTarget,
        walletBalance: this.initialWalletBalance,
        positionSizeUSDT: this.positionSizeUSDT,
        minNotional: this.riskGuard.minNotional,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        previousPlan: this.activePlan,
        planHistory: this.planHistory.slice(-5),
        firstPositionPrice: this.firstPositionPrice,
      });

      if (context.volatility) this._lastVolatility = context.volatility;
      if (context.liquidationCaps) this._lastLiquidationCaps = context.liquidationCaps;
      this._lastMicrostructure = {
        oiChange: context.oiChange || null,
        liquidations: context.liquidations || null,
        volumeRatio: context.volumeRatio || null,
        takerRatio: context.takerRatio || null,
        globalLSRatio: context.globalLSRatio || null,
      };

      let plan = await this.planner.generatePlan(context);

      // Accumulate AI token usage
      if (plan._usage) {
        this.aiTokenUsage.inputTokens += plan._usage.inputTokens;
        this.aiTokenUsage.outputTokens += plan._usage.outputTokens;
        this.aiTokenUsage.cacheRead += plan._usage.cacheRead;
        this.aiTokenUsage.cacheCreation += plan._usage.cacheCreation;
        this.aiTokenUsage.planCount++;
      }

      const validation = this.riskGuard.validatePlan(plan, {
        currentPrice: this.currentPrice,
        longPosition: this.longPosition,
        shortPosition: this.shortPosition,
        positionSizeUSDT: this.positionSizeUSDT,
        phase: this.phase,
        liquidationCaps: context.liquidationCaps,
        minLiqDistancePct: context.minLiqDistancePct,
      });

      if (!validation.valid) {
        await this.addLog(`AI plan rejected: ${validation.reasons.join(', ')}`);
        // Preserve the rejected plan's probabilityAssessment so the fallback
        // DCA path can bias its size split using the AI's own conviction.
        const rejectedBias = plan?.probabilityAssessment || null;
        plan = this.riskGuard.generateFallbackPlan(this.currentPrice, {
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          positionSizeUSDT: this.positionSizeUSDT,
          volatility: this._lastVolatility,
          phase: this.phase,
          liquidationCaps: context.liquidationCaps,
        }, 'Risk guard rejection', rejectedBias);

        const fallbackValidation = this.riskGuard.validatePlan(plan, {
          currentPrice: this.currentPrice,
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          positionSizeUSDT: this.positionSizeUSDT,
          phase: this.phase,
          liquidationCaps: context.liquidationCaps,
          minLiqDistancePct: context.minLiqDistancePct,
        });

        if (!fallbackValidation.valid) {
          const msg = `Both AI and fallback plans rejected: ${fallbackValidation.reasons.join(', ')}`;
          await this.addLog(`ERROR: [CRITICAL] ${msg}`);
          this.criticalError = msg;
          await this.stop('critical_error');
          return;
        }
        await this.addLog('Using fallback plan.');
      }

      // Freeze the microstructure inputs the AI actually consumed onto the plan,
      // so the frontend can show users exactly what the model saw (live data
      // keeps ticking after the plan is made).
      plan.microstructureSnapshot = this._lastMicrostructure
        ? { ...this._lastMicrostructure }
        : null;
      plan.volatilitySnapshot = this._lastVolatility ? { ...this._lastVolatility } : null;
      plan.plannedAt = new Date().toISOString();
      // Attach paired-trigger constants from context so the executor uses
      // them when clamping shadow qty (rather than its default fallback).
      if (context.ratioBand) plan.ratioBand = context.ratioBand;
      if (context.shadowDistance) plan.shadowDistance = context.shadowDistance;

      // Install plan
      this.activePlan = plan;
      this.executor.setActivePlan(plan);
      this.executionState = 'EXECUTING_PLAN';

      await this.addLog(`AI Plan installed${plan._schema === 'paired' ? ' [paired-trigger]' : ''}${plan._fellBack ? ' [fell back to legacy]' : ''}.`);
      await this.addLog(`Analysis: ${plan.analysis || 'N/A'}`);

      if (plan._schema === 'paired') {
        await this._logPairedPlan(plan);
      } else {
        await this._logLegacyPlan(plan);
      }
      if (plan.probabilityAssessment) {
        await this.addLog(`  Prob: ${plan.probabilityAssessment.higherChance} (${plan.probabilityAssessment.confidence}) — ${plan.probabilityAssessment.reasoning}`);
      }

      // HOLD replan timer (legacy + paired-with-all-HOLD-primaries)
      const bothHold = plan._schema === 'paired'
        ? plan.actionAbove?.primary?.type === 'HOLD' && plan.actionBelow?.primary?.type === 'HOLD'
        : plan.actionAbove?.type === 'HOLD' && plan.actionBelow?.type === 'HOLD';
      if (bothHold) {
        const minutes = Math.max(15, Math.min(120, plan.holdReplanMinutes || 30));
        this._holdReplanAt = Date.now() + minutes * 60 * 1000;
        await this.addLog(`  Both HOLD. Re-evaluate in ${minutes} min.`);
      } else {
        this._holdReplanAt = null;
      }

      // Paired-mode 4h staleness timer — replan if no fills happen for that long.
      // Without this, paired plans with no trigger crossings would sit unfilled
      // indefinitely, even as market state drifts away from where the plan was made.
      this._resetStalenessTimer();

      await this.saveState();

      // Immediate trigger check
      if (this.currentPrice && !this.isTradingSequenceInProgress) {
        const immediate = this.executor.checkImmediateTriggers(this.currentPrice);
        if (immediate) {
          await this.addLog(`Immediate trigger: ${immediate.action.type} at ${this._formatPrice(immediate.action.triggerPrice)}`);
          this.isTradingSequenceInProgress = true;
          try {
            await this._executeTriggeredAction(immediate);
          } finally {
            this.isTradingSequenceInProgress = false;
          }
        }
      }
    } catch (error) {
      await this.addLog(`ERROR: [AI_ERROR] ${error.message}`);
      this.executionState = 'IDLE';

      try {
        const fallback = this.riskGuard.generateFallbackPlan(this.currentPrice, {
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          positionSizeUSDT: this.positionSizeUSDT,
          volatility: this._lastVolatility,
          phase: this.phase,
          liquidationCaps: this._lastLiquidationCaps,
        }, 'AI error');
        fallback.microstructureSnapshot = this._lastMicrostructure
          ? { ...this._lastMicrostructure }
          : null;
        fallback.volatilitySnapshot = this._lastVolatility ? { ...this._lastVolatility } : null;
        fallback.plannedAt = new Date().toISOString();
        this.activePlan = fallback;
        this.executor.setActivePlan(fallback);
        this.executionState = 'EXECUTING_PLAN';
        await this.addLog('Installed fallback plan due to AI error.');
      } catch (fbErr) {
        await this.addLog(`ERROR: Fallback also failed: ${fbErr.message}`);
      }
    }
  }

  /**
   * Execute one action and record state. Returns { isHold } so callers can
   * branch. Used both by _executeTriggeredAction (initial fire) and by the
   * paired-mode cascade loop (subsequent fires within the same tick).
   */
  async _runActionAndRecord(action, direction) {
    const result = await this.executor.executeAction(action);

    if (action.type === 'HOLD') return { isHold: true };

    this.tradeCount++;

    // Track first position price for single-leg guard
    if (!this.firstPositionPrice && this.currentPrice) {
      this.firstPositionPrice = this.currentPrice;
      if (this.riskGuard) this.riskGuard.firstPositionPrice = this.currentPrice;
    }

    // Transition from INITIAL to DCA after OPEN_HEDGE
    if (action.type === 'OPEN_HEDGE') {
      this.phase = 'DCA';
      await this.addLog('Phase transition: INITIAL -> DCA');
    }

    const outcome = {
      action, direction, result,
      price: this.currentPrice,
      timestamp: new Date(),
      longPosition: this.longPosition ? { ...this.longPosition } : null,
      shortPosition: this.shortPosition ? { ...this.shortPosition } : null,
    };

    this.planHistory.push({ plan: this.activePlan, direction, triggeredAction: action, outcome, timestamp: new Date() });
    await this._savePlanToFirestore(this.activePlan, outcome);

    // Refresh positions. expectNonEmpty: we just placed orders, so if REST
    // returns null/null it's the Binance /fapi/v2/account propagation race —
    // retry with short backoff inside _refreshHedgePositions.
    await this.detectCurrentPosition(true);
    await this._refreshHedgePositions({ expectNonEmpty: true });

    // C4: persist post-fill state so a crash between fills doesn't lose
    // tradeCount, phase, or position-derived metrics. saveState is also
    // called at plan install (line ~603) and start/stop boundaries.
    await this.saveState();

    await this.addLog(
      `Trade #${this.tradeCount}. ` +
      `LONG: ${this.longPosition ? this._formatNotional(this.longPosition.notional) + ' @ ' + this._formatPrice(this.longPosition.entryPrice) : 'none'}, ` +
      `SHORT: ${this.shortPosition ? this._formatNotional(this.shortPosition.notional) + ' @ ' + this._formatPrice(this.shortPosition.entryPrice) : 'none'}, ` +
      `Gap: ${this._formatPrice(this.hedgeGap)}, P&L: ${this._formatNotional(this.lockedProfit)} USDT`
    );

    return { isHold: false };
  }

  async _executeTriggeredAction(triggeredAction) {
    const { action, direction } = triggeredAction;
    await this.addLog(`Executing (${direction}): ${action.type}${action.kind ? ' ' + action.kind : ''} — ${action.reason}`);

    try {
      const { isHold } = await this._runActionAndRecord(action, direction);
      if (isHold) {
        await this._requestNewPlan('execution_complete');
        return;
      }

      // Paired-mode cascade: if multiple triggers crossed within the same
      // tick (e.g. price spike past both shadow_LONG and primary_SHORT on
      // an upward move), fire all crossed actions in closest-first order
      // before the AI replans. Without this, only the closest fires per
      // tick and the rest are canceled by the post-fill replan, costing
      // legitimate fills during fast moves.
      if (this.activePlan?._schema === 'paired') {
        let cascaded;
        while ((cascaded = this.executor.checkImmediateTriggers(this.currentPrice))) {
          await this.addLog(`Cascade fill (${cascaded.direction}): ${cascaded.action.type}${cascaded.action.kind ? ' ' + cascaded.action.kind : ''} @ ${this._formatPrice(cascaded.action.triggerPrice)}`);
          const r = await this._runActionAndRecord(cascaded.action, cascaded.direction);
          if (r.isHold) break;
        }
      }

      await this._requestNewPlan('execution_complete');
    } catch (error) {
      await this.addLog(`ERROR: [TRADING_ERROR] ${action.type}: ${error.message}`);
      await this._requestNewPlan('execution_error');
    }
  }

  // ——— Plan logging helpers (schema-aware) ——————————————————————————

  async _logLegacyPlan(plan) {
    if (plan.actionAbove) {
      if (plan.actionAbove.type === 'OPEN_HEDGE') {
        await this.addLog(`  ABOVE: OPEN_HEDGE at ${this._formatPrice(plan.actionAbove.triggerPrice)} — LONG ${plan.actionAbove.longSizeUSDT} / SHORT ${plan.actionAbove.shortSizeUSDT} USDT`);
      } else if (plan.actionAbove.type === 'HOLD') {
        await this.addLog(`  ABOVE: HOLD (${plan.actionAbove.reason})`);
      } else {
        await this.addLog(`  ABOVE: ${plan.actionAbove.type} at ${this._formatPrice(plan.actionAbove.triggerPrice)} — ${plan.actionAbove.sizeUSDT} USDT (${plan.actionAbove.reason})`);
      }
    }
    if (plan.actionBelow) {
      if (plan.actionBelow.type === 'OPEN_HEDGE') {
        await this.addLog(`  BELOW: OPEN_HEDGE at ${this._formatPrice(plan.actionBelow.triggerPrice)} — LONG ${plan.actionBelow.longSizeUSDT} / SHORT ${plan.actionBelow.shortSizeUSDT} USDT`);
      } else if (plan.actionBelow.type === 'HOLD') {
        await this.addLog(`  BELOW: HOLD (${plan.actionBelow.reason})`);
      } else {
        await this.addLog(`  BELOW: ${plan.actionBelow.type} at ${this._formatPrice(plan.actionBelow.triggerPrice)} — ${plan.actionBelow.sizeUSDT} USDT (${plan.actionBelow.reason})`);
      }
    }
  }

  async _logPairedPlan(plan) {
    const fmt = (a) => {
      if (!a || a.type === 'HOLD' || a.type === 'SKIP') return `${a?.type || 'NONE'}${a?.reason ? ' (' + a.reason + ')' : ''}`;
      return `${a.type} at ${this._formatPrice(a.triggerPrice)} — ${a.qty} ${this.symbol?.replace('USDT', '') || 'qty'}`;
    };
    if (plan.actionAbove) {
      await this.addLog(`  ABOVE primary: ${fmt(plan.actionAbove.primary)}`);
      await this.addLog(`  ABOVE shadow:  ${fmt(plan.actionAbove.shadow)}`);
    }
    if (plan.actionBelow) {
      await this.addLog(`  BELOW primary: ${fmt(plan.actionBelow.primary)}`);
      await this.addLog(`  BELOW shadow:  ${fmt(plan.actionBelow.shadow)}`);
    }
    if (this.executor?.clampWarnings?.length) {
      for (const w of this.executor.clampWarnings) {
        await this.addLog(`  CLAMP ${w.sideKey}.${w.shadowType}: proposed ${w.proposed} → ${w.final} (${w.reason}, max ${w.maxAllowed?.toFixed(4)})`);
      }
    }
  }

  _resetStalenessTimer() {
    if (this._stalenessTimer) clearTimeout(this._stalenessTimer);
    this._stalenessTimer = setTimeout(() => {
      this._stalenessTimer = null;
      if (!this.isStopping && this.isRunning) {
        this.addLog(`Staleness timer fired (${(this._stalenessTimeoutMs / 60000).toFixed(0)} min). Requesting fresh plan.`)
          .catch(() => {});
        this._requestNewPlan('staleness').catch((e) => console.error(`Staleness replan failed: ${e.message}`));
      }
    }, this._stalenessTimeoutMs);
  }

  _clearStalenessTimer() {
    if (this._stalenessTimer) {
      clearTimeout(this._stalenessTimer);
      this._stalenessTimer = null;
    }
  }

  // ——— Anthropic key fetch (via proxy, not Secret Manager) ——————————

  async _fetchAnthropicApiKey() {
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) return envKey;

    const response = await fetch(this.sharedVmProxyGcfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': this.profileId },
      body: JSON.stringify({ apiType: 'secret', endpoint: '/secret/anthropic', profileBinanceApiGcfUrl: this.gcfProxyUrl }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Failed to fetch Anthropic key: ${response.status} - ${err.error || response.statusText}`);
    }

    const { apiKey } = await response.json();
    if (!apiKey) throw new Error('No Anthropic API key configured.');
    return apiKey;
  }

  // ——— Position & PnL helpers ——————————————————————————————————————

  async _refreshHedgePositions({ expectNonEmpty = false } = {}) {
    let positions = await this.detectHedgePositions();

    // Targeted race fallback: when the caller knows orders were just placed
    // (expectNonEmpty=true) but REST returned null for both sides, Binance's
    // /fapi/v2/account may be lagging behind the fill by 100-500ms. Retry up
    // to 5 times with 300ms spacing. Only fires in this specific scenario;
    // no continuous polling elsewhere.
    if (expectNonEmpty && !positions.long && !positions.short) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        console.log(`[Reconcile] Post-trade REST returned empty positions; retry ${attempt}/5 after 300ms`);
        await new Promise(r => setTimeout(r, 300));
        positions = await this.detectHedgePositions();
        if (positions.long || positions.short) break;
      }
      if (!positions.long && !positions.short) {
        console.warn(`[Reconcile] All 5 retries exhausted; accepting null state. Manual check recommended.`);
      }
    }

    this.longPosition = positions.long;
    this.shortPosition = positions.short;

    if (this.longPosition && this.shortPosition) {
      this.hedgeGap = this.shortPosition.entryPrice - this.longPosition.entryPrice;
      const minQty = Math.min(this.longPosition.quantity, this.shortPosition.quantity);
      this.lockedProfit = this.hedgeGap * minQty;
    } else {
      this.hedgeGap = 0;
      this.lockedProfit = 0;
    }
  }

  _updateUnrealizedPnL(currentPrice) {
    if (this._longEntryPrice && this._longPositionSize) {
      this.longPositionPnL = (currentPrice - this._longEntryPrice) * (this._longPositionSize / this._longEntryPrice);
    } else {
      this.longPositionPnL = 0;
    }
    if (this._shortEntryPrice && this._shortPositionSize) {
      this.shortPositionPnL = (this._shortEntryPrice - currentPrice) * (this._shortPositionSize / this._shortEntryPrice);
    } else {
      this.shortPositionPnL = 0;
    }
    this.positionPnL = this.longPositionPnL + this.shortPositionPnL;
    this.totalPnL = this.positionPnL + this.accumulatedRealizedPnL - this.accumulatedTradingFees;
  }

  // ——— State persistence ————————————————————————————————————————————

  async saveState() {
    if (!this.strategyId) return;
    try {
      await this.firestore.collection('strategies').doc(this.strategyId).set({
        type: 'AI_HEDGE',
        strategyId: this.strategyId,
        profileId: this.profileId,
        userId: this.userId,
        symbol: this.symbol,
        isRunning: this.isRunning,
        phase: this.phase,
        executionState: this.executionState,
        // C4 recovery fields — required to reconstruct strategy after restart.
        gcfProxyUrl: this.gcfProxyUrl,
        sharedVmProxyGcfUrl: this.sharedVmProxyGcfUrl,
        aiModel: this.aiModel,
        initialHedgeMultiplier: this.initialHedgeMultiplier,
        profitPercent: this.profitPercent,
        criticalError: this.criticalError,
        longPosition: this.longPosition,
        shortPosition: this.shortPosition,
        hedgeGap: this.hedgeGap,
        lockedProfit: this.lockedProfit,
        currentPrice: this.currentPrice,
        positionPnL: this.positionPnL,
        totalPnL: this.totalPnL,
        longPositionPnL: this.longPositionPnL,
        shortPositionPnL: this.shortPositionPnL,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        longAccumulatedRealizedPnL: this.longAccumulatedRealizedPnL,
        shortAccumulatedRealizedPnL: this.shortAccumulatedRealizedPnL,
        longTradingFees: this.longTradingFees,
        shortTradingFees: this.shortTradingFees,
        positionSizeUSDT: this.positionSizeUSDT,
        maxPositionSizeUSDT: this.maxPositionSizeUSDT,
        leverage: this.leverage,
        desiredProfitUSDT: this.desiredProfitUSDT,
        priceType: this.priceType,
        activePlan: this.activePlan,
        tradeCount: this.tradeCount,
        initialWalletBalance: this.initialWalletBalance,
        firstPositionPrice: this.firstPositionPrice,
        strategyStartTime: this.strategyStartTime,
        strategyEndTime: this.strategyEndTime || null,
        timeTaken: this.timeTaken || null,
        realtimeWsConnected: this.realtimeWsConnected,
        userDataWsConnected: this.userDataWsConnected,
        lastUpdated: new Date(),
      }, { merge: true });
    } catch (error) {
      console.error(`Failed to save state: ${error.message}`);
    }
  }

  async _savePlanToFirestore(plan, outcome) {
    if (!this.strategyId) return;
    try {
      await this.firestore.collection('strategies').doc(this.strategyId).collection('aiPlans').add({
        plan: {
          analysis: plan.analysis,
          actionAbove: plan.actionAbove,
          actionBelow: plan.actionBelow,
          probabilityAssessment: plan.probabilityAssessment,
          microstructureSnapshot: plan.microstructureSnapshot ?? null,
          volatilitySnapshot: plan.volatilitySnapshot ?? null,
          plannedAt: plan.plannedAt ?? null,
        },
        outcome: outcome ? { action: outcome.action, direction: outcome.direction, price: outcome.price, longPosition: outcome.longPosition, shortPosition: outcome.shortPosition } : null,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`Failed to save plan: ${error.message}`);
    }
  }

  // ——— Status for API ————————————————————————————————————————————————

  getStatus() {
    const longNotional = this.longPosition?.notional || 0;
    const shortNotional = this.shortPosition?.notional || 0;
    const estimatedClosingFees = (longNotional + shortNotional) * FEE_RATE;

    return {
      type: 'AI_HEDGE',
      strategyId: this.strategyId,
      isRunning: this.isRunning,
      symbol: this.symbol,
      phase: this.phase,
      executionState: this.executionState,
      currentPrice: this.currentPrice,
      longPosition: this.longPosition,
      shortPosition: this.shortPosition,
      hedgeGap: this.hedgeGap,
      lockedProfit: this.lockedProfit,
      desiredProfitUSDT: this.desiredProfitUSDT,
      positionPnL: this.positionPnL,
      totalPnL: this.totalPnL,
      longPositionPnL: this.longPositionPnL,
      shortPositionPnL: this.shortPositionPnL,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL,
      accumulatedTradingFees: this.accumulatedTradingFees,
      estimatedClosingFees,
      effectiveTarget: this.desiredProfitUSDT ? this.desiredProfitUSDT + estimatedClosingFees : null,
      progressToTarget: this.desiredProfitUSDT ? (this.totalPnL / (this.desiredProfitUSDT + estimatedClosingFees)) * 100 : null,
      positionSizeUSDT: this.positionSizeUSDT,
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      leverage: this.leverage,
      priceType: this.priceType,
      aiModel: this.aiModel,
      initialHedgeMultiplier: this.initialHedgeMultiplier,
      profitPercent: this.profitPercent,
      activePlan: this.activePlan ? {
        analysis: this.activePlan.analysis,
        actionAbove: this.activePlan.actionAbove,
        actionBelow: this.activePlan.actionBelow,
        probabilityAssessment: this.activePlan.probabilityAssessment,
        microstructureSnapshot: this.activePlan.microstructureSnapshot ?? null,
        volatilitySnapshot: this.activePlan.volatilitySnapshot ?? null,
        plannedAt: this.activePlan.plannedAt ?? null,
      } : null,
      tradeCount: this.tradeCount,
      planHistoryCount: this.planHistory.length,
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,
      streamMode: this.streamMode || 'WS',
      volatility: this._lastVolatility,
      microstructure: this._lastMicrostructure,
      firstPositionPrice: this.firstPositionPrice,
      strategyStartTime: this.strategyStartTime,
      initialWalletBalance: this.initialWalletBalance,
      criticalError: this.criticalError,
      aiTokenUsage: this.aiTokenUsage,
    };
  }

  async manualReplan() {
    if (!this.isRunning) throw new Error('Strategy is not running.');
    this._lastReplanTime = 0;
    await this._requestNewPlan('manual');
  }

  // ——— Platform Fee ————————————————————————————————————————————————

  async deductPlatformFee(profitAmount) {
    try {
      if (!this.userId) return;
      const userDocRef = this.firestore.collection('users').doc(this.userId);
      const userDoc = await userDocRef.get();
      if (!userDoc.exists) return;

      const platformFeePercent = userDoc.data().platformFeePercent ?? 15;
      if (platformFeePercent <= 0) return;

      const platformFee = profitAmount * (platformFeePercent / 100);
      await this.addLog(`Platform Fee: ${this._formatNotional(platformFee)} USDT (${platformFeePercent}% of ${this._formatNotional(profitAmount)})`);

      const walletRef = userDocRef.collection('wallets').doc('default');
      const walletDoc = await walletRef.get();
      if (!walletDoc.exists) return;

      const currentBalance = walletDoc.data().balance || 0;
      const newBalance = currentBalance - platformFee;
      if (newBalance < 0) {
        await this.addLog(`Warning: Fee would cause negative balance. Skipping.`);
        return;
      }

      await walletRef.update({ balance: newBalance, updatedAt: new Date() });
      await this.addLog(`Fee deducted. Balance: ${this._formatNotional(newBalance)} USDT`);

      await this.firestore.collection('reload_balance_history').add({
        userId: this.userId,
        profileId: this.profileId,
        strategyId: this.strategyId,
        timestamp: new Date(),
        balance: newBalance,
        type: 'platform_fee',
        amount: -platformFee,
        description: `Platform fee (${platformFeePercent}%) on profit of $${this._formatNotional(profitAmount)}`,
        metadata: { totalPnL: profitAmount, feePercentage: platformFeePercent },
      });
    } catch (error) {
      console.error(`Platform fee error: ${error.message}`);
      await this.addLog(`ERROR: [PLATFORM_FEE] ${error.message}`);
    }
  }
}

export default AiHedgeStrategy;
export { AiHedgeStrategy };
