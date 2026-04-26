/**
 * AiPlanExecutor — monitors trigger prices and executes AI plan actions.
 *
 * Dual-action model: each plan has one action ABOVE and one BELOW current price.
 * When one triggers, the other is cancelled and a fresh plan is requested.
 *
 * Supports OPEN_HEDGE (Phase 1) which opens both LONG and SHORT simultaneously,
 * and ADD/CUT actions (Phase 2) for DCA.
 */
class AiPlanExecutor {
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

    // Save trade record from REST response — this is the reliable path. The
    // user-data WS-based saveTrade in trading-base._handleOrderTradeUpdate stays
    // as the primary for fee/PnL accumulation, but if user-data WS is silent
    // (relay silent-stuck or otherwise), at least the chart marker gets a record.
    if (result && restSide && restPositionSide) {
      await strategy._saveTradeFromOrderResult(result, symbol, restSide, restPositionSide);
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

    // Save trade records from REST responses (reliable path; see executeAction)
    if (longResult) await strategy._saveTradeFromOrderResult(longResult, symbol, 'BUY', 'LONG');
    if (shortResult) await strategy._saveTradeFromOrderResult(shortResult, symbol, 'SELL', 'SHORT');

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
