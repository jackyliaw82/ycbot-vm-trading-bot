import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import { AiPlanner } from './ai-planner.js';
import { AiPlanExecutor } from './ai-plan-executor.js';
import { AiRiskGuard, FEE_RATE } from './ai-risk-guard.js';
import { AiMarketContext } from './ai-market-context.js';

// Per-model pricing in USD per million tokens. Mirrors ai-hedge-strategy.js.
const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0, cacheWrite5m: 3.75,  cacheRead: 0.30 },
  'claude-opus-4-7':   { input: 15.0, output: 75.0, cacheWrite5m: 18.75, cacheRead: 1.50 },
};

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;       // AI Context 2 cadence
const MARGIN_HEADROOM_FLOOR_PCT = 30;              // free margin floor for sizing safety
const HARVEST_LOSS_THRESHOLD_PCT = 0.30;           // 30% of initial capital — gate for HARVEST eligibility
const DEFAULT_RECOVERY_FACTOR = 0.20;
const DEFAULT_RECOVERY_DISTANCE = 0.005;           // 0.5%
const STALE_RETRY_BASE_MS = 30 * 1000;
const STALE_RETRY_MAX_MS = 30 * 60 * 1000;

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
 * AiReversalStrategy — AI-driven volume-based reversal strategy.
 *
 * Single-sided position management on Binance USDⓈ-M Perp Futures in
 * one-way position mode. AI selects bullLevel + bearLevel from volume
 * profile; reversals fire on opposite-level touches with a dynamic
 * sizing formula; AI may HARVEST when accumulated_loss ≥ 30% of initial
 * capital AND position is profitable. Cycle ends ONLY at Final TP, user
 * Stop, or unrecoverable system error.
 *
 * AI consult contexts:
 *   - 'plan'      → emit fresh bullLevel/bearLevel (cycle start + post-HARVEST)
 *   - 'heartbeat' → every 5min while position open: CONTINUE / ADJUST / HARVEST
 *   - 'veto'      → out-of-band before each reversal: CONTINUE / REDUCE size
 *
 * State machine:
 *   INITIAL → WAITING → (LONG_HELD | SHORT_HELD) → (reverse or HARVESTING → WAITING) → EXITED
 */
class AiReversalStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // Reversal-specific state
    this.strategyType = 'reversal';
    this.currentSide = null;                // 'LONG' | 'SHORT' | null
    this.currentPosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
    this.bullLevel = null;
    this.bearLevel = null;
    this.finalTpPrice = null;
    this.cycleAccumulatedLoss = 0;
    this.reversalCount = 0;
    this.harvestCount = 0;
    this.initialCapital = 0;
    this.currentInitialSize = 0;
    this.cycleStartTime = null;
    this.executionState = 'IDLE';           // IDLE | PLANNING | EXECUTING | TERMINATED
    this.subState = 'INITIAL';              // INITIAL | WAITING | LONG_HELD | SHORT_HELD | HARVESTING | EXITED

    // Sizing config
    this.recoveryFactor = DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = 0;

    // AI modules
    this.planner = null;
    this.executor = null;
    this.riskGuard = null;
    this.marketContext = null;

    // Plan + history
    this.activePlan = null;                 // last PLAN response from AI
    this.lastDecision = null;               // last heartbeat decision
    this.planHistory = [];

    // Token usage accumulators
    this.aiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };

    // Heartbeat scheduler
    this._heartbeatTimer = null;

    // Stale retry on AI failure
    this._staleRetryAttempt = 0;
    this._staleRetryTimer = null;
  }

  // ——— Lifecycle ——————————————————————————————————————————————————————

  /**
   * Start the strategy. Forces one-way position mode, instantiates AI
   * modules, subscribes to WS streams, requests first PLAN.
   */
  async start(config) {
    const {
      symbol,
      leverage = DEFAULT_LEVERAGE,
      initialSize,
      recoveryFactor = DEFAULT_RECOVERY_FACTOR,
      recoveryDistance = DEFAULT_RECOVERY_DISTANCE,
      harvestLossThreshold = HARVEST_LOSS_THRESHOLD_PCT,
      desiredProfitUSDT = 0,
      maxPositionSizeUSDT = 0,
      priceType = 'MARK',
      aiModel = 'claude-sonnet-4-6',
      anthropicApiKey,
      apiKey,
      apiSecret,
      userId,
    } = config;

    if (!symbol) throw new Error('AiReversalStrategy.start: missing symbol');
    if (!initialSize || initialSize <= 0) throw new Error('AiReversalStrategy.start: invalid initialSize');
    if (!anthropicApiKey) throw new Error('AiReversalStrategy.start: missing anthropicApiKey');

    this.symbol = symbol;
    this.leverage = leverage;
    this.maxPositionSizeUSDT = maxPositionSizeUSDT || initialSize * 10;
    this.priceType = priceType;
    this.aiModel = aiModel;
    this.userId = userId;
    this.recoveryFactor = recoveryFactor;
    this.recoveryDistance = recoveryDistance;
    this.harvestLossThreshold = harvestLossThreshold;
    this.desiredProfitUSDT = desiredProfitUSDT;
    this.currentInitialSize = initialSize;

    await this.addLog(`[REVERSAL] start: symbol=${symbol} initialSize=${initialSize} leverage=${leverage}x model=${aiModel}`);

    // Configure Binance credentials + symbol metadata first (TradingBase machinery).
    await this._configureBinance(apiKey, apiSecret);
    await this._getExchangeInfo(symbol);

    // ONE-WAY position mode — reversal is single-sided. Mutually exclusive with hedge mode at account level.
    try {
      await this.setPositionMode(false);
      await this.addLog('[REVERSAL] Binance position mode set to ONE-WAY');
    } catch (err) {
      // If already in one-way, Binance returns an error — non-fatal.
      await this.addLog(`[REVERSAL] setPositionMode(false) note: ${err.message}`);
    }
    await this.setLeverage(symbol, leverage);

    // Initial capital snapshot (used by harvest gate + sizing self-regulation).
    const wallet = await this.getWalletBalance();
    this.initialCapital = wallet || initialSize;
    await this.addLog(`[REVERSAL] initialCapital snapshot: ${this.initialCapital} USDT`);

    // Instantiate AI modules.
    this.planner = new AiPlanner(anthropicApiKey, aiModel);
    this.executor = new AiPlanExecutor(this);
    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      minNotional: this.minNotional || 5,
    });
    this.marketContext = new AiMarketContext(this);

    // Connect WS streams.
    await this.connectRealtimeWebSocket();
    await this.connectUserDataStream();
    await this.connectLiquidationWebSocket();

    // Detect any pre-existing position on this symbol (e.g., after VM restart).
    await this._refreshCurrentPosition();

    this.cycleStartTime = Date.now();
    this.executionState = 'PLANNING';
    this.subState = 'INITIAL';
    this.isRunning = true;
    await this._saveState();

    // First PLAN request — sets bullLevel + bearLevel.
    await this._requestPlan('cycle_start');

    // Start heartbeat scheduler.
    this._startHeartbeat();
  }

  /**
   * Resume a strategy from a Firestore snapshot. Used on VM restart.
   */
  async resume(snapshot) {
    if (!snapshot) throw new Error('AiReversalStrategy.resume: missing snapshot');

    this.symbol = snapshot.symbol;
    this.leverage = snapshot.leverage || DEFAULT_LEVERAGE;
    this.maxPositionSizeUSDT = snapshot.maxPositionSizeUSDT || 0;
    this.priceType = snapshot.priceType || 'MARK';
    this.aiModel = snapshot.aiModel || 'claude-sonnet-4-6';
    this.userId = snapshot.userId;
    this.recoveryFactor = snapshot.config?.recoveryFactor || DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = snapshot.config?.recoveryDistance || DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = snapshot.config?.harvestLossThreshold || HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = snapshot.config?.desiredProfitUSDT || 0;
    this.currentInitialSize = snapshot.currentInitialSize || snapshot.config?.initialSize || 0;
    this.initialCapital = snapshot.initialCapital || 0;

    this.currentSide = snapshot.currentSide || null;
    this.currentPosition = snapshot.currentPosition || null;
    this.bullLevel = snapshot.bullLevel || null;
    this.bearLevel = snapshot.bearLevel || null;
    this.finalTpPrice = snapshot.finalTpPrice || null;
    this.cycleAccumulatedLoss = snapshot.cycleAccumulatedLoss || 0;
    this.reversalCount = snapshot.reversalCount || 0;
    this.harvestCount = snapshot.harvestCount || 0;
    this.cycleStartTime = snapshot.cycleStartTime || Date.now();
    this.subState = snapshot.subState || 'WAITING';
    this.executionState = 'IDLE';
    this.accumulatedRealizedPnL = snapshot.accumulatedRealizedPnL || 0;
    this.accumulatedTradingFees = snapshot.accumulatedTradingFees || 0;
    this.accumulatedFundingFees = snapshot.accumulatedFundingFees || 0;
    this.planHistory = snapshot.planHistory || [];
    this.activePlan = snapshot.activePlan || null;
    this.aiTokenUsage = snapshot.aiTokenUsage || { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };

    await this.addLog(`[REVERSAL] resume: subState=${this.subState} side=${this.currentSide || 'NONE'} reversals=${this.reversalCount} harvests=${this.harvestCount} accLoss=${this.cycleAccumulatedLoss}`);

    await this._configureBinance(snapshot.apiKey, snapshot.apiSecret);
    await this._getExchangeInfo(this.symbol);

    this.planner = new AiPlanner(snapshot.anthropicApiKey, this.aiModel);
    this.executor = new AiPlanExecutor(this);
    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      minNotional: this.minNotional || 5,
    });
    this.marketContext = new AiMarketContext(this);

    await this.connectRealtimeWebSocket();
    await this.connectUserDataStream();
    await this.connectLiquidationWebSocket();

    await this._refreshCurrentPosition();

    this.isRunning = true;
    this._startHeartbeat();
  }

  /**
   * Stop the strategy. Optionally flat the current position before stopping.
   */
  async stop(options = {}) {
    const { flatten = false } = options;
    this.isRunning = false;
    this._stopHeartbeat();
    if (this._staleRetryTimer) {
      clearTimeout(this._staleRetryTimer);
      this._staleRetryTimer = null;
    }
    if (flatten && this.currentPosition && this.currentPosition.quantity > 0) {
      try {
        await this.addLog('[REVERSAL] stop: flattening current position');
        await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason: 'user-stop' });
      } catch (err) {
        await this.addLog(`[REVERSAL] stop: flatten failed: ${err.message}`);
      }
    }
    this.executionState = 'TERMINATED';
    this.subState = 'EXITED';
    await this._saveState();
    await this.addLog('[REVERSAL] stop: terminated');
  }

  async onStopComplete() {
    return this.stop({ flatten: false });
  }

  // ——— Price tick handling ——————————————————————————————————————————

  /**
   * Called from the realtime WS price stream. Dispatches level-touch logic.
   */
  async handleRealtimePrice(price) {
    if (!this.isRunning) return;
    if (!Number.isFinite(price) || price <= 0) return;
    this.currentPrice = price;

    // Final TP check — highest priority. If hit, close to flat and terminate cycle.
    if (this.currentPosition && this.finalTpPrice && this._checkFinalTpHit(price)) {
      await this._handleFinalTpHit();
      return;
    }

    // Level-touch dispatch.
    if (this.subState === 'WAITING' && this.bullLevel != null && this.bearLevel != null) {
      if (price >= this.bullLevel) {
        await this._openInitialPosition('LONG', this.bullLevel);
      } else if (price <= this.bearLevel) {
        await this._openInitialPosition('SHORT', this.bearLevel);
      }
    } else if (this.subState === 'LONG_HELD' && this.bearLevel != null && price <= this.bearLevel) {
      await this._performReversal('SHORT');
    } else if (this.subState === 'SHORT_HELD' && this.bullLevel != null && price >= this.bullLevel) {
      await this._performReversal('LONG');
    }
  }

  // ——— Plan / Heartbeat / Veto consults ——————————————————————————————

  async _requestPlan(reason) {
    if (this.executionState === 'TERMINATED') return;
    this.executionState = 'PLANNING';
    await this.addLog(`[REVERSAL] _requestPlan(${reason})`);
    try {
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({ consultContext: 'plan' }));
      const plan = await this.planner.generatePlan(ctx, 'reversal');
      this._accumulateAiUsage(plan);
      const validation = this.riskGuard.validatePlan(plan, ctx);
      if (!validation.valid) {
        await this.addLog(`[REVERSAL] PLAN validation failed: ${validation.reasons.join('; ')}`);
        this._scheduleStaleRetry('plan', reason);
        return;
      }
      await this._handlePlanResponse(plan, reason);
      this._staleRetryAttempt = 0;
    } catch (err) {
      await this.addLog(`[REVERSAL] _requestPlan error: ${err.message}`);
      this._scheduleStaleRetry('plan', reason);
    }
  }

  async _requestHeartbeat() {
    if (!this.isRunning || this.executionState === 'TERMINATED') return;
    if (!this.currentPosition || !this.currentPosition.quantity) return;  // only consult while holding
    await this.addLog('[REVERSAL] _requestHeartbeat');
    try {
      const harvestEligible = this._isHarvestEligible();
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({
        consultContext: 'heartbeat',
        harvestEligible,
      }));
      const plan = await this.planner.generatePlan(ctx, 'reversal');
      this._accumulateAiUsage(plan);
      const validation = this.riskGuard.validatePlan(plan, ctx);
      if (!validation.valid) {
        await this.addLog(`[REVERSAL] HEARTBEAT validation failed: ${validation.reasons.join('; ')}`);
        return;
      }
      await this._handleHeartbeatResponse(plan);
    } catch (err) {
      await this.addLog(`[REVERSAL] _requestHeartbeat error: ${err.message}`);
    }
  }

  async _requestVeto(proposedNewSize) {
    try {
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({
        consultContext: 'veto',
        vetoMode: true,
        proposedNewSize,
      }));
      const plan = await this.planner.generatePlan(ctx, 'reversal');
      this._accumulateAiUsage(plan);
      const validation = this.riskGuard.validatePlan(plan, ctx);
      if (!validation.valid) {
        await this.addLog(`[REVERSAL] VETO validation failed: ${validation.reasons.join('; ')} — falling back to proposed size`);
        return proposedNewSize;
      }
      if (plan.decision === 'REDUCE' && typeof plan.newSize === 'number' && plan.newSize > 0) {
        await this.addLog(`[REVERSAL] AI veto REDUCE: ${proposedNewSize} → ${plan.newSize} (${plan.rationale || 'no rationale'})`);
        return plan.newSize;
      }
      return proposedNewSize;
    } catch (err) {
      await this.addLog(`[REVERSAL] _requestVeto error: ${err.message} — falling back to proposed size`);
      return proposedNewSize;
    }
  }

  async _handlePlanResponse(plan, reason) {
    this.bullLevel = plan.bullLevel;
    this.bearLevel = plan.bearLevel;
    if (typeof plan.newInitialSize === 'number' && plan.newInitialSize > 0) {
      this.currentInitialSize = plan.newInitialSize;
    }
    this.activePlan = {
      decision: plan.decision,
      bullLevel: plan.bullLevel,
      bearLevel: plan.bearLevel,
      newInitialSize: plan.newInitialSize ?? null,
      rationale: plan.rationale,
      confidence: plan.confidence,
      reason,
      timestamp: Date.now(),
    };
    this.planHistory.push({ ...this.activePlan, accumulatedLoss: this.cycleAccumulatedLoss, reversalCount: this.reversalCount });
    if (this.planHistory.length > 50) this.planHistory = this.planHistory.slice(-50);

    this.subState = 'WAITING';
    this.executionState = 'IDLE';
    await this.addLog(`[REVERSAL] PLAN accepted: bull=${plan.bullLevel} bear=${plan.bearLevel} size=${this.currentInitialSize} (${plan.rationale || 'no rationale'})`);
    this._recomputeFinalTpPrice();
    await this._saveState();
  }

  async _handleHeartbeatResponse(plan) {
    this.lastDecision = { decision: plan.decision, rationale: plan.rationale, timestamp: Date.now() };
    if (plan.decision === 'CONTINUE') {
      await this.addLog(`[REVERSAL] heartbeat: CONTINUE — ${plan.rationale || 'levels intact'}`);
      return;
    }
    if (plan.decision === 'ADJUST') {
      const oldBull = this.bullLevel;
      const oldBear = this.bearLevel;
      this.bullLevel = plan.bullLevel;
      this.bearLevel = plan.bearLevel;
      await this.addLog(`[REVERSAL] heartbeat: ADJUST — bull ${oldBull} → ${plan.bullLevel}, bear ${oldBear} → ${plan.bearLevel} (${plan.rationale || 'no rationale'})`);
      await this._saveState();
      return;
    }
    if (plan.decision === 'HARVEST') {
      await this.addLog(`[REVERSAL] heartbeat: HARVEST — ${plan.rationale || 'AI harvest'}`);
      await this._executeHarvest(plan.rationale);
    }
  }

  // ——— Position actions ——————————————————————————————————————————————

  async _openInitialPosition(side, levelPrice) {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    try {
      const sizeUSDT = this.currentInitialSize;
      const verb = side === 'LONG' ? 'OPEN_LONG_AT_LEVEL' : 'OPEN_SHORT_AT_LEVEL';
      const quantity = await this._calculateAdjustedQuantity(this.symbol, sizeUSDT, levelPrice, verb);
      await this.executor.executeAction({
        type: verb,
        quantity,
        triggerPrice: levelPrice,
        sizeUSDT,
      });
      this.subState = side === 'LONG' ? 'LONG_HELD' : 'SHORT_HELD';
      await this.addLog(`[REVERSAL] initial ${side} opened at level ${levelPrice} (size ${sizeUSDT} USDT)`);
    } catch (err) {
      await this.addLog(`[REVERSAL] _openInitialPosition error: ${err.message}`);
    } finally {
      this.executionState = 'IDLE';
      await this._saveState();
    }
  }

  async _performReversal(newSide) {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    try {
      // Compute new size (formula + margin projection + AI veto).
      const proposed = this._computeFormulaSize();
      const projected = this._applyMarginHeadroomCap(proposed);
      const finalSize = await this._requestVeto(projected);
      const verb = newSide === 'LONG' ? 'REVERSE_TO_LONG' : 'REVERSE_TO_SHORT';
      const targetLevel = newSide === 'LONG' ? this.bullLevel : this.bearLevel;
      const newQty = await this._calculateAdjustedQuantity(this.symbol, finalSize, targetLevel || this.currentPrice, verb);

      await this.executor.executeAction({
        type: verb,
        newQuantity: newQty,
        sizeUSDT: finalSize,
      });

      this.reversalCount += 1;
      this.subState = newSide === 'LONG' ? 'LONG_HELD' : 'SHORT_HELD';
      await this.addLog(`[REVERSAL] reversal #${this.reversalCount} → ${newSide} (size ${finalSize} USDT, accLoss ${this.cycleAccumulatedLoss})`);
    } catch (err) {
      await this.addLog(`[REVERSAL] _performReversal error: ${err.message}`);
    } finally {
      this.executionState = 'IDLE';
      this._recomputeFinalTpPrice();
      await this._saveState();
    }
  }

  async _executeHarvest(reason) {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    try {
      this.subState = 'HARVESTING';
      await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason });
      this.harvestCount += 1;
      // Position fully closed; refresh from Binance to confirm.
      await this._refreshCurrentPosition();
      this.currentPosition = null;
      this.currentSide = null;
      this.subState = 'WAITING';
      await this._saveState();
      // Immediately request fresh PLAN.
      await this._requestPlan('post_harvest');
    } catch (err) {
      await this.addLog(`[REVERSAL] _executeHarvest error: ${err.message}`);
    } finally {
      this.executionState = 'IDLE';
    }
  }

  async _handleFinalTpHit() {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    try {
      await this.addLog(`[REVERSAL] Final TP hit at ${this.currentPrice} — closing cycle`);
      await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason: 'final_tp' });
      await this._refreshCurrentPosition();
      this.currentPosition = null;
      this.currentSide = null;
      this.subState = 'EXITED';
      this.executionState = 'TERMINATED';
      this.isRunning = false;
      this._stopHeartbeat();
      await this._saveState();
      try {
        await sendStrategyCompletionNotification({
          userId: this.userId,
          strategyId: this.strategyId,
          strategyType: 'AI Reversal',
          symbol: this.symbol,
          totalPnL: -this.cycleAccumulatedLoss + this.desiredProfitUSDT,
          duration: formatDuration(Date.now() - (this.cycleStartTime || Date.now())),
        });
      } catch (notifyErr) {
        await this.addLog(`[REVERSAL] notify error: ${notifyErr.message}`);
      }
    } catch (err) {
      await this.addLog(`[REVERSAL] _handleFinalTpHit error: ${err.message}`);
    } finally {
      if (this.executionState !== 'TERMINATED') this.executionState = 'IDLE';
    }
  }

  // ——— Dynamic sizing ————————————————————————————————————————————————

  /**
   * Apply the user's formula:
   *   Recovery size   = accumulated_loss × recovery_factor
   *   Additional size = Recovery size / recovery_distance
   *   New size        = Initial size + Additional size
   */
  _computeFormulaSize() {
    const loss = Math.max(0, this.cycleAccumulatedLoss || 0);
    const recoverySize = loss * this.recoveryFactor;
    const additional = this.recoveryDistance > 0 ? recoverySize / this.recoveryDistance : 0;
    const newSize = (this.currentInitialSize || 0) + additional;
    return Math.max(newSize, this.currentInitialSize || 0);
  }

  /**
   * Margin-headroom projection — simulate 2 more reversals at current
   * trajectory; if projected freeMargin% < MARGIN_HEADROOM_FLOOR_PCT, cap
   * the proposed new size back to currentInitialSize.
   */
  _applyMarginHeadroomCap(proposedSize) {
    const wallet = this.lastWalletSnapshot?.totalMarginBalance || this.initialCapital || 0;
    if (wallet <= 0) return proposedSize;
    const proposedNotional = proposedSize;
    const usedMargin = (this.currentPosition?.notional || 0) / Math.max(1, this.leverage);
    const proposedMarginUse = proposedNotional / Math.max(1, this.leverage);
    // Pessimistic: assume two more reversals at same proposed size.
    const projectedUsed = usedMargin + proposedMarginUse * 2;
    const projectedFreePct = ((wallet - projectedUsed) / wallet) * 100;
    if (projectedFreePct < MARGIN_HEADROOM_FLOOR_PCT) {
      const floor = this.currentInitialSize || 0;
      void this.addLog(`[REVERSAL] margin-headroom cap: proposed=${proposedSize} projectedFree=${projectedFreePct.toFixed(2)}% < ${MARGIN_HEADROOM_FLOOR_PCT}% → capped to ${floor}`);
      return floor;
    }
    return proposedSize;
  }

  // ——— Final TP ——————————————————————————————————————————————————————

  /**
   * Final TP price — solves for price where unrealized PnL on the current
   * position covers accumulated_loss + desired_profit.
   *
   *   LONG:  qty × (price - entryAvg) ≥ accLoss + desiredProfit
   *          price ≥ entryAvg + (accLoss + desiredProfit) / qty
   *   SHORT: qty × (entryAvg - price) ≥ accLoss + desiredProfit
   *          price ≤ entryAvg - (accLoss + desiredProfit) / qty
   */
  _recomputeFinalTpPrice() {
    if (!this.currentPosition || !this.currentPosition.quantity || this.currentPosition.quantity <= 0) {
      this.finalTpPrice = null;
      return;
    }
    const qty = this.currentPosition.quantity;
    const entry = this.currentPosition.entryPrice || this.currentPosition.avgEntry;
    const needed = (this.cycleAccumulatedLoss || 0) + (this.desiredProfitUSDT || 0);
    if (!entry || qty <= 0) {
      this.finalTpPrice = null;
      return;
    }
    if (this.currentSide === 'LONG') {
      this.finalTpPrice = entry + needed / qty;
    } else if (this.currentSide === 'SHORT') {
      this.finalTpPrice = entry - needed / qty;
    } else {
      this.finalTpPrice = null;
    }
  }

  _checkFinalTpHit(price) {
    if (!this.finalTpPrice) return false;
    if (this.currentSide === 'LONG') return price >= this.finalTpPrice;
    if (this.currentSide === 'SHORT') return price <= this.finalTpPrice;
    return false;
  }

  // ——— Harvest eligibility gate ——————————————————————————————————————

  _isHarvestEligible() {
    if (!this.currentPosition || !this.currentPosition.quantity) return false;
    const unrealized = this.currentPosition.unrealizedPnl || 0;
    if (unrealized <= 0) return false;
    if (this.initialCapital <= 0) return false;
    return this.cycleAccumulatedLoss >= this.harvestLossThreshold * this.initialCapital;
  }

  // ——— Trade fill reconciliation ——————————————————————————————————————

  /**
   * Hook called by TradingBase machinery when a trade fill is recorded.
   * Updates accumulated_loss based on realized PnL + fees, refreshes
   * currentPosition, recomputes Final TP.
   */
  async _onTradeRecorded(trade) {
    const realized = parseFloat(trade.realizedPnl || 0);
    const commission = parseFloat(trade.commission || 0);
    this.accumulatedRealizedPnL = (this.accumulatedRealizedPnL || 0) + realized;
    this.accumulatedTradingFees = (this.accumulatedTradingFees || 0) + commission;
    // accumulated_loss is a POSITIVE number when in net loss.
    this.cycleAccumulatedLoss = Math.max(0, -this.accumulatedRealizedPnL + this.accumulatedTradingFees + (this.accumulatedFundingFees || 0));
    await this._refreshCurrentPosition();
    this._recomputeFinalTpPrice();
    await this._saveState();
    // Per-trade metrics sample (mirrors hedge pattern).
    try {
      await this._writeMetricsSample();
    } catch (err) {
      await this.addLog(`[REVERSAL] _writeMetricsSample error: ${err.message}`);
    }
  }

  async _writeMetricsSample() {
    if (!this.firestore || !this.strategyId) return;
    const sample = {
      t: Date.now(),
      accumulatedLoss: this.cycleAccumulatedLoss,
      currentSize: this.currentPosition?.notional || 0,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      side: this.currentSide || null,
    };
    await this.firestore.collection('strategies').doc(this.strategyId)
      .collection('metricsSamples').add(sample);
  }

  // ——— Funding fee polling ————————————————————————————————————————————

  async _pollFundingIncome() {
    try {
      const since = this._lastFundingPollTs || (Date.now() - 8 * 60 * 60 * 1000);
      const items = await this.makeProxyRequest('/fapi/v1/income', 'GET', {
        symbol: this.symbol,
        incomeType: 'FUNDING_FEE',
        startTime: since,
        limit: 100,
      }, true, 'futures').catch(() => []);
      if (Array.isArray(items)) {
        for (const it of items) {
          this.accumulatedFundingFees = (this.accumulatedFundingFees || 0) + parseFloat(it.income || 0);
        }
      }
      this._lastFundingPollTs = Date.now();
      this.cycleAccumulatedLoss = Math.max(0, -this.accumulatedRealizedPnL + this.accumulatedTradingFees + this.accumulatedFundingFees);
      this._recomputeFinalTpPrice();
    } catch (err) {
      await this.addLog(`[REVERSAL] funding poll error: ${err.message}`);
    }
  }

  // ——— Heartbeat scheduling ——————————————————————————————————————————

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._requestHeartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ——— Stale retry on AI failure ——————————————————————————————————————

  _scheduleStaleRetry(consultContext, reason) {
    this._staleRetryAttempt = Math.min((this._staleRetryAttempt || 0) + 1, 6);
    const delay = Math.min(STALE_RETRY_BASE_MS * Math.pow(2, this._staleRetryAttempt - 1), STALE_RETRY_MAX_MS);
    void this.addLog(`[REVERSAL] stale retry (${consultContext}) in ${Math.floor(delay / 1000)}s`);
    if (this._staleRetryTimer) clearTimeout(this._staleRetryTimer);
    this._staleRetryTimer = setTimeout(() => {
      if (consultContext === 'plan') this._requestPlan(reason).catch(() => {});
      else if (consultContext === 'heartbeat') this._requestHeartbeat().catch(() => {});
    }, delay);
  }

  // ——— Helpers ————————————————————————————————————————————————————————

  _buildStrategyState(overrides = {}) {
    return {
      strategyType: 'reversal',
      currentSide: this.currentSide,
      currentPosition: this.currentPosition,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      finalTpPrice: this.finalTpPrice,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      initialCapital: this.initialCapital,
      currentInitialSize: this.currentInitialSize,
      walletBalance: this.lastWalletSnapshot?.totalMarginBalance || 0,
      positionSizeUSDT: this.currentInitialSize,
      minNotional: this.minNotional || 5,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      previousPlan: this.activePlan,
      planHistory: this.planHistory.slice(-5),
      ...overrides,
    };
  }

  async _refreshCurrentPosition() {
    try {
      const positions = await this.detectCurrentPosition(true);
      // In one-way mode there's a single net position; find the one for our symbol.
      const pos = Array.isArray(positions)
        ? positions.find(p => p.symbol === this.symbol)
        : positions;
      if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
        const qty = Math.abs(parseFloat(pos.positionAmt));
        const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
        this.currentPosition = {
          quantity: qty,
          entryPrice: parseFloat(pos.entryPrice),
          avgEntry: parseFloat(pos.entryPrice),
          notional: qty * parseFloat(pos.entryPrice),
          unrealizedPnl: parseFloat(pos.unRealizedProfit || 0),
        };
        this.currentSide = side;
      } else {
        this.currentPosition = null;
        this.currentSide = null;
      }
    } catch (err) {
      await this.addLog(`[REVERSAL] _refreshCurrentPosition error: ${err.message}`);
    }
  }

  _accumulateAiUsage(plan) {
    if (!plan?._usage) return;
    this.aiTokenUsage.inputTokens += plan._usage.inputTokens || 0;
    this.aiTokenUsage.outputTokens += plan._usage.outputTokens || 0;
    this.aiTokenUsage.cacheRead += plan._usage.cacheRead || 0;
    this.aiTokenUsage.cacheCreation += plan._usage.cacheCreation || 0;
    this.aiTokenUsage.requests += 1;
  }

  /**
   * Compute end-of-strategy AI usage cost in USD.
   */
  getAiUsageCost() {
    const p = MODEL_PRICING[this.aiModel] || MODEL_PRICING['claude-sonnet-4-6'];
    const u = this.aiTokenUsage;
    const million = 1_000_000;
    return (
      (u.inputTokens * p.input
        + u.outputTokens * p.output
        + u.cacheRead * p.cacheRead
        + u.cacheCreation * p.cacheWrite5m) / million
    );
  }

  // ——— Status snapshot (consumed by /ai-reversal/status) ——————————————

  getStatus() {
    return {
      strategyId: this.strategyId,
      strategyType: 'reversal',
      symbol: this.symbol,
      isRunning: this.isRunning,
      executionState: this.executionState,
      subState: this.subState,
      currentSide: this.currentSide,
      currentPosition: this.currentPosition,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      finalTpPrice: this.finalTpPrice,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      initialCapital: this.initialCapital,
      currentInitialSize: this.currentInitialSize,
      desiredProfitUSDT: this.desiredProfitUSDT,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      activePlan: this.activePlan,
      lastDecision: this.lastDecision,
      aiTokenUsage: this.aiTokenUsage,
      aiUsageCostUSD: this.getAiUsageCost(),
      cycleStartTime: this.cycleStartTime,
      cycleDuration: this.cycleStartTime ? formatDuration(Date.now() - this.cycleStartTime) : null,
      currentPrice: this.currentPrice,
    };
  }

  // ——— Firestore persistence ——————————————————————————————————————————

  async _saveState() {
    if (!this.firestore || !this.strategyId) return;
    try {
      const doc = {
        strategyType: 'reversal',
        symbol: this.symbol,
        isRunning: this.isRunning,
        executionState: this.executionState,
        subState: this.subState,
        currentSide: this.currentSide,
        currentPosition: this.currentPosition,
        bullLevel: this.bullLevel,
        bearLevel: this.bearLevel,
        finalTpPrice: this.finalTpPrice,
        cycleAccumulatedLoss: this.cycleAccumulatedLoss,
        reversalCount: this.reversalCount,
        harvestCount: this.harvestCount,
        initialCapital: this.initialCapital,
        currentInitialSize: this.currentInitialSize,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
        accumulatedTradingFees: this.accumulatedTradingFees || 0,
        accumulatedFundingFees: this.accumulatedFundingFees || 0,
        activePlan: this.activePlan,
        planHistory: this.planHistory.slice(-50),
        cycleStartTime: this.cycleStartTime,
        leverage: this.leverage,
        maxPositionSizeUSDT: this.maxPositionSizeUSDT,
        aiModel: this.aiModel,
        aiTokenUsage: this.aiTokenUsage,
        config: {
          recoveryFactor: this.recoveryFactor,
          recoveryDistance: this.recoveryDistance,
          harvestLossThreshold: this.harvestLossThreshold,
          desiredProfitUSDT: this.desiredProfitUSDT,
          initialSize: this.currentInitialSize,
        },
        userId: this.userId,
        profileId: this.profileId,
        gcfProxyUrl: this.gcfProxyUrl,
        updatedAt: Date.now(),
      };
      await this.firestore.collection('strategies').doc(this.strategyId).set(doc, { merge: true });
    } catch (err) {
      await this.addLog(`[REVERSAL] _saveState error: ${err.message}`);
    }
  }
}

export { AiReversalStrategy };
export default AiReversalStrategy;
