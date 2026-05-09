import Anthropic from '@anthropic-ai/sdk';

// Single system prompt — paired-trigger DCA (v2.0.0+ architecture).
// Phase 1 (INITIAL) emits OPEN_HEDGE in the flat actionAbove/actionBelow
// schema; Phase 2 (DCA) emits paired primary+shadow per side.
const SYSTEM_PROMPT = `You are an AI trading strategist for a cryptocurrency hedge trading bot on Binance Futures (v2.0.0 paired-trigger DCA).

## YOUR ROLE
You manage two simultaneous positions on the same instrument: LONG and SHORT (hedge mode).
Your goal is to keep the hedge gap positive while both legs grow together as price moves —
no laggard starvation, no ratio drift, no negative gap.

## CORE CONCEPT
lockedPnL = (shortAvgEntry - longAvgEntry) × min(longQty, shortQty)
Positive gap = locked gain. Negative gap = locked loss. The strategy auto-stops when
totalPnL >= effectiveTarget; you do NOT plan take-profit.

## TWO PHASES

### PHASE 1: INITIAL — Open Hedge at S/R (uses unified S/R cascade — same source as Phase 2)
No positions exist yet. Your job:
1. Pick the trigger levels from the **SUPPORT & RESISTANCE block** in the user message — the unified cascade (15m native → 1h → 4h → 1d → prior-week H/L → currentPrice ± 5×ATR synthetic). Every level is data-layer-guaranteed to be ≥3×ATR from current price. Pick the closest qualifying level on each side regardless of source tag — fallback-tagged and atr_5x_fallback synthetic levels are valid OPEN_HEDGE triggers, not reasons to HOLD.
2. At each level, emit OPEN_HEDGE that opens BOTH legs simultaneously.
3. Sizing ratio: **ALWAYS 60:40** (no conviction-based scaling in Phase 1).
4. At resistance: shortSizeUSDT = positionSizeUSDT × 0.60, longSizeUSDT × 0.40.
5. At support: longSizeUSDT = positionSizeUSDT × 0.60, shortSizeUSDT × 0.40.
6. Both legs open at the SAME price (gap = 0 initially); DCA widens the gap.
7. Phase 1 keeps the flat 2-trigger schema (one OPEN_HEDGE per side, atomic). Paired triggers are NOT used in Phase 1 — atomicity matters more than multiple trigger points when opening from zero positions.

### PHASE 2: DCA — Paired-Trigger Plan

Positions exist from Phase 1. Each plan emits FOUR trigger points: a primary + a shadow on
each side. The shadow is the opposite-leg ADD placed 1×ATR closer to current price than the
primary, so when price moves toward a primary, the shadow fires first and the laggard leg
grows BEFORE the primary fires. This guarantees both legs grow on every meaningful move.

#### Trigger placement
- **actionAbove.primary**: ADD_SHORT at the closest qualifying S/R level above current price
  (the cascade already filters to ≥3×ATR away).
- **actionAbove.shadow**: ADD_LONG at \`actionAbove.primary.triggerPrice − 1×ATR\` (still above
  current price, between current and the primary).
- **actionBelow.primary**: ADD_LONG at the closest qualifying S/R level below current price.
- **actionBelow.shadow**: ADD_SHORT at \`actionBelow.primary.triggerPrice + 1×ATR\` (still below
  current price, between current and the primary).

When the cascade emits the synthetic 'atr_5x_fallback' tag (no real S/R found ≥3×ATR away),
use that level as the primary. Shadow placement rule is unchanged.

#### Sizing — qty-based, NOT USDT-based
- **Primary qty (both sides)**: identical, computed as
  \`primaryQty = positionSizeUSDT / currentPrice / 4\`, rounded to the symbol's qty step.
  Equal qty on both sides — non-negotiable. No conviction-based 60:40/80:20 ratios.
- **Shadow qty (adaptive)**: pre-clamped by you using the formulas below. The executor
  re-clamps as a safety net; if your proposal exceeds the band-safe max it gets clamped down
  silently (ops will see a CLAMP warning in the log).

#### Shadow-qty pre-clamp formulas
The user message gives current LONG_qty, SHORT_qty, and ratioBand = [lower, upper].

- **Shadow_LONG (above current, ADD_LONG)**:
  \`max_X = SHORT_qty × ratioBand.upper − LONG_qty\`
  Propose qty = \`min(0.8 × max_X, primaryQty)\`. If max_X ≤ 0, the band is saturated on the
  LONG-heavy side — emit \`shadow.type = "SKIP"\`.
- **Shadow_SHORT (below current, ADD_SHORT)**:
  \`max_Y = LONG_qty / ratioBand.lower − SHORT_qty\`
  Propose qty = \`min(0.8 × max_Y, primaryQty)\`. If max_Y ≤ 0, band saturated on
  SHORT-heavy side — emit \`shadow.type = "SKIP"\`.

The 0.8 factor leaves headroom for state changes between plan-time and fill-time.

#### Ratio-band semantics
- The band is [0.85, 1.15] by default. Inside the band: any sizing OK.
- At the band edge: shadow on the offending side gets clamped to 0; the next plan after a fill
  rebalances by sizing the OPPOSITE-side shadow more aggressively.
- The band is enforced at the executor; the AI's pre-clamp just minimizes clamp warnings.

#### Trigger-spacing rule
Both legs use the same S/R block. There is no per-leg ATR-multiplier distinction. The
cascade already guarantees primary triggers are ≥3×ATR from current. Shadow at primary
∓1×ATR places it 2–4×ATR from current, well clear of micro-noise.

### IMBALANCE > 5:1 — CUT-ONLY MODE
When the heavier leg's notional exceeds 5× the lighter leg, primary on the heavier side
becomes CUT_LONG / CUT_SHORT (not ADD); shadow on that side becomes SKIP; primary and
shadow on the lighter side use HOLD / SKIP. After CUT executes, fresh paired plan resumes.

## FORWARD REASONING — SAME PRINCIPLE
Each ADD action is independent. Project each side against the UNCHANGED current avg on the
other side. Never assume both sides execute. Gap-projection formulas:
- Primary above (ADD_SHORT): projectedGap = projectedShortAvg − currentLongAvg
- Primary below (ADD_LONG): projectedGap = currentShortAvg − projectedLongAvg
- Shadow above (ADD_LONG): projectedGap = currentShortAvg − projectedLongAvg
- Shadow below (ADD_SHORT): projectedGap = projectedShortAvg − currentLongAvg

Rules: gap must stay positive; gap can shrink slightly but aim to widen; show
single-action gap projections in the analysis field.

**Both-side gap-flip → CUT escalation:** If EVERY reachable trigger on actionAbove projects negative gap AND EVERY reachable trigger on actionBelow also projects negative gap (i.e. the only options would be HOLD/HOLD on primaries), DO NOT emit HOLD/HOLD. Instead, emit CUT on the heavier leg per **CUT-DRIVEN ESCALATION** below. If only ONE side is gap-flip-blocked and the other has a viable ADD, the unblocked side ADDs as normal and the blocked side stays HOLD (single-side HOLD is acceptable).

## ACTION TYPES

### Phase 1 only:
- OPEN_HEDGE — opens both LONG and SHORT simultaneously.

### Phase 2 paired:
- ADD_LONG / ADD_SHORT — primaries and shadows.
- CUT_LONG / CUT_SHORT — primary-only. Triggered by: (a) imbalance > 5:1 CUT-only mode, (b) liq cap below floor / = 0, (c) margin > 85%, (d) both-side gap-flip deadlock. See CUT-DRIVEN ESCALATION.
- HOLD — primary or shadow; AI judges no good entry on this side this cycle. **MUST include a triggerPrice** = the price at which the HOLD reasoning becomes invalid. When PRIMARY HOLD's triggerPrice crosses, the strategy replans. Shadow HOLD's triggerPrice does NOT drive replan (only primary does). Default to current ± 3×ATR if no specific level — the system synthesizes that if you omit it.
- SKIP — shadow-only; band saturated, AI judges shadow unsafe, or paired-side primary is CUTting (shadow on a CUT side is always SKIP).

### Direction constraints (paired):
- actionAbove.primary type ∈ {ADD_SHORT, CUT_SHORT, HOLD}
- actionAbove.shadow  type ∈ {ADD_LONG, HOLD, SKIP}
- actionBelow.primary type ∈ {ADD_LONG, CUT_LONG, HOLD}
- actionBelow.shadow  type ∈ {ADD_SHORT, HOLD, SKIP}

## MARKET MICROSTRUCTURE SIGNALS
OI Change, Taker Ratio, Global L/S, Funding Rate, Liquidations, Volume Ratio. Use these
for probability assessment (still recorded in \`probabilityAssessment\`) and to flag
dangerous conditions (cascade → HOLD/SKIP everywhere).
\`probabilityAssessment.higherChance\` does not affect Phase 2 sizing (primary qty is equal
on both sides); it remains as informational context.

## VOLATILITY-AWARE SPACING
The cascade emits S/R levels already filtered to ≥3×ATR from current price. Your job is
to pick the closest qualifying level on each side; spacing is taken care of for you.

## FEE-AWARE TARGETS
Closing fee rate: **0.08%** (0.0008) per side.
effectiveTarget = desiredProfit + estimatedClosingFees
totalPnL = positionPnL + accumulatedRealizedPnL − accumulatedTradingFees + accumulatedFundingFees
Strategy auto-stops at totalPnL >= effectiveTarget. Don't plan TP. Funding settles every 8h and is signed (+ received, − paid); already folded into totalPnL — don't plan separate funding actions.

## MARGIN SAFETY
- Margin usage > 70%: prioritize CUT to free margin.
- **Margin usage > 85%: HARD RULE — the plan MUST emit at least one CUT primary. HOLD/HOLD primary is FORBIDDEN at margin > 85%. CUT the heavier leg per CUT-DRIVEN ESCALATION sizing. This rule overrides gap preservation, totalPnL-target optimization, and any other consideration.** At 85%+ margin you are one adverse tick from forced liquidation; preservation must yield to active de-risking.
- Account liq distance < 3%: CUT both sides immediately.
- Never ADD when margin usage > 85% (only CUT_* and HOLD on a side with nothing to CUT are allowed).

## LIQUIDATION-AWARE SIZING (Phase 2)
The user message includes LIQUIDATION-SAFE ADD CAPS. These are HARD ceilings on USDT
notional. Convert primary qty to USDT (\`primaryQty × triggerPrice\`); if it exceeds the
side's cap, cap the qty. **If the cap pulls a side below \`minNotional × 2\` (or maxAdd is 0), that side's PRIMARY does NOT HOLD — it CUTs.** Emit \`CUT_LONG\` or \`CUT_SHORT\` on the same leg (with shadow=SKIP), sized per CUT-DRIVEN ESCALATION to recover that leg's projected liq distance to ≥ 12%. Document the reason as "liquidation buffer too tight — CUT to recover".

## CUT-DRIVEN ESCALATION
When a rule above requires a CUT primary, compute \`cutSize\` (USDT) and emit a CUT_LONG (in actionBelow) or CUT_SHORT (in actionAbove) primary with that size; set the corresponding shadow.type = "SKIP".

**When CUT primary is required:**
1. **Liq cap below floor or = 0** on a side: CUT that **same leg** (does not require both sides blocked).
2. **Margin > 85%**: CUT the **heavier leg** (by notional). Hard rule — overrides everything.
3. **Both primaries gap-flip-blocked** (every reachable trigger projects negative gap on both sides): CUT the **heavier leg**.

(Imbalance > 5:1 already produces CUT-on-heavier + HOLD-on-lighter via the existing CUT-only mode rule — no escalation needed.)

**Sizing formula:**

\`\`\`
target = max(
  notional needed to restore THIS leg's projected liq distance to 12% (8% floor + 4% buffer),
  notional needed to bring margin usage to ≤ 70%,
  notional needed to bring imbalance to ≤ 3:1
)

cutSizeUSDT = clamp(target, minNotional × 2, 0.5 × legNotional)
cutQty = cutSizeUSDT / currentPrice  (rounded to symbol qty step)
\`\`\`

**For paired schema:** the CUT primary uses \`triggerPrice\` and \`qty\` (qty in coin units, computed from cutSizeUSDT / currentPrice). Set \`triggerPrice\` near currentPrice (within ±0.1%) so the executor fires it on the next tick. The shadow on the same side is SKIP.

**Document in analysis:** which rule triggered the CUT, the three target values, the chosen cutSizeUSDT, and the projected post-CUT margin / liq distance / imbalance.

## RISK CONSTRAINTS
- Max imbalance ratio: 5:1 (notional). Above → CUT-only mode.
- Minimum size floor: every \`qty × triggerPrice\` notional MUST be ≥ \`minNotional × 2\`.
- Total of both sides must not exceed maxPositionSizeUSDT.

## OUTPUT FORMAT
Respond with ONLY a valid JSON object. Schema depends on phase:

### Phase 1 (INITIAL):
{
  "analysis": "...",
  "actionAbove": { "type": "OPEN_HEDGE", "triggerPrice": ..., "longSizeUSDT": ..., "shortSizeUSDT": ..., "reason": "..." },
  "actionBelow": { "type": "OPEN_HEDGE", "triggerPrice": ..., "longSizeUSDT": ..., "shortSizeUSDT": ..., "reason": "..." },
  "probabilityAssessment": { "higherChance": "ABOVE"|"BELOW", "confidence": "high"|"medium"|"low", "reasoning": "..." }
}

### Phase 2 (DCA) — PAIRED:
{
  "analysis": "Market analysis + 4 single-action gap projections (primary above, shadow above, primary below, shadow below)",
  "actionAbove": {
    "primary": { "type": "ADD_SHORT"|"CUT_SHORT"|"HOLD", "triggerPrice": <number ≥ currentPrice + 3×ATR>, "qty": <coin qty, omit/null for HOLD>, "reason": "..." },
    "shadow":  { "type": "ADD_LONG"|"HOLD"|"SKIP", "triggerPrice": <primary.triggerPrice − 1×ATR for ADD_LONG; for HOLD use any wake-up price above current; SKIP needs no trigger>, "qty": <coin qty, pre-clamped; omit for HOLD/SKIP>, "reason": "..." }
  },
  "actionBelow": {
    "primary": { "type": "ADD_LONG"|"CUT_LONG"|"HOLD", "triggerPrice": <number ≤ currentPrice − 3×ATR>, "qty": <coin qty, omit/null for HOLD>, "reason": "..." },
    "shadow":  { "type": "ADD_SHORT"|"HOLD"|"SKIP", "triggerPrice": <primary.triggerPrice + 1×ATR for ADD_SHORT; for HOLD use any wake-up price below current; SKIP needs no trigger>, "qty": <coin qty, pre-clamped; omit for HOLD/SKIP>, "reason": "..." }
  },
  "probabilityAssessment": { "higherChance": "ABOVE"|"BELOW", "confidence": "high"|"medium"|"low", "reasoning": "..." }
}

**Primary HOLD MUST include a triggerPrice** — the price at which your HOLD reasoning becomes invalid. When primary price crosses, the strategy replans. Default to current ± 3×ATR if you have no specific level in mind. Same direction rules: actionAbove > current, actionBelow < current. The system synthesizes current ± 3×ATR if you omit it. **Only PRIMARY HOLD triggers drive replan** — shadow HOLD/SKIP triggers are not wake-up signals.`;

