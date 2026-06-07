/**
 * AiPlanExecutor — executes AI Reversal plan actions.
 *
 * One-way position mode: positionSide is always 'BOTH'. The orchestrator
 * (ai-reversal-strategy.js) tracks the current side/qty/entry and decides when
 * to open, reverse, or harvest; this executor just routes the resulting verbs
 * to placeMarketOrder.
 *
 * Verbs:
 *   - OPEN_LONG_AT_LEVEL / OPEN_SHORT_AT_LEVEL — open a fresh position at a level.
 *   - HARVEST_CLOSE — fully close the current position to flat.
 * Reversals (close current leg + reopen opposite) are performed by the
 * orchestrator's own placeMarketOrder calls, not through this executor.
 */
class AiPlanExecutor {
  constructor(strategy) {
    this.strategy = strategy;
  }

  /**
   * Execute a triggered action.
   */
  async executeAction(action) {
    if (action.type === 'OPEN_LONG_AT_LEVEL' || action.type === 'OPEN_SHORT_AT_LEVEL') {
      return await this._executeOpenAtLevel(action);
    }
    if (action.type === 'HARVEST_CLOSE') {
      return await this._executeHarvestClose(action);
    }
    throw new Error(`Unknown action type: ${action.type}`);
  }

  // ——— AI Reversal Strategy execution helpers ——————————————————————————
  //
  // One-way position mode: positionSide is always 'BOTH'. Clamps/reads use
  // strategy.activePosition.quantity (the OBJECT representation;
  // strategy.currentPosition is the STRING side from TradingBase's
  // `detectCurrentPosition`).

  /**
   * OPEN_LONG_AT_LEVEL / OPEN_SHORT_AT_LEVEL — initial entry or post-harvest
   * fresh entry. qty comes from the orchestrator (initial size or AI-vetoed
   * value). triggerPrice is the level that was touched.
   */
  async _executeOpenAtLevel(action) {
    const strategy = this.strategy;
    const symbol = strategy.symbol;
    const isLong = action.type === 'OPEN_LONG_AT_LEVEL';
    const side = isLong ? 'BUY' : 'SELL';
    const positionSide = 'BOTH';

    let quantity = action.quantity;
    if (!quantity && action.sizeUSDT && action.triggerPrice) {
      quantity = await strategy._calculateAdjustedQuantity(symbol, action.sizeUSDT, action.triggerPrice, action.type);
    }
    if (!quantity || quantity <= 0) {
      throw new Error(`Cannot execute ${action.type}: quantity is ${quantity}`);
    }
    quantity = strategy.roundQuantity(quantity);

    await strategy.addLog(`[AI] ${action.type}: ${side} ${quantity} @ market (level: ${strategy._formatPrice(action.triggerPrice)})`);
    const result = await strategy.placeMarketOrder(symbol, side, quantity, positionSide);

    if (result && result.orderId) {
      strategy._scheduleRestFallback(result.orderId, symbol, side, positionSide);
    }
    if (strategy.riskGuard) strategy.riskGuard.recordAction();
    return { status: 'OPENED', side: isLong ? 'LONG' : 'SHORT', quantity, result };
  }

  /**
   * HARVEST_CLOSE — fully close the current position to flat. Realized PnL
   * reduces accumulated_loss. Orchestrator follows up with a Context 1
   * PLAN consult to set fresh bullLevel/bearLevel.
   */
  async _executeHarvestClose(action) {
    const strategy = this.strategy;
    const symbol = strategy.symbol;
    // reversal's position OBJECT lives on activePosition; currentPosition on
    // the base class is a STRING.
    const currentPos = strategy.activePosition;
    const currentSide = strategy.currentSide;

    if (!currentPos || !currentPos.quantity || currentPos.quantity <= 0) {
      throw new Error('HARVEST_CLOSE: no current position to harvest');
    }
    // Close the full position raw — currentPos.quantity comes from Binance
    // and is already step-aligned, so we dodge FP edge cases in roundQuantity.
    const closeQty = currentPos.quantity;
    const closeSide = currentSide === 'LONG' ? 'SELL' : 'BUY';

    await strategy.addLog(`[AI] HARVEST_CLOSE: closing ${currentSide} ${closeQty} @ market — ${action.reason || 'AI harvest'}`);
    // reduceOnly (v4.4.6) — bypasses Binance's notional check so
    // sub-minNotional residue can close. Critical for stop+flatten on
    // a stuck cycle (e.g., 0.01 SOL residue from a pre-4.4.5 replan
    // mishap = ~$0.83 notional, far below $5 min — without reduceOnly
    // Binance rejects with error -4164).
    const result = await strategy.placeMarketOrder(symbol, closeSide, closeQty, 'BOTH', { reduceOnly: true });
    if (result && result.orderId) {
      strategy._scheduleRestFallback(result.orderId, symbol, closeSide, 'BOTH');
    }
    if (strategy.riskGuard) strategy.riskGuard.recordAction();
    return { status: 'HARVESTED', closeQty, side: currentSide, result };
  }
}

export { AiPlanExecutor };
export default AiPlanExecutor;
