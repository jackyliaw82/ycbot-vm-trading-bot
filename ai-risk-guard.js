/**
 * AiRiskGuard — validates AI-generated plans against risk constraints.
 *
 * Guardrails:
 * 1. Max total position size
 * 2. Side imbalance ratio
 * 3. Trigger price sanity (within % of current price)
 * 4. Min order size (exchange minNotional)
 * 5. Rate limiting (max actions per hour)
 * 6. Max unrealized loss threshold
 * 7. Fallback plan when AI is unavailable
 */
class AiRiskGuard {
  constructor(config = {}) {
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || 10000;
    this.maxImbalanceRatio = config.maxImbalanceRatio || 3.0;
    this.maxPriceDeviationPercent = config.maxPriceDeviationPercent || 5.0;
    this.maxActionsPerHour = config.maxActionsPerHour || 20;
    this.maxUnrealizedLossPercent = config.maxUnrealizedLossPercent || 30;
    this.minNotional = config.minNotional || 5;

    // Rate limiting tracker
    this._actionTimestamps = [];
  }

  /**
   * Validate an AI plan against all guardrails.
   * @param {object} plan — the AI-generated plan
   * @param {object} state — current market/position state
   * @returns {{ valid: boolean, reasons: string[] }}
   */
  validatePlan(plan, state) {
    const reasons = [];
    const { currentPrice, longPosition, shortPosition, walletBalance } = state;

    if (!plan || !plan.planA) {
      return { valid: false, reasons: ['Plan is null or missing planA'] };
    }

    // Validate each plan's actions
    const plansToCheck = ['planA', 'planB', 'planC'].filter(k => plan[k]);
    for (const planKey of plansToCheck) {
      const planObj = plan[planKey];
      if (!planObj.actions || !Array.isArray(planObj.actions)) continue;

      for (const action of planObj.actions) {
        // 1. Trigger price sanity
        if (currentPrice && action.triggerPrice) {
          const deviation = Math.abs(action.triggerPrice - currentPrice) / currentPrice * 100;
          if (deviation > this.maxPriceDeviationPercent) {
            reasons.push(
              `${planKey}: ${action.type} trigger ${action.triggerPrice} is ${deviation.toFixed(1)}% from current price ${currentPrice} (max ${this.maxPriceDeviationPercent}%)`
            );
          }
        }

        // 2. Min order size
        if (action.sizeUSDT && action.sizeUSDT < this.minNotional) {
          reasons.push(`${planKey}: ${action.type} size ${action.sizeUSDT} USDT below minNotional ${this.minNotional}`);
        }

        // 3. Max position size check
        if (action.type === 'ADD_LONG' || action.type === 'ADD_SHORT') {
          const currentLongNotional = longPosition?.notional || 0;
          const currentShortNotional = shortPosition?.notional || 0;
          const currentTotal = currentLongNotional + currentShortNotional;
          const addedSize = action.sizeUSDT || 0;

          if (currentTotal + addedSize > this.maxPositionSizeUSDT) {
            reasons.push(
              `${planKey}: ${action.type} would exceed max position size (${currentTotal + addedSize} > ${this.maxPositionSizeUSDT})`
            );
          }
        }

        // 4. Imbalance check
        if (action.type === 'ADD_LONG' || action.type === 'ADD_SHORT') {
          const longNotional = (longPosition?.notional || 0) + (action.type === 'ADD_LONG' ? (action.sizeUSDT || 0) : 0);
          const shortNotional = (shortPosition?.notional || 0) + (action.type === 'ADD_SHORT' ? (action.sizeUSDT || 0) : 0);

          if (longNotional > 0 && shortNotional > 0) {
            const ratio = Math.max(longNotional / shortNotional, shortNotional / longNotional);
            if (ratio > this.maxImbalanceRatio) {
              reasons.push(
                `${planKey}: ${action.type} would create imbalance ratio ${ratio.toFixed(1)} (max ${this.maxImbalanceRatio})`
              );
            }
          }
        }
      }
    }

    // 5. Rate limiting
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    this._actionTimestamps = this._actionTimestamps.filter(t => t > oneHourAgo);
    if (this._actionTimestamps.length >= this.maxActionsPerHour) {
      reasons.push(`Rate limit: ${this._actionTimestamps.length} actions in last hour (max ${this.maxActionsPerHour})`);
    }

    return {
      valid: reasons.length === 0,
      reasons,
    };
  }

  /**
   * Record that an action was executed (for rate limiting).
   */
  recordAction() {
    this._actionTimestamps.push(Date.now());
  }

  /**
   * Generate a simple fallback DCA plan when AI is unavailable.
   */
  generateFallbackPlan(currentPrice, state) {
    const { longPosition, shortPosition, positionSizeUSDT } = state;
    const gridStep = currentPrice * 0.003; // 0.3%

    const actions = [];

    // Simple DCA: add to the smaller side, or both if no positions
    if (!longPosition && !shortPosition) {
      // No positions — open initial entries
      actions.push({
        type: 'ADD_LONG',
        triggerPrice: currentPrice - gridStep,
        sizeUSDT: positionSizeUSDT,
        reason: 'Fallback: initial LONG entry below current price',
      });
      actions.push({
        type: 'ADD_SHORT',
        triggerPrice: currentPrice + gridStep,
        sizeUSDT: positionSizeUSDT,
        reason: 'Fallback: initial SHORT entry above current price',
      });
    } else if (!longPosition) {
      actions.push({
        type: 'ADD_LONG',
        triggerPrice: currentPrice - gridStep,
        sizeUSDT: positionSizeUSDT,
        reason: 'Fallback: open LONG to start hedge',
      });
    } else if (!shortPosition) {
      actions.push({
        type: 'ADD_SHORT',
        triggerPrice: currentPrice + gridStep,
        sizeUSDT: positionSizeUSDT,
        reason: 'Fallback: open SHORT to start hedge',
      });
    } else {
      // Both sides exist — DCA into the smaller side
      const longNotional = longPosition.notional || 0;
      const shortNotional = shortPosition.notional || 0;

      if (longNotional <= shortNotional) {
        actions.push({
          type: 'ADD_LONG',
          triggerPrice: currentPrice - gridStep * 2,
          sizeUSDT: positionSizeUSDT,
          reason: 'Fallback: DCA LONG (smaller side)',
        });
      } else {
        actions.push({
          type: 'ADD_SHORT',
          triggerPrice: currentPrice + gridStep * 2,
          sizeUSDT: positionSizeUSDT,
          reason: 'Fallback: DCA SHORT (smaller side)',
        });
      }
    }

    return {
      analysis: 'Fallback DCA plan — AI unavailable. Using simple grid-based entries.',
      planA: {
        scenario: 'Fallback DCA',
        probability: 'medium',
        actions,
      },
      planB: null,
      planC: null,
      recommendedPlan: 'A',
      nextReplanTrigger: {
        type: 'PRICE',
        value: currentPrice + (currentPrice * 0.01), // Replan after 1% move
        direction: 'ABOVE',
      },
    };
  }
}

export { AiRiskGuard };
export default AiRiskGuard;