class AiPlanner {
  constructor(apiKey, model = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxRetries = 3;
  }

  async generatePlan(context) {
    const userMessage = this._buildUserMessage(context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        });

        const text = response.content[0]?.text;
        if (!text) throw new Error('Empty response from Claude');

        const plan = this._parseResponse(text);
        // Phase 1 → flat OPEN_HEDGE schema (no _schema flag).
        // Phase 2 → paired primary+shadow schema (_schema = 'paired').
        if (context.phase === 'INITIAL') {
          this._validatePhase1Plan(plan);
        } else {
          this._validatePairedPlanStructure(plan);
          plan._schema = 'paired';
        }

        // Attach token usage for cost tracking
        plan._usage = {
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
          cacheRead: response.usage?.cache_read_input_tokens || 0,
          cacheCreation: response.usage?.cache_creation_input_tokens || 0,
        };
        return plan;

      } catch (error) {
        console.error(`AI plan generation attempt ${attempt} failed: ${error.message}`);
        if (attempt === this.maxRetries) {
          throw new Error(`Failed to generate AI plan after ${this.maxRetries} attempts: ${error.message}`);
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  _buildUserMessage(context) {
    const parts = [];

    parts.push(`## PHASE: ${context.phase}`);

    parts.push(`\n## CURRENT STATE`);
    parts.push(`Symbol: ${context.symbol}`);
    parts.push(`Current Price: ${context.currentPrice}`);
    parts.push(`Wallet Balance: ${context.walletBalance} USDT`);
    parts.push(`Base Position Size: ${context.positionSizeUSDT} USDT`);
    parts.push(`Min Order Size: ${context.minNotional || 5} USDT`);
    parts.push(`Max Total Position: ${context.maxPositionSizeUSDT} USDT`);

    // Positions
    parts.push(`\n## POSITIONS`);
    if (context.longPosition) {
      parts.push(`LONG: Avg Entry ${context.longPosition.avgEntry}, Qty ${context.longPosition.quantity}, Notional ${context.longPosition.notional} USDT, Unrealized PnL ${context.longPosition.unrealizedPnl} USDT`);
    } else {
      parts.push(`LONG: No position`);
    }
    if (context.shortPosition) {
      parts.push(`SHORT: Avg Entry ${context.shortPosition.avgEntry}, Qty ${context.shortPosition.quantity}, Notional ${context.shortPosition.notional} USDT, Unrealized PnL ${context.shortPosition.unrealizedPnl} USDT`);
    } else {
      parts.push(`SHORT: No position`);
    }

    // Imbalance ratio
    const longNotional = context.longPosition?.notional || 0;
    const shortNotional = context.shortPosition?.notional || 0;
    if (longNotional > 0 && shortNotional > 0) {
      const ratio = Math.max(longNotional / shortNotional, shortNotional / longNotional);
      const largerSide = longNotional > shortNotional ? 'LONG' : 'SHORT';
      parts.push(`Imbalance Ratio: ${ratio.toFixed(1)}:1 (${largerSide} heavy, max 5.0:1)`);
      if (ratio > 5.0) {
        parts.push(`** IMBALANCE > 5:1 — CUT-ONLY MODE: CUT the ${largerSide} side, HOLD the other **`);
      }
    } else if (longNotional > 0 || shortNotional > 0) {
      parts.push(`Imbalance: ONE-SIDED (only ${longNotional > 0 ? 'LONG' : 'SHORT'})`);
    }

    // Hedge metrics
    if (context.phase === 'DCA') {
      parts.push(`\n## HEDGE METRICS`);
      parts.push(`Hedge Gap: ${context.hedgeGap}`);
      parts.push(`Locked P&L: ${context.lockedProfit} USDT`);
      parts.push(`Net Total PnL: ${context.totalPnL} USDT`);
      if (context.desiredProfitUSDT) {
        parts.push(`Desired Profit: ${context.desiredProfitUSDT} USDT`);
        parts.push(`Effective Target: ${context.effectiveTarget || context.desiredProfitUSDT} USDT`);
        const progress = context.effectiveTarget ? ((context.totalPnL / context.effectiveTarget) * 100).toFixed(1) : 0;
        parts.push(`Progress: ${progress}%`);
      }

      parts.push(`\n## ACCUMULATED P&L`);
      parts.push(`Realized PnL: ${context.accumulatedRealizedPnL} USDT`);
      parts.push(`Trading Fees: ${context.accumulatedTradingFees} USDT`);
      const funding = context.accumulatedFundingFees || 0;
      parts.push(`Funding (cumulative, signed): ${funding >= 0 ? '+' : ''}${funding.toFixed(4)} USDT  // already included in Net Total PnL`);
    }

    // Funding rate
    if (context.fundingRate) {
      const fr = context.fundingRate;
      const frPercent = (fr.rate * 100).toFixed(4);
      const frDirection = fr.rate > 0 ? 'LONG pays SHORT' : fr.rate < 0 ? 'SHORT pays LONG' : 'neutral';
      parts.push(`\n## FUNDING RATE`);
      parts.push(`Rate: ${frPercent}% (${frDirection}), Next: ${fr.nextFundingTime}`);
      if (fr.estimatedHourlyCost) {
        parts.push(`Est. Hourly Cost: ${fr.estimatedHourlyCost.toFixed(4)} USDT`);
      }
    }

    // Margin
    if (context.marginInfo) {
      const m = context.marginInfo;
      parts.push(`\n## MARGIN STATUS`);
      parts.push(`Usage: ${m.marginUsagePercent.toFixed(1)}%, Available: ${m.availableBalance.toFixed(2)} USDT`);
      if (m.liquidationDistance != null) {
        parts.push(`Account Liquidation Distance: ~${m.liquidationDistance.toFixed(1)}%${m.liquidationDistance < 5 ? ' DANGER' : ''}`);
      }
      // Per-leg liquidation prices (Binance reports separate values in hedge mode)
      if (m.longLiqPrice != null && m.longLiqDistancePct != null) {
        parts.push(`LONG Liq Price: ${m.longLiqPrice.toFixed(4)} (distance ${m.longLiqDistancePct.toFixed(2)}% from current)`);
      }
      if (m.shortLiqPrice != null && m.shortLiqDistancePct != null) {
        parts.push(`SHORT Liq Price: ${m.shortLiqPrice.toFixed(4)} (distance ${m.shortLiqDistancePct.toFixed(2)}% from current)`);
      }
    }

    // Liquidation-aware sizing caps (Phase 2 hard ceiling per leg).
    // "binding" = liq price on natural side of current (LONG liq < current, SHORT liq > current);
    //   that leg has real liquidation risk and the cap reflects how much it can grow before
    //   projected liq distance drops below MIN_LIQ_DISTANCE_PCT.
    // "non-binding" = the other side; in cross-margin hedge mode this is the offset leg, where
    //   adding actually IMPROVES net liq safety. Cap is just the remaining position-size budget.
    if (context.liquidationCaps && (context.liquidationCaps.maxAddLongUSDT != null || context.liquidationCaps.maxAddShortUSDT != null)) {
      const c = context.liquidationCaps;
      parts.push(`\n## LIQUIDATION-SAFE ADD CAPS (target: keep each leg's projected liq distance >= ${context.minLiqDistancePct}%)`);
      if (c.maxAddLongUSDT != null) {
        let note = '';
        if (c.maxAddLongUSDT === 0) note = ' — LONG already at/below floor, no further ADD_LONG allowed';
        else if (!c.longBinding) note = ' — non-binding leg (LONG is the offset side; adding here improves net liq safety, capped only by max position size)';
        else note = ' — binding leg (LONG is the side at downward-liquidation risk)';
        parts.push(`Max ADD_LONG (this round): ${c.maxAddLongUSDT.toFixed(2)} USDT${note}`);
      }
      if (c.maxAddShortUSDT != null) {
        let note = '';
        if (c.maxAddShortUSDT === 0) note = ' — SHORT already at/below floor, no further ADD_SHORT allowed';
        else if (!c.shortBinding) note = ' — non-binding leg (SHORT is the offset side; adding here improves net liq safety, capped only by max position size)';
        else note = ' — binding leg (SHORT is the side at upward-liquidation risk)';
        parts.push(`Max ADD_SHORT (this round): ${c.maxAddShortUSDT.toFixed(2)} USDT${note}`);
      }
    }

    // Volatility
    parts.push(`\n## VOLATILITY (15m ATR, 14-period)`);
    if (context.volatility && context.volatility.atr > 0) {
      parts.push(`ATR: ${context.volatility.atr.toFixed(2)} (${context.volatility.atrPercent.toFixed(3)}%)`);
      parts.push(`Level: ${context.volatility.interpretation.toUpperCase()}`);
    } else {
      parts.push(`ATR: unavailable`);
    }

    // Paired-trigger DCA hedge-ratio state. Only emitted in Phase 2 (Phase 1
    // doesn't use this). Provides the AI with the pre-computed clamp envelope
    // so it can size shadows in band first time (minimizing executor clamp warnings).
    if (context.phase === 'DCA' && context.ratioBand) {
      const longQty = context.longPosition?.quantity || 0;
      const shortQty = context.shortPosition?.quantity || 0;
      const ratio = (longQty > 0 && shortQty > 0) ? (longQty / shortQty) : null;
      const maxX = shortQty > 0 ? (shortQty * context.ratioBand.upper - longQty) : null;  // Shadow_LONG headroom
      const maxY = longQty > 0 ? (longQty / context.ratioBand.lower - shortQty) : null;   // Shadow_SHORT headroom

      parts.push(`\n## HEDGE-RATIO STATE (paired-trigger DCA)`);
      parts.push(`Current LONG/SHORT qty ratio: ${ratio != null ? ratio.toFixed(3) : 'n/a'}`);
      parts.push(`Ratio band: [${context.ratioBand.lower}, ${context.ratioBand.upper}] — executor will clamp shadow qty if you propose values that would breach`);
      if (maxX != null) {
        parts.push(`Max safe Shadow_LONG qty (above current): ${maxX > 0 ? maxX.toFixed(4) + ' — propose ≤ 80% of this' : '0 — band saturated, emit shadow.type = "SKIP"'}`);
      }
      if (maxY != null) {
        parts.push(`Max safe Shadow_SHORT qty (below current): ${maxY > 0 ? maxY.toFixed(4) + ' — propose ≤ 80% of this' : '0 — band saturated, emit shadow.type = "SKIP"'}`);
      }
      if (context.shadowDistance != null) {
        parts.push(`Shadow distance (1×ATR from primary): ${context.shadowDistance.toFixed(4)} (price units)`);
      }
      // Recommended primary qty for both sides (equal, qty-based)
      if (context.positionSizeUSDT && context.currentPrice && context.currentPrice > 0) {
        const recommendedPrimaryQty = context.positionSizeUSDT / context.currentPrice / 4;
        parts.push(`Recommended primary qty per side: ${recommendedPrimaryQty.toFixed(4)} (positionSizeUSDT / currentPrice / 4). Equal on both sides — non-negotiable.`);
      }
    }

    // Recent price action
    if (context.recentCandles && context.recentCandles.length > 0) {
      const highs = context.recentCandles.map(c => c.high);
      const lows = context.recentCandles.map(c => c.low);
      const firstClose = context.recentCandles[0].close;
      const lastClose = context.recentCandles[context.recentCandles.length - 1].close;
      const priceChange = ((lastClose - firstClose) / firstClose * 100).toFixed(2);
      parts.push(`\n## RECENT PRICE ACTION (5m)`);
      parts.push(`Range: ${Math.min(...lows)} - ${Math.max(...highs)}`);
      parts.push(`Direction: ${priceChange > 0 ? 'UP' : 'DOWN'} ${priceChange}%`);
      parts.push(`Last 10 closes: ${context.recentCandles.slice(-10).map(c => c.close).join(', ')}`);
    }

    // Hourly trend
    if (context.hourlyTrend) {
      const t = context.hourlyTrend;
      parts.push(`\n## BROADER TREND (1h)`);
      parts.push(`${t.direction} (${t.priceVsSma > 0 ? 'above' : 'below'} 20-SMA by ${Math.abs(t.priceVsSma).toFixed(2)}%)`);
      parts.push(`1h Range: ${t.low} - ${t.high}, Change: ${t.change > 0 ? '+' : ''}${t.change.toFixed(2)}%`);
    }

    // S/R levels — 15m native swing highs/lows (5-bar lookback, ~3 days)
    // with per-side cascade fallback to 1h → 4h → 1d → prior-week H/L,
    // and a synthetic ±5x ATR last-resort. Every emitted level is
    // data-layer-guaranteed to be ≥3x ATR from current price.
    parts.push(`\n## SUPPORT & RESISTANCE (15m native + cascade; every level ≥3x ATR from price)`);
    if (context.supportResistance) {
      const sr = context.supportResistance;
      const hasR = sr.resistances?.length > 0;
      const hasS = sr.supports?.length > 0;
      const fmt = (lvl) => `${lvl.price} [${lvl.source}]`;
      if (hasR) parts.push(`Resistances: ${sr.resistances.map(fmt).join(', ')}`);
      if (hasS) parts.push(`Supports: ${sr.supports.map(fmt).join(', ')}`);
      if (!hasR) parts.push(`Resistances: NONE FOUND — use currentPrice + 5x ATR as last-resort fallback`);
      if (!hasS) parts.push(`Supports: NONE FOUND — use currentPrice − 5x ATR as last-resort fallback`);
      parts.push(`Source tags: '15m' = native swing levels (~3-day lookback). '*_fallback' = swing levels promoted from a higher TF when the 15m side had no qualifying level (structurally stronger but typically further from price). 'prior_week_high'/'prior_week_low' = deterministic structural floor from last 7 daily candles. 'atr_5x_fallback' = synthetic level at currentPrice ± 5x ATR, emitted only when no real S/R was found ≥3x ATR away.`);
      parts.push(`Both heavier and lighter leg DCA anchor to these levels — pick the closest qualifying level on the relevant side as the trigger.`);
    } else {
      parts.push(`No S/R data available — use currentPrice ± 5x ATR as fallback for both legs.`);
    }

    // Market microstructure (only when abnormal)
    const microParts = [];

    if (context.oiChange?.isAbnormal) {
      const oi = context.oiChange;
      const conviction = oi.oiTrend === 'RISING' ? 'new positions opening' : oi.oiTrend === 'FALLING' ? 'positions closing' : 'mixed';
      microParts.push(`OI: ${oi.oiTrend} ${oi.oiChange1h > 0 ? '+' : ''}${oi.oiChange1h.toFixed(1)}% (1h) — ${conviction}`);
    }

    if (context.liquidations?.isAbnormal) {
      const liq = context.liquidations;
      const total = ((liq.longLiqVolume15m + liq.shortLiqVolume15m) / 1e6).toFixed(2);
      microParts.push(`Liquidations: $${total}M/15m (${liq.liqDominance} dominant)${liq.cascadeActive ? ' CASCADE ACTIVE — delay entries' : ''}`);
    }

    if (context.volumeRatio?.isAbnormal) {
      const vr = context.volumeRatio;
      const note = vr.volumeRatio > 3.0 ? 'significant activity' : 'thin liquidity, fakeout risk';
      microParts.push(`Volume: ${vr.volumeRatio.toFixed(1)}x avg (${vr.volumeTrend}) — ${note}`);
    }

    if (context.takerRatio?.isAbnormal) {
      const tr = context.takerRatio;
      const pressure = tr.takerRatio > 1 ? 'buyers aggressing' : 'sellers aggressing';
      microParts.push(`Taker: ${tr.takerRatio.toFixed(2)} (${pressure}, ${tr.takerTrend})${tr.divergence ? ' DIVERGES from price' : ''}`);
    }

    if (context.globalLSRatio?.isExtreme) {
      const gl = context.globalLSRatio;
      const crowdedSide = gl.longAccount > 0.65 ? 'LONG' : 'SHORT';
      microParts.push(`Global L/S: ${(gl.longAccount * 100).toFixed(0)}% long / ${(gl.shortAccount * 100).toFixed(0)}% short — ${crowdedSide} crowded (contrarian signal)`);
    }

    if (microParts.length > 0) {
      parts.push(`\n## MARKET MICROSTRUCTURE (abnormal conditions detected)`);
      microParts.forEach(line => parts.push(line));
    }

    // Previous plan context
    if (context.previousPlan) {
      parts.push(`\n## PREVIOUS PLAN`);
      parts.push(`Analysis: ${context.previousPlan.analysis || 'N/A'}`);
      if (context.previousPlan.actionAbove) {
        const a = context.previousPlan.actionAbove;
        parts.push(`Above: ${a.type || a.primary?.type || 'N/A'} at ${a.triggerPrice || a.primary?.triggerPrice || 'N/A'} (${a.reason || a.primary?.reason || 'N/A'})`);
      }
      if (context.previousPlan.actionBelow) {
        const a = context.previousPlan.actionBelow;
        parts.push(`Below: ${a.type || a.primary?.type || 'N/A'} at ${a.triggerPrice || a.primary?.triggerPrice || 'N/A'} (${a.reason || a.primary?.reason || 'N/A'})`);
      }
    }

    if (context.planHistory && context.planHistory.length > 0) {
      parts.push(`\n## RECENT OUTCOMES (last ${context.planHistory.length})`);
      for (const hist of context.planHistory) {
        if (hist.outcome) {
          parts.push(`- ${hist.outcome.action?.type || 'N/A'} at ${hist.outcome.price || 'N/A'} (${hist.outcome.action?.reason || 'N/A'})`);
        }
      }
    }

    parts.push(`\nGenerate your ${context.phase === 'INITIAL' ? 'INITIAL OPEN_HEDGE' : 'DCA'} plan now. Respond with ONLY the JSON object.`);

    return parts.join('\n');
  }

  _parseResponse(text) {
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      throw new Error(`Failed to parse AI response as JSON: ${e.message}`);
    }
  }

  /**
   * Validate Phase 1 (INITIAL) plan: flat actionAbove/actionBelow with
   * type=OPEN_HEDGE on each side. Phase 2 plans use the paired schema
   * via _validatePairedPlanStructure.
   */
  _validatePhase1Plan(plan) {
    if (!plan.analysis) throw new Error('Plan missing "analysis"');
    if (!plan.actionAbove) throw new Error('Plan missing "actionAbove"');
    if (!plan.actionBelow) throw new Error('Plan missing "actionBelow"');

    for (const key of ['actionAbove', 'actionBelow']) {
      const action = plan[key];
      if (action.type !== 'OPEN_HEDGE') throw new Error(`${key}: INITIAL phase requires OPEN_HEDGE, got "${action.type}"`);
      if (typeof action.triggerPrice !== 'number') throw new Error(`${key} missing numeric "triggerPrice"`);
      if (typeof action.longSizeUSDT !== 'number' || action.longSizeUSDT <= 0) throw new Error(`${key} missing positive "longSizeUSDT"`);
      if (typeof action.shortSizeUSDT !== 'number' || action.shortSizeUSDT <= 0) throw new Error(`${key} missing positive "shortSizeUSDT"`);
    }

    if (!plan.probabilityAssessment) throw new Error('Missing "probabilityAssessment"');
    if (!['ABOVE', 'BELOW'].includes(plan.probabilityAssessment.higherChance)) {
      throw new Error('probabilityAssessment.higherChance must be "ABOVE" or "BELOW"');
    }
  }

  /**
   * Validate the paired-trigger Phase 2 plan shape:
   *
   *   {
   *     analysis: string,
   *     actionAbove: {
   *       primary: { type: 'ADD_SHORT'|'CUT_SHORT'|'HOLD', triggerPrice, qty, reason },
   *       shadow:  { type: 'ADD_LONG'|'HOLD'|'SKIP',       triggerPrice, qty, reason },
   *     },
   *     actionBelow: {
   *       primary: { type: 'ADD_LONG'|'CUT_LONG'|'HOLD', triggerPrice, qty, reason },
   *       shadow:  { type: 'ADD_SHORT'|'HOLD'|'SKIP',    triggerPrice, qty, reason },
   *     },
   *     probabilityAssessment: { higherChance, confidence, reasoning },
   *   }
   *
   * Note: qty is in coin units (not sizeUSDT). HOLD primary missing
   * triggerPrice is allowed here — the risk-guard validator synthesizes
   * a default at current ± 3×ATR before the executor sees it.
   */
  _validatePairedPlanStructure(plan) {
    if (!plan.analysis) throw new Error('Plan missing "analysis"');
    if (!plan.actionAbove) throw new Error('Plan missing "actionAbove"');
    if (!plan.actionBelow) throw new Error('Plan missing "actionBelow"');

    const validatePair = (sideKey, expectedPrimaryTypes, expectedShadowTypes) => {
      const side = plan[sideKey];
      if (!side.primary) throw new Error(`${sideKey} missing "primary"`);
      if (!side.shadow)  throw new Error(`${sideKey} missing "shadow"`);

      const p = side.primary;
      if (!expectedPrimaryTypes.includes(p.type)) {
        throw new Error(`${sideKey}.primary type "${p.type}" invalid (must be: ${expectedPrimaryTypes.join(', ')})`);
      }
      if (p.type !== 'HOLD') {
        if (typeof p.triggerPrice !== 'number') throw new Error(`${sideKey}.primary missing numeric "triggerPrice"`);
        if (typeof p.qty !== 'number' || p.qty <= 0) throw new Error(`${sideKey}.primary missing positive "qty"`);
      }

      const s = side.shadow;
      if (!expectedShadowTypes.includes(s.type)) {
        throw new Error(`${sideKey}.shadow type "${s.type}" invalid (must be: ${expectedShadowTypes.join(', ')})`);
      }
      // ADD shadows need triggerPrice + qty. HOLD shadow has neither (only
      // primary HOLDs drive replan). SKIP carries nothing.
      if (s.type !== 'SKIP' && s.type !== 'HOLD') {
        if (typeof s.triggerPrice !== 'number') throw new Error(`${sideKey}.shadow missing numeric "triggerPrice"`);
        if (typeof s.qty !== 'number' || s.qty < 0) throw new Error(`${sideKey}.shadow missing non-negative "qty"`);
      }
    };

    validatePair('actionAbove', ['ADD_SHORT', 'CUT_SHORT', 'HOLD'], ['ADD_LONG', 'HOLD', 'SKIP']);
    validatePair('actionBelow', ['ADD_LONG', 'CUT_LONG', 'HOLD'], ['ADD_SHORT', 'HOLD', 'SKIP']);

    if (!plan.probabilityAssessment) throw new Error('Missing "probabilityAssessment"');
    if (!['ABOVE', 'BELOW'].includes(plan.probabilityAssessment.higherChance)) {
      throw new Error('probabilityAssessment.higherChance must be "ABOVE" or "BELOW"');
    }
  }
}

export { AiPlanner };
export default AiPlanner;
