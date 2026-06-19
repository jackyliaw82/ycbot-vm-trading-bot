import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import { AiPlanner } from './ai-planner.js';
import { AiPlanExecutor } from './ai-plan-executor.js';
import { AiRiskGuard, FEE_RATE } from './ai-risk-guard.js';
import { AiMarketContext } from './ai-market-context.js';
import wsBroadcast from './ws-broadcast.js';
import { FieldValue } from '@google-cloud/firestore';

// Per-model pricing in USD per million tokens.
const MODEL_PRICING = {
  // Anthropic — Claude.
  'claude-sonnet-4-6': { input: 3.0,   output: 15.0, cacheWrite5m: 3.75,   cacheRead: 0.30 },
  'claude-opus-4-7':   { input: 15.0,  output: 75.0, cacheWrite5m: 18.75,  cacheRead: 1.50 },
  // DeepSeek V4 — via Anthropic-compatible endpoint at api.deepseek.com/anthropic.
  // Per-1M-token USD rates from api-docs.deepseek.com (as of 2026-05-16).
  // v4-pro is currently on a 75% discount that expires 2026-05-31 15:59 UTC;
  // after expiry, multiply v4-pro rates by 4 to get post-discount values.
  // cache_control isn't honored by DeepSeek's Anthropic endpoint, so
  // cacheWrite5m mirrors `input` (cache miss = full price); cacheRead is
  // DeepSeek's automatic cache-hit rate when prefix-cached server-side.
  'deepseek-v4-flash': { input: 0.14,  output: 0.28, cacheWrite5m: 0.14,   cacheRead: 0.0028 },
  'deepseek-v4-pro':   { input: 0.435, output: 0.87, cacheWrite5m: 0.435,  cacheRead: 0.003625 },
};

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
 * AI consult contexts (all event-driven — none periodic; the 5-min heartbeat
 * was removed deliberately):
 *   - 'plan'         → emit fresh bullLevel/bearLevel (cycle start + post-harvest
 *                       only; bull/bear stay fixed for the rest of the cycle, no
 *                       periodic rethink).
 *   - 'harvest_price'→ while in position, when accLoss ≥ harvestLossThreshold ×
 *                       initial capital, set a harvestPrice on the profitable side
 *                       (harvest gate). harvestLossThreshold is a user config
 *                       setting (3–80%, default HARVEST_LOSS_THRESHOLD_PCT=0.30).
 *   - 'veto'         → before a reversal, CONTINUE / REDUCE size — ONLY when the
 *                       aiVetoOnReversal config flag is on (default OFF). With it
 *                       off, a reversal opens at the formula size with NO consult.
 *   - askAi()        → manual, user-triggered advisory (out of band).
 *
 * State machine:
 *   INITIAL → WAITING → (LONG_HELD | SHORT_HELD) → (reverse or HARVESTING → WAITING) → EXITED
 *
 * The HARVESTING branch is preserved for a future non-AI-driven harvest
 * implementation; the periodic AI heartbeat that previously drove it is gone.
 */
class AiReversalStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // Reversal-specific state
    this.strategyType = 'reversal';
    this.currentSide = null;                // 'LONG' | 'SHORT' | null
    this.activePosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
    this.bullLevel = null;
    this.bearLevel = null;
    this.finalTpPrice = null;
    this.cycleAccumulatedLoss = 0;
    this.reversalCount = 0;
    this.harvestCount = 0;
    // AI-set harvest target. When accLoss ≥ 30% × initialCapital and a
    // position is open, an AI consult sets this to a side-favorable price
    // (LONG: > entry; SHORT: < entry). On every price tick, if price
    // reaches this value, _executeHarvest fires. Cleared on every position
    // event (reversal, harvest, final TP). null = no active target.
    this.harvestPrice = null;
    // Guards against firing >1 in-flight harvest_price AI consult per tick.
    // Set true at consult start, cleared on success/failure/stale-retry.
    this._harvestConsultPending = false;
    this.initialCapital = 0;
    this.currentInitialSize = 0;
    this.cycleStartTime = null;
    this.executionState = 'IDLE';           // IDLE | PLANNING | EXECUTING | TERMINATED
    this.subState = 'INITIAL';              // INITIAL | WAITING | LONG_HELD | SHORT_HELD | HARVESTING | EXITED
    // How the cycle ended — set in stop() to 'final_tp' or 'manual' and persisted
    // on the strategy doc so the PnL / History completion-type classifier can read
    // it directly instead of inferring from the strategyFlow audit trail. null
    // while the strategy is running.
    this.stopReason = null;

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
    // lastDecision: previously set by the 5-min heartbeat (CONTINUE/ADJUST/
    // HARVEST). The heartbeat was removed — bull/bear are now picked once at
    // cycle start and stay fixed. Field is preserved (serialized + surfaced
    // in getStatus) for a future non-AI-driven harvest mechanism to populate.
    this.lastDecision = null;
    this.planHistory = [];

    // Cached volume primitives — refreshed at every AI consult and surfaced
    // via getStatus() so the frontend chart can overlay POC/VAH/VAL/HVN edges.
    this._lastVolumeProfile24h = null;
    this._lastVolumeProfile7d = null;
    this._lastCvd = null;
    this._lastOrderbookDepth = null;
    // ATR / volatility snapshot — feeds the Volume Analytics panel's ATR
    // cell. Populated by _cacheVolumeContext on every AI consult.
    this._lastVolatility = null;

    // Token usage accumulators
    this.aiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };

    // Stale retry on AI failure
    this._staleRetryAttempt = 0;
    this._staleRetryTimer = null;

    // Lifecycle infrastructure. Tracked
    // here so stop() can clear every interval/timeout deterministically
    // and start()/resume() can restart them. Leaving any unset means a
    // restart will leak the prior session's timer.
    this.listenKeyRefreshInterval = null;
    this._fundingPollTimeout = null;
    this._lastFundingPollTs = null;
  }

  // ——— Lifecycle ——————————————————————————————————————————————————————

  /**
   * Start the strategy. Forces one-way position mode, instantiates AI
   * modules, subscribes to WS streams, requests first PLAN.
   */
  async start(config = {}) {
    // strategyId is set by app.js before calling start() (non-blocking pattern).
    if (!this.strategyId) {
      this.strategyId = `ai_reversal_${this.profileId}_${Date.now()}`;
    }
    this.initFirestoreCollections(this.strategyId);

    this.symbol = config.symbol || 'BTCUSDT';
    this.leverage = config.leverage || DEFAULT_LEVERAGE;
    this.priceType = config.priceType || 'MARK';
    this.aiModel = config.aiModel || 'claude-sonnet-4-6';
    this.recoveryFactor = config.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = config.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = config.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = config.desiredProfitUSDT || 0;
    this.currentInitialSize = config.initialSize || 0;
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || (this.currentInitialSize * 10);
    // Advanced toggles — currently advisory (sizing math doesn't act on them
    // yet) but stored so the startup log reflects what the form sent.
    this.recoveryFactorDecay = !!config.recoveryFactorDecay;
    this.recoveryDistanceAutoWiden = !!config.recoveryDistanceAutoWiden;
    // AI size veto on reversal — when true, _performReversal calls
    // _requestVeto (CONTINUE / REDUCE) before opening the new opposite
    // leg. When false, skip the AI consult and use the formula's
    // projected size directly (faster reversals, deterministic sizing,
    // lower DeepSeek cost). Defaults false (matches frontend default).
    this.aiVetoOnReversal = !!config.aiVetoOnReversal;

    if (!this.symbol) throw new Error('AiReversalStrategy.start: missing symbol');
    if (!this.currentInitialSize || this.currentInitialSize <= 0) {
      throw new Error('AiReversalStrategy.start: invalid initialSize');
    }

    // AI key comes from GCP Secret Manager — not the config form. Branch on
    // the model-ID prefix: `deepseek-*` models go through the Anthropic
    // SDK pointed at DeepSeek's Anthropic-compatible endpoint; everything
    // else uses Anthropic's hosted Claude API.
    const isDeepseek = (this.aiModel || '').startsWith('deepseek-');
    const aiApiKey = isDeepseek
      ? await this._fetchDeepseekApiKey()
      : await this._fetchAnthropicApiKey();

    await this.addLog(`Starting AI Reversal Strategy for ${this.symbol}...`);
    // Surface EVERY config field — used to verify the form values made it
    // through to the VM untouched. Three groups separated by `|` for
    // readability: identity/sizing | recovery knobs | advanced toggles.
    await this.addLog(
      `Config: symbol=${this.symbol}, initialSize=${this.currentInitialSize} USDT, ` +
      `leverage=${this.leverage}x, maxPos=${this.maxPositionSizeUSDT} USDT, ` +
      `priceType=${this.priceType}, model=${this.aiModel} ` +
      `| recoveryFactor=${(this.recoveryFactor * 100).toFixed(0)}%, ` +
      `recoveryDistance=${(this.recoveryDistance * 100).toFixed(2)}%, ` +
      `harvestLossThreshold=${(this.harvestLossThreshold * 100).toFixed(0)}%, ` +
      `desiredProfitUSDT=${this.desiredProfitUSDT} ` +
      `| recoveryFactorDecay=${this.recoveryFactorDecay ? 'on' : 'off'}, ` +
      `recoveryDistanceAutoWiden=${this.recoveryDistanceAutoWiden ? 'on' : 'off'}, ` +
      `aiVetoOnReversal=${this.aiVetoOnReversal ? 'on' : 'off'}`
    );

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // ONE-WAY position mode — reversal is single-sided. Force it in case the
      // Binance account was left in dual-side (hedge) position mode.
      try {
        await this.setPositionMode(false);
        await this.addLog('Binance position mode set to ONE-WAY (single-sided).');
      } catch (err) {
        // If already in the target mode OR open positions block the switch,
        // Binance returns an error. Non-fatal — log and continue.
        await this.addLog(`setPositionMode(false) note: ${err.message}`);
      }
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`ERROR: [SETUP_ERROR] ${error.message}`);
      throw error;
    }

    const minNotional = this.exchangeInfoCache[this.symbol]?.minNotional || 5;
    this.minNotional = minNotional;
    if (this.currentInitialSize < minNotional) {
      const msg = `Initial size (${this.currentInitialSize} USDT) below minimum notional (${minNotional} USDT)`;
      await this.addLog(`ERROR: [VALIDATION_ERROR] ${msg}`);
      throw new Error(msg);
    }

    // Initial capital snapshot — drives the harvest gate and the sizing self-regulation loop.
    this.initialWalletBalance = await this.getWalletBalance();
    this.initialCapital = this.initialWalletBalance || this.currentInitialSize;
    await this.addLog(`Wallet balance: ${this._formatNotional(this.initialWalletBalance)} USDT — using as initialCapital.`);

    // AI modules.
    this.marketContext = new AiMarketContext(this);
    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      maxImbalanceRatio: 5.0,
      maxPriceDeviationPercent: 5.0,
      maxActionsPerHour: 20,
      minNotional,
      singleLegStopPercent: 5.0,
    });
    this.planner = new AiPlanner(aiApiKey, this.aiModel);
    this.executor = new AiPlanExecutor(this);

    this.isRunning = true;
    this.cycleStartTime = Date.now();
    this.strategyStartTime = new Date();
    this.subState = 'INITIAL';
    this.executionState = 'PLANNING';

    // WebSocket setup — listen key first, then user-data + realtime price.
    // No liquidation WS: reversal's AI consult / sizing math never reads
    // liquidation data. One less stream to keep alive.
    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    // Periodic listen key refresh — keeps user data stream alive.
    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Background refresh of volume primitives (VP24h/VP7d/CVD/orderbook/ATR).
    // Independent of AI consult cadence so the chart's POC/HVN/Final TP
    // overlays + Volume Analytics panel stay populated during long
    // position holds where no consult fires.
    this._scheduleVolumeRefresh();

    // Reconcile against Binance — pick up any pre-existing position (e.g., manual trade or VM restart).
    await this.detectCurrentPosition(true);
    await this._refreshCurrentPosition();

    // Funding poll baseline + scheduler. Anchor at strategy start so the
    // first poll only catches entries from THIS cycle.
    this._lastFundingPollTs = this.strategyStartTime.getTime();
    this._scheduleNextFundingPoll();

    await this.addLog(`AI Reversal Strategy started. Waiting for AI to set bull/bear levels...`);
    await this.saveState();

    // Single AI consult at cycle start. Bull/bear levels are set once here
    // and stay fixed for the entire cycle — there is no periodic 5-min
    // rethink. Cycle ends only at Final TP, user Stop, or system error.
    this._requestPlan('cycle_start').catch(err => {
      this.addLog(`[REVERSAL] initial plan request error: ${err.message}`).catch(() => {});
    });
  }

  /**
   * Resume a strategy from a Firestore snapshot. Called by app.js boot-scan
   * (recoverActiveStrategies) when a `type: 'AI_REVERSAL'` doc has
   * `isRunning: true` but no in-memory instance exists (i.e. PM2 restart
   * / VM force-update).
   *
   * Critical contract (see audit C3+C4+C5):
   *   - Restore identifiers FIRST so addLog can write under the right strategyId
   *   - Validate C4 proxy URLs before doing anything else
   *   - Fetch a FRESH Anthropic key (snapshot.anthropicApiKey is never stored)
   *   - Restore _lastFundingPollTs so the next funding poll uses correct baseline
   *   - Reissue listen-key request + refresh interval + WS health monitor
   *   - Schedule next funding poll
   *   - Reconcile current position from Binance (source of truth)
   */
  async resume(snapshot) {
    if (!snapshot) throw new Error('AiReversalStrategy.resume: missing snapshot');

    // Restore identifiers FIRST so addLog writes under the correct strategyId.
    this.strategyId = snapshot.strategyId;
    this.profileId = snapshot.profileId;
    this.userId = snapshot.userId;
    this.gcfProxyUrl = snapshot.gcfProxyUrl;
    this.sharedVmProxyGcfUrl = snapshot.sharedVmProxyGcfUrl;
    this.initFirestoreCollections(this.strategyId);

    // C4 proxy URL validation. Without these the strategy cannot reach
    // Binance OR the Anthropic key fetcher; abort cleanly and mark the
    // doc with a recoverable error.
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

    await this.addLog(`[RECOVERY] Resuming AI Reversal Strategy after restart...`);

    // Restore config
    this.symbol = snapshot.symbol;
    this.leverage = snapshot.leverage || DEFAULT_LEVERAGE;
    this.maxPositionSizeUSDT = snapshot.maxPositionSizeUSDT || 0;
    this.priceType = snapshot.priceType || 'MARK';
    this.aiModel = snapshot.aiModel || 'claude-sonnet-4-6';
    this.recoveryFactor = snapshot.config?.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = snapshot.config?.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = snapshot.config?.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = snapshot.config?.desiredProfitUSDT || 0;
    this.currentInitialSize = snapshot.currentInitialSize || snapshot.config?.initialSize || 0;
    // Restore advanced toggles too (advisory, but tracked for log parity).
    this.recoveryFactorDecay = !!snapshot.config?.recoveryFactorDecay;
    this.recoveryDistanceAutoWiden = !!snapshot.config?.recoveryDistanceAutoWiden;
    this.aiVetoOnReversal = !!snapshot.config?.aiVetoOnReversal;

    // Restore cycle state
    this.currentSide = snapshot.currentSide || null;
    this.activePosition = snapshot.currentPosition || null;
    this.bullLevel = snapshot.bullLevel || null;
    this.bearLevel = snapshot.bearLevel || null;
    this.finalTpPrice = snapshot.finalTpPrice || null;
    this.cycleAccumulatedLoss = snapshot.cycleAccumulatedLoss || 0;
    this.reversalCount = snapshot.reversalCount || 0;
    this.harvestCount = snapshot.harvestCount || 0;
    // Restore the in-flight harvest target if the VM died mid-cycle while
    // an AI-set harvestPrice was being watched. Only honored if a position
    // is also restored — otherwise it'll be cleared on the next position
    // event anyway.
    this.harvestPrice = typeof snapshot.harvestPrice === 'number' && Number.isFinite(snapshot.harvestPrice)
      ? snapshot.harvestPrice
      : null;
    this.initialCapital = snapshot.initialCapital || 0;
    this.initialWalletBalance = snapshot.initialWalletBalance || null;
    const sst = snapshot.cycleStartTime;
    this.cycleStartTime = typeof sst === 'number' ? sst : Date.now();
    this.strategyStartTime = new Date(this.cycleStartTime);
    this.subState = snapshot.subState || 'WAITING';
    this.executionState = 'IDLE';
    this.accumulatedRealizedPnL = snapshot.accumulatedRealizedPnL || 0;
    this.accumulatedTradingFees = snapshot.accumulatedTradingFees || 0;
    this.accumulatedFundingFees = snapshot.accumulatedFundingFees || 0;

    // Funding poll high-water mark. Fall back to strategyStartTime for
    // pre-v3.4.0 snapshots that didn't persist this field.
    this._lastFundingPollTs = snapshot._lastFundingPollTs || this.cycleStartTime;

    // L3-reconcile watermark — restore so the post-resume L3 sweep starts
    // FROM the latest fill already in the accumulators, not from cycle
    // start. Pre-v3.7.0 snapshots leave this null; the strategyStartTime
    // fallback inside _reconcileRecentTrades absorbs that one final
    // double-count, after which saveState persists the field going forward.
    this._lastReconciliationAt = snapshot._lastReconciliationAt || null;

    // AI continuity. planHistory + activePlan restored as-is. lastDecision
    // preserved on the off chance a future harvest mechanism has written to
    // it; the now-removed heartbeat was the only writer historically.
    this.aiTokenUsage = snapshot.aiTokenUsage || { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
    this.planHistory = Array.isArray(snapshot.planHistory) ? snapshot.planHistory : [];
    this.activePlan = snapshot.activePlan || null;
    this.lastDecision = snapshot.lastDecision || null;

    // FRESH AI key — never trust a snapshot value (the snapshot shape
    // doesn't actually store the key, but defensive anyway). Provider is
    // derived from the model-ID prefix restored from the snapshot.
    const isDeepseek = (this.aiModel || '').startsWith('deepseek-');
    const aiApiKey = isDeepseek
      ? await this._fetchDeepseekApiKey()
      : await this._fetchAnthropicApiKey();

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // One-way mode — reversal is single-sided. Wrap in try/catch
      // because Binance refuses the call if positions are open.
      try {
        await this.setPositionMode(false);
      } catch (err) {
        await this.addLog(`[RECOVERY] setPositionMode(false) note: ${err.message}`);
      }
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`[RECOVERY] ERROR setup: ${error.message}`);
      throw error;
    }

    const minNotional = this.exchangeInfoCache[this.symbol]?.minNotional || 5;
    this.minNotional = minNotional;

    this.marketContext = new AiMarketContext(this);
    this.riskGuard = new AiRiskGuard({
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      maxImbalanceRatio: 5.0,
      maxPriceDeviationPercent: 5.0,
      maxActionsPerHour: 20,
      minNotional,
      singleLegStopPercent: 5.0,
    });
    this.planner = new AiPlanner(aiApiKey, this.aiModel);
    this.executor = new AiPlanExecutor(this);

    this.isRunning = true;

    // WS lifecycle — listen-key request FIRST (avoids stale-key races),
    // then user-data stream, then realtime price feed, then refresh
    // interval + health monitor. No liquidation WS: reversal's AI consult
    // and sizing math never read liquidation data.
    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Background volume snapshot refresh. CRITICAL on resume: when a
    // position is already held, resume() does NOT fire a fresh PLAN
    // consult, so the volume primitives (VP/CVD/orderbook/ATR) would
    // otherwise stay null until the next reversal/harvest — leaving the
    // chart's POC/HVN/Final TP overlays + Volume Analytics panel blank.
    // Fire one immediate refresh in addition to the recurring schedule
    // so the user sees data within seconds, not 5 minutes.
    this._scheduleVolumeRefresh();
    this._refreshVolumeSnapshot().catch(() => {});

    // Preload _wsHandledOrderIds from Firestore trades subcollection BEFORE
    // L3 reconcile fires. The in-memory dedup map is empty on every restart;
    // without this preload, L3 sees every historical fill as "unhandled"
    // and re-adds commission/realizedPnL on top of the restored accumulators
    // (fee/realizedPnL doubling — observed regression of the v3.7.0 watermark
    // fix when WS T and userTrades.time drift apart). Awaited (not fire-and-
    // forget) so the map is populated before reconcile reads it.
    await this._preloadWsHandledOrderIdsFromFirestore();

    // L3 catch-up: sweep any fills Binance executed during VM downtime
    // BEFORE the next scheduled listenKey refresh (30 min) does it
    // automatically. Best-effort; swallow errors — the
    // automatic 30-min L3 will catch anything we miss here.
    this._reconcileRecentTrades().catch((err) => {
      console.error(`[REVERSAL] L3 reconcile on resume failed: ${err.message}`);
    });

    // Reconcile position from Binance (source of truth).
    await this.detectCurrentPosition(true);
    await this._refreshCurrentPosition();

    // Catch up on any funding settlements during downtime, then schedule
    // the next 8h-aligned poll. _pollFundingIncome calls saveState itself
    // so accumulators are persisted before we proceed.
    try {
      await this._pollFundingIncome();
    } catch (err) {
      console.error(`[RECOVERY] funding catch-up failed: ${err.message}`);
    }
    this._scheduleNextFundingPoll();

    // Recompute Final TP from restored accumulated_loss + current position
    // (Final TP is a derived value; never persisted).
    this._recomputeFinalTpPrice();

    await this.addLog(`[RECOVERY] subState=${this.subState} side=${this.currentSide || 'NONE'} reversals=${this.reversalCount} harvests=${this.harvestCount} accLoss=${this.cycleAccumulatedLoss.toFixed(4)} USDT`);

    await this.saveState();

    // Resume policy after heartbeat removal:
    //   - In-position: do nothing. Bull/bear are restored from snapshot
    //     and stay fixed — no AI re-consult needed (the periodic rethink
    //     was removed deliberately).
    //   - No position (WAITING / fresh restart pre-touch): fire one PLAN
    //     to re-derive bull/bear levels. Without this the strategy would
    //     idle forever if the saved snapshot didn't have levels (e.g.
    //     crash before the first plan landed).
    if (!this.activePosition) {
      this._requestPlan('resume_recovery').catch((err) => {
        this.addLog(`[RECOVERY] immediate plan failed: ${err.message}`).catch(() => {});
      });
    }
  }

  /**
   * Single termination path — used for BOTH manual stop and Final TP
   * auto-stop (v4.0.1 consolidation). "One method to rule them all":
   * position close (when
   * requested), final funding flush, WS cleanup, platform fee
   * deduction, AI usage log, completion notification, saveState, and
   * the onStopComplete hook that unregisters from app.js's
   * `activeStrategies` map.
   *
   * options.flatten — close any open position via HARVEST_CLOSE first.
   *                   Manual stops pass this when the user opts in;
   *                   Final TP passes true unconditionally.
   * options.reason  — 'manual' (default) | 'final_tp'. Threads through
   *                   to the executor's close-order log and (for
   *                   final_tp only) triggers the strategyFlow audit
   *                   record + metricsSample bookkeeping so the
   *                   frontend chart can mark the TP exit.
   *
   * Idempotent — calling twice (e.g. user clicks Stop just as Final TP
   * fires) early-exits on the second call.
   */
  async stop(options = {}) {
    const { flatten = false, reason = 'manual' } = options;

    // Concurrency + idempotency guard. stop() is reachable from
    // /ai-reversal/stop AND from _handleFinalTpHit; both could fire in
    // quick succession. The `!isRunning` check catches the concurrent
    // race (first call sets isRunning=false synchronously before any
    // await, so the second microtask-queued call bails). The
    // TERMINATED check catches a stop attempt AFTER a previous stop
    // already completed (the `if (!this.isRunning) return;` guard).
    if (!this.isRunning || this.executionState === 'TERMINATED') return;

    this.isRunning = false;

    // Cancel ALL background timers. Each was started in start()/resume()
    // and would leak across a restart if missed here.
    if (this._staleRetryTimer) {
      clearTimeout(this._staleRetryTimer);
      this._staleRetryTimer = null;
    }
    if (this._fundingPollTimeout) {
      clearTimeout(this._fundingPollTimeout);
      this._fundingPollTimeout = null;
    }
    if (this.listenKeyRefreshInterval) {
      clearInterval(this.listenKeyRefreshInterval);
      this.listenKeyRefreshInterval = null;
    }
    if (this._volumeRefreshInterval) {
      clearInterval(this._volumeRefreshInterval);
      this._volumeRefreshInterval = null;
    }

    const exitPrice = this.currentPrice;

    if (flatten) {
      // Source-of-truth refresh BEFORE the flatten check. activePosition can be
      // null in-memory while Binance still holds an open position (state lost
      // across a partial restart, missed WS update, etc.) — without this
      // refresh the close silently no-ops and the user is left with an open
      // position. stop() always closes.
      try {
        await this._refreshCurrentPosition();
      } catch (err) {
        await this.addLog(`[REVERSAL] stop: pre-flatten position refresh failed: ${err.message}`);
      }

      if (this.activePosition && this.activePosition.quantity > 0) {
        const closeReason = reason === 'final_tp' ? 'final_tp' : 'user-stop';
        try {
          await this.addLog(`[REVERSAL] stop: flattening ${this.currentSide} ${this.activePosition.quantity} (${closeReason})`);
          await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason: closeReason });
          // Verify the close actually flattened — if Binance still reports a
          // residual position, log a warning so it's surfaced in the log feed.
          await this._refreshCurrentPosition();
          if (this.activePosition && this.activePosition.quantity > 0) {
            await this.addLog(`[REVERSAL] WARNING: stop+flatten left residual ${this.currentSide} ${this.activePosition.quantity} on Binance — close it manually`);
          } else {
            await this.addLog('[REVERSAL] stop: position confirmed flat');
          }
        } catch (err) {
          await this.addLog(`[REVERSAL] stop: flatten failed: ${err.message}`);
        }
      } else {
        await this.addLog('[REVERSAL] stop: no open position on Binance — nothing to flatten');
      }

      // Final TP: write the strategyFlow audit record + metricsSample so
      // the frontend chart can mark the exit. Manual stops skip this to
      // avoid changing existing audit-log cadence.
      if (reason === 'final_tp') {
        try {
          await this._postExecuteBookkeeping('FINAL_TP_HIT', { exitPrice });
        } catch (bkErr) {
          console.error(`[REVERSAL] FINAL_TP_HIT bookkeeping failed: ${bkErr.message}`);
        }
      }
    }

    // Clear position-derived state. Done after the optional flatten so
    // `_refreshCurrentPosition` had real fields to work against.
    this.activePosition = null;
    this.currentSide = null;
    this.harvestPrice = null;

    // Final funding flush — capture any settlement that happened between
    // the last scheduled poll and stop. Non-critical: swallow errors.
    try {
      await this._pollFundingIncome();
    } catch (err) {
      console.error(`[REVERSAL] final funding poll failed: ${err.message}`);
    }

    // Release the user-data listen key + drop both WS streams.
    try {
      if (typeof this.cleanupWebSockets === 'function') this.cleanupWebSockets();
    } catch (err) {
      console.error(`[REVERSAL] cleanupWebSockets failed: ${err.message}`);
    }

    this.executionState = 'TERMINATED';
    this.subState = 'EXITED';
    this.strategyEndTime = new Date();
    // Record how the cycle ended ('final_tp' | 'manual'). Read by the PnL /
    // History completion-type classifier so a Final TP auto-exit is no longer
    // mislabeled as a Manual Stop.
    this.stopReason = reason;

    // Platform fee on net positive PnL.
    // Funding is included in net so the fee scales with what the bot
    // actually delivered to the user.
    const netPnL = (this.accumulatedRealizedPnL || 0)
      - (this.accumulatedTradingFees || 0)
      + (this.accumulatedFundingFees || 0);
    if (netPnL > 0) {
      try {
        await this.deductPlatformFee(netPnL);
      } catch (feeErr) {
        console.error(`[REVERSAL] platform fee error: ${feeErr.message}`);
      }
    }

    await this.saveState();

    // Platform-wide hero profit (public landing page): add this cycle's net
    // profit when positive. Idempotent (heroCounted flag) + best-effort — a
    // failure here must never break the stop/teardown sequence.
    await this._recordHeroProfit(netPnL);

    // AI usage summary — end-of-stop log.
    const u = this.aiTokenUsage;
    if (u && (u.requests || 0) > 0) {
      try {
        const totalCost = typeof this.getAiUsageCost === 'function' ? this.getAiUsageCost() : 0;
        await this.addLog(
          `AI Usage: ${u.requests} requests, ${(u.inputTokens || 0).toLocaleString()} input + ${(u.outputTokens || 0).toLocaleString()} output ` +
          `(cache write: ${(u.cacheCreation || 0).toLocaleString()}, read: ${(u.cacheRead || 0).toLocaleString()}). ` +
          `Est. cost (${this.aiModel}): $${totalCost.toFixed(4)}`
        );
      } catch (logErr) {
        console.error(`[REVERSAL] AI usage log failed: ${logErr.message}`);
      }
    }

    await this.addLog(reason === 'final_tp'
      ? '[REVERSAL] Final TP — cycle complete, strategy terminated.'
      : '[REVERSAL] stop: terminated');

    // Completion notification. Helper signature is
    // (userId, strategyData); the FCM token lookup relies on the
    // second argument being the data object.
    try {
      const elapsed = this.cycleStartTime
        ? formatDuration(Date.now() - this.cycleStartTime)
        : 'N/A';
      await sendStrategyCompletionNotification(this.userId, {
        strategyId: this.strategyId,
        symbol: this.symbol,
        netPnL,
        profitPercentage: this.initialCapital ? (netPnL / this.initialCapital) * 100 : 0,
        tradeCount: this.tradeCount || (this.reversalCount + this.harvestCount + (reason === 'final_tp' ? 1 : 0)),
        timeTaken: elapsed,
        realizedPnL: this.accumulatedRealizedPnL || 0,
        tradingFees: this.accumulatedTradingFees || 0,
        fundingFees: this.accumulatedFundingFees || 0,
      });
    } catch (notifyErr) {
      console.error(`[REVERSAL] notify error: ${notifyErr.message}`);
    }

    // CRITICAL: invokes the app.js callback that does
    // `activeStrategies.delete(strategyId)`. Without this, the next start
    // attempt for this profile is rejected with "already running".
    try { this.onStopComplete?.(); } catch (e) {
      console.error('[REVERSAL] onStopComplete hook failed:', e.message);
    }
  }

  /**
   * Add this cycle's NET profit (realized − fees + funding — the value computed
   * in stop()) to the platform-wide hero counter at platform_stats/heroProfit,
   * but only when positive. Read by backend-service GET /stats/hero-profit for
   * the public landing page.
   *
   * Idempotent: a transaction flips a `heroCounted` flag on this strategy's doc
   * AND bumps the counter atomically, so a retried / post-restart stop can never
   * double-count. Best-effort: any failure is logged and swallowed so it can
   * never break the stop/teardown sequence (worst case: this stop goes uncounted).
   */
  async _recordHeroProfit(netPnL) {
    if (!(netPnL > 0)) return;
    try {
      const strategyRef = this.firestore.collection('strategies').doc(this.strategyId);
      const heroRef = this.firestore.collection('platform_stats').doc('heroProfit');
      await this.firestore.runTransaction(async (tx) => {
        const snap = await tx.get(strategyRef);          // all reads before writes
        if (snap.get('heroCounted') === true) return;    // already counted — no-op
        tx.set(heroRef, {
          totalProfitUSDT: FieldValue.increment(netPnL),
          contributingStops: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.set(strategyRef, { heroCounted: true }, { merge: true });
      });
    } catch (err) {
      console.error(`[REVERSAL] hero-profit record failed: ${err.message}`);
    }
  }

  // ——— Price tick handling ——————————————————————————————————————————

  /**
   * Called from the realtime WS price stream. Dispatches level-touch logic.
   */
  async handleRealtimePrice(price) {
    if (!this.isRunning) return;
    if (!Number.isFinite(price) || price <= 0) return;
    this.currentPrice = price;

    // Per-tick price push for the chart's candle wick. Slim — currentPrice
    // + ISO timestamp only. The 10s strategy_update interval still carries
    // the full status payload (position, plans, levels) at its own cadence.
    try {
      wsBroadcast.pushPriceTick(this.strategyId, {
        currentPrice: price,
        timestamp: new Date().toISOString(),
      });
    } catch (_) { /* best-effort */ }

    // Keep the in-memory position's unrealized PnL fresh on every tick.
    // Cheap (multiplication + sign branch); needed so getStatus() and
    // Final TP gating see the latest unrealized value.
    if (this.activePosition) this._updateUnrealizedPnL(price);

    // Final TP check — highest priority. If hit, close to flat and terminate cycle.
    if (this.activePosition && this.finalTpPrice && this._checkFinalTpHit(price)) {
      await this._handleFinalTpHit();
      return;
    }

    // Harvest-price hit — second priority. If hit, close to flat and re-PLAN.
    // Direction-aware: LONG → price ≥ harvestPrice; SHORT → price ≤ harvestPrice.
    // Validation at consult time guarantees harvestPrice is on the profitable
    // side of entry, so any tick that hits it represents a profitable close.
    if (this.activePosition && this.harvestPrice != null && this._checkHarvestPriceHit(price)) {
      await this._executeHarvest('ai_harvest_price_hit');
      return;
    }

    // Harvest gate — fire an AI consult to SET a harvestPrice if all of:
    //   1. We're in a position (LONG_HELD or SHORT_HELD).
    //   2. Cycle accumulated loss ≥ 30% × initial capital.
    //   3. No harvestPrice currently set (idempotency — cleared on every
    //      position event so re-arm naturally happens after reversals).
    //   4. No consult currently in flight (prevents tick-rate AI spam).
    //   5. executionState is IDLE (don't fire during EXECUTING or PLANNING).
    if (this._isHarvestGateOpen()) {
      this._requestHarvestPrice().catch((err) => {
        this.addLog(`[REVERSAL] harvest_price consult error: ${err.message}`).catch(() => {});
      });
    }

    // Level-touch dispatch.
    //
    // Defense-in-depth (v4.4.5). The WAITING branch routes to
    // _openInitialPosition (OPEN at fixed initial size), the *_HELD
    // branches route to _performReversal (atomic close+open with recovery
    // sizing). If subState says WAITING but a position actually exists,
    // those two assumptions collide — the OPEN would silently net
    // against the existing position in Binance one-way mode. Detect that
    // desync HERE, before _openInitialPosition's own refusal kicks in,
    // so the log makes the source of the corruption obvious.
    const positionOpen = this.activePosition && this.activePosition.quantity > 0;
    if (this.subState === 'WAITING' && positionOpen) {
      if (!this._loggedWaitingDesync) {
        this._loggedWaitingDesync = true;
        this.addLog(`[REVERSAL] dispatch skipped: subState=WAITING but ${this.currentSide || '?'} position open (qty=${this.activePosition.quantity}). State desync — stop+flatten to recover.`).catch(() => {});
      }
      return;
    }
    // Clear the desync log latch once state is consistent again.
    if (this._loggedWaitingDesync) this._loggedWaitingDesync = false;

    // Only dispatch a new position action when nothing else is in flight.
    // During PLANNING (the async cycle-start / post-harvest consult) or
    // EXECUTING (a close/open mid-flight), a concurrent tick must NOT open or
    // reverse — that's the window the post-harvest stale-level open slipped
    // through (executionState was 'PLANNING', which the per-action guards
    // didn't block). Reversals are unaffected: a held position only ever ticks
    // with executionState IDLE (no plan runs mid-position).
    if (this.executionState !== 'IDLE') return;

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

  // Direction-aware check: hit if price has reached the AI-set harvestPrice
  // in the favorable direction. harvestPrice is validated at consult time
  // to be > entry for LONG (or < entry for SHORT), so a hit guarantees a
  // profitable close.
  _checkHarvestPriceHit(price) {
    if (!this.harvestPrice || !this.currentSide) return false;
    if (this.currentSide === 'LONG') return price >= this.harvestPrice;
    if (this.currentSide === 'SHORT') return price <= this.harvestPrice;
    return false;
  }

  // Gate for firing an AI consult to derive a fresh harvestPrice.
  // All conditions must hold:
  //   - Position is open (otherwise there's nothing to plan an exit from)
  //   - accLoss meets the threshold (default 30% × initialCapital)
  //   - No harvestPrice already in effect
  //   - No consult currently in flight
  //   - executionState is IDLE (not EXECUTING a trade / not PLANNING bull/bear)
  _isHarvestGateOpen() {
    if (this.executionState !== 'IDLE') return false;
    if (!this.activePosition || !this.activePosition.quantity) return false;
    // Position state must be SETTLED before we consult. After a reversal,
    // subState flips (LONG_HELD/SHORT_HELD) immediately, but currentSide +
    // activePosition.entryPrice are refreshed slightly later by
    // _refreshCurrentPosition. Firing the consult in that window feeds the AI
    // AND the risk-guard direction check the JUST-CLOSED leg's side/entry — so
    // the AI plans a harvest for the old side and the guard validates against
    // it, producing a harvestPrice on the wrong side of the NEW entry → an
    // immediate loss-making harvest. Wait until currentSide agrees with subState
    // (both are set together in _refreshCurrentPosition, so a match means the
    // entry is fresh too).
    if (this.subState === 'LONG_HELD' && this.currentSide !== 'LONG') return false;
    if (this.subState === 'SHORT_HELD' && this.currentSide !== 'SHORT') return false;
    if (this.harvestPrice != null) return false;
    if (this._harvestConsultPending) return false;
    if (this.initialCapital <= 0) return false;
    const threshold = this.harvestLossThreshold * this.initialCapital;
    return this.cycleAccumulatedLoss >= threshold;
  }

  // ——— Plan / Harvest-Price / Veto consults ——————————————————————————

  async _requestPlan(reason) {
    if (this.executionState === 'TERMINATED') return;
    // Defense-in-depth (v4.4.5). _handlePlanResponse unconditionally resets
    // subState to WAITING — safe ONLY between cycles (cycle_start before
    // first open, post_harvest after close to flat, resume_recovery when
    // !activePosition). Firing it mid-position desyncs the dispatcher in
    // handleRealtimePrice: it sees subState=WAITING + existing position
    // and routes the next level touch to _openInitialPosition (OPEN at
    // fixed initial size) instead of _performReversal (REVERSE with
    // recovery sizing). Binance one-way mode then nets the OPEN against
    // the existing position, leaving residue and corrupting Final TP.
    // The /ai-reversal/replan endpoint that triggered this was removed in
    // v4.4.5, but guard here defends against any future caller (refactor,
    // stale-retry of a pre-4.4.5 manual_replan reason, etc.).
    const inFlight = this.subState === 'LONG_HELD'
      || this.subState === 'SHORT_HELD'
      || this.subState === 'HARVESTING';
    const allowedInFlightReasons = new Set(['post_harvest']);
    if (inFlight && !allowedInFlightReasons.has(reason)) {
      await this.addLog(`[REVERSAL] _requestPlan(${reason}) refused: subState=${this.subState} (mid-position). Use Adjust or Ask AI to change levels.`);
      return;
    }
    this.executionState = 'PLANNING';
    await this.addLog(`[REVERSAL] _requestPlan(${reason})`);
    try {
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({ consultContext: 'plan' }));
      this._cacheVolumeContext(ctx);
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

  /**
   * Consult AI for a fresh harvestPrice. Gate ALREADY checked by
   * _isHarvestGateOpen — caller (handleRealtimePrice) only invokes this
   * when position is open, accLoss ≥ threshold, no harvestPrice set, no
   * consult in flight, and executionState is IDLE.
   *
   * In-flight guard (`_harvestConsultPending`) prevents tick-rate spam:
   * set true at entry, cleared in finally (success OR failure).
   *
   * On validation failure, schedules a stale retry with exponential backoff
   * (same pattern as _requestPlan). During the retry window the pending
   * flag stays cleared so subsequent ticks don't fire — the retry timer
   * is the sole driver. We DO NOT keep the pending flag set, because if
   * the bot crashes mid-retry the flag would never clear; the stale retry
   * timer is the right place for backoff state.
   */
  async _requestHarvestPrice() {
    if (this._harvestConsultPending) return;
    this._harvestConsultPending = true;
    await this.addLog('[REVERSAL] _requestHarvestPrice');
    try {
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({
        consultContext: 'harvest_price',
      }));
      this._cacheVolumeContext(ctx);
      const plan = await this.planner.generatePlan(ctx, 'reversal');
      this._accumulateAiUsage(plan);
      const validation = this.riskGuard.validatePlan(plan, ctx);
      if (!validation.valid) {
        await this.addLog(`[REVERSAL] HARVEST_PRICE validation failed: ${validation.reasons.join('; ')}`);
        this._scheduleStaleRetry('harvest_price', 'gate_open');
        return;
      }
      await this._handleHarvestPriceResponse(plan);
      this._staleRetryAttempt = 0;
    } catch (err) {
      await this.addLog(`[REVERSAL] _requestHarvestPrice error: ${err.message}`);
      this._scheduleStaleRetry('harvest_price', 'gate_open');
    } finally {
      this._harvestConsultPending = false;
    }
  }

  async _handleHarvestPriceResponse(plan) {
    this.harvestPrice = plan.harvestPrice;
    this.lastDecision = {
      decision: 'HARVEST_PRICE',
      rationale: plan.rationale,
      timestamp: Date.now(),
    };
    await this.addLog(
      `[REVERSAL] HARVEST_PRICE set: ${this.currentSide} entry=${this.activePosition?.entryPrice} ` +
      `harvestPrice=${plan.harvestPrice} accLoss=${this.cycleAccumulatedLoss.toFixed(4)} ` +
      `(${plan.rationale || 'no rationale'})`
    );
    await this.saveState();
    // Persist for audit trail — surfaced in /ai-reversal/plan-history.
    this._savePlanToFirestore(plan, 'harvest_price').catch(() => {});
  }

  async _requestVeto(proposedNewSize) {
    try {
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({
        consultContext: 'veto',
        vetoMode: true,
        proposedNewSize,
      }));
      this._cacheVolumeContext(ctx);
      const plan = await this.planner.generatePlan(ctx, 'reversal');
      this._accumulateAiUsage(plan);
      const validation = this.riskGuard.validatePlan(plan, ctx);
      if (!validation.valid) {
        await this.addLog(`[REVERSAL] VETO validation failed: ${validation.reasons.join('; ')} — falling back to proposed size`);
        return proposedNewSize;
      }
      // Persist the veto plan for audit trail (consumed by plan-history).
      this._savePlanToFirestore(plan, 'veto').catch(() => {});
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

  /**
   * Manual user-driven level adjustment. Mutates bullLevel/bearLevel,
   * recomputes Final TP, saves state, logs. Does NOT consult AI.
   *
   * Returns a structured result so the HTTP layer can surface what
   * actually changed and any safety warnings (e.g. the new level is on
   * the wrong side of current price and will fire on the next tick).
   *
   * No state-machine transitions — subState/executionState stay as-is.
   * That's intentional: the user may adjust while flat OR in-position,
   * and any consequent reversal/open is driven by handleRealtimePrice
   * on the next tick using the new levels.
   */
  async adjustLevels({ bullLevel, bearLevel, source = 'manual' } = {}) {
    if (!this.isRunning) {
      throw new Error('Cannot adjust levels: strategy is not running');
    }
    const before = { bullLevel: this.bullLevel, bearLevel: this.bearLevel };
    const changes = {};
    const warnings = [];

    if (bullLevel != null) {
      if (typeof bullLevel !== 'number' || !Number.isFinite(bullLevel) || bullLevel <= 0) {
        throw new Error(`Invalid bullLevel: ${bullLevel}`);
      }
      this.bullLevel = bullLevel;
      changes.bullLevel = { from: before.bullLevel, to: bullLevel };
    }
    if (bearLevel != null) {
      if (typeof bearLevel !== 'number' || !Number.isFinite(bearLevel) || bearLevel <= 0) {
        throw new Error(`Invalid bearLevel: ${bearLevel}`);
      }
      this.bearLevel = bearLevel;
      changes.bearLevel = { from: before.bearLevel, to: bearLevel };
    }

    // Tick-level safety surface: report any new level that's already on
    // the trigger side of current price. The HTTP layer pre-checks this
    // and asks the user for confirmation, but echo back the same warnings
    // so the log + audit trail capture what actually fired.
    // Only warn about a leg the user actually CHANGED — an unchanged level
    // already on the trigger side is a pre-existing condition, not introduced
    // by this adjust, and must not block editing the other leg. Mirrors the
    // HTTP pre-check gate in app.js (/ai-reversal/adjust-levels).
    const px = this.currentPrice;
    if (Number.isFinite(px) && px > 0) {
      if (this.subState === 'WAITING') {
        if (changes.bullLevel && this.bullLevel != null && px >= this.bullLevel) warnings.push(`bullLevel ${this.bullLevel} ≤ current ${px} — will OPEN LONG on next tick`);
        if (changes.bearLevel && this.bearLevel != null && px <= this.bearLevel) warnings.push(`bearLevel ${this.bearLevel} ≥ current ${px} — will OPEN SHORT on next tick`);
      } else if (this.subState === 'LONG_HELD') {
        if (changes.bearLevel && this.bearLevel != null && px <= this.bearLevel) warnings.push(`bearLevel ${this.bearLevel} ≥ current ${px} — will REVERSE LONG→SHORT on next tick`);
      } else if (this.subState === 'SHORT_HELD') {
        if (changes.bullLevel && this.bullLevel != null && px >= this.bullLevel) warnings.push(`bullLevel ${this.bullLevel} ≥ current ${px} — will REVERSE SHORT→LONG on next tick`);
      }
    }

    this._recomputeFinalTpPrice();
    await this.saveState();

    const changeParts = [];
    if (changes.bullLevel) changeParts.push(`bull ${changes.bullLevel.from} → ${changes.bullLevel.to}`);
    if (changes.bearLevel) changeParts.push(`bear ${changes.bearLevel.from} → ${changes.bearLevel.to}`);
    if (changeParts.length > 0) {
      await this.addLog(`[REVERSAL] manual level adjust (${source}): ${changeParts.join(', ')}` + (warnings.length ? ` — WARNINGS: ${warnings.join('; ')}` : ''));
    }

    // Append a synthetic entry to the aiPlans subcollection so the
    // position chart's bull/bear/Final-TP history-segment trail picks
    // up the manual change on its next re-seed (~60s while running, or
    // immediately on page reload). Without this, the chart re-seeds
    // from aiPlans on refresh and reverts to the most recent AI-set
    // values. Only emits the legs that actually changed, so we don't
    // create duplicate points on the unchanged side. Fire-and-forget —
    // a write failure shouldn't break the adjust response.
    if (changeParts.length > 0) {
      this._savePlanToFirestore(
        {
          decision: 'MANUAL_ADJUST',
          bullLevel: changes.bullLevel ? changes.bullLevel.to : null,
          bearLevel: changes.bearLevel ? changes.bearLevel.to : null,
          rationale: `Manual user adjustment (${source}): ${changeParts.join(', ')}${warnings.length ? ` — accepted with warnings: ${warnings.join('; ')}` : ''}`,
        },
        'manual_adjust',
      ).catch(() => {});
    }

    return {
      changes,
      warnings,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      currentPrice: this.currentPrice,
      subState: this.subState,
      finalTpPrice: this.finalTpPrice,
    };
  }

  /**
   * Manual, user-driven edit of the cycle's desired-profit target while the
   * strategy is running. Backend for the "Profit target" pencil in the
   * frontend's Levels & Targets card.
   *
   * The frontend only knows the % (desiredProfitPercent); the bot stores the
   * absolute desiredProfitUSDT. We convert here against `initialCapital` — the
   * SAME cycle-start basis the frontend used to derive the initial USDT at
   * start (initialCapital ≈ the wallet snapshot taken in `start`). Anchoring to
   * initialCapital (not the live wallet, which drifts with unrealized PnL)
   * keeps "1.5%" meaning exactly what it meant at cycle start.
   *
   * desiredProfitUSDT feeds _recomputeFinalTpPrice() (Final TP = entry ±
   * (accLoss + desiredProfit + aiCost + fee)/qty), so the change re-derives the
   * Final TP immediately. No state-machine transition — like adjustLevels, the
   * cycle just continues with the new target. saveState persists it.
   */
  async adjustProfitTarget({ desiredProfitPercent } = {}) {
    if (!this.isRunning) {
      throw new Error('Cannot adjust profit target: strategy is not running');
    }
    const pct = Number(desiredProfitPercent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error(`Invalid desiredProfitPercent: ${desiredProfitPercent} (must be > 0 and ≤ 100)`);
    }
    if (!(this.initialCapital > 0)) {
      throw new Error('Cannot adjust profit target: initialCapital is not set');
    }

    const before = this.desiredProfitUSDT || 0;
    const newUSDT = this.initialCapital * (pct / 100);
    this.desiredProfitUSDT = newUSDT;
    this._recomputeFinalTpPrice();
    await this.saveState();

    await this.addLog(
      `[REVERSAL] manual profit-target adjust: ${pct}% → ${this._formatNotional(newUSDT)} USDT ` +
      `(was ${this._formatNotional(before)} USDT, initialCapital ${this._formatNotional(this.initialCapital)})`,
    );

    return {
      desiredProfitPercent: pct,
      desiredProfitUSDT: this.desiredProfitUSDT,
      initialCapital: this.initialCapital,
      finalTpPrice: this.finalTpPrice,
    };
  }

  /**
   * User-driven free-form AI consult. Does NOT mutate strategy state —
   * the AI's response (rationale + optional proposed levels) is returned
   * raw so the frontend can show it and optionally call adjustLevels()
   * if the user clicks Approve.
   *
   * Persisted to aiPlans subcollection with consultContext='user_question'
   * so the existing /ai-reversal/plan-history endpoint surfaces it in the
   * decision history modal.
   */
  async askAi(question) {
    if (!this.isRunning) {
      throw new Error('Cannot ask AI: strategy is not running');
    }
    if (typeof question !== 'string' || !question.trim()) {
      throw new Error('Question text required');
    }
    if (!this.planner || !this.marketContext) {
      throw new Error('AI modules not initialized');
    }
    await this.addLog(`[REVERSAL] _askAi: "${question.slice(0, 120)}${question.length > 120 ? '…' : ''}"`);
    try {
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({
        consultContext: 'user_question',
        userQuestion: question,
      }));
      this._cacheVolumeContext(ctx);
      const plan = await this.planner.generatePlan(ctx, 'reversal');
      this._accumulateAiUsage(plan);
      const validation = this.riskGuard.validatePlan(plan, ctx);
      if (!validation.valid) {
        await this.addLog(`[REVERSAL] _askAi validation soft-fail: ${validation.reasons.join('; ')} — returning raw response anyway (advisory)`);
      }
      // Persist for audit (visible in /ai-reversal/plan-history) and surface
      // the planId so the frontend can pass it back on /adjust-levels to mark
      // the proposal applied. We AWAIT here (unlike other consult contexts)
      // because the planId is part of the response contract.
      const planId = await this._savePlanToFirestore(plan, 'user_question', { userQuestion: question });
      // Save state so the recomputed Final TP from _accumulateAiUsage lands.
      await this.saveState();
      return {
        planId: planId || null,
        decision: plan.decision,
        rationale: plan.rationale,
        proposedBullLevel: plan.proposedBullLevel ?? null,
        proposedBearLevel: plan.proposedBearLevel ?? null,
        confidence: plan.confidence ?? null,
        currentBullLevel: this.bullLevel,
        currentBearLevel: this.bearLevel,
        currentPrice: this.currentPrice,
        subState: this.subState,
        validationReasons: validation.valid ? [] : validation.reasons,
      };
    } catch (err) {
      await this.addLog(`[REVERSAL] _askAi error: ${err.message}`);
      throw err;
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
    // Show the PROJECTED dynamic size the next open will actually use
    // (_computeFormulaSize from currentInitialSize + carried accLoss), not the
    // bare currentInitialSize — at cycle start accLoss=0 so this is the base
    // size, but post-harvest / resume it reflects the recovery-augmented size.
    // The real open still applies the margin-headroom cap (+ AI veto if on), so
    // this is an estimate, hence "size≈".
    await this.addLog(`[REVERSAL] PLAN accepted: bull=${plan.bullLevel} bear=${plan.bearLevel} size≈${this._computeFormulaSize().toFixed(2)} (accLoss ${this.cycleAccumulatedLoss.toFixed(2)}) (${plan.rationale || 'no rationale'})`);
    this._recomputeFinalTpPrice();
    await this.saveState();
    // Persist the plan to the aiPlans subcollection for audit trail
    // (consumed by /ai-reversal/plan-history).
    this._savePlanToFirestore(plan, 'plan').catch(() => {});
  }

  // ——— Position actions ——————————————————————————————————————————————

  async _openInitialPosition(side, levelPrice) {
    if (this.executionState === 'EXECUTING') return;
    // Defense-in-depth (v4.4.5). OPEN_*_AT_LEVEL assumes flat — it executes
    // a market BUY/SELL at currentInitialSize with no recovery sizing. If
    // an active position exists at call time, subState and reality are
    // already desynced (the dispatcher should have routed to
    // _performReversal). Binance one-way mode would net the OPEN against
    // the existing position, leaving residue. Refuse loudly instead — the
    // strategy idles, surfacing the desync in the log so the operator can
    // stop+flatten and restart.
    if (this.activePosition && this.activePosition.quantity > 0) {
      await this.addLog(`[REVERSAL] _openInitialPosition(${side}) refused: existing ${this.currentSide || '?'} position qty=${this.activePosition.quantity} (subState=${this.subState}). State desync — stop+flatten to recover.`);
      return;
    }
    this.executionState = 'EXECUTING';
    const verb = side === 'LONG' ? 'OPEN_LONG_AT_LEVEL' : 'OPEN_SHORT_AT_LEVEL';
    try {
      // Dynamic sizing — size the entry to recover the cycle's carried-over
      // accumulated loss, using the SAME pipeline as a reversal. At cycle start
      // accLoss=0, so _computeFormulaSize returns exactly currentInitialSize (no
      // behavior change); after a harvest the carried accLoss (reduced by the
      // banked profit) augments the size so the fresh entry recovers faster.
      // Margin-headroom cap, then the AI size veto — both mirroring
      // _performReversal: when aiVetoOnReversal is on the AI may REDUCE the
      // recovery size for this entry too. executionState is already 'EXECUTING'
      // here, so the dispatch guard blocks any concurrent open/reverse while the
      // veto consult is in flight.
      this.cycleAccumulatedLoss = this._computeAccLoss();
      const proposed = this._computeFormulaSize();
      const projected = this._applyMarginHeadroomCap(proposed);
      const sizeUSDT = this.aiVetoOnReversal ? await this._requestVeto(projected) : projected;
      const quantity = await this._calculateAdjustedQuantity(this.symbol, sizeUSDT, levelPrice, verb);
      await this.executor.executeAction({
        type: verb,
        quantity,
        triggerPrice: levelPrice,
        sizeUSDT,
      });
      this.subState = side === 'LONG' ? 'LONG_HELD' : 'SHORT_HELD';
      await this.addLog(`[REVERSAL] initial ${side} opened at level ${levelPrice} (size ${sizeUSDT} USDT, accLoss ${this.cycleAccumulatedLoss.toFixed(4)})`);
    } catch (err) {
      await this.addLog(`[REVERSAL] _openInitialPosition error: ${err.message}`);
    } finally {
      this.executionState = 'IDLE';
      await this._postExecuteBookkeeping(verb, { triggerPrice: levelPrice });
    }
  }

  async _performReversal(newSide) {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    const verb = newSide === 'LONG' ? 'REVERSE_TO_LONG' : 'REVERSE_TO_SHORT';
    const fromSide = this.currentSide;
    let finalSize = 0;
    try {
      const closeQty = this.activePosition?.quantity || 0;
      if (!closeQty || closeQty <= 0) {
        throw new Error(`no ${fromSide || '?'} position to reverse`);
      }

      // ===== Step 1: close current leg =====
      // "Rely on Binance, not projection": close
      // first, let the WS update populate accumulatedRealizedPnL +
      // accumulatedTradingFees with TRUE values, then size the new leg
      // from `cycleAccumulatedLoss` directly. FEE_RATE is reserved for
      // Final-TP effective-target math only (see _recomputeFinalTpPrice).
      const closeSide = fromSide === 'LONG' ? 'SELL' : 'BUY';
      await this.addLog(`[AI] ${verb} step 1/2: closing ${fromSide} ${closeQty} @ market`);
      const closeResult = await this.placeMarketOrder(this.symbol, closeSide, closeQty, 'BOTH', { reduceOnly: true });
      if (closeResult?.orderId) {
        this._scheduleRestFallback(closeResult.orderId, this.symbol, closeSide, 'BOTH');
      }

      // ===== Step 2: wait for WS to deliver the close fill =====
      // 2000ms covers Binance's typical <100ms WS propagation with
      // generous headroom for the REST fallback if WS misses. After
      // confirmation _handleOrderTradeUpdate has folded the close's
      // realized PnL + commission into the accumulators.
      let wsConfirmed = false;
      if (closeResult?.orderId) {
        wsConfirmed = await this._waitForOrderFillConfirmation(closeResult.orderId, 2000);
      }
      if (!wsConfirmed) {
        await this.addLog(`[REVERSAL] close fill not WS-confirmed within 2s — sizing may use stale accLoss; next reversal self-corrects`);
      }

      // Recompute accLoss from current (now-actual) accumulators. No
      // projection — Binance is the source of truth.
      this.cycleAccumulatedLoss = this._computeAccLoss();

      // ===== Step 3: size new leg from actual accLoss =====
      const proposed = this._computeFormulaSize();
      const projected = this._applyMarginHeadroomCap(proposed);
      if (this.aiVetoOnReversal) {
        finalSize = await this._requestVeto(projected);
      } else {
        finalSize = projected;
        await this.addLog(`[REVERSAL] AI size veto disabled — using projected size ${finalSize} USDT (accLoss ${this.cycleAccumulatedLoss.toFixed(4)})`);
      }

      // ===== Step 4: open new opposite leg =====
      const targetLevel = newSide === 'LONG' ? this.bullLevel : this.bearLevel;
      const newQty = await this._calculateAdjustedQuantity(this.symbol, finalSize, targetLevel || this.currentPrice, verb);
      if (!newQty || newQty <= 0) {
        throw new Error(`invalid new quantity ${newQty} for ${verb}`);
      }
      const openSide = newSide === 'LONG' ? 'BUY' : 'SELL';
      await this.addLog(`[AI] ${verb} step 2/2: opening ${newSide} ${newQty} @ market`);
      const openResult = await this.placeMarketOrder(this.symbol, openSide, newQty, 'BOTH');
      if (openResult?.orderId) {
        this._scheduleRestFallback(openResult.orderId, this.symbol, openSide, 'BOTH');
      }
      if (this.riskGuard) this.riskGuard.recordAction();

      this.reversalCount += 1;
      this.subState = newSide === 'LONG' ? 'LONG_HELD' : 'SHORT_HELD';
      // Clear the previous harvestPrice — it was direction- and entry-bound
      // to the OLD position. The new position will re-trigger the gate on
      // the next tick if accLoss is still ≥ threshold, and a fresh
      // harvestPrice will be consulted for the new side/entry.
      this.harvestPrice = null;
      await this.addLog(`[REVERSAL] reversal #${this.reversalCount} → ${newSide} (size ${finalSize} USDT, accLoss ${this.cycleAccumulatedLoss})`);
    } catch (err) {
      await this.addLog(`[REVERSAL] _performReversal error: ${err.message}`);
    } finally {
      this.executionState = 'IDLE';
      await this._postExecuteBookkeeping(verb, { sizeUSDT: finalSize });
    }
  }

  async _executeHarvest(reason) {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    // Clear the harvest target up-front — the close is about to fire and
    // we don't want a tick mid-close to re-trigger the gate based on a
    // stale price. Once subState transitions to WAITING (post-close), the
    // gate naturally stays closed because activePosition will be null.
    this.harvestPrice = null;
    try {
      this.subState = 'HARVESTING';
      await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason });
      this.harvestCount += 1;
      // Position fully closed; refresh from Binance to confirm.
      await this._refreshCurrentPosition();
      this.activePosition = null;
      this.currentSide = null;
      // Clear the prior cycle's levels BEFORE returning to WAITING. The
      // post-harvest PLAN below is async (~tens of seconds); without this, a
      // price tick during that window would see subState=WAITING + the STALE
      // bull/bear still set and open an initial position at the old level
      // (then the landing PLAN resets subState=WAITING over the open position →
      // "state desync → stop+flatten"). With levels null, the WAITING dispatch
      // stays inert until _handlePlanResponse installs fresh levels — matching
      // cycle-start, where levels also begin null.
      this.bullLevel = null;
      this.bearLevel = null;
      this.subState = 'WAITING';
      await this._postExecuteBookkeeping('HARVEST_CLOSE', { reason: reason || null });
      // Immediately request fresh PLAN.
      await this._requestPlan('post_harvest');
    } catch (err) {
      await this.addLog(`[REVERSAL] _executeHarvest error: ${err.message}`);
    } finally {
      this.executionState = 'IDLE';
    }
  }

  /**
   * Manual, user-driven harvest. Banks the current profitable leg ON DEMAND —
   * even when cycleAccumulatedLoss is BELOW the auto harvest-gate threshold
   * (the gate in _isHarvestGateOpen is deliberately NOT consulted here). This
   * is the backend for the Active Position card's "Harvest now" control.
   *
   * Reuses the full _executeHarvest machinery (close to flat at market via
   * reduceOnly → post-harvest PLAN → bookkeeping → cycle CONTINUES, does NOT
   * stop). Validation runs synchronously and the (long-running) close is
   * fired-and-forgotten so the HTTP caller gets an immediate eligibility
   * verdict; the close itself flips executionState to EXECUTING synchronously,
   * closing the race with a concurrent price tick.
   *
   * Refuses unless a position is open AND currently in profit. The UI gates
   * the button on the same condition, but this is the safety net against a
   * stale click. Throws on ineligibility (the route maps it to a 409).
   */
  async harvestNow() {
    if (!this.isRunning) {
      throw new Error('Strategy is not running.');
    }
    if (this.executionState !== 'IDLE') {
      throw new Error('Strategy is busy — a trade or plan is in progress. Try again in a moment.');
    }
    const heldSide = this.subState === 'LONG_HELD' ? 'LONG'
      : this.subState === 'SHORT_HELD' ? 'SHORT'
        : null;
    if (!heldSide || !this.activePosition || !(this.activePosition.quantity > 0)) {
      throw new Error('No open position to harvest.');
    }
    // Refresh unrealized PnL against the latest mark before judging profit —
    // the gate must reflect the price right now, not whatever the last tick left.
    this._updateUnrealizedPnL(this.currentPrice);
    const unrealized = this.activePosition.unrealizedPnl || 0;
    if (!(unrealized > 0)) {
      throw new Error(`Position is not in profit (unrealized ${unrealized.toFixed(4)} USDT). Harvest only banks a profitable leg.`);
    }

    // No awaits between the IDLE check above and the _executeHarvest handoff
    // below — addLog is fire-and-forget and _updateUnrealizedPnL is sync — so
    // no price tick can interleave and fire a reversal before _executeHarvest
    // flips executionState to EXECUTING.
    this.addLog(`[REVERSAL] manual harvest requested — banking ~${unrealized.toFixed(4)} USDT (${heldSide} @ ${this.currentPrice})`).catch(() => {});
    this._executeHarvest('manual_harvest').catch((err) => {
      this.addLog(`[REVERSAL] manual harvest error: ${err.message}`).catch(() => {});
    });

    return { harvesting: true, side: heldSide, unrealizedPnl: unrealized, price: this.currentPrice };
  }

  /**
   * Final TP detection handler — invoked from handleRealtimePrice when
   * price crosses finalTpPrice. v4.0.1: reduced to a thin re-entry guard
   * around stop({flatten:true, reason:'final_tp'}). The unified stop()
   * method does everything that used to live here (HARVEST_CLOSE, the
   * residual check, FINAL_TP_HIT bookkeeping, WS cleanup, notification,
   * saveState) PLUS the parity gaps that were missing before:
   *
   *   - Final funding flush
   *   - Platform fee deduction on net positive PnL
   *   - AI usage summary log
   *   - onStopComplete() hook → removes the entry from app.js's
   *     `activeStrategies` map. Without this hook the next start
   *     attempt for this profile is rejected with "already running"
   *     until the VM restarts. This was the user-reported bug.
   */
  async _handleFinalTpHit() {
    // Re-entry guard: two ticks could pass the `isRunning` check in
    // handleRealtimePrice before stop() flips isRunning to false. The
    // executionState lock prevents the second call from double-stopping.
    if (this.executionState === 'EXECUTING' || this.executionState === 'TERMINATED') return;
    this.executionState = 'EXECUTING';
    try {
      await this.addLog(`[REVERSAL] Final TP hit at ${this.currentPrice} — closing cycle`);
      await this.stop({ flatten: true, reason: 'final_tp' });
    } catch (err) {
      await this.addLog(`[REVERSAL] _handleFinalTpHit error: ${err.message}`);
      // If stop() never reached TERMINATED (e.g. threw very early), release
      // the lock so a future tick or a /ai-reversal/stop request can try
      // again. If stop() succeeded, executionState is already TERMINATED.
      if (this.executionState !== 'TERMINATED') this.executionState = 'IDLE';
    }
  }

  // ——— Dynamic sizing ————————————————————————————————————————————————

  /**
   * Apply the user's formula:
   *   Recovery size   = accumulated_loss × recovery_factor
   *   Additional size = Recovery size / recovery_distance
   *   New size        = Initial size + Additional size
   *
   * Reads `cycleAccumulatedLoss` from current accumulators (Binance-truth).
   * Caller (_performReversal) is responsible for refreshing accumulators
   * via WS confirmation before invoking — no forward projection.
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
    const usedMargin = (this.activePosition?.notional || 0) / Math.max(1, this.leverage);
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
   * position covers accumulated_loss + desired_profit + ai_consult_cost +
   * estimated_closing_fee.
   *
   *   needed = accLoss + desiredProfit + aiCost + estimatedClosingFee
   *   LONG:  qty × (price - entryAvg) ≥ needed
   *          price ≥ entryAvg + needed / qty
   *   SHORT: qty × (entryAvg - price) ≥ needed
   *          price ≤ entryAvg - needed / qty
   *
   * `estimatedClosingFee = notional × FEE_RATE`. FEE_RATE = 0.08%
   * = 0.05% taker + 0.03% slippage buffer; it ensures the realized exit
   * (after fee + slippage on the close) lands as close to desiredProfit
   * as possible rather than under-shooting by the close cost.
   *
   * AI cost is folded in so the cycle exits at TRUE breakeven-plus-profit
   * including the running DeepSeek/Anthropic consult cost. Recomputed after
   * every event AND after every AI consult (via _accumulateAiUsage) so the
   * target rises in lock-step with cost growth.
   */
  _recomputeFinalTpPrice() {
    if (!this.activePosition || !this.activePosition.quantity || this.activePosition.quantity <= 0) {
      this.finalTpPrice = null;
      return;
    }
    const qty = this.activePosition.quantity;
    const entry = this.activePosition.entryPrice || this.activePosition.avgEntry;
    const aiCost = typeof this.getAiUsageCost === 'function' ? (this.getAiUsageCost() || 0) : 0;
    const notional = this.activePosition.notional || (entry * qty) || 0;
    const estimatedClosingFee = notional * FEE_RATE;
    const needed = (this.cycleAccumulatedLoss || 0)
      + (this.desiredProfitUSDT || 0)
      + aiCost
      + estimatedClosingFee;
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
    if (!this.activePosition || !this.activePosition.quantity) return false;
    const unrealized = this.activePosition.unrealizedPnl || 0;
    if (unrealized <= 0) return false;
    if (this.initialCapital <= 0) return false;
    return this.cycleAccumulatedLoss >= this.harvestLossThreshold * this.initialCapital;
  }

  // ——— Trade fill reconciliation ——————————————————————————————————————

  /**
   * Post-execute bookkeeping hook. Called by each strategy action helper
   * (_openInitialPosition / _performReversal / _executeHarvest /
   * _handleFinalTpHit) AFTER `executor.executeAction()` resolves.
   *
   * IMPORTANT: TradingBase already updates `accumulatedTradingFees` and
   * `accumulatedRealizedPnL` automatically when ORDER_TRADE_UPDATE events
   * arrive on the user-data WS (and via the REST fallback when WS misses).
   * This hook just recomputes the DERIVED state that depends on those
   * accumulators — cycleAccumulatedLoss, currentPosition, finalTpPrice —
   * plus persists a metricsSample + strategyFlow audit-trail record.
   *
   * Brief settle delay (~250ms) allows the WS path to deliver before we
   * read the accumulators. Not strictly necessary — the saveState() at
   * the end captures whatever state is current — but produces a cleaner
   * first-trade audit record.
   */
  async _postExecuteBookkeeping(actionType, extra = {}) {
    try {
      await new Promise((r) => setTimeout(r, 250));
      // OPEN/REVERSE actions leave a fresh position on Binance; pass
      // expectNonEmpty so _refreshCurrentPosition retries against REST
      // lag (Binance's /fapi/v2/account routinely takes 100-500ms to
      // reflect a market-order fill). HARVEST/FINAL_TP close the
      // position — expect empty; no retry.
      const expectNonEmpty = actionType === 'OPEN_LONG_AT_LEVEL'
        || actionType === 'OPEN_SHORT_AT_LEVEL'
        || actionType === 'REVERSE_TO_LONG'
        || actionType === 'REVERSE_TO_SHORT';
      await this._refreshCurrentPosition(expectNonEmpty);
      this.cycleAccumulatedLoss = this._computeAccLoss();
      this._recomputeFinalTpPrice();
      // TEMP: record recomputed Final TP after open / reversal / harvest — remove after testing.
      // On HARVEST_CLOSE the position is flat, so finalTpPrice is null by design (no active
      // target); the meaningful fresh target appears on the subsequent OPEN_*_AT_LEVEL line.
      const TEMP_TP_LOG_ACTIONS = new Set([
        'OPEN_LONG_AT_LEVEL', 'OPEN_SHORT_AT_LEVEL',
        'REVERSE_TO_LONG', 'REVERSE_TO_SHORT',
        'HARVEST_CLOSE',
      ]);
      if (TEMP_TP_LOG_ACTIONS.has(actionType)) {
        await this.addLog(
          `[TEMP] Final TP recomputed after ${actionType}: ` +
          `finalTpPrice=${this.finalTpPrice ?? 'null'} ` +
          `(side=${this.currentSide ?? 'FLAT'}, ` +
          `entry=${this.activePosition?.entryPrice ?? this.activePosition?.avgEntry ?? 'n/a'}, ` +
          `qty=${this.activePosition?.quantity ?? 'n/a'}, ` +
          `reversals=${this.reversalCount}, harvests=${this.harvestCount}, ` +
          `accLoss=${this.cycleAccumulatedLoss.toFixed(4)})`
        );
      }
      await this.saveState();
      this._writeMetricsSample().catch(() => {});
      this._writeStrategyFlow(actionType, extra).catch(() => {});
      // Immediate heartbeat — currentPosition / currentSide / cycleAccumLoss /
      // reversalCount / harvestCount / accumulated*PnL just changed. Without
      // this push, frontend would see stale state for up to 30s (next safety-
      // net interval). _writeStrategyFlow above also fires its own flow_event
      // push with a slim per-event payload; this heartbeat carries the full
      // TRUE LIVE state snapshot so the frontend can re-sync without waiting.
      this._pushHeartbeatNow();
    } catch (err) {
      console.error(`[REVERSAL] _postExecuteBookkeeping error: ${err.message}`);
    }
  }

  /**
   * Compute the cycle's accumulated loss in USDT (always ≥ 0).
   *
   * Sign-consistent formulation — each component carries its own signed
   * wallet impact, and we just sum them. accLoss is the positive
   * magnitude of the drawdown when net is negative, 0 otherwise.
   *
   *   netSignedPnL = realized + fees + funding
   *
   *   where each component is the signed wallet delta:
   *     realized:  + profit              / − loss
   *     fees:      always negative       (every fill subtracts from wallet)
   *     funding:   + received            / − paid
   *
   *   accLoss      = max(0, −netSignedPnL)
   *
   * Note on storage: `this.accumulatedTradingFees` is kept by TradingBase
   * as a POSITIVE MAGNITUDE (cost size), so we negate it inside this
   * helper to convert to the signed convention above. This lets us keep
   * the broader codebase's existing storage shape while the formula
   * reads cleanly with all three terms in the same sign space.
   */
  _computeAccLoss() {
    const realized = (this.accumulatedRealizedPnL  || 0);                        // signed
    const fees     = -(this.accumulatedTradingFees || 0);                        // → signed (always negative)
    const funding  = (this.accumulatedFundingFees   || 0);                       // signed
    const netSignedPnL = realized + fees + funding;
    return netSignedPnL < 0 ? -netSignedPnL : 0;
  }

  /**
   * Audit-trail record per strategy action. Enables the frontend chart
   * to correlate fills with the originating verb (OPEN_LONG_AT_LEVEL vs
   * REVERSE_TO_SHORT vs HARVEST_CLOSE) by timestamp proximity.
   */
  async _writeStrategyFlow(actionType, extra = {}) {
    if (!this.firestore || !this.strategyId) return;
    try {
      const timestamp = new Date();
      await this.firestore.collection('strategies').doc(this.strategyId).collection('strategyFlow').add({
        actionType,
        side: this.currentSide || null,
        price: this.currentPrice || null,
        position: this.activePosition ? {
          quantity: this.activePosition.quantity,
          entryPrice: this.activePosition.entryPrice,
          notional: this.activePosition.notional,
        } : null,
        cycleAccumulatedLoss: this.cycleAccumulatedLoss,
        reversalCount: this.reversalCount,
        harvestCount: this.harvestCount,
        finalTpPrice: this.finalTpPrice,
        ...extra,
        timestamp,
      });

      // Real-time push for the chart's TP segment boundaries. Slim payload —
      // only the four fields ReversalPositionChart's buildTpFromFlow walker
      // reads. Future consumers needing position / cycleAccumulatedLoss /
      // etc. can extend this.
      try {
        wsBroadcast.pushFlowEvent(this.strategyId, {
          actionType,
          side: this.currentSide || null,
          finalTpPrice: this.finalTpPrice ?? null,
          timestamp: timestamp.toISOString(),
        });
      } catch (_) { /* push is best-effort; REST poll catches stragglers */ }
    } catch (err) {
      console.error(`[REVERSAL] _writeStrategyFlow failed: ${err.message}`);
    }
  }

  async _writeMetricsSample() {
    if (!this.firestore || !this.strategyId) return;
    const sample = {
      t: Date.now(),
      accumulatedLoss: this.cycleAccumulatedLoss,
      currentSize: this.activePosition?.notional || 0,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      side: this.currentSide || null,
    };
    await this.firestore.collection('strategies').doc(this.strategyId)
      .collection('metricsSamples').add(sample);
  }

  // ——— Funding fee polling ————————————————————————————————————————————

  /**
   * Poll Binance income endpoint for FUNDING_FEE entries since the last
   * recorded high-water mark. Idempotent: re-running with the same
   * `_lastFundingPollTs` is a no-op if no new entries.
   *
   * On success, advances `_lastFundingPollTs` to the maximum entry time
   * (NOT Date.now() — that would skip any future entries with
   * timestamps just before now).
   */
  async _pollFundingIncome() {
    if (!this.symbol || !this._lastFundingPollTs) return { added: 0, count: 0 };
    try {
      const startTime = this._lastFundingPollTs + 1;
      const incomes = await this.makeProxyRequest(
        '/fapi/v1/income',
        'GET',
        { symbol: this.symbol, incomeType: 'FUNDING_FEE', startTime, limit: 1000 },
        true,
        'futures',
      ) || [];

      if (!Array.isArray(incomes) || incomes.length === 0) return { added: 0, count: 0 };

      let added = 0;
      let maxTime = this._lastFundingPollTs;
      for (const entry of incomes) {
        const v = parseFloat(entry.income);
        if (Number.isFinite(v)) {
          added += v;
          this.accumulatedFundingFees = (this.accumulatedFundingFees || 0) + v;
          if (entry.time > maxTime) maxTime = entry.time;
        }
      }
      this._lastFundingPollTs = maxTime;

      // accumulatedFundingFees is stored SIGNED (− paid / + received) per
      // the parse loop above; _computeAccLoss treats it as a signed
      // wallet event identical in semantics to realized PnL. Funding
      // PAID now correctly INCREASES accLoss (the v4.1.1 formula
      // subtracted it, under-sizing recovery on every funding-heavy
      // cycle — see _computeAccLoss for the full rationale).
      this.cycleAccumulatedLoss = this._computeAccLoss();
      this._recomputeFinalTpPrice();

      await this.addLog(
        `Funding settled: ${added >= 0 ? '+' : ''}${added.toFixed(4)} USDT ` +
        `(cumulative ${this.accumulatedFundingFees >= 0 ? '+' : ''}${this.accumulatedFundingFees.toFixed(4)} USDT, ${incomes.length} entries)`
      );
      await this.saveState();
      // accumulatedFundingFees + cycleAccumulatedLoss just changed; push so
      // frontend sees the funding settlement at sub-second latency instead
      // of waiting up to 30s for the next safety-net heartbeat.
      this._pushHeartbeatNow();
      return { added, count: incomes.length };
    } catch (err) {
      console.error(`[REVERSAL] funding poll error: ${err.message}`);
      return { added: 0, count: 0, error: err.message };
    }
  }

  /**
   * Schedule the next funding-fee poll aligned to the next 8h UTC
   * settlement boundary + 60s safety buffer. Self-rescheduling.
   * Cancellable via clearTimeout(this._fundingPollTimeout).
   *
   * If the primary poll at +60s returns zero entries (Binance lagged on
   * ledgering the settlement), retries once at +5min then resumes the
   * normal 8h cadence regardless of the retry outcome.
   */
  _scheduleNextFundingPoll() {
    const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
    const SAFETY_BUFFER_MS = 60 * 1000;
    const RETRY_BUFFER_MS = 5 * 60 * 1000;

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

  // ——— Stale retry on AI failure ——————————————————————————————————————

  _scheduleStaleRetry(consultContext, reason) {
    this._staleRetryAttempt = Math.min((this._staleRetryAttempt || 0) + 1, 6);
    const delay = Math.min(STALE_RETRY_BASE_MS * Math.pow(2, this._staleRetryAttempt - 1), STALE_RETRY_MAX_MS);
    void this.addLog(`[REVERSAL] stale retry (${consultContext}) in ${Math.floor(delay / 1000)}s`);
    if (this._staleRetryTimer) clearTimeout(this._staleRetryTimer);
    this._staleRetryTimer = setTimeout(() => {
      if (consultContext === 'plan') this._requestPlan(reason).catch(() => {});
      else if (consultContext === 'harvest_price') {
        // Re-check the gate at retry time — between the original failure
        // and now, a reversal may have flipped the position (clearing
        // harvestPrice) or accLoss may have moved. The gate function
        // collapses all those checks into one call.
        if (this._isHarvestGateOpen()) {
          this._requestHarvestPrice().catch(() => {});
        }
      }
      // veto failures fall back to the proposed size inline (see _requestVeto)
      // and never reach this retry scheduler.
    }, delay);
  }

  // ——— Helpers ————————————————————————————————————————————————————————

  _buildStrategyState(overrides = {}) {
    return {
      strategyType: 'reversal',
      currentSide: this.currentSide,
      currentPosition: this.activePosition,
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

  /**
   * Reconcile the in-memory position snapshot against Binance via
   * TradingBase. CRITICAL: `detectCurrentPosition()` does NOT return
   * positions — it updates instance fields on the base class:
   *   this.currentPosition       — STRING 'LONG' | 'SHORT' | 'NONE'
   *   this.positionEntryPrice    — number
   *   this.currentPositionQuantity — number (abs value)
   *   this.positionSize          — number (abs notional)
   * We read those AFTER awaiting detectCurrentPosition and project them
   * into our local OBJECT `this.activePosition` (different field name to
   * avoid the collision with TradingBase's string write on every WS
   * ACCOUNT_UPDATE event).
   */
  /**
   * Reconcile in-memory position against Binance via TradingBase.
   *
   * `expectNonEmpty`: when true (caller knows a position should exist —
   * post-OPEN, post-REVERSE), retry the REST call up to 5× with 300ms
   * gaps if the first call returns empty. Binance's /fapi/v2/account
   * routinely lags a fresh market fill by 100-500ms, so without the
   * retry we'd persist activePosition=null right after the order
   * acknowledges, leaving the Firestore doc + frontend in a stale
   * "no position" state until the next tick or external trigger.
   */
  async _refreshCurrentPosition(expectNonEmpty = false) {
    try {
      await this.detectCurrentPosition(true);
      let side = this.currentPosition;
      let qty = this.currentPositionQuantity;
      let entryPrice = this.positionEntryPrice;

      const hasPosition = (side === 'LONG' || side === 'SHORT')
        && qty && qty > 0
        && Number.isFinite(entryPrice) && entryPrice > 0;

      if (expectNonEmpty && !hasPosition) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          console.log(`[REVERSAL] _refreshCurrentPosition: REST returned empty post-trade; retry ${attempt}/5 after 300ms`);
          await new Promise((r) => setTimeout(r, 300));
          await this.detectCurrentPosition(true);
          side = this.currentPosition;
          qty = this.currentPositionQuantity;
          entryPrice = this.positionEntryPrice;
          if ((side === 'LONG' || side === 'SHORT') && qty && qty > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
            console.log(`[REVERSAL] _refreshCurrentPosition: REST resolved non-empty on attempt ${attempt}/5`);
            break;
          }
        }
      }

      if ((side === 'LONG' || side === 'SHORT') && qty && qty > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
        const notional = qty * entryPrice;
        this.activePosition = {
          quantity: qty,
          entryPrice,
          avgEntry: entryPrice,
          notional,
          unrealizedPnl: 0,
        };
        this.currentSide = side;
        if (Number.isFinite(this.currentPrice) && this.currentPrice > 0) {
          this._updateUnrealizedPnL(this.currentPrice);
        }
        return;
      }

      // No position (or REST kept returning empty after retries).
      this.activePosition = null;
      this.currentSide = null;
    } catch (err) {
      await this.addLog(`[REVERSAL] _refreshCurrentPosition error: ${err.message}`);
    }
  }

  /**
   * Recompute unrealized PnL on the active position from the latest
   * mark price. LONG: (price - entry) × qty; SHORT: (entry - price) × qty.
   * Cheap — called from handleRealtimePrice on every tick and at the end
   * of _postExecuteBookkeeping. Result is written to activePosition.unrealizedPnl.
   */
  _updateUnrealizedPnL(currentPrice) {
    if (!this.activePosition || !Number.isFinite(currentPrice) || currentPrice <= 0) return;
    const { quantity, entryPrice } = this.activePosition;
    if (!Number.isFinite(quantity) || !Number.isFinite(entryPrice) || quantity <= 0 || entryPrice <= 0) return;
    const direction = this.currentSide === 'LONG' ? 1 : this.currentSide === 'SHORT' ? -1 : 0;
    if (direction === 0) return;
    this.activePosition.unrealizedPnl = (currentPrice - entryPrice) * quantity * direction;
  }

  /**
   * Cache the volume primitives from a freshly-built reversal context so
   * getStatus() can surface them to the frontend chart. Refreshed at every
   * AI consult (Context 1 plan, Context 2 veto).
   */
  _cacheVolumeContext(ctx) {
    if (!ctx) return;
    // Merge-only: never overwrite a previously-cached non-null value
    // with a null/undefined fresh value. A transient Binance kline fetch
    // failure inside marketContext._getVolumeProfile / _getCvdSnapshot
    // would otherwise wipe good data the chart was already rendering.
    if (ctx.volumeProfile24h != null) this._lastVolumeProfile24h = ctx.volumeProfile24h;
    if (ctx.volumeProfile7d != null) this._lastVolumeProfile7d = ctx.volumeProfile7d;
    if (ctx.cvd != null) this._lastCvd = ctx.cvd;
    if (ctx.orderbookDepth != null) this._lastOrderbookDepth = ctx.orderbookDepth;
    if (ctx.volatility != null) this._lastVolatility = ctx.volatility;
  }

  /**
   * Refresh the volume primitives (VP24h/VP7d/CVD/orderbook/ATR) outside
   * of an AI consult. Needed because:
   *   - Heartbeat was removed; AI consults only fire on cycle start +
   *     post-harvest (PLAN), the harvest gate (sets a harvest price), the
   *     pre-reversal size veto ONLY when aiVetoOnReversal is on (default off),
   *     and user ask-AI. A plain reversal does NOT consult the AI by default.
   *   - resume() deliberately does NOT fire a fresh PLAN when a position
   *     is already held, so after a force-update the cached primitives
   *     start empty and stay empty until the user reverses/harvests —
   *     which means the chart's POC/VAH/VAL/HVN/ATR/CVD panels all
   *     render "—" until then.
   *
   * Calls the per-primitive fetchers directly (each has its own internal
   * TTL cache, so a 5-min cadence here is cheap — first call after the
   * cache lapses hits Binance, subsequent calls within the TTL no-op).
   * Fire-and-forget; cache update goes through _cacheVolumeContext which
   * is merge-only (above) so a transient fetch failure can't blank the
   * chart.
   */
  async _refreshVolumeSnapshot() {
    if (!this.isRunning || !this.marketContext) return;
    try {
      const [vp24h, vp7d, cvd, depth, volatility] = await Promise.all([
        this.marketContext._getVolumeProfile('24h'),
        this.marketContext._getVolumeProfile('7d'),
        this.marketContext._getCvdSnapshot(),
        this.marketContext._getOrderbookSnapshot(),
        this.marketContext._getVolatility(),
      ]);
      this._cacheVolumeContext({
        volumeProfile24h: vp24h,
        volumeProfile7d: vp7d,
        cvd,
        orderbookDepth: depth,
        volatility,
      });
    } catch (err) {
      console.error(`[REVERSAL] _refreshVolumeSnapshot error: ${err.message}`);
    }
  }

  _scheduleVolumeRefresh() {
    if (this._volumeRefreshInterval) clearInterval(this._volumeRefreshInterval);
    // 5-minute cadence. Each fetcher caches internally (VP TTL 10min,
    // CVD ~5min, etc.) so this is cheap when nothing has expired and
    // keeps the chart fresh during long position holds.
    this._volumeRefreshInterval = setInterval(() => {
      if (!this.isRunning) return;
      this._refreshVolumeSnapshot().catch(() => {});
    }, 5 * 60 * 1000);
  }

  _accumulateAiUsage(plan) {
    if (!plan?._usage) return;
    this.aiTokenUsage.inputTokens += plan._usage.inputTokens || 0;
    this.aiTokenUsage.outputTokens += plan._usage.outputTokens || 0;
    this.aiTokenUsage.cacheRead += plan._usage.cacheRead || 0;
    this.aiTokenUsage.cacheCreation += plan._usage.cacheCreation || 0;
    this.aiTokenUsage.requests += 1;
    // Final TP target includes AI consult cost — recompute so the price
    // creeps up in lock-step with token spend, not just on trades/funding.
    this._recomputeFinalTpPrice();
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

  /**
   * Fetches the Anthropic API key for this profile (env var override, then
   * GCF proxy to the user's Secret Manager binding). Lives here rather than
   * on TradingBase — follow-up: refactor down to TradingBase.
   */
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

  // DeepSeek key fetcher — same pattern as _fetchAnthropicApiKey, hits a
  // different /secret/* endpoint on the per-profile binance-proxy GCF.
  // ai-planner detects the model prefix and routes the SDK to
  // api.deepseek.com/anthropic so the key works against DeepSeek V4.
  async _fetchDeepseekApiKey() {
    const envKey = process.env.DEEPSEEK_API_KEY;
    if (envKey) return envKey;

    const response = await fetch(this.sharedVmProxyGcfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': this.profileId },
      body: JSON.stringify({ apiType: 'secret', endpoint: '/secret/deepseek', profileBinanceApiGcfUrl: this.gcfProxyUrl }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Failed to fetch DeepSeek key: ${response.status} - ${err.error || response.statusText}`);
    }

    const { apiKey } = await response.json();
    if (!apiKey) throw new Error('No DeepSeek API key configured.');
    return apiKey;
  }

  // ——— Platform Fee ————————————————————————————————————————————————

  /**
   * Deducts the platform fee from the user's wallet on net positive PnL.
   * Lives here rather than on TradingBase for the same reason
   * _fetchAnthropicApiKey does; follow-up: refactor down to TradingBase.
   * Called from stop() when netPnL > 0.
   */
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
      currentPosition: this.activePosition,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      finalTpPrice: this.finalTpPrice,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      harvestPrice: this.harvestPrice,
      initialCapital: this.initialCapital,
      currentInitialSize: this.currentInitialSize,
      desiredProfitUSDT: this.desiredProfitUSDT,
      // Running config — surfaced so the frontend's Active Config panel
      // can show the values the bot is ACTUALLY using rather than the
      // form's DEFAULT_CONFIG (which is what reversal's frontend used
      // to read, producing a wrong picture when a strategy was started
      // with non-default settings and the user later refreshed the page).
      leverage: this.leverage,
      priceType: this.priceType,
      aiModel: this.aiModel,
      recoveryFactor: this.recoveryFactor,
      recoveryDistance: this.recoveryDistance,
      harvestLossThreshold: this.harvestLossThreshold,
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      recoveryFactorDecay: this.recoveryFactorDecay,
      recoveryDistanceAutoWiden: this.recoveryDistanceAutoWiden,
      aiVetoOnReversal: this.aiVetoOnReversal,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      activePlan: this.activePlan,
      lastDecision: this.lastDecision,
      aiTokenUsage: this.aiTokenUsage,
      aiUsageCostUSD: this.getAiUsageCost(),
      cycleStartTime: this.cycleStartTime,
      cycleDuration: this.cycleStartTime ? formatDuration(Date.now() - this.cycleStartTime) : null,
      // Emitted as an ISO string for the frontend chart's SS marker
      // (`updateSessionStartX` does `Date.parse(status.strategyStartTime)`).
      // Without this, the SS vertical dotted line never draws on reversal.
      strategyStartTime: this.strategyStartTime ? this.strategyStartTime.toISOString() : null,
      currentPrice: this.currentPrice,

      // Volume primitives — cached at every AI consult by _cacheVolumeContext.
      // Frontend chart overlays POC / VAH / VAL / HVN edges from these.
      volumeProfile24h: this._lastVolumeProfile24h,
      volumeProfile7d: this._lastVolumeProfile7d,
      cvd: this._lastCvd,
      orderbookDepth: this._lastOrderbookDepth,
      // ATR / volatility — feeds the Volume Analytics panel's ATR cell.
      volatility: this._lastVolatility,
    };
  }

  /**
   * Slim TRUE LIVE snapshot for WS heartbeat broadcasts. Excludes:
   *   - Static config (leverage / priceType / recovery params / etc.) — loaded
   *     once by frontend's initial REST fetch of getStatus().
   *   - Fields covered by other event pushes (currentPrice via price_tick;
   *     bullLevel/bearLevel/activePlan/finalTpPrice via plan_update / flow_event).
   *   - AI-consult cache (volumeProfile / cvd / orderbookDepth / volatility)
   *     which only changes on consults — pushed via plan_update.context.
   *   - Derivable fields (cycleDuration = Date.now() - cycleStartTime).
   * Fires on the 30s safety-net interval AND immediately after every
   * bookkeeping change via _pushHeartbeatNow(). Frontend merges into existing
   * state (setStatus(prev => ({...prev, ...payload}))).
   */
  getHeartbeatPayload() {
    return {
      strategyId: this.strategyId,
      executionState: this.executionState,
      subState: this.subState,
      isRunning: this.isRunning,
      currentSide: this.currentSide,
      currentPosition: this.activePosition,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      harvestPrice: this.harvestPrice,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      aiTokenUsage: this.aiTokenUsage,
      aiUsageCostUSD: this.getAiUsageCost(),
    };
  }

  /**
   * Immediate heartbeat broadcast — called from every bookkeeping path that
   * mutates TRUE LIVE state (trade fills via _postExecuteBookkeeping; AI
   * consults via _savePlanToFirestore caller; harvest-price set/clear).
   * Combined with the 30s safety-net interval in app.js, this means frontend
   * sees state mutations at sub-second latency without waiting for the next
   * tick. Best-effort — wrapped in try/catch so a broadcast hiccup never
   * disturbs the trading logic.
   */
  _pushHeartbeatNow() {
    try {
      wsBroadcast.pushStrategyUpdate(this.strategyId, this.getHeartbeatPayload());
    } catch (_) { /* non-fatal */ }
  }

  // ——— Firestore persistence ——————————————————————————————————————————

  /**
   * Persist the full strategy snapshot to Firestore. Public so resume()
   * (via app.js recoverActiveStrategies) can find the doc by `type` and
   * so all lifecycle sites have a single source-of-truth save method.
   *
   * Required fields for the bot's boot-time recovery scan:
   *   - type: 'AI_REVERSAL' (queried by recoverActiveStrategies)
   *   - isRunning: true while the strategy is alive
   *   - gcfProxyUrl + sharedVmProxyGcfUrl (C4 — without these resume()
   *     can't reconstruct the Binance proxy or Anthropic key fetcher)
   *   - _lastFundingPollTs (so the next poll uses the correct high-water
   *     mark instead of re-scanning the last 8h)
   */
  async saveState() {
    if (!this.firestore || !this.strategyId) return;
    try {
      const doc = {
        // Type tag for the boot-recovery scan.
        type: 'AI_REVERSAL',
        strategyType: 'reversal',  // legacy alias; kept for back-compat
        strategyId: this.strategyId,
        userId: this.userId,
        profileId: this.profileId,
        // C4 — proxy URLs required to reconstruct the strategy after restart.
        gcfProxyUrl: this.gcfProxyUrl,
        sharedVmProxyGcfUrl: this.sharedVmProxyGcfUrl,
        symbol: this.symbol,
        isRunning: this.isRunning,
        executionState: this.executionState,
        subState: this.subState,
        // 'final_tp' | 'manual' | null — how the cycle ended (set in stop()).
        stopReason: this.stopReason ?? null,
        currentSide: this.currentSide,
        currentPosition: this.activePosition,
        bullLevel: this.bullLevel,
        bearLevel: this.bearLevel,
        finalTpPrice: this.finalTpPrice,
        cycleAccumulatedLoss: this.cycleAccumulatedLoss,
        reversalCount: this.reversalCount,
        harvestCount: this.harvestCount,
        harvestPrice: this.harvestPrice,
        initialCapital: this.initialCapital,
        initialWalletBalance: this.initialWalletBalance,
        currentInitialSize: this.currentInitialSize,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
        accumulatedTradingFees: this.accumulatedTradingFees || 0,
        accumulatedFundingFees: this.accumulatedFundingFees || 0,
        // Funding poll baseline — without this, resume() would re-scan
        // the entire last-8h window and double-count past entries.
        _lastFundingPollTs: this._lastFundingPollTs,
        // L3-reconcile watermark — latest fill time whose effects are
        // already in accumulatedTradingFees / accumulatedRealizedPnL.
        // Without persistence, resume() would default to strategyStartTime
        // and L3 would re-add every historical fill on top of the restored
        // accumulators (fee/realized-PnL doubling on every VM restart).
        _lastReconciliationAt: this._lastReconciliationAt || null,
        activePlan: this.activePlan,
        lastDecision: this.lastDecision,
        planHistory: this.planHistory.slice(-50),
        cycleStartTime: this.cycleStartTime,
        // strategyStartTime + strategyEndTime are read by the frontend
        // useStrategyCompletionListener to compute timeTaken on the in-app
        // Final-TP notification banner. Without them duration shows 'N/A'.
        strategyStartTime: this.strategyStartTime || null,
        strategyEndTime: this.strategyEndTime || null,
        leverage: this.leverage,
        maxPositionSizeUSDT: this.maxPositionSizeUSDT,
        aiModel: this.aiModel,
        aiTokenUsage: this.aiTokenUsage,
        // Strategy settings surfaced at top-level so the Historical tab's
        // summary card can render them without descending into config.
        // (HistoricalDataTab reads d.desiredProfitUSDT / d.positionSizeUSDT /
        // d.priceType / d.recoveryFactor etc. directly.)
        desiredProfitUSDT: this.desiredProfitUSDT,
        positionSizeUSDT: this.currentInitialSize,
        priceType: this.priceType,
        recoveryFactor: this.recoveryFactor,
        recoveryDistance: this.recoveryDistance,
        harvestLossThreshold: this.harvestLossThreshold,
        recoveryFactorDecay: this.recoveryFactorDecay,
        recoveryDistanceAutoWiden: this.recoveryDistanceAutoWiden,
        aiVetoOnReversal: this.aiVetoOnReversal,
        config: {
          recoveryFactor: this.recoveryFactor,
          recoveryDistance: this.recoveryDistance,
          harvestLossThreshold: this.harvestLossThreshold,
          desiredProfitUSDT: this.desiredProfitUSDT,
          initialSize: this.currentInitialSize,
          recoveryFactorDecay: this.recoveryFactorDecay,
          recoveryDistanceAutoWiden: this.recoveryDistanceAutoWiden,
          aiVetoOnReversal: this.aiVetoOnReversal,
        },
        criticalError: this.criticalError || null,
        lastUpdated: new Date(),
        updatedAt: Date.now(),
      };
      await this.firestore.collection('strategies').doc(this.strategyId).set(doc, { merge: true });
    } catch (err) {
      await this.addLog(`[REVERSAL] saveState error: ${err.message}`);
    }
  }

  /**
   * Persist a single AI plan response to the strategies/{id}/aiPlans
   * subcollection so the /ai-reversal/plan-history endpoint can return a
   * real audit trail.
   * Stores the consult context (plan / veto) for filtering.
   */
  async _savePlanToFirestore(plan, consultContext, extras = {}) {
    if (!this.firestore || !this.strategyId) return null;
    try {
      const timestamp = new Date();
      const ref = await this.firestore.collection('strategies').doc(this.strategyId).collection('aiPlans').add({
        consultContext: consultContext || 'plan',
        plan: {
          decision: plan.decision || null,
          bullLevel: plan.bullLevel ?? null,
          bearLevel: plan.bearLevel ?? null,
          // user_question consults return proposedBull/BearLevel (not bull/bearLevel).
          // Persisting them lets the chat UI replay the proposal across reloads.
          proposedBullLevel: plan.proposedBullLevel ?? null,
          proposedBearLevel: plan.proposedBearLevel ?? null,
          newInitialSize: plan.newInitialSize ?? null,
          newSize: plan.newSize ?? null,
          rationale: plan.rationale || null,
          confidence: typeof plan.confidence === 'number' ? plan.confidence : null,
        },
        // The raw user question for user_question consults — surfaced as the
        // "You: ..." line in the chat replay. Other consult contexts pass null.
        userQuestion: extras.userQuestion || null,
        usage: plan._usage || null,
        cycleSnapshot: {
          currentSide: this.currentSide,
          reversalCount: this.reversalCount,
          harvestCount: this.harvestCount,
          cycleAccumulatedLoss: this.cycleAccumulatedLoss,
          bullLevel: this.bullLevel,
          bearLevel: this.bearLevel,
          // Persisted per consult so the chart can rebuild Final TP history
          // segments on reload. Side-aware coloring uses currentSide above.
          finalTpPrice: this.finalTpPrice ?? null,
        },
        timestamp,
      });

      // Slim real-time plan_update push for chart bull/bear overlay + chat
      // replay. Extended in this batch with `context` (AI consult cache —
      // volume profiles / CVD / orderbookDepth / volatility), which only
      // refreshes on consults so it now travels here exclusively, not on
      // every 30s heartbeat. Frontend merges `context` into status state.
      // marketContext / newInitialSize / etc. remain stripped — consumers
      // don't read them and they'd balloon the payload by 10-50 KB.
      try {
        wsBroadcast.pushPlanUpdate(this.strategyId, {
          id: ref.id,
          consultContext: consultContext || 'plan',
          timestamp: timestamp.toISOString(),
          userQuestion: extras.userQuestion || null,
          plan: {
            bullLevel: plan.bullLevel ?? null,
            bearLevel: plan.bearLevel ?? null,
            proposedBullLevel: plan.proposedBullLevel ?? null,
            proposedBearLevel: plan.proposedBearLevel ?? null,
            rationale: plan.rationale || null,
            confidence: typeof plan.confidence === 'number' ? plan.confidence : null,
          },
          cycleSnapshot: {
            bullLevel: this.bullLevel,
            bearLevel: this.bearLevel,
          },
          // AI consult cache — only refreshed on consults, so heartbeat no
          // longer carries these. Frontend merges into status so the chart's
          // VPVR overlay + Volume Analytics panel stay live across reloads.
          context: {
            volumeProfile24h: this._lastVolumeProfile24h,
            volumeProfile7d: this._lastVolumeProfile7d,
            cvd: this._lastCvd,
            orderbookDepth: this._lastOrderbookDepth,
            volatility: this._lastVolatility,
          },
        });
      } catch (_) { /* push is best-effort; REST poll catches stragglers */ }

      // Heartbeat fire — aiUsageCostUSD / aiTokenUsage just incremented from
      // this consult. Without immediate push, frontend would see stale cost
      // for up to 30s (next safety-net interval).
      this._pushHeartbeatNow();

      return ref.id;
    } catch (err) {
      console.error(`Failed to save reversal plan: ${err.message}`);
      return null;
    }
  }

  /**
   * Mark a previously-persisted user_question aiPlans doc as applied.
   * Called from /ai-reversal/adjust-levels when the request carries a
   * sourcePlanId, so the chat replay can restore the "Applied" pill
   * across reloads / devices. No-op if the doc does not exist.
   */
  async _markPlanApplied(planId, appliedBullLevel, appliedBearLevel) {
    if (!this.firestore || !this.strategyId || !planId) return;
    try {
      await this.firestore.collection('strategies').doc(this.strategyId)
        .collection('aiPlans').doc(planId).set({
          userActions: {
            applied: true,
            appliedAt: new Date(),
            appliedBullLevel: appliedBullLevel ?? null,
            appliedBearLevel: appliedBearLevel ?? null,
          },
        }, { merge: true });
    } catch (err) {
      console.error(`Failed to mark plan ${planId} applied: ${err.message}`);
    }
  }
}

export { AiReversalStrategy };
export default AiReversalStrategy;
