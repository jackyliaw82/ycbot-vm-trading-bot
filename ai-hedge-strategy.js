import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification, sendReversalNotification } from './pushNotificationHelper.js';
import { AiPlanner } from './ai-planner.js';
import { AiPlanExecutor } from './ai-plan-executor.js';
import { AiRiskGuard } from './ai-risk-guard.js';
import { AiMarketContext } from './ai-market-context.js';

/**
 * AiHedgeStrategy — AI-driven hedge position management.
 *
 * Grows LONG and SHORT positions simultaneously, using Claude API to reason
 * about price targets, scenario plans (A/B/C), and position management.
 * When both sides reach equal size with a hedge gap, profit is locked.
 */
class AiHedgeStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // ─── Hedge-specific state ──────────────────────────────────────────────

    // Per-side position tracking (structured, AI-friendly)
    this.longPosition = null;  // { avgEntry, quantity, notional, unrealizedPnl }
    this.shortPosition = null; // { avgEntry, quantity, notional, unrealizedPnl }

    // Hedge metrics
    this.hedgeGap = 0;           // shortAvgEntry - longAvgEntry
    this.lockedProfit = 0;       // (shortAvgEntry - longAvgEntry) * min(longQty, shortQty)
    this.desiredProfitUSDT = null; // Auto-stop when locked profit hits this

    // AI execution state
    this.executionState = 'IDLE'; // 'IDLE' | 'WAITING_FOR_PLAN' | 'EXECUTING_PLAN' | 'REPLANNING'
    this.activePlan = null;       // Current AI-generated plan (planA/B/C + triggers)
    this.selectedPlanKey = null;  // 'planA' | 'planB' | 'planC'
    this.planHistory = [];        // Array of past plans and outcomes (kept in memory for context)

    // Strategy config
    this.positionSizeUSDT = 0;   // Base position size per entry
    this.leverage = DEFAULT_LEVERAGE;
    this.maxPositionSizeUSDT = 0; // Max total notional across both sides

    // Trade tracking
    this.tradeCount = 0;
    this.strategyStartTime = null;
    this.initialWalletBalance = null;

    // Market volatility (updated on each plan request)
    this._lastVolatility = null; // { atr, atrPercent, interpretation }

    // AI modules (initialized in start())
    this.planner = null;
    this.executor = null;
    this.riskGuard = null;
    this.marketContext = null;

    // Price tracking for crossing detection
    this.lastProcessedPrice = null;

    // Replan cooldown — prevent excessive API calls
    this._lastReplanTime = 0;
    this._replanCooldownMs = 5000; // 5s minimum between replans

    // Flag to prevent overlapping trading sequences
    this.isTradingSequenceInProgress = false;
  }

  // ─── Strategy lifecycle ──────────────────────────────────────────────────

  async start(config = {}) {
    if (this.isRunning) {
      await this.addLog('Strategy is already running.');
      return;
    }

    // Generate unique strategyId
    this.strategyId = `ai_hedge_${this.profileId}_${Date.now()}`;
    this.initFirestoreCollections(this.strategyId);

    // Apply config
    this.symbol = config.symbol || 'BTCUSDT';
    this.positionSizeUSDT = config.positionSizeUSDT || 120;
    this.leverage = config.leverage || DEFAULT_LEVERAGE;
    this.desiredProfitUSDT = config.desiredProfitUSDT || null;
    this.priceType = config.priceType || 'MARK';
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || (this.positionSizeUSDT * 20);

    // AI config — fetch Anthropic API key from Secret Manager or env var
    const anthropicApiKey = await this._fetchAnthropicApiKey(config.anthropicApiKeySecretName);
    const aiModel = config.aiModel || 'claude-sonnet-4-6';

    await this.addLog(`Starting AI Hedge Strategy for ${this.symbol}...`);
    await this.addLog(`Config: posSize=${this.positionSizeUSDT} USDT, leverage=${this.leverage}x, maxPos=${this.maxPositionSizeUSDT} USDT, model=${aiModel}`);

    // Setup exchange
    try {
      await this.setLeverage(this.symbol, this.leverage);
      await this.setPositionMode(true); // Hedge mode
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`ERROR: [SETUP_ERROR] Failed to setup exchange: ${error.message}`);
      throw error;
    }

    // Get wallet balance
    this.initialWalletBalance = await this.getWalletBalance();
    await this.addLog(`Wallet balance: ${this._formatNotional(this.initialWalletBalance)} USDT`);

    // Initialize AI modules
    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      maxImbalanceRatio: 3.0,
      maxPriceDeviationPercent: 5.0,
      maxActionsPerHour: 20,
      maxUnrealizedLossPercent: 30,
      minNotional: this.exchangeInfoCache[this.symbol]?.minNotional || 5,
    });

    this.marketContext = new AiMarketContext(this);
    this.planner = new AiPlanner(anthropicApiKey, aiModel);
    this.executor = new AiPlanExecutor(this);

    // Setup WebSocket connections
    this.isRunning = true;
    this.strategyStartTime = new Date();

    const listenKeyResponse = await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    // Start listenKey refresh interval
    this.listenKeyRefreshInterval = setInterval(async () => {
      try {
        await this._retryListenKeyRequest(true);
      } catch (error) {
        console.error(`Failed to refresh listenKey: ${error.message}`);
        await this.addLog(`ERROR: [CONNECTION_ERROR] ListenKey refresh failed: ${error.message}`);
        if (this.listenKeyRefreshInterval) {
          clearInterval(this.listenKeyRefreshInterval);
          this.listenKeyRefreshInterval = null;
        }
        if (this.userDataWs && this.userDataWs.readyState === 1) {
          this.userDataWs.close(1000, 'Reconnecting due to listenKey refresh failure');
        }
      }
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Detect any existing positions
    await this.detectCurrentPosition(true);
    await this._refreshHedgePositions();

    await this.addLog('AI Hedge Strategy started. Waiting for first price tick to request initial plan...');
    await this.saveState();
  }

  async stop(reason = 'manual') {
    if (!this.isRunning) return;

    this.isStopping = true;
    this.isRunning = false;
    this.executionState = 'IDLE';

    await this.addLog(`Stopping AI Hedge Strategy. Reason: ${reason}`);

    // Cleanup WebSockets
    this.cleanupWebSockets();

    // Final state save
    await this._refreshHedgePositions();
    await this.saveState();

    this.isStopping = false;
    await this.addLog('AI Hedge Strategy stopped.');

    // Send notification
    try {
      await sendStrategyCompletionNotification(this.profileId, this.strategyId, {
        symbol: this.symbol,
        totalPnL: this.totalPnL,
        reason,
      });
    } catch (e) {
      console.error('Failed to send completion notification:', e.message);
    }
  }

  // ─── Core price handler ──────────────────────────────────────────────────

  async handleRealtimePrice(price) {
    if (!this.isRunning) return;

    const prevPrice = this.lastProcessedPrice;
    this.currentPrice = price;
    this.lastProcessedPrice = price;

    // Update PnL
    this._updateUnrealizedPnL(price);

    // Check locked profit target (dynamic breakeven: accounts for accumulated losses + fees)
    if (this.desiredProfitUSDT) {
      const realizedLoss = Math.min(0, this.accumulatedRealizedPnL); // only count losses
      const breakeven = Math.abs(realizedLoss) + this.accumulatedTradingFees;
      const effectiveTarget = this.desiredProfitUSDT + breakeven;

      if (this.lockedProfit >= effectiveTarget) {
        await this.addLog(`TARGET REACHED: Locked ${this._formatNotional(this.lockedProfit)} USDT >= Effective Target ${this._formatNotional(effectiveTarget)} USDT (Desired ${this._formatNotional(this.desiredProfitUSDT)} + Breakeven ${this._formatNotional(breakeven)})`);
        await this.stop('locked_profit_target_reached');
        return;
      }
    }

    // Request initial plan on first tick
    if (!this.activePlan && this.executionState === 'IDLE') {
      this.executionState = 'WAITING_FOR_PLAN';
      await this._requestNewPlan('initial');
      return;
    }

    // Check triggers if we have an active plan
    if (this.activePlan && this.executionState === 'EXECUTING_PLAN' && prevPrice !== null) {
      if (this.isTradingSequenceInProgress) return; // Prevent overlap

      const triggeredAction = this.executor.checkTriggers(prevPrice, price);
      if (triggeredAction) {
        this.isTradingSequenceInProgress = true;
        try {
          await this._executeTriggeredAction(triggeredAction);
        } finally {
          this.isTradingSequenceInProgress = false;
        }
      }
    }

    // Check if replan trigger hit
    if (this.activePlan && this.activePlan.nextReplanTrigger && prevPrice !== null) {
      const trigger = this.activePlan.nextReplanTrigger;
      if (trigger.type === 'PRICE') {
        const crossed = trigger.direction === 'ABOVE'
          ? (prevPrice < trigger.value && price >= trigger.value)
          : (prevPrice > trigger.value && price <= trigger.value);
        if (crossed) {
          await this.addLog(`Replan trigger hit at ${this._formatPrice(price)} (${trigger.direction} ${this._formatPrice(trigger.value)})`);
          await this._requestNewPlan('replan_trigger');
        }
      }
    }
  }

  // ─── AI plan management ──────────────────────────────────────────────────

  async _requestNewPlan(reason = 'execution_complete') {
    // Cooldown check
    const now = Date.now();
    if (now - this._lastReplanTime < this._replanCooldownMs) {
      return;
    }
    this._lastReplanTime = now;

    this.executionState = 'WAITING_FOR_PLAN';
    await this.addLog(`Requesting AI plan... Reason: ${reason}`);

    try {
      // Build market context
      // Calculate dynamic breakeven for AI context
      const realizedLoss = Math.min(0, this.accumulatedRealizedPnL);
      const breakeven = Math.abs(realizedLoss) + this.accumulatedTradingFees;
      const effectiveTarget = this.desiredProfitUSDT ? this.desiredProfitUSDT + breakeven : null;

      const context = await this.marketContext.buildContext({
        longPosition: this.longPosition,
        shortPosition: this.shortPosition,
        hedgeGap: this.hedgeGap,
        lockedProfit: this.lockedProfit,
        desiredProfitUSDT: this.desiredProfitUSDT,
        breakeven,
        effectiveTarget,
        walletBalance: this.initialWalletBalance,
        positionSizeUSDT: this.positionSizeUSDT,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        previousPlan: this.activePlan,
        planHistory: this.planHistory.slice(-5), // Last 5 plans for context
      });

      // Store volatility data for status endpoint
      if (context.volatility) {
        this._lastVolatility = context.volatility;
      }

      // Generate plan
      let plan = await this.planner.generatePlan(context);

      // Validate through risk guard
      const validation = this.riskGuard.validatePlan(plan, {
        currentPrice: this.currentPrice,
        longPosition: this.longPosition,
        shortPosition: this.shortPosition,
        walletBalance: this.initialWalletBalance,
      });

      if (!validation.valid) {
        await this.addLog(`AI plan rejected by risk guard: ${validation.reasons.join(', ')}`);
        // Try fallback
        plan = this.riskGuard.generateFallbackPlan(this.currentPrice, {
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          positionSizeUSDT: this.positionSizeUSDT,
        });
        await this.addLog('Using fallback DCA plan.');
      }

      // Install plan
      this.activePlan = plan;
      this.selectedPlanKey = plan.recommendedPlan || 'planA';
      this.executor.setActivePlan(plan, this.selectedPlanKey);
      this.executionState = 'EXECUTING_PLAN';

      await this.addLog(`AI Plan installed. Recommended: Plan ${plan.recommendedPlan || 'A'}`);
      await this.addLog(`Analysis: ${plan.analysis || 'N/A'}`);

      const selectedPlan = plan[`plan${plan.recommendedPlan || 'A'}`];
      if (selectedPlan && selectedPlan.actions) {
        for (const action of selectedPlan.actions) {
          await this.addLog(`  → ${action.type} at ${this._formatPrice(action.triggerPrice)} (${action.reason})`);
        }
      }

      await this.saveState();
    } catch (error) {
      await this.addLog(`ERROR: [AI_ERROR] Failed to get AI plan: ${error.message}`);
      this.executionState = 'IDLE';

      // Fallback
      try {
        const fallbackPlan = this.riskGuard.generateFallbackPlan(this.currentPrice, {
          longPosition: this.longPosition,
          shortPosition: this.shortPosition,
          positionSizeUSDT: this.positionSizeUSDT,
        });
        this.activePlan = fallbackPlan;
        this.selectedPlanKey = 'planA';
        this.executor.setActivePlan(fallbackPlan, 'planA');
        this.executionState = 'EXECUTING_PLAN';
        await this.addLog('Installed fallback DCA plan due to AI error.');
      } catch (fallbackError) {
        await this.addLog(`ERROR: [AI_ERROR] Fallback plan also failed: ${fallbackError.message}`);
      }
    }
  }

  async _executeTriggeredAction(triggeredAction) {
    const { action, planKey } = triggeredAction;
    await this.addLog(`Executing: ${action.type} — ${action.reason}`);

    try {
      const result = await this.executor.executeAction(action);

      // Record result
      this.tradeCount++;
      const outcome = {
        action,
        planKey,
        result,
        price: this.currentPrice,
        timestamp: new Date(),
        longPosition: this.longPosition ? { ...this.longPosition } : null,
        shortPosition: this.shortPosition ? { ...this.shortPosition } : null,
      };

      // Add to plan history
      this.planHistory.push({
        plan: this.activePlan,
        selectedPlan: this.selectedPlanKey,
        triggeredAction: action,
        outcome,
        timestamp: new Date(),
      });

      // Save plan to Firestore
      await this._savePlanToFirestore(this.activePlan, outcome);

      // Refresh positions after trade
      await this.detectCurrentPosition(true);
      await this._refreshHedgePositions();

      await this.addLog(
        `Trade #${this.tradeCount} executed. ` +
        `LONG: ${this.longPosition ? this._formatNotional(this.longPosition.notional) + ' USDT @ ' + this._formatPrice(this.longPosition.avgEntry) : 'none'}, ` +
        `SHORT: ${this.shortPosition ? this._formatNotional(this.shortPosition.notional) + ' USDT @ ' + this._formatPrice(this.shortPosition.avgEntry) : 'none'}, ` +
        `Gap: ${this._formatPrice(this.hedgeGap)}, Locked: ${this._formatNotional(this.lockedProfit)} USDT`
      );

      // Check if CLOSE_HEDGE
      if (action.type === 'CLOSE_HEDGE') {
        await this.addLog('CLOSE_HEDGE executed. Strategy completing.');
        await this.stop('hedge_closed');
        return;
      }

      // Request new plan after execution
      await this._requestNewPlan('execution_complete');

    } catch (error) {
      await this.addLog(`ERROR: [TRADING_ERROR] Failed to execute ${action.type}: ${error.message}`);
      // Don't stop — just request a new plan
      await this._requestNewPlan('execution_error');
    }
  }

  // ─── Secret Manager helpers ──────────────────────────────────────────────────

  async _fetchAnthropicApiKey(secretName) {
    // Fallback to env var for backward compatibility
    if (!secretName) {
      const envKey = process.env.ANTHROPIC_API_KEY;
      if (envKey) return envKey;
      throw new Error('No Anthropic API key configured. Set it in your trading profile.');
    }

    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const [version] = await client.accessSecretVersion({
      name: `${secretName}/versions/latest`,
    });
    return version.payload.data.toString('utf8');
  }

  // ─── Position & PnL helpers ────────────────────────────────────────────────

  async _refreshHedgePositions() {
    const hedgePositions = await this.detectHedgePositions();

    this.longPosition = hedgePositions.long;
    this.shortPosition = hedgePositions.short;

    // Calculate hedge metrics
    if (this.longPosition && this.shortPosition) {
      this.hedgeGap = this.shortPosition.entryPrice - this.longPosition.entryPrice;
      const minQty = Math.min(this.longPosition.quantity, this.shortPosition.quantity);
      this.lockedProfit = this.hedgeGap > 0 ? this.hedgeGap * minQty : 0;
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

  // ─── State persistence ─────────────────────────────────────────────────────

  async saveState() {
    if (!this.strategyId) return;

    try {
      const strategyRef = this.firestore.collection('strategies').doc(this.strategyId);
      await strategyRef.set({
        type: 'AI_HEDGE',
        strategyId: this.strategyId,
        profileId: this.profileId,
        symbol: this.symbol,
        isRunning: this.isRunning,
        executionState: this.executionState,

        // Positions
        longPosition: this.longPosition,
        shortPosition: this.shortPosition,
        hedgeGap: this.hedgeGap,
        lockedProfit: this.lockedProfit,

        // PnL
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

        // Config
        positionSizeUSDT: this.positionSizeUSDT,
        maxPositionSizeUSDT: this.maxPositionSizeUSDT,
        leverage: this.leverage,
        desiredProfitUSDT: this.desiredProfitUSDT,
        priceType: this.priceType,

        // AI plan state
        activePlan: this.activePlan,
        selectedPlanKey: this.selectedPlanKey,

        // Tracking
        tradeCount: this.tradeCount,
        initialWalletBalance: this.initialWalletBalance,
        strategyStartTime: this.strategyStartTime,

        // WebSocket statuses
        realtimeWsConnected: this.realtimeWsConnected,
        userDataWsConnected: this.userDataWsConnected,

        lastUpdated: new Date(),
      }, { merge: true });
    } catch (error) {
      console.error(`Failed to save AI Hedge state: ${error.message}`);
    }
  }

  async loadState(strategyId) {
    try {
      this.strategyId = strategyId;
      this.initFirestoreCollections(strategyId);

      const strategyRef = this.firestore.collection('strategies').doc(strategyId);
      const doc = await strategyRef.get();

      if (!doc.exists) {
        await this.addLog(`No saved state found for ${strategyId}.`);
        return false;
      }

      const data = doc.data();
      if (data.type !== 'AI_HEDGE') {
        await this.addLog(`Strategy ${strategyId} is not an AI_HEDGE strategy.`);
        return false;
      }

      // Restore state
      this.symbol = data.symbol || 'BTCUSDT';
      this.executionState = data.executionState || 'IDLE';
      this.longPosition = data.longPosition || null;
      this.shortPosition = data.shortPosition || null;
      this.hedgeGap = data.hedgeGap || 0;
      this.lockedProfit = data.lockedProfit || 0;
      this.currentPrice = data.currentPrice || null;
      this.positionPnL = data.positionPnL || 0;
      this.totalPnL = data.totalPnL || 0;
      this.longPositionPnL = data.longPositionPnL || 0;
      this.shortPositionPnL = data.shortPositionPnL || 0;
      this.accumulatedRealizedPnL = data.accumulatedRealizedPnL || 0;
      this.accumulatedTradingFees = data.accumulatedTradingFees || 0;
      this.longAccumulatedRealizedPnL = data.longAccumulatedRealizedPnL || 0;
      this.shortAccumulatedRealizedPnL = data.shortAccumulatedRealizedPnL || 0;
      this.longTradingFees = data.longTradingFees || 0;
      this.shortTradingFees = data.shortTradingFees || 0;
      this.positionSizeUSDT = data.positionSizeUSDT || 120;
      this.maxPositionSizeUSDT = data.maxPositionSizeUSDT || 0;
      this.leverage = data.leverage || DEFAULT_LEVERAGE;
      this.desiredProfitUSDT = data.desiredProfitUSDT || null;
      this.priceType = data.priceType || 'MARK';
      this.activePlan = data.activePlan || null;
      this.selectedPlanKey = data.selectedPlanKey || null;
      this.tradeCount = data.tradeCount || 0;
      this.initialWalletBalance = data.initialWalletBalance || null;
      this.strategyStartTime = data.strategyStartTime?.toDate ? data.strategyStartTime.toDate() : data.strategyStartTime || null;

      await this.addLog(`State loaded for ${strategyId}. Trades: ${this.tradeCount}, Locked: ${this._formatNotional(this.lockedProfit)} USDT`);
      return true;
    } catch (error) {
      console.error(`Failed to load AI Hedge state: ${error.message}`);
      return false;
    }
  }

  async _savePlanToFirestore(plan, outcome) {
    if (!this.strategyId) return;
    try {
      const planRef = this.firestore.collection('strategies').doc(this.strategyId).collection('aiPlans');
      await planRef.add({
        plan: {
          analysis: plan.analysis,
          recommendedPlan: plan.recommendedPlan,
          planA: plan.planA,
          planB: plan.planB,
          planC: plan.planC,
        },
        outcome: outcome ? {
          action: outcome.action,
          planKey: outcome.planKey,
          price: outcome.price,
          longPosition: outcome.longPosition,
          shortPosition: outcome.shortPosition,
        } : null,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`Failed to save plan to Firestore: ${error.message}`);
    }
  }

  // ─── Status for API ────────────────────────────────────────────────────────

  getStatus() {
    return {
      type: 'AI_HEDGE',
      strategyId: this.strategyId,
      isRunning: this.isRunning,
      symbol: this.symbol,
      executionState: this.executionState,
      currentPrice: this.currentPrice,

      // Positions
      longPosition: this.longPosition,
      shortPosition: this.shortPosition,
      hedgeGap: this.hedgeGap,
      lockedProfit: this.lockedProfit,
      desiredProfitUSDT: this.desiredProfitUSDT,

      // PnL
      positionPnL: this.positionPnL,
      totalPnL: this.totalPnL,
      longPositionPnL: this.longPositionPnL,
      shortPositionPnL: this.shortPositionPnL,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL,
      accumulatedTradingFees: this.accumulatedTradingFees,

      // Dynamic breakeven target
      breakeven: Math.abs(Math.min(0, this.accumulatedRealizedPnL)) + this.accumulatedTradingFees,
      effectiveTarget: this.desiredProfitUSDT
        ? this.desiredProfitUSDT + Math.abs(Math.min(0, this.accumulatedRealizedPnL)) + this.accumulatedTradingFees
        : null,
      progressToTarget: this.desiredProfitUSDT
        ? (this.lockedProfit / (this.desiredProfitUSDT + Math.abs(Math.min(0, this.accumulatedRealizedPnL)) + this.accumulatedTradingFees)) * 100
        : null,

      // Config
      positionSizeUSDT: this.positionSizeUSDT,
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      leverage: this.leverage,

      // AI
      activePlan: this.activePlan ? {
        analysis: this.activePlan.analysis,
        recommendedPlan: this.activePlan.recommendedPlan,
        selectedPlan: this.selectedPlanKey,
      } : null,
      tradeCount: this.tradeCount,
      planHistoryCount: this.planHistory.length,

      // WebSocket
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,

      // Volatility
      volatility: this._lastVolatility,

      // Timing
      strategyStartTime: this.strategyStartTime,
      initialWalletBalance: this.initialWalletBalance,
    };
  }

  /**
   * Manually trigger a replan (e.g., from API endpoint).
   */
  async manualReplan() {
    if (!this.isRunning) {
      throw new Error('Strategy is not running.');
    }
    this._lastReplanTime = 0; // Reset cooldown
    await this._requestNewPlan('manual');
  }
}

export default AiHedgeStrategy;
export { AiHedgeStrategy };
