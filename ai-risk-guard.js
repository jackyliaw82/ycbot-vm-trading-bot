/**
 * AiRiskGuard — validates AI-generated plans against risk constraints.
 *
 * Guardrails:
 * 1. Max total position size
 * 2. Side imbalance ratio (5:1) — CUT-only mode when exceeded
 * 3. Trigger price sanity (within % of current price)
 * 4. Min order size (exchange minNotional)
 * 5. Rate limiting (max actions per hour)
 * 6. Gap projection — reject actions that would make gap negative
 * 7. Single-leg guard — stop if only one leg and price 5% away
 * 8. Fallback plan when AI is unavailable
 */

const FEE_RATE = 0.0008; // 0.08% per side

class AiRiskGuard {
  constructor(config = {}) {
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || 10000;
    this.maxImbalanceRatio = config.maxImbalanceRatio || 5.0;
    this.maxPriceDeviationPercent = config.maxPriceDeviationPercent || 5.0;
    this.maxActionsPerHour = config.maxActionsPerHour || 20;
    this.minNotional = config.minNotional || 5;
    this.singleLegStopPercent = config.singleLegStopPercent || 5.0;

    this._actionTimestamps = [];
    this.firstPositionPrice = null; // Track first ever position entry price
  }

  /**
   * Validate a dual-action plan (Phase 1 INITIAL or Phase 2 DCA).
   */
  validatePlan(plan, state) {
    if (!plan || !plan.actionAbove || !plan.actionBelow) {
      return { valid: false, reasons: ['Plan is null or missing actionAbove/actionBelow'] };
    }

    if (state.phase === 'INITIAL') {
      return this._validateInitialPlan(plan, state);
    }

    return this._validateDCAPlan(plan, state);
  }

