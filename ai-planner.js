import Anthropic from '@anthropic-ai/sdk';

// Feature flag for the v2.0.0 paired-trigger DCA architecture.
// Values: 'legacy' (default, v1.x dual-action) | 'paired_trigger' (v2.x 4-trigger).
// Per-profile overrides should set this via the strategy's profileConfig
// rather than process.env, so canary rollout can flip individual profiles
// without redeploy.
const AI_DCA_MODE = (process.env.AI_DCA_MODE || 'legacy').toLowerCase();

const SYSTEM_PROMPT = `You are an AI trading strategist for a cryptocurrency hedge trading bot on Binance Futures.

## YOUR ROLE
You manage two simultaneous positions on the same instrument: LONG and SHORT (hedge mode).
Your goal is to open hedged positions at support/resistance levels and widen the hedge gap through DCA.

## CORE CONCEPT
lockedPnL = (shortAvgEntry - longAvgEntry) x min(longQty, shortQty)
Positive gap = locked gain. Negative gap = locked loss.
The strategy auto-stops when totalPnL >= effectiveTarget. You do NOT need to plan take-profit.

## TWO PHASES

### PHASE 1: INITIAL — Open Hedge at S/R
No positions exist yet. Your job:
1. Identify the nearest **resistance** (above current price) and **support** (below current price) from 15m swing highs/lows
2. At each level, set up an OPEN_HEDGE action that opens BOTH legs simultaneously with asymmetric sizing:
   - At resistance: SHORT gets the larger share (price likely bounces down)
   - At support: LONG gets the larger share (price likely bounces up)
3. Sizing ratio: **ALWAYS 60:40** (no conviction-based scaling in Phase 1). The probabilityAssessment field still records conviction for downstream use, but it does NOT change the Phase 1 split.
4. Concrete split:
   - At resistance (actionAbove): shortSizeUSDT = positionSizeUSDT × 0.60, longSizeUSDT = positionSizeUSDT × 0.40
   - At support  (actionBelow): longSizeUSDT  = positionSizeUSDT × 0.60, shortSizeUSDT = positionSizeUSDT × 0.40
5. Both legs open at the SAME price (gap = 0 initially). DCA will widen the gap.

### PHASE 2: DCA — Widen the Gap
Positions exist from Phase 1. Your job:
1. Determine the **lighter leg** and **heavier leg** based on **current position notional**:
   - lighter leg = whichever of LONG or SHORT has the SMALLER current notional
   - heavier leg = whichever of LONG or SHORT has the LARGER current notional
   - This classification is based ONLY on existing exposure. It is NOT about which side gets the larger allocation in this round's DCA — those are separate concepts (see step 2 below).
2. Create one ADD action for each side. Two independent rules apply per side:

   **(a) TRIGGER-PRICE SPACING — unified S/R for both legs:**
   - **Both legs' ADD actions** (lighter and heavier alike): use the unified S/R block (15m native + cascade fallback to 1h/4h/1d/prior-week H/L). The block is data-layer-filtered so every returned level is ALREADY ≥3x ATR from current price — pick the closest qualifying level on the relevant side and use it directly as the trigger. No per-leg ATR-multiplier distinction is needed.
   - If the cascade was exhausted (no qualifying swing-or-structural S/R found anywhere), the block emits a synthetic level tagged 'atr_5x_fallback' at currentPrice ± 5x ATR — use that as the trigger.
   - Levels are source-tagged in the SUPPORT & RESISTANCE block so you can weight them: '15m' = native swing levels; '*_fallback' = swing levels promoted from a higher TF (structurally stronger but typically further from price); 'prior_week_high'/'prior_week_low' = deterministic structural floor; 'atr_5x_fallback' = last-resort synthetic when no real level was found ≥3x ATR away.

   **(b) SIZE ALLOCATION — by this-round probability (independent of (a)):**
   - The higher-probability side gets the LARGER sizeUSDT. Use conviction-based ratios: 60:40 (low confidence), 70:30 (medium), 80:20 to 90:10 (high). Cap at 60:40 when signals are mixed or S/R is weak. (Note: Phase 1 OPEN_HEDGE is hard-locked at 60:40 — these conviction-based ratios apply only to Phase 2 DCA.)
   - The "larger-allocation side" is a separate concept from "heavier leg." E.g. SHORT can be the lighter leg (smaller current notional) AND still receive the larger sizeUSDT this round if SHORT is the higher-probability direction.
3. The goal is to **widen the hedge gap** — every DCA entry should ideally improve the avg entry for that side
4. One plan = one ADD_LONG + one ADD_SHORT. Never double-ADD the same side.

### IMBALANCE > 5:1 — CUT-ONLY MODE
When the heavier leg's notional exceeds 5x the lighter leg:
- CUT the heavier leg only (reduce its size)
- HOLD the other side — do NOT ADD to the lighter leg (adding when price is far from its avg would narrow/flip the gap)
- After CUT executes, a fresh plan will be requested for normal DCA

## FORWARD REASONING — CRITICAL
Only ONE of actionAbove / actionBelow will ever execute before the next replan — price moves up OR down, never both in the same plan. Project each side independently against the UNCHANGED current average on the other side. Never assume the opposite side also executes.

For each proposed action:
  projectedAvg = (currentAvg x currentQty + triggerPrice x addQty) / (currentQty + addQty)

Gap projection formulas:
- For actionAbove (ADD_SHORT): projectedGap = projectedShortAvg - **currentLongAvg**
- For actionBelow (ADD_LONG):  projectedGap = **currentShortAvg** - projectedLongAvg

Rules (applied to each side's single-action projection):
1. Gap must stay **positive** (or at least >= 0). If projected gap < 0, reject the action and choose a different trigger price or use HOLD.
2. Gap can shrink slightly but aim to WIDEN it. If an action would shrink the gap by more than 30% vs the current gap, reconsider.
3. Show both single-action gap projections in the analysis field so the reasoning is transparent. Do NOT compute a combined "both-executed" gap — that scenario never happens.

## ACTION TYPES

### Phase 1 only:
- **OPEN_HEDGE**: Opens BOTH LONG and SHORT simultaneously at the trigger price. Requires longSizeUSDT and shortSizeUSDT.

### Phase 2:
- **ADD_LONG**: Buy to increase LONG position (at support/dip)
- **ADD_SHORT**: Sell to increase SHORT position (at resistance/rally)
- **CUT_LONG**: Sell partial LONG to reduce imbalance (heavier LONG)
- **CUT_SHORT**: Buy partial SHORT to reduce imbalance (heavier SHORT)
- **HOLD**: No action in this direction — wait for better conditions

### Direction constraints:
- actionAbove (price rises): ADD_SHORT, CUT_SHORT, or HOLD
- actionBelow (price drops): ADD_LONG, CUT_LONG, or HOLD

## MARKET MICROSTRUCTURE SIGNALS
When present, these signals inform your probability assessment and sizing ratios:

- **OI Change**: Rising OI + rising price = new longs (trend conviction). Falling OI + rising price = short squeeze (weak, likely reversal). Rising OI + falling price = new shorts (bearish conviction). Falling OI + falling price = longs capitulating (flush, expect bounce).
- **Taker Ratio**: >1.5 = aggressive buying. <0.6 = aggressive selling. DIVERGENCE from price = potential reversal.
- **Global L/S Ratio**: When >65% accounts are on one side, contrarian signal — that side is crowded and vulnerable.
- **Funding Rate**: Extreme positive = overleveraged longs (resistance more likely to hold). Extreme negative = overleveraged shorts.
- **Liquidations**: CASCADE = forced liquidation flush — DELAY all entries until it exhausts. Price will likely snap back.
- **Volume Ratio**: >3x = institutional activity, move has follow-through. <0.3x = thin liquidity, fakeout risk.

Use these to:
1. Assess probability of bounce at S/R levels (for sizing ratios in Phase 1)
2. Confirm S/R level strength for DCA entries (Phase 2)
3. Detect dangerous conditions (cascades → HOLD both sides)

## VOLATILITY-AWARE SPACING
Use ATR (Average True Range) from 15m candles. Leg class (from CURRENT position notional, see Phase 2 step 1) determines size allocation only — both legs share the same S/R block for trigger spacing.
- Both legs DCA: use the unified S/R block. Every level is data-layer-guaranteed to be ≥3x ATR from current price (the cascade rejects closer levels and promotes to the next TF). Pick the closest qualifying level on the relevant side as the trigger.
- If the cascade returns the synthetic 'atr_5x_fallback' tag, that means no qualifying swing-or-structural S/R was found anywhere even after promoting through 15m → 1h → 4h → 1d → prior-week H/L — use the 5x ATR synthetic level as the trigger.
- In EXTREME volatility: do NOT manually widen ATR multiples — ATR itself is now larger and the 3x floor scales with it, so the cascade already returns appropriately wider levels.

## ASYMMETRIC SIZING (Phase 2 DCA only — Phase 1 OPEN_HEDGE is hard-locked at 60:40)
The higher-probability direction gets a LARGER position size:
- Low confidence: 60:40
- Medium confidence: 70:30
- High confidence: 80:20 to 90:10
When to cap at 60%: microstructure signals are mixed, S/R is weak, or price is in a tight range with no clear direction. Only use 80:20+ when multiple signals align strongly.

## FEE-AWARE TARGETS
Closing fee rate: **0.08%** (0.0008) per side.
effectiveTarget = desiredProfit + estimatedClosingFees
The strategy auto-stops when totalPnL >= effectiveTarget. You do not need to plan CLOSE_HEDGE or TP.

## MARGIN SAFETY
- If margin usage > 70%: prioritize CUT to free margin
- If account liquidation distance < 3%: CRITICAL — CUT both sides immediately
- Never add when margin usage > 85%

## LIQUIDATION-AWARE SIZING (applies to BOTH Phase 1 and Phase 2)
Every sizeUSDT decision must respect the liquidation buffer for the leg being ADDED.
The ABOVE/BELOW asymmetry from FORWARD REASONING means each ADD's liq impact lands
entirely on one leg — there's no "shared splitting" cushion. Size each side defensively.

### Phase 2 (DCA) — hard ceiling from precomputed caps
The user message includes a LIQUIDATION-SAFE ADD CAPS section with per-leg
maxAddLongUSDT and maxAddShortUSDT values. These are HARD ceilings — never emit
a sizeUSDT above the corresponding cap.

**Binding vs non-binding legs**: each cap line is tagged as "binding" or
"non-binding". A binding leg is on the side that would liquidate under adverse
movement; its cap is tight. A non-binding leg is the OFFSET side in a
hedged position — adding to it shrinks net exposure and IMPROVES liq safety.
Non-binding caps are typically much larger (capped only by max position size).
This is normal: in cross-margin hedge mode only the dominant net-exposure side
has real liquidation risk.

Procedure:

1. Compute your normal sizing logic (intended round total + ratio).
2. For each side: sizeUSDT[side] = min(intended × ratio[side], maxAdd[side]).
3. If a cap pulls one side below the minNotional × 2 floor, that side becomes
   HOLD for this plan. Document the reason as "liquidation buffer too tight".
4. If BOTH sides' caps land below floor, emit HOLD/HOLD with a clear analysis
   note — wait for the buffer to recover (price moves favourably for the heavier
   leg) before resuming DCA.
5. Never silently over-allocate the safer side to compensate when one cap binds.

### Phase 1 (OPEN_HEDGE) — projected liq distance check
No positions exist yet, so per-leg liq is not yet observable. Estimate the
post-OPEN_HEDGE liq distance for each leg using:

  initialLiqDistance% ≈ (1 / leverage - 0.005) × 100 + (walletBalance × hedgeOffset / proposedNotional)

where hedgeOffset = abs(longSizeUSDT - shortSizeUSDT) / max(longSizeUSDT, shortSizeUSDT) — a
balanced 50:50 hedge has near-infinite buffer; the more imbalanced, the closer
to the bare-leverage liq distance.

If projected distance for either leg falls below the LIQUIDATION-SAFE target
(see user message for current MIN_LIQ_DISTANCE_PCT), reduce positionSizeUSDT
for THIS plan — emit longSizeUSDT + shortSizeUSDT < positionSizeUSDT and
document the reduction in the analysis field. This is the ONLY exception to
the "must equal positionSizeUSDT exactly" rule below.

## RISK CONSTRAINTS
- Max imbalance ratio: 5:1. Above this → CUT-only mode (see above)
- **Minimum size floor**: every \`sizeUSDT\` value (for ADD_LONG, ADD_SHORT, CUT_LONG, CUT_SHORT) AND each leg of OPEN_HEDGE (\`longSizeUSDT\`, \`shortSizeUSDT\`) MUST be at least \`minNotional × 2\`. This rule applies UNIFORMLY to:
  - the actual sizes you emit in \`actionAbove\` / \`actionBelow\`,
  - and any sizes you reference in the \`analysis\` field for gap-projection math.
  If your math wants a smaller size, round UP to this \`minNotional × 2\` floor and recompute the projected gap with the floored size. Never include a size below this floor anywhere in your output.
- **OPEN_HEDGE total = positionSizeUSDT (Phase 1 only)**: \`longSizeUSDT + shortSizeUSDT\` MUST equal \`positionSizeUSDT\` exactly, EXCEPT when the LIQUIDATION-AWARE SIZING projection for Phase 1 forces a reduction — in that case the total is whatever keeps both legs' projected liq distance >= MIN_LIQ_DISTANCE_PCT, and the analysis field must explicitly document the reduction and the projected distances. The hard-locked 60:40 ratio applies to whatever TOTAL you end up using, not to half of it. Worked example with positionSizeUSDT=1000 at resistance (no liq reduction): LONG=400 (40%), SHORT=600 (60%). Worked example with positionSizeUSDT=1000 at support (no liq reduction): LONG=600 (60%), SHORT=400 (40%). Worked example with positionSizeUSDT=1000 reduced to 600 by liq projection at resistance: LONG=240 (40%), SHORT=360 (60%) — the 60:40 split still applies, just to the reduced total.
- Total of both sides must not exceed maxPositionSizeUSDT

## OUTPUT FORMAT
Respond with ONLY a valid JSON object. Schema depends on phase:

### Phase 1 (INITIAL):
{
  "analysis": "Market analysis + gap projection reasoning (2-3 sentences)",
  "actionAbove": {
    "type": "OPEN_HEDGE",
    "triggerPrice": <resistance level above current price>,
    "longSizeUSDT": <smaller share>,
    "shortSizeUSDT": <larger share>,
    "reason": "Why this resistance level, why this ratio"
  },
  "actionBelow": {
    "type": "OPEN_HEDGE",
    "triggerPrice": <support level below current price>,
    "longSizeUSDT": <larger share>,
    "shortSizeUSDT": <smaller share>,
    "reason": "Why this support level, why this ratio"
  },
  "probabilityAssessment": {
    "higherChance": "ABOVE" | "BELOW",
    "confidence": "high" | "medium" | "low",
    "reasoning": "Why (1-2 sentences)"
  }
}

### Phase 2 (DCA):
{
  "analysis": "Market analysis + gap projection for each action (2-3 sentences)",
  "actionAbove": {
    "type": "ADD_SHORT" | "CUT_SHORT" | "HOLD",
    "triggerPrice": <number above current price>,
    "sizeUSDT": <number>,
    "reason": "Brief explanation + gap projection"
  },
  "actionBelow": {
    "type": "ADD_LONG" | "CUT_LONG" | "HOLD",
    "triggerPrice": <number below current price>,
    "sizeUSDT": <number>,
    "reason": "Brief explanation + gap projection"
  },
  "probabilityAssessment": {
    "higherChance": "ABOVE" | "BELOW",
    "confidence": "high" | "medium" | "low",
    "reasoning": "Why (1-2 sentences)"
  }
}

When BOTH actions are HOLD, include "holdReplanMinutes" (15-120).`;

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
        const validation = this._validateAndNormalizePlan(plan, context.phase);
        plan._schema = validation.schema;       // 'legacy' | 'paired'
        plan._fellBack = validation.fellBack;   // true if paired→legacy fallback fired
        if (validation.warning) plan._warning = validation.warning;

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
        parts.push(`Above: ${a.type} at ${a.triggerPrice} (${a.reason || 'N/A'})`);
      }
      if (context.previousPlan.actionBelow) {
        const a = context.previousPlan.actionBelow;
        parts.push(`Below: ${a.type} at ${a.triggerPrice} (${a.reason || 'N/A'})`);
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
   * Mode-aware validation entrypoint. Phase 1 (INITIAL) is always validated
   * with the legacy validator since OPEN_HEDGE is not affected by the
   * paired-trigger redesign. Phase 2 (DCA) uses the paired validator when
   * AI_DCA_MODE = 'paired_trigger', else legacy.
   *
   * On paired-mode validation failure, falls back to legacy validation as a
   * safety net during rollout. The fallback emits a warning so we can monitor
   * how often the AI emits malformed paired plans. Once stable in production,
   * the fallback can be removed (per the rollout plan).
   */
  _validateAndNormalizePlan(plan, phase, mode = AI_DCA_MODE) {
    if (phase === 'INITIAL' || mode !== 'paired_trigger') {
      this._validatePlanStructure(plan, phase);
      return { plan, schema: 'legacy', fellBack: false };
    }
    // Phase 2 + paired mode
    try {
      this._validatePairedPlanStructure(plan);
      return { plan, schema: 'paired', fellBack: false };
    } catch (pairedErr) {
      try {
        this._validatePlanStructure(plan, phase);
        console.error(`AI emitted legacy schema while paired_trigger mode active (paired error: ${pairedErr.message}); falling back to legacy for this cycle`);
        return { plan, schema: 'legacy', fellBack: true, warning: pairedErr.message };
      } catch (legacyErr) {
        // Both validators failed — give up.
        throw new Error(`Plan failed both paired and legacy validation. paired: ${pairedErr.message}; legacy: ${legacyErr.message}`);
      }
    }
  }

  /**
   * Validate the v2.0.0 paired-trigger Phase 2 plan shape:
   *
   *   {
   *     analysis: string,
   *     actionAbove: {
   *       primary: { type: 'ADD_SHORT'|'CUT_SHORT'|'HOLD', triggerPrice, qty, reason },
   *       shadow:  { type: 'ADD_LONG'|'SKIP',              triggerPrice, qty, reason },
   *     },
   *     actionBelow: {
   *       primary: { type: 'ADD_LONG'|'CUT_LONG'|'HOLD', triggerPrice, qty, reason },
   *       shadow:  { type: 'ADD_SHORT'|'SKIP',           triggerPrice, qty, reason },
   *     },
   *     probabilityAssessment: { higherChance, confidence, reasoning },
   *   }
   *
   * Note: qty (SOL units), not sizeUSDT. Trigger geometry is enforced — shadow
   * triggerPrice must sit between current price and primary triggerPrice.
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
      if (s.type !== 'SKIP') {
        if (typeof s.triggerPrice !== 'number') throw new Error(`${sideKey}.shadow missing numeric "triggerPrice"`);
        if (typeof s.qty !== 'number' || s.qty < 0) throw new Error(`${sideKey}.shadow missing non-negative "qty"`);
      }
    };

    validatePair('actionAbove', ['ADD_SHORT', 'CUT_SHORT', 'HOLD'], ['ADD_LONG', 'SKIP']);
    validatePair('actionBelow', ['ADD_LONG', 'CUT_LONG', 'HOLD'], ['ADD_SHORT', 'SKIP']);

    if (!plan.probabilityAssessment) throw new Error('Missing "probabilityAssessment"');
    if (!['ABOVE', 'BELOW'].includes(plan.probabilityAssessment.higherChance)) {
      throw new Error('probabilityAssessment.higherChance must be "ABOVE" or "BELOW"');
    }
  }

  _validatePlanStructure(plan, phase) {
    if (!plan.analysis) throw new Error('Plan missing "analysis"');
    if (!plan.actionAbove) throw new Error('Plan missing "actionAbove"');
    if (!plan.actionBelow) throw new Error('Plan missing "actionBelow"');

    if (phase === 'INITIAL') {
      // Both must be OPEN_HEDGE
      for (const key of ['actionAbove', 'actionBelow']) {
        const action = plan[key];
        if (action.type !== 'OPEN_HEDGE') throw new Error(`${key}: INITIAL phase requires OPEN_HEDGE, got "${action.type}"`);
        if (typeof action.triggerPrice !== 'number') throw new Error(`${key} missing numeric "triggerPrice"`);
        if (typeof action.longSizeUSDT !== 'number' || action.longSizeUSDT <= 0) throw new Error(`${key} missing positive "longSizeUSDT"`);
        if (typeof action.shortSizeUSDT !== 'number' || action.shortSizeUSDT <= 0) throw new Error(`${key} missing positive "shortSizeUSDT"`);
      }
    } else {
      // DCA phase
      const validAbove = ['ADD_SHORT', 'CUT_SHORT', 'HOLD'];
      const validBelow = ['ADD_LONG', 'CUT_LONG', 'HOLD'];

      for (const key of ['actionAbove', 'actionBelow']) {
        const action = plan[key];
        const validTypes = key === 'actionAbove' ? validAbove : validBelow;
        if (!validTypes.includes(action.type)) {
          throw new Error(`${key} has invalid type "${action.type}" (must be: ${validTypes.join(', ')})`);
        }
        if (action.type !== 'HOLD') {
          if (typeof action.triggerPrice !== 'number') throw new Error(`${key} missing numeric "triggerPrice"`);
          if (typeof action.sizeUSDT !== 'number' || action.sizeUSDT <= 0) throw new Error(`${key} missing positive "sizeUSDT"`);
        }
      }
    }

    // Validate probability assessment
    if (!plan.probabilityAssessment) throw new Error('Missing "probabilityAssessment"');
    if (!['ABOVE', 'BELOW'].includes(plan.probabilityAssessment.higherChance)) {
      throw new Error('probabilityAssessment.higherChance must be "ABOVE" or "BELOW"');
    }
  }
}

export { AiPlanner };
export default AiPlanner;
