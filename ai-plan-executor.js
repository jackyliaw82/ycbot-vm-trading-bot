/**
 * AiPlanExecutor — monitors trigger prices and executes AI plan actions.
 *
 * Legacy model (v1.x): each plan has one action ABOVE and one BELOW current price.
 * When one triggers, the other is cancelled and a fresh plan is requested.
 *
 * Paired-trigger model (v2.0.0+, AI_DCA_MODE=paired_trigger): each plan has
 * 4 actions per side — primary + shadow on actionAbove, primary + shadow on
 * actionBelow. Shadow qty is band-clamped to keep LONG/SHORT ratio in band
 * even on one-sided fills.
 *
 * Supports OPEN_HEDGE (Phase 1) which opens both LONG and SHORT simultaneously,
 * and ADD/CUT actions (Phase 2) for DCA.
 */
class AiPlanExecutor {
  /**
   * Pure helper: clamp a shadow qty proposal so the post-fill LONG/SHORT
   * ratio stays inside the band even if the shadow alone fills (price
   * reverses before reaching the paired primary).
   *
   * For Shadow_LONG (ADD_LONG triggered when price rises past the shadow):
   *   post-fill ratio = (longQty + X) / shortQty
   *   constraint:      ≤ ratioBand.upper
   *   max_X = shortQty × ratioBand.upper − longQty
   *
   * For Shadow_SHORT (ADD_SHORT triggered when price falls past the shadow):
   *   post-fill ratio = longQty / (shortQty + Y)
   *   constraint:      ≥ ratioBand.lower
   *   max_Y = longQty / ratioBand.lower − shortQty
   *
   * Returns { finalQty, wasClamped, reason, maxAllowed }. If maxAllowed ≤ 0
   * the band is saturated and the caller should SKIP the order.
   */
  static clampShadowQty(side, proposedQty, longQty, shortQty, ratioBand) {
    const { lower, upper } = ratioBand || { lower: 0.85, upper: 1.15 };

    let maxAllowed;
    if (side === 'shadow_long') {
      maxAllowed = shortQty * upper - longQty;
    } else if (side === 'shadow_short') {
      maxAllowed = longQty / lower - shortQty;
    } else {
      throw new Error(`clampShadowQty: unknown side '${side}' (expected shadow_long or shadow_short)`);
    }

    if (maxAllowed <= 0) {
      return { finalQty: 0, wasClamped: true, reason: 'band_saturated', maxAllowed };
    }
    if (!Number.isFinite(proposedQty) || proposedQty <= 0) {
      return { finalQty: 0, wasClamped: false, reason: 'proposed_zero_or_invalid', maxAllowed };
    }
    if (proposedQty > maxAllowed) {
      return { finalQty: maxAllowed, wasClamped: true, reason: 'clamped_to_max', maxAllowed };
    }
    return { finalQty: proposedQty, wasClamped: false, reason: 'within_band', maxAllowed };
  }

  constructor(strategy) {
    this.strategy = strategy;
    this.activePlan = null;
    this.pendingActions = []; // Two actions: one ABOVE, one BELOW
  }

  /**
   * Install a new dual-action plan.
   */
  setActivePlan(plan) {
    this.activePlan = plan;
    this.pendingActions = [];

    if (plan.actionAbove) {
      this.pendingActions.push({ ...plan.actionAbove, direction: 'ABOVE', executed: false });
    }
    if (plan.actionBelow) {
      this.pendingActions.push({ ...plan.actionBelow, direction: 'BELOW', executed: false });
    }
  }

  /**
   * Check if any action's trigger is already satisfied at plan install time.
   * ABOVE triggers when price >= trigger, BELOW when price <= trigger.
   */
  checkImmediateTriggers(currentPrice) {
    if (!this.pendingActions || this.pendingActions.length === 0) return null;

    for (const action of this.pendingActions) {
      if (action.executed || !action.triggerPrice) continue;

      let triggered = false;
      if (action.direction === 'ABOVE') triggered = currentPrice >= action.triggerPrice;
      else if (action.direction === 'BELOW') triggered = currentPrice <= action.triggerPrice;

      if (triggered) {
        action.executed = true;
        for (const other of this.pendingActions) {
          if (other !== action) other.executed = true;
        }
        return { action, direction: action.direction };
      }
    }
    return null;
  }

  /**
   * Check if any action's trigger has been crossed on a price tick.
   * ABOVE triggers on upward cross, BELOW triggers on downward cross.
   */
  checkTriggers(prevPrice, currentPrice) {
    if (!this.pendingActions || this.pendingActions.length === 0) return null;

    for (const action of this.pendingActions) {
      if (action.executed || !action.triggerPrice) continue;

      let triggered = false;
      if (action.direction === 'ABOVE') {
        triggered = prevPrice < action.triggerPrice && currentPrice >= action.triggerPrice;
      } else if (action.direction === 'BELOW') {
        triggered = prevPrice > action.triggerPrice && currentPrice <= action.triggerPrice;
      }

      if (triggered) {
        action.executed = true;
        for (const other of this.pendingActions) {
          if (other !== action) other.executed = true;
        }
        return { action, direction: action.direction };
      }
    }
    return null;
  }

