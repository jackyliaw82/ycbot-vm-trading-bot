import Anthropic from '@anthropic-ai/sdk';
import { REVERSAL_SYSTEM_PROMPT } from './ai-reversal-prompt.js';

// DeepSeek exposes an Anthropic-compatible endpoint at /anthropic. Pointing
// the @anthropic-ai/sdk at this baseURL lets us reuse the same
// `messages.create(...)` signature for DeepSeek V4 models with no other code
// changes. Auth is via the same `x-api-key` header the SDK already sends.
// Source: https://api-docs.deepseek.com/guides/anthropic_api
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

class AiPlanner {
  constructor(apiKey, model = 'deepseek-v4-flash') {
    // DeepSeek is the sole AI provider — always point the @anthropic-ai/sdk
    // client at DeepSeek's Anthropic-compatible endpoint.
    this.client = new Anthropic({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
    });
    this.model = model;
    this.provider = 'deepseek';
    this.maxRetries = 3;
    // One-shot diagnostic flag — first successful consult logs the raw
    // response.usage shape so we can verify which cache-hit fields the
    // provider populates (esp. DeepSeek's Anthropic-compatible endpoint:
    // Anthropic-style `cache_read_input_tokens` vs DeepSeek-native
    // `prompt_cache_hit_tokens`). Stays false after first log to keep
    // production logs clean.
    this._loggedUsageShape = false;
  }

  async generatePlan(context, strategyType = 'reversal') {
    // Hedge was removed — reversal is the only plan producer now. The
    // strategyType param is kept for call-site compatibility (callers pass
    // 'reversal'); it no longer selects between prompts.
    void strategyType;
    const systemPrompt = REVERSAL_SYSTEM_PROMPT;
    const userMessage = this._buildReversalUserMessage(context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          // 8192 cap — was 2048, but long analyses (multi-paragraph reasoning)
          // can run long, and truncated responses produce "Unexpected end of
          // JSON input" parse failures that send the strategy into the
          // stale-counter retry loop. Output is billed per emitted token, not
          // per cap, so the higher ceiling has no cost impact in normal operation.
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

        this._validateReversalPlanShape(plan, context.consultContext || 'plan');
        plan._schema = 'reversal';
        plan._consultContext = context.consultContext || 'plan';

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
    } else if (consultContext === 'harvest_price') {
      if (decision !== 'HARVEST_PRICE') {
        throw new Error(`Reversal plan (harvest_price): expected decision=HARVEST_PRICE, got ${decision}`);
      }
      if (typeof plan.harvestPrice !== 'number' || !Number.isFinite(plan.harvestPrice)) {
        throw new Error('Reversal plan (harvest_price): harvestPrice must be a finite number');
      }
    } else if (consultContext === 'veto') {
      if (!['CONTINUE', 'REDUCE'].includes(decision)) {
        throw new Error(`Reversal plan (veto): expected CONTINUE|REDUCE, got ${decision}`);
      }
      if (decision === 'REDUCE' && typeof plan.newSize !== 'number') {
        throw new Error('Reversal plan (REDUCE): newSize required');
      }
    } else if (consultContext === 'user_question') {
      if (decision !== 'ADVISE') {
        throw new Error(`Reversal plan (user_question): expected decision=ADVISE, got ${decision}`);
      }
      if (typeof plan.rationale !== 'string' || !plan.rationale.trim()) {
        throw new Error('Reversal plan (user_question): rationale required');
      }
      const bullOk = plan.proposedBullLevel == null
        || (typeof plan.proposedBullLevel === 'number' && Number.isFinite(plan.proposedBullLevel));
      const bearOk = plan.proposedBearLevel == null
        || (typeof plan.proposedBearLevel === 'number' && Number.isFinite(plan.proposedBearLevel));
      if (!bullOk || !bearOk) {
        throw new Error('Reversal plan (user_question): proposedBullLevel/proposedBearLevel must be null or finite numbers');
      }
    } else if (consultContext === 'reversal_tightening') {
      if (decision !== 'REVERSAL_TIGHTENING') {
        throw new Error(`Reversal plan (reversal_tightening): expected decision=REVERSAL_TIGHTENING, got ${decision}`);
      }
      if (typeof plan.level !== 'number' || !Number.isFinite(plan.level)) {
        throw new Error('Reversal plan (reversal_tightening): level must be a finite number');
      }
    } else {
      throw new Error(`Reversal plan: unknown consult context ${consultContext}`);
    }
  }

