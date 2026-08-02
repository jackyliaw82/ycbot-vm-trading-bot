import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import wsBroadcast from './ws-broadcast.js';
import { FieldValue } from '@google-cloud/firestore';
import { FEE_RATE } from './fees.js';
import { VolumeProfile } from './volume-profile.js';
import { MarketMetrics } from './market-metrics.js';
import {
  minInitialSizeUSDT,
  resolveLadderGeometry,
  LADDER_STEP_PCT,
  LADDER_LEVELS_PER_SIDE,
} from './ladder-levels.js';
import { buildReversalLadder } from './reversal-levels.js';
import { planReversalActions, averageOpenEntry } from './reversal-crossings.js';
import { planLevels } from './level-planner.js';
import { buildLevelContext } from './market-context.js';
import { precisionFormatter } from './precisionUtils.js';
import { trailDistance, trailExitLevel } from './reversal-trail.js';
import { AiPlanner } from './ai-planner.js';
import { AiUsageAccumulator } from './ai-cost.js';

const MARGIN_HEADROOM_FLOOR_PCT = 30;              // free margin floor for sizing safety
const HARVEST_LOSS_THRESHOLD_PCT = 0.08;           // 8% of initial capital — gate for HARVEST eligibility
const DEFAULT_RECOVERY_FACTOR = 0.20;
const DEFAULT_RECOVERY_DISTANCE = 0.005;           // 0.5%
// Backoff between `_reconcileTrendInvariant`'s Final-TP arming retries.
// The retry costs a Binance REST round trip AND a Firestore log write, and it
// is driven from `handleRealtimePrice` — i.e. every price tick, several per
// second. Unarmed TREND is fully exposed with no exit target, so we want the
// arm ASAP; Binance REST throttling on this VM's IP is a known live failure
// mode, so we cannot hammer it per tick. 15s is the compromise.
const TREND_ARM_RETRY_INTERVAL_MS = 15_000;
// Backoff between level-planning attempts. Planning costs a volume-profile
// build plus five market-data fetches (and, from Task 6, an AI round trip), and
// it is driven from `handleRealtimePrice` — several ticks per second. A failed
// plan leaves the strategy flat with no ladder, which is safe but idle, so the
// retry must be frequent enough to recover quickly and slow enough not to storm
// Binance. Same trade-off as the TREND arm retry, one notch longer.
const LEVEL_PLAN_RETRY_INTERVAL_MS = 30_000;
// Minimum distance a manual harvest/re-anchor Trigger Price must sit from the
// live price, so an armed trigger cannot accidentally fire on the very next
// tick. Hard-enforced by harvestNow(); the frontend mirrors it for UX only.
const TRIGGER_MIN_GAP_PCT = 0.001; // 0.1%

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
 * ReversalLadderStrategy — two-level reversal-ladder strategy.
 *
 * This file started as AnchorLadderStrategy (single anchor, LONG rungs above
 * it / SHORT below, crossing the anchor flattened the position) and was
 * rewritten on `feat/reversal-ladder-lvn` to replace that anchor with TWO
 * independently-set levels — `bullLevel` above, `bearLevel` below — with a
 * DEAD ZONE between them where nothing happens. A position opens at one
 * level, is held across the whole dead zone, and only ever changes at the
 * OTHER level: a REVERSAL that closes, resets the abandoned side's ledger,
 * and opens the new side on the SAME tick (`_reverseTo`). The old anchor
 * flatten's two-tick rule does not apply to a reversal — see
 * `reversal-crossings.js`'s `planReversalActions` for the full rule set.
 *
 * The levels themselves are DERIVED, not fixed geometry: `_planAndBuildLevels`
 * asks `planLevels` (level-planner.js) for a validated bull/bear pair, which
 * tries an AI planner first (`this._aiPlanner` — null until a later task wires
 * one in, so today it always falls through) and otherwise falls back to the
 * mechanical volume-profile void edges. A failed plan builds nothing and the
 * strategy stays flat with an empty ladder.
 *
 * Everything else is infrastructure reused verbatim from the anchor era —
 * Binance REST/WS plumbing, position reconciliation, fill resolution, funding
 * polling, Firestore persistence, bookkeeping, dynamic sizing, the harvest
 * gauge, the Trigger Price and Close & stop actions, the Final TP editor, and
 * the unified stop()/Final-TP termination path.
 *
 * One-way mode means a "leg" is bookkeeping only — Binance nets every filled
 * leg into a single `activePosition`, so there are no partial closes anywhere
 * in this strategy. Every close (reversal, Final TP, harvest) is a full
 * reduceOnly close of that one netted position, via `_closeConsolidated`.
 */
class ReversalLadderStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // Cycle / position state
    this.strategyType = 'reversalLadder';
    this.currentSide = null;                // 'LONG' | 'SHORT' | null
    this.activePosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
    // Set by _refreshCurrentPosition(): true when the LAST Binance position
    // fetch failed (state is UNKNOWN — never wiped to flat on failure), false
    // once a fetch succeeds. Read to tell "confirmed flat" apart from
    // "unknown" — by `_closeQuantity()`, by stop()'s residual verification,
    // and by `_recomputeFinalTpPrice`. It never gates a close: closes size
    // themselves from the legs, which need no fetch (see `_closeQuantity`).
    this._lastPositionRefreshFailed = false;
    // Backoff clock for `_reconcileTrendInvariant`'s Final-TP arming retry.
    // In-memory only and deliberately NOT persisted: a restart should always
    // get one immediate attempt at re-arming rather than inheriting a stale
    // interval from the process that died.
    this._trendArmRetryLastTs = null;
    // NOTE: `_trendFinalTpArmed` is deliberately NOT initialised here — it is
    // a DERIVED getter (see its definition above `_enterTrend`), not stored
    // state. It used to be a plain field, which is precisely why it could
    // drift out of step with `finalTpPrice`. Do not reintroduce the field.
    this.finalTpPrice = null;
    this.cycleAccumulatedLoss = 0;
    this.harvestCount = 0;
    this.reanchorCount = 0;              // every completed _harvestToFlat (flat reset OR position harvest); FE spinner watches this
    this.initialCapital = 0;
    this.currentInitialSize = 0;         // base for DYNAMIC trend sizing (original config size; never overwritten → no compounding)
    this._ladderBaseSize = 0;            // base the LADDER is sized from: initial size, then the dynamically re-sized base after a reversal / harvest
    this.cycleStartTime = null;
    // Execution lock. KEPT (not AI state): stop() uses the TERMINATED value
    // as the re-entry guard around termination. EXECUTING is not currently
    // produced by anything (its sole producer, the dead _handleFinalTpHit,
    // was removed) but the value is left in the enum for a future re-entry
    // guard around stop() itself. The AI-only 'PLANNING' value is no longer
    // produced by anything.
    this.executionState = 'IDLE';           // IDLE | EXECUTING | TERMINATED
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
    // The config view's desired profit, captured once per cycle and never
    // overwritten by an edit. It is the FLOOR: a manually-moved Final TP may
    // only ever project MORE profit than the config asked for, and Reset
    // returns to exactly this. `desiredProfitUSDT` cannot serve as the floor
    // because every edit overwrites it in place.
    this.minDesiredProfitUSDT = 0;

    // Volume profile — chart-only. Refreshed by _refreshVolumeSnapshot from
    // the salvaged VolumeProfile module so the frontend chart can overlay
    // POC/VAH/VAL/HVN edges. The ladder itself reads nothing from it.
    this.volumeProfile = null;              // VolumeProfile instance (built in start()/resume())
    this._lastVolumeProfile24h = null;
    // Volume Analytics cells, fed by MarketMetrics off the same 5-min refresh.
    // Display-only, exactly like the profile above: the ladder reads none of
    // them. See market-metrics.js.
    this.marketMetrics = null;              // MarketMetrics instance (built in start()/resume())
    this._lastCvd = null;
    this._lastOrderbookDepth = null;
    this._lastVolatility = null;

    // Lifecycle infrastructure. Tracked
    // here so stop() can clear every interval/timeout deterministically
    // and start()/resume() can restart them. Leaving any unset means a
    // restart will leak the prior session's timer.
    this.listenKeyRefreshInterval = null;
    this._fundingPollTimeout = null;
    this._lastFundingPollTs = null;

    // ---- Ladder state ----
    this.ladderMode = 'SCALING';        // SCALING | TREND
    this.bullLevel = null;              // upper trigger — L1 IS this price
    this.bearLevel = null;              // lower trigger — S1 IS this price
    this.reversalCount = 0;             // committed reversals this cycle
    this.trendStartPrice = null;        // the price TREND armed at; Task 5's trail measures from it
    this.ladderLines = [];              // [{index, direction, price, state, quantity}]
    this.lastProcessedPrice = null;     // last tick price the ladder crossing logic saw
    this.stepPct = LADDER_STEP_PCT;     // DEFAULT geometry; start() overrides from config within bounds (see ladder-levels.js resolveLadderGeometry)
    this.levelsPerSide = LADDER_LEVELS_PER_SIDE; // DEFAULT; same override in start()
    this._tradingSeqInProgress = false; // ladder crossing reentrancy guard
    // Re-entrancy latch for the TICK BODY. Deliberately DISTINCT from
    // `_tradingSeqInProgress`: that flag means "a trading sequence is
    // executing", and `_harvestToFlat` refuses to run while it is set — so it
    // cannot also serve as the tick's mutual-exclusion gate without silently
    // disabling every tick-driven harvest. See the tombstone in
    // `handleRealtimePrice`. Transient, never persisted: a restart must always
    // get a clean first tick rather than inherit a dead process's latch.
    this._tickInProgress = false;
    this._levelPlanInProgress = false;
    this._levelPlanLastTs = null;

    // ---- AI level planning (§10) ----
    // The key is held in memory ONLY. It is never logged, never written to
    // Firestore, and never returned by getStatus/getHeartbeatPayload — it comes
    // from Secret Manager via the start request (Phase 0) and a persisted copy
    // would put a live credential in a database the frontend can read.
    this._aiApiKey = null;
    this._aiPlanner = null;
    this.aiModel = 'deepseek-v4-flash';
    this._aiUsage = new AiUsageAccumulator();
    this.aiCostUSD = 0;

    // ---- TREND state ----
    this.trendDirection = null;         // origin breakout direction ('LONG'|'SHORT')

    // ---- Trailing exit (§7) ----
    // TREND-only give-back limiter. PERSISTED: a redeploy that silently
    // disarmed it would resume holding a runaway position the user armed
    // trailing to bound — a textbook fail-open. `trailExit` is persisted too
    // (not re-derived) because the ratchet is path-dependent: re-deriving it
    // from the live price after a restart would silently GIVE BACK every tick
    // of progress the ratchet had already locked in.
    this.trailEnabled = false;          // boolean — plain On/Off, direction comes from the position
    this.trailDistanceValue = null;     // number|null — fixed at TREND arm
    this.trailExit = null;              // number|null — the live ratcheted exit level

    // ---- Phase 3: harvest-gauge cap ----
    this._lastLadderSize = null;        // last dynamic ladder base size (for gauge-full freeze)
    this._manualHarvestRequested = false; // latch: harvestNow() sets this; honored on the next free tick (transient, not persisted)
    // Optional one-shot manual trigger (harvestNow(triggerPrice)). PERSISTED —
    // saveState/resume carry it so a VM restart doesn't silently disarm it.
    // Direction (`Above`) is fixed at arm time so it can't drift as price moves.
    this.harvestTriggerPrice = null;      // number | null
    this.harvestTriggerAbove = null;      // boolean | null: true = fire when price >= level
    // WHAT the armed trigger does on arrival. The trigger already owns the
    // "when" — validation, the 0.1% gap, tick rounding, persistence, resume,
    // cancel, and the pre-dispatch tick slot — so the stop variant is one extra
    // bit rather than a parallel mechanism that could drift out of step with it.
    // 'reanchor' (default) = close + re-anchor + keep trading, today's behaviour.
    // 'stop'               = close + END the cycle, for banking a profit and
    //                        walking away rather than rebuilding the ladder.
    this.harvestTriggerAction = 'reanchor';   // 'reanchor' | 'stop'
  }

  // ——— Lifecycle ——————————————————————————————————————————————————————

  /**
   * Start the strategy. Forces one-way position mode, subscribes to WS
   * streams, and builds the initial ladder on the first price tick.
   */
  async start(config = {}) {
    // strategyId is set by app.js before calling start() (non-blocking pattern).
    if (!this.strategyId) {
      this.strategyId = `reversal_ladder_${this.profileId}_${Date.now()}`;
    }
    this.initFirestoreCollections(this.strategyId);

    this.symbol = config.symbol || 'BTCUSDT';
    this.leverage = config.leverage || DEFAULT_LEVERAGE;
    this.priceType = config.priceType || 'MARK';
    this.recoveryFactor = config.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = config.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = config.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = config.desiredProfitUSDT || 0;
    this.minDesiredProfitUSDT = this.desiredProfitUSDT;   // the config value IS the floor
    this.currentInitialSize = config.initialSize || 0;
    this._ladderBaseSize = this.currentInitialSize; // initial ladder uses the initial size; a harvest later carries the last consolidated notional

    if (!this.symbol) throw new Error('ReversalLadderStrategy.start: missing symbol');
    // Ladder geometry. DEFAULTS preserve the original fixed geometry; both are
    // user-configurable within bounds enforced HERE via resolveLadderGeometry
    // (ladder-levels.js) — the SAME validator the /reversal-ladder/start route
    // uses, so the two gates can never drift again. The UI is a convenience —
    // the VM is the authority, so an old frontend or a direct API call cannot
    // deploy a structurally lossy or unreachable ladder. Rejected BEFORE any
    // network call, like the size gate below.
    const geometry = resolveLadderGeometry({
      ladderStepPct: config.ladderStepPct,
      ladderLevelsPerSide: config.ladderLevelsPerSide,
    });
    if (!geometry.ok) {
      await this.addLog(`ERROR: [VALIDATION_ERROR] ${geometry.error}`);
      throw new Error(geometry.error);
    }
    this.stepPct = geometry.stepPct;
    this.levelsPerSide = geometry.levelsPerSide;

    // Absent key = mechanical levels from `rangeVoids`. That is a real,
    // supported mode (§10's fallback), not a degraded start — so log it and
    // continue rather than refusing.
    this.aiModel = config.aiModel || this.aiModel;
    if (typeof config.aiApiKey === 'string' && config.aiApiKey.trim() !== '') {
      this._aiApiKey = config.aiApiKey.trim();
      this._aiPlanner = new AiPlanner(this._aiApiKey, this.aiModel);
      await this.addLog(`[REVERSAL] AI level planning enabled (${this.aiModel}).`);
    } else {
      await this.addLog(
        `[REVERSAL] no AI key supplied — levels will come from the mechanical volume-void edges.`,
      );
    }

    // Gate on the trivially-known minimum BEFORE any network call — no point
    // burning a setLeverage/setPositionMode/exchangeInfo round trip on an
    // input that's rejected regardless. (The tighter per-symbol minNotional
    // check, which needs exchangeInfoCache, runs further down after
    // _getExchangeInfo.)
    const minSize = minInitialSizeUSDT(this.levelsPerSide);
    if (!(this.currentInitialSize >= minSize)) {
      const msg = `Initial size (${this.currentInitialSize} USDT) is below the ${minSize} USDT minimum for a ${this.levelsPerSide}-level ladder.`;
      await this.addLog(`ERROR: [VALIDATION_ERROR] ${msg}`);
      throw new Error(msg);
    }

    await this.addLog(`Starting Reversal Ladder Strategy for ${this.symbol}...`);
    // Surface EVERY config field — used to verify the form values made it
    // through to the VM untouched. Three groups separated by `|` for
    // readability: identity/sizing | recovery knobs | advanced toggles.
    await this.addLog(
      `Config: symbol=${this.symbol}, initialSize=${this.currentInitialSize} USDT, ` +
      `leverage=${this.leverage}x, priceType=${this.priceType}, ` +
      `ladderStep=${(this.stepPct * 100).toFixed(2)}%, ladderLevels=${this.levelsPerSide}/side ` +
      `| recoveryFactor=${(this.recoveryFactor * 100).toFixed(0)}%, ` +
      `recoveryDistance=${(this.recoveryDistance * 100).toFixed(2)}%, ` +
      `harvestLossThreshold=${(this.harvestLossThreshold * 100).toFixed(0)}%, ` +
      `desiredProfitUSDT=${this.desiredProfitUSDT}`
    );

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // One-way (single-side) mode. The ladder holds LONG legs ONLY above
      // bullLevel and SHORT legs ONLY below bearLevel, and Rule 2 resets the
      // abandoned side before the new side fills, so it can never need both
      // sides at once — hedge mode is unnecessary, and one-way lets Binance
      // net the legs into a single position. Wrapped because Binance refuses
      // the call while positions are open (harmless: an open position means
      // the mode is already whatever it is).
      try {
        await this.setPositionMode(false);
      } catch (e) {
        await this.addLog(`WARN setPositionMode(false): ${e.message} (continuing — may already be one-way, or open positions block the switch).`);
      }
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`ERROR: [SETUP_ERROR] ${error.message}`);
      throw error;
    }

    const minNotional = this.exchangeInfoCache[this.symbol]?.minNotional || 5;
    this.minNotional = minNotional;
    // Divide by the FIELD, not the constant — `_legNotional()` (the runtime
    // sizing path) already does, and the two must agree or this gate validates a
    // 5-rung ladder against an N-rung runtime (too permissive for N > 5).
    const legNotional = this.currentInitialSize / this.levelsPerSide;
    if (legNotional < minNotional) {
      const msg = `Each ladder leg would be ${legNotional.toFixed(2)} USDT, below this symbol's ${minNotional} USDT minimum notional.`;
      await this.addLog(`ERROR: [VALIDATION_ERROR] ${msg}`);
      throw new Error(msg);
    }

    // Initial capital snapshot — drives the harvest gate and the sizing self-regulation loop.
    this.initialWalletBalance = await this.getWalletBalance();
    this.initialCapital = this.initialWalletBalance || this.currentInitialSize;
    await this.addLog(`Wallet balance: ${this._formatNotional(this.initialWalletBalance)} USDT — using as initialCapital.`);

    this.volumeProfile = new VolumeProfile(this);
    this.marketMetrics = new MarketMetrics(this);

    this.isRunning = true;
    this.cycleStartTime = Date.now();
    this.strategyStartTime = new Date();
    this.subState = 'INITIAL';
    this.executionState = 'IDLE';
    this.ladderMode = 'SCALING';
    this.ladderLines = [];

    // WebSocket setup — listen key first, then user-data + realtime price.
    // No liquidation WS: the ladder's geometry / sizing math never reads
    // liquidation data. One less stream to keep alive.
    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    // Periodic listen key refresh — keeps user data stream alive.
    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Background refresh of the display-only volume primitives
    // (VP24h/CVD/orderbook/ATR) that feed the chart's POC/HVN overlays and the
    // Volume Analytics panel.
    this._scheduleVolumeRefresh();

    // Reconcile against Binance — pick up any pre-existing position (e.g., manual trade or VM restart).
    // _refreshCurrentPosition() calls detectCurrentPosition(true) itself, inside
    // a try that sets _lastPositionRefreshFailed. Do NOT add a bare
    // detectCurrentPosition() call here: it now THROWS on an API error, and an
    // unguarded throw escapes start() (see the note in resume()).
    await this._refreshCurrentPosition();

    // Funding poll baseline + scheduler. Anchor at strategy start so the
    // first poll only catches entries from THIS cycle.
    this._lastFundingPollTs = this.strategyStartTime.getTime();
    this._scheduleNextFundingPoll();

    await this.addLog('ReversalLadderStrategy running — awaiting the first tick to plan levels.');
    await this.saveState();
    // Push immediately — one harmless extra heartbeat moments before the
    // first tick's own push from _buildLadders(). Synchronous + internally
    // try/caught, so no await (see _pushHeartbeatNow's own doc).
    this._pushHeartbeatNow?.();
  }

  /**
   * Build BOTH ladders around a validated level pair. The single writer of
   * `bullLevel`/`bearLevel` and of `ladderLines` on a fresh build.
   *
   * Callers must have validated the pair already (planLevels does, and refuses
   * to return an invalid one). `buildReversalLadder` throws on bad geometry
   * rather than silently building something unreachable — that throw is a real
   * bug signal and must not be swallowed here.
   */
  async _buildLadders({ bullLevel, bearLevel, reason = 'cycle_start' }) {
    this.ladderLines = buildReversalLadder(bullLevel, bearLevel, this.stepPct, this.levelsPerSide);
    this.bullLevel = bullLevel;
    this.bearLevel = bearLevel;
    this.ladderMode = 'SCALING';
    this.trendDirection = null;
    // Nulling finalTpPrice IS the disarm — `_trendFinalTpArmed` derives from it.
    this.finalTpPrice = null;
    this.trendStartPrice = null;
    this._clearTrail();
    this.lastProcessedPrice = this.currentPrice;

    await this.addLog(`===== LEVELS SET (${reason}) =====`);
    await this.addLog(
      `BULL ${this._formatPrice(bullLevel)} | BEAR ${this._formatPrice(bearLevel)} | ` +
      `dead zone ${(((bullLevel - bearLevel) / bearLevel) * 100).toFixed(2)}% | ` +
      `step ${(this.stepPct * 100).toFixed(2)}% | ${this.levelsPerSide} levels/side | ` +
      `leg ${this._formatNotional(this._legNotional())} USDT`,
    );
    await this.saveState();
    this._pushHeartbeatNow?.();
  }

  /**
   * Plan a level pair and build both ladders from it.
   *
   * Returns false when no valid pair could be produced — and when it returns
   * false NOTHING is built, so the strategy stays flat with an empty ladder and
   * the tick gate retries on the throttle. That is deliberate: trading without
   * levels has no entry trigger and no reversal boundary, so "we could not plan"
   * must never read as "proceed".
   *
   * `false` really does mean nothing was built, even on the unlikely path where
   * `_buildLadders` throws AFTER assigning `this.ladderLines` (its own trailing
   * addLog/saveState calls already self-catch, so this is defense in depth, not
   * a realistic trigger today) — checked below via `this.ladderLines.length`
   * rather than by whether the surrounding try completed, because BOTH callers
   * (the empty-ladder gate and `_harvestToFlat`) guarantee `ladderLines` is `[]`
   * before calling this, so a non-empty array after a throw can only mean
   * `_buildLadders` itself already assigned it.
   */
  async _planAndBuildLevels(reason) {
    if (this._levelPlanInProgress) return false;
    const now = Date.now();
    if (this._levelPlanLastTs != null && (now - this._levelPlanLastTs) < LEVEL_PLAN_RETRY_INTERVAL_MS) {
      return false;
    }
    this._levelPlanLastTs = now;
    this._levelPlanInProgress = true;
    try {
      const context = await buildLevelContext({
        symbol: this.symbol,
        currentPrice: this.currentPrice,
        volumeProfile: this.volumeProfile,
        marketMetrics: this.marketMetrics,
      });
      const result = await planLevels({ planner: this._aiPlanner ?? null, context });
      if (!result) {
        await this.addLog(
          `ERROR: level planning (${reason}) produced no valid bull/bear pair for ${this.symbol} — ` +
          `NOT trading without levels. Retrying in ${LEVEL_PLAN_RETRY_INTERVAL_MS / 1000}s.`,
        );
        return false;
      }
      // Account the consult's cost regardless of what happens to the pair
      // below — the AI call already happened and was billed, whether or not
      // the price-staleness re-check that follows discards its proposal.
      if (result.usage) {
        this._aiUsage.add(result.usage);
        this.aiCostUSD = this._aiUsage.costUsd(this.aiModel);
      }
      if (result.error) {
        await this.addLog(`[REVERSAL] level planning note: ${result.error}`);
      }
      await this.addLog(
        `[REVERSAL] levels from ${result.source} — bull ${this._formatPrice(result.bullLevel)} / ` +
        `bear ${this._formatPrice(result.bearLevel)}` +
        (result.rationale ? ` — ${result.rationale}` : ''),
      );

      // The pair was validated against the price as it stood BEFORE
      // buildLevelContext's six network fetches. Price can have left the band
      // in that window, and _buildLadders stamps lastProcessedPrice from the
      // LIVE price — so a ladder built now could sit entirely on one side of
      // price, and the next tick back through the level would open a position
      // in the wrong direction. Re-check against the live price rather than
      // trusting a snapshot that is seconds old; the throttle re-plans.
      const live = this.currentPrice;
      if (!Number.isFinite(live) || !(result.bearLevel < live && live < result.bullLevel)) {
        await this.addLog(
          `[REVERSAL] level planning (${reason}) discarded — price moved to ` +
          `${this._formatPrice(live)}, outside the proposed band ` +
          `${this._formatPrice(result.bearLevel)}–${this._formatPrice(result.bullLevel)} ` +
          `while the market context was being fetched. Re-planning.`,
        );
        return false;
      }

      await this._buildLadders({ bullLevel: result.bullLevel, bearLevel: result.bearLevel, reason });
      this._levelPlanLastTs = null;   // succeeded: no throttle carried forward
      return true;
    } catch (err) {
      // See the docstring above: a throw after _buildLadders already assigned
      // the ladder must still report success, never the "nothing was built"
      // false that every caller relies on.
      if (this.ladderLines.length) {
        await this.addLog(`WARNING: level planning (${reason}) built the ladder but a trailing step failed: ${err.message}`);
        this._levelPlanLastTs = null;
        return true;
      }
      await this.addLog(`ERROR: level planning (${reason}) failed for ${this.symbol}: ${err.message}`);
      return false;
    } finally {
      this._levelPlanInProgress = false;
    }
  }

  // Each leg is an equal slice of the ladder base. The base is the initial size
  // at cycle start, then whatever dynamic sizing produces at each reversal
  // and post-harvest.
  _legNotional() {
    return (this._ladderBaseSize || this.currentInitialSize || 0) / this.levelsPerSide;
  }

  /**
   * Resolve an order's ACTUAL fill (avg price + filled qty) from the user-data
   * WS, so open paths book position state from the real fill rather than the
   * requested qty at the target price. Waits for the WS FILLED marker, then
   * reads the captured summary (TradingBase.getWsOrderFill). Falls back, in
   * order, to the REST-ack FULL response (executedQty/avgPrice) and finally to
   * the requested qty at `fallbackPrice`. `source` records which path won.
   */
  async _resolveFill(orderId, restResult, requestedQty, fallbackPrice) {
    let filledQty = requestedQty;
    let fillPrice = fallbackPrice;
    try {
      if (orderId != null) {
        const confirmed = await this._waitForOrderFillConfirmation(orderId, 3000);
        const wf = this.getWsOrderFill(orderId);
        if (confirmed && wf && wf.filledQty > 0) {
          filledQty = wf.filledQty;
          if (Number.isFinite(wf.avgPrice) && wf.avgPrice > 0) fillPrice = wf.avgPrice;
          return { filledQty, fillPrice, source: 'ws' };
        }
      }
    } catch (e) {
      await this.addLog(`Fill-confirm ${orderId} failed (${e.message}); using REST/fallback.`);
    }
    // REST-ack fallback: the FULL market response may already carry the fill.
    const restQty = parseFloat(restResult?.executedQty);
    const restPrice = parseFloat(restResult?.avgPrice);
    if (Number.isFinite(restQty) && restQty > 0) {
      filledQty = restQty;
      if (Number.isFinite(restPrice) && restPrice > 0) fillPrice = restPrice;
      return { filledQty, fillPrice, source: 'rest' };
    }
    return { filledQty, fillPrice, source: 'fallback' };
  }

  /**
   * Notional -> quantity conversion (tick/step rounding, minNotional floor).
   * Thin wrapper around TradingBase._calculateAdjustedQuantity — the same
   * conversion the old hedge-mode _openGridLeg used.
   *
   * Every leg must carry its FULL designated notional (initialSize divided
   * evenly across the levels). The sizing formula and the harvest gauge are
   * calibrated on that, so nothing may scale a leg down behind their backs —
   * which is why the reversal-era L5b ATR scaling was removed from the base
   * class rather than left dormant. See the note at its old site.
   */
  async _quantityFor(symbol, notionalUSDT, price) {
    return this._calculateAdjustedQuantity(symbol, notionalUSDT, price);
  }

  /**
   * Close the net one-way position to flat: ONE reduceOnly market order via
   * `_closeConsolidated`, then reset every ladder leg's bookkeeping to EMPTY.
   *
   * One-way mode nets every filled leg into a single `activePosition` — there
   * is no such thing as a per-leg close, so the old hedge-mode per-leg
   * `_closeGridLeg` loop is gone. This is now a thin "flatten whatever is
   * open" primitive, used only by `stop({flatten:true})`.
   * (`_reverseTo` does NOT call this — it closes directly via
   * `_closeConsolidated` and rebuilds only the abandoned side.)
   *
   * Returns whether a position was ACTUALLY closed, never merely whether legs
   * were marked open.
   */
  async _flattenGrid(reason = 'FLATTEN') {
    const openLegs = this.ladderLines.filter(l => l.state === 'POSITION_OPEN');
    if (!openLegs.length && !this._closeQuantity()) return false;

    await this.addLog(`Flattening ladder: closing net position (${openLegs.length} leg(s) recorded open).`);
    const closed = await this._closeConsolidated(reason);

    if (!closed && this._closeQuantity() > 0) {
      await this.addLog(`WARNING: flatten (${reason}) could not be verified — leg ledger left INTACT.`);
      await this.saveState();
      this._pushHeartbeatNow?.();
      return false;
    }

    for (const leg of this.ladderLines) {
      leg.state = 'EMPTY';
      leg.quantity = null;
      leg.fillPrice = null;
    }

    await this.saveState();
    return closed;
  }

  /**
   * The quantity every close places — summed from the OPEN LEGS, never read
   * off `activePosition`.
   *
   * TOMBSTONE — do NOT "simplify" this back to `activePosition.quantity`.
   * `_fillLeg` books `leg.quantity` from the ACTUAL user-data WS fill, so the
   * open legs are a WS-true ledger of everything this bot has opened, and they
   * need no network call — they cannot 503. `activePosition.quantity` is
   * written ONLY by `_refreshCurrentPosition` (REST): when that fails it keeps
   * whatever it held BEFORE the failure, which can sit UNDER what Binance
   * really holds (a leg fill's own refresh 503'd — the leg is booked, the
   * position is not). Closing that stale figure orphans the remainder. THREE
   * rounds of bugs came from exactly this, each patched with another "refuse
   * to close on unknown state" guard in a caller; sizing from the legs removes
   * the cause, so none of those guards are needed.
   *
   * `activePosition` is kept only as a FLOOR, for the opposite drift (a
   * position with no legs behind it: legs wiped by a flatten whose close died
   * before `saveState`, or a position opened outside the bot). reduceOnly can
   * never flip a position, so an over-sized close is clamped by Binance and
   * harmless while an under-sized one orphans — max() is fail-safe on both.
   */
  _closeQuantity() {
    const restQty = (this.activePosition && this.activePosition.quantity) || 0;
    // The one question REST still answers better than the legs: Binance was
    // REACHABLE and reported flat, so open legs are stale bookkeeping and
    // there is genuinely nothing to close. Detection, NOT a refusal — when the
    // state is UNKNOWN this falls through and closes what the legs know.
    if (!restQty && !this._lastPositionRefreshFailed) return 0;
    const legQty = this.ladderLines
      .filter((l) => l.state === 'POSITION_OPEN')
      .reduce((sum, l) => sum + (l.quantity || 0), 0);
    // Round to the symbol's stepSize before returning. Summing per-leg
    // quantities — each already exchange-valid — produces float artifacts like
    // 0.28 × 3 = 0.8400000000000001, which Binance rejects on the close order
    // with -1111 "precision over maximum". roundQuantity FLOORS on the stepSize
    // (never overshoots the real position → no -2018 insufficient-position) and
    // cleans the FP noise; legQty and restQty describe the same position, so
    // this is lossless for a genuine close.
    return this.roundQuantity(Math.max(legQty, restQty));
  }

  /**
   * Binance -2022 "ReduceOnly Order is rejected" — the exchange refusing a
   * reduceOnly order because there is nothing left to reduce.
   *
   * `makeProxyRequest` (trading-base.js) attaches the Binance error code to
   * the thrown Error as `binanceErrorCode` — the same field `cancelOrder`
   * keys on for -2011 (trading-base.js) — so that structured field is the
   * primary signal here. `err.code` and the message substring are last-resort
   * fallbacks for any path that loses the structured field.
   */
  _isReduceOnlyRejected(err) {
    if (!err) return false;
    if (err.binanceErrorCode === -2022 || err.code === -2022 || err.code === '-2022') return true;
    return String(err.message || '').includes('-2022');
  }

  /**
   * Close the full net one-way position to flat — the SINGLE close primitive
   * for the whole strategy. reduceOnly is REQUIRED (not positionSide, which is
   * a hedge-mode concept) — without it a sub-minNotional close is rejected by
   * Binance with -4164 "insufficient position".
   *
   * Self-gating and self-sizing off `_closeQuantity()`: callers need not (and
   * must not) pre-decide what is open from a REST snapshot.
   *
   * Return contract (every caller depends on this): returns `true` ONLY when
   * the close is VERIFIED (WS fill marker, a full REST-ack qty, or a REST
   * position check confirming flat) — position state is cleared in that case
   * and only that case. Returns `false` when there was nothing to close, when
   * the side could not be resolved, or when the close could not be verified —
   * in the last two cases position state is deliberately left INTACT, so the
   * caller must NOT wipe its leg ledger.
   */
  async _closeConsolidated(reason) {
    let qty = this._closeQuantity();
    if (!(qty > 0)) return false;

    // The side comes from the legs for the same reason the quantity does:
    // `currentSide` is written only by `_refreshCurrentPosition` (REST), so it
    // is null in precisely the cases the legs still cover. Every open leg is
    // the same direction — Rule 2 resets the abandoned side to EMPTY before
    // the new side fills, so at most one direction is ever open at once.
    let side = this.currentSide
      || this.ladderLines.find((l) => l.state === 'POSITION_OPEN')?.direction
      || null;
    if (!side) {
      // A position with no legs behind it and no side in memory is state drift
      // (missed WS update, partial restart, a snapshot written without it).
      // Binance is the only source left — never guess a side.
      await this._refreshCurrentPosition();
      side = this.currentSide;
      qty = this._closeQuantity();
      if (!(qty > 0)) return false; // refresh resolved: nothing actually open
      if (!side) {
        await this.addLog(`WARNING: _closeConsolidated: ${this.symbol} has an open position (qty ${qty}) but currentSide could not be resolved even after refreshing from Binance — position NOT closed, must be closed manually.`);
        return false;
      }
    }
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    await this.addLog(`Consolidated CLOSE ${side} qty ${qty} (${reason}).`);
    let result;
    try {
      result = await this.placeMarketOrder(this.symbol, closeSide, qty, undefined, { reduceOnly: true });
    } catch (err) {
      // A reduceOnly rejection is EVIDENCE the position may already be flat —
      // it is Binance saying "there is nothing to reduce". Rethrowing here
      // aborted the whole tick before the verification tiers below could ask
      // what is actually open, so the same doomed close was re-issued every
      // tick forever (the -2022 runaway of 2026-07-25). Fall through instead:
      // tier 1 and 2 self-skip without an order result, and tier 3 answers
      // authoritatively. An unreachable or still-open Binance still resolves to
      // "unverified", which leaves the leg ledger INTACT exactly as before.
      if (!this._isReduceOnlyRejected(err)) throw err;
      await this.addLog(
        `Close (${reason}) for ${this.symbol} ${side} qty ${qty} was rejected by Binance as reduceOnly (-2022) — ` +
        `verifying the real position before deciding.`,
      );
      result = null;
    }

    // Verify the close ACTUALLY happened before dropping position state. Mirrors
    // the tiering `_resolveFill` already uses on the open path. Returning true on
    // an unverified close is what let a live position be dropped from the books.
    // Tier 1 — user-data WS FILLED marker (fastest truth). Resolves false on
    // timeout; it never rejects, so there is nothing to catch.
    let verified = result?.orderId
      ? await this._waitForOrderFillConfirmation(result.orderId, 3000)
      : false;

    // Tier 2 — the REST order-ack usually already carries the fill for a MARKET
    // order. Require the FULL requested qty; a partial falls through to tier 3.
    if (!verified) {
      const acked = parseFloat(result?.executedQty);
      if (Number.isFinite(acked) && acked >= qty) verified = true;
    }

    // Tier 3 — ask Binance what the position actually is. A confirmed-flat
    // account proves the close landed even if we never saw the fill event.
    if (!verified) {
      // No try/catch: _refreshCurrentPosition() catches internally and NEVER
      // throws — it signals failure via _lastPositionRefreshFailed, not an
      // exception, so a catch here was dead code (and a silent-swallow catch
      // is exactly the shape this fix set out to remove).
      await this._refreshCurrentPosition();
      const stillOpen = !!(this.activePosition && this.activePosition.quantity > 0);
      if (!this._lastPositionRefreshFailed && !stillOpen) verified = true;
    }

    if (!verified) {
      await this.addLog(
        `WARNING: close (${reason}) for ${this.symbol} ${side} qty ${qty} could NOT be verified — no WS fill ` +
        `event, no fill quantity in the REST ack, and Binance has not verified the position as closed. ` +
        `Position state left INTACT. Verify manually on Binance.`,
      );
      return false;
    }

    this.activePosition = null;
    this.currentSide = null;
    this.finalTpPrice = null;
    return true;
  }

  // Harvest gauge is full once accumulated loss reaches the configured threshold of initial capital.
  _isGaugeFull() {
    return this.initialCapital > 0
      && this.cycleAccumulatedLoss >= this.harvestLossThreshold * this.initialCapital;
  }

  /**
   * Dynamic re-basing of the ladder's per-leg notional, applied at every
   * reversal (formerly `_computeTrendSize`, the old grid's RANGE->TREND
   * entry sizing — same recovery-formula + margin-headroom-cap + gauge-full
   * freeze, repurposed: the ladder re-bases at every reversal instead of
   * sizing a one-off consolidated TREND entry).
   *
   * Async: fetches the LIVE margin balance for the headroom cap rather than
   * trusting a cached snapshot. Called only from `_reverseTo` /
   * `_harvestToFlat` — both async, both at reset points, a handful of
   * times per cycle, never in a hot loop — so the extra round trip is cheap
   * and buys a correct-during-drawdown headroom figure instead of a frozen
   * cycle-start one.
   */
  async _computeLadderBaseSize() {
    this.cycleAccumulatedLoss = this._computeAccLoss();
    // Gauge-full escalation freeze: once the gauge is full, stop GROWING live
    // exposure — reuse the last (grown) size. This is the gauge's sole remaining
    // job: a re-anchor/harvest at a full gauge keeps the locked size, at a
    // not-full gauge re-sizes fresh.
    if (this._isGaugeFull() && this._lastLadderSize != null) {
      return this._lastLadderSize;
    }
    const proposed = this._computeFormulaSize();
    let walletBalance;
    try {
      walletBalance = await this.getTotalMarginBalance();
    } catch (err) {
      // FAIL CLOSED: an unknown margin balance must never read as "plenty of
      // headroom". Cap to the safe floor (currentInitialSize) rather than
      // falling back to a stale/guessed figure.
      await this.addLog(`[LADDER] margin-headroom cap: getTotalMarginBalance() failed (${err.message}) — capping to currentInitialSize (fail-closed).`);
      const floor = this.currentInitialSize || 0;
      this._lastLadderSize = floor;
      return floor;
    }
    const sized = this._applyMarginHeadroomCap(proposed, walletBalance);
    this._lastLadderSize = sized;
    return sized;
  }

  /**
   * Fill one ladder leg — a market order that ADDS to the net one-way position.
   *
   * In one-way mode the legs are not separate positions: Binance nets them.
   * `leg` is bookkeeping for which level has filled; `activePosition` is the
   * real thing. Books from the ACTUAL user-data WS fill, never the requested qty.
   */
  async _fillLeg(leg) {
    const notional = this._legNotional();
    const qty = await this._quantityFor(this.symbol, notional, leg.price);
    const side = leg.direction === 'LONG' ? 'BUY' : 'SELL';

    const res = await this.placeMarketOrder(this.symbol, side, qty); // one-way: no positionSide
    const fill = await this._resolveFill(res?.orderId, res, qty, leg.price);

    leg.state = 'POSITION_OPEN';
    leg.quantity = fill.filledQty;
    leg.fillPrice = fill.fillPrice;

    await this.addLog(
      `${leg.direction} ${leg.direction === 'LONG' ? 'L' : 'S'}${leg.index} filled: ` +
      `${fill.filledQty} @ ${this._formatPrice(fill.fillPrice)} (${this._formatNotional(notional)} USDT)`,
    );
    await this._refreshCurrentPosition(true);
    await this._postExecuteBookkeeping('LADDER_FILL', { direction: leg.direction, index: leg.index });
  }

  /**
   * Rule 2 — the reversal. Close the whole netted position, reset the abandoned
   * side's ledger, and hand control back so the caller can fill the new side ON
   * THE SAME TICK. Unlike the deleted anchor flatten there is no two-tick rule
   * here: the position is genuinely reversing, not oscillating around a centre.
   *
   * Returns false when the caller must fill NOTHING.
   *
   * TOMBSTONE — an unverified close MUST abort before the leg reset below. Those
   * POSITION_OPEN markings are the ONLY record of what this bot has open
   * (`_closeQuantity` sizes every close from them). Resetting them after a close
   * we could not verify ORPHANS a live position: it stays open on Binance while
   * the books read flat and nothing ever tries to close it again. Do NOT
   * rethrow — `handleRealtimePrice` awaits this without a catch, so a throw would escape
   * the WS tick handler.
   */
  async _reverseTo(newSide) {
    const abandoned = newSide === 'LONG' ? 'SHORT' : 'LONG';

    let closed = false;
    try { closed = await this._closeConsolidated('reversal'); }
    catch (e) { await this.addLog(`ERROR reversal close: ${e.message}`); }

    if (!closed && this._closeQuantity() > 0) {
      await this.addLog(
        `WARNING: REVERSAL to ${newSide} aborted — the close could not be verified; the ladder was left ` +
        `INTACT so the open position stays tracked. It will retry on the next tick.`,
      );
      await this.saveState();
      this._pushHeartbeatNow?.();
      return false;
    }

    for (const leg of this.ladderLines) {
      if (leg.direction !== abandoned) continue;
      leg.state = 'EMPTY';
      leg.quantity = null;
      leg.fillPrice = null;
    }

    const prevBase = this._ladderBaseSize;
    this.cycleAccumulatedLoss = this._computeAccLoss();
    this._ladderBaseSize = await this._computeLadderBaseSize();

    // Back to SCALING even if we came out of TREND (§6 Rule 2). Nulling
    // finalTpPrice IS the disarm — `_trendFinalTpArmed` derives from it.
    this.ladderMode = 'SCALING';
    this.trendDirection = null;
    this.finalTpPrice = null;
    // Carry-forward 2 — `trailExitLevel` is pure and has no memory of which
    // side a `previous` came from, so a LONG-side value left standing would
    // ratchet a later SHORT trail the wrong way.
    this.trendStartPrice = null;
    this._clearTrail();
    this.reversalCount = (this.reversalCount || 0) + 1;

    await this.addLog(
      `===== REVERSAL #${this.reversalCount} ${abandoned} → ${newSide} @ ` +
      `${this._formatPrice(this.currentPrice)} ===== ` +
      `accLoss ${this._formatNotional(this.cycleAccumulatedLoss)} USDT | ` +
      `base ${this._formatNotional(prevBase)} → ${this._formatNotional(this._ladderBaseSize)} USDT | ` +
      `leg ${this._formatNotional(this._legNotional())} USDT`,
    );
    await this._writeStrategyFlow('REVERSAL', {
      from: abandoned, to: newSide, bullLevel: this.bullLevel, bearLevel: this.bearLevel,
      accLoss: this.cycleAccumulatedLoss, baseSize: this._ladderBaseSize, reversalCount: this.reversalCount,
    }).catch(() => {});
    await this.saveState();
    this._pushHeartbeatNow?.();
    return true;
  }

  /**
   * Which side currently holds inventory, DERIVED from the leg ledger.
   *
   * Never stored. The legs are the WS-true record (`_fillLeg` books
   * `leg.quantity` from the actual user-data fill), so this needs no network
   * call and cannot go stale behind a failed REST refresh — unlike
   * `currentSide`, which `_refreshCurrentPosition` leaves null on exactly the
   * ticks it matters. Rule 2 resets the abandoned side to EMPTY before the new
   * side fills, so at most one direction is ever open.
   */
  get heldSide() {
    return this.ladderLines.find((l) => l.state === 'POSITION_OPEN')?.direction ?? null;
  }

  /**
   * "Is TREND's Final TP armed?" — DERIVED, never stored.
   *
   * The invariant this encodes has always been: *not armed MUST mean
   * `finalTpPrice` is null* — never silently keep a stale guess. It used to
   * be a plain boolean field set alongside `finalTpPrice`, i.e. a SHADOW of
   * a value that is itself already state. Two copies of one fact drift, and
   * every drift here fails OPEN, because the TREND exit gate
   * (`if (this.finalTpPrice && ...)`) trusts ANY non-null value and never
   * consults this flag:
   *
   *   - The field was never persisted by `saveState` while `finalTpPrice`
   *     IS persisted and restored, so every TREND resume booted with
   *     armed=false + a non-null restored target and raised a FALSE
   *     "still unarmed" alarm.
   *   - `_pollFundingIncome` (8-hourly), `adjustProfitTarget` (the user's
   *     profit pencil) and `resume` all call `_recomputeFinalTpPrice()`
   *     without touching the flag, so they could resurrect the exact
   *     unverified target `_enterTrend` had deliberately refused — with
   *     armed still false — and the exit gate would fire on it.
   *
   * Deriving it makes those states unrepresentable rather than merely
   * unlikely: the arm IS the non-null value. `_recomputeFinalTpPrice` is the
   * single writer and refuses to derive from unverified data, so
   * "armed" reduces to "TREND holds a target derived from a Binance-verified
   * position". Nothing to persist, nothing to restore, nothing to desync.
   *
   * TOMBSTONE — do NOT turn this back into an assignable field "for
   * clarity". The setter below deliberately THROWS: in this codebase a
   * silent fail-open is the dominant failure mode, so an assignment must
   * fail loudly at the offending line rather than quietly desync the exit
   * gate. Disarm by nulling `finalTpPrice`; arm by recomputing it.
   */
  get _trendFinalTpArmed() {
    return this.ladderMode === 'TREND' && this.finalTpPrice != null;
  }

  set _trendFinalTpArmed(_v) {
    throw new Error(
      '_trendFinalTpArmed is derived from (ladderMode === TREND && finalTpPrice != null) and cannot be assigned. ' +
      'To disarm, set finalTpPrice = null. To arm, call _recomputeFinalTpPrice() against a verified position.',
    );
  }

  /**
   * Fully scaled -> TREND. Passive from here: the position is KEPT EXACTLY AS-IS.
   *
   * Deliberately does NOT flatten and re-open (which is what the old
   * _triggerTrend did): the ladder has already built a favourable average entry
   * — the innermost rungs (near the trigger level) filled first, so the average
   * sits closer to the trigger than the outermost rung price is — and
   * re-opening would discard it and pay fees for the privilege.
   */
  async _enterTrend(direction) {
    this.ladderMode = 'TREND';
    this.trendDirection = direction;
    this.trendStartPrice = this.currentPrice;
    // Disarm before arming: `_trendFinalTpArmed` derives from finalTpPrice, so
    // nulling it here means a failed arm below cannot leave the pre-TREND
    // value standing (that value was derived off the not-yet-reconciled
    // position and is exactly the "stale guess" the invariant forbids).
    this.finalTpPrice = null;
    await this._refreshCurrentPosition(true);
    if (this._lastPositionRefreshFailed) {
      // One retry before giving up: a single 503 right at the TREND
      // transition must not bake a wrong exit price for the whole cycle —
      // Final TP is armed HERE AND ONLY HERE; in TREND no further leg fills
      // occur, so `_postExecuteBookkeeping` never runs again to correct it,
      // and the funding-poll recompute just re-derives from the same stale
      // `activePosition`.
      await this._refreshCurrentPosition(true);
    }
    if (this._lastPositionRefreshFailed) {
      // finalTpPrice is already null (disarmed above) and MUST stay that way:
      // the TREND exit check (`if (this.finalTpPrice && ...)`) trusts any
      // non-null value, so "not armed" must mean null, not "silently keep the
      // last stale guess". Nothing is recomputed on this branch — and even if
      // it were, `_recomputeFinalTpPrice` refuses to derive from a position
      // whose refresh just failed.
      await this.addLog(
        `[LADDER] WARNING: _enterTrend: Binance position refresh failed (twice) while arming TREND ${direction} ` +
        `for ${this.symbol} — Final TP NOT armed from unverified data. Position remains fully exposed with NO ` +
        `exit target until _reconcileTrendInvariant self-heals it on a later tick/resume.`
      );
    } else {
      // Armed HERE and only here on the happy path — SCALING never checks it.
      // The arm is the write itself: if the recompute cannot resolve a target
      // (flat / unresolved side), finalTpPrice stays null and
      // `_trendFinalTpArmed` stays false, so `_reconcileTrendInvariant`
      // retries on the next tick rather than the cycle believing it is armed.
      this._recomputeFinalTpPrice();
    }

    // Arm the trailing exit (§7) at the moment TREND arms — it measures from
    // `trendStartPrice`, just set above. See `_armTrail`'s own doc for why the
    // distance is fixed here and never recomputed.
    this._armTrail();

    const avg = averageOpenEntry(this.ladderLines, direction);
    await this.addLog(
      `===== TREND ${direction} (fully scaled @ ${this._formatPrice(this.currentPrice)}) ===== ` +
      `avg entry ${this._formatPrice(avg)} | Final TP ${this.finalTpPrice != null ? this._formatPrice(this.finalTpPrice) : 'UNARMED — see WARNING above'}`,
    );

    // A manually-raised profit target is a CYCLE-level goal: it survives every
    // reversal, including one that flips the cycle to the opposite side.
    // That is deliberate, but it is invisible — the level the user originally
    // picked is long gone (the reversal nulls finalTpPrice), while the profit it
    // implied silently keeps setting every subsequent target, on top of an
    // accumulated loss that the reversal just grew. Say so at the moment it takes
    // effect, so a distant target is explained rather than discovered.
    const floorUSDT = this.minDesiredProfitUSDT || 0;
    if ((this.desiredProfitUSDT || 0) > floorUSDT + 1e-9) {
      await this.addLog(
        `[LADDER] carrying the manual profit target ${this._formatNotional(this.desiredProfitUSDT)} USDT ` +
        `into this TREND (config target ${this._formatNotional(floorUSDT)} USDT) — ` +
        `Final TP sits further out as a result. Reset it from Position Control to return to config.`,
      );
    }
    await this._writeStrategyFlow('TREND_ENTER', {
      direction, avgEntry: avg, finalTpPrice: this.finalTpPrice, armed: this._trendFinalTpArmed,
    }).catch(() => {});
    await this.saveState();
    // Mode just flipped SCALING -> TREND with no leg fill on this tick, so nothing
    // else pushes a heartbeat; broadcast now or the Levels & Targets panel +
    // chart wait for the next heartbeat (a later fill or the 30s safety net).
    this._pushHeartbeatNow?.();
  }

  /**
   * Arm the trail at the moment TREND arms. The distance is fixed here and
   * never recomputed, which is what makes the exit start exactly at the
   * opposite level and move 1:1 with price — no tuning knob, self-scaling
   * across symbols.
   *
   * A no-op when trailing is off, so `trailExit` stays null and every hit
   * check below is dead. Safe to call twice.
   */
  _armTrail() {
    if (!this.trailEnabled || this.ladderMode !== 'TREND') {
      this.trailDistanceValue = null;
      this.trailExit = null;
      return;
    }
    const side = this.trendDirection;
    const d = trailDistance(this.trendStartPrice, side, this.bullLevel, this.bearLevel);
    if (d == null || !(d > 0)) {
      // An unusable distance must leave the trail DISARMED, never guessed. A
      // trail derived from a bad start price would sit at an arbitrary level
      // and close a healthy position.
      this.trailDistanceValue = null;
      this.trailExit = null;
      return;
    }
    this.trailDistanceValue = d;
    this.trailExit = trailExitLevel({
      price: this.trendStartPrice, distance: d, side,
      bullLevel: this.bullLevel, bearLevel: this.bearLevel, previous: null,
    });
  }

  /** Clear the trail. Called on every reversal, trailed exit and level rebuild. */
  _clearTrail() {
    this.trailDistanceValue = null;
    this.trailExit = null;
  }

  /**
   * Ratchet the exit level toward the entry level. Returns true when price has
   * reached it AND the trail has actually moved off the opposite level.
   *
   * The strict inequality is the §7 collision rule: while `trailExit` still
   * equals the opposite level, a hit there is a REVERSAL (Rule 2), not a
   * trailed exit. Only once the ratchet has carried it past that level does the
   * trail own the close.
   */
  _updateTrailAndCheckHit(price) {
    if (!this.trailEnabled || this.ladderMode !== 'TREND') return false;
    if (this.trailDistanceValue == null) return false;
    const side = this.trendDirection;
    const next = trailExitLevel({
      price, distance: this.trailDistanceValue, side,
      bullLevel: this.bullLevel, bearLevel: this.bearLevel, previous: this.trailExit,
    });
    if (next == null) return false;
    this.trailExit = next;
    if (side === 'LONG')  return next > this.bearLevel && price <= next;
    if (side === 'SHORT') return next < this.bullLevel && price >= next;
    return false;
  }

  /**
   * §7 — the trailed exit. Close, reset BOTH ladders, return to SCALING flat,
   * and fill NOTHING on this tick.
   *
   * The two-tick rule DOES apply here (unlike a reversal): the trail caps at the
   * entry level, so closing there would leave price sitting on L1/S1 and the
   * same tick would immediately refill the position just closed.
   *
   * Returns false when the caller must not advance `lastProcessedPrice`.
   */
  async _trailedExit() {
    let closed = false;
    try { closed = await this._closeConsolidated('trailed_exit'); }
    catch (e) { await this.addLog(`ERROR trailed-exit close: ${e.message}`); }

    if (!closed && this._closeQuantity() > 0) {
      await this.addLog(
        `WARNING: TRAILED EXIT aborted — the close could not be verified; the ladder was left INTACT ` +
        `so the open position stays tracked. It will retry on the next tick.`,
      );
      await this.saveState();
      this._pushHeartbeatNow?.();
      return false;
    }

    const exitAt = this.trailExit;
    for (const leg of this.ladderLines) {
      leg.state = 'EMPTY';
      leg.quantity = null;
      leg.fillPrice = null;
    }
    this.ladderMode = 'SCALING';
    this.trendDirection = null;
    this.trendStartPrice = null;
    this.finalTpPrice = null;
    this._clearTrail();
    this.cycleAccumulatedLoss = this._computeAccLoss();
    this._ladderBaseSize = await this._computeLadderBaseSize();

    await this.addLog(
      `===== TRAILED EXIT @ ${this._formatPrice(exitAt)} ===== levels UNCHANGED ` +
      `(bull ${this._formatPrice(this.bullLevel)} / bear ${this._formatPrice(this.bearLevel)}) | ` +
      `accLoss ${this._formatNotional(this.cycleAccumulatedLoss)} USDT | ` +
      `leg ${this._formatNotional(this._legNotional())} USDT`,
    );
    await this._writeStrategyFlow('TRAILED_EXIT', {
      exitLevel: exitAt, bullLevel: this.bullLevel, bearLevel: this.bearLevel,
      accLoss: this.cycleAccumulatedLoss,
    }).catch(() => {});
    await this.saveState();
    this._pushHeartbeatNow?.();
    return true;
  }

  /**
   * Turn the trailing exit on or off. Accepted at any time while running: it is
   * a state change, not an action. Switching it on mid-TREND arms it now;
   * switching it off clears the ratchet so a later re-arm starts fresh rather
   * than inheriting a stale level from a different position.
   *
   * STRICT, not coercing — only real booleans. Error shapes match `harvestNow`
   * so the route can map them: bad input sets `.invalidInput = true` (→ 400);
   * `!isRunning` is untagged (→ 409).
   */
  async setTrailEnabled(enabled) {
    if (!this.isRunning) throw new Error('Strategy is not running.');
    if (typeof enabled !== 'boolean') {
      const e = new Error('Trailing must be true or false.');
      e.invalidInput = true;
      throw e;
    }
    this.trailEnabled = enabled;
    if (enabled) this._armTrail(); else this._clearTrail();
    await this.saveState();
    this._pushHeartbeatNow?.();
    await this.addLog(
      `[REVERSAL] trailing exit ${enabled ? 'ON' : 'OFF'}` +
      (enabled && this.trailExit != null ? ` — exit at ${this._formatPrice(this.trailExit)}` : ''),
    );
    return { trailEnabled: this.trailEnabled, trailExit: this.trailExit };
  }

  /**
   * Restore the trail from a snapshot. Its own method because it holds an
   * invariant worth testing, and `resume()` cannot be exercised in a unit test.
   *
   * Carry-forward 1: never TRUST the persisted exit — re-clamp it into the
   * RESTORED band. The levels can have moved since it was written (a manual edit
   * or an applied Ask AI proposal narrows the band), and a stale value outside
   * that band would win the ratchet's Math.max/Math.min forever, silently
   * defeating the cap whose only job is keeping the exit out of the ladder.
   *
   * `trailEnabled` restores from an EXPLICIT `=== true` only: a missing or
   * malformed field is unknown, and unknown must never read as armed.
   */
  _restoreTrailFromSnapshot(snapshot = {}) {
    this.trailEnabled = snapshot.trailEnabled === true;
    this.trendStartPrice = Number.isFinite(snapshot.trendStartPrice) ? snapshot.trendStartPrice : null;
    this.trailDistanceValue = Number.isFinite(snapshot.trailDistanceValue) ? snapshot.trailDistanceValue : null;
    const exit = snapshot.trailExit;
    this.trailExit = (Number.isFinite(exit)
      && Number.isFinite(this.bullLevel) && Number.isFinite(this.bearLevel))
      ? Math.min(this.bullLevel, Math.max(this.bearLevel, exit))
      : null;
  }

  /**
   * Derive the SCALING→TREND invariant instead of chasing the fill event.
   *
   * `handleRealtimePrice`'s normal path already calls `_enterTrend` the
   * instant the outermost leg fills — but `_fillLeg` persists that leg's
   * POSITION_OPEN state (via `_postExecuteBookkeeping` -> `saveState`)
   * BEFORE that call runs. A process death in that ~0.5-2s window (a PM2
   * restart or VM redeploy, both routine here) persists "SCALING + fully
   * scaled" with no way back: `resume()` only re-arms Final TP when the
   * snapshot already says TREND, and every leg being open means the tick
   * loop's `plan.fills` is empty forever, so the event that drives
   * `_enterTrend` can never fire again. The ladder then sits fully exposed
   * with NO exit target — the position stays open until price eventually
   * reverses all the way through the dead zone and crosses the OTHER level,
   * forcing a reversal instead of the clean Final TP exit it should have had.
   *
   * Called from `resume()` and from the top of every tick (before the
   * TREND/SCALING dispatch) so the invariant self-heals on the very next
   * opportunity regardless of when the crash happened. Idempotent: a no-op
   * once `ladderMode` is already 'TREND'.
   */
  async _reconcileTrendInvariant() {
    if (this.ladderMode === 'SCALING') {
      const outermost = this.ladderLines.find(
        (l) => l.index === this.levelsPerSide && l.state === 'POSITION_OPEN',
      );
      if (!outermost) return false;
      await this.addLog(
        `[LADDER] SCALING→TREND invariant reconcile: outermost ${outermost.direction} leg already ` +
        `POSITION_OPEN with ladderMode still SCALING — arming TREND now (resume or a missed tick).`,
      );
      await this._enterTrend(outermost.direction);
      return true;
    }

    // Self-heal for Fix B: `_enterTrend` already ran (ladderMode is TREND)
    // but its arming refresh failed (twice) and left Final TP unarmed. No
    // further leg fills happen in TREND, so nothing else will ever retry
    // this — this reconcile runs on every tick and on resume, so it keeps
    // retrying until Binance answers rather than leaving the cycle stuck
    // fully exposed with no exit target for the rest of the cycle.
    if (this.ladderMode === 'TREND' && !this._trendFinalTpArmed) {
      // Backoff. This runs from `handleRealtimePrice` — every price tick,
      // several per second — and each attempt costs a Binance REST round trip
      // plus a Firestore log write. Previously the bug below capped the retry
      // at exactly one attempt by accident (it marked itself armed and never
      // came back); now that the retry actually persists until it succeeds, it
      // needs a real rate limit rather than that accidental one.
      const now = Date.now();
      if (this._trendArmRetryLastTs != null
          && (now - this._trendArmRetryLastTs) < TREND_ARM_RETRY_INTERVAL_MS) {
        return false;
      }
      this._trendArmRetryLastTs = now;

      await this.addLog(
        `[LADDER] TREND Final-TP invariant reconcile: TREND ${this.trendDirection} active for ${this.symbol} but ` +
        `Final TP is still unarmed — retrying position refresh.`
      );
      await this._refreshCurrentPosition(true);
      if (this._lastPositionRefreshFailed) {
        await this.addLog(
          `[LADDER] WARNING: TREND Final-TP invariant reconcile: refresh failed again for ${this.symbol} — ` +
          `Final TP still unarmed, will retry next tick.`
        );
        return false;
      }
      this._recomputeFinalTpPrice();

      // TOMBSTONE — do NOT collapse this back into an unconditional
      // `armed = true` / "armed at ..." log. This is a reconciler for an
      // invariant, and it used to mark the invariant ACHIEVED without ever
      // checking that it was: a successful refresh that resolves to FLAT (or
      // to an unresolvable side) derives NO target, so it logged the nonsense
      // "Final TP armed at N/A", reported success, and — back when the flag
      // was stored — short-circuited its own retry forever.
      //
      // Reachable, not theoretical: a process death inside `_reverseTo`
      // between `_closeConsolidated()` and `saveState()` — a window that
      // contains `_computeLadderBaseSize()` -> `getTotalMarginBalance()`, a
      // real 100-500ms round trip — persists TREND + every leg POSITION_OPEN
      // while Binance is already flat. The refresh then succeeds and honestly
      // answers "flat", and this branch called that an arm.
      //
      // A reconciler may only report the state it actually reached.
      if (!this._trendFinalTpArmed) {
        await this.addLog(
          `[LADDER] WARNING: TREND Final-TP invariant reconcile: refresh SUCCEEDED for ${this.symbol} but no Final TP ` +
          `could be derived (position ${this.activePosition && this.activePosition.quantity > 0
            ? `qty ${this.activePosition.quantity}, side ${this.currentSide || 'UNRESOLVED'}`
            : 'FLAT on Binance'}` +
          `) — TREND ${this.trendDirection} with no position to exit is a contradiction; Final TP stays unarmed and ` +
          `this will retry. Check whether a reversal died before it could persist.`
        );
        return false;
      }

      // Armed: clear the backoff so a LATER disarm retries immediately rather
      // than waiting out an interval left over from this recovery.
      this._trendArmRetryLastTs = null;
      await this.addLog(
        `[LADDER] TREND Final-TP invariant reconcile: Final TP armed at ${this._formatPrice(this.finalTpPrice)}.`
      );
      await this.saveState();
      return true;
    }

    return false;
  }

  /**
   * Manual harvest — flatten, clear both levels, re-plan a fresh bull/bear
   * pair, dynamic-size, redistribute. Unlike a reversal (which keeps the
   * un-abandoned side's ladder standing) a harvest closes AT a level, so
   * keeping the old pair would leave price sitting on top of a trigger and
   * refill it immediately — both ladders are cleared and re-planned from
   * scratch. accLoss is NOT reset (real carried loss); the gauge only empties
   * if realized PnL reduces cycleAccumulatedLoss on its own.
   *
   * Manual only. There is no automatic harvest.
   *
   * @returns {Promise<boolean>} `true` only when the close + re-plan completed
   *   (reached `_planAndBuildLevels`); `false` on the in-flight skip and on the
   *   tombstone abort. Callers that need a bounded retry on an aborted harvest
   *   must key it off this return — never infer the outcome from observed side
   *   effects.
   */
  async _harvestToFlat(reason) {
    if (this._tradingSeqInProgress) {
      await this.addLog(`Harvest (${reason}) skipped — a trading sequence is in progress; retry.`);
      return false;
    }
    this._tradingSeqInProgress = true;
    try {
      // Was a position actually open? Drives the label and which counter bumps.
      // `_closeQuantity()` here (pre-close) reads the WS-true leg ledger / activePosition;
      // 0 means a genuine flat re-anchor, > 0 means a real harvest.
      const hadInventory = this._closeQuantity() > 0;

      // Label the action by the sign of the position's unrealized PnL captured
      // BEFORE the close (activePosition is nulled by `_closeConsolidated`).
      // Same backend action either way; the label just distinguishes a
      // profit-banking HARVEST from a strategic loss-taking RE-ANCHOR. A flat
      // run is always RE-ANCHOR — there is no position whose PnL sign could
      // call it a harvest.
      const closingPnl = (this.activePosition && Number.isFinite(this.activePosition.unrealizedPnl))
        ? this.activePosition.unrealizedPnl : 0;
      const kind = !hadInventory ? 'RE-ANCHOR' : (closingPnl >= 0 ? 'HARVEST' : 'RE-ANCHOR');
      let detail = reason;
      await this.addLog(`===== ${kind} (${detail}) — flatten + re-plan levels =====`);

      // Self-gating and self-sizing (see `_closeQuantity`). This matters most
      // here of all the close paths: the harvest RE-ANCHORS, so anything left
      // behind would net against a geometry it was never part of.
      let closed = false;
      try { closed = await this._closeConsolidated('harvest'); }
      catch (e) { await this.addLog(`ERROR ${kind} close: ${e.message}`); }

      // TOMBSTONE — a failed close MUST abort the rebuild. The re-plan below
      // resets every leg to EMPTY, and those POSITION_OPEN markings are the
      // ONLY record of what this bot has open (`_closeQuantity` sizes every close
      // from them). Rebuilding after a failed close ORPHANS a live position: it
      // stays open on Binance while the bot's books read "flat, fresh ladder" and
      // nothing ever tries to close it again. Leave the ladder INTACT instead, so
      // the position stays tracked and the harvest can be retried. `_reverseTo`
      // and `_flattenGrid` now carry this same guard — no close path may wipe its
      // leg ledger on a close it could not verify. Do NOT rethrow here:
      // `handleRealtimePrice` awaits this without a catch, so a throw would escape
      // the WS tick handler.
      //
      // `closed === true` now means the close was VERIFIED — `_closeConsolidated`
      // tiers WS fill marker -> full REST-ack qty -> REST position check before
      // returning true, and returns `false` on anything unverified. That `false`
      // is exactly what this guard catches, so an unconfirmed fill can no longer
      // slip past it (shared contract with `_reverseTo`).
      //
      // Check POST-close inventory, not a pre-close snapshot: in the `!closed`
      // branch, `_closeConsolidated` never reaches its leg-clearing /
      // `activePosition`-nulling code (that only runs after a confirmed close),
      // so the ledger is untouched and `_closeQuantity()` still reads the true
      // open inventory here. This also correctly stops aborting when
      // `_closeConsolidated` internally refreshed and found the account
      // genuinely flat (returns `false` with nothing actually open) — a
      // pre-close snapshot would have aborted on that stale reading and
      // blocked the re-plan for no reason. (This check would NOT be valid
      // after a SUCCESSFUL close: legs stay POSITION_OPEN until the re-plan
      // rebuilds them below, so `_closeQuantity()` would still read positive
      // even though the close is fine — do not "simplify" this to run
      // unconditionally.)
      if (!closed && this._closeQuantity() > 0) {
        await this.addLog(
          `WARNING: ${kind} (${reason}) ABORTED — the close did not complete, so the ladder was left ` +
          `INTACT and the open position is still tracked. Retry the harvest, or close it manually on Binance.`,
        );
        await this.saveState();
        this._pushHeartbeatNow?.();
        return false;
      }

      // Only a VERIFIED position-close counts as a harvest. `closed` is true iff
      // `_closeConsolidated` actually closed something; `hadInventory` was only the
      // PRE-close belief, which can be a stale "open" that a mid-close refresh
      // proves flat (closed=false, nothing closed). Counting that as a harvest
      // would inflate harvestCount and wrongly mark the cycle as having traded
      // (see `_hasNoTradingActivity`). A flat re-anchor is never a harvest.
      if (closed) this.harvestCount = (this.harvestCount || 0) + 1;
      this.reanchorCount = (this.reanchorCount || 0) + 1;
      this.finalTpPrice = null;

      this.cycleAccumulatedLoss = this._computeAccLoss();
      this._ladderBaseSize = await this._computeLadderBaseSize();
      await this.addLog(
        `Post-${kind} base ${this._formatNotional(this._ladderBaseSize)} USDT → ` +
        `leg ${this._formatNotional(this._legNotional())} USDT (accLoss ${this._formatNotional(this.cycleAccumulatedLoss)}).`,
      );

      // Re-plan the levels: a harvest closes AT a level, so keeping the old pair
      // would leave price sitting on top of a trigger and refill it immediately.
      // A failed re-plan leaves the ladder EMPTY, which is safe — the tick gate
      // retries on the throttle and nothing trades meanwhile. Mode/trendDirection
      // are reset here too — `_buildLadders` is their only OTHER writer, and it
      // never runs on a failed re-plan, so a harvest out of TREND whose re-plan
      // fails would otherwise persist ladderMode:'TREND' over an empty ladder:
      // a flat account announcing TREND, which resume()'s _reconcileTrendInvariant
      // reads as the invariant needing a self-heal and burns a REST refresh + a
      // false-alarm log on the very next tick/restart.
      this.ladderLines = [];
      this.bullLevel = null;
      this.bearLevel = null;
      this.ladderMode = 'SCALING';
      this.trendDirection = null;
      await this._planAndBuildLevels(reason);

      // The audit label reflects what ACTUALLY happened (keyed off `closed`), not
      // the pre-close `kind` guess — so a stale-open-but-actually-flat run records
      // as a RE-ANCHOR here, consistent with the counter above. The opening log
      // above keeps the pre-close `kind` as a best-effort "attempting" label.
      const finalKind = closed ? kind : 'RE-ANCHOR';
      await this._writeStrategyFlow('HARVEST', {
        reason, kind: finalKind, closingPnl, flat: !closed, reanchorCount: this.reanchorCount,
        bullLevel: this.bullLevel, bearLevel: this.bearLevel, baseSize: this._ladderBaseSize,
      }).catch(() => {});
      await this.saveState();
      return true;
    } finally {
      this._tradingSeqInProgress = false;
    }
  }

  /**
   * Restore ladder geometry from a persisted snapshot.
   *
   * This MUST come from the snapshot, not the constants. A cycle started at 8
   * levels that resumed at 5 would rebuild a DIFFERENT ladder beneath its own
   * filled legs — orphaning inventory and confusing _reconcileTrendInvariant,
   * which derives TREND from "fully scaled". Snapshots written before geometry
   * was configurable carry neither field; those legitimately default.
   *
   * Validation is delegated to resolveLadderGeometry — the SAME single
   * definition of "valid geometry" that start() and the HTTP route use (see
   * its docstring in ladder-levels.js). Its `?? DEFAULT` fallback covers the
   * genuinely-absent (null/undefined) case, i.e. a legacy pre-geometry
   * snapshot. A field that is PRESENT but fails the bounds/type check (e.g.
   * corrupted Firestore data, a hand-edited doc, 0, NaN, a numeric string) is
   * NOT the same as absent — silently coercing it to the default would read
   * "unknown" as "safe" and rebuild a ladder that may not match whatever is
   * actually open on the exchange for this cycle. That is exactly the
   * silent-fail-open shape this codebase forbids (see CLAUDE.md), so this
   * throws instead: resume() has no surrounding try/catch around this call,
   * so the throw rejects the resume() promise, and app.js's
   * recoverActiveStrategies() already treats a rejected resume() as a hard
   * recovery failure — isRunning:false + criticalError persisted, strategy
   * NOT added to activeStrategies — rather than silently running with the
   * wrong ladder.
   */
  _applySnapshotGeometry(snapshot = {}) {
    const geometry = resolveLadderGeometry({
      ladderStepPct: snapshot.stepPct,
      ladderLevelsPerSide: snapshot.levelsPerSide,
    });
    if (!geometry.ok) {
      throw new Error(`ReversalLadderStrategy.resume: invalid persisted geometry — ${geometry.error}`);
    }
    this.stepPct = geometry.stepPct;
    this.levelsPerSide = geometry.levelsPerSide;
  }

  /**
   * Resume a strategy from a Firestore snapshot. Called by app.js boot-scan
   * (recoverActiveStrategies) when a `type: 'REVERSAL_LADDER'` doc has
   * `isRunning: true` but no in-memory instance exists (i.e. PM2 restart
   * / VM force-update).
   *
   * Critical contract (see audit C3+C4+C5):
   *   - Restore identifiers FIRST so addLog can write under the right strategyId
   *   - Validate C4 proxy URLs before doing anything else
   *   - Restore _lastFundingPollTs so the next funding poll uses correct baseline
   *   - Reissue listen-key request + refresh interval + WS health monitor
   *   - Schedule next funding poll
   *   - Reconcile current position from Binance (source of truth)
   */
  async resume(snapshot) {
    if (!snapshot) throw new Error('ReversalLadderStrategy.resume: missing snapshot');

    // Restore identifiers FIRST so addLog writes under the correct strategyId.
    this.strategyId = snapshot.strategyId;
    this.profileId = snapshot.profileId;
    this.userId = snapshot.userId;
    this.gcfProxyUrl = snapshot.gcfProxyUrl;
    this.sharedVmProxyGcfUrl = snapshot.sharedVmProxyGcfUrl;
    this.initFirestoreCollections(this.strategyId);

    // C4 proxy URL validation. Without these the strategy cannot reach
    // Binance; abort cleanly and mark the doc with a recoverable error.
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

    await this.addLog(`[RECOVERY] Resuming Reversal Ladder Strategy after restart...`);

    // Restore config
    this.symbol = snapshot.symbol;
    this.leverage = snapshot.leverage || DEFAULT_LEVERAGE;
    this.priceType = snapshot.priceType || 'MARK';
    this.recoveryFactor = snapshot.config?.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = snapshot.config?.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = snapshot.config?.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = snapshot.config?.desiredProfitUSDT || 0;
    this.minDesiredProfitUSDT = snapshot.minDesiredProfitUSDT ?? this.desiredProfitUSDT;
    this.currentInitialSize = snapshot.currentInitialSize || snapshot.config?.initialSize || 0;

    // ---- ladder state ----
    this.ladderMode = snapshot.ladderMode || 'SCALING';
    this.bullLevel = snapshot.bullLevel ?? null;
    this.bearLevel = snapshot.bearLevel ?? null;
    // Trailing exit (§7) — restored AFTER bullLevel/bearLevel: the restore
    // re-clamps the persisted exit into the just-restored band (carry-forward 1).
    this._restoreTrailFromSnapshot(snapshot);
    this.ladderLines = Array.isArray(snapshot.ladderLines) ? snapshot.ladderLines : [];
    this.trendDirection = snapshot.trendDirection ?? null;
    this.lastProcessedPrice = snapshot.lastProcessedPrice ?? null;
    this._ladderBaseSize = snapshot.ladderBaseSize || this.currentInitialSize; // grown ladder base survives restarts (else ladder shrinks to initial)
    this._lastLadderSize = snapshot._lastLadderSize ?? null;
    this._applySnapshotGeometry(snapshot);

    // Restore cycle state
    this.currentSide = snapshot.currentSide || null;
    this.activePosition = snapshot.currentPosition || null;
    this.finalTpPrice = snapshot.finalTpPrice || null;
    this.harvestTriggerPrice = snapshot.harvestTriggerPrice ?? null;
    this.harvestTriggerAbove = snapshot.harvestTriggerAbove ?? null;
    this.harvestTriggerAction = snapshot.harvestTriggerAction === 'stop' ? 'stop' : 'reanchor';
    this.cycleAccumulatedLoss = snapshot.cycleAccumulatedLoss || 0;
    this.reversalCount = snapshot.reversalCount || 0;
    this.harvestCount = snapshot.harvestCount || 0;
    this.reanchorCount = snapshot.reanchorCount || 0;
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
    this.aiCostUSD = snapshot.aiCostUSD || 0;
    this.aiModel = snapshot.aiModel || this.aiModel;

    // The API key is deliberately NOT persisted, so a resumed cycle has no
    // planner: any level re-plan after a restart (a harvest, a fired reanchor
    // trigger) uses the mechanical void edges. Say so rather than letting the
    // source silently change under the user. Phase 0 closes this by fetching
    // the key from Secret Manager here.
    await this.addLog(
      `[RECOVERY] AI level planning is unavailable after a restart (the key is not persisted) — ` +
      `any re-plan this cycle will use the mechanical volume-void edges.`,
    );

    // Funding poll high-water mark. Fall back to strategyStartTime for
    // pre-v3.4.0 snapshots that didn't persist this field.
    this._lastFundingPollTs = snapshot._lastFundingPollTs || this.cycleStartTime;

    // L3-reconcile watermark — restore so the post-resume L3 sweep starts
    // FROM the latest fill already in the accumulators, not from cycle
    // start. Pre-v3.7.0 snapshots leave this null; the strategyStartTime
    // fallback inside _reconcileRecentTrades absorbs that one final
    // double-count, after which saveState persists the field going forward.
    this._lastReconciliationAt = snapshot._lastReconciliationAt || null;

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // One-way (single-side) mode — mirrors start(). The ladder holds LONG
      // legs ONLY above bullLevel and SHORT legs ONLY below bearLevel, and Rule
      // 2 keeps only one side open at once; hedge mode is unnecessary. Wrap in
      // try/catch because Binance refuses the call while positions are open
      // (harmless: an open position means the mode is already whatever it is).
      // Critically it must NOT be setPositionMode(true) — on a restart while
      // flat that would silently flip the account to hedge mode and break
      // every subsequent one-way order.
      try {
        await this.setPositionMode(false);
      } catch (err) {
        await this.addLog(`[RECOVERY] setPositionMode(false) note: ${err.message} (continuing — likely already one-way, or open positions block the switch).`);
      }
      await this._getExchangeInfo(this.symbol);
    } catch (error) {
      await this.addLog(`[RECOVERY] ERROR setup: ${error.message}`);
      throw error;
    }

    const minNotional = this.exchangeInfoCache[this.symbol]?.minNotional || 5;
    this.minNotional = minNotional;

    this.volumeProfile = new VolumeProfile(this);
    this.marketMetrics = new MarketMetrics(this);

    this.isRunning = true;

    // WS lifecycle — listen-key request FIRST (avoids stale-key races),
    // then user-data stream, then realtime price feed, then refresh
    // interval + health monitor. No liquidation WS: the ladder's geometry
    // and sizing math never read liquidation data.
    await this._retryListenKeyRequest(false);
    this.connectUserDataStream();
    this.connectRealtimeWebSocket();

    this.listenKeyRefreshInterval = setInterval(() => {
      this._scheduledListenKeyRefresh();
    }, 30 * 60 * 1000);

    this._startWebSocketHealthMonitoring();

    // Background volume snapshot refresh. _scheduleVolumeRefresh() fires one
    // immediate refresh itself, so the primitives (VP/CVD/orderbook/ATR) and
    // the Volume Analytics panel populate within seconds of resume rather than
    // sitting blank until the first 5-minute interval.
    this._scheduleVolumeRefresh();

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
      console.error(`[LADDER] L3 reconcile on resume failed: ${err.message}`);
    });

    // Reconcile position from Binance (source of truth).
    //
    // ⚠️ Do NOT reinstate a bare `await this.detectCurrentPosition(true)` here.
    // It used to sit on this line and was a CRITICAL bug: detectCurrentPosition()
    // THROWS on an API error (so that "flat" and "unknown" stop being the same
    // value), and an unguarded throw escapes resume() into app.js's recovery
    // .catch(), which sets isRunning:false. Boot recovery queries
    // where('isRunning','==',true) — so ONE transient 503 during a redeploy
    // permanently abandoned a live position: still open on Binance, no ladder,
    // no Final TP, and no stop-loss by design. Never retried, because the doc
    // had already been marked stopped.
    //
    // _refreshCurrentPosition() makes the identical detectCurrentPosition(true)
    // call inside a try that sets _lastPositionRefreshFailed, which every
    // consequential reader consults and which _reconcileTrendInvariant retries
    // on each tick. The bare call was pure redundancy that defeated exactly the
    // machinery built for this case.
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

    // Mode-aware resume: SCALING re-derives the TREND invariant here (not just
    // on the next tick) so a process death between `_fillLeg(L5)` persisting
    // and `_enterTrend` running can never strand the cycle in SCALING fully-
    // scaled with no exit target — see `_reconcileTrendInvariant`. TREND
    // (already armed on the snapshot) re-arms Final TP from the restored
    // consolidated position.
    const reconciledToTrend = await this._reconcileTrendInvariant();
    if (!reconciledToTrend && this.ladderMode === 'TREND' && this.activePosition && this.currentSide) {
      this._recomputeFinalTpPrice();
      await this.addLog(`Resumed in TREND ${this.currentSide}; Final TP ${this.finalTpPrice ? this._formatPrice(this.finalTpPrice) : 'n/a'}.`);
    }

    // A TREND that resumed with trailing on but no usable distance must re-arm
    // rather than run untrailed — the user armed it to bound this position.
    if (this.trailEnabled && this.ladderMode === 'TREND' && this.trailDistanceValue == null) {
      this._armTrail();
    }
  }

  /**
   * Single termination path — used for BOTH manual stop and Final TP
   * auto-stop (v4.0.1 consolidation). "One method to rule them all":
   * position close (when
   * requested), final funding flush, WS cleanup, platform fee
   * deduction, completion notification, saveState, and
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

    // Concurrency + idempotency guard. stop() is reachable from both the
    // /reversal-ladder/stop route AND the tick loop's Final TP check in
    // handleRealtimePrice; both could fire in quick succession. The
    // `!isRunning` check catches the concurrent
    // race (first call sets isRunning=false synchronously before any
    // await, so the second microtask-queued call bails). The
    // TERMINATED check catches a stop attempt AFTER a previous stop
    // already completed (the `if (!this.isRunning) return;` guard).
    if (!this.isRunning || this.executionState === 'TERMINATED') return;

    this.isRunning = false;

    // Cancel ALL background timers. Each was started in start()/resume()
    // and would leak across a restart if missed here.
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
      // Flatten the net one-way position. `_flattenGrid` / `_closeConsolidated`
      // place ONE reduceOnly market order — one-way mode nets every filled leg
      // into a single `activePosition`; there is no per-leg close. `_enterTrend`
      // never touches leg state, so legs stay marked POSITION_OPEN straight
      // through a TREND transition — branch 1 below fires whenever anything is
      // open, TREND included, and usually wins.
      //
      // Source-of-truth refresh FIRST, before any branch decides what (if
      // anything) is open. In-memory `activePosition` can be null while
      // Binance still holds a position (a transient API error makes
      // `getCurrentPositions()` return [] indistinguishable from flat, a
      // missed WS update, a partial restart) — nothing below may conclude
      // "there is nothing to close" from memory alone.
      try {
        await this._refreshCurrentPosition();
      } catch (err) {
        await this.addLog(`[LADDER] stop: pre-flatten position refresh failed: ${err.message}`);
      }

      // closedSomething reflects an ACTUAL close, never a leg marking —
      // `_flattenGrid` now returns whether it closed a real position (see its
      // own doc). It only gates which fallback branch attempts a close; the
      // residual verification below ALWAYS runs afterwards regardless of
      // its value.
      let closedSomething = false;
      if (this.ladderLines.some(l => l.state === 'POSITION_OPEN')) {
        try {
          closedSomething = await this._flattenGrid();
        } catch (err) {
          await this.addLog(`[LADDER] stop: grid flatten failed: ${err.message}`);
        }
      }
      // Fallback for a position with no ladder leg left marked POSITION_OPEN
      // (a TREND-consolidated position, or branch 1's close throwing before
      // `_flattenGrid` resets leg state). One branch, not two: since
      // `_closeConsolidated` self-gates and self-sizes there is nothing for a
      // TREND-specific variant to decide differently.
      if (!closedSomething) {
        const closeReason = reason === 'final_tp' ? 'final_tp' : 'user-stop';
        try {
          closedSomething = await this._closeConsolidated(closeReason);
        } catch (err) {
          await this.addLog(`[LADDER] stop: flatten failed: ${err.message}`);
        }
      }
      // Only claim "nothing to flatten" when Binance actually ANSWERED and
      // there is genuinely nothing to close. Saying it while the state is
      // unknown, or while a close attempt just threw over a live quantity,
      // reads as false reassurance.
      if (!closedSomething && !this._lastPositionRefreshFailed && !this._closeQuantity()) {
        await this.addLog('[LADDER] stop: no open position on Binance — nothing to flatten');
      }

      // Residual verification — ALWAYS runs, regardless of which branch (if
      // any) closed something above: a close call can throw, partially
      // fill, or race a fill event, so Binance is the only source of truth
      // for whether the position is actually flat. Never terminate silently
      // with a position still open.
      try {
        await this._refreshCurrentPosition();
      } catch (err) {
        await this.addLog(`[LADDER] stop: post-flatten position refresh failed: ${err.message}`);
      }
      // TOMBSTONE — the flag check MUST come first. This block used to lead
      // with `activePosition` and then `else if (closedSomething) ->
      // "confirmed flat"`, so a stop whose refresh never succeeded reported
      // "position confirmed flat" purely because a close had been ATTEMPTED:
      // `_closeConsolidated` nulls `activePosition` unconditionally, the
      // refresh above then fails and leaves it null, and null was read as
      // flat. The FINAL-STATE-UNKNOWN arm below was unreachable in exactly
      // the case it existed for, because it sat last AND keyed on legs that
      // `_flattenGrid` had already wiped. The user must NEVER be told
      // "confirmed flat" when the position state is unknown — an unverified
      // stop is the last moment anyone is watching.
      if (this._lastPositionRefreshFailed) {
        // Never terminate silently: state is still UNKNOWN after the
        // post-flatten refresh. Report whatever bookkeeping survives —
        // deliberately-untouched legs and/or the last-known position — as
        // the loudest signal we can give before the strategy terminates.
        const openLegs = this.ladderLines.filter(l => l.state === 'POSITION_OPEN');
        const legQty = openLegs.reduce((sum, l) => sum + (l.quantity || 0), 0);
        const lastKnown = this.activePosition && this.activePosition.quantity > 0
          ? `last-known position ${this.currentSide} ${this.activePosition.quantity}`
          : 'no position in memory (which is NOT proof of flat — the refresh failed)';
        await this.addLog(
          `[LADDER] WARNING: stop: FINAL STATE UNKNOWN for ${this.symbol} — Binance could not be reached to confirm ` +
          `flat${closedSomething ? ' after a close was attempted' : ''}. ${openLegs.length} ladder leg(s) (qty ` +
          `${legQty}) remain marked open; ${lastKnown}. Verify manually on Binance.`
        );
      } else if (this.activePosition && this.activePosition.quantity > 0) {
        await this.addLog(`[LADDER] WARNING: stop+flatten left residual ${this.currentSide} ${this.activePosition.quantity} ${this.symbol} on Binance — close it manually`);
      } else if (closedSomething) {
        await this.addLog('[LADDER] stop: position confirmed flat');
      }

      // Final TP: write the strategyFlow audit record + metricsSample so
      // the frontend chart can mark the exit. Manual stops skip this to
      // avoid changing existing audit-log cadence.
      if (reason === 'final_tp') {
        try {
          await this._postExecuteBookkeeping('FINAL_TP_HIT', { exitPrice });
        } catch (bkErr) {
          console.error(`[LADDER] FINAL_TP_HIT bookkeeping failed: ${bkErr.message}`);
        }
      }
    }

    // Clear position-derived state. Done after the optional flatten so
    // `_refreshCurrentPosition` had real fields to work against.
    this.activePosition = null;
    this.currentSide = null;

    // Any armed trigger dies with the cycle (Final TP or manual Stop): a
    // terminated strategy must never keep reporting an armed feature.
    this.harvestTriggerPrice = null;
    this.harvestTriggerAbove = null;
    this.harvestTriggerAction = 'reanchor';

    // Final funding flush — capture any settlement that happened between
    // the last scheduled poll and stop. Non-critical: swallow errors.
    try {
      await this._pollFundingIncome();
    } catch (err) {
      console.error(`[LADDER] final funding poll failed: ${err.message}`);
    }

    // Release the user-data listen key + drop both WS streams.
    try {
      if (typeof this.cleanupWebSockets === 'function') this.cleanupWebSockets();
    } catch (err) {
      console.error(`[LADDER] cleanupWebSockets failed: ${err.message}`);
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
        console.error(`[LADDER] platform fee error: ${feeErr.message}`);
      }
    }

    // A cycle that stopped WITHOUT ever filling a position has no PnL. Don't
    // persist it as a "completed" strategy — it would inflate the Completed
    // count and dilute the win rate in the PnL tab. Delete the doc start()
    // created (isRunning:true) so boot-recovery can't resurrect it either.
    // Guarded by _hasNoTradingActivity() so a strategy that actually traded is
    // never removed here.
    const noTrade = this._hasNoTradingActivity();
    if (noTrade) {
      await this._deleteNoTradeStrategyDoc();
    } else {
      await this.saveState();
    }

    // Platform-wide hero profit (public landing page): add this cycle's net
    // profit when positive. Idempotent (heroCounted flag) + best-effort — a
    // failure here must never break the stop/teardown sequence.
    await this._recordHeroProfit(netPnL);

    await this.addLog(reason === 'final_tp'
      ? '[LADDER] Final TP — cycle complete, strategy terminated.'
      : '[LADDER] stop: terminated');

    // Completion notification. Helper signature is
    // (userId, strategyData); the FCM token lookup relies on the
    // second argument being the data object. Skipped for a no-trade cycle —
    // there is no completed strategy to report (and its doc was just deleted).
    if (!noTrade) {
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
        console.error(`[LADDER] notify error: ${notifyErr.message}`);
      }
    }

    // CRITICAL: invokes the app.js callback that does
    // `activeStrategies.delete(strategyId)`. Without this, the next start
    // attempt for this profile is rejected with "already running".
    try { this.onStopComplete?.(); } catch (e) {
      console.error('[LADDER] onStopComplete hook failed:', e.message);
    }
  }

  /**
   * True when this cycle never filled a position: no trading fees (every fill
   * incurs a taker commission), no realized PnL, no funding, and no reversals
   * or harvests. All of these are persisted by saveState() and
   * restored by resume(), so the check is crash-safe across a VM restart.
   * Conservative by design — any real trading activity leaves a non-zero
   * accumulatedTradingFees, so a strategy that actually traded can never be
   * misclassified as no-trade.
   */
  _hasNoTradingActivity() {
    return (this.accumulatedTradingFees || 0) === 0
      && (this.accumulatedRealizedPnL || 0) === 0
      && (this.accumulatedFundingFees || 0) === 0
      && (this.reversalCount || 0) === 0
      && (this.harvestCount || 0) === 0;
  }

  /**
   * Delete a no-trade cycle's Firestore doc (created by start() with
   * isRunning:true) plus its subcollections, instead of persisting it via
   * saveState(). Keeps the PnL tab's Completed count honest and prevents
   * boot-recovery from resurrecting an empty cycle. Only ever called behind
   * _hasNoTradingActivity(). Best-effort per subcollection; on a top-level
   * delete failure it falls back to saveState() so we never leave a dangling
   * isRunning:true doc that recovery would try to resume.
   */
  async _deleteNoTradeStrategyDoc() {
    // Suppress the remaining stop()-path addLog() writes (addLog no-ops when
    // this flag is set) so they don't recreate the logs subcollection under the
    // doc we're about to delete.
    this.willBeDeleted = true;
    const strategyRef = this.firestore.collection('strategies').doc(this.strategyId);
    try {
      const subs = [
        [this.tradesCollectionRef, 'trades'],
        [this.logsCollectionRef, 'logs'],
        [this.strategyFlowCollectionRef, 'strategyFlow'],
        [strategyRef.collection('metricsSamples'), 'metricsSamples'],
        [strategyRef.collection('aiPlans'), 'aiPlans'],
      ];
      for (const [ref, name] of subs) {
        if (!ref) continue;
        try {
          await this.deleteSubcollection(ref, name);
        } catch (subErr) {
          console.error(`[LADDER] no-trade cleanup: ${name} delete failed: ${subErr.message}`);
        }
      }
      await strategyRef.delete();
      console.log(`[LADDER] no-trade cycle ${this.strategyId} — strategy doc deleted (not persisted as completed).`);
    } catch (err) {
      console.error(`[LADDER] no-trade doc delete failed for ${this.strategyId}: ${err.message} — falling back to saveState()`);
      this.willBeDeleted = false;
      try { await this.saveState(); } catch (saveErr) {
        console.error(`[LADDER] fallback saveState also failed: ${saveErr.message}`);
      }
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
      console.error(`[LADDER] hero-profit record failed: ${err.message}`);
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
    // Cheap (multiplication + sign branch); needed so getStatus() and the
    // 30s heartbeat surface a live figure to the frontend.
    //
    // MUST stay above the mode dispatch below: every SCALING/TREND branch
    // returns, so anything after them never runs. Parked here this covers
    // TREND, where the consolidated position lives, and SCALING, where a
    // reversal clears activePosition via `_closeConsolidated`, a few lines down.
    if (this.activePosition) this._updateUnrealizedPnL(price);

    // ---- Level gate: plan the pair and build both ladders. ----
    // Unlike the deleted anchor, levels are DERIVED from market data, so this
    // can fail. It returns false and builds nothing when it does; we then trade
    // nothing this tick rather than guessing a level.
    if (!this.ladderLines.length) {
      await this._planAndBuildLevels('cycle_start');
      return;
    }

    if (this._tradingSeqInProgress) return; // do NOT advance lastProcessedPrice: re-scan this band next tick

    // ---- Tick mutual exclusion. ----
    // The `_tradingSeqInProgress` check above is NOT sufficient on its own:
    // nothing sets that flag until an action branch deep inside the dispatch
    // below, and there are awaits in between (`_reconcileTrendInvariant`,
    // `_harvestToFlat`) across which a SECOND WS tick can enter, pass the very
    // same gate, and execute the very same branch. That double-counted
    // `reversalCount` and wrote a duplicate REVERSAL row into the audit trail
    // the position chart reads. (No duplicate ORDER was possible — reduceOnly
    // plus the `leg.state === 'EMPTY'` re-check cover that — which is why this
    // survived as a counter bug rather than a money one.)
    //
    // TOMBSTONE — do NOT "simplify" this by setting `_tradingSeqInProgress`
    // here instead. `_harvestToFlat` REFUSES to run while that flag is set, and
    // the dispatch below calls it from two branches (the manual-harvest latch
    // and the armed price trigger), so hoisting it would make every tick-driven
    // harvest silently skip — turning a counter bug into a real one where the
    // user's Harvest button and their armed Trigger Price both stop working.
    // The two flags mean different things and must stay separate.
    //
    // Dropping the overlapping tick is safe for the same reason the guard above
    // is: `lastProcessedPrice` is not advanced, so the band is re-scanned on the
    // next tick.
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    try {
      await this._dispatchTick(price);
    } finally {
      this._tickInProgress = false;
    }
  }

  /**
   * The tick's decision body — everything downstream of the re-entrancy gates.
   *
   * Split out of `handleRealtimePrice` so the `_tickInProgress` latch can wrap
   * it in one try/finally rather than the method's dozen `return` paths each
   * needing to remember to clear the flag. Not a public entry point: call
   * `handleRealtimePrice`, which owns the guards and the latch.
   */
  async _dispatchTick(price) {
    // Honor a queued manual harvest on the next free tick (harvestNow sets the latch).
    if (this._manualHarvestRequested) {
      this._manualHarvestRequested = false;
      await this._harvestToFlat('manual_harvest');
      this.lastProcessedPrice = price;
      return;
    }

    // Armed price trigger — fire the manual harvest/re-anchor at a user-set
    // level. Placed here with the manual latch, BEFORE the SCALING/TREND
    // dispatch, so it takes precedence over the normal ladder action on this
    // tick (identical to the manual latch). One-shot: cleared BEFORE acting so
    // a throw mid-harvest can never leave a re-firing loop. Threshold (not
    // prev/current bracketing) so a gap-through and a resume-past-level fire.
    if (this.harvestTriggerPrice != null) {
      const reached = this.harvestTriggerAbove
        ? price >= this.harvestTriggerPrice
        : price <= this.harvestTriggerPrice;
      if (reached) {
        const action = this.harvestTriggerAction;
        this.harvestTriggerPrice = null;
        this.harvestTriggerAbove = null;
        this.harvestTriggerAction = 'reanchor';
        if (action === 'stop') {
          // Close and END the cycle. Read BEFORE the clears above so a throw
          // mid-stop cannot leave a re-firing trigger, same one-shot discipline
          // the re-anchor path uses.
          this._tradingSeqInProgress = true;
          try { await this.stop({ flatten: true, reason: 'protect' }); }
          finally { this._tradingSeqInProgress = false; }
          return;
        }
        // Re-anchor whether flat or holding — `_harvestToFlat` closes any position
        // (nothing if flat) and re-anchors on the live price. A flat run is
        // recorded as a RE-ANCHOR (reanchorCount), not a harvest.
        await this._harvestToFlat('price_trigger');
        this.lastProcessedPrice = price;
        return;
      }
    }

    // ---- Derive the SCALING→TREND invariant BEFORE dispatching. ----
    await this._reconcileTrendInvariant();

    // ---- TREND exit 1: Final TP -> close + STOP. The cycle ends. ----
    if (this.ladderMode === 'TREND' && this.finalTpPrice && this._checkFinalTpHit(price)) {
      this._tradingSeqInProgress = true;
      try { await this.stop({ flatten: true, reason: 'final_tp' }); }
      finally { this._tradingSeqInProgress = false; }
      return;
    }

    // ---- TREND exit 2: the trailed exit (§7). Checked before the tick rules so
    // a ratcheted trail owns the close; while it still sits AT the opposite
    // level `_updateTrailAndCheckHit` returns false and the reversal below
    // handles the hit instead.
    if (this.ladderMode === 'TREND' && this._updateTrailAndCheckHit(price)) {
      this._tradingSeqInProgress = true;
      let ok = false;
      try { ok = await this._trailedExit(); } finally { this._tradingSeqInProgress = false; }
      if (!ok) return;              // aborted: re-scan this band next tick
      this.lastProcessedPrice = price;
      return;                       // two-tick rule: fill nothing on this tick
    }

    // ---- Tick rules 0-3 (§6). One call covers SCALING and TREND alike: the
    // rules are identical, and TREND differs only in already being fully
    // scaled (so `fills` comes back empty) and in the two exits handled above
    // and below.
    const plan = planReversalActions({
      prevPrice: this.lastProcessedPrice,
      currentPrice: price,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      legs: this.ladderLines,
      heldSide: this.heldSide,
    });

    if (plan.reverse) {
      this._tradingSeqInProgress = true;
      try {
        const ok = await this._reverseTo(plan.side);
        if (!ok) return;  // aborted: fill nothing, do NOT advance lastProcessedPrice
        for (const leg of plan.fills) {
          if (leg.state === 'EMPTY') await this._fillLeg(leg);
        }
        if (plan.enterTrend) await this._enterTrend(plan.side);
      } finally { this._tradingSeqInProgress = false; }
      this.lastProcessedPrice = price;
      return;
    }

    if (plan.fills.length) {
      this._tradingSeqInProgress = true;
      try {
        for (const leg of plan.fills) {
          if (leg.state === 'EMPTY') await this._fillLeg(leg); // re-check: state may have moved since planning
        }
        // Fully scaled -> TREND. `enterTrend` comes from planReversalActions,
        // which derives the outermost index FROM THE LEGS — never from a rung
        // count that could disagree with them.
        if (plan.enterTrend) await this._enterTrend(plan.side);
      } finally { this._tradingSeqInProgress = false; }
    }

    this.lastProcessedPrice = price;
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
   * (accLoss + desiredProfit + fee)/qty), so the change re-derives the
   * Final TP immediately. No state-machine transition — the cycle just
   * continues with the new target. saveState persists it.
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
      `[LADDER] manual profit-target adjust: ${pct}% → ${this._formatNotional(newUSDT)} USDT ` +
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
   * Project what closing at `price` would net, WITHOUT changing anything.
   *
   * This is the number the Final TP editor shows while the user types, and it
   * is the same quantity `desiredProfitUSDT` denotes: at the Final TP,
   * `needed = accLoss + desiredProfit + closingFee`, so the cycle's net lands
   * exactly on `desiredProfit`. Inverting `_recomputeFinalTpPrice` here — the
   * SAME accLoss and the SAME entry-based closing-fee estimate — is what makes
   * the editor's preview and the resulting target agree; deriving it any other
   * way would show one number and arm another.
   *
   * PURE: no mutation, no I/O. Returns null when there is nothing to project
   * from (no verified position, no side, degenerate price).
   *
   * @param {number} price
   * @returns {{projectedProfitUSDT: number, side: 'LONG'|'SHORT'} | null}
   */
  projectProfitAtPrice(price) {
    if (this._lastPositionRefreshFailed) return null;   // unknown must never read as safe
    const pos = this.activePosition;
    if (!pos || !(pos.quantity > 0)) return null;
    const qty = pos.quantity;
    const entry = pos.entryPrice || pos.avgEntry;
    if (!entry || !Number.isFinite(price) || price <= 0) return null;
    const side = this.trendDirection || this.currentSide;
    if (side !== 'LONG' && side !== 'SHORT') return null;

    // Signed distance IN THE PROFITABLE DIRECTION. A LONG profits above entry,
    // a SHORT below — so a level on the wrong side yields a negative gain and
    // is rejected by the floor check below rather than silently flipping sign.
    const gain = side === 'LONG' ? (price - entry) * qty : (entry - price) * qty;
    const notional = pos.notional || entry * qty || 0;
    const estimatedClosingFee = notional * FEE_RATE;
    return {
      projectedProfitUSDT: gain - (this.cycleAccumulatedLoss || 0) - estimatedClosingFee,
      side,
    };
  }

  /**
   * Move the Final TP to a user-chosen LEVEL, or reset it to the config target.
   *
   * Writes `desiredProfitUSDT` and lets `_recomputeFinalTpPrice()` re-derive the
   * price — deliberately NOT a second writer of `finalTpPrice`. That method is
   * the single choke point enforcing "a target may only be derived from
   * Binance-VERIFIED position data"; assigning a price directly here would walk
   * straight past the `_lastPositionRefreshFailed` guard, and because the TREND
   * exit gate is `if (this.finalTpPrice && ...)` the guessed target would be
   * ACTED ON. Back-solving keeps that invariant intact for free.
   *
   * The FLOOR is `minDesiredProfitUSDT` — the config view's desired profit,
   * captured at cycle start. A manual level may only project MORE than config
   * asked for; `reset: true` returns to exactly it.
   *
   * Validated on PROFIT, never on price: a SHORT's Final TP sits BELOW entry, so
   * "must be higher" is inverted on that side and a price comparison would let a
   * short cycle set a target worth less than config asked for.
   *
   * Error shapes match harvestNow: client-input problems set `.invalidInput`
   * (route → 400); state conflicts are untagged (route → 409).
   *
   * @param {{price?: number, reset?: boolean}} input
   */
  async adjustFinalTp({ price = null, profitUSDT = null, reset = false } = {}) {
    if (!this.isRunning) throw new Error('Strategy is not running.');
    const invalidInput = (msg) => { const e = new Error(msg); e.invalidInput = true; return e; };

    if (reset) {
      this.desiredProfitUSDT = this.minDesiredProfitUSDT || 0;
      this._recomputeFinalTpPrice();
      await this.saveState();
      this._pushHeartbeatNow?.();
      await this.addLog(
        `[LADDER] Final TP reset to the config target — desired profit ` +
        `${this._formatNotional(this.desiredProfitUSDT)} USDT` +
        (this.finalTpPrice ? ` (Final TP ${this._formatPrice(this.finalTpPrice)}).` : '.'),
      );
      return {
        reset: true,
        desiredProfitUSDT: this.desiredProfitUSDT,
        minDesiredProfitUSDT: this.minDesiredProfitUSDT,
        finalTpPrice: this.finalTpPrice,
      };
    }

    // Set the TARGET directly, without a level. This is the path that works in
    // SCALING — and while flat — where there is no position to back-solve a price
    // from, but the profit target still matters: it is what `_recomputeFinalTpPrice`
    // will derive the Final TP from the moment the outermost leg trips TREND.
    // Routed through this method rather than `adjustProfitTarget` so the config
    // floor is enforced in ONE place; a second entry point that skipped it would
    // let the target be set below what config asked for.
    if (profitUSDT != null) {
      const want = Number(profitUSDT);
      if (!Number.isFinite(want)) throw invalidInput('Profit target must be a number.');
      const floorUSDT = this.minDesiredProfitUSDT || 0;
      if (want < floorUSDT - 1e-9) {
        throw invalidInput(
          `${this._formatNotional(want)} USDT is below the ${this._formatNotional(floorUSDT)} USDT ` +
          `target set in the config. Raise it, or Reset.`,
        );
      }
      const prev = this.desiredProfitUSDT || 0;
      this.desiredProfitUSDT = want;
      this._recomputeFinalTpPrice();   // null in SCALING/flat by design — armed later by _enterTrend
      await this.saveState();
      this._pushHeartbeatNow?.();
      await this.addLog(
        `[LADDER] profit target ${this._formatNotional(prev)} → ${this._formatNotional(want)} USDT ` +
        (this.finalTpPrice ? `(Final TP ${this._formatPrice(this.finalTpPrice)}).` : '(no position yet — applies when TREND arms).'),
      );
      return {
        desiredProfitUSDT: this.desiredProfitUSDT,
        minDesiredProfitUSDT: floorUSDT,
        finalTpPrice: this.finalTpPrice,
      };
    }

    const px = Number(price);
    if (!Number.isFinite(px) || px <= 0) throw invalidInput('Final TP must be a positive number.');

    // A Final TP only exists against a verified open position. Refusing here is
    // a STATE conflict, not bad input — the request may be perfectly well-formed.
    const projected = this.projectProfitAtPrice(px);
    if (!projected) {
      throw new Error('Final TP cannot be set right now — no verified open position to derive it from.');
    }

    const floor = this.minDesiredProfitUSDT || 0;
    // Tolerance absorbs float noise so re-submitting the level the UI just
    // displayed as exactly-at-floor is not rejected for a sub-cent shortfall.
    if (projected.projectedProfitUSDT < floor - 1e-9) {
      throw invalidInput(
        `That level projects ${this._formatNotional(projected.projectedProfitUSDT)} USDT, below the ` +
        `${this._formatNotional(floor)} USDT target set in the config. ` +
        `Move the Final TP further ${projected.side === 'LONG' ? 'up' : 'down'}, or Reset.`,
      );
    }

    const before = this.desiredProfitUSDT || 0;
    this.desiredProfitUSDT = projected.projectedProfitUSDT;
    this._recomputeFinalTpPrice();
    await this.saveState();
    this._pushHeartbeatNow?.();
    await this.addLog(
      `[LADDER] Final TP moved to ${this._formatPrice(this.finalTpPrice ?? px)} — desired profit ` +
      `${this._formatNotional(before)} → ${this._formatNotional(this.desiredProfitUSDT)} USDT ` +
      `(config floor ${this._formatNotional(floor)}).`,
    );
    return {
      desiredProfitUSDT: this.desiredProfitUSDT,
      minDesiredProfitUSDT: floor,
      finalTpPrice: this.finalTpPrice,
    };
  }

  // ——— Position actions ——————————————————————————————————————————————

  /**
   * Manual, user-driven harvest. Flattens whatever is open ON DEMAND —
   * regardless of cycleAccumulatedLoss vs the auto harvest-gate threshold.
   * This is the backend for the Active Position card's "Harvest now" control.
   *
   * `_harvestToFlat` self-guards on `_tradingSeqInProgress` and SKIPS if a
   * trading sequence is momentarily in flight, so this sets a latch instead
   * of firing directly — `handleRealtimePrice` honors it on the next free
   * tick, guaranteeing the harvest actually runs (no silent no-op).
   *
   * No open-position gate: this also works while FLAT. `_harvestToFlat`
   * (from Task 1) closes whatever is open — or nothing, if already flat —
   * and always re-anchors on the live price, so both the immediate action
   * and an armed trigger are valid at any time the strategy is running. A
   * flat run records as a RE-ANCHOR (`reanchorCount`), not a harvest. The
   * frontend still labels the button by the position's unrealized PnL —
   * Harvest (unrealized >= 0) or Re-anchor (unrealized < 0 or flat) — but
   * both queue the identical flatten (if any) + re-anchor. The gauge no
   * longer gates this either way; its only remaining job is locking dynamic
   * sizing (see `_computeLadderBaseSize`).
   *
   * `triggerPrice` is optional and selects between two modes:
   *  - omitted/null → immediate harvest: latches for the next free tick (as
   *    above), also clearing any previously-armed trigger.
   *  - a number → arm a validated one-shot Trigger Price instead of harvesting
   *    now; fires later off `handleRealtimePrice` when the market crosses it.
   *
   * Throws on ineligibility. Two error shapes, tagged so the route can tell
   * them apart: the state conflict ('Strategy is not running.') is untagged
   * → the route maps it to 409; trigger-price validation failures
   * (non-positive price, no live price yet, price too close to the current
   * price) set `error.invalidInput = true` → the route maps those to 400.
   */
  async harvestNow(triggerPrice = null, { action = 'reanchor' } = {}) {
    if (!this.isRunning) throw new Error('Strategy is not running.');

    // No price → immediate harvest on the next free tick (today's behavior).
    // Clear any armed trigger so an immediate Harvest-now always supersedes a
    // pending one — the backend, not the frontend, guarantees the exclusion.
    if (triggerPrice == null) {
      this.harvestTriggerPrice = null;
      this.harvestTriggerAbove = null;
      this.harvestTriggerAction = 'reanchor';
      this._manualHarvestRequested = true; // honored on the next free tick
      return { harvesting: true, queued: true, mode: this.ladderMode, price: this.currentPrice };
    }

    // With a price → arm a one-shot trigger. The VM is the authority on
    // validity (mirrors the ladder-geometry bounds philosophy): validate,
    // enforce the 0.1% gap, and round to the symbol's tick size here.
    // These are client-INPUT errors (bad/too-close price), not state
    // conflicts — tag them so the route can map to 400 instead of 409.
    const invalidInput = (msg) => { const e = new Error(msg); e.invalidInput = true; return e; };
    const px = Number(triggerPrice);
    if (!Number.isFinite(px) || px <= 0) {
      throw invalidInput('Trigger price must be a positive number.');
    }
    const ref = this.currentPrice;
    if (!Number.isFinite(ref) || ref <= 0) {
      throw invalidInput('No live price yet — cannot arm a trigger.');
    }
    const rounded = this.roundPrice(px);
    if (Math.abs(rounded - ref) < ref * TRIGGER_MIN_GAP_PCT) {
      throw invalidInput(`Trigger price must be at least 0.1% from the current price (${this._formatPrice(ref)}).`);
    }
    // STRICT: only the two known actions. An unrecognised value must not
    // silently become a cycle-ending stop, nor silently become a re-anchor when
    // the caller meant to stop — reject it and make the caller say what it wants.
    if (action !== 'reanchor' && action !== 'stop') {
      throw invalidInput("Trigger action must be 'reanchor' or 'stop'.");
    }
    this.harvestTriggerPrice = rounded;
    this.harvestTriggerAbove = rounded > ref;
    this.harvestTriggerAction = action;
    this._manualHarvestRequested = false; // arming is NOT an immediate harvest
    await this.saveState();
    this._pushHeartbeatNow?.();
    await this.addLog(
      `[LADDER] ${action === 'stop' ? 'PROTECT' : 'harvest'} trigger armed @ ${this._formatPrice(rounded)} ` +
      `(fires when price ${this.harvestTriggerAbove ? '>=' : '<='} ${this._formatPrice(rounded)}` +
      `${action === 'stop' ? ' — closes and ENDS the cycle' : ' — closes and re-anchors'}).`,
    );
    return { armed: true, triggerPrice: rounded, above: this.harvestTriggerAbove, action, mode: this.ladderMode };
  }

  /**
   * Cancel an armed harvest/re-anchor Trigger Price. No-op-safe (idempotent).
   * Called by the /reversal-ladder/cancel-harvest-trigger route.
   */
  async cancelHarvestTrigger() {
    const had = this.harvestTriggerPrice != null;
    this.harvestTriggerPrice = null;
    this.harvestTriggerAbove = null;
    this.harvestTriggerAction = 'reanchor';
    if (had) {
      await this.saveState();
      this._pushHeartbeatNow?.();
      await this.addLog('[LADDER] harvest trigger cancelled.');
    }
    return { cancelled: true };
  }

  // ——— Manual level control (§3, §10) ——————————————————————————————————

  /**
   * Manual edit of one or both levels (§3). The VM is the authority; the UI
   * confirm is a convenience.
   *
   * Two hard refusals, both fail-CLOSED:
   *  1. The §3 invariant `bearLevel < live price < bullLevel`. A level on the
   *     wrong side of price is an order trigger that fires the instant it is
   *     set.
   *  2. A side with ANY filled leg cannot move. Rebuilding that ladder resets
   *     its legs, and those POSITION_OPEN markings are the only record of what
   *     is open (`_closeQuantity` sizes every close from them) — moving the
   *     geometry under them orphans live inventory.
   *
   * Error shapes match `harvestNow`: input errors set `.invalidInput = true`
   * (→ 400); state conflicts are untagged (→ 409).
   */
  async editLevels({ bullLevel = null, bearLevel = null } = {}) {
    if (!this.isRunning) throw new Error('Strategy is not running.');
    const invalidInput = (msg) => { const e = new Error(msg); e.invalidInput = true; return e; };

    if (bullLevel == null && bearLevel == null) {
      throw invalidInput('Supply bullLevel, bearLevel, or both.');
    }
    const price = this.currentPrice;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('No live price yet — cannot validate a level edit.');
    }

    const nextBull = bullLevel == null ? this.bullLevel : this.roundPrice(Number(bullLevel));
    const nextBear = bearLevel == null ? this.bearLevel : this.roundPrice(Number(bearLevel));
    if (!Number.isFinite(nextBull) || nextBull <= 0) throw invalidInput('bullLevel must be a positive number.');
    if (!Number.isFinite(nextBear) || nextBear <= 0) throw invalidInput('bearLevel must be a positive number.');

    const movingBull = bullLevel != null && nextBull !== this.bullLevel;
    const movingBear = bearLevel != null && nextBear !== this.bearLevel;

    // The §3 invariant is checked ONLY against the side being moved. Once a
    // position is scaled, price is legitimately OUTSIDE the band by
    // construction (that is what TREND is), so re-validating the untouched side
    // against live price would refuse every edit exactly when the user most
    // wants one. The untouched side cannot have become invalid on its own — it
    // has not moved — and the side price HAS run past is filled, which the
    // filled-leg refusal below rejects anyway. `nextBull > nextBear` is checked
    // unconditionally: an inverted pair has no dead zone at all.
    if (movingBull && !(nextBull > price)) {
      throw invalidInput(`bullLevel must be above the current price (${this._formatPrice(price)}).`);
    }
    if (movingBear && !(nextBear < price)) {
      throw invalidInput(`bearLevel must be below the current price (${this._formatPrice(price)}).`);
    }
    if (!(nextBull > nextBear)) {
      throw invalidInput(`bullLevel (${this._formatPrice(nextBull)}) must be above bearLevel (${this._formatPrice(nextBear)}).`);
    }

    const held = (dir) => this.ladderLines.some((l) => l.direction === dir && l.state === 'POSITION_OPEN');
    if (movingBull && held('LONG')) {
      throw new Error('The bull ladder has a filled leg — close the position before moving that level.');
    }
    if (movingBear && held('SHORT')) {
      throw new Error('The bear ladder has a filled leg — close the position before moving that level.');
    }
    if (!movingBull && !movingBear) {
      return { bullLevel: this.bullLevel, bearLevel: this.bearLevel, changed: false };
    }

    // Rebuild ONLY the moved side, preserving the other side's legs verbatim —
    // the untouched ladder may hold inventory, and buildReversalLadder returns
    // fresh EMPTY legs for both sides.
    const rebuilt = buildReversalLadder(nextBull, nextBear, this.stepPct, this.levelsPerSide);
    this.ladderLines = this.ladderLines.map((leg) => {
      const moving = leg.direction === 'LONG' ? movingBull : movingBear;
      if (!moving) return leg;
      return rebuilt.find((r) => r.direction === leg.direction && r.index === leg.index) ?? leg;
    });
    this.bullLevel = nextBull;
    this.bearLevel = nextBear;

    // Carry-forward 3: the band just moved. The ratchet's stored value may now
    // sit outside it, where Math.max/Math.min would let it win forever and the
    // cap that keeps the exit out of the ladder would be silently dead.
    if (Number.isFinite(this.trailExit)) {
      this.trailExit = Math.min(this.bullLevel, Math.max(this.bearLevel, this.trailExit));
    }
    if (this.trailEnabled && this.ladderMode === 'TREND') {
      // The distance is measured against the levels, so a moved level changes
      // it. Re-arm from the current trend start rather than keeping a distance
      // derived from a band that no longer exists.
      const d = trailDistance(this.trendStartPrice, this.trendDirection, this.bullLevel, this.bearLevel);
      this.trailDistanceValue = (d != null && d > 0) ? d : null;
      if (this.trailDistanceValue == null) this.trailExit = null;
    }

    await this.addLog(
      `[REVERSAL] levels edited — BULL ${this._formatPrice(this.bullLevel)} / ` +
      `BEAR ${this._formatPrice(this.bearLevel)} (rebuilt: ` +
      `${[movingBull && 'bull', movingBear && 'bear'].filter(Boolean).join(' + ')}).`,
    );
    await this._writeStrategyFlow('LEVELS_EDITED', {
      bullLevel: this.bullLevel, bearLevel: this.bearLevel, movedBull: movingBull, movedBear: movingBear,
    }).catch(() => {});
    await this.saveState();
    this._pushHeartbeatNow?.();
    return { bullLevel: this.bullLevel, bearLevel: this.bearLevel, changed: true };
  }

  /**
   * Ask the planner for a level proposal WITHOUT applying it (§10). Returns a
   * proposal even with a position open; applying it is a separate, explicit
   * user action through `editLevels`, which re-runs the §3 guard rails and the
   * filled-leg refusal.
   */
  async askAi(question) {
    if (!this.isRunning) throw new Error('Strategy is not running.');
    if (!Number.isFinite(this.currentPrice) || this.currentPrice <= 0) {
      throw new Error('No live price yet — cannot build a market context.');
    }
    const context = await buildLevelContext({
      symbol: this.symbol,
      currentPrice: this.currentPrice,
      volumeProfile: this.volumeProfile,
      marketMetrics: this.marketMetrics,
    });
    const result = await planLevels({
      planner: this._aiPlanner ?? null,
      context,
      mode: 'ask',
      question: typeof question === 'string' ? question : undefined,
    });
    if (!result) throw new Error('No valid level pair could be produced for this market right now.');
    if (result.usage) {
      this._aiUsage.add(result.usage);
      this.aiCostUSD = this._aiUsage.costUsd(this.aiModel);
      await this.saveState();
    }
    return {
      bullLevel: result.bullLevel,
      bearLevel: result.bearLevel,
      source: result.source,
      rationale: result.rationale,
      confidence: result.confidence,
      applied: false,
    };
  }

  // ——— Dynamic sizing ————————————————————————————————————————————————

  /**
   * Apply the user's formula:
   *   Recovery size   = accumulated_loss × recovery_factor
   *   Additional size = Recovery size / recovery_distance
   *   New size        = Initial size + Additional size
   *
   * Reads `cycleAccumulatedLoss` from current accumulators (Binance-truth).
   * Caller (_computeLadderBaseSize) is responsible for refreshing accumulators
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
   *
   * `wallet` MUST be the live totalMarginBalance (see `_computeLadderBaseSize`,
   * the sole caller) — never a cached snapshot. A cached figure over-estimates
   * headroom exactly during drawdown, when the cap matters most.
   */
  _applyMarginHeadroomCap(proposedSize, wallet) {
    // Fail CLOSED on an unknown wallet balance. The `getTotalMarginBalance()`
    // call site already throws (caught by `_computeLadderBaseSize`) on a
    // hard API failure, but a 200 response with a missing/malformed field
    // parses to NaN WITHOUT throwing — belt-and-braces here too. An unknown
    // balance must NEVER read as "infinite headroom" (the previous
    // `wallet <= 0 -> return proposedSize` fell through to exactly that for
    // NaN, since `NaN <= 0` is false).
    if (!Number.isFinite(wallet) || wallet <= 0) {
      const floor = this.currentInitialSize || 0;
      void this.addLog(`[LADDER] margin-headroom cap: wallet balance invalid/unknown (${wallet}) — capping to ${floor} (fail-closed).`);
      return floor;
    }
    const proposedNotional = proposedSize;
    const usedMargin = (this.activePosition?.notional || 0) / Math.max(1, this.leverage);
    const proposedMarginUse = proposedNotional / Math.max(1, this.leverage);
    // Pessimistic: assume two more reversals at same proposed size.
    const projectedUsed = usedMargin + proposedMarginUse * 2;
    const projectedFreePct = ((wallet - projectedUsed) / wallet) * 100;
    if (projectedFreePct < MARGIN_HEADROOM_FLOOR_PCT) {
      const floor = this.currentInitialSize || 0;
      void this.addLog(`[LADDER] margin-headroom cap: proposed=${proposedSize} projectedFree=${projectedFreePct.toFixed(2)}% < ${MARGIN_HEADROOM_FLOOR_PCT}% → capped to ${floor}`);
      return floor;
    }
    return proposedSize;
  }

  // ——— Final TP ——————————————————————————————————————————————————————

  /**
   * Final TP price — solves for price where unrealized PnL on the current
   * position covers accumulated_loss + desired_profit + estimated_closing_fee.
   *
   *   needed = accLoss + desiredProfit + estimatedClosingFee
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
   * The old AI-consult cost addend is gone (the strategy is fully mechanical),
   * so the target now moves only with accumulated loss, the desired profit, and
   * the estimated closing fee. Recomputed on every position/funding event.
   *
   * Side resolution mirrors `_checkFinalTpHit`: key off `trendDirection`
   * (set synchronously in `_enterTrend` and restored directly from the
   * snapshot in `resume`) with a `currentSide` fallback, rather than
   * `currentSide` alone. `currentSide` is only ever populated by
   * `_refreshCurrentPosition()` (a REST call) or restored from a snapshot,
   * so on a boot-recovery race (resume() calls this before the position
   * refresh resolves currentSide) keying on currentSide alone left
   * finalTpPrice null and the Final TP call site
   * (`if (this.finalTpPrice && this._checkFinalTpHit(price))`) silently
   * never arms.
   */
  _recomputeFinalTpPrice() {
    // SINGLE CHOKE POINT — the only writer of finalTpPrice that derives a
    // target, and therefore the right place to enforce "a target may only be
    // derived from Binance-VERIFIED position data".
    //
    // TOMBSTONE — do NOT drop this guard and re-guard the call sites instead.
    // This method has four callers, three of which (`_pollFundingIncome`,
    // `adjustProfitTarget`, `resume`) fire on schedules and user actions that
    // have nothing to do with arming, and every one of them used to be
    // unguarded. When the last refresh failed, `activePosition` is whatever it
    // was BEFORE the failure (a stale qty/entry), so a target derived from it
    // is a guess — and because the TREND exit gate is `if (this.finalTpPrice
    // && ...)`, that guess would be ACTED ON: an 8-hourly funding settlement
    // or the user nudging the profit-target pencil would silently resurrect
    // the exact unverified target `_enterTrend` had refused to arm, and close
    // the cycle at it. Refusing here means every caller — including any future
    // one — inherits the invariant instead of having to remember it.
    //
    // Nulling (rather than leaving the previous value) is the point: it keeps
    // "unverified" and "unarmed" the same state, so `_reconcileTrendInvariant`
    // sees an unarmed TREND and retries each tick until Binance answers.
    if (this._lastPositionRefreshFailed) {
      this.finalTpPrice = null;
      return;
    }
    if (!this.activePosition || !this.activePosition.quantity || this.activePosition.quantity <= 0) {
      this.finalTpPrice = null;
      return;
    }
    const qty = this.activePosition.quantity;
    const entry = this.activePosition.entryPrice || this.activePosition.avgEntry;
    const notional = this.activePosition.notional || (entry * qty) || 0;
    // needed = accLoss + desiredProfit + estimatedClosingFee
    // (the AI-cost term is gone — there is no AI.)
    const estimatedClosingFee = notional * FEE_RATE;
    const needed = (this.cycleAccumulatedLoss || 0)
      + (this.desiredProfitUSDT || 0)
      + estimatedClosingFee;
    if (!entry || qty <= 0) {
      this.finalTpPrice = null;
      return;
    }
    const side = this.trendDirection || this.currentSide;
    if (side === 'LONG') {
      this.finalTpPrice = entry + needed / qty;
    } else if (side === 'SHORT') {
      this.finalTpPrice = entry - needed / qty;
    } else {
      this.finalTpPrice = null;
    }
  }

  // TREND-only check (SCALING never calls this — see handleRealtimePrice). Keys
  // off `trendDirection`, the mechanical direction fixed the instant TREND was
  // entered, rather than `currentSide` — the latter is exchange-derived via
  // `_refreshCurrentPosition` and, on a boot-recovery race, could still be
  // unset even though the strategy doc already recorded which way TREND runs.
  _checkFinalTpHit(price) {
    if (!this.finalTpPrice) return false;
    const side = this.trendDirection || this.currentSide;
    if (side === 'LONG') return price >= this.finalTpPrice;
    if (side === 'SHORT') return price <= this.finalTpPrice;
    return false;
  }

  // ——— Trade fill reconciliation ——————————————————————————————————————

  /**
   * Post-execute bookkeeping hook. Called after a leg fill (_fillLeg) and
   * after the FINAL_TP_HIT close in stop(), once the order/close resolves
   * on Binance. (_reverseTo / _harvestToFlat / _enterTrend do their
   * own inline bookkeeping — accLoss recompute + saveState + strategyFlow —
   * since they don't go through a single order/fill path.)
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
      console.error(`[LADDER] _postExecuteBookkeeping error: ${err.message}`);
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
      console.error(`[LADDER] _writeStrategyFlow failed: ${err.message}`);
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
      console.error(`[LADDER] funding poll error: ${err.message}`);
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

  // ——— Helpers ————————————————————————————————————————————————————————

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
          console.log(`[LADDER] _refreshCurrentPosition: REST returned empty post-trade; retry ${attempt}/5 after 300ms`);
          await new Promise((r) => setTimeout(r, 300));
          await this.detectCurrentPosition(true);
          side = this.currentPosition;
          qty = this.currentPositionQuantity;
          entryPrice = this.positionEntryPrice;
          if ((side === 'LONG' || side === 'SHORT') && qty && qty > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
            console.log(`[LADDER] _refreshCurrentPosition: REST resolved non-empty on attempt ${attempt}/5`);
            break;
          }
        }
      }

      // Reached only when detectCurrentPosition() above did NOT throw —
      // Binance was actually queried, so the result (position or genuinely
      // empty) is authoritative.
      this._lastPositionRefreshFailed = false;

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

      // No position (or REST kept returning empty after retries) — the
      // fetch SUCCEEDED and confirmed flat, so it's safe to reflect that.
      this.activePosition = null;
      this.currentSide = null;
    } catch (err) {
      // detectCurrentPosition() throws on an API failure and — critically —
      // never wipes currentPosition/positionEntryPrice/etc on the way there,
      // so `this.activePosition` here is still whatever it was BEFORE this
      // call (stale, not flat). Leave it untouched: swallow the error (many
      // callers of _refreshCurrentPosition assume it never throws — e.g.
      // _postExecuteBookkeeping's saveState/heartbeat tail must still run)
      // but flag the failure so state-sensitive callers like stop()'s
      // flatten path can tell "confirmed flat" apart from "unknown".
      this._lastPositionRefreshFailed = true;
      await this.addLog(`[LADDER] _refreshCurrentPosition error: ${err.message} — position state UNKNOWN, NOT treated as flat.`);
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
   * Refresh the 24h VP for the chart histogram, plus the Volume Analytics
   * primitives (CVD / orderbook depth / ATR). Display-only — the ladder is
   * anchored on live price and reads nothing from any of them. Best-effort:
   * a failure leaves the last snapshot in place rather than throwing into the
   * tick path.
   *
   * Each metric is caught independently: one dead endpoint must not blank the
   * other three cells. Fetched in parallel — they are unrelated reads and the
   * serial version would stack four round-trips onto the tick path's interval.
   */
  async _refreshVolumeSnapshot() {
    const refresh = async (label, fetch, assign) => {
      try {
        const value = await fetch();
        if (value) assign(value);
      } catch (e) {
        await this.addLog(`${label} refresh failed: ${e.message} (keeping the last snapshot).`);
      }
    };

    await Promise.all([
      refresh('Volume profile', () => this.volumeProfile.get24h(this.symbol), v => { this._lastVolumeProfile24h = v; }),
      refresh('CVD', () => this.marketMetrics.getCvd(this.symbol), v => { this._lastCvd = v; }),
      refresh('Orderbook depth', () => this.marketMetrics.getOrderbookDepth(this.symbol), v => { this._lastOrderbookDepth = v; }),
      refresh('ATR', () => this.marketMetrics.getVolatility(this.symbol), v => { this._lastVolatility = v; }),
    ]);
  }

  _scheduleVolumeRefresh() {
    if (this._volumeRefreshInterval) clearInterval(this._volumeRefreshInterval);
    // Fire ONE immediate refresh so the chart's POC/HVN overlays and the
    // Volume Analytics panel populate within seconds of start/resume — the
    // primitives (VP/CVD/orderbook/ATR) start null, so without this they sit
    // blank until the first interval fires 5 minutes later. This lives here
    // (not the callers) so EVERY startup path gets it: start() previously only
    // scheduled, leaving a fresh strategy blank for 5 minutes.
    this._refreshVolumeSnapshot().catch(() => {});
    // 5-minute cadence. Each fetcher caches internally (VP TTL 10min,
    // CVD ~5min, etc.) so this is cheap when nothing has expired and
    // keeps the chart fresh during long position holds.
    this._volumeRefreshInterval = setInterval(() => {
      if (!this.isRunning) return;
      this._refreshVolumeSnapshot().catch(() => {});
    }, 5 * 60 * 1000);
  }

  // ——— Platform Fee ————————————————————————————————————————————————

  /**
   * Deducts the platform fee from the user's wallet on net positive PnL.
   * Strategy-specific (reads userId/firestore off `this`) rather than on
   * TradingBase; follow-up: refactor down to TradingBase.
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
      // Negative Reload Balance is allowed by design — the strategy-start gate
      // (/billing/preflight) blocks new cycles until the user tops up. Deduct
      // the full fee even if it takes the balance below 0.

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
        // Traceable reference shown in the wallet ledger UI: the strategy run
        // whose profit this fee was charged on.
        reference: this.strategyId,
        metadata: { totalPnL: profitAmount, feePercentage: platformFeePercent },
      });
    } catch (error) {
      console.error(`Platform fee error: ${error.message}`);
      await this.addLog(`ERROR: [PLATFORM_FEE] ${error.message}`);
    }
  }

  // ——— Status snapshot (consumed by /reversal-ladder/status) ——————————————

  getStatus() {
    // acc-loss is purely derived from the live (Binance-truth) accumulators, so
    // refresh it on read — the displayed gauge then always matches the Cycle PnL
    // Net regardless of which trade path last ran (grid crossings, harvest, ...).
    this.cycleAccumulatedLoss = this._computeAccLoss();
    return {
      strategyId: this.strategyId,
      strategyType: 'reversalLadder',
      symbol: this.symbol,
      // Price precision (decimals) from the cached exchange info, so the frontend
      // formats ALL prices (ladder levels, bull/bear levels, trigger inputs) at the pair's
      // real tick precision instead of a magnitude heuristic. Static per symbol,
      // so it rides getStatus() (loaded once) rather than the slim heartbeat.
      pricePrecision: precisionFormatter.getPricePrecision(this.symbol),
      isRunning: this.isRunning,
      executionState: this.executionState,
      subState: this.subState,
      currentSide: this.currentSide,
      currentPosition: this.activePosition,
      finalTpPrice: this.finalTpPrice,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      reanchorCount: this.reanchorCount,
      initialCapital: this.initialCapital,
      currentInitialSize: this.currentInitialSize,
      desiredProfitUSDT: this.desiredProfitUSDT,
      minDesiredProfitUSDT: this.minDesiredProfitUSDT,
      // AI level planning (§10) — cost accounting only. The key itself
      // (`_aiApiKey`) is NEVER surfaced here — see its constructor doc.
      aiCostUSD: this.aiCostUSD ?? 0,
      aiModel: this.aiModel,

      // Ladder state — the frontend's status/chart view renders these
      // directly. `mode` is the alias the frontend actually reads
      // (status.mode, not status.ladderMode).
      mode: this.ladderMode,         // the frontend reads status.mode, not ladderMode
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      ladderLines: this.ladderLines,
      trendDirection: this.trendDirection,
      levelsPerSide: this.levelsPerSide,
      stepPct: this.stepPct,
      legNotional: this._legNotional(),
      ladderBaseSize: this._ladderBaseSize,
      // Trailing exit (§7).
      trailEnabled: this.trailEnabled ?? false,
      trailDistanceValue: this.trailDistanceValue ?? null,
      trailExit: this.trailExit ?? null,
      trendStartPrice: this.trendStartPrice ?? null,
      // Running config — surfaced so the frontend's Active Config panel
      // can show the values the bot is ACTUALLY using rather than the
      // form's DEFAULT_CONFIG (which is what reversal's frontend used
      // to read, producing a wrong picture when a strategy was started
      // with non-default settings and the user later refreshed the page).
      leverage: this.leverage,
      priceType: this.priceType,
      recoveryFactor: this.recoveryFactor,
      recoveryDistance: this.recoveryDistance,
      harvestLossThreshold: this.harvestLossThreshold,
      _lastLadderSize: this._lastLadderSize,
      harvestTriggerPrice: this.harvestTriggerPrice ?? null,
      harvestTriggerAbove: this.harvestTriggerAbove ?? null,
      harvestTriggerAction: this.harvestTriggerAction ?? 'reanchor',
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      cycleStartTime: this.cycleStartTime,
      cycleDuration: this.cycleStartTime ? formatDuration(Date.now() - this.cycleStartTime) : null,
      // Emitted as an ISO string for the frontend chart's SS marker
      // (`updateSessionStartX` does `Date.parse(status.strategyStartTime)`).
      // Without this, the SS vertical dotted line never draws on reversal.
      strategyStartTime: this.strategyStartTime ? this.strategyStartTime.toISOString() : null,
      currentPrice: this.currentPrice,

      // Volume primitives — refreshed for the chart by _refreshVolumeSnapshot.
      // Frontend chart overlays POC / VAH / VAL / HVN edges from these.
      volumeProfile24h: this._lastVolumeProfile24h,
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
   *   - Fields covered by other event pushes (currentPrice via price_tick).
   *   - Volume/volatility snapshot cache (volumeProfile24h / cvd /
   *     orderbookDepth / volatility) — refreshed on its own interval, not
   *     worth a heartbeat push every time.
   *   - Derivable fields (cycleDuration = Date.now() - cycleStartTime).
   * Ladder/mode fields (mode, bullLevel/bearLevel/ladderLines/etc., trendDirection,
   * finalTpPrice, ...) ARE included here because SCALING/TREND transitions
   * and reversal rebuilds happen mid-cycle, and the frontend merges
   * this payload directly into `status`
   * (setStatus(prev => ({...prev, ...payload}))) so a value missing here
   * would only ever reach the frontend via the next full REST getStatus().
   * Fires on the 30s safety-net interval AND immediately after every
   * bookkeeping change via _pushHeartbeatNow().
   */
  getHeartbeatPayload() {
    this.cycleAccumulatedLoss = this._computeAccLoss(); // keep derived acc-loss live (see getStatus)
    return {
      strategyId: this.strategyId,
      strategyType: 'reversalLadder',
      executionState: this.executionState,
      subState: this.subState,
      isRunning: this.isRunning,
      currentPrice: this.currentPrice,
      currentSide: this.currentSide,
      currentPosition: this.activePosition,
      finalTpPrice: this.finalTpPrice,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      reanchorCount: this.reanchorCount,
      initialCapital: this.initialCapital,
      harvestLossThreshold: this.harvestLossThreshold,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      // AI level planning (§10) — cost accounting only; the key is never here.
      aiCostUSD: this.aiCostUSD ?? 0,
      aiModel: this.aiModel,

      // Ladder state — see docstring: included here on every heartbeat
      // because mode/ladder transitions happen mid-cycle.
      mode: this.ladderMode,         // the frontend reads status.mode, not ladderMode
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      ladderLines: this.ladderLines,
      trendDirection: this.trendDirection,
      levelsPerSide: this.levelsPerSide,
      stepPct: this.stepPct,
      legNotional: this._legNotional(),
      ladderBaseSize: this._ladderBaseSize,
      // Trailing exit (§7).
      trailEnabled: this.trailEnabled ?? false,
      trailDistanceValue: this.trailDistanceValue ?? null,
      trailExit: this.trailExit ?? null,
      trendStartPrice: this.trendStartPrice ?? null,
      harvestTriggerPrice: this.harvestTriggerPrice ?? null,
      harvestTriggerAbove: this.harvestTriggerAbove ?? null,
      harvestTriggerAction: this.harvestTriggerAction ?? 'reanchor',
    };
  }

  /**
   * Immediate heartbeat broadcast — called from every bookkeeping path that
   * mutates TRUE LIVE state (trade fills via _postExecuteBookkeeping; ladder
   * rebuilds / mode transitions; harvest set/clear).
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
   *   - type: 'REVERSAL_LADDER' (queried by recoverActiveStrategies)
   *   - isRunning: true while the strategy is alive
   *   - gcfProxyUrl + sharedVmProxyGcfUrl (C4 — without these resume()
   *     can't reconstruct the Binance proxy)
   *   - _lastFundingPollTs (so the next poll uses the correct high-water
   *     mark instead of re-scanning the last 8h)
   */
  async saveState() {
    if (!this.firestore || !this.strategyId) return;
    try {
      const doc = {
        // Type tag for the boot-recovery scan.
        type: 'REVERSAL_LADDER',
        strategyType: 'reversalLadder',
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
        finalTpPrice: this.finalTpPrice,
        cycleAccumulatedLoss: this.cycleAccumulatedLoss,
        reversalCount: this.reversalCount,
        harvestCount: this.harvestCount,
        reanchorCount: this.reanchorCount,
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
        cycleStartTime: this.cycleStartTime,
        // strategyStartTime + strategyEndTime are read by the frontend
        // useStrategyCompletionListener to compute timeTaken on the in-app
        // Final-TP notification banner. Without them duration shows 'N/A'.
        strategyStartTime: this.strategyStartTime || null,
        strategyEndTime: this.strategyEndTime || null,
        leverage: this.leverage,
        // Strategy settings surfaced at top-level so the Historical tab's
        // summary card can render them without descending into config.
        // (HistoricalDataTab reads d.desiredProfitUSDT / d.positionSizeUSDT /
        // d.priceType / d.recoveryFactor etc. directly.)
        desiredProfitUSDT: this.desiredProfitUSDT,
        minDesiredProfitUSDT: this.minDesiredProfitUSDT,
        positionSizeUSDT: this.currentInitialSize,
        priceType: this.priceType,
        recoveryFactor: this.recoveryFactor,
        recoveryDistance: this.recoveryDistance,
        harvestLossThreshold: this.harvestLossThreshold,
        // ---- ladder state ----
        ladderMode: this.ladderMode,
        bullLevel: this.bullLevel,
        bearLevel: this.bearLevel,
        ladderLines: this.ladderLines,   // flat objects (Firestore-safe: no nested arrays)
        trendDirection: this.trendDirection,
        lastProcessedPrice: this.lastProcessedPrice,
        ladderBaseSize: this._ladderBaseSize,
        _lastLadderSize: this._lastLadderSize,
        // Armed manual harvest/re-anchor trigger (one-shot price level). Persist
        // so a VM restart / resume doesn't silently disarm it.
        harvestTriggerPrice: this.harvestTriggerPrice ?? null,
        harvestTriggerAbove: this.harvestTriggerAbove ?? null,
        harvestTriggerAction: this.harvestTriggerAction ?? 'reanchor',
        // Geometry is per-cycle config, not a constant — resume MUST rebuild the
        // ladder this cycle actually started with (see _applySnapshotGeometry).
        stepPct: this.stepPct,
        levelsPerSide: this.levelsPerSide,
        // Trailing exit (§7) — PERSISTED so a redeploy cannot silently disarm
        // it (see the field's own doc in the constructor).
        trailEnabled: this.trailEnabled ?? false,
        trailDistanceValue: this.trailDistanceValue ?? null,
        trailExit: this.trailExit ?? null,
        trendStartPrice: this.trendStartPrice ?? null,
        // AI level planning (§10) — cost accounting only. NEVER persist
        // `_aiApiKey` here: that would put a live credential in a database the
        // frontend can read (see the field's own doc in the constructor).
        aiCostUSD: this.aiCostUSD ?? 0,
        aiModel: this.aiModel,
        config: {
          recoveryFactor: this.recoveryFactor,
          recoveryDistance: this.recoveryDistance,
          harvestLossThreshold: this.harvestLossThreshold,
          desiredProfitUSDT: this.desiredProfitUSDT,
          initialSize: this.currentInitialSize,
        },
        criticalError: this.criticalError || null,
        lastUpdated: new Date(),
        updatedAt: Date.now(),
      };
      await this.firestore.collection('strategies').doc(this.strategyId).set(doc, { merge: true });
    } catch (err) {
      await this.addLog(`[LADDER] saveState error: ${err.message}`);
    }
  }

}

export { ReversalLadderStrategy };
export default ReversalLadderStrategy;
