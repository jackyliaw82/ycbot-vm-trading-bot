/**
 * AiRiskGuard — validates AI-generated plans + light post-processing.
 *
 * As of v3.0.0 (Hedge Phase redesign), the risk-guard is a thin
 * validator + post-processor, NOT a fallback-plan generator.
 *
 * Guardrails:
 * 1. Max total position size
 * 2. Side imbalance ratio (5:1) — CUT-only mode when exceeded
 * 3. Trigger price sanity (within % of current price)
 * 4. Min order size (exchange minNotional)
 * 5. Rate limiting (max actions per hour)
 * 6. Gap projection — reject actions that would make gap negative
 * 7. Single-leg guard — stop if only one leg and price 5% away
 *
 * Post-processing (applied before validation, on a working copy):
 * - HOLD/HOLD primaries → force-convert to CUT heavier leg
 *   (forbidden by prompt rules; we defensively transform if the AI
 *   slips through).
 * - HOLD primary missing triggerPrice → synthesize current ± 3×ATR.
 *
 * Failure mode: validation rejection now signals to the strategy to
 * stale-counter retry (no fallback plan generated here).
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
   * Validate a plan against risk constraints.
   *
   * Dispatches by phase:
   *   - Phase 1 INITIAL → flat OPEN_HEDGE validator.
   *   - Phase 2 HEDGE → paired primary+shadow validator (v3.0.0 paired schema).
   */
  validatePlan(plan, state) {
    if (!plan || !plan.actionAbove || !plan.actionBelow) {
      return { valid: false, reasons: ['Plan is null or missing actionAbove/actionBelow'] };
    }

    // Phase 1 → flat OPEN_HEDGE schema; Phase 2 → paired primary+shadow.
    if (state.phase === 'INITIAL') {
      return this._validateInitialPlan(plan, state);
    }
    return this._validateHedgePlanPaired(plan, state);
  }

  /**
   * Post-process an AI-generated plan before validation.
   *
   * Handles two transforms:
   *   1. HOLD/HOLD primaries → convert heavier-leg side to CUT_<heavier>
   *      (the prompt forbids HOLD/HOLD; this is a defensive safety net).
   *   2. (HOLD triggerPrice synthesis is handled inline in the validator.)
   *
   * Returns the plan (possibly mutated). Caller may pass the same object
   * back into validatePlan() afterward.
   */
  postProcessPlan(plan, state) {
    if (!plan || state.phase !== 'HEDGE') return plan;
    if (plan._schema !== 'paired') return plan;

    const aboveType = plan.actionAbove?.primary?.type;
    const belowType = plan.actionBelow?.primary?.type;
    if (aboveType !== 'HOLD' || belowType !== 'HOLD') return plan;

    // Both primaries are HOLD — forbidden. Convert the heavier-leg side to CUT.
    const { currentPrice, longPosition, shortPosition } = state;
    const longNotional = longPosition?.notional || 0;
    const shortNotional = shortPosition?.notional || 0;
    const heavierSide = longNotional >= shortNotional ? 'LONG' : 'SHORT';
    const heavierNotional = Math.max(longNotional, shortNotional);

    // CUT-DRIVEN ESCALATION sizing: 30% of heavier leg, floored at
    // minNotional × 2 so Binance accepts the order. The 50% upper cap from
    // the AI-planner prompt is redundant here (30% < 50% always), so we
    // simplify to max(floor, 0.30 × N).
    const floor = this.minNotional * 2;
    const cutSizeUSDT = Math.max(floor, heavierNotional * 0.30);
    const cutQty = currentPrice > 0 ? cutSizeUSDT / currentPrice : 0;
    const cutTrigger = currentPrice; // immediate market-level trigger

    if (heavierSide === 'LONG') {
      plan.actionBelow.primary = {
        type: 'CUT_LONG',
        triggerPrice: cutTrigger,
        qty: cutQty,
        reason: `Post-hoc: HOLD/HOLD detected; CUT heavier LONG leg (${heavierNotional.toFixed(2)} USDT) to free margin and rebalance.`,
      };
      plan.actionBelow.shadow = { type: 'SKIP' };
    } else {
      plan.actionAbove.primary = {
        type: 'CUT_SHORT',
        triggerPrice: cutTrigger,
        qty: cutQty,
        reason: `Post-hoc: HOLD/HOLD detected; CUT heavier SHORT leg (${heavierNotional.toFixed(2)} USDT) to free margin and rebalance.`,
      };
      plan.actionAbove.shadow = { type: 'SKIP' };
    }
    plan._holdHoldTransformed = true;
    return plan;
  }

  /**
   * Validate Phase 1 INITIAL plan (OPEN_HEDGE).
   */
  _validateInitialPlan(plan, state) {
    const reasons = [];
    const { currentPrice, positionSizeUSDT } = state;
    const sizeFloor = this.minNotional * 2;

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

      // Min size floor (minNotional × 2 safety margin) for both legs
      if (action.longSizeUSDT < sizeFloor) {
        reasons.push(`${key}: longSizeUSDT ${action.longSizeUSDT} below minimum ${sizeFloor} (= minNotional ${this.minNotional} × 2 safety margin)`);
      }
      if (action.shortSizeUSDT < sizeFloor) {
        reasons.push(`${key}: shortSizeUSDT ${action.shortSizeUSDT} below minimum ${sizeFloor} (= minNotional ${this.minNotional} × 2 safety margin)`);
      }

      // Total size check
      const totalSize = (action.longSizeUSDT || 0) + (action.shortSizeUSDT || 0);
      if (totalSize > this.maxPositionSizeUSDT) {
        reasons.push(`${key}: total ${totalSize} exceeds max ${this.maxPositionSizeUSDT}`);
      }

      // OPEN_HEDGE total must NOT EXCEED positionSizeUSDT (small tolerance for AI rounding).
      // The AI is allowed to emit a smaller total under the LIQUIDATION-AWARE SIZING
      // exception (Phase 1 liq projection forces a reduction below positionSizeUSDT) —
      // we just guard against overspending or accidental zero.
      if (positionSizeUSDT && positionSizeUSDT > 0) {
        const tolerance = this.minNotional;
        if (totalSize > positionSizeUSDT + tolerance) {
          reasons.push(`${key}: OPEN_HEDGE total ${totalSize.toFixed(2)} exceeds positionSizeUSDT ${positionSizeUSDT} (+${tolerance} tolerance)`);
        }
      }
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Validate the paired-trigger Phase 2 Hedge Phase plan.
   *
   * Plan shape:
   *   actionAbove = { primary: { type, triggerPrice, qty }, shadow: { type, triggerPrice, qty } }
   *   actionBelow = { primary: { type, triggerPrice, qty }, shadow: { type, triggerPrice, qty } }
   *
   * Iterates 4 sub-actions and applies the same risk checks as the legacy
   * validator, with two adaptations:
   *   - Notional is computed as qty × triggerPrice (paired schema uses qty, not sizeUSDT).
   *   - Direction sanity is keyed off the parent side (actionAbove must be > currentPrice,
   *     actionBelow < currentPrice) regardless of whether the sub-action is primary or
   *     shadow — both live above/below current per the cascade architecture.
   *
   * Liquidation cap, max position size, imbalance > 5:1 CUT-only, gap projection, and
   * rate limiting all apply as in legacy.
   */
  _validateHedgePlanPaired(plan, state) {
    const reasons = [];
    // Shadow-only violations are demoted to SKIP rather than failing the
    // whole plan. Each entry: { sideKey, reasons: string[] }. Surfaced in
    // the validation result so the caller can log the demotions.
    const demotedShadows = [];
    const { currentPrice, longPosition, shortPosition, volatility } = state;
    const atr = volatility?.atr || 0;
    const sizeFloor = this.minNotional * 2;
    const longNotional = longPosition?.notional || 0;
    const shortNotional = shortPosition?.notional || 0;
    const imbalanceRatio = (longNotional > 0 && shortNotional > 0)
      ? Math.max(longNotional / shortNotional, shortNotional / longNotional)
      : 0;
    const lighterSide = longNotional < shortNotional ? 'LONG' : 'SHORT';
    const caps = state.liquidationCaps;

    // Sum of all ADD notionals across 4 sub-actions — for max-total-position check.
    let totalAddNotional = 0;

    const validateSub = (sideKey, kind, sub) => {
      // SKIP sub-actions carry nothing — no trigger, no validation.
      if (!sub || sub.type === 'SKIP') return;

      // HOLD now carries a triggerPrice (price at which the HOLD reasoning
      // becomes invalid). Synthesize default at current ± 3×ATR if AI didn't
      // supply one. HOLD is primary-only (shadow HOLD is rejected upstream
      // by the structure validator), so this branch only fires for primaries.
      if (sub.type === 'HOLD' && currentPrice && atr > 0 && sub.triggerPrice == null) {
        const synthesized = sideKey === 'actionAbove'
          ? currentPrice + 3 * atr
          : currentPrice - 3 * atr;
        sub.triggerPrice = synthesized;
        sub.synthesizedTrigger = true;
        console.warn(`[RISK-GUARD] HOLD ${sideKey}.${kind}: synthesized triggerPrice ${synthesized.toFixed(4)} (current ${currentPrice} ${sideKey === 'actionAbove' ? '+' : '-'} 3×ATR)`);
      }

      const tag = `${sideKey}.${kind}`;
      const isShadow = kind === 'shadow';
      const isHold = sub.type === 'HOLD';
      const isAdd = sub.type === 'ADD_LONG' || sub.type === 'ADD_SHORT';
      const isCut = sub.type === 'CUT_LONG' || sub.type === 'CUT_SHORT';

      // Shadow-demotable violations accumulate locally; if any fire on a
      // shadow, we mutate the shadow.type to SKIP at the end of this
      // validateSub call rather than failing the plan. Primary violations
      // (and shadow schema violations) push to fatal `reasons` directly.
      const shadowDemoteReasons = [];
      const violation = (msg, { demotable = true } = {}) => {
        if (isShadow && demotable) shadowDemoteReasons.push(msg);
        else reasons.push(msg);
      };

      // Trigger price sanity: direction rule applies to ADD/CUT/HOLD;
      // 5%-deviation rule only applies to ADD/CUT (HOLD wake-up triggers
      // can be 3×ATR away which on high-vol symbols may exceed 5%).
      // Direction violations are schema bugs — keep as FATAL even for shadows.
      if (currentPrice && sub.triggerPrice) {
        if (!isHold) {
          const deviation = Math.abs(sub.triggerPrice - currentPrice) / currentPrice * 100;
          if (deviation > this.maxPriceDeviationPercent) {
            violation(`${tag}: trigger ${sub.triggerPrice} is ${deviation.toFixed(1)}% from current price (max ${this.maxPriceDeviationPercent}%)`, { demotable: false });
          }
        }
        if (sideKey === 'actionAbove' && sub.triggerPrice <= currentPrice) {
          violation(`${tag}: trigger ${sub.triggerPrice} not above current price ${currentPrice}`, { demotable: false });
        }
        if (sideKey === 'actionBelow' && sub.triggerPrice >= currentPrice) {
          violation(`${tag}: trigger ${sub.triggerPrice} not below current price ${currentPrice}`, { demotable: false });
        }
      }

      // HOLD has no qty/notional — skip remaining checks (and HOLD is
      // primary-only so the demote-to-SKIP path doesn't apply anyway).
      if (isHold) return;

      // Compute USDT notional from qty × triggerPrice. Shared by floor / cap checks.
      const notional = (typeof sub.qty === 'number' && typeof sub.triggerPrice === 'number')
        ? sub.qty * sub.triggerPrice
        : 0;

      // Min size floor — applies to ADD and CUT alike (Binance minNotional
      // must be honoured for any market order). Demotable for shadows.
      if ((isAdd || isCut) && notional > 0 && notional < sizeFloor) {
        violation(`${tag}: notional ${notional.toFixed(2)} (qty ${sub.qty} × ${sub.triggerPrice}) below minimum ${sizeFloor} (= minNotional ${this.minNotional} × 2 safety margin)`);
      }

      if (!isAdd) {
        // CUT and other types: no further per-side checks below. If a
        // shadow accumulated demote reasons above, apply demotion now.
        if (isShadow && shadowDemoteReasons.length > 0) {
          this._demoteShadowToSkip(sub, sideKey, shadowDemoteReasons, demotedShadows);
        }
        return;
      }

      // Provisional add — backed out if shadow is demoted below.
      totalAddNotional += notional;

      // Liquidation-aware cap — based on the action.type (ADD_LONG vs ADD_SHORT),
      // not the parent side. Shadow_LONG @ actionAbove still grows the LONG leg
      // and must respect maxAddLongUSDT. Demotable for shadows.
      if (caps) {
        if (sub.type === 'ADD_LONG' && caps.maxAddLongUSDT != null && notional > caps.maxAddLongUSDT + 0.01) {
          violation(`${tag}: ADD_LONG notional ${notional.toFixed(2)} exceeds liquidation-safe cap ${caps.maxAddLongUSDT.toFixed(2)} USDT (LONG liq distance would drop below ${state.minLiqDistancePct}%)`);
        }
        if (sub.type === 'ADD_SHORT' && caps.maxAddShortUSDT != null && notional > caps.maxAddShortUSDT + 0.01) {
          violation(`${tag}: ADD_SHORT notional ${notional.toFixed(2)} exceeds liquidation-safe cap ${caps.maxAddShortUSDT.toFixed(2)} USDT (SHORT liq distance would drop below ${state.minLiqDistancePct}%)`);
        }
      }

      // Imbalance > 5:1 — CUT-only mode. ADDs to the lighter side are forbidden.
      // Demotable for shadows (shadow on lighter side becomes SKIP); primary on
      // lighter side stays fatal so AI is forced to escalate to CUT.
      if (imbalanceRatio > this.maxImbalanceRatio) {
        if ((sub.type === 'ADD_LONG' && lighterSide === 'LONG') ||
            (sub.type === 'ADD_SHORT' && lighterSide === 'SHORT')) {
          violation(`${tag}: imbalance ${imbalanceRatio.toFixed(1)}:1 — CUT-only mode, cannot ADD to lighter side (${lighterSide})`);
        }
      }

      // Gap projection — reject if THIS action alone would flip gap negative.
      // Each sub-action is projected independently per FORWARD REASONING.
      // Demotable for shadows (most common slip-through case).
      if (longPosition && shortPosition && sub.triggerPrice && sub.qty > 0) {
        const projection = this.projectGap(
          { type: sub.type, triggerPrice: sub.triggerPrice, sizeUSDT: notional },
          longPosition,
          shortPosition,
        );
        if (projection.projectedGap < 0) {
          violation(`${tag}: ${sub.type} at ${sub.triggerPrice} (qty ${sub.qty}) would flip gap to ${projection.projectedGap.toFixed(4)} (current: ${projection.currentGap.toFixed(4)})`);
        }
      }

      // Apply shadow demotion if any violations accumulated. Back out the
      // provisional totalAddNotional contribution since this sub no longer ADDs.
      if (isShadow && shadowDemoteReasons.length > 0) {
        this._demoteShadowToSkip(sub, sideKey, shadowDemoteReasons, demotedShadows);
        totalAddNotional -= notional;
      }
    };

    validateSub('actionAbove', 'primary', plan.actionAbove?.primary);
    validateSub('actionAbove', 'shadow',  plan.actionAbove?.shadow);
    validateSub('actionBelow', 'primary', plan.actionBelow?.primary);
    validateSub('actionBelow', 'shadow',  plan.actionBelow?.shadow);

    // Max total position size — sum of current legs + all proposed ADDs across
    // the 4 sub-actions. Even though only some will fire per cycle, validate the
    // pessimistic case where all four ADDs eventually accumulate.
    const currentTotal = longNotional + shortNotional;
    if (currentTotal + totalAddNotional > this.maxPositionSizeUSDT) {
      reasons.push(`Plan: cumulative ADD notional ${totalAddNotional.toFixed(2)} on top of current ${currentTotal.toFixed(2)} would exceed max ${this.maxPositionSizeUSDT}`);
    }

    // Rate limiting.
    const now = Date.now();
    this._actionTimestamps = this._actionTimestamps.filter(t => t > now - 3600000);
    if (this._actionTimestamps.length >= this.maxActionsPerHour) {
      reasons.push(`Rate limit: ${this._actionTimestamps.length} actions in last hour (max ${this.maxActionsPerHour})`);
    }

    return { valid: reasons.length === 0, reasons, demotedShadows };
  }

  /**
   * Mutate a shadow sub-action to SKIP and record the demotion. Used by
   * _validateHedgePlanPaired when shadow-only violations are detected
   * (gap flip, liq cap, band saturation, imbalance, notional floor). The
   * primaries on the same plan remain valid; we save a wasted AI replan
   * by salvaging the rest of the plan instead of stale-counter retrying.
   */
  _demoteShadowToSkip(sub, sideKey, reasonList, demotedShadows) {
    sub.type = 'SKIP';
    sub.reason = `[POST-HOC] demoted to SKIP — ${reasonList.join('; ')}`;
    delete sub.qty;
    delete sub.triggerPrice;
    demotedShadows.push({ sideKey, reasons: reasonList });
    console.warn(`[RISK-GUARD] Shadow demoted to SKIP on ${sideKey}: ${reasonList.join('; ')}`);
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

  // ─── REMOVED in v3.0.0 ──────────────────────────────────────────────────
  // generateFallbackPlan() was removed when Hedge Phase shipped. On AI
  // failure or validation rejection, the strategy now increments a stale
  // counter and retries on exponential backoff (30s → 30m) — see
  // ai-hedge-strategy.js. HOLD/HOLD slip-throughs are handled by the
  // postProcessPlan() transform above, not by generating a fresh fallback.


  static get FEE_RATE() {
    return FEE_RATE;
  }
}

export { AiRiskGuard, FEE_RATE };
export default AiRiskGuard;