  /**
   * Execute a triggered action.
   */
  async executeAction(action) {
    const strategy = this.strategy;
    const symbol = strategy.symbol;

    if (action.type === 'HOLD') {
      await strategy.addLog(`[AI] HOLD: ${action.reason || 'waiting for better conditions'}`);
      return { status: 'HOLD' };
    }

    if (action.type === 'OPEN_HEDGE') {
      return await this._executeOpenHedge(action);
    }

    // Calculate quantity from sizeUSDT
    let quantity = action.quantity;
    if (!quantity && action.sizeUSDT) {
      quantity = await strategy._calculateAdjustedQuantity(symbol, action.sizeUSDT, action.triggerPrice);
    }
    if (!quantity || quantity <= 0) {
      throw new Error(`Cannot execute ${action.type}: quantity is ${quantity}`);
    }
    quantity = strategy.roundQuantity(quantity);

    let result;
    let restSide = null;
    let restPositionSide = null;

    switch (action.type) {
      case 'ADD_LONG':
        result = await strategy.placeMarketOrder(symbol, 'BUY', quantity, 'LONG');
        restSide = 'BUY'; restPositionSide = 'LONG';
        await strategy.addLog(`[AI] ADD_LONG: Bought ${quantity} @ market (target: ${strategy._formatPrice(action.triggerPrice)})`);
        break;

      case 'ADD_SHORT':
        result = await strategy.placeMarketOrder(symbol, 'SELL', quantity, 'SHORT');
        restSide = 'SELL'; restPositionSide = 'SHORT';
        await strategy.addLog(`[AI] ADD_SHORT: Sold ${quantity} @ market (target: ${strategy._formatPrice(action.triggerPrice)})`);
        break;

      case 'CUT_LONG':
        result = await strategy.placeMarketOrder(symbol, 'SELL', quantity, 'LONG');
        restSide = 'SELL'; restPositionSide = 'LONG';
        await strategy.addLog(`[AI] CUT_LONG: Sold ${quantity} LONG @ market`);
        break;

      case 'CUT_SHORT':
        result = await strategy.placeMarketOrder(symbol, 'BUY', quantity, 'SHORT');
        restSide = 'BUY'; restPositionSide = 'SHORT';
        await strategy.addLog(`[AI] CUT_SHORT: Bought ${quantity} SHORT @ market`);
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    // Schedule deferred REST fallback. If the user-data WS path saves trade
    // records for this orderId within REST_FALLBACK_DELAY_MS, the fallback
    // skips quietly. If WS misses, the fallback fetches /fapi/v1/userTrades
    // and writes proper per-fill records (with tradeId, qty, price, commission)
    // and accumulates the fees + realized PnL.
    if (result && result.orderId && restSide && restPositionSide) {
      strategy._scheduleRestFallback(result.orderId, symbol, restSide, restPositionSide);
    }

    if (strategy.riskGuard) strategy.riskGuard.recordAction();
    return result;
  }

  /**
   * Execute OPEN_HEDGE: place both LONG and SHORT simultaneously at market price.
   */
  async _executeOpenHedge(action) {
    const strategy = this.strategy;
    const symbol = strategy.symbol;

    const longQty = await strategy._calculateAdjustedQuantity(symbol, action.longSizeUSDT, action.triggerPrice);
    const shortQty = await strategy._calculateAdjustedQuantity(symbol, action.shortSizeUSDT, action.triggerPrice);

    if (!longQty || longQty <= 0) throw new Error(`OPEN_HEDGE: invalid LONG quantity from ${action.longSizeUSDT} USDT`);
    if (!shortQty || shortQty <= 0) throw new Error(`OPEN_HEDGE: invalid SHORT quantity from ${action.shortSizeUSDT} USDT`);

    const roundedLongQty = strategy.roundQuantity(longQty);
    const roundedShortQty = strategy.roundQuantity(shortQty);

    await strategy.addLog(`[AI] OPEN_HEDGE: Opening LONG ${roundedLongQty} (${action.longSizeUSDT} USDT) + SHORT ${roundedShortQty} (${action.shortSizeUSDT} USDT) @ market`);

    // Place both orders — LONG first, then SHORT immediately after
    const longResult = await strategy.placeMarketOrder(symbol, 'BUY', roundedLongQty, 'LONG');
    const shortResult = await strategy.placeMarketOrder(symbol, 'SELL', roundedShortQty, 'SHORT');

    // Schedule deferred REST fallback for each leg (see executeAction for rationale)
    if (longResult && longResult.orderId) strategy._scheduleRestFallback(longResult.orderId, symbol, 'BUY', 'LONG');
    if (shortResult && shortResult.orderId) strategy._scheduleRestFallback(shortResult.orderId, symbol, 'SELL', 'SHORT');

    if (strategy.riskGuard) strategy.riskGuard.recordAction();

    return { status: 'HEDGE_OPENED', longResult, shortResult };
  }

  getPendingActions() {
    return this.pendingActions.filter(a => !a.executed);
  }

  clearActions() {
    this.pendingActions = [];
    this.activePlan = null;
  }
}

export { AiPlanExecutor };
export default AiPlanExecutor;
