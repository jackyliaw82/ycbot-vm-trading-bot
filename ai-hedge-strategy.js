import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import { AiPlanner } from './ai-planner.js';
import { AiPlanExecutor } from './ai-plan-executor.js';
import { AiRiskGuard, FEE_RATE } from './ai-risk-guard.js';
import { AiMarketContext } from './ai-market-context.js';
import fetch from 'node-fetch';

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
 * Phase 2 (DCA): Widens the hedge gap through DCA entries at 5m/15m S/R levels.
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
    this.isTradingSequenceInProgress = false;

    // Single-leg guard: track price of first ever position
    this.firstPositionPrice = null;

    // HOLD replan timer
    this._holdReplanAt = null;

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
    const aiModel = config.aiModel || 'claude-sonnet-4-6';

    await this.addLog(`Starting AI Hedge Strategy for ${this.symbol}...`);
    await this.addLog(`Config: posSize=${this.positionSizeUSDT} USDT, leverage=${this.leverage}x, maxPos=${this.maxPositionSizeUSDT} USDT, model=${aiModel}`);

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
    this.planner = new AiPlanner(anthropicApiKey, aiModel);
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

  async stop(reason = 'manual') {
    if (!this.isRunning) return;

    this.isStopping = true;
    this.isRunning = false;
    this.executionState = 'IDLE';

    await this.addLog(`Stopping AI Hedge Strategy. Reason: ${reason}`);

    // Close positions if not already closed
    if (reason !== 'hedge_closed') {
      try {
        await this._refreshHedgePositions();

        if (this.longPosition && this.longPosition.quantity > 0) {
          const qty = this.roundQuantity(this.longPosition.quantity);
          await this.addLog(`Closing LONG: SELL ${qty}`);
          await this.placeMarketOrder(this.symbol, 'SELL', qty, 'LONG');
        }
        if (this.shortPosition && this.shortPosition.quantity > 0) {
          const qty = this.roundQuantity(this.shortPosition.quantity);
          await this.addLog(`Closing SHORT: BUY ${qty}`);
          await this.placeMarketOrder(this.symbol, 'BUY', qty, 'SHORT');
        }

        await new Promise(r => setTimeout(r, 3000));
        await this._refreshHedgePositions();

        const longRem = this.longPosition?.quantity || 0;
        const shortRem = this.shortPosition?.quantity || 0;
        if (longRem > 0 || shortRem > 0) {
          await this.addLog(`WARNING: Positions not fully closed. LONG: ${longRem}, SHORT: ${shortRem}`);
        } else {
          await this.addLog('All positions closed.');
        }
      } catch (err) {
        await this.addLog(`ERROR: Failed to close positions: ${err.message}`);
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

    // Log AI token usage summary
    const u = this.aiTokenUsage;
    if (u.planCount > 0) {
      const inputCost = (u.inputTokens / 1_000_000) * 3.00;
      const outputCost = (u.outputTokens / 1_000_000) * 15.00;
      const totalCost = inputCost + outputCost;
      await this.addLog(`AI Usage: ${u.planCount} plans, ${u.inputTokens.toLocaleString()} input + ${u.outputTokens.toLocaleString()} output tokens (cache: ${u.cacheRead.toLocaleString()} read). Est. cost: $${totalCost.toFixed(4)}`);
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

    // Auto-stop check: totalPnL >= effectiveTarget
    if (this.desiredProfitUSDT && this.phase === 'DCA') {
      const longNotional = this.longPosition?.notional || 0;
      const shortNotional = this.shortPosition?.notional || 0;
      const estimatedClosingFees = (longNotional + shortNotional) * FEE_RATE;
      const effectiveTarget = this.desiredProfitUSDT + estimatedClosingFees;

      if (this.totalPnL >= effectiveTarget) {
        await this.addLog(`TARGET REACHED: PnL ${this._formatNotional(this.totalPnL)} >= Target ${this._formatNotional(effectiveTarget)} USDT`);
        await this.stop('profit_target_reached');
        return;
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
        phase: this.phase,
      });

      if (!validation.valid) {
        await this.addLog(`AI plan rejected: ${validation.reasons.join(', ')}`);
        plan = this.riskGuard.generateFallbackPlan(this.currentPrice, {
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          positionSizeUSDT: this.positionSizeUSDT,
          volatility: this._lastVolatility,
          phase: this.phase,
        }, 'Risk guard rejection');

        const fallbackValidation = this.riskGuard.validatePlan(plan, {
          currentPrice: this.currentPrice,
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          phase: this.phase,
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

      // Install plan
      this.activePlan = plan;
      this.executor.setActivePlan(plan);
      this.executionState = 'EXECUTING_PLAN';

      await this.addLog(`AI Plan installed.`);
      await this.addLog(`Analysis: ${plan.analysis || 'N/A'}`);

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
      if (plan.probabilityAssessment) {
        await this.addLog(`  Prob: ${plan.probabilityAssessment.higherChance} (${plan.probabilityAssessment.confidence}) — ${plan.probabilityAssessment.reasoning}`);
      }

      // HOLD replan timer
      const bothHold = plan.actionAbove?.type === 'HOLD' && plan.actionBelow?.type === 'HOLD';
      if (bothHold) {
        const minutes = Math.max(15, Math.min(120, plan.holdReplanMinutes || 30));
        this._holdReplanAt = Date.now() + minutes * 60 * 1000;
        await this.addLog(`  Both HOLD. Re-evaluate in ${minutes} min.`);
      } else {
        this._holdReplanAt = null;
      }

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
        }, 'AI error');
        this.activePlan = fallback;
        this.executor.setActivePlan(fallback);
        this.executionState = 'EXECUTING_PLAN';
        await this.addLog('Installed fallback plan due to AI error.');
      } catch (fbErr) {
        await this.addLog(`ERROR: Fallback also failed: ${fbErr.message}`);
      }
    }
  }

  async _executeTriggeredAction(triggeredAction) {
    const { action, direction } = triggeredAction;
    await this.addLog(`Executing (${direction}): ${action.type} — ${action.reason}`);

    try {
      const result = await this.executor.executeAction(action);

      if (action.type === 'HOLD') {
        await this._requestNewPlan('execution_complete');
        return;
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
        action,
        direction,
        result,
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

      await this.addLog(
        `Trade #${this.tradeCount}. ` +
        `LONG: ${this.longPosition ? this._formatNotional(this.longPosition.notional) + ' @ ' + this._formatPrice(this.longPosition.entryPrice) : 'none'}, ` +
        `SHORT: ${this.shortPosition ? this._formatNotional(this.shortPosition.notional) + ' @ ' + this._formatPrice(this.shortPosition.entryPrice) : 'none'}, ` +
        `Gap: ${this._formatPrice(this.hedgeGap)}, P&L: ${this._formatNotional(this.lockedProfit)} USDT`
      );

      await this._requestNewPlan('execution_complete');
    } catch (error) {
      await this.addLog(`ERROR: [TRADING_ERROR] ${action.type}: ${error.message}`);
      await this._requestNewPlan('execution_error');
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
        plan: { analysis: plan.analysis, actionAbove: plan.actionAbove, actionBelow: plan.actionBelow, probabilityAssessment: plan.probabilityAssessment },
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
      initialHedgeMultiplier: this.initialHedgeMultiplier,
      profitPercent: this.profitPercent,
      activePlan: this.activePlan ? { analysis: this.activePlan.analysis, actionAbove: this.activePlan.actionAbove, actionBelow: this.activePlan.actionBelow, probabilityAssessment: this.activePlan.probabilityAssessment } : null,
      tradeCount: this.tradeCount,
      planHistoryCount: this.planHistory.length,
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,
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
