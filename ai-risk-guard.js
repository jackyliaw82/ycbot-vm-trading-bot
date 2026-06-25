/**
 * AiRiskGuard — validates AI Reversal plans.
 *
 * A thin per-consult-context validator (NOT a fallback-plan generator). It
 * checks each plan's shape and bounds (level math, sizing, allowed verbs).
 *
 * Failure mode: validation rejection signals the strategy to stale-counter
 * retry (no fallback plan generated here).
 */

const FEE_RATE = 0.0008; // 0.08% per side

class AiRiskGuard {
  constructor(config = {}) {
    this.maxPositionSizeUSDT = config.maxPositionSizeUSDT || 10000;
    this.minNotional = config.minNotional || 5;
    this._actionTimestamps = [];
  }

  /**
   * Validate a plan against risk constraints. Reversal is the only plan
   * producer; any other schema is a programming error and is rejected.
   */
  validatePlan(plan, state) {
    if (!plan) {
      return { valid: false, reasons: ['Plan is null'] };
    }
    if (plan._schema === 'reversal' || state.strategyType === 'reversal') {
      return this._validateReversalPlan(plan, state);
    }
    return { valid: false, reasons: ['Unsupported plan schema (only reversal plans are supported)'] };
  }

  /**
   * Validate an AI Reversal Strategy plan.
   *
   * Per-context validation:
   *   - 'plan'          → decision=PLAN, level math, sizing within bounds.
   *                       Fires once at cycle start; bull/bear stay fixed for
   *                       the rest of the cycle.
   *   - 'harvest_price' → decision=HARVEST_PRICE, harvestPrice on the
   *                       profitable side of the current position's entry
   *                       (LONG: > entry; SHORT: < entry).
   *   - 'veto'          → decision in {CONTINUE, REDUCE}, REDUCE size within bounds.
   *
   * Disallowed verbs (REPLAN / PAUSE / EXIT / ADJUST / HARVEST without
   * _PRICE / CONTINUE in a non-veto context) are rejected here as defense
   * in depth; the prompt also forbids them.
   */
  _validateReversalPlan(plan, state) {
    const reasons = [];
    const consultContext = plan._consultContext || state.consultContext || 'plan';
    const { currentPrice, volatility } = state;
    const atr = volatility?.atr || 0;
    const minSpacing = atr * (state.minLevelSpacingATR || 1.5);

    // Reject forbidden verbs outright (defense in depth). ADJUST and bare
    // HARVEST were heartbeat-only verbs; the heartbeat is gone but a stale
    // prompt or mis-trained model could still emit them, so we explicitly
    // block. HARVEST_PRICE (the new verb) is intentionally NOT in this list.
    if (['REPLAN', 'PAUSE', 'EXIT', 'ADJUST', 'HARVEST'].includes(plan.decision)) {
      reasons.push(`Verb ${plan.decision} is not allowed in the reversal strategy verb space`);
      return { valid: false, reasons };
    }

    if (consultContext === 'plan') {
      if (plan.decision !== 'PLAN') {
        reasons.push(`plan context: expected decision=PLAN, got ${plan.decision}`);
      }
      this._validateReversalLevels(plan, currentPrice, minSpacing, reasons);
      // Optional newInitialSize override — must be within bounds if present.
      if (plan.newInitialSize != null) {
        const floor = this.minNotional * 2;
        if (plan.newInitialSize < floor) {
          reasons.push(`newInitialSize ${plan.newInitialSize} below minNotional×2 (${floor})`);
        }
        if (this.maxPositionSizeUSDT && plan.newInitialSize > this.maxPositionSizeUSDT) {
          reasons.push(`newInitialSize ${plan.newInitialSize} above maxPositionSizeUSDT (${this.maxPositionSizeUSDT})`);
        }
      }
    } else if (consultContext === 'harvest_price') {
      if (plan.decision !== 'HARVEST_PRICE') {
        reasons.push(`harvest_price context: expected decision=HARVEST_PRICE, got ${plan.decision}`);
      }
      if (typeof plan.harvestPrice !== 'number' || !Number.isFinite(plan.harvestPrice) || plan.harvestPrice <= 0) {
        reasons.push('harvest_price: harvestPrice must be a positive finite number');
      } else {
        // Direction check: harvestPrice must be on the profitable side of
        // the current position's entry. Without a position there's nothing
        // to validate against — but the strategy only fires this consult
        // when a position is open, so missing position is a programming
        // error (still tolerated as a soft warning rather than a reject).
        const pos = state.currentPosition;
        const side = state.currentSide;
        const entry = pos?.avgEntry ?? pos?.entryPrice;
        if (!pos || !Number.isFinite(entry) || entry <= 0) {
          reasons.push('harvest_price: no active position to validate harvestPrice against');
        } else if (side === 'LONG' && plan.harvestPrice <= entry) {
          reasons.push(`harvest_price: LONG requires harvestPrice (${plan.harvestPrice}) > entry (${entry}) for a profitable close`);
        } else if (side === 'SHORT' && plan.harvestPrice >= entry) {
          reasons.push(`harvest_price: SHORT requires harvestPrice (${plan.harvestPrice}) < entry (${entry}) for a profitable close`);
        }
      }
    } else if (consultContext === 'veto') {
      if (!['CONTINUE', 'REDUCE'].includes(plan.decision)) {
        reasons.push(`veto: decision must be CONTINUE | REDUCE, got ${plan.decision}`);
      }
      if (plan.decision === 'REDUCE') {
        if (typeof plan.newSize !== 'number' || plan.newSize <= 0) {
          reasons.push('REDUCE requires positive newSize');
        } else {
          const floor = this.minNotional * 2;
          if (plan.newSize < floor) {
            reasons.push(`REDUCE newSize ${plan.newSize} below minNotional×2 (${floor})`);
          }
          if (state.proposedNewSize != null && plan.newSize > state.proposedNewSize) {
            reasons.push(`REDUCE newSize ${plan.newSize} exceeds proposedNewSize ${state.proposedNewSize}`);
          }
        }
      }
    } else if (consultContext === 'user_question') {
      // Advisory consult — bot does not act on the response. Only enforce
      // the shape constraint (planner already did this) plus the standard
      // forbidden-verb check at the top. Proposed levels are NOT validated
      // here because the user may legitimately ask about a "wrong-side"
      // level (e.g. "what if I move bear to 110% of current?"). The
      // adjust-levels endpoint validates and warns at apply time.
      if (plan.decision !== 'ADVISE') {
        reasons.push(`user_question: expected ADVISE, got ${plan.decision}`);
      }
    } else {
      reasons.push(`Unknown consult context: ${consultContext}`);
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Shared level validation for PLAN and ADJUST decisions.
   * Mutates reasons in place.
   */
  _validateReversalLevels(plan, currentPrice, minSpacing, reasons) {
    if (typeof plan.bullLevel !== 'number' || !Number.isFinite(plan.bullLevel)) {
      reasons.push('bullLevel must be a finite number');
    }
    if (typeof plan.bearLevel !== 'number' || !Number.isFinite(plan.bearLevel)) {
      reasons.push('bearLevel must be a finite number');
    }
    if (typeof plan.bullLevel === 'number' && typeof plan.bearLevel === 'number') {
      if (currentPrice != null && plan.bullLevel <= currentPrice) {
        reasons.push(`bullLevel ${plan.bullLevel} must be > current price ${currentPrice}`);
      }
      if (currentPrice != null && plan.bearLevel >= currentPrice) {
        reasons.push(`bearLevel ${plan.bearLevel} must be < current price ${currentPrice}`);
      }
      const spacing = plan.bullLevel - plan.bearLevel;
      if (minSpacing > 0 && spacing < minSpacing) {
        reasons.push(`level spacing ${spacing.toFixed(6)} below required 1.5×ATR (${minSpacing.toFixed(6)})`);
      }
    }
  }

  /**
   * Record that an action fired (timestamp log).
   */
  recordAction() {
    this._actionTimestamps.push(Date.now());
  }

  static get FEE_RATE() {
    return FEE_RATE;
  }
}

export { AiRiskGuard, FEE_RATE };
export default AiRiskGuard;
