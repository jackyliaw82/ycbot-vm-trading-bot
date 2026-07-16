import { TradingBase, DEFAULT_LEVERAGE } from './trading-base.js';
import { sendStrategyCompletionNotification } from './pushNotificationHelper.js';
import wsBroadcast from './ws-broadcast.js';
import { FieldValue } from '@google-cloud/firestore';
import { FEE_RATE } from './fees.js';
import { VolumeProfile } from './volume-profile.js';
import { buildLadder, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE, MIN_INITIAL_SIZE_USDT } from './ladder-levels.js';
import { planLadderActions, averageOpenEntry } from './ladder-crossings.js';

const MARGIN_HEADROOM_FLOOR_PCT = 30;              // free margin floor for sizing safety
const HARVEST_LOSS_THRESHOLD_PCT = 0.30;           // 30% of initial capital — gate for HARVEST eligibility
const DEFAULT_RECOVERY_FACTOR = 0.20;
const DEFAULT_RECOVERY_DISTANCE = 0.005;           // 0.5%

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
 * AnchorLadderStrategy — fully mechanical anchor-ladder strategy.
 *
 * This file was copied from ai-dual-strategy.js and stripped: every AI consult
 * path (planner / risk-guard / market-context / plan-executor / the AI
 * provider client), the reversal machinery, and the whole UNWIND mode are
 * gone. What remains is infrastructure that already works and is reused
 * verbatim — Binance REST/WS plumbing, position reconciliation, fill
 * resolution, funding polling, Firestore persistence, bookkeeping, and the
 * unified stop()/Final-TP termination path.
 *
 * TRADES CORRECTLY as of Task 7. Task 6 built the ladder geometry
 * (initializeLadder, _legNotional, one-way position mode, the size gate).
 * Task 7 replaced the tick dispatch and the trading actions it drives:
 *
 *   Task 6 — build the ladder on the anchor (buildLadder: 0.3% × 5 levels/side) [DONE]
 *   Task 7 — tick handling (planLadderActions), leg fills (_fillLeg), the
 *            anchor-flatten reset (_flattenAtAnchor), and the outermost-leg
 *            -> TREND transition (_enterTrend) [DONE]
 *
 * One-way mode means a "leg" is bookkeeping only — Binance nets every filled
 * leg into a single `activePosition`, so there are no partial closes anywhere
 * in this strategy. Every close (anchor flatten, Final TP, harvest) is a full
 * reduceOnly close of that one netted position, via `_closeConsolidated`.
 *
 * No AI is consulted anywhere: levels are pure geometry off the anchor.
 */
