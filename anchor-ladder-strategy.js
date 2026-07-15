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

// ---- Grid (dual/hedge) defaults — legacy resume() fallbacks only; the ladder's
// own geometry (stepPct/levelsPerSide) is fixed via LADDER_STEP_PCT /
// LADDER_LEVELS_PER_SIDE, not these. ----
const DEFAULT_GRID_LEVELS_PER_SIDE = 5;
const DEFAULT_MIN_STEP_PCT = 0.0025;   // round-trip fee+slippage floor
const DEFAULT_MAX_WIDTH_PCT = 0.05;    // cap on half-width fraction from anchor

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

    // Reversal-specific state
    this.strategyType = 'dual';
    this.currentSide = null;                // 'LONG' | 'SHORT' | null
    this.activePosition = null;            // { quantity, entryPrice, notional, unrealizedPnl }
    this.bullLevel = null;
    this.bearLevel = null;
    this.finalTpPrice = null;
    this.cycleAccumulatedLoss = 0;
    this.reversalCount = 0;
    this.harvestCount = 0;
    this.initialCapital = 0;
    this.currentInitialSize = 0;         // base for DYNAMIC trend sizing (original config size; never overwritten → no compounding)
    this._ladderBaseSize = 0;            // base the LADDER is sized from: initial size, then the last consolidated notional after a harvest
    this._lastConsolidatedNotional = 0;  // notional of the most recent TREND/UNWIND consolidated open (carried into the post-harvest grid)
    this.cycleStartTime = null;
    // Execution lock. KEPT (not AI state): stop() and _handleFinalTpHit use the
    // EXECUTING/TERMINATED values as the re-entry guard around termination.
    // The AI-only 'PLANNING' value is no longer produced by anything.
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
    this._lastTrendSize = null;         // last dynamic TREND size (for gauge-full freeze)
    this._harvestRestartPending = false;// next TREND sizes fresh after a harvest-to-flat
    this._manualHarvestRequested = false; // latch: harvestNow() sets this; honored on the next free tick (transient, not persisted)
  }

  // ——— Lifecycle ——————————————————————————————————————————————————————

  /**
   * Start the strategy. Forces one-way position mode, instantiates AI
   * modules, subscribes to WS streams, requests first PLAN.
   */
  async start(config = {}) {
    // strategyId is set by app.js before calling start() (non-blocking pattern).
    if (!this.strategyId) {
      this.strategyId = `ai_dual_${this.profileId}_${Date.now()}`;
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
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || (this.currentInitialSize * 10);

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
      `leverage=${this.leverage}x, maxPos=${this.maxPositionSizeUSDT} USDT, ` +
      `priceType=${this.priceType} ` +
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
  async _flattenGrid(reason = 'FLATTEN') {
    const openLegs = this.ladderLines.filter(l => l.state === 'POSITION_OPEN');
    const hadPosition = !!(this.activePosition && this.activePosition.quantity > 0);
    if (!openLegs.length && !hadPosition) return false;

    if (hadPosition) {
      await this.addLog(`Flattening ladder: closing net position (${openLegs.length} leg(s) recorded open).`);
      await this._closeConsolidated(reason);
    }

    for (const leg of this.ladderLines) {
      leg.state = 'EMPTY';
      leg.quantity = null;
      leg.fillPrice = null;
    }

    await this.saveState();
    return true;
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
   */
  _computeLadderBaseSize() {
    this.cycleAccumulatedLoss = this._computeAccLoss();
    // Gauge-full escalation freeze: once the gauge is full, stop GROWING live exposure —
    // reuse the last size. EXCEPTION: a harvest restart (flat -> fresh) always re-sizes.
    if (this._isGaugeFull() && !this._harvestRestartPending && this._lastTrendSize != null) {
      return this._lastTrendSize;
    }
    const proposed = this._computeFormulaSize();
    const sized = this._applyMarginHeadroomCap(proposed);
    this._lastTrendSize = sized;
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
    this._ladderBaseSize = this._computeLadderBaseSize();

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

  // De-risk to flat (hedge-safe) and re-anchor RANGE. accLoss is NOT reset (real carried loss);
  // the gauge only empties if the realized PnL reduces cycleAccumulatedLoss on its own.
  async _harvestToFlat(reason) {
    if (this._tradingSeqInProgress) {
      await this.addLog(`Harvest (${reason}) skipped — a trading sequence is already in progress; retry.`);
      return;
    }
    this._tradingSeqInProgress = true;
    try {
      await this.addLog(`===== HARVEST (${reason}) — flatten to flat + re-anchor =====`);
      if (this.ladderLines.some(l => l.state === 'POSITION_OPEN')) {
        try { await this._flattenGrid(); } catch (e) { await this.addLog(`ERROR harvest grid flatten: ${e.message}`); }
      }
      if (this.activePosition && this.activePosition.quantity > 0) {
        try { await this._closeConsolidated('harvest'); } catch (e) { await this.addLog(`ERROR harvest consolidated close: ${e.message}`); }
      }
      this.harvestCount = (this.harvestCount || 0) + 1;
      this.finalTpPrice = null;
      // Ladder-base carry-forward: size the fresh post-harvest ladder from the LAST
      // consolidated (TREND) position notional — the recovery-grown exposure —
      // instead of the base initial size. Falls back to initialSize if no consolidated
      // position happened this cycle. Kept SEPARATE from currentInitialSize (the
      // dynamic-sizing base) so it never feeds back into trend sizing → no compounding.
      // The consolidated notional is itself margin-capped, so no extra cap is needed.
      // Levels per side are fixed (LADDER_LEVELS_PER_SIDE) — no re-derivation needed.
      this._ladderBaseSize = (this._lastConsolidatedNotional > 0) ? this._lastConsolidatedNotional : this.currentInitialSize;
      await this.addLog(`Ladder base carried to ${this._formatNotional(this._ladderBaseSize)} USDT (last consolidated notional).`);
      // Re-anchor: clear the ladder so the next tick's empty-ladder gate rebuilds it around current price.
      this.ladderLines = [];
      this.vwapLong = null; this.vwapShort = null;
      this.trendDirection = null;
      this.ladderMode = 'RANGE';
      this._harvestRestartPending = true; // next TREND entry re-sizes fresh (freeze exception)
      await this._writeStrategyFlow('HARVEST', { reason, gridMode: 'RANGE' });
      await this.saveState();
    } finally {
      this._tradingSeqInProgress = false;
    }
  }

  /**
   * Resume a strategy from a Firestore snapshot. Called by app.js boot-scan
   * (recoverActiveStrategies) when a `type: 'AI_DUAL'` doc has
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

    await this.addLog(`[RECOVERY] Resuming Anchor Ladder Strategy after restart...`);

    // Restore config
    this.symbol = snapshot.symbol;
    this.leverage = snapshot.leverage || DEFAULT_LEVERAGE;
    this.maxPositionSizeUSDT = snapshot.maxPositionSizeUSDT || 0;
    this.priceType = snapshot.priceType || 'MARK';
    this.recoveryFactor = snapshot.config?.recoveryFactor ?? DEFAULT_RECOVERY_FACTOR;
    this.recoveryDistance = snapshot.config?.recoveryDistance ?? DEFAULT_RECOVERY_DISTANCE;
    this.harvestLossThreshold = snapshot.config?.harvestLossThreshold ?? HARVEST_LOSS_THRESHOLD_PCT;
    this.desiredProfitUSDT = snapshot.config?.desiredProfitUSDT || 0;
    this.currentInitialSize = snapshot.currentInitialSize || snapshot.config?.initialSize || 0;
    this._ladderBaseSize = snapshot.gridBaseSize || this.currentInitialSize; // grown ladder base survives restarts (else ladder shrinks to initial)
    this._lastConsolidatedNotional = snapshot.lastConsolidatedNotional || 0;
    // Restore advanced toggles too (advisory, but tracked for log parity).
    this.recoveryFactorDecay = !!snapshot.config?.recoveryFactorDecay;
    this.recoveryDistanceAutoWiden = !!snapshot.config?.recoveryDistanceAutoWiden;

    // ---- grid state ----
    this.ladderMode = snapshot.gridMode || 'RANGE';
    this.anchor = snapshot.gridAnchor ?? null;
    this.gridUpperBoundary = snapshot.gridUpperBoundary ?? null;
    this.gridLowerBoundary = snapshot.gridLowerBoundary ?? null;
    this.upperLVN = snapshot.upperLVN ?? null;
    this.lowerLVN = snapshot.lowerLVN ?? null;
    this.ladderLines = Array.isArray(snapshot.gridLines) ? snapshot.gridLines : [];
    this.vwapLong = snapshot.vwapLong ?? null;
    this.vwapShort = snapshot.vwapShort ?? null;
    this.gridLevelsPerSide = Number(snapshot.config?.gridLevelsPerSide) || DEFAULT_GRID_LEVELS_PER_SIDE;
    this.minStepPct = snapshot.config?.minStepPct != null ? Number(snapshot.config.minStepPct) : DEFAULT_MIN_STEP_PCT;
    this.maxWidthPct = snapshot.config?.maxWidthPct != null ? Number(snapshot.config.maxWidthPct) : DEFAULT_MAX_WIDTH_PCT;
    this.lastProcessedPrice = snapshot.lastProcessedPrice ?? null;

    // ---- TREND state ----
    this.trendDirection = snapshot.trendDirection ?? null;

    // ---- Phase 3: harvest-gauge cap state ----
    this._lastTrendSize = snapshot._lastTrendSize ?? null;
    this._harvestRestartPending = !!snapshot._harvestRestartPending;

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

    // Mode-aware resume: RANGE rebuilds nothing (first tick / existing legs drive it);
    // TREND re-arms Final TP from the restored consolidated position.
    if (this.ladderMode === 'TREND' && this.activePosition && this.currentSide) {
      this._recomputeFinalTpPrice();
      await this.addLog(`Resumed in TREND ${this.currentSide}; Final TP ${this.finalTpPrice ? this._formatPrice(this.finalTpPrice) : 'n/a'}.`);
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
      // Grid-aware flatten. In hedge/RANGE the position is held as open grid
      // legs (positionSide LONG/SHORT, never reduceOnly), which the reversal
      // HARVEST_CLOSE path (positionSide:'BOTH' + reduceOnly) can't close — it
      // would orphan the legs. BOTH a stray grid leg AND a consolidated
      // (TREND/UNWIND) hedge position can be open at once (e.g. a grid leg
      // failed to flatten on TREND entry), so close EACH that has open state;
      // the reversal (single-sided) fallback runs ONLY if neither did.
      let closedSomething = false;
      if (this.ladderLines.some(l => l.state === 'POSITION_OPEN')) {
        try {
          await this._flattenGrid();
        } catch (err) {
          await this.addLog(`[DUAL] stop: grid flatten failed: ${err.message}`);
        }
        closedSomething = true;
      }
      if (this.activePosition && this.activePosition.quantity > 0 && (this.ladderMode === 'TREND' || this.ladderMode === 'UNWIND')) {
        // Consolidated (TREND/UNWIND) hedge position — single positionSide-encoded
        // position, not grid legs. Close it directly rather than falling through
        // to the reversal HARVEST_CLOSE path (positionSide:'BOTH' + reduceOnly),
        // which hedge mode rejects.
        try {
          await this._closeConsolidated('stop');
        } catch (err) {
          await this.addLog(`[DUAL] stop: consolidated close failed: ${err.message}`);
        }
        closedSomething = true;
      }
      if (!closedSomething) {
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
            await this._closeConsolidated(closeReason);
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
      ? '[REVERSAL] Final TP — cycle complete, strategy terminated.'
      : '[REVERSAL] stop: terminated');

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
        console.error(`[REVERSAL] notify error: ${notifyErr.message}`);
      }
    }

    // CRITICAL: invokes the app.js callback that does
    // `activeStrategies.delete(strategyId)`. Without this, the next start
    // attempt for this profile is rejected with "already running".
    try { this.onStopComplete?.(); } catch (e) {
      console.error('[REVERSAL] onStopComplete hook failed:', e.message);
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
          console.error(`[REVERSAL] no-trade cleanup: ${name} delete failed: ${subErr.message}`);
        }
      }
      await strategyRef.delete();
      console.log(`[REVERSAL] no-trade cycle ${this.strategyId} — strategy doc deleted (not persisted as completed).`);
    } catch (err) {
      console.error(`[REVERSAL] no-trade doc delete failed for ${this.strategyId}: ${err.message} — falling back to saveState()`);
      this.willBeDeleted = false;
      try { await this.saveState(); } catch (saveErr) {
        console.error(`[REVERSAL] fallback saveState also failed: ${saveErr.message}`);
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
    // Cheap (multiplication + sign branch); needed so getStatus() and the
    // 30s heartbeat surface a live figure to the frontend.
    //
    // MUST stay above the mode dispatch below: every RANGE/TREND/UNWIND branch
    // returns, so anything after them never runs. Parked here (as in
    // ai-reversal-strategy.js) this covers TREND/UNWIND, where the consolidated
    // position lives; RANGE clears activePosition outright a few lines down.
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

  // ——— Position actions ——————————————————————————————————————————————

  /**
   * Manual, user-driven harvest. Flattens whatever is open ON DEMAND — grid
   * legs and/or a consolidated TREND/UNWIND position — regardless of
   * cycleAccumulatedLoss vs the auto harvest-gate threshold, and regardless
   * of per-leg profit (the dual grid can have simultaneous LONG+SHORT legs,
   * so there's no single "the position" to profit-gate). This is the backend
   * for the Active Position card's "Harvest now" control.
   *
   * Delegates to `_harvestToFlat` (hedge-safe: `_flattenGrid` + `_closeConsolidated`,
   * never reduceOnly, never the one-way `_executeHarvest`/HARVEST_CLOSE path).
   * `_harvestToFlat` self-guards on `_tradingSeqInProgress` and SKIPS if a
   * trading sequence is momentarily in flight, so this sets a latch instead
   * of firing directly — `handleRealtimePrice` honors it on the next free
   * tick, guaranteeing the harvest actually runs (no silent no-op).
   *
   * Refuses only when there is nothing open. Throws on ineligibility (the
   * route maps it to a 409).
   */
  async harvestNow() {
    if (!this.isRunning) {
      throw new Error('Strategy is not running.');
    }
    const hasGrid = this.ladderLines.some(l => l.state === 'POSITION_OPEN');
    const hasConsolidated = !!(this.activePosition && this.activePosition.quantity > 0);
    if (!hasGrid && !hasConsolidated) {
      throw new Error('Nothing open to harvest.');
    }
    this._manualHarvestRequested = true; // honored on the next free tick (see handleRealtimePrice)
    return { harvesting: true, queued: true, mode: this.ladderMode, price: this.currentPrice };
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
   * The old AI-consult cost addend is gone (the strategy is fully mechanical),
   * so the target now moves only with accumulated loss, the desired profit, and
   * the estimated closing fee. Recomputed on every position/funding event.
   */
  _recomputeFinalTpPrice() {
    if (!this.activePosition || !this.activePosition.quantity || this.activePosition.quantity <= 0) {
      this.finalTpPrice = null;
      return;
    }
    const qty = this.activePosition.quantity;
    const entry = this.activePosition.entryPrice || this.activePosition.avgEntry;
    const notional = this.activePosition.notional || (entry * qty) || 0;
    const estimatedClosingFee = notional * FEE_RATE;
    // No AI cost term any more — the strategy is fully mechanical, so the old
    // `+ aiCost` addend is permanently zero and has been dropped.
    const needed = (this.cycleAccumulatedLoss || 0)
      + (this.desiredProfitUSDT || 0)
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
   * Lives here rather than on TradingBase for the same reason
   * _fetchDeepseekApiKey does; follow-up: refactor down to TradingBase.
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

  // ——— Status snapshot (consumed by /ai-reversal/status) ——————————————

  getStatus() {
    // acc-loss is purely derived from the live (Binance-truth) accumulators, so
    // refresh it on read — the displayed gauge then always matches the Cycle PnL
    // Net regardless of which trade path last ran (grid crossings, harvest, ...).
    this.cycleAccumulatedLoss = this._computeAccLoss();
    return {
      strategyId: this.strategyId,
      strategyType: 'dual',
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
      gridBaseSize: this._ladderBaseSize,
      lastConsolidatedNotional: this._lastConsolidatedNotional,
      desiredProfitUSDT: this.desiredProfitUSDT,

      // Grid (dual/hedge) state — the frontend's Phase 4 Dual view renders
      // these directly. `mode` is the alias the frontend actually reads
      // (status.mode, not status.gridMode).
      mode: this.ladderMode,
      gridAnchor: this.anchor,
      gridUpperBoundary: this.gridUpperBoundary,
      gridLowerBoundary: this.gridLowerBoundary,
      upperLVN: this.upperLVN,
      lowerLVN: this.lowerLVN,
      gridLines: this.ladderLines,
      vwapLong: this.vwapLong,
      vwapShort: this.vwapShort,
      gridLevelsPerSide: this.gridLevelsPerSide,
      trendDirection: this.trendDirection,
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
      maxPositionSizeUSDT: this.maxPositionSizeUSDT,
      recoveryFactorDecay: this.recoveryFactorDecay,
      recoveryDistanceAutoWiden: this.recoveryDistanceAutoWiden,
      _lastTrendSize: this._lastTrendSize,
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
   *   - Fields covered by other event pushes (currentPrice via price_tick;
   *     bullLevel/bearLevel/activePlan via plan_update / flow_event).
   *   - AI-consult cache (volumeProfile / cvd / orderbookDepth / volatility)
   *     which only changes on consults — pushed via plan_update.context.
   *   - Derivable fields (cycleDuration = Date.now() - cycleStartTime).
   * Grid/mode fields (mode, gridAnchor/gridLines/etc., trendDirection,
   * unwindDirection, finalTpPrice, ...) ARE included here — unlike reversal,
   * a live Dual WS session needs them on every heartbeat because RANGE/TREND/
   * UNWIND transitions and grid rebuilds happen mid-cycle, not just at plan
   * boundaries, and the frontend merges this payload directly into `status`
   * (setStatus(prev => ({...prev, ...payload}))) so a value missing here
   * would only ever reach the frontend via the next full REST getStatus().
   * Fires on the 30s safety-net interval AND immediately after every
   * bookkeeping change via _pushHeartbeatNow().
   */
  getHeartbeatPayload() {
    this.cycleAccumulatedLoss = this._computeAccLoss(); // keep derived acc-loss live (see getStatus)
    return {
      strategyId: this.strategyId,
      strategyType: 'dual',
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

      // Grid (dual/hedge) state — see docstring: included here (unlike
      // reversal's heartbeat) because mode/grid transitions happen mid-cycle.
      mode: this.ladderMode,
      gridAnchor: this.anchor,
      gridUpperBoundary: this.gridUpperBoundary,
      gridLowerBoundary: this.gridLowerBoundary,
      upperLVN: this.upperLVN,
      lowerLVN: this.lowerLVN,
      gridLines: this.ladderLines,
      vwapLong: this.vwapLong,
      vwapShort: this.vwapShort,
      gridLevelsPerSide: this.gridLevelsPerSide,
      trendDirection: this.trendDirection,
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
   *   - type: 'AI_DUAL' (queried by recoverActiveStrategies)
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
        type: 'AI_DUAL',
        strategyType: 'dual',  // legacy alias; kept for back-compat
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
        initialCapital: this.initialCapital,
        initialWalletBalance: this.initialWalletBalance,
        currentInitialSize: this.currentInitialSize,
        gridBaseSize: this._ladderBaseSize,
        lastConsolidatedNotional: this._lastConsolidatedNotional,
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
        maxPositionSizeUSDT: this.maxPositionSizeUSDT,
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
        // ---- grid state ----
        gridMode: this.ladderMode,
        gridAnchor: this.anchor,
        gridUpperBoundary: this.gridUpperBoundary,
        gridLowerBoundary: this.gridLowerBoundary,
        upperLVN: this.upperLVN,
        lowerLVN: this.lowerLVN,
        gridLines: this.ladderLines,          // array of flat objects (Firestore-safe: no nested arrays-of-arrays)
        vwapLong: this.vwapLong,
        vwapShort: this.vwapShort,
        lastProcessedPrice: this.lastProcessedPrice,
        // ---- TREND state ----
        trendDirection: this.trendDirection,
        // ---- Phase 3: harvest-gauge cap state ----
        _lastTrendSize: this._lastTrendSize,
        _harvestRestartPending: this._harvestRestartPending,
        config: {
          recoveryFactor: this.recoveryFactor,
          recoveryDistance: this.recoveryDistance,
          harvestLossThreshold: this.harvestLossThreshold,
          desiredProfitUSDT: this.desiredProfitUSDT,
          initialSize: this.currentInitialSize,
          recoveryFactorDecay: this.recoveryFactorDecay,
          recoveryDistanceAutoWiden: this.recoveryDistanceAutoWiden,
          gridLevelsPerSide: this.gridLevelsPerSide,
          minStepPct: this.minStepPct,
          maxWidthPct: this.maxWidthPct,
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

}

export { AnchorLadderStrategy };
export default AnchorLadderStrategy;
