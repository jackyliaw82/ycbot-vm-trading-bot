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

// L5c volatility-aware sizing thresholds
const ATR_PCT_HIGH_VOL = 2.5;       // start-time scale-down trigger (%)
const ATR_DYNAMIC_TRIGGER_X = 1.5;  // mid-run scale when current >= 1.5× start
const VOL_SIZING_FLOOR = 0.4;       // never scale below 40% of original size

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

    // HedgeMetricsChart sampling — 1 write/min to Firestore subcollection
    // strategies/{strategyId}/metricsSamples for cross-device chart history.
    // Mirrors the trades subcollection pattern.
    this._metricsSampleInterval = null;

    this.isTradingSequenceInProgress = false;

    // Single-leg guard: track price of first ever position
    this.firstPositionPrice = null;

    // (HOLD time-based replan timer removed — HOLD now carries a triggerPrice
    // synthesized at current ± 3×ATR if AI didn't supply one. Replan fires
    // on price-cross via the executor's normal trigger detection path.)

    // Auto-stop hysteresis: require sustained target hit (N consecutive
    // ticks AND min elapsed duration) before closing out. Defends against
    // single-tick wicks where a transient unrealized-PnL spike on one leg
    // would otherwise force a full close at a price that immediately
    // mean-reverts. Reset to null/0 on any tick where PnL drops below target.
    this._targetReachedSinceTs = null;
    this._targetReachedTickCount = 0;
    this._targetMinTicks = 3;
    this._targetMinDurationMs = 2500;

    // L5c volatility-aware sizing. Snapshot of atrPercent at strategy start
    // is the baseline against which mid-run ATR is compared. If current ATR
    // is significantly higher, ADD orders are scaled down (CUT untouched).
    this._atrPctAtStart = null;

    // C2 funding accounting. Funding settles every 8h on Binance USDS-M
    // (00:00, 08:00, 16:00 UTC). Signed (positive = bot received funding,
    // negative = bot paid). Folded into totalPnL so the auto-stop trigger
    // and the AI prompt see it without any special handling.
    // _lastFundingPollTs is the high-water mark on the income ledger — the
    // next poll uses (it + 1) as startTime so we never double-count.
    this.accumulatedFundingFees = 0;
    this._lastFundingPollTs = null;
    this._fundingPollTimeout = null;

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

    // M7 was here — pre-flight wallet check against full-DCA margin cap.
    // Removed: the frontend deliberately sizes maxPositionSize as
    // wallet × leverage × 0.8 (MAX_POSITION_BUFFER) so Phase 2 can DCA into
    // the full margin runway. Pre-flighting against (2 × maxPos / leverage)
    // therefore tripped on every legitimate config from this app:
    //   wallet ≥ (2 × wallet × leverage × 0.8 / leverage) × 1.2
    //   wallet ≥ wallet × 1.92  → always false.
    // Real protection lives in the frontend's MAX_POSITION_BUFFER + the
    // minNotional check above + Binance's per-fill margin enforcement.

    // L5a: marketContext constructed BEFORE riskGuard so we can fetch ATR
    // and scale maxPositionSizeUSDT before the risk guard locks it in.
    this.marketContext = new AiMarketContext(this);

    // Start-time volatility-aware position-size scaling. If ATR is unusually
    // high at start, scale down both positionSizeUSDT and maxPositionSizeUSDT
    // proportionally so the strategy doesn't open overly large positions on
    // a regime shift the user wasn't expecting. Stores _atrPctAtStart for
    // L5b dynamic mid-run scaling.
    try {
      const startVol = await this.marketContext._getVolatility();
      const atrPct = startVol?.atrPercent;
      if (atrPct && atrPct > 0) {
        this._atrPctAtStart = atrPct;
        if (atrPct > ATR_PCT_HIGH_VOL) {
          const rawFactor = ATR_PCT_HIGH_VOL / atrPct;
          const factor = Math.max(VOL_SIZING_FLOOR, Math.min(1, rawFactor));
          const oldPos = this.positionSizeUSDT;
          const oldMax = this.maxPositionSizeUSDT;
          this.positionSizeUSDT = oldPos * factor;
          this.maxPositionSizeUSDT = oldMax * factor;
          await this.addLog(
            `[L5a] ATR=${atrPct.toFixed(2)}% > ${ATR_PCT_HIGH_VOL}% threshold; scaling positionSize ${oldPos.toFixed(2)} → ${this.positionSizeUSDT.toFixed(2)} USDT, ` +
            `maxPos ${oldMax.toFixed(2)} → ${this.maxPositionSizeUSDT.toFixed(2)} USDT (×${factor.toFixed(2)}, floor ${VOL_SIZING_FLOOR})`
          );
        } else {
          await this.addLog(`[L5a] ATR=${atrPct.toFixed(2)}% ≤ ${ATR_PCT_HIGH_VOL}% — no start-time scaling.`);
        }
      }
    } catch (err) {
      console.error(`[L5a] Volatility fetch failed at start, skipping scaling: ${err.message}`);
    }

    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      maxImbalanceRatio: 5.0,
      maxPriceDeviationPercent: 5.0,
      maxActionsPerHour: 20,
      minNotional,
      singleLegStopPercent: 5.0,
    });

    this.planner = new AiPlanner(anthropicApiKey, this.aiModel);
    this.executor = new AiPlanExecutor(this);

    this.isRunning = true;
    this.phase = 'INITIAL';
    this.strategyStartTime = new Date();

    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();
    this.connectLiquidationWebSocket();

    // M3: scheduledListenKeyRefresh handles retry-with-backoff before
    // falling back to WS close.
    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
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

    // C2: funding poll baseline + scheduler. Anchor at strategy start
    // (no settlements have happened yet) and align future polls to the
    // next 8h UTC boundary.
    this._lastFundingPollTs = this.strategyStartTime.getTime();
    this._scheduleNextFundingPoll();

    // HedgeMetricsChart 1/min sampler → strategies/{id}/metricsSamples
    this._startMetricsSampler();

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

    // C2: restore funding state. _lastFundingPollTs falls back to
    // strategyStartTime so a snapshot saved before the C2 fix still works.
    this.accumulatedFundingFees = snapshot.accumulatedFundingFees || 0;
    this._lastFundingPollTs = snapshot._lastFundingPollTs || this.strategyStartTime.getTime();

    // L5c: restore ATR baseline. If absent (pre-L5 snapshot), best-effort
    // refetch happens just below — we don't want pre-L5 strategies to
    // suddenly start scaling on resume against an undefined baseline.
    this._atrPctAtStart = snapshot._atrPctAtStart || null;

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

    // L5c: best-effort baseline refetch for pre-L5 snapshots. Use current ATR
    // as the baseline so dynamic mid-run scaling has SOMETHING to compare
    // against, even if it isn't the literal start-of-strategy value.
    if (this._atrPctAtStart == null) {
      try {
        const vol = await this.marketContext._getVolatility();
        if (vol?.atrPercent > 0) {
          this._atrPctAtStart = vol.atrPercent;
          await this.addLog(`[L5c] Pre-L5 snapshot: backfilled _atrPctAtStart=${vol.atrPercent.toFixed(2)}% from current ATR.`);
        }
      } catch (err) {
        console.error(`[L5c] Baseline refetch failed: ${err.message}`);
      }
    }

    this.isRunning = true;

    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();
    this.connectLiquidationWebSocket();

    // M3: scheduledListenKeyRefresh handles retry-with-backoff before
    // falling back to WS close.
    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
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

    // Phase 1 INITIAL with no positions yet is a NORMAL state — the strategy
    // was waiting for the OPEN_HEDGE trigger price to be crossed when the
    // restart hit. Resume in INITIAL phase; the strategy will request a fresh
    // plan on the first price tick and continue waiting for OPEN_HEDGE.
    // Without this branch, force-update on a Phase-1 strategy would
    // mistakenly fall through to "positions closed during downtime" and
    // mark the strategy stopped.
    if (snapshot.phase === 'INITIAL' && !longExists && !shortExists) {
      this.phase = 'INITIAL';
      await this.addLog('[RECOVERY] Phase 1 INITIAL — no positions yet (waiting for OPEN_HEDGE trigger). Resuming in INITIAL phase. Will replan on first price tick.');

      // Funding poll + metrics sampler are safe to start in INITIAL —
      // sampler skips internally when either leg has 0 qty; funding poll
      // is symbol-keyed and harmless when there are no positions.
      this._scheduleNextFundingPoll();
      this._startMetricsSampler();

      await this.saveState();
      return;
    }

    if (!longExists && !shortExists) {
      // DCA phase, both legs gone — auto-stop fired during downtime, or
      // user closed manually.
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

    // C2: catch up on any settlements during downtime, then resume scheduler.
    await this._pollFundingIncome();
    this._scheduleNextFundingPoll();

    // HedgeMetricsChart 1/min sampler — same as start()
    this._startMetricsSampler();

    await this.saveState();
  }

  async stop(reason = 'manual') {
    if (!this.isRunning) return;

    this.isStopping = true;
    this.isRunning = false;
    this.executionState = 'IDLE';
    this._stopMetricsSampler();

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
    // C2: cancel scheduled funding poll, then do one final flush so any
    // settlement that happened between the last scheduled poll and stop is
    // captured before platform fee calculation.
    if (this._fundingPollTimeout) {
      clearTimeout(this._fundingPollTimeout);
      this._fundingPollTimeout = null;
    }
    try {
      await this._pollFundingIncome();
    } catch (err) {
      console.error(`[FUNDING] final flush failed: ${err.message}`);
    }
    this.cleanupWebSockets();
    this.strategyEndTime = new Date();
    this.timeTaken = this.strategyStartTime ? formatDuration(Date.now() - new Date(this.strategyStartTime).getTime()) : null;

    await this._refreshHedgePositions();
    this._updateUnrealizedPnL(this.currentPrice);

    // Platform fee. Funding is included in net so the platform fee scales
    // with what the bot actually delivered to the user.
    const netPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees + this.accumulatedFundingFees;
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
      const { totalCost } = this._computeAiCost();
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
        fundingFees: this.accumulatedFundingFees,
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

      // (HOLD time-based replan removed — replan now fires on HOLD trigger
      // crossing via the trigger detection above. _runActionAndRecord will
      // schedule a replan when a HOLD action's triggerPrice is crossed.)
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

      // Build snapshot for AI; line numbers below stay aligned with grep:
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
        accumulatedFundingFees: this.accumulatedFundingFees,
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
        volatility: context.volatility,
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
          volatility: context.volatility,
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

      await this.addLog(`AI Plan installed${plan._schema === 'paired' ? ' [paired]' : ' [phase1]'}.`);
      await this.addLog(`Analysis: ${plan.analysis || 'N/A'}`);

      if (plan._schema === 'paired') {
        await this._logPairedPlan(plan);
      } else {
        await this._logPhase1Plan(plan);
      }
      if (plan.probabilityAssessment) {
        await this.addLog(`  Prob: ${plan.probabilityAssessment.higherChance} (${plan.probabilityAssessment.confidence}) — ${plan.probabilityAssessment.reasoning}`);
      }

      // Time-based replan timers removed (4h staleness + HOLD-replan).
      // Replan now fires on price-cross of any trigger — including HOLD
      // primaries which carry a synthesized 3×ATR triggerPrice if AI
      // didn't supply one. See _runActionAndRecord for the replan
      // dispatch when a HOLD trigger crosses.

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

    if (action.type === 'HOLD') {
      // Reaching this branch means the HOLD's triggerPrice was crossed —
      // the AI's reasoning is now invalid and we need a fresh plan. Fire
      // and forget; the new plan will replace the active one when it
      // arrives. Don't await — letting other-side triggers continue
      // processing on this tick is fine since the replacing plan
      // supersedes them anyway.
      const triggerStr = action.triggerPrice ? this._formatPrice(action.triggerPrice) : 'unknown';
      this.addLog(`HOLD trigger crossed at ${triggerStr} — requesting fresh plan.`).catch(() => {});
      this._requestNewPlan('hold_trigger_crossed').catch((e) =>
        console.error(`HOLD-trigger replan failed: ${e.message}`));
      return { isHold: true };
    }

    // M1: wait for WS to confirm fill(s) before reading positions, closing
    // the race where REST ACK beats the ACCOUNT_UPDATE event. Bounded
    // 1500ms — if WS doesn't confirm within that window the existing
    // _refreshHedgePositions retry will catch up.
    if (action.type === 'OPEN_HEDGE') {
      const longId = result?.longResult?.orderId;
      const shortId = result?.shortResult?.orderId;
      await Promise.all([
        this._waitForOrderFillConfirmation(longId, 1500),
        this._waitForOrderFillConfirmation(shortId, 1500),
      ]);
    } else if (result?.orderId) {
      await this._waitForOrderFillConfirmation(result.orderId, 1500);
    }

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
    // L2: cap in-memory plan history. AI context only uses the last 5 (line 691)
    // so dropping older entries is purely RAM hygiene, no behavior change.
    if (this.planHistory.length > 50) this.planHistory.shift();
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

  // Phase 1 plan logging — flat actionAbove/actionBelow with type=OPEN_HEDGE.
  async _logPhase1Plan(plan) {
    if (plan.actionAbove?.type === 'OPEN_HEDGE') {
      await this.addLog(`  ABOVE: OPEN_HEDGE at ${this._formatPrice(plan.actionAbove.triggerPrice)} — LONG ${plan.actionAbove.longSizeUSDT} / SHORT ${plan.actionAbove.shortSizeUSDT} USDT`);
    }
    if (plan.actionBelow?.type === 'OPEN_HEDGE') {
      await this.addLog(`  BELOW: OPEN_HEDGE at ${this._formatPrice(plan.actionBelow.triggerPrice)} — LONG ${plan.actionBelow.longSizeUSDT} / SHORT ${plan.actionBelow.shortSizeUSDT} USDT`);
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

  /**
   * HedgeMetricsChart 1/min sampler. Writes one
   * { t, gap, ratio, strategyId } doc to strategies/{id}/metricsSamples on
   * every tick. Skips when either leg has 0 quantity (matches frontend
   * gating). Called via setInterval armed in start()/resume(), cleared in
   * stop(). Mirrors the saveTrade subcollection pattern so cross-device
   * sync works without bot-side state.
   */
  async _writeMetricsSample() {
    if (!this.strategyId || !this.firestore) return;
    if (!this.longPosition || !this.shortPosition) return;
    const longQty = this.longPosition.quantity || 0;
    const shortQty = this.shortPosition.quantity || 0;
    if (!(longQty > 0) || !(shortQty > 0)) return;
    try {
      await this.firestore.collection('strategies').doc(this.strategyId)
        .collection('metricsSamples').add({
          t: Date.now(),
          gap: this.hedgeGap || 0,
          ratio: longQty / shortQty,
          strategyId: this.strategyId,
        });
    } catch (err) {
      console.error(`[METRICS-SAMPLE] write failed: ${err.message}`);
    }
  }

  _startMetricsSampler() {
    if (this._metricsSampleInterval) clearInterval(this._metricsSampleInterval);
    this._metricsSampleInterval = setInterval(() => {
      if (this.isRunning) this._writeMetricsSample();
    }, 60_000);
  }

  _stopMetricsSampler() {
    if (this._metricsSampleInterval) {
      clearInterval(this._metricsSampleInterval);
      this._metricsSampleInterval = null;
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
    // C2: include funding so auto-stop and AI prompt see the full picture.
    this.totalPnL = this.positionPnL + this.accumulatedRealizedPnL - this.accumulatedTradingFees + this.accumulatedFundingFees;
  }

  // ——— L1 AI cost computation —————————————————————————————————————————

  /**
   * Compute current AI usage cost in USD from accumulated aiTokenUsage and
   * MODEL_PRICING. Returns { inputCost, outputCost, cacheWriteCost,
   * cacheReadCost, totalCost }. Pure function over local state — no
   * network calls, safe to call from getStatus() on every poll.
   */
  _computeAiCost() {
    const u = this.aiTokenUsage || {};
    const rates = MODEL_PRICING[this.aiModel] || MODEL_PRICING['claude-sonnet-4-6'];
    const inputCost      = (u.inputTokens   || 0) / 1_000_000 * rates.input;
    const outputCost     = (u.outputTokens  || 0) / 1_000_000 * rates.output;
    const cacheWriteCost = (u.cacheCreation || 0) / 1_000_000 * rates.cacheWrite5m;
    const cacheReadCost  = (u.cacheRead     || 0) / 1_000_000 * rates.cacheRead;
    const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;
    return { inputCost, outputCost, cacheWriteCost, cacheReadCost, totalCost };
  }

  // ——— C2 Funding-fee polling —————————————————————————————————————————

  /**
   * Poll Binance /fapi/v1/income for FUNDING_FEE entries since the last
   * high-water mark and accumulate them into `accumulatedFundingFees`.
   * Idempotent: if no new entries, no-op. Failures are logged and
   * swallowed — funding poll is non-critical to trading.
   */
  async _pollFundingIncome() {
    if (!this.symbol || !this._lastFundingPollTs) return { added: 0, count: 0 };
    try {
      // startTime is +1 over the last seen entry's timestamp so we never
      // re-count the boundary entry. Limit 1000 is well above what could
      // accumulate between settlements (3/day × 2 legs = 6 entries max
      // per 8h window for a single symbol).
      const startTime = this._lastFundingPollTs + 1;
      const incomes = await this.makeProxyRequest(
        '/fapi/v1/income',
        'GET',
        { symbol: this.symbol, incomeType: 'FUNDING_FEE', startTime, limit: 1000 },
        true,
        'futures'
      ) || [];

      if (!Array.isArray(incomes) || incomes.length === 0) return { added: 0, count: 0 };

      let added = 0;
      let maxTime = this._lastFundingPollTs;
      for (const entry of incomes) {
        const v = parseFloat(entry.income);
        if (Number.isFinite(v)) {
          added += v;
          this.accumulatedFundingFees += v;
          if (entry.time > maxTime) maxTime = entry.time;
        }
      }
      this._lastFundingPollTs = maxTime;

      await this.addLog(
        `Funding settled: ${added >= 0 ? '+' : ''}${added.toFixed(4)} USDT ` +
        `(cumulative ${this.accumulatedFundingFees >= 0 ? '+' : ''}${this.accumulatedFundingFees.toFixed(4)} USDT, ${incomes.length} entries)`
      );
      await this.saveState();
      return { added, count: incomes.length };
    } catch (err) {
      console.error(`[FUNDING] poll failed: ${err.message}`);
      return { added: 0, count: 0, error: err.message };
    }
  }

  /**
   * Schedule the next funding poll aligned to the next 8h UTC settlement
   * boundary + 60s safety buffer. Self-rescheduling. Cancellable via
   * clearTimeout(this._fundingPollTimeout).
   *
   * If the primary poll at +60s returns zero entries (Binance hasn't
   * ledger'd the settlement yet), schedules a one-shot retry at +5min,
   * then resumes the normal 8h cadence regardless of retry outcome.
   */
  _scheduleNextFundingPoll() {
    const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
    const SAFETY_BUFFER_MS = 60 * 1000;          // 60s after settlement
    const RETRY_BUFFER_MS = 5 * 60 * 1000;       // 5min retry on empty

    if (this._fundingPollTimeout) {
      clearTimeout(this._fundingPollTimeout);
      this._fundingPollTimeout = null;
    }

    const now = Date.now();
    const nextSettlement = Math.ceil(now / EIGHT_HOURS_MS) * EIGHT_HOURS_MS;
    const primaryDelay = Math.max(1000, (nextSettlement - now) + SAFETY_BUFFER_MS);

    this._fundingPollTimeout = setTimeout(async () => {
      if (!this.isRunning) return;
      const result = await this._pollFundingIncome();
      // If primary poll found nothing, try once more 5min later in case
      // Binance was lagging. Don't chain further retries — that's what the
      // next 8h cycle is for.
      if (this.isRunning && result.count === 0 && !result.error) {
        this._fundingPollTimeout = setTimeout(async () => {
          if (this.isRunning) await this._pollFundingIncome();
          if (this.isRunning) this._scheduleNextFundingPoll();
        }, RETRY_BUFFER_MS);
      } else if (this.isRunning) {
        this._scheduleNextFundingPoll();
      }
    }, primaryDelay);
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
        accumulatedFundingFees: this.accumulatedFundingFees,
        _lastFundingPollTs: this._lastFundingPollTs,
        _atrPctAtStart: this._atrPctAtStart,
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
      accumulatedFundingFees: this.accumulatedFundingFees,
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
      // L1: live AI cost so the user can self-judge "stuck or just patient?"
      aiTokenUsage: { ...this.aiTokenUsage },
      aiCostUsd: this._computeAiCost().totalCost,
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,
      streamMode: this.streamMode || 'WS',
      priceFeedStale: !!this._priceFeedStale,
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
