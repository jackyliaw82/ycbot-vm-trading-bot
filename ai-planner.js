import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You are an AI trading strategist for a cryptocurrency hedge trading bot on Binance Futures.

## YOUR ROLE
You manage two simultaneous positions on the same instrument: LONG and SHORT (hedge mode).
Your goal is to build both sides toward equal size, locking in the hedge gap as profit.

## STRATEGY RULES
1. LOCKED PROFIT: When both LONG and SHORT are equal quantity, profit is locked:
   lockedProfit = (shortAvgEntry - longAvgEntry) × quantity
   This profit is guaranteed regardless of where price goes.

2. BUILDING POSITIONS: Grow each side slowly with well-timed entries:
   - ADD_LONG: Buy to increase LONG position (on dips/pullbacks)
   - ADD_SHORT: Sell to increase SHORT position (on rallies/resistance)
   - Goal: Both sides converge to equal quantity with maximum gap

3. CUTTING & LIGHTENING: When one side is in heavy loss:
   - CUT_LONG: Sell partial/full LONG to realize loss and free margin
   - CUT_SHORT: Buy partial/full SHORT to realize loss and free margin
   - Then re-enter at better price to shift average closer to current price

4. TAKING PROFIT: When one side has sufficient profit:
   - TP_LONG: Sell partial/full LONG to take profit
   - TP_SHORT: Buy partial/full SHORT to take profit
   - Usually paired with a cut on the other side

5. CLOSE_HEDGE: Close both sides when locked profit meets target

## SCENARIO PLANNING
Generate 3 plans for different market scenarios:
- Plan A: Most likely scenario
- Plan B: Alternative scenario
- Plan C: Adverse/protective scenario

Each plan should consider:
- Current price trend and momentum
- Support/resistance levels from recent price action
- Current position state (sizes, averages, unrealized PnL)
- Risk exposure and margin usage

## VOLATILITY-AWARE TRADING
Use ATR (Average True Range) to calibrate your decisions:
- In HIGH/EXTREME volatility: widen DCA entry spacing, use wider trigger distances, prefer smaller position sizes
- In LOW volatility: tighten DCA spacing, use closer trigger distances, can use standard position sizes
- ATR percentage guides entry gap: entries should be at least 1x ATR% apart (minimum 0.3%)

## BREAKEVEN-AWARE TARGETS
The "Effective Target" accounts for accumulated losses and fees:
  effectiveTarget = desiredProfit + |realizedLosses| + tradingFees
Your plans should work toward building locked profit to meet the effective target, not just the desired profit.

## RISK CONSTRAINTS
- Never suggest total position size exceeding maxPositionSize
- DCA entries should be at least 0.3% apart (or 1x ATR%, whichever is larger)
- Always include a protective scenario (Plan C)
- When suggesting cuts, preserve at least the minimum tradeable quantity

