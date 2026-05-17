import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import { AiPlanner } from './ai-planner.js';
import { AiPlanExecutor } from './ai-plan-executor.js';
import { AiRiskGuard, FEE_RATE } from './ai-risk-guard.js';
import { AiMarketContext } from './ai-market-context.js';

// Per-model pricing in USD per million tokens. Mirrors ai-hedge-strategy.js.
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
    this.activePosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
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

    // Cached volume primitives — refreshed at every AI consult and surfaced
    // via getStatus() so the frontend chart can overlay POC/VAH/VAL/HVN edges.
    this._lastVolumeProfile24h = null;
    this._lastVolumeProfile7d = null;
    this._lastCvd = null;
    this._lastOrderbookDepth = null;
    // ATR / volatility snapshot — feeds the Volume Analytics panel's ATR
    // cell. Populated by _cacheVolumeContext on every AI consult; mirrors
    // hedge's _lastVolatility pattern.
    this._lastVolatility = null;

    // Token usage accumulators
    this.aiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };

    // Heartbeat scheduler
    this._heartbeatTimer = null;

    // Stale retry on AI failure
    this._staleRetryAttempt = 0;
    this._staleRetryTimer = null;

    // Lifecycle infrastructure (mirrors AiHedgeStrategy fields). Tracked
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
      `recoveryDistanceAutoWiden=${this.recoveryDistanceAutoWiden ? 'on' : 'off'}`
    );

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // ONE-WAY position mode — reversal is single-sided. Mutually exclusive
      // with AI Hedge (which uses hedge mode) at the Binance account level.
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

    // AI modules — same instantiation order as ai-hedge-strategy.
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
    // liquidation data (unlike hedge). One less stream to keep alive.
    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    // Periodic listen key refresh — keeps user data stream alive.
    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Reconcile against Binance — pick up any pre-existing position (e.g., manual trade or VM restart).
    await this.detectCurrentPosition(true);
    await this._refreshCurrentPosition();

    // Funding poll baseline + scheduler. Anchor at strategy start so the
    // first poll only catches entries from THIS cycle. Mirrors hedge's
    // pattern at ai-hedge-strategy.js:310-311.
    this._lastFundingPollTs = this.strategyStartTime.getTime();
    this._scheduleNextFundingPoll();

    await this.addLog(`AI Reversal Strategy started. Waiting for AI to set bull/bear levels...`);
    await this.saveState();

    // Kick off first PLAN consult and start heartbeat scheduler.
    this._requestPlan('cycle_start').catch(err => {
      this.addLog(`[REVERSAL] initial plan request error: ${err.message}`).catch(() => {});
    });
    this._startHeartbeat();
  }

  /**
   * Resume a strategy from a Firestore snapshot. Called by app.js boot-scan
   * (recoverActiveStrategies) when a `type: 'AI_REVERSAL'` doc has
   * `isRunning: true` but no in-memory instance exists (i.e. PM2 restart
   * / VM force-update). Mirrors AiHedgeStrategy.resume (line 328+).
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

    // Restore cycle state
    this.currentSide = snapshot.currentSide || null;
    this.activePosition = snapshot.currentPosition || null;
    this.bullLevel = snapshot.bullLevel || null;
    this.bearLevel = snapshot.bearLevel || null;
    this.finalTpPrice = snapshot.finalTpPrice || null;
    this.cycleAccumulatedLoss = snapshot.cycleAccumulatedLoss || 0;
    this.reversalCount = snapshot.reversalCount || 0;
    this.harvestCount = snapshot.harvestCount || 0;
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

    // AI continuity. planHistory restored as-is; activePlan restored only
    // if a position is currently held (otherwise we're in WAITING and a
    // fresh plan will arrive on the next heartbeat anyway).
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
    // and sizing math never read liquidation data (unlike hedge).
    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

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
    // automatically. Mirrors hedge's resume() pattern at
    // ai-hedge-strategy.js:571. Best-effort; swallow errors — the
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

    // Start heartbeat (5min cadence) so AI keeps consulting on the
    // resumed position. If we're in WAITING with no position, the
    // first price tick (or manual replan) will trigger a fresh PLAN.
    this._startHeartbeat();

    // Volume analytics live on _lastVolumeProfile24h/7d/_lastCvd/
    // _lastOrderbookDepth, populated only by _cacheVolumeContext() inside
    // an AI consult. Those fields are intentionally not persisted (stale
    // on resume anyway), so the running view's Volume Analytics panel
    // sits empty until the next consult — up to 5 min for in-position,
    // potentially hours for WAITING. Mirror start()'s immediate-consult
    // pattern so the panel populates within seconds. DeepSeek's prefix
    // cache absorbs most of the input-token cost.
    if (this.activePosition) {
      this._requestHeartbeat().catch((err) => {
        this.addLog(`[RECOVERY] immediate heartbeat failed: ${err.message}`).catch(() => {});
      });
    } else {
      this._requestPlan('resume_recovery').catch((err) => {
        this.addLog(`[RECOVERY] immediate plan failed: ${err.message}`).catch(() => {});
      });
    }
  }

  /**
   * Stop the strategy. Optionally flat the current position before
   * stopping. Mirrors AiHedgeStrategy.stop's cleanup discipline: every
   * interval/timeout started in start() or resume() MUST be cleared
   * here, otherwise a stop→start cycle leaks the prior session's timers.
   *
   * Order matters:
   *   1. Set isRunning=false to short-circuit any in-flight pollers
   *   2. Optional flatten (only if user asked)
   *   3. Clear ALL timers (heartbeat, stale retry, funding poll, listen-key refresh)
   *   4. Final funding poll so any settlement during stop is captured
   *   5. cleanupWebSockets to release the listen-key + drop streams
   *   6. saveState with isRunning=false marker
   *   7. Notification + onStopComplete hook
   */
  async stop(options = {}) {
    const { flatten = false } = options;
    this.isRunning = false;

    // Cancel ALL background timers. Each was started in start()/resume()
    // and would leak across a restart if missed here.
    this._stopHeartbeat();
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

    if (flatten) {
      // Source-of-truth refresh BEFORE the flatten check. activePosition can be
      // null in-memory while Binance still holds an open position (state lost
      // across a partial restart, missed WS update, etc.) — without this
      // refresh the close silently no-ops and the user is left with an open
      // position. Mirrors hedge's stop() pattern which always closes.
      try {
        await this._refreshCurrentPosition();
      } catch (err) {
        await this.addLog(`[REVERSAL] stop: pre-flatten position refresh failed: ${err.message}`);
      }

      if (this.activePosition && this.activePosition.quantity > 0) {
        try {
          await this.addLog(`[REVERSAL] stop: flattening ${this.currentSide} ${this.activePosition.quantity}`);
          await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason: 'user-stop' });
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
    }

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
    await this.saveState();
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

    // Keep the in-memory position's unrealized PnL fresh on every tick.
    // Cheap (multiplication + sign branch); needed so getStatus() and
    // Final TP gating see the latest unrealized value.
    if (this.activePosition) this._updateUnrealizedPnL(price);

    // Final TP check — highest priority. If hit, close to flat and terminate cycle.
    if (this.activePosition && this.finalTpPrice && this._checkFinalTpHit(price)) {
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

  async _requestHeartbeat() {
    if (!this.isRunning || this.executionState === 'TERMINATED') return;
    if (!this.activePosition || !this.activePosition.quantity) return;  // only consult while holding
    await this.addLog('[REVERSAL] _requestHeartbeat');
    try {
      const harvestEligible = this._isHarvestEligible();
      const ctx = await this.marketContext.buildReversalContext(this._buildStrategyState({
        consultContext: 'heartbeat',
        harvestEligible,
      }));
      this._cacheVolumeContext(ctx);
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
    await this.saveState();
    // Persist the plan to the aiPlans subcollection for audit trail
    // (consumed by /ai-reversal/plan-history).
    this._savePlanToFirestore(plan, 'plan').catch(() => {});
  }

  async _handleHeartbeatResponse(plan) {
    this.lastDecision = { decision: plan.decision, rationale: plan.rationale, timestamp: Date.now() };
    // Every heartbeat response gets persisted to aiPlans regardless of
    // the verb so the audit trail captures CONTINUE decisions too.
    this._savePlanToFirestore(plan, 'heartbeat').catch(() => {});

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
      await this.saveState();
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
    const verb = side === 'LONG' ? 'OPEN_LONG_AT_LEVEL' : 'OPEN_SHORT_AT_LEVEL';
    try {
      const sizeUSDT = this.currentInitialSize;
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
      await this._postExecuteBookkeeping(verb, { triggerPrice: levelPrice });
    }
  }

  async _performReversal(newSide) {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    const verb = newSide === 'LONG' ? 'REVERSE_TO_LONG' : 'REVERSE_TO_SHORT';
    let finalSize = 0;
    try {
      // Compute new size (formula + margin projection + AI veto).
      const proposed = this._computeFormulaSize();
      const projected = this._applyMarginHeadroomCap(proposed);
      finalSize = await this._requestVeto(projected);
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
      await this._postExecuteBookkeeping(verb, { sizeUSDT: finalSize });
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
      this.activePosition = null;
      this.currentSide = null;
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

  async _handleFinalTpHit() {
    if (this.executionState === 'EXECUTING') return;
    this.executionState = 'EXECUTING';
    try {
      const exitPrice = this.currentPrice;
      const exitSide = this.currentSide;
      await this.addLog(`[REVERSAL] Final TP hit at ${exitPrice} — closing cycle`);
      await this.executor.executeAction({ type: 'HARVEST_CLOSE', reason: 'final_tp' });

      // Verify Binance actually flattened the position. HARVEST_CLOSE sends
      // a market order, but if it errors or only partially fills the user is
      // left exposed. Refresh from REST + warn if residual remains; don't
      // null activePosition until we've confirmed it's actually flat.
      await this._refreshCurrentPosition();
      if (this.activePosition && this.activePosition.quantity > 0) {
        await this.addLog(`[REVERSAL] WARNING: Final TP close left residual ${this.currentSide} ${this.activePosition.quantity} on Binance — close it manually`);
      }

      this.activePosition = null;
      this.currentSide = null;
      this.subState = 'EXITED';
      this.executionState = 'TERMINATED';
      this.isRunning = false;
      this.strategyEndTime = new Date();
      this._stopHeartbeat();
      // Clear all background timers since the cycle is over (mirrors stop()).
      if (this._fundingPollTimeout) { clearTimeout(this._fundingPollTimeout); this._fundingPollTimeout = null; }
      if (this.listenKeyRefreshInterval) { clearInterval(this.listenKeyRefreshInterval); this.listenKeyRefreshInterval = null; }
      await this._postExecuteBookkeeping('FINAL_TP_HIT', { exitPrice });

      // Drop both WS streams (cycle is over, no more level-touch dispatch).
      try {
        if (typeof this.cleanupWebSockets === 'function') this.cleanupWebSockets();
      } catch (cleanupErr) {
        console.error(`[REVERSAL] Final TP cleanupWebSockets failed: ${cleanupErr.message}`);
      }

      // Push notification. Helper signature is (userId, strategyData) — the
      // previous single-object call meant strategyData was undefined and
      // sendPushNotification got the object as userId, so the FCM token
      // lookup silently failed. Fields mirror hedge's payload.
      try {
        const elapsed = this.cycleStartTime
          ? formatDuration(Date.now() - this.cycleStartTime)
          : 'N/A';
        const netPnL = (this.accumulatedRealizedPnL || 0)
          - (this.accumulatedTradingFees || 0)
          + (this.accumulatedFundingFees || 0);
        await sendStrategyCompletionNotification(this.userId, {
          strategyId: this.strategyId,
          symbol: this.symbol,
          netPnL,
          profitPercentage: this.initialCapital ? (netPnL / this.initialCapital) * 100 : 0,
          tradeCount: this.tradeCount || (this.reversalCount + this.harvestCount + 1),
          timeTaken: elapsed,
          realizedPnL: this.accumulatedRealizedPnL || 0,
          tradingFees: this.accumulatedTradingFees || 0,
          fundingFees: this.accumulatedFundingFees || 0,
        });
      } catch (notifyErr) {
        await this.addLog(`[REVERSAL] notify error: ${notifyErr.message}`);
      }

      // Persist the terminal state — required for the frontend's
      // useStrategyCompletionListener to see isRunning=false on a doc
      // tagged type='AI_REVERSAL' and surface the in-app notification.
      try {
        await this.saveState();
      } catch (saveErr) {
        console.error(`[REVERSAL] Final TP saveState failed: ${saveErr.message}`);
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
   * position covers accumulated_loss + desired_profit + ai_consult_cost.
   *
   *   needed = accLoss + desiredProfit + aiCost
   *   LONG:  qty × (price - entryAvg) ≥ needed
   *          price ≥ entryAvg + needed / qty
   *   SHORT: qty × (entryAvg - price) ≥ needed
   *          price ≤ entryAvg - needed / qty
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
    const needed = (this.cycleAccumulatedLoss || 0) + (this.desiredProfitUSDT || 0) + aiCost;
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
      this.cycleAccumulatedLoss = Math.max(0,
        -(this.accumulatedRealizedPnL || 0)
        + (this.accumulatedTradingFees || 0)
        + (this.accumulatedFundingFees || 0)
      );
      this._recomputeFinalTpPrice();
      await this.saveState();
      this._writeMetricsSample().catch(() => {});
      this._writeStrategyFlow(actionType, extra).catch(() => {});
    } catch (err) {
      console.error(`[REVERSAL] _postExecuteBookkeeping error: ${err.message}`);
    }
  }

  /**
   * Audit-trail record per strategy action. Enables the frontend chart
   * to correlate fills with the originating verb (OPEN_LONG_AT_LEVEL vs
   * REVERSE_TO_SHORT vs HARVEST_CLOSE) by timestamp proximity. Mirrors
   * hedge's strategyFlow subcollection.
   */
  async _writeStrategyFlow(actionType, extra = {}) {
    if (!this.firestore || !this.strategyId) return;
    try {
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
        timestamp: new Date(),
      });
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
   * `_lastFundingPollTs` is a no-op if no new entries. Mirrors
   * AiHedgeStrategy._pollFundingIncome (ai-hedge-strategy.js:1344-1384).
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

      // Funding flows into accumulated_loss with the same sign convention
      // as fees (positive = cost, increases the loss the strategy needs
      // to recover). negative funding (rebate) reduces loss.
      this.cycleAccumulatedLoss = Math.max(0,
        -(this.accumulatedRealizedPnL || 0)
        + (this.accumulatedTradingFees || 0)
        + (this.accumulatedFundingFees || 0)
      );
      this._recomputeFinalTpPrice();

      await this.addLog(
        `Funding settled: ${added >= 0 ? '+' : ''}${added.toFixed(4)} USDT ` +
        `(cumulative ${this.accumulatedFundingFees >= 0 ? '+' : ''}${this.accumulatedFundingFees.toFixed(4)} USDT, ${incomes.length} entries)`
      );
      await this.saveState();
      return { added, count: incomes.length };
    } catch (err) {
      console.error(`[REVERSAL] funding poll error: ${err.message}`);
      return { added: 0, count: 0, error: err.message };
    }
  }

  /**
   * Schedule the next funding-fee poll aligned to the next 8h UTC
   * settlement boundary + 60s safety buffer. Self-rescheduling.
   * Cancellable via clearTimeout(this._fundingPollTimeout). Mirrors
   * AiHedgeStrategy._scheduleNextFundingPoll (ai-hedge-strategy.js:1395-1424).
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
   * Mirrors AiHedgeStrategy._refreshHedgePositions (ai-hedge-strategy.js:1268).
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
   * AI consult (Context 1 plan, Context 2 heartbeat, Context 3 veto).
   */
  _cacheVolumeContext(ctx) {
    if (!ctx) return;
    if (ctx.volumeProfile24h !== undefined) this._lastVolumeProfile24h = ctx.volumeProfile24h;
    if (ctx.volumeProfile7d !== undefined) this._lastVolumeProfile7d = ctx.volumeProfile7d;
    if (ctx.cvd !== undefined) this._lastCvd = ctx.cvd;
    if (ctx.orderbookDepth !== undefined) this._lastOrderbookDepth = ctx.orderbookDepth;
    if (ctx.volatility !== undefined) this._lastVolatility = ctx.volatility;
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
   * Fetches the Anthropic API key for this profile. Mirrors
   * AiHedgeStrategy._fetchAnthropicApiKey (env var override, then GCF proxy
   * to the user's Secret Manager binding). Duplicated here rather than
   * inherited because AiReversalStrategy extends TradingBase, not
   * AiHedgeStrategy — follow-up: refactor to TradingBase.
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
        currentSide: this.currentSide,
        currentPosition: this.activePosition,
        bullLevel: this.bullLevel,
        bearLevel: this.bearLevel,
        finalTpPrice: this.finalTpPrice,
        cycleAccumulatedLoss: this.cycleAccumulatedLoss,
        reversalCount: this.reversalCount,
        harvestCount: this.harvestCount,
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
        config: {
          recoveryFactor: this.recoveryFactor,
          recoveryDistance: this.recoveryDistance,
          harvestLossThreshold: this.harvestLossThreshold,
          desiredProfitUSDT: this.desiredProfitUSDT,
          initialSize: this.currentInitialSize,
          recoveryFactorDecay: this.recoveryFactorDecay,
          recoveryDistanceAutoWiden: this.recoveryDistanceAutoWiden,
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
   * subcollection. Mirrors AiHedgeStrategy._savePlanToFirestore so the
   * /ai-reversal/plan-history endpoint can return a real audit trail.
   * Stores the consult context (plan / heartbeat / veto) for filtering.
   */
  async _savePlanToFirestore(plan, consultContext) {
    if (!this.firestore || !this.strategyId) return;
    try {
      await this.firestore.collection('strategies').doc(this.strategyId).collection('aiPlans').add({
        consultContext: consultContext || 'plan',
        plan: {
          decision: plan.decision || null,
          bullLevel: plan.bullLevel ?? null,
          bearLevel: plan.bearLevel ?? null,
          newInitialSize: plan.newInitialSize ?? null,
          newSize: plan.newSize ?? null,
          rationale: plan.rationale || null,
          confidence: typeof plan.confidence === 'number' ? plan.confidence : null,
        },
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
        timestamp: new Date(),
      });
    } catch (err) {
      console.error(`Failed to save reversal plan: ${err.message}`);
    }
  }
}

export { AiReversalStrategy };
export default AiReversalStrategy;