  /**
   * Build the user message for reversal AI consults.
   * Five consult contexts are supported: plan, harvest_price, veto,
   * user_question, reversal_tightening.
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
    parts.push(`  (= max(0, −(Σ realized PnL + Σ trading fees + Σ funding fees))  — each summand signed; fees always ≤ 0)`);
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
      parts.push(`  - These levels are PERMANENT for the cycle — there is no periodic AI rethink. Pick robust levels that survive multi-hour holds, not opportunistic short-term ones.`);
    } else if (ctx === 'harvest_price') {
      const pos = context.currentPosition;
      const entry = pos?.avgEntry;
      const side = context.currentSide;
      parts.push(`Emit a HARVEST_PRICE — a single price the bot will watch on every tick. When current price reaches this value, the bot closes the position to flat (locking in a profit on the current leg) and re-PLANs fresh bullLevel/bearLevel for a new cycle phase.`);
      parts.push(`Active position: ${side} entry=${entry} qty=${pos?.quantity} notional=${pos?.notional} unrealizedPnl=${pos?.unrealizedPnl}`);
      parts.push(`Hard constraints:`);
      if (side === 'LONG') {
        parts.push(`  - harvestPrice > entry (${entry}) — must be strictly above entry for a profitable close.`);
      } else if (side === 'SHORT') {
        parts.push(`  - harvestPrice < entry (${entry}) — must be strictly below entry for a profitable close.`);
      }
      parts.push(`  - Pick the price most likely to be touched next while still ensuring profitable close. Use volume profile + CVD + orderbook depth — look for high-probability targets near liquid HVNs or value-area edges.`);
      parts.push(`  - If you believe the most likely target is BEYOND finalTpPrice (above for LONG, below for SHORT), set harvestPrice to that anyway — the bot will hit Final TP first and the cycle will complete naturally. This is acceptable.`);
      parts.push(`  - This is a ONE-SHOT consult per position phase. If the position is reversed (price hits bullLevel/bearLevel) before harvestPrice is touched, harvestPrice is discarded and you will be re-consulted for the new side/entry.`);
    } else if (ctx === 'veto') {
      parts.push(`Bot proposes New size: ${context.proposedNewSize} USDT (already passed deterministic margin-headroom projection).`);
      parts.push(`Decide: CONTINUE (approve) or REDUCE (provide smaller newSize ≥ ${(context.minNotional * 2).toFixed(2)} USDT).`);
    } else if (ctx === 'user_question') {
      parts.push(`The user has typed a free-form question into the running strategy's "Ask AI" panel. Read the question, ground your answer in the market context above, and respond with the ADVISE schema.`);
      parts.push(`If the question references a possible level change (e.g., "should I move bear to X?", "is bull too tight?"), put your proposed numeric values in proposedBullLevel/proposedBearLevel; otherwise leave them null and answer in rationale only.`);
      parts.push(`Your output is ADVISORY — the bot will NOT apply level changes automatically. The user reviews your rationale and explicitly clicks Approve to apply.`);
      parts.push('');
      parts.push(`## USER QUESTION`);
      parts.push(context.userQuestion || '(no question text provided)');
    } else if (ctx === 'reversal_tightening') {
      const side = context.currentSide;
      const entryLevel = side === 'LONG' ? context.bullLevel : context.bearLevel;
      const oppName = side === 'LONG' ? 'bearLevel' : 'bullLevel';
      const dirWord = side === 'LONG' ? 'below' : 'above';
      const b = context.tighteningBounds || {};
      const low = b.low != null ? b.low.toFixed(6) : '?';
      const high = b.high != null ? b.high.toFixed(6) : '?';
      parts.push(`A ${side} position was just opened at the entry level ${entryLevel}. The opposite reversal level (${oppName}) was set to a temporary 1% safeguard. REFINE it: emit a single REVERSAL_TIGHTENING with "level" — the best ${oppName} within the tight band.`);
      parts.push(`Hard constraint: level MUST be within [${low}, ${high}] (i.e. 0.5%–1% ${dirWord} the ${side === 'LONG' ? 'bull' : 'bear'} entry). Out-of-band is rejected and the 1% safeguard is kept.`);
      parts.push(`Objective — place the level to MINIMIZE false / whipsaw reversals: just ${dirWord === 'below' ? 'below' : 'above'} real ${side === 'LONG' ? 'support' : 'resistance'} so noise bounces but a genuine break flips the position. Data priority for this sub-1% band:`);
      parts.push(`  1. Orderbook ${side === 'LONG' ? 'bid' : 'ask'} walls in-band (primary) — sit just beyond the nearest significant cluster.`);
      parts.push(`  2. Recent 5m swing ${side === 'LONG' ? 'lows' : 'highs'} — just past the latest minor swing.`);
      parts.push(`  3. CVD direction — if the trend favors the current ${side} position, place LOOSER (toward the 1% edge) to avoid early flips; if adverse, place TIGHTER (toward 0.5%) to flip fast and ride the move.`);
      parts.push(`  4. ATR noise floor — keep the level outside ~1 ATR of normal noise.`);
      parts.push(`  5. Volume profile is secondary here (24h/7d bins are too coarse to resolve sub-1% structure).`);
      parts.push(`If no clean structure sits within the band, default toward the looser (1%) edge with low confidence.`);
    }

    parts.push('');
    parts.push(`Return JSON only. No markdown fences, no commentary outside the JSON object.`);

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

}

export { AiPlanner };
export default AiPlanner;