## OUTPUT FORMAT
You MUST respond with ONLY a valid JSON object, no other text. The JSON must follow this exact schema:
{
  "analysis": "Brief market context summary (2-3 sentences)",
  "planA": {
    "scenario": "Description of this scenario",
    "probability": "high" | "medium" | "low",
    "actions": [
      {
        "type": "ADD_LONG" | "ADD_SHORT" | "CUT_LONG" | "CUT_SHORT" | "TP_LONG" | "TP_SHORT" | "CLOSE_HEDGE",
        "triggerPrice": <number>,
        "quantity": <number in base asset>,
        "sizeUSDT": <number in USDT>,
        "reason": "Brief explanation"
      }
    ]
  },
  "planB": { ... same structure ... },
  "planC": { ... same structure ... },
  "recommendedPlan": "A" | "B" | "C",
  "nextReplanTrigger": {
    "type": "PRICE",
    "value": <number>,
    "direction": "ABOVE" | "BELOW"
  }
}`;

class AiPlanner {
  constructor(apiKey, model = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxRetries = 3;
  }

  /**
   * Generate a trading plan from market context.
   * @param {object} context — market context from AiMarketContext.buildContext()
   * @returns {object} — structured plan with planA/B/C, recommendedPlan, nextReplanTrigger
   */
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
        this._validatePlanStructure(plan);
        return plan;

      } catch (error) {
        console.error(`AI plan generation attempt ${attempt} failed: ${error.message}`);
        if (attempt === this.maxRetries) {
          throw new Error(`Failed to generate AI plan after ${this.maxRetries} attempts: ${error.message}`);
        }
        // Wait before retry with exponential backoff
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  _buildUserMessage(context) {
    const parts = [];

    parts.push(`## CURRENT STATE`);
    parts.push(`Symbol: ${context.symbol}`);
    parts.push(`Current Price: ${context.currentPrice}`);
    parts.push(`Wallet Balance: ${context.walletBalance} USDT`);
    parts.push(`Base Position Size: ${context.positionSizeUSDT} USDT`);
    parts.push(`Max Total Position: ${context.maxPositionSizeUSDT} USDT`);

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

    parts.push(`\n## HEDGE METRICS`);
    parts.push(`Hedge Gap: ${context.hedgeGap}`);
    parts.push(`Locked Profit: ${context.lockedProfit} USDT`);
    if (context.desiredProfitUSDT) {
      parts.push(`Desired Profit: ${context.desiredProfitUSDT} USDT`);
      parts.push(`Breakeven (losses + fees): ${context.breakeven || 0} USDT`);
      parts.push(`Effective Target (desired + breakeven): ${context.effectiveTarget || context.desiredProfitUSDT} USDT`);
      const progress = context.effectiveTarget ? ((context.lockedProfit / context.effectiveTarget) * 100).toFixed(1) : 0;
      parts.push(`Progress to Target: ${progress}%`);
    }

    parts.push(`\n## ACCUMULATED P&L`);
    parts.push(`Realized PnL: ${context.accumulatedRealizedPnL} USDT`);
    parts.push(`Trading Fees: ${context.accumulatedTradingFees} USDT`);

    if (context.volatility && context.volatility.atr > 0) {
      parts.push(`\n## VOLATILITY (15m ATR, 14-period)`);
      parts.push(`ATR: ${context.volatility.atr.toFixed(2)} (${context.volatility.atrPercent.toFixed(3)}%)`);
      parts.push(`Volatility Level: ${context.volatility.interpretation.toUpperCase()}`);
    }

    if (context.recentCandles && context.recentCandles.length > 0) {
      parts.push(`\n## RECENT PRICE ACTION (5m candles, last ${context.recentCandles.length})`);
      // Summarize key levels instead of listing all candles
      const highs = context.recentCandles.map(c => c.high);
      const lows = context.recentCandles.map(c => c.low);
      const recentHigh = Math.max(...highs);
      const recentLow = Math.min(...lows);
      const firstClose = context.recentCandles[0].close;
      const lastClose = context.recentCandles[context.recentCandles.length - 1].close;
      const priceChange = ((lastClose - firstClose) / firstClose * 100).toFixed(2);

      parts.push(`Range: ${recentLow} - ${recentHigh}`);
      parts.push(`Direction: ${priceChange > 0 ? 'UP' : 'DOWN'} ${priceChange}%`);
      parts.push(`Recent closes (last 10): ${context.recentCandles.slice(-10).map(c => c.close).join(', ')}`);
    }

    if (context.previousPlan) {
      parts.push(`\n## PREVIOUS PLAN`);
      parts.push(`Analysis: ${context.previousPlan.analysis || 'N/A'}`);
      parts.push(`Recommended: Plan ${context.previousPlan.recommendedPlan || 'N/A'}`);
    }

    if (context.planHistory && context.planHistory.length > 0) {
      parts.push(`\n## RECENT PLAN OUTCOMES (last ${context.planHistory.length})`);
      for (const hist of context.planHistory) {
        if (hist.outcome) {
          parts.push(`- ${hist.outcome.action?.type || 'N/A'} at ${hist.outcome.price || 'N/A'} (${hist.outcome.action?.reason || 'N/A'})`);
        }
      }
    }

    parts.push(`\nGenerate your trading plan now. Respond with ONLY the JSON object.`);

    return parts.join('\n');
  }

  _parseResponse(text) {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // Try to find JSON object in the text
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error(`Failed to parse AI response as JSON: ${e.message}`);
    }
  }

  _validatePlanStructure(plan) {
    if (!plan.analysis) throw new Error('Plan missing "analysis" field');
    if (!plan.planA) throw new Error('Plan missing "planA"');

    const validatePlanActions = (planObj, label) => {
      if (!planObj.scenario) throw new Error(`${label} missing "scenario"`);
      if (!planObj.actions || !Array.isArray(planObj.actions)) throw new Error(`${label} missing "actions" array`);

      for (const action of planObj.actions) {
        if (!action.type) throw new Error(`${label} action missing "type"`);
        if (typeof action.triggerPrice !== 'number') throw new Error(`${label} action missing numeric "triggerPrice"`);

        const validTypes = ['ADD_LONG', 'ADD_SHORT', 'CUT_LONG', 'CUT_SHORT', 'TP_LONG', 'TP_SHORT', 'CLOSE_HEDGE'];
        if (!validTypes.includes(action.type)) {
          throw new Error(`${label} action has invalid type: ${action.type}`);
        }
      }
    };

    validatePlanActions(plan.planA, 'planA');
    if (plan.planB) validatePlanActions(plan.planB, 'planB');
    if (plan.planC) validatePlanActions(plan.planC, 'planC');
  }
}

export { AiPlanner };
export default AiPlanner;
