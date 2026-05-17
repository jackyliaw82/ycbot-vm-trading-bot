import Anthropic from '@anthropic-ai/sdk';
import { REVERSAL_SYSTEM_PROMPT } from './ai-reversal-prompt.js';

// Hedge system prompt — paired-trigger Hedge Phase (v3.0.0+ architecture).
// Phase 1 (INITIAL) emits OPEN_HEDGE in the flat actionAbove/actionBelow
// schema; Phase 2 (HEDGE) emits paired primary+shadow per side.
// Reversal system prompt is imported above; selection happens in generatePlan.
const SYSTEM_PROMPT = `You are an AI trading strategist for a cryptocurrency hedge trading bot on Binance Futures (v3.0.0 paired-trigger Hedge Phase).

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
1. Pick the trigger levels from the **SUPPORT & RESISTANCE block** in the user message — the unified cascade (15m native → 1h → currentPrice ± 5×ATR synthetic). Every level is data-layer-guaranteed to be ≥3×ATR from current price. Pick the closest qualifying level on each side regardless of source tag — 1h_fallback and atr_5x_fallback synthetic levels are valid OPEN_HEDGE triggers, not reasons to HOLD.
2. At each level, emit OPEN_HEDGE that opens BOTH legs simultaneously.
3. Sizing ratio: **ALWAYS 60:40** (no conviction-based scaling in Phase 1).
4. At resistance: shortSizeUSDT = positionSizeUSDT × 0.60, longSizeUSDT × 0.40.
5. At support: longSizeUSDT = positionSizeUSDT × 0.60, shortSizeUSDT × 0.40.
6. Both legs open at the SAME price (gap = 0 initially); Hedge Phase widens the gap.
7. Phase 1 keeps the flat 2-trigger schema (one OPEN_HEDGE per side, atomic). Paired triggers are NOT used in Phase 1 — atomicity matters more than multiple trigger points when opening from zero positions.

### PHASE 2: HEDGE — Paired-Trigger Plan

Positions exist from Phase 1. Each plan emits FOUR trigger points: a primary + a shadow on
each side. The shadow is the opposite-leg ADD placed 1×ATR closer to current price than the
primary, so when price moves toward a primary, the shadow fires first and the laggard leg
grows BEFORE the primary fires. This guarantees both legs grow on every meaningful move.

**Ultimate goal of Hedge Phase:** widen the hedge gap while keeping the LONG/SHORT ratio
band intact, moving both avg entries apart in trending or consolidating markets, until
totalPnL ≥ effectiveTarget.

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

#### Primary sizing — side-ratio + ceiling-based, AI-decided

**Step 1: Pick the heavier-leg side ratio** based on your directional bias and conviction:
- **60:40** → low conviction
- **70:30** → medium conviction
- **80:20** → high conviction
- **90:10** → very high conviction (rare; requires strong microstructure confirmation)

The bigger fraction goes to the side aligned with your bias direction:
- bias \`ABOVE\` → bigger LONG primary (ADD_LONG below) — you expect price to retrace down, so bigger LONG dip-buy.
- bias \`BELOW\` → bigger SHORT primary (ADD_SHORT above) — you expect price to retrace up, so bigger SHORT fade.

Total side-allocation never exceeds \`positionSizeUSDT\` (the user's per-cycle base size).

**Step 2: Compute each primary's hard ceiling** = the minimum of:
- \`sideAllocation\` = ratio × positionSizeUSDT (your bias-driven budget for this side)
- \`liqCapUSDT\` (from LIQUIDATION-SAFE ADD CAPS in the user message) — HARD safety
- \`gapFlipCeilingUSDT\` — largest size that keeps projectedGap > 0 ASSUMING the same-side
  shadow has fired first (use POST-SHADOW LO_after / SH_after per FORWARD REASONING
  below). If the same-side shadow is SKIP, fall back to current-state projection.
  HARD safety.

**Band saturation is NOT a primary sizing constraint.** Ratio may drift further
outside the band on a primary fire when adding to the heavier side. The same-side
shadow on the next plan (which has opposite direction to its primary by construction)
will pull ratio back toward band via the \`max_X\`/\`max_Y\` headroom that opens up when
the heavier leg grows. Cyclic push (primary) and pull (next-plan same-side shadow) is
by design — only the hedge-gap-positive invariant is sacred.

When the current ratio is already outside the band and you are ADDing to the heavier
side, explicitly state in \`analysis\`: the current ratio, the post-fill ratio, and the
rebalance mechanism on the next plan. Keep the reasoning auditable.

**Step 3: Pick the primary's notional within \`[2×minNotional, hardCeiling]\`:**

If the primary is on the LIGHTER side (would pull ratio toward band — e.g. current
ratio 1.50 LONG-heavy and you are ADD_SHORT, or ratio 0.70 SHORT-heavy and you are
ADD_LONG): aim for the largest qty that brings ratio closest to band. Typically the
hardCeiling. If \`gapFlipCeilingUSDT\` would force the qty below what's needed to
land inside the band, ADD at the gap-flip-bounded qty anyway — ratio moves toward
band but may not fully re-enter. This is a partial rebalance and is acceptable.

If the primary is on the HEAVIER side (would push ratio further from band — e.g.
current ratio 1.50 LONG-heavy and you are ADD_LONG): size freely within
\`[2×minNotional, hardCeiling]\`. **Default: pick the hardCeiling (max-safe size).**
Ratio drift is acceptable here; the rebalance happens on the next plan's same-side
shadow.

If the primary is on the BALANCED side (current ratio inside band): pick within
\`[2×minNotional, hardCeiling]\` per microstructure judgment. Default: pick the
hardCeiling. Moderate down only on reversal-risk signals (taker divergence,
abnormal OI spike, volume cascade, etc.). State moderation reason in \`reason\`.

**If hardCeiling < 2×minNotional → emit \`primary.type = "HOLD"\`** — the minimum
safe ADD would flip gap or breach liq cap. Band saturation is NOT a HOLD reason
anymore. Single-side HOLD is acceptable; both-side HOLD/HOLD is forbidden — the
system will force-convert to CUT heavier leg (post-hoc) but you should try to
avoid it by escalating to CUT yourself when appropriate.

Convert to qty: \`qty = sizeUSDT / triggerPrice\` (rounded to symbol qty step).

#### Shadow sizing — band-bounded, gap-flip-aware

The user message provides \`max_X\` (above-side ADD_LONG shadow band headroom) and \`max_Y\`
(below-side ADD_SHORT shadow band headroom). These encode the band saturation cap:
\`max_X = qtySH × 1.15 − qtyLO\` and \`max_Y = qtyLO / 0.85 − qtySH\`.

Shadows fall into two cases:

**Case 1 — Drift-away shadow (band-saturated side):** \`max_X ≤ 0\` (or \`max_Y ≤ 0\`).
The shadow would push ratio FURTHER from the band on the already-heavy side. Emit
\`shadow.type = "SKIP"\`. Shadows are never allowed to drift ratio away from the band.

**Case 2 — Rebalance shadow (lighter side has headroom):** \`max_X > 0\` (or \`max_Y > 0\`).
The shadow pulls ratio TOWARD the band. Compute the gap-flip ceiling for the shadow —
the largest qty Q such that the leg projection still leaves post-shadow gap > 0:
- ADD_LONG shadow above @ shadowPrice (pulls LO):
  \`LO_after = (LO×qtyLO + shadowPrice×Q) / (qtyLO + Q)\` must satisfy \`SH − LO_after > 0\`.
  When shadowPrice > LO, Q is unbounded by gap; when shadowPrice < LO, Q is bounded.
- ADD_SHORT shadow below @ shadowPrice (pulls SH):
  \`SH_after = (SH×qtySH + shadowPrice×Q) / (qtySH + Q)\` must satisfy \`SH_after − LO > 0\`.
  When shadowPrice < SH, Q is unbounded by gap; when shadowPrice closer to LO or below, Q bounded.

Pick shadow qty = \`min(max_X or max_Y, gap_flip_ceiling)\` × 0.70 safety margin.
Floor: \`2×minNotional / triggerPrice\`.

**If even the floor would flip gap or breach liq cap → emit \`shadow.type = "SKIP"\`.**
Only this corner case (no positive Q fits gap-positive) maps to SKIP under the new rule.

State your sizing rationale in the shadow's \`reason\` field: which case applies,
the gap-flip ceiling value, and the chosen qty.

#### Ratio-band semantics
- The band [0.85, 1.15] constrains SHADOW sizing only. Primaries ADD freely within hard
  ceilings (sideAllocation, liqCap, gapFlipCeiling). Ratio may drift outside band on
  primary fires when ADDing to the heavier side.
- Drift-away shadow (\`max_X ≤ 0\` or \`max_Y ≤ 0\` on the heavier side): SKIP.
- Rebalance shadow (\`max_X > 0\` or \`max_Y > 0\` on the lighter side): pull ratio toward
  band. If full \`max_X\`/\`max_Y\` would flip gap, scale down to the gap-flip ceiling (with
  ~70% safety margin). Only SKIP if even the floor would flip gap.
- Across cycles, primary pushes ratio outside band, the next plan's same-side shadow
  (opposite direction to its primary by construction) pulls it partially back. Steady-state
  oscillation around the band edge is acceptable.
- Imbalance > 5:1 still escalates to CUT-only mode (hard stop on runaway drift).
- Only the gap-positive invariant is sacred.

#### Trigger-spacing rule
Both legs use the same S/R block. There is no per-leg ATR-multiplier distinction. The
cascade already guarantees primary triggers are ≥3×ATR from current. Shadow at primary
∓1×ATR places it 2–4×ATR from current, well clear of micro-noise.

#### Replan trigger
- AI replan fires ONLY when a primary executes (ADD or CUT).
- Shadow execution does NOT trigger a replan; remaining triggers in this plan stay active.
- The shadow-first sequencing in FORWARD REASONING means the primary is already sized to
  remain gap-safe AFTER the same-side shadow has fired, so this is by design.
- In zigzag paths where the OPPOSITE-side shadow ALSO fires before the primary (e.g.
  AL_S → AS_S → AS_P), the small additional gap drain on the opposite side is bounded —
  each shadow's in-isolation gate still holds and the next primary fire resets state with
  a fresh AI replan.

### IMBALANCE > 5:1 — CUT-ONLY MODE
When the heavier leg's notional exceeds 5× the lighter leg, primary on the heavier side
becomes CUT_LONG / CUT_SHORT (not ADD); shadow on that side becomes SKIP; primary and
shadow on the lighter side use HOLD / SKIP. After CUT executes, fresh paired plan resumes.

## FORWARD REASONING — SHADOW-FIRST SEQUENCING

The shadow on the SAME side as a primary always fires FIRST when price moves toward the
primary (shadow sits 1×ATR closer to current). Therefore size the primary based on the
POST-SHADOW projected state, NOT the current state. This makes primary sizing accurate
at the moment it actually fires.

### Shadow projection (Step 1 — current state in, post-shadow state out)
Each shadow projects against the UNCHANGED current avg on the OPPOSITE side:
- Shadow above (ADD_LONG at primaryAbove − 1×ATR):
  LO_after = (currentLongAvg × currentLongQty + shadowAbove.triggerPrice × shadowAbove.qty)
             / (currentLongQty + shadowAbove.qty)
  projectedGap_shadowAbove = currentShortAvg − LO_after  (MUST stay > 0)
- Shadow below (ADD_SHORT at primaryBelow + 1×ATR):
  SH_after = (currentShortAvg × currentShortQty + shadowBelow.triggerPrice × shadowBelow.qty)
             / (currentShortQty + shadowBelow.qty)
  projectedGap_shadowBelow = SH_after − currentLongAvg  (MUST stay > 0)

### Primary projection (Step 2 — uses POST-SHADOW state on same side)
Each primary projects against the POST-SHADOW projected avg on the SAME side (because the
same-side shadow fires first), and the UNCHANGED current avg on the opposite side:
- Primary above (ADD_SHORT at primaryAbove.triggerPrice):
  SH_after_primary = (currentShortAvg × currentShortQty + primaryAbove.triggerPrice × primaryAbove.qty)
                     / (currentShortQty + primaryAbove.qty)
  projectedGap_primaryAbove = SH_after_primary − LO_after  (where LO_after is from Step 1)
- Primary below (ADD_LONG at primaryBelow.triggerPrice):
  LO_after_primary = (currentLongAvg × currentLongQty + primaryBelow.triggerPrice × primaryBelow.qty)
                     / (currentLongQty + primaryBelow.qty)
  projectedGap_primaryBelow = SH_after − LO_after_primary  (where SH_after is from Step 1)

### Fallback when shadow.type = SKIP
If the same-side shadow is SKIP (band saturated, or shadow gap-flip), the primary reverts
to current-state projection:
- Primary above (shadow above = SKIP): projectedGap = projectedShortAvg − currentLongAvg
- Primary below (shadow below = SKIP): projectedGap = currentShortAvg − projectedLongAvg

### Edge case
If price gaps directly through the primary level without touching the shadow level first
(rare — single tick covering >1×ATR), the primary will be mildly under-sized vs what
current-state would have allowed. This is acceptable — leaves a bit of notional on the
table but is never a safety issue.

Rules: gap must stay positive after BOTH steps; gap can shrink slightly but aim to widen;
show BOTH the shadow projection AND the post-shadow primary projection numerically in the
\`analysis\` field (e.g. "LO_after AL_shadow = 100.83, then SH_after AS_primary = 112.5,
projectedGap = 11.67").

**Both-side gap-flip → CUT escalation:** If EVERY reachable trigger on actionAbove projects negative gap AND EVERY reachable trigger on actionBelow also projects negative gap (i.e. the only options would be HOLD/HOLD on primaries), DO NOT emit HOLD/HOLD. Instead, emit CUT on the heavier leg per **CUT-DRIVEN ESCALATION** below. If only ONE side is gap-flip-blocked and the other has a viable ADD, the unblocked side ADDs as normal and the blocked side stays HOLD (single-side HOLD is acceptable).

## ACTION TYPES

### Phase 1 only:
- OPEN_HEDGE — opens both LONG and SHORT simultaneously.

### Phase 2 paired:
- ADD_LONG / ADD_SHORT — primaries and shadows.
- CUT_LONG / CUT_SHORT — primary-only. Triggered by: (a) imbalance > 5:1 CUT-only mode, (b) liq cap below floor / = 0, (c) margin > 85%, (d) both-side gap-flip deadlock. See CUT-DRIVEN ESCALATION.
- HOLD — primary only; AI judges no good entry on this side this cycle. **MUST include a triggerPrice** = the price at which the HOLD reasoning becomes invalid. When the primary HOLD's triggerPrice crosses, the strategy replans. Default to current ± 3×ATR if no specific level — the system synthesizes that if you omit it.
- SKIP — shadow-only; band saturated, AI judges shadow unsafe, or paired-side primary is CUTting (shadow on a CUT side is always SKIP).

### Direction constraints (paired):
- actionAbove.primary type ∈ {ADD_SHORT, CUT_SHORT, HOLD}
- actionAbove.shadow  type ∈ {ADD_LONG, SKIP}
- actionBelow.primary type ∈ {ADD_LONG, CUT_LONG, HOLD}
- actionBelow.shadow  type ∈ {ADD_SHORT, SKIP}

## MARKET MICROSTRUCTURE SIGNALS
OI Change, Taker Ratio, Global L/S, Funding Rate, Liquidations, Volume Ratio. Use these
for probability assessment (still recorded in \`probabilityAssessment\`) and to flag
dangerous conditions (cascade → HOLD/SKIP everywhere).
\`probabilityAssessment.higherChance\` and \`.confidence\` DRIVE the primary side-ratio in
Phase 2 (Hedge Phase) — bigger primary on the side aligned with bias; ratio scales with
confidence per the Sizing section above (60:40 low / 70:30 medium / 80:20 high / 90:10 very high).

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

### Phase 2 (HEDGE) — PAIRED:
{
  "analysis": "Market analysis + 4 single-action gap projections (primary above, shadow above, primary below, shadow below)",
  "actionAbove": {
    "primary": { "type": "ADD_SHORT"|"CUT_SHORT"|"HOLD", "triggerPrice": <number ≥ currentPrice + 3×ATR>, "qty": <coin qty, omit/null for HOLD>, "reason": "..." },
    "shadow":  { "type": "ADD_LONG"|"SKIP", "triggerPrice": <primary.triggerPrice − 1×ATR for ADD_LONG; SKIP needs no trigger>, "qty": <coin qty, pre-clamped; omit for SKIP>, "reason": "..." }
  },
  "actionBelow": {
    "primary": { "type": "ADD_LONG"|"CUT_LONG"|"HOLD", "triggerPrice": <number ≤ currentPrice − 3×ATR>, "qty": <coin qty, omit/null for HOLD>, "reason": "..." },
    "shadow":  { "type": "ADD_SHORT"|"SKIP", "triggerPrice": <primary.triggerPrice + 1×ATR for ADD_SHORT; SKIP needs no trigger>, "qty": <coin qty, pre-clamped; omit for SKIP>, "reason": "..." }
  },
  "probabilityAssessment": { "higherChance": "ABOVE"|"BELOW", "confidence": "high"|"medium"|"low", "reasoning": "..." }
}

**Primary HOLD MUST include a triggerPrice** — the price at which your HOLD reasoning becomes invalid. When primary price crosses, the strategy replans. Default to current ± 3×ATR if you have no specific level in mind. Same direction rules: actionAbove > current, actionBelow < current. The system synthesizes current ± 3×ATR if you omit it. **HOLD is primary-only** — shadow type is restricted to ADD or SKIP.`;

