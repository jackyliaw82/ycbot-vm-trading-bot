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
   * Validate a plan against risk constraints.
   *
   * Dispatches by phase + schema:
   *   - Phase 1 INITIAL → legacy 2-trigger OPEN_HEDGE validator (unchanged)
   *   - Phase 2 DCA, plan._schema === 'paired' → v2.0.0 paired-trigger validator
   *   - Phase 2 DCA, otherwise → legacy 2-trigger DCA validator (unchanged)
   */
  validatePlan(plan, state) {
    if (!plan || !plan.actionAbove || !plan.actionBelow) {
      return { valid: false, reasons: ['Plan is null or missing actionAbove/actionBelow'] };
    }

    if (state.phase === 'INITIAL') {
      return this._validateInitialPlan(plan, state);
    }

    if (plan._schema === 'paired') {
      return this._validateDCAPlanPaired(plan, state);
    }

    return this._validateDCAPlan(plan, state);
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
      // L4: strip triggerPrice from HOLD actions so the executor's crossing
      // logic doesn't spuriously fire them. AI sometimes emits triggerPrice
      // on HOLD (cosmetic carryover from when the same level was an ADD)
      // — that drove wasted replan cycles in the 50h stuck log.
      if (action && action.type === 'HOLD' && action.triggerPrice != null) {
        console.warn(`[RISK-GUARD] Stripping triggerPrice from ${key} HOLD action (was ${action.triggerPrice})`);
        delete action.triggerPrice;
      }
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

      // Min size floor (minNotional × 2 safety margin)
      const sizeFloor = this.minNotional * 2;
      if (action.sizeUSDT && action.sizeUSDT < sizeFloor) {
        reasons.push(`${key}: size ${action.sizeUSDT} below minimum ${sizeFloor} (= minNotional ${this.minNotional} × 2 safety margin)`);
      }

      // Max position size
      if (action.type === 'ADD_LONG' || action.type === 'ADD_SHORT') {
        const currentTotal = longNotional + shortNotional;
        if (currentTotal + (action.sizeUSDT || 0) > this.maxPositionSizeUSDT) {
          reasons.push(`${key}: would exceed max position size`);
        }
      }

      // Liquidation-aware cap (server-side enforcement of the prompt rule).
      // The AI is told the maxAddLongUSDT / maxAddShortUSDT in the user message;
      // this guard rejects plans where the AI ignored those caps.
      const caps = state.liquidationCaps;
      if (caps) {
        if (action.type === 'ADD_LONG' && caps.maxAddLongUSDT != null && action.sizeUSDT > caps.maxAddLongUSDT + 0.01) {
          reasons.push(`${key}: ADD_LONG ${action.sizeUSDT.toFixed(2)} exceeds liquidation-safe cap ${caps.maxAddLongUSDT.toFixed(2)} USDT (LONG liq distance would drop below ${state.minLiqDistancePct}%)`);
        }
        if (action.type === 'ADD_SHORT' && caps.maxAddShortUSDT != null && action.sizeUSDT > caps.maxAddShortUSDT + 0.01) {
          reasons.push(`${key}: ADD_SHORT ${action.sizeUSDT.toFixed(2)} exceeds liquidation-safe cap ${caps.maxAddShortUSDT.toFixed(2)} USDT (SHORT liq distance would drop below ${state.minLiqDistancePct}%)`);
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
   * Validate a v2.0.0 paired-trigger Phase 2 DCA plan.
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
  _validateDCAPlanPaired(plan, state) {
    const reasons = [];
    const { currentPrice, longPosition, shortPosition } = state;
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
      // L4: strip triggerPrice from HOLD/SKIP sub-actions so the executor's
      // crossing logic doesn't spuriously fire them. Same rationale as the
      // legacy validator above.
      if (sub && (sub.type === 'HOLD' || sub.type === 'SKIP') && sub.triggerPrice != null) {
        console.warn(`[RISK-GUARD] Stripping triggerPrice from ${sideKey}.${kind} ${sub.type} sub-action (was ${sub.triggerPrice})`);
        delete sub.triggerPrice;
      }
      // HOLD (primary) and SKIP (shadow) carry no fields to check.
      if (!sub || sub.type === 'HOLD' || sub.type === 'SKIP') return;

      const tag = `${sideKey}.${kind}`;
      const isAdd = sub.type === 'ADD_LONG' || sub.type === 'ADD_SHORT';
      const isCut = sub.type === 'CUT_LONG' || sub.type === 'CUT_SHORT';

      // Trigger price sanity: actionAbove > current, actionBelow < current — applies
      // to BOTH primary and shadow regardless of action type. Shadow_LONG (under
      // actionAbove, ADD_LONG) is still above current; shadow_SHORT (under actionBelow,
      // ADD_SHORT) is still below current.
      if (currentPrice && sub.triggerPrice) {
        const deviation = Math.abs(sub.triggerPrice - currentPrice) / currentPrice * 100;
        if (deviation > this.maxPriceDeviationPercent) {
          reasons.push(`${tag}: trigger ${sub.triggerPrice} is ${deviation.toFixed(1)}% from current price (max ${this.maxPriceDeviationPercent}%)`);
        }
        if (sideKey === 'actionAbove' && sub.triggerPrice <= currentPrice) {
          reasons.push(`${tag}: trigger ${sub.triggerPrice} not above current price ${currentPrice}`);
        }
        if (sideKey === 'actionBelow' && sub.triggerPrice >= currentPrice) {
          reasons.push(`${tag}: trigger ${sub.triggerPrice} not below current price ${currentPrice}`);
        }
      }

      // Compute USDT notional from qty × triggerPrice. Shared by floor / cap checks.
      const notional = (typeof sub.qty === 'number' && typeof sub.triggerPrice === 'number')
        ? sub.qty * sub.triggerPrice
        : 0;

      // Min size floor — applies to ADD and CUT alike (Binance minNotional must be
      // honoured for any market order).
      if ((isAdd || isCut) && notional > 0 && notional < sizeFloor) {
        reasons.push(`${tag}: notional ${notional.toFixed(2)} (qty ${sub.qty} × ${sub.triggerPrice}) below minimum ${sizeFloor} (= minNotional ${this.minNotional} × 2 safety margin)`);
      }

      if (!isAdd) return; // CUT and other types: no further per-side checks below

      totalAddNotional += notional;

      // Liquidation-aware cap — based on the action.type (ADD_LONG vs ADD_SHORT),
      // not the parent side. Shadow_LONG @ actionAbove still grows the LONG leg
      // and must respect maxAddLongUSDT.
      if (caps) {
        if (sub.type === 'ADD_LONG' && caps.maxAddLongUSDT != null && notional > caps.maxAddLongUSDT + 0.01) {
          reasons.push(`${tag}: ADD_LONG notional ${notional.toFixed(2)} exceeds liquidation-safe cap ${caps.maxAddLongUSDT.toFixed(2)} USDT (LONG liq distance would drop below ${state.minLiqDistancePct}%)`);
        }
        if (sub.type === 'ADD_SHORT' && caps.maxAddShortUSDT != null && notional > caps.maxAddShortUSDT + 0.01) {
          reasons.push(`${tag}: ADD_SHORT notional ${notional.toFixed(2)} exceeds liquidation-safe cap ${caps.maxAddShortUSDT.toFixed(2)} USDT (SHORT liq distance would drop below ${state.minLiqDistancePct}%)`);
        }
      }

      // Imbalance > 5:1 — CUT-only mode. ADDs to the lighter side are forbidden;
      // applies to BOTH primary and shadow.
      if (imbalanceRatio > this.maxImbalanceRatio) {
        if ((sub.type === 'ADD_LONG' && lighterSide === 'LONG') ||
            (sub.type === 'ADD_SHORT' && lighterSide === 'SHORT')) {
          reasons.push(`${tag}: imbalance ${imbalanceRatio.toFixed(1)}:1 — CUT-only mode, cannot ADD to lighter side (${lighterSide})`);
        }
      }

      // Gap projection — reject if THIS action alone would flip gap negative.
      // Each sub-action is projected independently per FORWARD REASONING.
      if (longPosition && shortPosition && sub.triggerPrice && sub.qty > 0) {
        const projection = this.projectGap(
          { type: sub.type, triggerPrice: sub.triggerPrice, sizeUSDT: notional },
          longPosition,
          shortPosition,
        );
        if (projection.projectedGap < 0) {
          reasons.push(`${tag}: ${sub.type} at ${sub.triggerPrice} (qty ${sub.qty}) would flip gap to ${projection.projectedGap.toFixed(4)} (current: ${projection.currentGap.toFixed(4)})`);
        }
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

    // Rate limiting (shared with legacy DCA path).
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
  generateFallbackPlan(currentPrice, state, reason = 'AI unavailable', rejectedProbabilityAssessment = null) {
    const { longPosition, shortPosition, positionSizeUSDT, volatility, phase, liquidationCaps } = state;
    const atrPercent = (volatility && volatility.atrPercent > 0.3) ? volatility.atrPercent : 0.3;
    const gridStep = currentPrice * (atrPercent / 100);

    if (phase === 'INITIAL') {
      // Apply minNotional × 2 floor to each leg in the fallback OPEN_HEDGE.
      const floor = this.minNotional * 2;
      return {
        analysis: `Fallback INITIAL plan — ${reason}. Using ATR-based grid entries.`,
        actionAbove: {
          type: 'OPEN_HEDGE',
          triggerPrice: currentPrice + gridStep,
          longSizeUSDT: Math.max(positionSizeUSDT * 0.4, floor),
          shortSizeUSDT: Math.max(positionSizeUSDT * 0.6, floor),
          reason: 'Fallback: OPEN_HEDGE above with 60:40 SHORT-heavy',
        },
        actionBelow: {
          type: 'OPEN_HEDGE',
          triggerPrice: currentPrice - gridStep,
          longSizeUSDT: Math.max(positionSizeUSDT * 0.6, floor),
          shortSizeUSDT: Math.max(positionSizeUSDT * 0.4, floor),
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
      // Split posSize between the two DCA legs. If the rejected AI plan carried a
      // probabilityAssessment, bias the split using the AI's own ratio ladder
      // (60:40 / 70:30 / 80:20). If no AI signal, 50:50 neutral.
      const floor = this.minNotional * 2;
      let shortRatio = 0.5;
      let longRatio = 0.5;
      let biasNote = 'no AI signal — neutral 50:50';

      if (rejectedProbabilityAssessment && rejectedProbabilityAssessment.higherChance) {
        const conf = rejectedProbabilityAssessment.confidence || 'low';
        const skew = conf === 'high' ? 0.30 : conf === 'medium' ? 0.20 : 0.10;
        if (rejectedProbabilityAssessment.higherChance === 'ABOVE') {
          // Bullish bias → bigger ADD_LONG (catch dip if price retraces),
          // smaller ADD_SHORT (don't fight up-move).
          longRatio = 0.5 + skew;
          shortRatio = 0.5 - skew;
        } else if (rejectedProbabilityAssessment.higherChance === 'BELOW') {
          // Bearish bias → bigger ADD_SHORT (fade rally at resistance),
          // smaller ADD_LONG (don't catch falling knife).
          shortRatio = 0.5 + skew;
          longRatio = 0.5 - skew;
        }
        biasNote = `AI bias ${rejectedProbabilityAssessment.higherChance}/${conf} → ${(longRatio * 100).toFixed(0)}:${(shortRatio * 100).toFixed(0)} LONG:SHORT`;
      }

      // Apply minNotional × 2 floor on each leg.
      let shortSize = Math.max(positionSizeUSDT * shortRatio, floor);
      let longSize = Math.max(positionSizeUSDT * longRatio, floor);

      // CUT-DRIVEN ESCALATION (mirrors the v2.0.0 prompt rule). When the AI is
      // unavailable, the fallback now actively de-risks instead of emitting HOLD:
      //   - margin > 85% → MUST CUT heavier leg (hard rule)
      //   - liq cap below min floor on a side → CUT that same side
      // CUT sizing heuristic: 30% of leg notional, clamped to [floor, 50% × leg].
      const longNotional = longPosition?.notional || 0;
      const shortNotional = shortPosition?.notional || 0;
      const heavierSide = longNotional >= shortNotional ? 'LONG' : 'SHORT';
      const marginUsage = state.marginInfo?.marginUsagePercent || 0;
      const marginCut = marginUsage > 85;

      const cutSize = (legNotional) => {
        if (legNotional <= 0) return 0;
        const target = legNotional * 0.30;
        return Math.max(floor, Math.min(target, legNotional * 0.5));
      };

      // Apply liquidation-safe caps for ADD path
      let shortCapBound = false;
      let longCapBound = false;
      if (liquidationCaps) {
        if (liquidationCaps.maxAddShortUSDT != null) {
          if (shortSize > liquidationCaps.maxAddShortUSDT) shortSize = liquidationCaps.maxAddShortUSDT;
          if (shortSize < floor) shortCapBound = true;
        }
        if (liquidationCaps.maxAddLongUSDT != null) {
          if (longSize > liquidationCaps.maxAddLongUSDT) longSize = liquidationCaps.maxAddLongUSDT;
          if (longSize < floor) longCapBound = true;
        }
      }

      // Resolve actionAbove (SHORT side)
      if (marginCut && heavierSide === 'SHORT' && shortNotional > 0) {
        actionAbove = {
          type: 'CUT_SHORT',
          triggerPrice: currentPrice,
          sizeUSDT: cutSize(shortNotional),
          reason: `Fallback: margin ${marginUsage.toFixed(1)}% > 85% — CUT heavier SHORT to free margin (hard rule)`,
        };
      } else if (shortCapBound && shortNotional > 0) {
        actionAbove = {
          type: 'CUT_SHORT',
          triggerPrice: currentPrice,
          sizeUSDT: cutSize(shortNotional),
          reason: `Fallback: SHORT liq cap below floor (${floor.toFixed(2)} USDT) — CUT to recover liq buffer`,
        };
      } else if (shortCapBound) {
        // Cap-bound but no SHORT to cut (qty 0) → HOLD
        actionAbove = { type: 'HOLD', reason: `Fallback: ADD_SHORT skipped — liq cap below floor and no SHORT position to CUT` };
      } else {
        actionAbove = {
          type: 'ADD_SHORT',
          triggerPrice: currentPrice + gridStep * 2,
          sizeUSDT: shortSize,
          reason: `Fallback: DCA SHORT above (2x ATR) — ${biasNote}`,
        };
      }

      // Resolve actionBelow (LONG side)
      if (marginCut && heavierSide === 'LONG' && longNotional > 0) {
        actionBelow = {
          type: 'CUT_LONG',
          triggerPrice: currentPrice,
          sizeUSDT: cutSize(longNotional),
          reason: `Fallback: margin ${marginUsage.toFixed(1)}% > 85% — CUT heavier LONG to free margin (hard rule)`,
        };
      } else if (longCapBound && longNotional > 0) {
        actionBelow = {
          type: 'CUT_LONG',
          triggerPrice: currentPrice,
          sizeUSDT: cutSize(longNotional),
          reason: `Fallback: LONG liq cap below floor (${floor.toFixed(2)} USDT) — CUT to recover liq buffer`,
        };
      } else if (longCapBound) {
        actionBelow = { type: 'HOLD', reason: `Fallback: ADD_LONG skipped — liq cap below floor and no LONG position to CUT` };
      } else {
        actionBelow = {
          type: 'ADD_LONG',
          triggerPrice: currentPrice - gridStep * 2,
          sizeUSDT: longSize,
          reason: `Fallback: DCA LONG below (2x ATR) — ${biasNote}`,
        };
      }
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
