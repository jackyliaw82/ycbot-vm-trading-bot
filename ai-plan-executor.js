/**
 * AiPlanExecutor — monitors trigger prices and executes AI plan actions.
 *
 * Translates AI-generated plan actions into real Binance orders
 * using the TradingBase infrastructure.
 */
class AiPlanExecutor {
  constructor(strategy) {
    this.strategy = strategy; // Reference to AiHedgeStrategy (extends TradingBase)

    // Active plan state
    this.activePlan = null;
    this.selectedPlanKey = null;
    this.pendingActions = []; // Actions from the selected plan, sorted by trigger price
  }

  /**
   * Install a new plan and prepare trigger monitoring.
   * @param {object} plan — the validated AI plan
   * @param {string} selectedPlanKey — 'planA', 'planB', or 'planC'
   */
  setActivePlan(plan, selectedPlanKey = 'planA') {
    this.activePlan = plan;
    this.selectedPlanKey = `plan${selectedPlanKey}`;

    const selectedPlan = plan[this.selectedPlanKey];
    if (selectedPlan && selectedPlan.actions) {
      // Clone actions and mark as pending
      this.pendingActions = selectedPlan.actions.map(a => ({
        ...a,
        executed: false,
      }));
    } else {
      this.pendingActions = [];
    }
  }

  /**
   * Check if any action's trigger price has been crossed.
   * Called on every price tick from handleRealtimePrice().
   *
   * @param {number} prevPrice — previous tick price
   * @param {number} currentPrice — current tick price
   * @returns {{ action, planKey } | null} — the triggered action, or null
   */
  checkTriggers(prevPrice, currentPrice) {
    if (!this.pendingActions || this.pendingActions.length === 0) return null;

    for (const action of this.pendingActions) {
      if (action.executed) continue;

      const triggerPrice = action.triggerPrice;
      if (!triggerPrice) continue;

      let triggered = false;

      // Determine trigger direction based on action type
      switch (action.type) {
        case 'ADD_LONG':
        case 'CUT_SHORT':
          // Trigger when price drops TO or BELOW the trigger price
          triggered = prevPrice > triggerPrice && currentPrice <= triggerPrice;
          break;

        case 'ADD_SHORT':
        case 'CUT_LONG':
          // Trigger when price rises TO or ABOVE the trigger price
          triggered = prevPrice < triggerPrice && currentPrice >= triggerPrice;
          break;

        case 'TP_LONG':
          // Take profit LONG — trigger when price rises above
          triggered = prevPrice < triggerPrice && currentPrice >= triggerPrice;
          break;

        case 'TP_SHORT':
          // Take profit SHORT — trigger when price drops below
          triggered = prevPrice > triggerPrice && currentPrice <= triggerPrice;
          break;

        case 'CLOSE_HEDGE':
          // Close hedge — trigger in either direction
          triggered = (prevPrice < triggerPrice && currentPrice >= triggerPrice) ||
                      (prevPrice > triggerPrice && currentPrice <= triggerPrice);
          break;
      }

      if (triggered) {
        action.executed = true;
        return { action, planKey: this.selectedPlanKey };
      }
    }

    return null;
  }

  /**
   * Execute a triggered action by placing orders through TradingBase.
   *
   * @param {object} action — the action to execute
   * @returns {object} — execution result
   */
  async executeAction(action) {
    const strategy = this.strategy;
    const symbol = strategy.symbol;

    // Calculate quantity from sizeUSDT if not provided
    let quantity = action.quantity;
    if (!quantity && action.sizeUSDT) {
      quantity = await strategy._calculateAdjustedQuantity(symbol, action.sizeUSDT, action.triggerPrice);
    }
    if (!quantity || quantity <= 0) {
      throw new Error(`Cannot execute ${action.type}: quantity is ${quantity}`);
    }

    // Round quantity
    quantity = strategy.roundQuantity(quantity);

    let result;

    switch (action.type) {
      case 'ADD_LONG':
        // BUY to open/add LONG
        result = await strategy.placeMarketOrder(symbol, 'BUY', quantity, 'LONG');
        await strategy.addLog(`[AI] ADD_LONG: Bought ${quantity} @ market (target: ${strategy._formatPrice(action.triggerPrice)})`);
        break;

      case 'ADD_SHORT':
        // SELL to open/add SHORT
        result = await strategy.placeMarketOrder(symbol, 'SELL', quantity, 'SHORT');
        await strategy.addLog(`[AI] ADD_SHORT: Sold ${quantity} @ market (target: ${strategy._formatPrice(action.triggerPrice)})`);
        break;

      case 'CUT_LONG':
        // SELL to reduce/close LONG
        result = await strategy.placeMarketOrder(symbol, 'SELL', quantity, 'LONG');
        await strategy.addLog(`[AI] CUT_LONG: Sold ${quantity} LONG @ market`);
        break;

      case 'CUT_SHORT':
        // BUY to reduce/close SHORT
        result = await strategy.placeMarketOrder(symbol, 'BUY', quantity, 'SHORT');
        await strategy.addLog(`[AI] CUT_SHORT: Bought ${quantity} SHORT @ market`);
        break;

      case 'TP_LONG':
        // SELL to take profit on LONG
        result = await strategy.placeMarketOrder(symbol, 'SELL', quantity, 'LONG');
        await strategy.addLog(`[AI] TP_LONG: Took profit, sold ${quantity} LONG @ market`);
        break;

      case 'TP_SHORT':
        // BUY to take profit on SHORT
        result = await strategy.placeMarketOrder(symbol, 'BUY', quantity, 'SHORT');
        await strategy.addLog(`[AI] TP_SHORT: Took profit, bought ${quantity} SHORT @ market`);
        break;

      case 'CLOSE_HEDGE': {
        // Close both sides completely
        const positions = await strategy.detectHedgePositions();

        if (positions.long && positions.long.quantity > 0) {
          const longQty = strategy.roundQuantity(positions.long.quantity);
          await strategy.placeMarketOrder(symbol, 'SELL', longQty, 'LONG');
          await strategy.addLog(`[AI] CLOSE_HEDGE: Closed LONG ${longQty}`);
        }
        if (positions.short && positions.short.quantity > 0) {
          const shortQty = strategy.roundQuantity(positions.short.quantity);
          await strategy.placeMarketOrder(symbol, 'BUY', shortQty, 'SHORT');
          await strategy.addLog(`[AI] CLOSE_HEDGE: Closed SHORT ${shortQty}`);
        }

        result = { status: 'HEDGE_CLOSED' };
        break;
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    // Record action in risk guard
    if (strategy.riskGuard) {
      strategy.riskGuard.recordAction();
    }

    return result;
  }

  /**
   * Get the current state of pending actions.
   */
  getPendingActions() {
    return this.pendingActions.filter(a => !a.executed);
  }

  /**
   * Clear all pending actions (e.g., when a new plan is installed).
   */
  clearActions() {
    this.pendingActions = [];
    this.activePlan = null;
    this.selectedPlanKey = null;
  }
}

export { AiPlanExecutor };
export default AiPlanExecutor;