// DeepSeek exposes an Anthropic-compatible endpoint at /anthropic. Pointing
// the @anthropic-ai/sdk at this baseURL lets us reuse the same
// `messages.create(...)` signature for DeepSeek V4 models with no other code
// changes. Auth is via the same `x-api-key` header the SDK already sends.
// Source: https://api-docs.deepseek.com/guides/anthropic_api
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

class AiPlanner {
  constructor(apiKey, model = 'claude-sonnet-4-6') {
    const isDeepseek = typeof model === 'string' && model.startsWith('deepseek-');
    this.client = new Anthropic({
      apiKey,
      ...(isDeepseek ? { baseURL: DEEPSEEK_BASE_URL } : {}),
    });
    this.model = model;
    this.provider = isDeepseek ? 'deepseek' : 'anthropic';
    this.maxRetries = 3;
    // One-shot diagnostic flag — first successful consult logs the raw
    // response.usage shape so we can verify which cache-hit fields the
    // provider populates (esp. DeepSeek's Anthropic-compatible endpoint:
    // Anthropic-style `cache_read_input_tokens` vs DeepSeek-native
    // `prompt_cache_hit_tokens`). Stays false after first log to keep
    // production logs clean.
    this._loggedUsageShape = false;
  }

  async generatePlan(context, strategyType = 'hedge') {
    const isReversal = strategyType === 'reversal' || context.strategyType === 'reversal';
    const systemPrompt = isReversal ? REVERSAL_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const userMessage = isReversal ? this._buildReversalUserMessage(context) : this._buildUserMessage(context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          // 8192 cap — was 2048, but Hedge Phase analyses can run long
          // (multi-paragraph math + gap projections + band reasoning),
          // and truncated responses produce "Unexpected end of JSON input"
          // parse failures that send the strategy into the stale-counter
          // retry loop. Output is billed per emitted token, not per cap,
          // so the higher ceiling has no cost impact in normal operation.
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });

