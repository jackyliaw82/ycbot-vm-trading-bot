import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import wsBroadcast from './ws-broadcast.js';
import { FieldValue } from '@google-cloud/firestore';
import { FEE_RATE } from './fees.js';
import { VolumeProfile } from './volume-profile.js';
import { MarketMetrics } from './market-metrics.js';
import { BREAKOUT_PCT, resolveBreakoutGeometry, deriveBreakoutLevels } from './breakout-levels.js';
import { planBreakoutEntry } from './breakout-crossings.js';
import { planLevels } from './level-planner.js';
import { buildLevelContext } from './market-context.js';
import { precisionFormatter } from './precisionUtils.js';
import { trailDistance, trailExitLevel } from './breakout-trail.js';
import { AiPlanner } from './ai-planner.js';
import { AiUsageAccumulator } from './ai-cost.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const MARGIN_HEADROOM_FLOOR_PCT = 30;              // free margin floor for sizing safety
const HARVEST_LOSS_THRESHOLD_PCT = 0.08;           // 8% of initial capital — gate for HARVEST eligibility
const DEFAULT_RECOVERY_FACTOR = 0.20;
const DEFAULT_RECOVERY_DISTANCE = 0.005;           // 0.5%
// Backoff between level-planning attempts. Planning costs a volume-profile
// build plus five market-data fetches (and, from Task 6, an AI round trip), and
// it is driven from `handleRealtimePrice` — several ticks per second. A failed
// plan leaves the strategy flat with no entry levels, which is safe but idle,
// so the retry must be frequent enough to recover quickly and slow enough not
// to storm Binance.
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
 * BreakoutStrategy — single-entry breakout (one position per cycle leg, no
 * rungs, no reversals).
 *
 * This file has carried three designs. It started as AnchorLadderStrategy
 * (single anchor, LONG rungs above it / SHORT below). It was then rewritten
 * to a two-level reversal ladder — `bullLevel` above, `bearLevel` below, with
 * a dead zone between them, a position held across the whole zone and only
 * ever changing at the OTHER level via a reversal. Both of those were rung-
 * based ladders with scaling and a TREND mode. The breakout redesign deletes
 * all of that: a cycle now holds AT MOST ONE position, opened with a single
 * market order for the full base size at `bullBreakout` / `bearBreakout` —
 * each a fixed `breakoutPct` beyond the AI-planned `bullLevel` / `bearLevel`
 * — and closed either at the level (the stop, or its trailed variant once
 * ratcheted past entry — one mechanism, see `_stopOut`) or at the Final TP.
 * There is no rung ladder, no scaling, no TREND mode, and no reversal: a
 * close leaves the strategy FLAT, and the opposite side opens only if price
 * later reaches the opposite entry level (see `breakout-crossings.js`'s
 * `planBreakoutEntry` for the full entry rule).
 *
 * The levels themselves are DERIVED, not fixed geometry: `_planAndBuildLevels`
 * asks `planLevels` (level-planner.js) for a validated bull/bear pair, which
 * tries an AI planner first (`this._aiPlanner` — null until a later task wires
 * one in, so today it always falls through) and otherwise falls back to the
 * mechanical volume-profile void edges. A failed plan builds nothing and the
 * strategy stays flat with no entry levels.
 *
 * Everything else is infrastructure reused verbatim from the anchor era —
 * Binance REST/WS plumbing, position reconciliation, fill resolution, funding
 * polling, Firestore persistence, bookkeeping, dynamic sizing, the harvest
 * gauge, the Trigger Price and Close & stop actions, the Final TP editor, and
 * the unified stop()/Final-TP termination path.
 *
 * One-way mode means `openLeg` is bookkeeping only — Binance nets the single
 * filled leg into `activePosition`, so there are no partial closes anywhere
 * in this strategy. Every close (the stop, Final TP, harvest) is a full
 * reduceOnly close of that one netted position, via `_closeConsolidated`.
 */
class BreakoutStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // Cycle / position state
    this.strategyType = 'breakout';
    this.currentSide = null;                // 'LONG' | 'SHORT' | null
    this.activePosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
    // Set by _refreshCurrentPosition(): true when the LAST Binance position
    // fetch failed (state is UNKNOWN — never wiped to flat on failure), false
    // once a fetch succeeds. Read to tell "confirmed flat" apart from
    // "unknown" — by `_closeQuantity()`, by stop()'s residual verification,
    // and by `_recomputeFinalTpPrice`. It never gates a close: closes size
    // themselves from the legs, which need no fetch (see `_closeQuantity`).
    this._lastPositionRefreshFailed = false;
    this.finalTpPrice = null;
    this.cycleAccumulatedLoss = 0;
    this.harvestCount = 0;
    this.reanchorCount = 0;              // every completed _harvestToFlat (flat reset OR position harvest); FE spinner watches this
    this.initialCapital = 0;
    this.breakoutPct = BREAKOUT_PCT;
    this.bullBreakout = null;
    this.bearBreakout = null;
    // The single-row open-position ledger. This is what `_closeQuantity()`
    // reads. It is NOT `activePosition`: that comes from a REST refresh that
    // can fail, and an unknown state must never read as flat.
    this.openLeg = null;
    // One-shot gap latch. Set only when a close leaves price already beyond the
    // OPPOSITE entry level; consumed on the next tick. Deliberately NOT
    // persisted — it lives one tick, and firing it on stale intent after a
    // restart would open a position the market no longer justifies.
    this._pendingEntry = null;
    this.currentInitialSize = 0;         // base for DYNAMIC trend sizing (original config size; never overwritten → no compounding)
    this._positionBaseSize = 0;            // base the POSITION is sized from: initial size, then the dynamically re-sized base after a stop-out / harvest
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
    // POC/VAH/VAL/HVN edges. The strategy itself reads nothing from it.
    this.volumeProfile = null;              // VolumeProfile instance (built in start()/resume())
    this._lastVolumeProfile24h = null;
    // Volume Analytics cells, fed by MarketMetrics off the same 5-min refresh.
    // Display-only, exactly like the profile above: the strategy reads none of
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

    // ---- Level state ----
    this.bullLevel = null;              // upper trigger — L1 IS this price
    this.bearLevel = null;              // lower trigger — S1 IS this price
    this.reversalCount = 0;             // committed reversals this cycle
    this.stopOutCount = 0;              // verified stop-outs this cycle (feeds tradeCount — reversalCount never increments)
    this.lastProcessedPrice = null;     // last tick price the breakout crossing logic saw
    this._tradingSeqInProgress = false; // breakout crossing reentrancy guard
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
    // from an explicit start-request override OR (Phase 0a) Secret Manager via
    // _resolveAiApiKey(), and a persisted copy would put a live credential in
    // a database the frontend can read.
    this._aiApiKey = null;
    this._aiPlanner = null;
    this.aiModel = 'deepseek-v4-flash';
    this._aiUsage = new AiUsageAccumulator();
    this.aiCostUSD = 0;
    // Injectable seam for tests — _resolveAiApiKey() constructs a real
    // SecretManagerServiceClient on demand when this stays null.
    this._secretClient = null;

    // ---- Trailing exit (§7) ----
    // Give-back limiter for the held position. PERSISTED: a redeploy that
    // silently disarmed it would resume holding a runaway position the user
    // armed trailing to bound — a textbook fail-open. `trailExit` is persisted
    // too (not re-derived) because the ratchet is path-dependent: re-deriving
    // it from the live price after a restart would silently GIVE BACK every
    // tick of progress the ratchet had already locked in.
    this.trailEnabled = false;          // boolean — plain On/Off, direction comes from the position
    this.trailDistanceValue = null;     // number|null — fixed when the position opens
    this.trailExit = null;              // number|null — the live ratcheted exit level

    // ---- Phase 3: harvest-gauge cap ----
    this._lastPositionSize = null;        // last dynamic position base size (for gauge-full freeze)
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
    //                        walking away rather than re-planning levels.
    this.harvestTriggerAction = 'reanchor';   // 'reanchor' | 'stop'
  }

  /**
   * Which side is open, derived from the leg ledger. DERIVED, with a THROWING
   * setter — never a stored field. A stored copy is a second source of truth
   * for a fact `openLeg` already carries, and the two drift; that is exactly
   * the shape of bug this codebase already paid for once, when an "armed"
   * flag was a stored shadow of `finalTpPrice` instead of derived from it.
   */
  get heldSide() {
    return this.openLeg ? this.openLeg.direction : null;
  }

  set heldSide(_v) {
    throw new Error('heldSide is derived from openLeg — set or clear openLeg instead.');
  }

  /**
   * Recompute both entry levels from the AI-planned pair. Call after ANY change
   * to bullLevel/bearLevel/breakoutPct: cycle start, harvest re-plan, editLevels,
   * and resume.
   *
   * DERIVED, never persisted — see the getter above for why.
   *
   * Rounds to tick size here rather than in the pure module, because this is the
   * only layer that knows the symbol's exchange info. `trailDistance` reads the
   * ROUNDED levels, so the trail starts exactly on the exit level.
   */
  _deriveBreakoutLevels() {
    const raw = deriveBreakoutLevels(this.bullLevel, this.bearLevel, this.breakoutPct);
    this.bullBreakout = this.roundPrice(raw.bullBreakout);
    this.bearBreakout = this.roundPrice(raw.bearBreakout);
  }

  // ——— Lifecycle ——————————————————————————————————————————————————————

  /**
   * Start the strategy. Forces one-way position mode, subscribes to WS
   * streams, and builds the initial levels on the first price tick.
   */
  async start(config = {}) {
    // strategyId is set by app.js before calling start() (non-blocking pattern).
    if (!this.strategyId) {
      this.strategyId = `breakout_${this.profileId}_${Date.now()}`;
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
    this._positionBaseSize = this.currentInitialSize; // initial position uses the initial size; a harvest later carries the last consolidated notional

    if (!this.symbol) throw new Error('BreakoutStrategy.start: missing symbol');
    const geometry = resolveBreakoutGeometry({ breakoutPct: config.breakoutPct });
    if (!geometry.ok) {
      await this.addLog(`ERROR: [${geometry.code}] ${geometry.error}`);
      throw new Error(geometry.error);
    }
    this.breakoutPct = geometry.breakoutPct;

    // Absent key = mechanical levels from `rangeVoids`. That is a real,
    // supported mode (§10's fallback), not a degraded start — so log it and
    // continue rather than refusing.
    //
    // Phase 0a: config.aiApiKey stays as an explicit override — the existing
    // tests and any caller that wants to force a specific key still can —
    // but when it's absent the VM fetches the user's own key from Secret
    // Manager itself (_resolveAiApiKey) rather than requiring the browser to
    // carry it. A lookup failure there fails closed to null, same as "no key
    // supplied", never a thrown error.
    this.aiModel = config.aiModel || this.aiModel;
    let aiKeySource = null;
    if (typeof config.aiApiKey === 'string' && config.aiApiKey.trim() !== '') {
      this._aiApiKey = config.aiApiKey.trim();
      aiKeySource = 'the start request';
    } else {
      this._aiApiKey = await this._resolveAiApiKey();
      if (this._aiApiKey) aiKeySource = 'Secret Manager';
    }
    if (this._aiApiKey) {
      this._aiPlanner = new AiPlanner(this._aiApiKey, this.aiModel);
      await this.addLog(`AI level planning enabled (${this.aiModel}, key from ${aiKeySource}).`);
    } else {
      await this.addLog(
        `no AI key supplied — levels will come from the mechanical volume-void edges.`,
      );
    }

    await this.addLog(`Starting Breakout Strategy for ${this.symbol}...`);
    // Surface EVERY config field — used to verify the form values made it
    // through to the VM untouched. Three groups separated by `|` for
    // readability: identity/sizing | recovery knobs | advanced toggles.
    await this.addLog(
      `Config: symbol=${this.symbol}, initialSize=${this.currentInitialSize} USDT, ` +
      `leverage=${this.leverage}x, priceType=${this.priceType}, ` +
      `breakoutPct=${(this.breakoutPct * 100).toFixed(2)}% ` +
      `| recoveryFactor=${(this.recoveryFactor * 100).toFixed(0)}%, ` +
      `recoveryDistance=${(this.recoveryDistance * 100).toFixed(2)}%, ` +
      `harvestLossThreshold=${(this.harvestLossThreshold * 100).toFixed(0)}%, ` +
      `desiredProfitUSDT=${this.desiredProfitUSDT}`
    );

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // One-way (single-side) mode. The strategy holds LONG legs ONLY above
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
    // ONE order for the whole size, so there is one floor to clear rather than
    // one per rung. The old minimum scaled with the ladder's rung count;
    // there are no rungs, so it does not.
    if (this.currentInitialSize < minNotional) {
      const msg =
        `Initial size ${this.currentInitialSize} USDT is below ${this.symbol}'s minimum notional ` +
        `(${minNotional} USDT). Raise the size rather than running a position Binance will reject.`;
      await this.addLog(`ERROR: [SIZE_BELOW_MIN_NOTIONAL] ${msg}`);
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

    // WebSocket setup — listen key first, then user-data + realtime price.
    // No liquidation WS: the strategy's geometry / sizing math never reads
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

    await this.addLog('BreakoutStrategy running — awaiting the first tick to plan levels.');
    await this.saveState();
    // Push immediately — one harmless extra heartbeat moments before the
    // first tick's own push from _applyLevels(). Synchronous + internally
    // try/caught, so no await (see _pushHeartbeatNow's own doc).
    this._pushHeartbeatNow?.();
  }

  /**
   * Apply a validated level pair for a new cycle. The single writer of
   * `bullLevel`/`bearLevel` on a fresh build, and the trigger for deriving the
   * breakout entry levels from them.
   *
   * Callers must have validated the pair already (planLevels does, and refuses
   * to return an invalid one). `_deriveBreakoutLevels` (via `deriveBreakoutLevels`
   * in breakout-levels.js) throws on bad geometry rather than silently building
   * something unreachable — that throw is a real bug signal and must not be
   * swallowed here.
   */
  async _applyLevels({ bullLevel, bearLevel, reason = 'cycle_start' }) {
    this.bullLevel = bullLevel;
    this.bearLevel = bearLevel;
    this._deriveBreakoutLevels();
    // Nulling finalTpPrice clears any previous target — the new levels have
    // no position behind them yet.
    this.finalTpPrice = null;
    this._clearTrail();
    this.lastProcessedPrice = this.currentPrice;

    await this.addLog(`===== LEVELS SET (${reason}) =====`);
    await this.addLog(
      `BULL ${this._formatPrice(bullLevel)} | BEAR ${this._formatPrice(bearLevel)} | ` +
      `dead zone ${(((bullLevel - bearLevel) / bearLevel) * 100).toFixed(2)}% | ` +
      `breakout ${(this.breakoutPct * 100).toFixed(2)}% | entries ${this._formatPrice(this.bullBreakout)} / ${this._formatPrice(this.bearBreakout)} | ` +
      `position ${this._formatNotional(this._positionBaseSize)} USDT`,
    );
    await this.saveState();
    this._pushHeartbeatNow?.();
  }

  /**
   * Resolve this profile's DeepSeek API key from Secret Manager (Phase 0a).
   *
   * The key travels users/{userId}/profiles/{profileId} -> a persisted
   * `deepseekApiKeySecretName` (a FULL Secret Manager resource path, same
   * shape as the existing `binanceApiKeySecretName` field) -> the secret's
   * `latest` version. A separate work item owns writing that field; this
   * method only reads it.
   *
   * Two DISTINCT outcomes both return `null`, and must stay visibly distinct
   * in the logs (see CLAUDE.md's silent-fail-open rule):
   *   - "the user supplied no key" — no doc, or the field absent/empty. This
   *     is a normal, supported configuration (the mechanical volume-void
   *     fallback), NOT an error, so it logs nothing here.
   *   - "we could not tell whether a key exists" — Firestore unreachable,
   *     the secret deleted, IAM denied, etc. This is an UNKNOWN state that
   *     must not silently read as "no key" without a trace, so it logs a
   *     WARNING naming the failure (never the key) before returning null.
   *
   * MUST NEVER THROW. start() has no surrounding try/catch around its AI
   * block, and resume() explicitly documents (see the tombstone above
   * _applySnapshotGeometry) that an unguarded throw there escapes into
   * app.js's recoverActiveStrategies() .catch(), which marks the strategy
   * stopped and abandons a live position. The outer try/catch below is
   * belt-and-braces on top of the two narrower ones for exactly that reason.
   */
  async _resolveAiApiKey() {
    if (!this.firestore || !this.userId || !this.profileId) return null;

    try {
      let secretName;
      try {
        const snap = await this.firestore
          .collection('users').doc(this.userId)
          .collection('profiles').doc(this.profileId)
          .get();
        secretName = snap?.exists ? snap.data()?.deepseekApiKeySecretName : null;
      } catch (err) {
        await this.addLog(
          `WARNING: AI key lookup failed (profile read: ${err.message}) — ` +
          `treating this cycle as if no key was supplied.`,
        );
        return null;
      }

      if (typeof secretName !== 'string' || secretName.trim() === '') return null;

      try {
        const client = this._secretClient || new SecretManagerServiceClient();
        const [version] = await client.accessSecretVersion({ name: `${secretName.trim()}/versions/latest` });
        const value = version?.payload?.data?.toString('utf8').trim();
        return value ? value : null;
      } catch (err) {
        await this.addLog(
          `WARNING: AI key lookup failed (secret access: ${err.message}) — ` +
          `treating this cycle as if no key was supplied.`,
        );
        return null;
      }
    } catch (err) {
      // Should be unreachable given the two narrower try/catches above, but
      // this method's one hard contract is that it never throws — see the
      // docstring. A bug here must degrade to "no key", not escape.
      console.error(`_resolveAiApiKey: unexpected failure: ${err.message}`);
      return null;
    }
  }

  /**
   * Plan a level pair and derive both breakout entry levels from it.
   *
   * Returns false when no valid pair could be produced — and when it returns
   * false NOTHING is built, so the strategy stays flat with no entry levels and
   * the tick gate retries on the throttle. That is deliberate: trading without
   * levels has no entry trigger and no exit boundary, so "we could not plan"
   * must never read as "proceed".
   *
   * `false` really does mean nothing was built, even on the unlikely path where
   * `_applyLevels` throws AFTER assigning `this.bullBreakout`/`this.bearBreakout`
   * (its own trailing addLog/saveState calls already self-catch, so this is
   * defense in depth, not a realistic trigger today) — checked below via
   * `this.bullBreakout`/`this.bearBreakout` being non-null rather than by
   * whether the surrounding try completed, because BOTH callers (the
   * empty-levels gate and `_harvestToFlat`) guarantee both are `null` before
   * calling this, so non-null values after a throw can only mean
   * `_applyLevels` itself already assigned them.
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
        await this.addLog(`level planning note: ${result.error}`);
      }
      await this.addLog(
        `levels from ${result.source} — bull ${this._formatPrice(result.bullLevel)} / ` +
        `bear ${this._formatPrice(result.bearLevel)}` +
        (result.rationale ? ` — ${result.rationale}` : ''),
      );

      // The pair was validated against the price as it stood BEFORE
      // buildLevelContext's six network fetches. Price can have left the band
      // in that window, and _applyLevels stamps lastProcessedPrice from the
      // LIVE price — so levels built now could sit entirely on one side of
      // price, and the next tick back through the level would open a position
      // in the wrong direction. Re-check against the live price rather than
      // trusting a snapshot that is seconds old; the throttle re-plans.
      const live = this.currentPrice;
      if (!Number.isFinite(live) || !(result.bearLevel < live && live < result.bullLevel)) {
        await this.addLog(
          `level planning (${reason}) discarded — price moved to ` +
          `${this._formatPrice(live)}, outside the proposed band ` +
          `${this._formatPrice(result.bearLevel)}–${this._formatPrice(result.bullLevel)} ` +
          `while the market context was being fetched. Re-planning.`,
        );
        return false;
      }

      await this._applyLevels({ bullLevel: result.bullLevel, bearLevel: result.bearLevel, reason });
      this._levelPlanLastTs = null;   // succeeded: no throttle carried forward
      return true;
    } catch (err) {
      // See the docstring above: a throw after _applyLevels already assigned
      // the levels must still report success, never the "nothing was built"
      // false that every caller relies on.
      if (this.bullBreakout != null && this.bearBreakout != null) {
        await this.addLog(`WARNING: level planning (${reason}) built the levels but a trailing step failed: ${err.message}`);
        this._levelPlanLastTs = null;
        return true;
      }
      await this.addLog(`ERROR: level planning (${reason}) failed for ${this.symbol}: ${err.message}`);
      return false;
    } finally {
      this._levelPlanInProgress = false;
    }
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
   * The quantity every close places — summed from the OPEN LEG, never read
   * off `activePosition`.
   *
   * TOMBSTONE — do NOT "simplify" this back to `activePosition.quantity`.
   * `_openPosition` books `openLeg.quantity` from the ACTUAL user-data WS
   * fill, so the leg is a WS-true record of what this bot has opened, and it
   * needs no network call — it cannot 503. `activePosition.quantity` is
   * written ONLY by `_refreshCurrentPosition` (REST): when that fails it keeps
   * whatever it held BEFORE the failure, which can sit UNDER what Binance
   * really holds (the open's own post-fill refresh 503'd — the leg is booked,
   * the position is not). Closing that stale figure orphans the remainder.
   * THREE rounds of bugs came from exactly this, each patched with another
   * "refuse to close on unknown state" guard in a caller; sizing from the leg
   * removes the cause, so none of those guards are needed.
   *
   * `activePosition` is kept only as a FLOOR, for the opposite drift (a
   * position with no leg behind it: the leg wiped by a flatten whose close
   * died before `saveState`, or a position opened outside the bot). reduceOnly
   * can never flip a position, so an over-sized close is clamped by Binance and
   * harmless while an under-sized one orphans — max() is fail-safe on both.
   */
  _closeQuantity() {
    const restQty = (this.activePosition && this.activePosition.quantity) || 0;
    // The one question REST still answers better than the leg: Binance was
    // REACHABLE and reported flat, so an open leg is stale bookkeeping and there
    // is genuinely nothing to close. Detection, NOT a refusal — when the state is
    // UNKNOWN this falls through and closes what the leg knows.
    if (!restQty && !this._lastPositionRefreshFailed) return 0;
    const legQty = (this.openLeg && this.openLeg.quantity) || 0;
    // reduceOnly can never flip a position, so an over-sized close is clamped by
    // Binance and harmless while an under-sized one orphans — max() is fail-safe
    // on both. roundQuantity FLOORS on stepSize, cleaning FP noise without
    // overshooting the real position.
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
      || this.openLeg?.direction
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
    this.openLeg = null;
    return true;
  }

  // Harvest gauge is full once accumulated loss reaches the configured threshold of initial capital.
  _isGaugeFull() {
    return this.initialCapital > 0
      && this.cycleAccumulatedLoss >= this.harvestLossThreshold * this.initialCapital;
  }

  /**
   * Dynamic re-basing of the position's notional, applied on every stop-out
   * and harvest (formerly the old grid's scaled-entry sizing formula — same
   * recovery-formula + margin-headroom-cap + gauge-full freeze, repurposed
   * for a single consolidated entry per cycle).
   *
   * Async: fetches the LIVE margin balance for the headroom cap rather than
   * trusting a cached snapshot. Called only from `_stopOut` /
   * `_harvestToFlat` — both async, both at reset points, a handful of
   * times per cycle, never in a hot loop — so the extra round trip is cheap
   * and buys a correct-during-drawdown headroom figure instead of a frozen
   * cycle-start one.
   */
  async _computePositionBaseSize() {
    this.cycleAccumulatedLoss = this._computeAccLoss();
    // Gauge-full escalation freeze: once the gauge is full, stop GROWING live
    // exposure — reuse the last (grown) size. This is the gauge's sole remaining
    // job: a re-anchor/harvest at a full gauge keeps the locked size, at a
    // not-full gauge re-sizes fresh.
    if (this._isGaugeFull() && this._lastPositionSize != null) {
      return this._lastPositionSize;
    }
    const proposed = this._computeFormulaSize();
    let walletBalance;
    try {
      walletBalance = await this.getTotalMarginBalance();
    } catch (err) {
      // FAIL CLOSED: an unknown margin balance must never read as "plenty of
      // headroom". Cap to the safe floor (currentInitialSize) rather than
      // falling back to a stale/guessed figure.
      await this.addLog(`margin-headroom cap: getTotalMarginBalance() failed (${err.message}) — capping to currentInitialSize (fail-closed).`);
      const floor = this.currentInitialSize || 0;
      this._lastPositionSize = floor;
      return floor;
    }
    const sized = this._applyMarginHeadroomCap(proposed, walletBalance);
    this._lastPositionSize = sized;
    return sized;
  }

  /**
   * Open the cycle's one position — a single market order for the full base
   * size. Replaces the old ladder's rung-fill, which opened one rung of many.
   *
   * Books from the ACTUAL user-data WS fill (`_resolveFill`, which falls back to
   * a REST order lookup), never the requested qty. A requested quantity that was
   * only partially filled would leave `openLeg` claiming more than exists, and
   * every later close would size off that lie.
   */
  async _openPosition(side) {
    if (this.openLeg) {
      throw new Error(`_openPosition(${side}) refused — a ${this.openLeg.direction} position is already open.`);
    }
    const notional = this._positionBaseSize;
    const level = side === 'LONG' ? this.bullBreakout : this.bearBreakout;
    const qty = await this._quantityFor(this.symbol, notional, level);
    const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

    const res = await this.placeMarketOrder(this.symbol, orderSide, qty); // one-way: no positionSide
    const fill = await this._resolveFill(res?.orderId, res, qty, level);

    this.openLeg = {
      direction: side,
      quantity: fill.filledQty,
      fillPrice: fill.fillPrice,
      openedAt: this.currentPrice,
    };

    // The ONLY human-readable record that a position opened. `_writeStrategyFlow`
    // (fired by `_postExecuteBookkeeping` below) feeds the chart, not the strategy
    // log — so without this line an entry is invisible to anyone reading the log,
    // while its close still appears from `_closeConsolidated`. The deleted
    // `_fillLeg` logged every rung; dropping it here made a cycle look like it
    // closed a position it never opened.
    await this.addLog(
      `OPEN ${side} qty ${fill.filledQty} @ ${this._formatPrice(fill.fillPrice)} ` +
      `| breakout ${this._formatPrice(level)} ` +
      `| exit ${this._formatPrice(side === 'LONG' ? this.bullLevel : this.bearLevel)} ` +
      `| ${this._formatNotional(this._positionBaseSize)} USDT | fill from ${fill.source}.`,
    );

    await this._postExecuteBookkeeping('OPEN_BREAKOUT', { side, level, requestedQty: qty, filledQty: fill.filledQty });
    await this.saveState();
  }

  /**
   * Arm the trail at the moment the position opens. The distance is fixed
   * here and never recomputed, which is what makes the exit start exactly at
   * the entry level and move 1:1 with price from there — no tuning knob,
   * self-scaling across symbols.
   *
   * A no-op when trailing is off, so `trailExit` stays null and
   * `_updateTrailAndCheckHit` falls back to the plain pinned stop. Gated on
   * `openLeg` (the single-row ledger), not a deleted mode field. Safe to call
   * twice.
   */
  _armTrail() {
    if (!this.trailEnabled || !this.openLeg) {
      this.trailDistanceValue = null;
      this.trailExit = null;
      return;
    }
    const side = this.heldSide;
    const d = trailDistance(side, {
      bullLevel: this.bullLevel, bearLevel: this.bearLevel,
      bullBreakout: this.bullBreakout, bearBreakout: this.bearBreakout,
    });
    if (d == null || !(d > 0)) {
      // An unusable distance must leave the trail DISARMED, never guessed.
      this.trailDistanceValue = null;
      this.trailExit = null;
      return;
    }
    this.trailDistanceValue = d;
    this.trailExit = trailExitLevel({
      price: this.openLeg.fillPrice, distance: d, side,
      bullLevel: this.bullLevel, bearLevel: this.bearLevel, previous: null,
    });
  }

  /** Clear the trail. Called on every stop-out (plain or trailed), level rebuild, and toggling the trail off. */
  _clearTrail() {
    this.trailDistanceValue = null;
    this.trailExit = null;
  }

  /**
   * The strategy's ONLY stop check while a position is held. Returns true
   * when price has reached the current exit level.
   *
   * The stop and the trailed exit are ONE mechanism, not two. With trailing
   * DISARMED the level is pinned at bullLevel/bearLevel and this behaves as a
   * plain stop; with it ARMED, the level ratchets via `trailExitLevel` and can
   * lock profit above the entry. Either way `_stopOut` owns the close — the
   * caller does not need to know which framing produced the hit.
   */
  _updateTrailAndCheckHit(price) {
    const side = this.heldSide;
    if (!side) return false;

    // With trailing DISARMED the stop still exists — it just never ratchets.
    // Pin it to the exit level so this one branch serves both framings.
    if (!this.trailEnabled) {
      const stop = side === 'LONG' ? this.bullLevel : this.bearLevel;
      if (!Number.isFinite(stop)) return false;
      this.trailExit = stop;
      return side === 'LONG' ? price <= stop : price >= stop;
    }

    if (this.trailDistanceValue == null) return false;
    const next = trailExitLevel({
      price, distance: this.trailDistanceValue, side,
      bullLevel: this.bullLevel, bearLevel: this.bearLevel, previous: this.trailExit,
    });
    if (next == null) return false;
    this.trailExit = next;
    return side === 'LONG' ? price <= next : price >= next;
  }

  /**
   * The cycle's only non-terminal exit: close and go flat, cycle continues.
   *
   * Serves both framings of the same level — a stop at bullLevel/bearLevel when
   * trailing is disarmed, and a ratcheted trailed exit when it is armed.
   *
   * Returns false when the close could not be VERIFIED, in which case the caller
   * must not advance `lastProcessedPrice`. `_closeConsolidated` leaves `openLeg`
   * intact on an unverified close, so the position stays tracked and the exit
   * retries on the next tick. Do NOT clear `openLeg` here.
   */
  async _stopOut(price) {
    // Capture BEFORE the close — _closeConsolidated nulls openLeg, and the latch
    // must never re-arm the side that just closed.
    const closedSide = this.heldSide;

    let closed = false;
    try { closed = await this._closeConsolidated('stop_out'); }
    catch (e) { await this.addLog(`ERROR stop-out close: ${e.message}`); }

    if (!closed && this._closeQuantity() > 0) {
      await this.addLog(
        'WARNING: stop-out aborted — the close could not be verified; the position was left TRACKED. ' +
        'It will retry on the next tick.',
      );
      await this.saveState();
      this._pushHeartbeatNow?.();
      return false;
    }

    this._clearTrail();

    // Only a VERIFIED close is a real stop-out — mirrors the harvestCount gate
    // in `_harvestToFlat`. `closed` can still be false here with nothing left
    // to abort on (the abort guard above only fires when `_closeQuantity() >
    // 0`), which means there was genuinely nothing open to stop out of.
    if (closed) this.stopOutCount = (this.stopOutCount || 0) + 1;

    // Gap latch. A single tick can carry price past the OPPOSITE entry level on
    // the very tick that stopped us out; the two-tick rule means that side opens
    // NEXT tick, not this one. Only ever the opposite side: with the trail able
    // to ratchet past the entry, a profitable exit routinely lands beyond the
    // level we just traded, and latching that side would re-enter uncommanded.
    // Not persisted — it is valid for one tick only.
    if (closedSide === 'LONG' && price <= this.bearBreakout) this._pendingEntry = 'SHORT';
    else if (closedSide === 'SHORT' && price >= this.bullBreakout) this._pendingEntry = 'LONG';
    else this._pendingEntry = null;

    this._positionBaseSize = await this._computePositionBaseSize();
    await this._postExecuteBookkeeping('STOP_OUT', { price, pendingEntry: this._pendingEntry });
    await this.saveState();
    return true;
  }

  /**
   * Turn the trailing exit on or off. Accepted at any time while running: it is
   * a state change, not an action. Switching it on while a position is held
   * arms it now; switching it off clears the ratchet so a later re-arm starts
   * fresh rather than inheriting a stale level from a different position.
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
      `trailing exit ${enabled ? 'ON' : 'OFF'}` +
      (enabled && this.trailExit != null ? ` — exit at ${this._formatPrice(this.trailExit)}` : ''),
    );
    return { trailEnabled: this.trailEnabled, trailExit: this.trailExit };
  }

  /**
   * Restore the trail from a snapshot. Its own method because it holds an
   * invariant worth testing, and `resume()` cannot be exercised in a unit test.
   *
   * Carry-forward 1: never TRUST the persisted exit — re-clamp it into the
   * RESTORED band, FLOOR-ONLY, mirroring `trailExitLevel`'s own semantics
   * (see breakout-trail.js): `Math.max(bullLevel, exit)` for a LONG,
   * `Math.min(bearLevel, exit)` for a SHORT. There is deliberately NO upper
   * cap — Task 3 removed the two-sided ladder-era clamp everywhere else
   * specifically so the trail can ratchet PAST the entry level and lock a
   * real profit, and this restore must not throw that profit away by pulling
   * a persisted exit of, say, 105 (locked above a bullLevel of 100) back down
   * to 100 — that would turn a resume during a favourable retrace into a
   * silently discarded protective exit. The levels can still have moved since
   * the snapshot was written (a manual edit or an applied Ask AI proposal
   * narrows the band), which is exactly why this still clamps at the floor
   * rather than trusting the raw persisted value outright.
   *
   * The side comes from `this.openLeg` (Critical 1 — restored earlier in
   * `resume()`, before this call, specifically so it is available here). A
   * flat run has no held side and therefore no meaningful exit level.
   *
   * `trailEnabled` restores from an EXPLICIT `=== true` only: a missing or
   * malformed field is unknown, and unknown must never read as armed.
   */
  _restoreTrailFromSnapshot(snapshot = {}) {
    this.trailEnabled = snapshot.trailEnabled === true;
    this.trailDistanceValue = Number.isFinite(snapshot.trailDistanceValue) ? snapshot.trailDistanceValue : null;
    const exit = snapshot.trailExit;
    const side = this.openLeg ? this.openLeg.direction : null;
    if (!Number.isFinite(exit) || side == null) {
      this.trailExit = null;
      return;
    }
    if (side === 'LONG' && Number.isFinite(this.bullLevel)) {
      this.trailExit = Math.max(this.bullLevel, exit);
    } else if (side === 'SHORT' && Number.isFinite(this.bearLevel)) {
      this.trailExit = Math.min(this.bearLevel, exit);
    } else {
      this.trailExit = null;
    }
  }

  /**
   * Manual harvest — close whatever is open (nothing, if already flat),
   * clear both levels, re-plan a fresh bull/bear pair, dynamic-size. Unlike
   * the stop (which closes AT bullLevel/bearLevel and leaves those same
   * levels standing for the opposite side to open at) a harvest closes at an
   * ARBITRARY live price, so keeping the old pair would leave price sitting
   * on top of a trigger and refill it immediately — both levels are cleared
   * and re-planned from scratch. accLoss is NOT reset (real carried loss);
   * the gauge only empties if realized PnL reduces cycleAccumulatedLoss on
   * its own.
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
      // Name the price this fired at. For a price_trigger that is the level the
      // market actually reached — read BEFORE the close, because the close and
      // the re-plan both move on from here and the log would otherwise describe
      // the trigger with a price from after it fired. Without this the line said
      // only "RE-ANCHOR (price_trigger)" and there was no way to tell, from the
      // log alone, what price had hit.
      const firedAt = Number.isFinite(this.currentPrice) ? ` @ ${this._formatPrice(this.currentPrice)}` : '';
      await this.addLog(`===== ${kind} (${detail})${firedAt} — flatten + re-plan levels =====`);

      // Self-gating and self-sizing (see `_closeQuantity`). This matters most
      // here of all the close paths: the harvest RE-ANCHORS, so anything left
      // behind would net against a geometry it was never part of.
      let closed = false;
      try { closed = await this._closeConsolidated('harvest'); }
      catch (e) { await this.addLog(`ERROR ${kind} close: ${e.message}`); }

      // TOMBSTONE — a failed close MUST abort the rebuild. The re-plan below
      // rebuilds bullLevel/bearLevel from scratch, and openLeg is the ONLY
      // record of what this bot has open (`_closeQuantity` sizes every close
      // from it). Rebuilding after a failed close ORPHANS a live position: it
      // stays open on Binance while the bot's books read "flat, fresh levels" and
      // nothing ever tries to close it again. Leave openLeg INTACT instead, so
      // the position stays tracked and the harvest can be retried. `_stopOut`
      // carries this same guard — no close path in this strategy may wipe its
      // leg ledger on a close it could not verify. Do NOT rethrow here:
      // `handleRealtimePrice` awaits this without a catch, so a throw would escape
      // the WS tick handler.
      //
      // `closed === true` now means the close was VERIFIED — `_closeConsolidated`
      // tiers WS fill marker -> full REST-ack qty -> REST position check before
      // returning true, and returns `false` on anything unverified. That `false`
      // is exactly what this guard catches, so an unconfirmed fill can no longer
      // slip past it (shared contract with `_stopOut`).
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
          `WARNING: ${kind} (${reason}) ABORTED — the close did not complete, so the position was left ` +
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
      this._positionBaseSize = await this._computePositionBaseSize();
      await this.addLog(
        `Post-${kind} base ${this._formatNotional(this._positionBaseSize)} USDT → ` +
        `position ${this._formatNotional(this._positionBaseSize)} USDT (accLoss ${this._formatNotional(this.cycleAccumulatedLoss)}).`,
      );

      // Re-plan the levels: a harvest closes at an arbitrary live price, so
      // keeping the old pair would leave price sitting on top of a trigger and
      // refill it immediately. A failed re-plan leaves the strategy with no
      // entry levels, which is safe — the tick gate retries on the throttle
      // and nothing trades meanwhile. `openLeg`/`_pendingEntry` are cleared
      // here too — `_closeConsolidated` already nulls `openLeg` on a VERIFIED
      // close (the only way this line is reached, per the abort guard above),
      // so this is defense in depth; `_pendingEntry` is a one-tick latch that
      // must not survive into the freshly re-planned levels.
      //
      // CRITICAL 2 — bullBreakout/bearBreakout MUST be nulled here too, not
      // just bullLevel/bearLevel. The tick gate in `handleRealtimePrice` keys
      // off `this.bullBreakout == null || this.bearBreakout == null` to decide
      // whether to re-plan; leaving them non-null after a re-plan FAILURE (a
      // throttle, the AI planner unavailable, or the price-staleness discard
      // inside `_planAndBuildLevels`) would leave that gate permanently
      // satisfied, so the strategy would never re-plan again and would keep
      // trading last cycle's stale entry levels indefinitely with bullLevel/
      // bearLevel null — which also silences BOTH stop framings in
      // `_updateTrailAndCheckHit` (untrailed: `!Number.isFinite(null)`;
      // trailed: `trailDistanceValue` derives from the null levels too),
      // leaving only Final TP and a manual stop as exits.
      this.openLeg = null;
      this._pendingEntry = null;
      this.bullLevel = null;
      this.bearLevel = null;
      this.bullBreakout = null;
      this.bearBreakout = null;
      await this._planAndBuildLevels(reason);

      // The audit label reflects what ACTUALLY happened (keyed off `closed`), not
      // the pre-close `kind` guess — so a stale-open-but-actually-flat run records
      // as a RE-ANCHOR here, consistent with the counter above. The opening log
      // above keeps the pre-close `kind` as a best-effort "attempting" label.
      const finalKind = closed ? kind : 'RE-ANCHOR';
      await this._writeStrategyFlow('HARVEST', {
        reason, kind: finalKind, closingPnl, flat: !closed, reanchorCount: this.reanchorCount,
        bullLevel: this.bullLevel, bearLevel: this.bearLevel, baseSize: this._positionBaseSize,
      }).catch(() => {});
      await this.saveState();
      return true;
    } finally {
      this._tradingSeqInProgress = false;
    }
  }

  /**
   * Restore breakout geometry from a persisted snapshot.
   *
   * This MUST come from the snapshot, not the constant. A cycle started at 2%
   * that resumed at the 1% default would arm entry levels the cycle never
   * agreed to. Validation is delegated to resolveBreakoutGeometry — the SAME
   * single definition of "valid geometry" that start() and the HTTP route use
   * (see its docstring in breakout-levels.js). Its `?? DEFAULT` fallback covers
   * the genuinely-absent (null/undefined) case only; a PRESENT-but-invalid
   * value (corrupted Firestore data, a hand-edited doc, 0, NaN, a numeric
   * string) is NOT the same as absent — silently coercing it to the default
   * would read "unknown" as "safe". That is exactly the silent-fail-open shape
   * this codebase forbids (see CLAUDE.md), so this throws instead: resume()
   * has no surrounding try/catch around this call, so the throw rejects the
   * resume() promise, and app.js's recoverActiveStrategies() already treats a
   * rejected resume() as a hard recovery failure — isRunning:false +
   * criticalError persisted, strategy NOT added to activeStrategies — rather
   * than silently running with the wrong geometry.
   */
  _applySnapshotGeometry(snapshot = {}) {
    const geometry = resolveBreakoutGeometry({ breakoutPct: snapshot.config?.breakoutPct ?? snapshot.breakoutPct });
    if (!geometry.ok) {
      throw new Error(`[RECOVERY] ${geometry.error}`);
    }
    this.breakoutPct = geometry.breakoutPct;
  }

  /**
   * Resume a strategy from a Firestore snapshot. Called by app.js boot-scan
   * (recoverActiveStrategies) when a `type: 'BREAKOUT'` doc has
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
    // MIGRATION GUARD. Boot recovery resumes both the new `breakout_` prefix
    // and the legacy `reversal_ladder_` prefix (see breakout-recovery.js), so
    // this code may still be handed a pre-breakout ladder snapshot. An
    // incompatible snapshot is UNKNOWN state and must not read as safe:
    // resuming one would restore a rung ledger this class no longer has,
    // leaving any open position untracked.
    if (Array.isArray(snapshot?.ladderLines) || snapshot?.breakoutPct == null) {
      const msg =
        `[RECOVERY] REFUSING to resume ${snapshot?.strategyId ?? 'strategy'}: the saved state predates the ` +
        `breakout redesign (ladderLines present or breakoutPct missing). It must be stopped and restarted manually. ` +
        `Any position it holds is STILL OPEN on Binance and is NOT being tracked.`;
      await this.addLog(msg);
      throw new Error(msg);
    }

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

    await this.addLog(`[RECOVERY] Resuming Breakout Strategy after restart...`);

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

    // ---- cycle levels ----
    this.bullLevel = snapshot.bullLevel ?? null;
    this.bearLevel = snapshot.bearLevel ?? null;
    // The single-row open-position ledger (Critical 1) — restored HERE, before
    // both the trail restore below (which needs the held side to re-clamp the
    // ratchet to the correct floor) and `_recomputeFinalTpPrice()` further down
    // (which needs `heldSide`, derived from this, to resolve entry/exit
    // direction). Without this a restart mid-position resumed with
    // openLeg/heldSide both null, which silently dropped the Final TP, the
    // stop and the trail, AND let `_openPosition` open a SECOND full-size
    // position on the next crossing (its own `if (this.openLeg)` guard read
    // null as "nothing open").
    this.openLeg = snapshot.openLeg ?? null;
    // Trailing exit (§7) — restored AFTER bullLevel/bearLevel AND openLeg: the
    // restore re-clamps the persisted exit into the just-restored band and
    // needs the held side (carry-forward 1).
    this._restoreTrailFromSnapshot(snapshot);
    this.lastProcessedPrice = snapshot.lastProcessedPrice ?? null;
    this._positionBaseSize = snapshot.ladderBaseSize || this.currentInitialSize; // grown position base survives restarts (else it shrinks to initial)
    this._lastPositionSize = snapshot._lastPositionSize ?? null;
    this._applySnapshotGeometry(snapshot);
    // Entry levels are DERIVED, never persisted (see _deriveBreakoutLevels).
    // Recompute now that both the pair and breakoutPct are restored. Guarded:
    // a strategy resumed before its first tick ever planned a pair has null
    // levels, and deriveBreakoutLevels throws on a null input.
    if (this.bullLevel != null && this.bearLevel != null) {
      this._deriveBreakoutLevels();
    }

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
    this.stopOutCount = snapshot.stopOutCount || 0;
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

    // The API key is deliberately NOT persisted — a live credential does not
    // belong in a database the frontend can read (see the constructor doc) —
    // so a resumed cycle re-fetches it from Secret Manager via the profile
    // doc, exactly like start(). _resolveAiApiKey fails closed to null on any
    // lookup problem (Firestore unreachable, secret deleted, IAM denied) —
    // NEVER a thrown error: an unguarded throw here would escape resume()
    // into app.js's recoverActiveStrategies() .catch(), which marks the
    // strategy stopped and abandons a live position (see the tombstone
    // above _applySnapshotGeometry).
    this._aiApiKey = await this._resolveAiApiKey();
    if (this._aiApiKey) {
      this._aiPlanner = new AiPlanner(this._aiApiKey, this.aiModel);
      await this.addLog(`[RECOVERY] AI level planning enabled (${this.aiModel}, key from Secret Manager).`);
    } else {
      await this.addLog(
        `[RECOVERY] no AI key supplied — levels will come from the mechanical volume-void edges.`,
      );
    }

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
      // One-way (single-side) mode — mirrors start(). The strategy holds LONG
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
    // interval + health monitor. No liquidation WS: the strategy's geometry
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
      console.error(`L3 reconcile on resume failed: ${err.message}`);
    });

    // Reconcile position from Binance (source of truth).
    //
    // ⚠️ Do NOT reinstate a bare `await this.detectCurrentPosition(true)` here.
    // It used to sit on this line and was a CRITICAL bug: detectCurrentPosition()
    // THROWS on an API error (so that "flat" and "unknown" stop being the same
    // value), and an unguarded throw escapes resume() into app.js's recovery
    // .catch(), which sets isRunning:false. Boot recovery queries
    // where('isRunning','==',true) — so ONE transient 503 during a redeploy
    // permanently abandoned a live position: still open on Binance, untracked,
    // no Final TP, and no stop-loss by design. Never retried, because the doc
    // had already been marked stopped.
    //
    // _refreshCurrentPosition() makes the identical detectCurrentPosition(true)
    // call inside a try that sets _lastPositionRefreshFailed, which every
    // consequential reader consults (including `_recomputeFinalTpPrice` below).
    // The bare call was pure redundancy that defeated exactly the machinery
    // built for this case.
    await this._refreshCurrentPosition();

    // Reconcile a persisted `openLeg` against what Binance actually reports —
    // the SAME flat-vs-unknown protocol `_closeQuantity()` already encodes,
    // applied to the one piece of restored state the refresh above does NOT
    // touch. `_closeConsolidated` nulls `openLeg` in memory, but the
    // `saveState()` that persists that null runs several `await`s later; a
    // crash in that window leaves the LAST-persisted snapshot holding a
    // non-null `openLeg` for a position Binance has already closed.
    // `activePosition`/`currentSide` get re-derived from Binance by the
    // refresh just above, but `openLeg` was restored verbatim from the
    // snapshot with no reconciliation of its own — so a phantom leg would
    // otherwise survive FOREVER: `heldSide` stays truthy, `_openPosition`
    // refuses every new entry, and every tick's stop-out is a silent no-op
    // (`_closeQuantity()` reads 0, so `_stopOut` returns `true` without ever
    // touching `openLeg`). No bad order is ever placed — `_closeQuantity()`'s
    // reachable-and-flat guard sees to that — so this is an availability bug,
    // not a fund-safety one, but the bot stops trading until someone notices
    // and manually Harvests to self-heal it.
    //
    // The asymmetry below is deliberate — do NOT "simplify" this into clearing
    // on both branches. Binance REACHABLE + FLAT is the ONLY case where a
    // leftover leg can be proven a crash-window artifact. When the refresh
    // FAILED, the state is UNKNOWN, not flat — keeping a real position's
    // ledger is the far cheaper mistake than silently discarding one that
    // turns out to still be open (see the file-level SILENT FAIL-OPEN rule).
    if (this.openLeg) {
      if (this._lastPositionRefreshFailed) {
        await this.addLog(
          `[RECOVERY] openLeg ${this.openLeg.direction} qty ${this.openLeg.quantity} kept — the Binance ` +
          `position refresh failed, so this state is UNKNOWN, not flat.`,
        );
      } else if (!(this.activePosition && this.activePosition.quantity > 0)) {
        await this.addLog(
          `[RECOVERY] openLeg ${this.openLeg.direction} qty ${this.openLeg.quantity} discarded — Binance ` +
          `confirms flat, so this is a crash-window artifact (the close landed before saveState persisted it).`,
        );
        this.openLeg = null;
      }
      // else: Binance reports a live position matching the leg — it is real, keep it.
    }

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

    // A resumed position with trailing on but no usable distance must re-arm
    // rather than run untrailed — the user armed it to bound this position.
    if (this.trailEnabled && this.openLeg && this.trailDistanceValue == null) {
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
    // /breakout/stop route AND the tick loop's Final TP check in
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
      // Flatten the net one-way position via `_closeConsolidated` — ONE
      // reduceOnly market order. One-way mode nets the single filled leg into
      // `activePosition`; there is no per-leg close, and `_closeConsolidated`
      // self-gates and self-sizes off `_closeQuantity()`, so there is nothing
      // to branch on here.
      //
      // Source-of-truth refresh FIRST, before deciding what (if anything) is
      // open. In-memory `activePosition` can be null while Binance still
      // holds a position (a transient API error makes `getCurrentPositions()`
      // return [] indistinguishable from flat, a missed WS update, a partial
      // restart) — nothing below may conclude "there is nothing to close"
      // from memory alone.
      try {
        await this._refreshCurrentPosition();
      } catch (err) {
        await this.addLog(`stop: pre-flatten position refresh failed: ${err.message}`);
      }

      // closedSomething reflects an ACTUAL close, never a leg marking — see
      // `_closeConsolidated`'s own return contract. The residual verification
      // below ALWAYS runs afterwards regardless of its value.
      let closedSomething = false;
      const closeReason = reason === 'final_tp' ? 'final_tp' : 'user-stop';
      try {
        closedSomething = await this._closeConsolidated(closeReason);
      } catch (err) {
        await this.addLog(`stop: flatten failed: ${err.message}`);
      }
      // Only claim "nothing to flatten" when Binance actually ANSWERED and
      // there is genuinely nothing to close. Saying it while the state is
      // unknown, or while a close attempt just threw over a live quantity,
      // reads as false reassurance.
      if (!closedSomething && !this._lastPositionRefreshFailed && !this._closeQuantity()) {
        await this.addLog('stop: no open position on Binance — nothing to flatten');
      }

      // Residual verification — ALWAYS runs, regardless of which branch (if
      // any) closed something above: a close call can throw, partially
      // fill, or race a fill event, so Binance is the only source of truth
      // for whether the position is actually flat. Never terminate silently
      // with a position still open.
      try {
        await this._refreshCurrentPosition();
      } catch (err) {
        await this.addLog(`stop: post-flatten position refresh failed: ${err.message}`);
      }
      // TOMBSTONE — the flag check MUST come first. This block used to lead
      // with `activePosition` and then `else if (closedSomething) ->
      // "confirmed flat"`, so a stop whose refresh never succeeded reported
      // "position confirmed flat" purely because a close had been ATTEMPTED:
      // `_closeConsolidated` nulls `activePosition` unconditionally, the
      // refresh above then fails and leaves it null, and null was read as
      // flat. The FINAL-STATE-UNKNOWN arm below was unreachable in exactly
      // the case it existed for, because it sat last AND keyed on legs that
      // a close had already wiped. The user must NEVER be told
      // "confirmed flat" when the position state is unknown — an unverified
      // stop is the last moment anyone is watching.
      if (this._lastPositionRefreshFailed) {
        // Never terminate silently: state is still UNKNOWN after the
        // post-flatten refresh. Report whatever bookkeeping survives —
        // a deliberately-untouched leg and/or the last-known position — as
        // the loudest signal we can give before the strategy terminates.
        const legQty = (this.openLeg && this.openLeg.quantity) || 0;
        const lastKnown = this.activePosition && this.activePosition.quantity > 0
          ? `last-known position ${this.currentSide} ${this.activePosition.quantity}`
          : 'no position in memory (which is NOT proof of flat — the refresh failed)';
        await this.addLog(
          `WARNING: stop: FINAL STATE UNKNOWN for ${this.symbol} — Binance could not be reached to confirm ` +
          `flat${closedSomething ? ' after a close was attempted' : ''}. openLeg qty ${legQty} remains tracked; ` +
          `${lastKnown}. Verify manually on Binance.`
        );
      } else if (this.activePosition && this.activePosition.quantity > 0) {
        await this.addLog(`WARNING: stop+flatten left residual ${this.currentSide} ${this.activePosition.quantity} ${this.symbol} on Binance — close it manually`);
      } else if (closedSomething) {
        await this.addLog('stop: position confirmed flat');
      }

      // Final TP: write the strategyFlow audit record + metricsSample so
      // the frontend chart can mark the exit. Manual stops skip this to
      // avoid changing existing audit-log cadence.
      if (reason === 'final_tp') {
        try {
          await this._postExecuteBookkeeping('FINAL_TP_HIT', { exitPrice });
        } catch (bkErr) {
          console.error(`FINAL_TP_HIT bookkeeping failed: ${bkErr.message}`);
        }
      }
    }

    // Clear position-derived state. Done after the optional flatten so
    // `_refreshCurrentPosition` had real fields to work against.
    this.activePosition = null;
    this.currentSide = null;
    this.openLeg = null;
    this._pendingEntry = null;

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
      console.error(`final funding poll failed: ${err.message}`);
    }

    // Release the user-data listen key + drop both WS streams.
    try {
      if (typeof this.cleanupWebSockets === 'function') this.cleanupWebSockets();
    } catch (err) {
      console.error(`cleanupWebSockets failed: ${err.message}`);
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
        console.error(`platform fee error: ${feeErr.message}`);
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
      ? 'Final TP — cycle complete, strategy terminated.'
      : 'stop: terminated');

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
          tradeCount: this.tradeCount || (this.stopOutCount + this.harvestCount + (reason === 'final_tp' ? 1 : 0)),
          timeTaken: elapsed,
          realizedPnL: this.accumulatedRealizedPnL || 0,
          tradingFees: this.accumulatedTradingFees || 0,
          fundingFees: this.accumulatedFundingFees || 0,
        });
      } catch (notifyErr) {
        console.error(`notify error: ${notifyErr.message}`);
      }
    }

    // CRITICAL: invokes the app.js callback that does
    // `activeStrategies.delete(strategyId)`. Without this, the next start
    // attempt for this profile is rejected with "already running".
    try { this.onStopComplete?.(); } catch (e) {
      console.error('onStopComplete hook failed:', e.message);
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
          console.error(`no-trade cleanup: ${name} delete failed: ${subErr.message}`);
        }
      }
      await strategyRef.delete();
      console.log(`no-trade cycle ${this.strategyId} — strategy doc deleted (not persisted as completed).`);
    } catch (err) {
      console.error(`no-trade doc delete failed for ${this.strategyId}: ${err.message} — falling back to saveState()`);
      this.willBeDeleted = false;
      try { await this.saveState(); } catch (saveErr) {
        console.error(`fallback saveState also failed: ${saveErr.message}`);
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
      console.error(`hero-profit record failed: ${err.message}`);
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
    // MUST stay above `_dispatchTick` below: its Final TP and stop branches
    // both return, so anything after them never runs. Parked here this covers
    // a held position, since a stop-out clears activePosition via
    // `_closeConsolidated` a few lines down.
    if (this.activePosition) this._updateUnrealizedPnL(price);

    // ---- Level gate: plan the pair and derive the entry levels. ----
    // Unlike the deleted anchor, levels are DERIVED from market data, so this
    // can fail. It returns false and builds nothing when it does; we then trade
    // nothing this tick rather than guessing a level.
    if (this.bullBreakout == null || this.bearBreakout == null) {
      await this._planAndBuildLevels('cycle_start');
      return;
    }

    if (this._tradingSeqInProgress) return; // do NOT advance lastProcessedPrice: re-scan this band next tick

    // ---- Tick mutual exclusion. ----
    // The `_tradingSeqInProgress` check above is NOT sufficient on its own:
    // nothing sets that flag until an action branch deep inside the dispatch
    // below, and there is an await in between (`_harvestToFlat`) across which
    // a SECOND WS tick can enter, pass the very same gate, and execute the
    // very same branch. (Historically this double-counted a ladder-era
    // counter and wrote a duplicate audit row; no duplicate ORDER was ever
    // possible — reduceOnly plus the open-leg re-check in `_openPosition`
    // cover that.)
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
    // level. Placed here with the manual latch, BEFORE the exit/entry
    // dispatch below, so it takes precedence over the normal action on this
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

    // ---- Exit 1: Final TP -> close + STOP. The cycle ends. ----
    if (this.heldSide && this.finalTpPrice && this._checkFinalTpHit(price)) {
      this._tradingSeqInProgress = true;
      try { await this.stop({ flatten: true, reason: 'final_tp' }); }
      finally { this._tradingSeqInProgress = false; }
      return;
    }

    // ---- Exit 2: the stop. With trailing disarmed this level never moves off
    // bullLevel/bearLevel, so this single branch is both the near-level stop and
    // the trailed exit — they are one mechanism, not two.
    if (this.heldSide && this._updateTrailAndCheckHit(price)) {
      this._tradingSeqInProgress = true;
      let ok = false;
      try { ok = await this._stopOut(price); } finally { this._tradingSeqInProgress = false; }
      if (!ok) return;              // unverified close: re-scan this band next tick
      this.lastProcessedPrice = price;
      return;                       // two-tick rule: open nothing on this tick
    }

    // ---- Entry. ----
    const plan = planBreakoutEntry({
      prevPrice: this.lastProcessedPrice,
      currentPrice: price,
      bullBreakout: this.bullBreakout,
      bearBreakout: this.bearBreakout,
      heldSide: this.heldSide,
      pendingEntry: this._pendingEntry,
    });

    if (plan.open) {
      this._tradingSeqInProgress = true;
      try {
        await this._openPosition(plan.open);
        this._pendingEntry = null;   // consumed only once the open actually succeeded
        this._armTrail();
        await this._recomputeFinalTpPrice();
      } finally { this._tradingSeqInProgress = false; }
    } else if (plan.clearPending) {
      this._pendingEntry = null;     // price returned inside the band — intent is stale
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
      `manual profit-target adjust: ${pct}% → ${this._formatNotional(newUSDT)} USDT ` +
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
    const side = this.currentSide;
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
   * straight past the `_lastPositionRefreshFailed` guard, and because the Final
   * TP exit gate in `_dispatchTick` is `if (this.heldSide && this.finalTpPrice
   * && ...)` the guessed target would be ACTED ON. Back-solving keeps that
   * invariant intact for free.
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
        `Final TP reset to the config target — desired profit ` +
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

    // Set the TARGET directly, without a level. This is the path that works
    // while FLAT — where there is no position to back-solve a price from, but
    // the profit target still matters: it is what `_recomputeFinalTpPrice`
    // will derive the Final TP from the moment a position next opens.
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
      this._recomputeFinalTpPrice();   // null while flat by design — armed once a position opens
      await this.saveState();
      this._pushHeartbeatNow?.();
      await this.addLog(
        `profit target ${this._formatNotional(prev)} → ${this._formatNotional(want)} USDT ` +
        (this.finalTpPrice ? `(Final TP ${this._formatPrice(this.finalTpPrice)}).` : '(no position yet — applies once a position opens).'),
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
      `Final TP moved to ${this._formatPrice(this.finalTpPrice ?? px)} — desired profit ` +
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
   * sizing (see `_computePositionBaseSize`).
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
      return { harvesting: true, queued: true, price: this.currentPrice };
    }

    // With a price → arm a one-shot trigger. The VM is the authority on
    // validity (mirrors the breakout-geometry bounds philosophy): validate,
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
      `${action === 'stop' ? 'PROTECT' : 'harvest'} trigger armed @ ${this._formatPrice(rounded)} ` +
      `(fires when price ${this.harvestTriggerAbove ? '>=' : '<='} ${this._formatPrice(rounded)}` +
      `${action === 'stop' ? ' — closes and ENDS the cycle' : ' — closes and re-anchors'}).`,
    );
    return { armed: true, triggerPrice: rounded, above: this.harvestTriggerAbove, action };
  }

  /**
   * Cancel an armed harvest/re-anchor Trigger Price. No-op-safe (idempotent).
   * Called by the /breakout/cancel-harvest-trigger route.
   */
  async cancelHarvestTrigger() {
    const had = this.harvestTriggerPrice != null;
    this.harvestTriggerPrice = null;
    this.harvestTriggerAbove = null;
    this.harvestTriggerAction = 'reanchor';
    if (had) {
      await this.saveState();
      this._pushHeartbeatNow?.();
      await this.addLog('harvest trigger cancelled.');
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
   *  2. A side with a filled leg cannot move. openLeg is the only record of
   *     what is open (`_closeQuantity` sizes every close from it) — moving
   *     the geometry under it orphans live inventory.
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
    // position is open and the trail has ratcheted past its entry level, price
    // is legitimately OUTSIDE the band by construction, so re-validating the
    // untouched side against live price would refuse every edit exactly when
    // the user most wants one. The untouched side cannot have become invalid
    // on its own — it has not moved — and the side price HAS run past is
    // filled, which the filled-leg refusal below rejects anyway.
    // `nextBull > nextBear` is checked unconditionally: an inverted pair has
    // no dead zone at all.
    if (movingBull && !(nextBull > price)) {
      throw invalidInput(`bullLevel must be above the current price (${this._formatPrice(price)}).`);
    }
    if (movingBear && !(nextBear < price)) {
      throw invalidInput(`bearLevel must be below the current price (${this._formatPrice(price)}).`);
    }
    if (!(nextBull > nextBear)) {
      throw invalidInput(`bullLevel (${this._formatPrice(nextBull)}) must be above bearLevel (${this._formatPrice(nextBear)}).`);
    }

    if (movingBull && this.openLeg?.direction === 'LONG') {
      throw new Error('A LONG position is open — close it before moving the bull level.');
    }
    if (movingBear && this.openLeg?.direction === 'SHORT') {
      throw new Error('A SHORT position is open — close it before moving the bear level.');
    }
    if (!movingBull && !movingBear) {
      return { bullLevel: this.bullLevel, bearLevel: this.bearLevel, changed: false };
    }

    this.bullLevel = nextBull;
    this.bearLevel = nextBear;
    this._deriveBreakoutLevels();

    // Carry-forward: the band just moved, so a stored ratchet value may now sit
    // on the wrong side of its floor. Pull it back rather than letting a stale
    // value win forever. The distance itself is re-derived by _armTrail, which
    // Task 6 owns.
    if (this.openLeg && Number.isFinite(this.trailExit)) {
      this.trailExit = this.openLeg.direction === 'LONG'
        ? Math.max(this.bullLevel, this.trailExit)
        : Math.min(this.bearLevel, this.trailExit);
    }

    await this.addLog(
      // Name the re-derived ENTRIES, not just the levels. Editing bullLevel moves
      // bullBreakout with it, and that entry is where the next order actually
      // fills — a log that reports only the level leaves the fill price looking
      // like it came from nowhere. "rebuilt" was ladder language; nothing is
      // rebuilt now, the levels simply move.
      `levels edited — BULL ${this._formatPrice(this.bullLevel)} / ` +
      `BEAR ${this._formatPrice(this.bearLevel)} | entries ` +
      `${this._formatPrice(this.bullBreakout)} / ${this._formatPrice(this.bearBreakout)} ` +
      `(moved: ${[movingBull && 'bull', movingBear && 'bear'].filter(Boolean).join(' + ')}).`,
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
   * Caller (_computePositionBaseSize) is responsible for refreshing accumulators
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
   * Margin-headroom projection — simulate 2 more stop-outs at current
   * trajectory; if projected freeMargin% < MARGIN_HEADROOM_FLOOR_PCT, cap
   * the proposed new size back to currentInitialSize.
   *
   * `wallet` MUST be the live totalMarginBalance (see `_computePositionBaseSize`,
   * the sole caller) — never a cached snapshot. A cached figure over-estimates
   * headroom exactly during drawdown, when the cap matters most.
   */
  _applyMarginHeadroomCap(proposedSize, wallet) {
    // Fail CLOSED on an unknown wallet balance. The `getTotalMarginBalance()`
    // call site already throws (caught by `_computePositionBaseSize`) on a
    // hard API failure, but a 200 response with a missing/malformed field
    // parses to NaN WITHOUT throwing — belt-and-braces here too. An unknown
    // balance must NEVER read as "infinite headroom" (the previous
    // `wallet <= 0 -> return proposedSize` fell through to exactly that for
    // NaN, since `NaN <= 0` is false).
    if (!Number.isFinite(wallet) || wallet <= 0) {
      const floor = this.currentInitialSize || 0;
      void this.addLog(`margin-headroom cap: wallet balance invalid/unknown (${wallet}) — capping to ${floor} (fail-closed).`);
      return floor;
    }
    const proposedNotional = proposedSize;
    const usedMargin = (this.activePosition?.notional || 0) / Math.max(1, this.leverage);
    const proposedMarginUse = proposedNotional / Math.max(1, this.leverage);
    // Pessimistic: assume two more stop-outs at same proposed size.
    const projectedUsed = usedMargin + proposedMarginUse * 2;
    const projectedFreePct = ((wallet - projectedUsed) / wallet) * 100;
    if (projectedFreePct < MARGIN_HEADROOM_FLOOR_PCT) {
      const floor = this.currentInitialSize || 0;
      void this.addLog(`margin-headroom cap: proposed=${proposedSize} projectedFree=${projectedFreePct.toFixed(2)}% < ${MARGIN_HEADROOM_FLOOR_PCT}% → capped to ${floor}`);
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
   * Side resolution mirrors `_checkFinalTpHit`: key off `heldSide` — derived
   * from `openLeg`, the single-row close ledger set the instant `_openPosition`
   * fills — rather than `currentSide` alone. `currentSide` is only ever
   * populated by `_refreshCurrentPosition()` (a REST call) or restored from a
   * snapshot, so on a boot-recovery race keying on it alone could leave
   * finalTpPrice null even with a position already recorded.
   */
  _recomputeFinalTpPrice() {
    // SINGLE CHOKE POINT — the only writer of finalTpPrice that derives a
    // target, and therefore the right place to enforce "a target may only be
    // derived from Binance-VERIFIED position data".
    //
    // TOMBSTONE — do NOT drop this guard and re-guard the call sites instead.
    // This method has four callers, three of which (`_pollFundingIncome`,
    // `adjustProfitTarget`, `resume`) fire on schedules and user actions that
    // have nothing to do with a fresh open, and every one of them used to be
    // unguarded. When the last refresh failed, `activePosition` is whatever it
    // was BEFORE the failure (a stale qty/entry), so a target derived from it
    // is a guess — and because the exit gate in `_dispatchTick` is
    // `if (this.heldSide && this.finalTpPrice && ...)`, that guess would be
    // ACTED ON: an 8-hourly funding settlement or the user nudging the
    // profit-target pencil would silently resurrect an unverified target and
    // close the cycle at it. Refusing here means every caller — including any
    // future one — inherits the invariant instead of having to remember it.
    //
    // Nulling (rather than leaving the previous value) is the point: it keeps
    // "unverified" and "unarmed" the same state, so the position simply has no
    // Final TP target until the next successful recompute (the retried refresh
    // inside `_postExecuteBookkeeping` after an open, the next funding poll, or
    // a user edit) — it never trades on a guess.
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
    // needed = accLoss + desiredProfit + estimatedClosingFee + aiCost
    //
    // The aiCost term is BACK. It was removed when the AI stack was deleted for
    // AnchorLadder ("there is no AI"), but the breakout strategy plans its levels
    // with DeepSeek and the frontend now counts that spend in the cycle's Net. Without
    // this term the two disagree by exactly the AI cost: the cycle would close at
    // Final TP reporting a Net BELOW the target the user asked for, every time,
    // and the shortfall would grow with each Ask AI / re-plan.
    //
    // Note this is denominated in USD while everything else here is USDT. They
    // are treated 1:1 — the drift is a fraction of a cent on a sub-dollar figure,
    // far below the tick rounding applied downstream.
    const estimatedClosingFee = notional * FEE_RATE;
    const needed = (this.cycleAccumulatedLoss || 0)
      + (this.desiredProfitUSDT || 0)
      + estimatedClosingFee
      + (this.aiCostUSD || 0);
    if (!entry || qty <= 0) {
      this.finalTpPrice = null;
      return;
    }
    const side = this.heldSide;
    if (side == null) {
      this.finalTpPrice = null;
      return;
    }
    if (side === 'LONG') {
      this.finalTpPrice = entry + needed / qty;
    } else if (side === 'SHORT') {
      this.finalTpPrice = entry - needed / qty;
    } else {
      this.finalTpPrice = null;
    }
  }

  // Keys off `heldSide` — derived from `openLeg`, the single-row close
  // ledger — rather than `currentSide` (exchange-derived via
  // `_refreshCurrentPosition`, which can still be unresolved on a
  // boot-recovery race even though the leg is already recorded). Mirrors
  // `_recomputeFinalTpPrice`'s side resolution; the two must stay in
  // agreement.
  _checkFinalTpHit(price) {
    if (!this.finalTpPrice) return false;
    const side = this.heldSide;
    if (side === 'LONG') return price >= this.finalTpPrice;
    if (side === 'SHORT') return price <= this.finalTpPrice;
    return false;
  }

  // ——— Trade fill reconciliation ——————————————————————————————————————

  /**
   * Post-execute bookkeeping hook. Called after the position opens
   * (_openPosition), after a stop-out (_stopOut), and after the
   * FINAL_TP_HIT close in stop(), once the order/close resolves on
   * Binance. (`_harvestToFlat` does its own inline bookkeeping — accLoss
   * recompute + saveState + strategyFlow — since it doesn't go through a
   * single order/fill path.)
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
      // The breakout OPEN leaves a fresh position on Binance; pass
      // expectNonEmpty so _refreshCurrentPosition RETRIES against REST lag
      // (Binance's /fapi/v2/account routinely takes 100-500ms to reflect a
      // market-order fill). Without the retry a lagged read returns null with
      // _lastPositionRefreshFailed still false — which _closeQuantity() reads
      // as "reachable and flat" and would answer 0 for a position we just
      // opened. STOP_OUT / HARVEST / FINAL_TP close the position and expect
      // empty, so they take no retry.
      const expectNonEmpty = actionType === 'OPEN_BREAKOUT';
      await this._refreshCurrentPosition(expectNonEmpty);
      this.cycleAccumulatedLoss = this._computeAccLoss();
      this._recomputeFinalTpPrice();
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
      console.error(`_postExecuteBookkeeping error: ${err.message}`);
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
      console.error(`_writeStrategyFlow failed: ${err.message}`);
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
      console.error(`funding poll error: ${err.message}`);
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
          console.log(`_refreshCurrentPosition: REST returned empty post-trade; retry ${attempt}/5 after 300ms`);
          await new Promise((r) => setTimeout(r, 300));
          await this.detectCurrentPosition(true);
          side = this.currentPosition;
          qty = this.currentPositionQuantity;
          entryPrice = this.positionEntryPrice;
          if ((side === 'LONG' || side === 'SHORT') && qty && qty > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
            console.log(`_refreshCurrentPosition: REST resolved non-empty on attempt ${attempt}/5`);
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
      await this.addLog(`_refreshCurrentPosition error: ${err.message} — position state UNKNOWN, NOT treated as flat.`);
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
   * primitives (CVD / orderbook depth / ATR). Display-only — the strategy is
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

  // ——— Status snapshot (consumed by /breakout/status) ——————————————

  getStatus() {
    // acc-loss is purely derived from the live (Binance-truth) accumulators, so
    // refresh it on read — the displayed gauge then always matches the Cycle PnL
    // Net regardless of which trade path last ran (grid crossings, harvest, ...).
    this.cycleAccumulatedLoss = this._computeAccLoss();
    return {
      strategyId: this.strategyId,
      strategyType: 'breakout',
      symbol: this.symbol,
      // Price precision (decimals) from the cached exchange info, so the frontend
      // formats ALL prices (bull/bear levels, breakout entries, trigger inputs) at the pair's
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
      stopOutCount: this.stopOutCount || 0,
      initialCapital: this.initialCapital,
      currentInitialSize: this.currentInitialSize,
      desiredProfitUSDT: this.desiredProfitUSDT,
      minDesiredProfitUSDT: this.minDesiredProfitUSDT,
      // AI level planning (§10) — cost accounting only. The key itself
      // (`_aiApiKey`) is NEVER surfaced here — see its constructor doc.
      aiCostUSD: this.aiCostUSD ?? 0,
      aiModel: this.aiModel,

      // Breakout state — the frontend's status/chart view renders these
      // directly.
      breakoutPct: this.breakoutPct,
      bullBreakout: this.bullBreakout,
      bearBreakout: this.bearBreakout,
      openLeg: this.openLeg,
      heldSide: this.heldSide,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      positionBaseSize: this._positionBaseSize,
      // Trailing exit (§7).
      trailEnabled: this.trailEnabled ?? false,
      trailDistanceValue: this.trailDistanceValue ?? null,
      trailExit: this.trailExit ?? null,
      // Running config — surfaced so the frontend's Active Config panel
      // can show the values the bot is ACTUALLY using rather than the
      // form's DEFAULT_CONFIG (which is what the ladder-era frontend used
      // to read, producing a wrong picture when a strategy was started
      // with non-default settings and the user later refreshed the page).
      leverage: this.leverage,
      priceType: this.priceType,
      recoveryFactor: this.recoveryFactor,
      recoveryDistance: this.recoveryDistance,
      harvestLossThreshold: this.harvestLossThreshold,
      _lastPositionSize: this._lastPositionSize,
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
      // Without this, the SS vertical dotted line never draws on refresh.
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
   * Breakout/position fields (bullLevel/bearLevel/bullBreakout/bearBreakout/
   * openLeg/heldSide, finalTpPrice, ...) ARE included here because entries,
   * exits and trail ratchets happen mid-cycle, and the frontend merges
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
      strategyType: 'breakout',
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
      stopOutCount: this.stopOutCount || 0,
      initialCapital: this.initialCapital,
      harvestLossThreshold: this.harvestLossThreshold,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,
      // AI level planning (§10) — cost accounting only; the key is never here.
      aiCostUSD: this.aiCostUSD ?? 0,
      aiModel: this.aiModel,

      // Breakout state — included here on every heartbeat because entry/exit
      // transitions happen mid-cycle.
      breakoutPct: this.breakoutPct,
      bullBreakout: this.bullBreakout,
      bearBreakout: this.bearBreakout,
      openLeg: this.openLeg,
      heldSide: this.heldSide,
      bullLevel: this.bullLevel,
      bearLevel: this.bearLevel,
      positionBaseSize: this._positionBaseSize,
      // Trailing exit (§7).
      trailEnabled: this.trailEnabled ?? false,
      trailDistanceValue: this.trailDistanceValue ?? null,
      trailExit: this.trailExit ?? null,
      harvestTriggerPrice: this.harvestTriggerPrice ?? null,
      harvestTriggerAbove: this.harvestTriggerAbove ?? null,
      harvestTriggerAction: this.harvestTriggerAction ?? 'reanchor',
    };
  }

  /**
   * Immediate heartbeat broadcast — called from every bookkeeping path that
   * mutates TRUE LIVE state (trade fills via _postExecuteBookkeeping; level
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
   *   - type: 'BREAKOUT' (queried by recoverActiveStrategies)
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
        type: 'BREAKOUT',
        strategyType: 'breakout',
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
        // The single-row open-position ledger (Critical 1). Without this a
        // restart mid-position resumes with openLeg/heldSide both null, which
        // drops the Final TP/stop/trail AND lets `_openPosition` open a SECOND
        // full-size position on the next crossing (its `if (this.openLeg)`
        // guard reads null as "nothing open"). A flat object, not an array —
        // Firestore rejects nested arrays but this shape is fine.
        openLeg: this.openLeg,
        finalTpPrice: this.finalTpPrice,
        cycleAccumulatedLoss: this.cycleAccumulatedLoss,
        reversalCount: this.reversalCount,
        harvestCount: this.harvestCount,
        reanchorCount: this.reanchorCount,
        stopOutCount: this.stopOutCount,
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
        // ---- level state ----
        bullLevel: this.bullLevel,
        bearLevel: this.bearLevel,
        lastProcessedPrice: this.lastProcessedPrice,
        ladderBaseSize: this._positionBaseSize,
        _lastPositionSize: this._lastPositionSize,
        // Armed manual harvest/re-anchor trigger (one-shot price level). Persist
        // so a VM restart / resume doesn't silently disarm it.
        harvestTriggerPrice: this.harvestTriggerPrice ?? null,
        harvestTriggerAbove: this.harvestTriggerAbove ?? null,
        harvestTriggerAction: this.harvestTriggerAction ?? 'reanchor',
        // Geometry is per-cycle config, not a constant — resume MUST restore the
        // percentage and re-derive the entry levels from it. The levels
        // themselves are DERIVED and deliberately NOT persisted.
        breakoutPct: this.breakoutPct,
        // Trailing exit (§7) — PERSISTED so a redeploy cannot silently disarm
        // it (see the field's own doc in the constructor).
        trailEnabled: this.trailEnabled ?? false,
        trailDistanceValue: this.trailDistanceValue ?? null,
        trailExit: this.trailExit ?? null,
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
      await this.addLog(`saveState error: ${err.message}`);
    }
  }

}

export { BreakoutStrategy };
export default BreakoutStrategy;
