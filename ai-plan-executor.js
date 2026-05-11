/**
 * AiPlanExecutor — monitors trigger prices and executes AI plan actions.
 *
 * Phase 1 (INITIAL): one OPEN_HEDGE action ABOVE and one BELOW current price
 * (flat actionAbove/actionBelow shape). When one triggers, both legs open
 * atomically.
 *
 * Phase 2 (HEDGE): paired-trigger plan — primary + shadow on actionAbove,
 * primary + shadow on actionBelow. Shadow qty is band-clamped to keep
 * LONG/SHORT ratio in band even on one-sided fills.
 *
 * HOLD primaries carry a triggerPrice (synthesized at current ± 3×ATR if AI
 * doesn't supply one); when crossed, the strategy fires a replan instead of
 * placing an order. Shadow HOLDs are not pushed into pendingActions (only
 * primary HOLDs drive replan).
 */
const RATIO_BAND_DEFAULT = { lower: 0.85, upper: 1.15 };

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
    this.pendingActions = []; // Legacy: 2 actions. Paired: up to 4 (primary+shadow per side).
    this.isPairedMode = false; // True iff the active plan uses the v2.0.0 paired schema.
    this.clampWarnings = []; // Per-cycle log of qty clamps applied at install time.
  }

  /**
   * Install a new plan. Detects schema via plan._schema and unpacks accordingly.
   * - Legacy: 2 pending actions (one ABOVE, one BELOW), single-fire-cancels-other semantics.
   * - Paired: up to 4 pending actions (primary + shadow per side), no cross-cancellation
   *   so price moves through both shadow and primary fire both. Shadow qty is clamped
   *   here as a final safety net (AI is asked to pre-clamp in Phase D).
   */
  setActivePlan(plan) {
    this.activePlan = plan;
    this.pendingActions = [];
    this.clampWarnings = [];
    this.isPairedMode = plan?._schema === 'paired';

    if (this.isPairedMode) {
      this._installPairedPlan(plan);
    } else {
      this._installPhase1Plan(plan);
    }
  }

  // Phase 1 plan: flat actionAbove/actionBelow with type=OPEN_HEDGE on each
  // side (no _schema flag set). Phase 2 always uses paired schema, so this
  // path only fires for Phase 1 OPEN_HEDGE plans.
  _installPhase1Plan(plan) {
    if (plan.actionAbove) {
      this.pendingActions.push({ ...plan.actionAbove, direction: 'ABOVE', kind: 'primary', executed: false });
    }
    if (plan.actionBelow) {
      this.pendingActions.push({ ...plan.actionBelow, direction: 'BELOW', kind: 'primary', executed: false });
    }
  }

  _installPairedPlan(plan) {
    const longQty = this.strategy?.longPosition?.quantity || 0;
    const shortQty = this.strategy?.shortPosition?.quantity || 0;
    const ratioBand = plan.ratioBand || RATIO_BAND_DEFAULT;

    const installPair = (sideKey, direction) => {
      const side = plan[sideKey];
      if (!side) return;

      // Primary (ADD / CUT / HOLD). HOLD now carries a triggerPrice and
      // becomes a "wake-up" trigger — when crossed, the strategy fires a
      // replan instead of placing an order. Shadow HOLDs do NOT drive
      // wake-up (only primary does, per user directive).
      if (side.primary && side.primary.type !== 'SKIP') {
        this.pendingActions.push({
          type: side.primary.type,
          triggerPrice: side.primary.triggerPrice,
          quantity: side.primary.qty, // qty in SOL (paired schema), not USDT
          reason: side.primary.reason,
          direction,
          kind: 'primary',
          executed: false,
        });
      }

      // Shadow — push ADD shadows only. SKIP is a no-op; HOLD is no longer
      // a valid shadow type (validator rejects it). Only primary HOLD
      // drives wake-up.
      if (side.shadow && side.shadow.type !== 'SKIP') {
        const shadowSide = side.shadow.type === 'ADD_LONG' ? 'shadow_long' : 'shadow_short';
        const clamp = AiPlanExecutor.clampShadowQty(
          shadowSide,
          side.shadow.qty,
          longQty,
          shortQty,
          ratioBand,
        );
        if (clamp.wasClamped) {
          this.clampWarnings.push({
            sideKey, shadowType: side.shadow.type,
            proposed: side.shadow.qty, final: clamp.finalQty,
            reason: clamp.reason, maxAllowed: clamp.maxAllowed,
          });
        }
        if (clamp.finalQty > 0) {
          this.pendingActions.push({
            type: side.shadow.type,
            triggerPrice: side.shadow.triggerPrice,
            quantity: clamp.finalQty,
            reason: side.shadow.reason,
            direction,
            kind: 'shadow',
            executed: false,
            clampInfo: clamp.wasClamped ? { proposed: side.shadow.qty, reason: clamp.reason } : null,
          });
        }
      }
    };

    installPair('actionAbove', 'ABOVE');
    installPair('actionBelow', 'BELOW');
  }

  /**
   * Check if any action's trigger is already satisfied at plan install time.
   * ABOVE triggers when price >= trigger, BELOW when price <= trigger.
   */
  checkImmediateTriggers(currentPrice) {
    if (!this.pendingActions || this.pendingActions.length === 0) return null;

    // Order ABOVE actions ascending (closest-to-current first), BELOW descending
    // (closest-to-current first). Ensures shadow fires before primary on the
    // same side when both are crossed by an immediate price-spike at install time.
    const sorted = [...this.pendingActions].sort((a, b) => {
      if (a.direction === b.direction) {
        if (a.direction === 'ABOVE') return a.triggerPrice - b.triggerPrice;  // lower first
        return b.triggerPrice - a.triggerPrice;                                // higher first
      }
      return 0;
    });

    for (const action of sorted) {
      if (action.executed || !action.triggerPrice) continue;

      let triggered = false;
      if (action.direction === 'ABOVE') triggered = currentPrice >= action.triggerPrice;
      else if (action.direction === 'BELOW') triggered = currentPrice <= action.triggerPrice;

      if (triggered) {
        action.executed = true;
        // Legacy: cancel siblings so only one ADD/CUT fires per cycle.
        // Paired: leave siblings alive — primary on same side, or shadow on
        // the opposite side, may still fire on subsequent ticks (or right
        // after this one via the strategy's cascade loop).
        if (!this.isPairedMode) {
          for (const other of this.pendingActions) {
            if (other !== action) other.executed = true;
          }
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

    // Same closest-first ordering as checkImmediateTriggers.
    const sorted = [...this.pendingActions].sort((a, b) => {
      if (a.direction === b.direction) {
        if (a.direction === 'ABOVE') return a.triggerPrice - b.triggerPrice;
        return b.triggerPrice - a.triggerPrice;
      }
      return 0;
    });

    for (const action of sorted) {
      if (action.executed || !action.triggerPrice) continue;

      let triggered = false;
      if (action.direction === 'ABOVE') {
        triggered = prevPrice < action.triggerPrice && currentPrice >= action.triggerPrice;
      } else if (action.direction === 'BELOW') {
        triggered = prevPrice > action.triggerPrice && currentPrice <= action.triggerPrice;
      }

      if (triggered) {
        action.executed = true;
        if (!this.isPairedMode) {
          for (const other of this.pendingActions) {
            if (other !== action) other.executed = true;
          }
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

    // Calculate quantity from sizeUSDT. action.type passed through so
    // _calculateAdjustedQuantity can apply L5b dynamic scaling on ADD only.
    let quantity = action.quantity;
    if (!quantity && action.sizeUSDT) {
      quantity = await strategy._calculateAdjustedQuantity(symbol, action.sizeUSDT, action.triggerPrice, action.type);
    }
    if (!quantity || quantity <= 0) {
      throw new Error(`Cannot execute ${action.type}: quantity is ${quantity}`);
    }
    quantity = strategy.roundQuantity(quantity);

    // Belt-and-suspenders for CUT actions: even with floor-rounding upstream,
    // hard-clamp the qty against the actual leg quantity so a CUT can NEVER
    // exceed what's there. Prevents Binance error `-2018 insufficient position`
    // which would silently fail the CUT and leave the strategy in deadlock.
    // The clamped qty is re-rounded (floor) so the request stays on a stepSize
    // multiple even after clamp.
    if (action.type === 'CUT_LONG' && strategy.longPosition && strategy.longPosition.quantity > 0) {
      if (quantity > strategy.longPosition.quantity) {
        const before = quantity;
        quantity = strategy.roundQuantity(strategy.longPosition.quantity);
        await strategy.addLog(`[AI] CUT_LONG clamp: requested ${before} > leg qty ${strategy.longPosition.quantity}, capped at ${quantity}`);
      }
    }
    if (action.type === 'CUT_SHORT' && strategy.shortPosition && strategy.shortPosition.quantity > 0) {
      if (quantity > strategy.shortPosition.quantity) {
        const before = quantity;
        quantity = strategy.roundQuantity(strategy.shortPosition.quantity);
        await strategy.addLog(`[AI] CUT_SHORT clamp: requested ${before} > leg qty ${strategy.shortPosition.quantity}, capped at ${quantity}`);
      }
    }
    if ((action.type === 'CUT_LONG' || action.type === 'CUT_SHORT') && (!quantity || quantity <= 0)) {
      throw new Error(`Cannot execute ${action.type}: clamped quantity is ${quantity} (leg has nothing to CUT)`);
    }

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

    const longQty = await strategy._calculateAdjustedQuantity(symbol, action.longSizeUSDT, action.triggerPrice, 'OPEN_HEDGE');
    const shortQty = await strategy._calculateAdjustedQuantity(symbol, action.shortSizeUSDT, action.triggerPrice, 'OPEN_HEDGE');

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