class AnchorLadderStrategy extends TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    super(gcfProxyUrl, profileId, sharedVmProxyGcfUrl);

    // Cycle / position state
    this.strategyType = 'anchorLadder';
    this.currentSide = null;                // 'LONG' | 'SHORT' | null
    this.activePosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
    // Set by _refreshCurrentPosition(): true when the LAST Binance position
    // fetch failed (state is UNKNOWN — never wiped to flat on failure), false
    // once a fetch succeeds. stop()'s flatten path and _flattenGrid() read
    // this to avoid treating a failed refresh as a confirmed-flat position.
    this._lastPositionRefreshFailed = false;
    this.finalTpPrice = null;
    this.cycleAccumulatedLoss = 0;
    this.reversalCount = 0;
    this.harvestCount = 0;
    this.initialCapital = 0;
    this.currentInitialSize = 0;         // base for DYNAMIC trend sizing (original config size; never overwritten → no compounding)
    this._ladderBaseSize = 0;            // base the LADDER is sized from: initial size, then the dynamically re-sized base after an anchor flatten / harvest
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

    // Volume profile — chart-only. Refreshed by _refreshVolumeSnapshot from
    // the salvaged VolumeProfile module so the frontend chart can overlay
    // POC/VAH/VAL/HVN edges. The ladder itself reads nothing from it.
    this.volumeProfile = null;              // VolumeProfile instance (built in start()/resume())
    this._lastVolumeProfile24h = null;
    // Legacy Volume Analytics cells. No producer remains (the AI market-context
    // fetchers that populated them are gone), so these stay null and the panel
    // renders "—". Left in the status payload rather than removed so the
    // frontend contract is changed deliberately, not as a side effect here.
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
    this.ladderMode = 'RANGE';          // RANGE | TREND — mechanical geometry off the anchor, no AI
    this.anchor = null;
    this.ladderLines = [];              // [{levelIndex, direction, price, state, quantity}]
    this.lastProcessedPrice = null;     // last tick price the ladder crossing logic saw
    this.stepPct = LADDER_STEP_PCT;     // fixed geometry, not a user knob (see ladder-levels.js)
    this.levelsPerSide = LADDER_LEVELS_PER_SIDE;
    this._tradingSeqInProgress = false; // ladder crossing reentrancy guard

    // ---- TREND state ----
    this.trendDirection = null;         // origin breakout direction ('LONG'|'SHORT')

    // ---- Phase 3: harvest-gauge cap ----
    this._lastLadderSize = null;        // last dynamic ladder base size (for gauge-full freeze)
    this._harvestRestartPending = false;// next TREND sizes fresh after a harvest-to-flat
    this._manualHarvestRequested = false; // latch: harvestNow() sets this; honored on the next free tick (transient, not persisted)
  }

  // ——— Lifecycle ——————————————————————————————————————————————————————

  /**
   * Start the strategy. Forces one-way position mode, subscribes to WS
   * streams, and builds the initial ladder on the first price tick.
   */
  async start(config = {}) {
    // strategyId is set by app.js before calling start() (non-blocking pattern).
    if (!this.strategyId) {
      this.strategyId = `anchor_ladder_${this.profileId}_${Date.now()}`;
    }
    this.initFirestoreCollections(this.strategyId);

    this.symbol = config.symbol || 'BTCUSDT';
    this.leverage = config.leverage || DEFAULT_LEVERAGE;
    this.priceType = config.priceType || 'MARK';
    this.recoveryFactor = config.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = config.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = config.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = config.desiredProfitUSDT || 0;
    this.currentInitialSize = config.initialSize || 0;
    this._ladderBaseSize = this.currentInitialSize; // initial ladder uses the initial size; a harvest later carries the last consolidated notional

    // Fixed geometry — not user knobs. The 0.3% step clears the round-trip fee
    // floor (max(0.0025, FEE_RATE*3) = 0.25%) with headroom.
    this.stepPct = LADDER_STEP_PCT;
    this.levelsPerSide = LADDER_LEVELS_PER_SIDE;

    if (!this.symbol) throw new Error('AnchorLadderStrategy.start: missing symbol');
    // Gate on the trivially-known minimum BEFORE any network call — no point
    // burning a setLeverage/setPositionMode/exchangeInfo round trip on an
    // input that's rejected regardless. (The tighter per-symbol minNotional
    // check, which needs exchangeInfoCache, runs further down after
    // _getExchangeInfo.)
    if (!(this.currentInitialSize >= MIN_INITIAL_SIZE_USDT)) {
      const msg = `Initial size (${this.currentInitialSize} USDT) is below the ${MIN_INITIAL_SIZE_USDT} USDT minimum for a ${LADDER_LEVELS_PER_SIDE}-level ladder.`;
      await this.addLog(`ERROR: [VALIDATION_ERROR] ${msg}`);
      throw new Error(msg);
    }

    await this.addLog(`Starting Anchor Ladder Strategy for ${this.symbol}...`);
    // Surface EVERY config field — used to verify the form values made it
    // through to the VM untouched. Three groups separated by `|` for
    // readability: identity/sizing | recovery knobs | advanced toggles.
    await this.addLog(
      `Config: symbol=${this.symbol}, initialSize=${this.currentInitialSize} USDT, ` +
      `leverage=${this.leverage}x, priceType=${this.priceType} ` +
      `| recoveryFactor=${(this.recoveryFactor * 100).toFixed(0)}%, ` +
      `recoveryDistance=${(this.recoveryDistance * 100).toFixed(2)}%, ` +
      `harvestLossThreshold=${(this.harvestLossThreshold * 100).toFixed(0)}%, ` +
      `desiredProfitUSDT=${this.desiredProfitUSDT}`
    );

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // One-way (single-side) mode. The ladder holds LONG legs ONLY above the
      // anchor and SHORT legs ONLY below it, so it can never need both sides at
      // once — hedge mode is unnecessary, and one-way lets Binance net the legs
      // into a single position. Wrapped because Binance refuses the call while
      // positions are open (harmless: an open position means the mode is
      // already whatever it is).
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
    const legNotional = this.currentInitialSize / LADDER_LEVELS_PER_SIDE;
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

    this.isRunning = true;
    this.cycleStartTime = Date.now();
    this.strategyStartTime = new Date();
    this.subState = 'INITIAL';
    this.executionState = 'IDLE';
    this.ladderMode = 'RANGE';
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

    await this.addLog('AnchorLadderStrategy running — awaiting first tick to build the ladder.');
    await this.saveState();
  }

  /**
   * Anchor the ladder on the live mark price. Called from the empty-ladder gate
   * on the first tick, and again after a manual harvest re-anchors.
   *
   * Unlike the old VP-derived grid this needs no market data at all — the
   * anchor IS the current price and the step is fixed — so it cannot fail and
   * needs no retry throttle.
   */
  async initializeLadder(currentPrice) {
    this.anchor = currentPrice;
    this.ladderLines = buildLadder(currentPrice, this.stepPct, this.levelsPerSide);
    this.ladderMode = 'RANGE';
    this.trendDirection = null;
    this.finalTpPrice = null;
    this.lastProcessedPrice = currentPrice;

    const outer = currentPrice * this.stepPct * this.levelsPerSide;
    await this.addLog(`===== LADDER ANCHORED =====`);
    await this.addLog(
      `Anchor ${this._formatPrice(currentPrice)} | step ${(this.stepPct * 100).toFixed(2)}% | ` +
      `${this.levelsPerSide} levels/side | LONG ${this._formatPrice(currentPrice + currentPrice * this.stepPct)}` +
      `–${this._formatPrice(currentPrice + outer)} | SHORT ${this._formatPrice(currentPrice - outer)}` +
      `–${this._formatPrice(currentPrice - currentPrice * this.stepPct)} | ` +
      `leg ${this._formatNotional(this._legNotional())} USDT`,
    );
    await this.saveState();
  }

  // Each leg is an equal slice of the ladder base. The base is the initial size
  // at cycle start, then whatever dynamic sizing produces at each anchor
  // flatten and post-harvest.
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
   * conversion the old hedge-mode _openGridLeg used (default actionType
   * 'ADD', since a leg fill is additive to the net one-way position and
   * should still get the L5b ATR down-scaling that ADD actions receive).
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
   * open" primitive reused by `stop({flatten:true})` and `_harvestToFlat()`.
   * (`_flattenAtAnchor` does NOT call this — it closes directly via
   * `_closeConsolidated` and rebuilds the ladder from scratch.)
   */
  // Return value reflects whether a position was ACTUALLY closed, never
  // merely whether legs were marked open. Legs can be marked POSITION_OPEN
  // while `activePosition` is empty for two very different reasons:
  //   1. Genuine state drift (missed WS update) AND the last Binance refresh
  //      SUCCEEDED and confirmed flat — safe to reset the ledger; nothing is
  //      actually open.
  //   2. The last Binance refresh FAILED — state is UNKNOWN, not flat. Legs
  //      marked POSITION_OPEN could be a real live position. Wiping them
  //      here would silently discard it with no close ever attempted.
  // `this._lastPositionRefreshFailed` (set by _refreshCurrentPosition)
  // distinguishes the two; only case 1 resets the bookkeeping.
  async _flattenGrid(reason = 'FLATTEN') {
    const openLegs = this.ladderLines.filter(l => l.state === 'POSITION_OPEN');
    const hadPosition = !!(this.activePosition && this.activePosition.quantity > 0);
    if (!openLegs.length && !hadPosition) return false;

    if (hadPosition) {
      await this.addLog(`Flattening ladder: closing net position (${openLegs.length} leg(s) recorded open).`);
      await this._closeConsolidated(reason);
    } else if (openLegs.length && this._lastPositionRefreshFailed) {
      const qty = openLegs.reduce((sum, l) => sum + (l.quantity || 0), 0);
      await this.addLog(
        `[LADDER] WARNING: _flattenGrid: Binance position refresh failed — ${this.symbol} has ${openLegs.length} ` +
        `ladder leg(s) marked open (qty ${qty}) but current Binance state is UNKNOWN. NOT wiping legs and no close ` +
        `attempted this pass — will retry on the next stop/reconcile.`
      );
      return false;
    }

    for (const leg of this.ladderLines) {
      leg.state = 'EMPTY';
      leg.quantity = null;
      leg.fillPrice = null;
    }

    await this.saveState();
    return hadPosition;
  }

  // Close the full net one-way position to flat. reduceOnly is REQUIRED (not
  // positionSide, which is a hedge-mode concept) — without it a sub-minNotional
  // close is rejected by Binance with -4164 "insufficient position".
  async _closeConsolidated(reason) {
    if (!this.activePosition || !(this.activePosition.quantity > 0)) return false;
    if (!this.currentSide) {
      // currentSide missing while activePosition is populated is state drift
      // (missed WS update, partial restart, a snapshot written without it).
      // This is the single close path for the whole strategy — silently
      // bailing here orphans a live position on Binance. Binance is the
      // source of truth for side, so refresh from it rather than guessing.
      await this._refreshCurrentPosition();
      if (!this.activePosition || !(this.activePosition.quantity > 0)) return false; // refresh resolved: nothing actually open
      if (!this.currentSide) {
        await this.addLog(`WARNING: _closeConsolidated: ${this.symbol} has an open position (qty ${this.activePosition.quantity}) but currentSide could not be resolved even after refreshing from Binance — position NOT closed, must be closed manually.`);
        return false;
      }
    }
    const closeSide = this.currentSide === 'LONG' ? 'SELL' : 'BUY';
    const qty = this.activePosition.quantity;
    await this.addLog(`Consolidated CLOSE ${this.currentSide} qty ${qty} (${reason}).`);
    const result = await this.placeMarketOrder(this.symbol, closeSide, qty, undefined, { reduceOnly: true });
    // Confirm the close filled on the user-data WS before dropping the in-memory
    // position (realized PnL + fees fold in via the WS accumulators).
    try { if (result?.orderId) await this._waitForOrderFillConfirmation(result.orderId, 3000); }
    catch (e) { await this.addLog(`Consolidated close fill-confirm failed (${e.message}); clearing position anyway.`); }
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
   * anchor flatten (formerly `_computeTrendSize`, the old grid's RANGE->TREND
   * entry sizing — same recovery-formula + margin-headroom-cap + gauge-full
   * freeze, repurposed: the ladder re-bases at every flatten instead of
   * sizing a one-off consolidated TREND entry).
   *
   * Async: fetches the LIVE margin balance for the headroom cap rather than
   * trusting a cached snapshot. Called only from `_flattenAtAnchor` /
   * `_harvestToFlat` — both async, both at flatten points, a handful of
   * times per cycle, never in a hot loop — so the extra round trip is cheap
   * and buys a correct-during-drawdown headroom figure instead of a frozen
   * cycle-start one.
   */
  async _computeLadderBaseSize() {
    this.cycleAccumulatedLoss = this._computeAccLoss();
    // Gauge-full escalation freeze: once the gauge is full, stop GROWING live exposure —
    // reuse the last size. EXCEPTION: a harvest restart (flat -> fresh) always re-sizes.
    if (this._isGaugeFull() && !this._harvestRestartPending && this._lastLadderSize != null) {
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
      this._harvestRestartPending = false;
      return floor;
    }
    const sized = this._applyMarginHeadroomCap(proposed, walletBalance);
    this._lastLadderSize = sized;
    this._harvestRestartPending = false; // consumed: the fresh post-harvest size is now applied
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
      `${leg.direction} ${leg.direction === 'LONG' ? 'L' : 'S'}${leg.levelIndex} filled: ` +
      `${fill.filledQty} @ ${this._formatPrice(fill.fillPrice)} (${this._formatNotional(notional)} USDT)`,
    );
    await this._refreshCurrentPosition(true);
    await this._postExecuteBookkeeping('LADDER_FILL', { direction: leg.direction, levelIndex: leg.levelIndex });
  }

  /**
   * The anchor flatten — the ONLY close in RANGE, and one of two in TREND.
   *
   * Universal: identical in both modes. One reduceOnly market order closes the
   * whole netted position (there are no partial closes in this design), then the
   * ladder resets, dynamic sizing re-bases, and the legs are redistributed.
   *
   * The anchor does NOT move — price IS at the anchor when this fires, so the
   * geometry is already correct.
   *
   * No-ops when there is nothing open AND every leg is already EMPTY: price
   * oscillating across the anchor with a flat ladder otherwise re-triggers a
   * flatten with no position on every crossing — harmless (no orders placed)
   * but it would still re-run dynamic sizing, rebuild the ladder, and spam the
   * log + strategyFlow audit trail on every oscillation.
   */
  async _flattenAtAnchor() {
    const hadPosition = !!(this.activePosition && this.activePosition.quantity > 0);
    const hasOpenLegs = this.ladderLines.some(l => l.state === 'POSITION_OPEN');
    if (!hadPosition && !hasOpenLegs) return;

    if (hadPosition) {
      await this._closeConsolidated('anchor_flatten');
    }

    const prevBase = this._ladderBaseSize;
    this.cycleAccumulatedLoss = this._computeAccLoss();
    this._ladderBaseSize = await this._computeLadderBaseSize();

    this.ladderLines = buildLadder(this.anchor, this.stepPct, this.levelsPerSide);
    this.ladderMode = 'RANGE';
    this.trendDirection = null;
    this.finalTpPrice = null;

    await this.addLog(
      `===== ANCHOR FLATTEN @ ${this._formatPrice(this.anchor)} ===== ` +
      `accLoss ${this._formatNotional(this.cycleAccumulatedLoss)} USDT | ` +
      `base ${this._formatNotional(prevBase)} → ${this._formatNotional(this._ladderBaseSize)} USDT | ` +
      `leg ${this._formatNotional(this._legNotional())} USDT | ladder reset`,
    );
    await this._writeStrategyFlow('ANCHOR_FLATTEN', {
      anchor: this.anchor, accLoss: this.cycleAccumulatedLoss, baseSize: this._ladderBaseSize,
    }).catch(() => {});
    await this.saveState();
  }

  /**
   * Fully scaled -> TREND. Passive from here: the position is KEPT EXACTLY AS-IS.
   *
   * Deliberately does NOT flatten and re-open (which is what the old
   * _triggerTrend did): the ladder has already built a favourable average entry
   * — anchor+0.9% while price is at +1.5% — and re-opening would discard it and
   * pay fees for the privilege.
   */
  async _enterTrend(direction) {
    this.ladderMode = 'TREND';
    this.trendDirection = direction;
    await this._refreshCurrentPosition(true);
    this._recomputeFinalTpPrice(); // armed HERE and only here — RANGE never checks it

    const avg = averageOpenEntry(this.ladderLines, direction);
    await this.addLog(
      `===== TREND ${direction} (fully scaled @ ${this._formatPrice(this.currentPrice)}) ===== ` +
      `avg entry ${this._formatPrice(avg)} | Final TP ${this._formatPrice(this.finalTpPrice)}`,
    );
    await this._writeStrategyFlow('TREND_ENTER', {
      direction, avgEntry: avg, finalTpPrice: this.finalTpPrice,
    }).catch(() => {});
    await this.saveState();
  }

  /**
   * Derive the RANGE→TREND invariant instead of chasing the fill event.
   *
   * `handleRealtimePrice`'s normal path already calls `_enterTrend` the
   * instant the outermost leg fills — but `_fillLeg` persists that leg's
   * POSITION_OPEN state (via `_postExecuteBookkeeping` -> `saveState`)
   * BEFORE that call runs. A process death in that ~0.5-2s window (a PM2
   * restart or VM redeploy, both routine here) persists "RANGE + fully
   * scaled" with no way back: `resume()` only re-arms Final TP when the
   * snapshot already says TREND, and every leg being open means the tick
   * loop's `plan.fills` is empty forever, so the event that drives
   * `_enterTrend` can never fire again. The ladder then sits fully exposed
   * with NO exit target — the anchor flatten becomes the only remaining
   * exit, which turns a winning move into a guaranteed loss.
   *
   * Called from `resume()` and from the top of every tick (before the
   * TREND/RANGE dispatch) so the invariant self-heals on the very next
   * opportunity regardless of when the crash happened. Idempotent: a no-op
   * once `ladderMode` is already 'TREND'.
   */
  async _reconcileTrendInvariant() {
    if (this.ladderMode !== 'RANGE') return false;
    const outermost = this.ladderLines.find(
      (l) => l.levelIndex === this.levelsPerSide && l.state === 'POSITION_OPEN',
    );
    if (!outermost) return false;
    await this.addLog(
      `[LADDER] RANGE→TREND invariant reconcile: outermost ${outermost.direction} leg already ` +
      `POSITION_OPEN with ladderMode still RANGE — arming TREND now (resume or a missed tick).`,
    );
    await this._enterTrend(outermost.direction);
    return true;
  }

  /**
   * Manual harvest — flatten, RE-ANCHOR to the current price, dynamic-size,
   * redistribute. Identical to the anchor flatten except for the re-anchor:
   * the anchor flatten fires AT the anchor (so the geometry is already right),
   * while a harvest fires wherever price happens to be. accLoss is NOT reset
   * (real carried loss); the gauge only empties if realized PnL reduces
   * cycleAccumulatedLoss on its own.
   *
   * Manual only. There is no automatic harvest.
   */
  async _harvestToFlat(reason) {
    if (this._tradingSeqInProgress) {
      await this.addLog(`Harvest (${reason}) skipped — a trading sequence is in progress; retry.`);
      return;
    }
    this._tradingSeqInProgress = true;
    try {
      await this.addLog(`===== HARVEST (${reason}) — flatten + re-anchor =====`);
      if (this.activePosition && this.activePosition.quantity > 0) {
        try { await this._closeConsolidated('harvest'); }
        catch (e) { await this.addLog(`ERROR harvest close: ${e.message}`); }
      }
      this.harvestCount = (this.harvestCount || 0) + 1;
      this.finalTpPrice = null;
      this._harvestRestartPending = true; // the fresh post-harvest size always re-sizes (freeze exception)

      this.cycleAccumulatedLoss = this._computeAccLoss();
      this._ladderBaseSize = await this._computeLadderBaseSize();
      await this.addLog(
        `Post-harvest base ${this._formatNotional(this._ladderBaseSize)} USDT → ` +
        `leg ${this._formatNotional(this._legNotional())} USDT (accLoss ${this._formatNotional(this.cycleAccumulatedLoss)}).`,
      );

      // Re-anchor on the live price — THE difference from the anchor flatten.
      await this.initializeLadder(this.currentPrice);

      await this._writeStrategyFlow('HARVEST', { reason, anchor: this.anchor, baseSize: this._ladderBaseSize }).catch(() => {});
      await this.saveState();
    } finally {
      this._tradingSeqInProgress = false;
    }
  }

  /**
   * Resume a strategy from a Firestore snapshot. Called by app.js boot-scan
   * (recoverActiveStrategies) when a `type: 'ANCHOR_LADDER'` doc has
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
    if (!snapshot) throw new Error('AnchorLadderStrategy.resume: missing snapshot');

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

    await this.addLog(`[RECOVERY] Resuming Anchor Ladder Strategy after restart...`);

    // Restore config
    this.symbol = snapshot.symbol;
    this.leverage = snapshot.leverage || DEFAULT_LEVERAGE;
    this.priceType = snapshot.priceType || 'MARK';
    this.recoveryFactor = snapshot.config?.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = snapshot.config?.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = snapshot.config?.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = snapshot.config?.desiredProfitUSDT || 0;
    this.currentInitialSize = snapshot.currentInitialSize || snapshot.config?.initialSize || 0;

    // ---- ladder state ----
    this.ladderMode = snapshot.ladderMode || 'RANGE';
    this.anchor = snapshot.anchor ?? null;
    this.ladderLines = Array.isArray(snapshot.ladderLines) ? snapshot.ladderLines : [];
    this.trendDirection = snapshot.trendDirection ?? null;
    this.lastProcessedPrice = snapshot.lastProcessedPrice ?? null;
    this._ladderBaseSize = snapshot.ladderBaseSize || this.currentInitialSize; // grown ladder base survives restarts (else ladder shrinks to initial)
    this._lastLadderSize = snapshot._lastLadderSize ?? null;
    this._harvestRestartPending = !!snapshot._harvestRestartPending;
    this.stepPct = LADDER_STEP_PCT;           // fixed, never from the snapshot
    this.levelsPerSide = LADDER_LEVELS_PER_SIDE;

    // Restore cycle state
    this.currentSide = snapshot.currentSide || null;
    this.activePosition = snapshot.currentPosition || null;
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

    try {
      await this.setLeverage(this.symbol, this.leverage);
      // One-way (single-side) mode — mirrors start(). The ladder holds LONG
      // legs ONLY above the anchor and SHORT legs ONLY below it, so it can
      // never need both sides at once; hedge mode is unnecessary. Wrap in
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
      console.error(`[LADDER] L3 reconcile on resume failed: ${err.message}`);
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

    // Mode-aware resume: RANGE re-derives the TREND invariant here (not just
    // on the next tick) so a process death between `_fillLeg(L5)` persisting
    // and `_enterTrend` running can never strand the cycle in RANGE fully-
    // scaled with no exit target — see `_reconcileTrendInvariant`. TREND
    // (already armed on the snapshot) re-arms Final TP from the restored
    // consolidated position.
    const reconciledToTrend = await this._reconcileTrendInvariant();
    if (!reconciledToTrend && this.ladderMode === 'TREND' && this.activePosition && this.currentSide) {
      this._recomputeFinalTpPrice();
      await this.addLog(`Resumed in TREND ${this.currentSide}; Final TP ${this.finalTpPrice ? this._formatPrice(this.finalTpPrice) : 'n/a'}.`);
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
    // /anchor-ladder/stop route AND the tick loop's Final TP check in
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
      if (!closedSomething && this.activePosition && this.activePosition.quantity > 0 && this.ladderMode === 'TREND') {
        // Fallback for a TREND-consolidated position with no ladder leg left
        // marked POSITION_OPEN. Reachable — not merely defensive — when
        // branch 1's close throws before `_flattenGrid` resets leg state
        // (proven live: legs stay POSITION_OPEN through TREND, so branch 1
        // fires and throws, then this branch retries the close directly).
        try {
          await this._closeConsolidated('stop');
          closedSomething = true;
        } catch (err) {
          await this.addLog(`[LADDER] stop: consolidated close failed: ${err.message}`);
        }
      }
      if (!closedSomething && this.activePosition && this.activePosition.quantity > 0) {
        const closeReason = reason === 'final_tp' ? 'final_tp' : 'user-stop';
        try {
          await this.addLog(`[LADDER] stop: flattening ${this.currentSide} ${this.activePosition.quantity} (${closeReason})`);
          await this._closeConsolidated(closeReason);
          closedSomething = true;
        } catch (err) {
          await this.addLog(`[LADDER] stop: flatten failed: ${err.message}`);
        }
      } else if (!closedSomething) {
        // Do NOT claim "nothing to flatten" when the position state is
        // actually UNKNOWN (refresh failed) and ladderLines still shows
        // open legs — _flattenGrid already logged a WARNING for that case;
        // repeating "nothing to flatten" here would contradict it and read
        // as false reassurance.
        const stateUnknownWithOpenLegs = this._lastPositionRefreshFailed
          && this.ladderLines.some(l => l.state === 'POSITION_OPEN');
        if (!stateUnknownWithOpenLegs) {
          await this.addLog('[LADDER] stop: no open position on Binance — nothing to flatten');
        }
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
      if (this.activePosition && this.activePosition.quantity > 0) {
        await this.addLog(`[LADDER] WARNING: stop+flatten left residual ${this.currentSide} ${this.activePosition.quantity} ${this.symbol} on Binance — close it manually`);
      } else if (closedSomething) {
        await this.addLog('[LADDER] stop: position confirmed flat');
      } else if (this._lastPositionRefreshFailed && this.ladderLines.some(l => l.state === 'POSITION_OPEN')) {
        // Never terminate silently: state is still UNKNOWN after both
        // refresh attempts and ladderLines still shows open legs that were
        // deliberately left untouched — this is the loudest signal we can
        // give before the strategy terminates.
        const qty = this.ladderLines
          .filter(l => l.state === 'POSITION_OPEN')
          .reduce((sum, l) => sum + (l.quantity || 0), 0);
        await this.addLog(
          `[LADDER] WARNING: stop: FINAL STATE UNKNOWN for ${this.symbol} — Binance could not be reached to confirm ` +
          `flat, and ${this.ladderLines.filter(l => l.state === 'POSITION_OPEN').length} ladder leg(s) (qty ${qty}) ` +
          `remain marked open. Verify manually on Binance.`
        );
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
   * or harvests. All of these are persisted by saveState() and restored by
   * resume(), so the check is crash-safe across a VM restart. Conservative by
   * design — any real trading activity leaves a non-zero accumulatedTradingFees,
   * so a strategy that actually traded can never be misclassified as no-trade.
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
    // MUST stay above the mode dispatch below: every RANGE/TREND branch
    // returns, so anything after them never runs. Parked here this covers
    // TREND, where the consolidated position lives; RANGE clears
    // activePosition when it flattens, a few lines down.
    if (this.activePosition) this._updateUnrealizedPnL(price);

    // ---- Ladder gate: anchor on the first tick (and after a harvest). ----
    // No market data needed — the anchor IS the price — so no retry throttle.
    if (!this.ladderLines.length) {
      await this.initializeLadder(price);
      return;
    }

    if (this._tradingSeqInProgress) return; // do NOT advance lastProcessedPrice: re-scan this band next tick

    // Honor a queued manual harvest on the next free tick (harvestNow sets the latch).
    if (this._manualHarvestRequested) {
      this._manualHarvestRequested = false;
      await this._harvestToFlat('manual_harvest');
      this.lastProcessedPrice = price;
      return;
    }

    // ---- Derive the RANGE→TREND invariant BEFORE dispatching on mode. ----
    // Fully scaled (outermost leg POSITION_OPEN) always implies TREND — a
    // no-op once already TREND, and a self-heal on the first tick after a
    // resume that stalled in RANGE fully-scaled (see _reconcileTrendInvariant).
    // Runs first so a transition here is picked up by the TREND branch on
    // this SAME tick rather than waiting one more.
    await this._reconcileTrendInvariant();

    // ---- TREND: passive. Two exits, and only two. ----
    if (this.ladderMode === 'TREND') {
      // 1) Final TP -> close + STOP. The cycle ends.
      if (this.finalTpPrice && this._checkFinalTpHit(price)) {
        this._tradingSeqInProgress = true;
        try { await this.stop({ flatten: true, reason: 'final_tp' }); }
        finally { this._tradingSeqInProgress = false; }
        return;
      }
      // 2) Anchor reached -> flatten -> back to RANGE. Nothing else acts:
      //    price moving back inside the ladder is deliberately a no-op.
      const plan = planLadderActions({
        prevPrice: this.lastProcessedPrice, currentPrice: price, anchor: this.anchor, legs: this.ladderLines,
      });
      if (plan.flatten) {
        this._tradingSeqInProgress = true;
        try { await this._flattenAtAnchor(); } finally { this._tradingSeqInProgress = false; }
      }
      this.lastProcessedPrice = price;
      return;
    }

    // ---- RANGE ----
    const plan = planLadderActions({
      prevPrice: this.lastProcessedPrice, currentPrice: price, anchor: this.anchor, legs: this.ladderLines,
    });

    if (plan.flatten) {
      this._tradingSeqInProgress = true;
      try { await this._flattenAtAnchor(); } finally { this._tradingSeqInProgress = false; }
      this.lastProcessedPrice = price;
      return; // two-tick rule: the opposite side opens on the NEXT tick
    }

    if (plan.fills.length) {
      this._tradingSeqInProgress = true;
      try {
        for (const leg of plan.fills) {
          if (leg.state === 'EMPTY') await this._fillLeg(leg); // re-check: state may have moved since planning
        }
        // Fully scaled -> TREND. The outermost leg filling IS the trigger.
        const outermost = plan.fills.find(l => l.levelIndex === this.levelsPerSide);
        if (outermost && outermost.state === 'POSITION_OPEN') {
          await this._enterTrend(outermost.direction);
        }
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
   * Refuses only when there is nothing open. Throws on ineligibility (the
   * route maps it to a 409).
   */
  async harvestNow() {
    if (!this.isRunning) throw new Error('Strategy is not running.');
    const open = !!(this.activePosition && this.activePosition.quantity > 0);
    if (!open) throw new Error('Nothing open to harvest.');
    this._manualHarvestRequested = true; // honored on the next free tick
    return { harvesting: true, queued: true, mode: this.ladderMode, price: this.currentPrice };
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
    wallet = wallet || 0;
    if (wallet <= 0) return proposedSize;
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

  // TREND-only check (RANGE never calls this — see handleRealtimePrice). Keys
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
   * on Binance. (_flattenAtAnchor / _harvestToFlat / _enterTrend do their
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
   * Refresh the 24h VP for the chart histogram. Chart-only — the ladder is
   * anchored on live price and reads nothing from the profile. Best-effort:
   * a failure leaves the last snapshot in place rather than throwing into the
   * tick path.
   */
  async _refreshVolumeSnapshot() {
    try {
      const vp = await this.volumeProfile.get24h(this.symbol);
      if (vp) this._lastVolumeProfile24h = vp;
    } catch (e) {
      await this.addLog(`Volume profile refresh failed: ${e.message} (keeping the last snapshot).`);
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

  // ——— Status snapshot (consumed by /anchor-ladder/status) ——————————————

  getStatus() {
    // acc-loss is purely derived from the live (Binance-truth) accumulators, so
    // refresh it on read — the displayed gauge then always matches the Cycle PnL
    // Net regardless of which trade path last ran (grid crossings, harvest, ...).
    this.cycleAccumulatedLoss = this._computeAccLoss();
    return {
      strategyId: this.strategyId,
      strategyType: 'anchorLadder',
      symbol: this.symbol,
      isRunning: this.isRunning,
      executionState: this.executionState,
      subState: this.subState,
      currentSide: this.currentSide,
      currentPosition: this.activePosition,
      finalTpPrice: this.finalTpPrice,
      cycleAccumulatedLoss: this.cycleAccumulatedLoss,
      reversalCount: this.reversalCount,
      harvestCount: this.harvestCount,
      initialCapital: this.initialCapital,
      currentInitialSize: this.currentInitialSize,
      desiredProfitUSDT: this.desiredProfitUSDT,

      // Ladder state — the frontend's status/chart view renders these
      // directly. `mode` is the alias the frontend actually reads
      // (status.mode, not status.ladderMode).
      mode: this.ladderMode,         // the frontend reads status.mode, not ladderMode
      anchor: this.anchor,
      ladderLines: this.ladderLines,
      trendDirection: this.trendDirection,
      levelsPerSide: this.levelsPerSide,
      stepPct: this.stepPct,
      legNotional: this._legNotional(),
      ladderBaseSize: this._ladderBaseSize,
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
      _harvestRestartPending: this._harvestRestartPending,
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
   * Ladder/mode fields (mode, anchor/ladderLines/etc., trendDirection,
   * finalTpPrice, ...) ARE included here because RANGE/TREND transitions
   * and anchor-flatten rebuilds happen mid-cycle, and the frontend merges
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
      strategyType: 'anchorLadder',
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
      initialCapital: this.initialCapital,
      harvestLossThreshold: this.harvestLossThreshold,
      accumulatedRealizedPnL: this.accumulatedRealizedPnL || 0,
      accumulatedTradingFees: this.accumulatedTradingFees || 0,
      accumulatedFundingFees: this.accumulatedFundingFees || 0,

      // Ladder state — see docstring: included here on every heartbeat
      // because mode/ladder transitions happen mid-cycle.
      mode: this.ladderMode,         // the frontend reads status.mode, not ladderMode
      anchor: this.anchor,
      ladderLines: this.ladderLines,
      trendDirection: this.trendDirection,
      levelsPerSide: this.levelsPerSide,
      stepPct: this.stepPct,
      legNotional: this._legNotional(),
      ladderBaseSize: this._ladderBaseSize,
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
   *   - type: 'ANCHOR_LADDER' (queried by recoverActiveStrategies)
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
        type: 'ANCHOR_LADDER',
        strategyType: 'anchorLadder',
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
        positionSizeUSDT: this.currentInitialSize,
        priceType: this.priceType,
        recoveryFactor: this.recoveryFactor,
        recoveryDistance: this.recoveryDistance,
        harvestLossThreshold: this.harvestLossThreshold,
        // ---- ladder state ----
        ladderMode: this.ladderMode,
        anchor: this.anchor,
        ladderLines: this.ladderLines,   // flat objects (Firestore-safe: no nested arrays)
        trendDirection: this.trendDirection,
        lastProcessedPrice: this.lastProcessedPrice,
        ladderBaseSize: this._ladderBaseSize,
        _lastLadderSize: this._lastLadderSize,
        _harvestRestartPending: this._harvestRestartPending,
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

export { AnchorLadderStrategy };
export default AnchorLadderStrategy;