        // Concatenate every text block; skip non-text content (thinking /
        // tool_use blocks). Future-proofs against reasoning-mode responses
        // and DeepSeek's Anthropic-compatible endpoint which may lead with
        // a non-text block.
        const textBlocks = (response.content || [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        const text = textBlocks.join('\n').trim();

        if (!text) {
          // Surface the actual response shape so the next "empty response"
          // isn't a black box. Logs once per attempt; the catch block below
          // handles the retry loop.
          const diag = {
            provider: this.provider,
            model: this.model,
            stopReason: response.stop_reason ?? null,
            contentTypes: (response.content || []).map((b) => b?.type ?? typeof b),
            inputTokens: response.usage?.input_tokens ?? null,
            outputTokens: response.usage?.output_tokens ?? null,
          };
          console.error(`[ai-planner] empty response: ${JSON.stringify(diag)}`);
          throw new Error(
            `Empty response from ${this.provider} (${this.model}); ` +
            `stop_reason=${diag.stopReason}, output_tokens=${diag.outputTokens}`
          );
        }

        const plan = this._parseResponse(text);

        if (isReversal) {
          this._validateReversalPlanShape(plan, context.consultContext || 'plan');
          plan._schema = 'reversal';
          plan._consultContext = context.consultContext || 'plan';
        } else if (context.phase === 'INITIAL') {
          // Phase 1 → flat OPEN_HEDGE schema (no _schema flag).
          this._validatePhase1Plan(plan);
        } else {
          // Phase 2 → paired primary+shadow schema (_schema = 'paired').
          this._validatePairedPlanStructure(plan);
          plan._schema = 'paired';
        }

        // One-shot diagnostic — log the raw usage shape on the first
        // successful consult per AiPlanner instance. Tells us exactly
        // which cache-hit field name the provider populates (esp. on
        // DeepSeek's Anthropic-compatible endpoint where it's
        // undocumented whether they map to Anthropic naming or keep
        // DeepSeek-native naming). Fires once per cycle.
        if (!this._loggedUsageShape) {
          this._loggedUsageShape = true;
          console.log(
            `[ai-planner] usage shape (${this.provider}/${this.model}): ` +
            JSON.stringify(response.usage ?? null)
          );
        }

        // Attach token usage for cost tracking. Defensive read: tries
        // Anthropic-style `cache_read_input_tokens` first (works for
        // both Anthropic Claude and likely DeepSeek's Anthropic
        // endpoint), then falls back to DeepSeek-native
        // `prompt_cache_hit_tokens`. Cost calc credits whichever
        // wins, so the discount flows through regardless of which
        // naming convention is used.
        const usage = response.usage || {};
        plan._usage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheRead:
            usage.cache_read_input_tokens
            ?? usage.prompt_cache_hit_tokens
            ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
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

  /**
   * Validate reversal plan shape per consult context.
   * Risk-guard layer does the structural/business validation; this is a
   * cheap front-line shape check so malformed JSON fails fast.
   */
  _validateReversalPlanShape(plan, consultContext) {
    if (!plan || typeof plan !== 'object') throw new Error('Reversal plan: not an object');
    if (typeof plan.decision !== 'string') throw new Error('Reversal plan: missing decision');
    const decision = plan.decision;
    if (consultContext === 'plan') {
      if (decision !== 'PLAN') {
        throw new Error(`Reversal plan (plan context): expected decision=PLAN, got ${decision}`);
      }
      if (typeof plan.bullLevel !== 'number' || typeof plan.bearLevel !== 'number') {
        throw new Error('Reversal plan (plan context): bullLevel/bearLevel must be numbers');
      }
    } else if (consultContext === 'heartbeat') {
      if (!['CONTINUE', 'ADJUST', 'HARVEST'].includes(decision)) {
        throw new Error(`Reversal plan (heartbeat): expected CONTINUE|ADJUST|HARVEST, got ${decision}`);
      }
      if (decision === 'ADJUST') {
        if (typeof plan.bullLevel !== 'number' || typeof plan.bearLevel !== 'number') {
          throw new Error('Reversal plan (ADJUST): bullLevel/bearLevel required');
        }
      }
    } else if (consultContext === 'veto') {
      if (!['CONTINUE', 'REDUCE'].includes(decision)) {
        throw new Error(`Reversal plan (veto): expected CONTINUE|REDUCE, got ${decision}`);
      }
      if (decision === 'REDUCE' && typeof plan.newSize !== 'number') {
        throw new Error('Reversal plan (REDUCE): newSize required');
      }
    } else {
      throw new Error(`Reversal plan: unknown consult context ${consultContext}`);
    }
  }

  /**
   * Build the user message for reversal AI consults.
   * Three consult contexts are supported: plan, heartbeat, veto.
   * The context object is built by AiMarketContext.buildReversalContext.
   */
  _buildReversalUserMessage(context) {
    const parts = [];
    const ctx = context.consultContext || 'plan';

    parts.push(`CONTEXT: ${ctx.toUpperCase()}`);
    parts.push('');
    parts.push(`## SYMBOL & PRICING`);
    parts.push(`Symbol: ${context.symbol}`);
    parts.push(`Current Price: ${context.currentPrice}`);
    parts.push(`Wallet Balance: ${context.walletBalance} USDT`);
    parts.push(`Initial Capital (cycle start): ${context.initialCapital} USDT`);
    parts.push(`Configured Initial Position Size: ${context.currentInitialSize} USDT`);
    parts.push(`Max Position Size: ${context.maxPositionSizeUSDT} USDT`);
    parts.push(`Min Notional Floor: ${context.minNotional} USDT`);

    parts.push('');
    parts.push(`## CYCLE STATE`);
    parts.push(`Active Side: ${context.currentSide || 'NONE (flat / awaiting touch)'}`);
    if (context.currentPosition) {
      parts.push(`Position Entry: ${context.currentPosition.avgEntry}`);
      parts.push(`Position Quantity: ${context.currentPosition.quantity}`);
      parts.push(`Position Notional: ${context.currentPosition.notional} USDT`);
      parts.push(`Unrealized PnL: ${context.currentPosition.unrealizedPnl} USDT`);
    }
    parts.push(`Current bullLevel: ${context.bullLevel != null ? context.bullLevel : 'unset'}`);
    parts.push(`Current bearLevel: ${context.bearLevel != null ? context.bearLevel : 'unset'}`);
    parts.push(`Current Final TP price: ${context.finalTpPrice != null ? context.finalTpPrice : 'unset'}`);
    parts.push(`Reversal Count: ${context.reversalCount}`);
    parts.push(`Harvest Count: ${context.harvestCount}`);
    parts.push(`Cycle Accumulated Loss: ${context.cycleAccumulatedLoss} USDT`);
    parts.push(`  (= -Σ realized PnL + Σ trading fees + Σ funding fees)`);
    parts.push(`Σ Realized PnL: ${context.accumulatedRealizedPnL} USDT`);
    parts.push(`Σ Trading Fees: ${context.accumulatedTradingFees} USDT`);
    parts.push(`Σ Funding Fees: ${context.accumulatedFundingFees} USDT`);

    // Volatility — used for level spacing constraint.
    if (context.volatility) {
      parts.push('');
      parts.push(`## VOLATILITY`);
      parts.push(`ATR(14, 15m): ${context.volatility.atr} (${context.volatility.atrPercent}%) — ${context.volatility.interpretation}`);
      const atr = context.volatility.atr || 0;
      const minSpacing = atr * (context.minLevelSpacingATR || 1.5);
      parts.push(`Required level spacing: bullLevel − bearLevel ≥ ${minSpacing.toFixed(6)} (= 1.5 × ATR)`);
    }

    // Volume Profile — primary signal for level placement.
    parts.push('');
    parts.push(`## VOLUME PROFILE (24h, 5m candles × 288 bars)`);
    if (context.volumeProfile24h) {
      const vp = context.volumeProfile24h;
      parts.push(`POC: ${vp.poc.price.toFixed(6)} (volume ${vp.poc.volume.toFixed(2)})`);
      parts.push(`Value Area: VAL=${vp.val.toFixed(6)} → VAH=${vp.vah.toFixed(6)} (70% of volume)`);
      parts.push(`Price Range: ${vp.priceMin.toFixed(6)} → ${vp.priceMax.toFixed(6)}`);
      parts.push(`HVN ranges (magnetic / reversal-prone, top 20% by volume):`);
      for (const h of vp.hvns.slice(0, 5)) {
        parts.push(`  ${h.priceLow.toFixed(6)} → ${h.priceHigh.toFixed(6)} (vol ${h.volume.toFixed(2)})`);
      }
      parts.push(`LVN ranges (voids / breakout-friendly, bottom 20% by volume):`);
      for (const l of vp.lvns.slice(0, 5)) {
        parts.push(`  ${l.priceLow.toFixed(6)} → ${l.priceHigh.toFixed(6)} (vol ${l.volume.toFixed(2)})`);
      }
    } else {
      parts.push(`(unavailable)`);
    }

    parts.push('');
    parts.push(`## VOLUME PROFILE (7d, 1h candles × 168 bars)`);
    if (context.volumeProfile7d) {
      const vp = context.volumeProfile7d;
      parts.push(`POC: ${vp.poc.price.toFixed(6)}`);
      parts.push(`Value Area: VAL=${vp.val.toFixed(6)} → VAH=${vp.vah.toFixed(6)}`);
      parts.push(`HVN ranges (top 5):`);
      for (const h of vp.hvns.slice(0, 5)) {
        parts.push(`  ${h.priceLow.toFixed(6)} → ${h.priceHigh.toFixed(6)}`);
      }
      parts.push(`LVN ranges (top 5):`);
      for (const l of vp.lvns.slice(0, 5)) {
        parts.push(`  ${l.priceLow.toFixed(6)} → ${l.priceHigh.toFixed(6)}`);
      }
    } else {
      parts.push(`(unavailable)`);
    }

    // CVD — momentum confirmation.
    parts.push('');
    parts.push(`## CVD (Cumulative Volume Delta)`);
    if (context.cvd) {
      parts.push(`CVD over last ${context.cvd.lookbackMinutes}min: ${context.cvd.cvd.toFixed(2)}`);
      parts.push(`Trend: ${context.cvd.cvdTrend} (1st-half Δ ${context.cvd.firstHalfDelta.toFixed(2)} → 2nd-half Δ ${context.cvd.secondHalfDelta.toFixed(2)})`);
    } else {
      parts.push(`(unavailable)`);
    }

    // Orderbook depth — instantaneous flow.
    parts.push('');
    parts.push(`## ORDERBOOK DEPTH (top-${context.orderbookDepth?.levels || 100} each side)`);
    if (context.orderbookDepth) {
      const d = context.orderbookDepth;
      parts.push(`Bid vs Ask volume: ${d.bidVolume.toFixed(2)} vs ${d.askVolume.toFixed(2)} (imbalance ${(d.imbalance * 100).toFixed(2)}%)`);
      parts.push(`Top-10 levels: bid ${d.top10Bids.toFixed(2)} vs ask ${d.top10Asks.toFixed(2)} (imbalance ${(d.top10Imbalance * 100).toFixed(2)}%)`);
    } else {
      parts.push(`(unavailable)`);
    }

    // S/R cascade — backup signals.
    if (context.supportResistance) {
      parts.push('');
      parts.push(`## SUPPORT & RESISTANCE (cascade)`);
      const sr = context.supportResistance;
      if (sr.supports?.length) {
        parts.push(`Supports:`);
        for (const s of sr.supports) parts.push(`  ${s.price.toFixed(6)} (${s.source}, rank ${s.rank})`);
      }
      if (sr.resistances?.length) {
        parts.push(`Resistances:`);
        for (const r of sr.resistances) parts.push(`  ${r.price.toFixed(6)} (${r.source}, rank ${r.rank})`);
      }
    }

    // Funding / OI / liquidations — regime indicators.
    if (context.fundingRate) {
      parts.push('');
      parts.push(`## FUNDING`);
      parts.push(`Rate: ${context.fundingRate.rate} (next ${context.fundingRate.nextFundingTime})`);
      if (context.fundingRate.estimatedHourlyCost != null) {
        parts.push(`Est hourly cost (current position): ${context.fundingRate.estimatedHourlyCost.toFixed(4)} USDT`);
      }
    }

    if (context.oiChange?.isAbnormal) {
      parts.push('');
      parts.push(`## OI CHANGE (abnormal)`);
      parts.push(`oiChange5m=${context.oiChange.oiChange5m?.toFixed(2)}% oiChange1h=${context.oiChange.oiChange1h?.toFixed(2)}% trend=${context.oiChange.oiTrend}`);
    }

    if (context.liquidations?.isAbnormal) {
      parts.push('');
      parts.push(`## LIQUIDATIONS (abnormal)`);
      const l = context.liquidations;
      parts.push(`Long liq vol 15m: ${l.longLiqVolume15m?.toFixed(2)}  Short liq vol 15m: ${l.shortLiqVolume15m?.toFixed(2)}  Cascade: ${l.cascadeActive}`);
    }

    // Margin info — important for size discussions.
    if (context.marginInfo) {
      parts.push('');
      parts.push(`## MARGIN`);
      parts.push(`Available: ${context.marginInfo.availableBalance?.toFixed(2)} USDT (margin used ${context.marginInfo.marginUsagePercent?.toFixed(2)}%)`);
      if (context.marginInfo.liquidationDistance != null) {
        parts.push(`Account liquidation distance: ${context.marginInfo.liquidationDistance.toFixed(2)}%`);
      }
    }

    // Context-specific footer.
    parts.push('');
    parts.push(`## CONSULT REQUEST`);
    if (ctx === 'plan') {
      parts.push(`Emit a fresh PLAN with bullLevel + bearLevel. Hard constraints:`);
      parts.push(`  - bullLevel > current_price (${context.currentPrice})`);
      parts.push(`  - bearLevel < current_price (${context.currentPrice})`);
      parts.push(`  - bullLevel − bearLevel ≥ 1.5 × ATR`);
      parts.push(`  - Levels must straddle the POC and prefer LVN-facing edges of the HVN.`);
    } else if (ctx === 'heartbeat') {
      parts.push(`Decide: CONTINUE / ADJUST / HARVEST.`);
      parts.push(`HARVEST eligible: ${context.harvestEligible ? 'YES (loss ≥ 30% of initial capital AND profitable position)' : 'NO (gate not met — do not return HARVEST)'}`);
      parts.push(`Use ADJUST only for small slides (≤ 1×ATR) driven by: POC drift > 0.5%, level invalidation pattern, CVD divergence at level, or regime shift (ATR > 2× recent norm).`);
    } else if (ctx === 'veto') {
      parts.push(`Bot proposes New size: ${context.proposedNewSize} USDT (already passed deterministic margin-headroom projection).`);
      parts.push(`Decide: CONTINUE (approve) or REDUCE (provide smaller newSize ≥ ${(context.minNotional * 2).toFixed(2)} USDT).`);
    }

    parts.push('');
    parts.push(`Return JSON only. No markdown fences, no commentary outside the JSON object.`);

    return parts.join('\n');
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
    if (context.phase === 'HEDGE') {
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

    // Paired-trigger Hedge Phase ratio state. Only emitted in Phase 2 (Phase 1
    // doesn't use this). Provides the AI with the pre-computed clamp envelope
    // so it can size shadows in band first time (minimizing executor clamp warnings).
    if (context.phase === 'HEDGE' && context.ratioBand) {
      const longQty = context.longPosition?.quantity || 0;
      const shortQty = context.shortPosition?.quantity || 0;
      const ratio = (longQty > 0 && shortQty > 0) ? (longQty / shortQty) : null;
      const maxX = shortQty > 0 ? (shortQty * context.ratioBand.upper - longQty) : null;  // Shadow_LONG headroom
      const maxY = longQty > 0 ? (longQty / context.ratioBand.lower - shortQty) : null;   // Shadow_SHORT headroom

      parts.push(`\n## HEDGE-RATIO STATE (paired-trigger Hedge Phase)`);
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
    // with per-side cascade fallback to 1h, and a synthetic ±5x ATR
    // last-resort. Every emitted level is data-layer-guaranteed to be
    // ≥3x ATR from current price.
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
      parts.push(`Source tags: '15m' = native swing levels (~3-day lookback). '1h_fallback' = swing levels promoted from 1h when the 15m side had no qualifying level (structurally stronger but typically further from price). 'atr_5x_fallback' = synthetic level at currentPrice ± 5x ATR, emitted only when neither 15m nor 1h produced a level ≥3x ATR away.`);
      parts.push(`Both heavier and lighter leg anchor to these levels — pick the closest qualifying level on the relevant side as the trigger.`);
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

    parts.push(`\nGenerate your ${context.phase === 'INITIAL' ? 'INITIAL OPEN_HEDGE' : 'HEDGE'} plan now. Respond with ONLY the JSON object.`);

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
   *       shadow:  { type: 'ADD_LONG'|'SKIP',              triggerPrice, qty, reason },
   *     },
   *     actionBelow: {
   *       primary: { type: 'ADD_LONG'|'CUT_LONG'|'HOLD', triggerPrice, qty, reason },
   *       shadow:  { type: 'ADD_SHORT'|'SKIP',           triggerPrice, qty, reason },
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
      // ADD shadows need triggerPrice + qty. SKIP carries nothing. HOLD is
      // not allowed on shadows — primary-only (it would be a no-op for
      // execution and indistinguishable from SKIP).
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
}

export { AiPlanner };
export default AiPlanner;