  /**
   * Validate Phase 1 INITIAL plan (OPEN_HEDGE).
   */
  _validateInitialPlan(plan, state) {
    const reasons = [];
    const { currentPrice } = state;

    for (const key of ['actionAbove', 'actionBelow']) {
      const action = plan[key];

      if (action.type !== 'OPEN_HEDGE') {
        reasons.push(`${key}: INITIAL phase requires OPEN_HEDGE, got "${action.type}"`);
        continue;
      }

      // Trigger price sanity
      if (currentPrice && action.triggerPrice) {
        const deviation = Math.abs(action.triggerPrice - currentPrice) / currentPrice * 100;
        if (deviation > this.maxPriceDeviationPercent) {
          reasons.push(`${key}: trigger ${action.triggerPrice} is ${deviation.toFixed(1)}% from current price (max ${this.maxPriceDeviationPercent}%)`);
        }

        if (key === 'actionAbove' && action.triggerPrice <= currentPrice) {
          reasons.push(`actionAbove: trigger ${action.triggerPrice} not above current price ${currentPrice}`);
        }
        if (key === 'actionBelow' && action.triggerPrice >= currentPrice) {
          reasons.push(`actionBelow: trigger ${action.triggerPrice} not below current price ${currentPrice}`);
        }
      }

      // Min notional for both legs
      if (action.longSizeUSDT < this.minNotional) {
        reasons.push(`${key}: longSizeUSDT ${action.longSizeUSDT} below minNotional ${this.minNotional}`);
      }
      if (action.shortSizeUSDT < this.minNotional) {
        reasons.push(`${key}: shortSizeUSDT ${action.shortSizeUSDT} below minNotional ${this.minNotional}`);
      }

      // Total size check
      const totalSize = (action.longSizeUSDT || 0) + (action.shortSizeUSDT || 0);
      if (totalSize > this.maxPositionSizeUSDT) {
        reasons.push(`${key}: total ${totalSize} exceeds max ${this.maxPositionSizeUSDT}`);
      }
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Validate Phase 2 DCA plan.
   */
  _validateDCAPlan(plan, state) {
    const reasons = [];
    const { currentPrice, longPosition, shortPosition } = state;

    const longNotional = longPosition?.notional || 0;
    const shortNotional = shortPosition?.notional || 0;
    const imbalanceRatio = (longNotional > 0 && shortNotional > 0)
      ? Math.max(longNotional / shortNotional, shortNotional / longNotional)
      : 0;

    for (const key of ['actionAbove', 'actionBelow']) {
      const action = plan[key];
      if (action.type === 'HOLD') continue;

      // Trigger price sanity
      if (currentPrice && action.triggerPrice) {
        const deviation = Math.abs(action.triggerPrice - currentPrice) / currentPrice * 100;
        if (deviation > this.maxPriceDeviationPercent) {
          reasons.push(`${key}: trigger ${action.triggerPrice} is ${deviation.toFixed(1)}% from current price (max ${this.maxPriceDeviationPercent}%)`);
        }

        if (key === 'actionAbove' && action.triggerPrice <= currentPrice) {
          reasons.push(`actionAbove: trigger not above current price`);
        }
        if (key === 'actionBelow' && action.triggerPrice >= currentPrice) {
          reasons.push(`actionBelow: trigger not below current price`);
        }
      }

      // Min order size
      if (action.sizeUSDT && action.sizeUSDT < this.minNotional) {
        reasons.push(`${key}: size ${action.sizeUSDT} below minNotional ${this.minNotional}`);
      }

      // Max position size
      if (action.type === 'ADD_LONG' || action.type === 'ADD_SHORT') {
        const currentTotal = longNotional + shortNotional;
        if (currentTotal + (action.sizeUSDT || 0) > this.maxPositionSizeUSDT) {
          reasons.push(`${key}: would exceed max position size`);
        }
      }

      // Imbalance > 5:1 — reject ADD to lighter side
      if (imbalanceRatio > this.maxImbalanceRatio) {
        const lighterSide = longNotional < shortNotional ? 'LONG' : 'SHORT';
        if ((action.type === 'ADD_LONG' && lighterSide === 'LONG') ||
            (action.type === 'ADD_SHORT' && lighterSide === 'SHORT')) {
          reasons.push(`${key}: imbalance ${imbalanceRatio.toFixed(1)}:1 — CUT-only mode, cannot ADD to lighter side`);
        }
      }

      // Gap projection guard
      if ((action.type === 'ADD_LONG' || action.type === 'ADD_SHORT') &&
          longPosition && shortPosition && action.triggerPrice && action.sizeUSDT) {
        const projection = this.projectGap(action, longPosition, shortPosition);
        if (projection.projectedGap < 0) {
          reasons.push(`${key}: ${action.type} at ${action.triggerPrice} would flip gap to ${projection.projectedGap.toFixed(4)} (current: ${projection.currentGap.toFixed(4)})`);
        }
      }
    }

    // Rate limiting
    const now = Date.now();
    this._actionTimestamps = this._actionTimestamps.filter(t => t > now - 3600000);
    if (this._actionTimestamps.length >= this.maxActionsPerHour) {
      reasons.push(`Rate limit: ${this._actionTimestamps.length} actions in last hour (max ${this.maxActionsPerHour})`);
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Project the gap after an ADD action.
   */
  projectGap(action, longPosition, shortPosition) {
    const longAvg = longPosition.entryPrice || longPosition.avgEntry;
    const shortAvg = shortPosition.entryPrice || shortPosition.avgEntry;
    const longQty = longPosition.quantity;
    const shortQty = shortPosition.quantity;
    const currentGap = shortAvg - longAvg;

    let projectedLongAvg = longAvg;
    let projectedShortAvg = shortAvg;

    if (action.type === 'ADD_LONG' && action.triggerPrice && action.sizeUSDT) {
      const addQty = action.sizeUSDT / action.triggerPrice;
      projectedLongAvg = (longAvg * longQty + action.triggerPrice * addQty) / (longQty + addQty);
    }

    if (action.type === 'ADD_SHORT' && action.triggerPrice && action.sizeUSDT) {
      const addQty = action.sizeUSDT / action.triggerPrice;
      projectedShortAvg = (shortAvg * shortQty + action.triggerPrice * addQty) / (shortQty + addQty);
    }

    const projectedGap = projectedShortAvg - projectedLongAvg;
    return { currentGap, projectedGap, projectedLongAvg, projectedShortAvg };
  }

  /**
   * Check single-leg guard: if only one leg is open and price is >5% from first position price.
   */
  checkSingleLegGuard(longPosition, shortPosition, currentPrice) {
    if (!this.firstPositionPrice || !currentPrice) return { shouldStop: false };

    const hasLong = longPosition && longPosition.quantity > 0;
    const hasShort = shortPosition && shortPosition.quantity > 0;

    // Both legs exist or neither — guard doesn't apply
    if ((hasLong && hasShort) || (!hasLong && !hasShort)) {
      return { shouldStop: false };
    }

    const deviation = Math.abs(currentPrice - this.firstPositionPrice) / this.firstPositionPrice * 100;
    if (deviation > this.singleLegStopPercent) {
      return {
        shouldStop: true,
        reason: `Single-leg guard: price ${currentPrice} is ${deviation.toFixed(1)}% from first position price ${this.firstPositionPrice} (max ${this.singleLegStopPercent}%)`,
      };
    }

    return { shouldStop: false };
  }

  recordAction() {
    this._actionTimestamps.push(Date.now());
  }

  /**
   * Generate a fallback dual-action plan when AI is unavailable.
   */
  generateFallbackPlan(currentPrice, state, reason = 'AI unavailable') {
    const { longPosition, shortPosition, positionSizeUSDT, volatility, phase } = state;
    const atrPercent = (volatility && volatility.atrPercent > 0.3) ? volatility.atrPercent : 0.3;
    const gridStep = currentPrice * (atrPercent / 100);

    if (phase === 'INITIAL') {
      return {
        analysis: `Fallback INITIAL plan — ${reason}. Using ATR-based grid entries.`,
        actionAbove: {
          type: 'OPEN_HEDGE',
          triggerPrice: currentPrice + gridStep,
          longSizeUSDT: positionSizeUSDT * 0.4,
          shortSizeUSDT: positionSizeUSDT * 0.6,
          reason: 'Fallback: OPEN_HEDGE above with 60:40 SHORT-heavy',
        },
        actionBelow: {
          type: 'OPEN_HEDGE',
          triggerPrice: currentPrice - gridStep,
          longSizeUSDT: positionSizeUSDT * 0.6,
          shortSizeUSDT: positionSizeUSDT * 0.4,
          reason: 'Fallback: OPEN_HEDGE below with 60:40 LONG-heavy',
        },
        probabilityAssessment: { higherChance: 'ABOVE', confidence: 'low', reasoning: 'Fallback plan' },
      };
    }

    // DCA fallback
    let actionAbove, actionBelow;

    if (!longPosition && !shortPosition) {
      actionAbove = { type: 'HOLD', reason: 'Fallback: no positions' };
      actionBelow = { type: 'HOLD', reason: 'Fallback: no positions' };
    } else {
      actionAbove = {
        type: 'ADD_SHORT',
        triggerPrice: currentPrice + gridStep * 2,
        sizeUSDT: positionSizeUSDT,
        reason: 'Fallback: DCA SHORT above (2x ATR)',
      };
      actionBelow = {
        type: 'ADD_LONG',
        triggerPrice: currentPrice - gridStep * 2,
        sizeUSDT: positionSizeUSDT,
        reason: 'Fallback: DCA LONG below (2x ATR)',
      };
    }

    return {
      analysis: `Fallback DCA plan — ${reason}.`,
      actionAbove,
      actionBelow,
      probabilityAssessment: { higherChance: 'ABOVE', confidence: 'low', reasoning: 'Fallback' },
    };
  }

  static get FEE_RATE() {
    return FEE_RATE;
  }
}

export { AiRiskGuard, FEE_RATE };
export default AiRiskGuard;
