// AI usage pricing. Rates are per 1M tokens in USD, recovered verbatim from the
// deleted ai-reversal-strategy.js (git show 06e4199^:ai-reversal-strategy.js,
// MODEL_PRICING near the top) so restored cost figures stay comparable with the
// historical ones already recorded against past cycles.
//
// DeepSeek's Anthropic-compatible endpoint does NOT honour cache_control, so a
// cache MISS is billed at the full input rate — cacheWrite5m therefore mirrors
// `input` rather than carrying Anthropic's 1.25x write premium. cacheRead is
// DeepSeek's automatic server-side prefix-cache hit rate.
export const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: 3.0,   output: 15.0, cacheWrite5m: 3.75,   cacheRead: 0.30 },
  'claude-opus-4-7':   { input: 15.0,  output: 75.0, cacheWrite5m: 18.75,  cacheRead: 1.50 },
  'deepseek-v4-flash': { input: 0.14,  output: 0.28, cacheWrite5m: 0.14,   cacheRead: 0.0028 },
  'deepseek-v4-pro':   { input: 0.435, output: 0.87, cacheWrite5m: 0.435,  cacheRead: 0.003625 },
};

const FALLBACK_MODEL = 'deepseek-v4-flash';
const MILLION = 1_000_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Cost in USD for one call's token usage. Unknown models fall back to the
 * default rate card rather than returning NaN — a NaN here would silently
 * poison the Final TP, which adds AI cost to the amount a cycle must recover.
 */
export function usageCostUsd(usage, model) {
  if (!usage || typeof usage !== 'object') return 0;
  const p = MODEL_PRICING[model] || MODEL_PRICING[FALLBACK_MODEL];
  return (
    num(usage.inputTokens) * p.input +
    num(usage.outputTokens) * p.output +
    num(usage.cacheRead) * p.cacheRead +
    num(usage.cacheCreation) * p.cacheWrite5m
  ) / MILLION;
}

/** Running total across every consult in a cycle. */
export class AiUsageAccumulator {
  constructor() {
    this._t = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
  }
  add(usage) {
    if (!usage || typeof usage !== 'object') return;
    this._t.inputTokens += num(usage.inputTokens);
    this._t.outputTokens += num(usage.outputTokens);
    this._t.cacheRead += num(usage.cacheRead);
    this._t.cacheCreation += num(usage.cacheCreation);
  }
  get totals() { return { ...this._t }; }
  costUsd(model) { return usageCostUsd(this._t, model); }
}
