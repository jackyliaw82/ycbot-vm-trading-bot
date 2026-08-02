import Anthropic from '@anthropic-ai/sdk';

// DeepSeek exposes an Anthropic-compatible endpoint at /anthropic. Pointing the
// @anthropic-ai/sdk at this baseURL lets us reuse messages.create(...) unchanged;
// auth rides on the same x-api-key header the SDK already sends.
// Source: https://api-docs.deepseek.com/guides/anthropic_api
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;
// 8192, not 2048: long analyses were being truncated mid-JSON, and a truncated
// body fails to parse — which used to send the caller into a retry loop for a
// reason that looked like a provider fault. Output bills per emitted token, not
// per cap, so the headroom is free.
const MAX_TOKENS = 8192;

export class AiPlanner {
  /**
   * `client` and `sleep` are injectable so tests never touch the network or a
   * real timer. Production passes neither.
   */
  constructor(apiKey, model = 'deepseek-v4-flash', { client, backoffMs, sleep } = {}) {
    this.client = client || new Anthropic({ apiKey, baseURL: DEEPSEEK_BASE_URL });
    this.model = model;
    this.provider = 'deepseek';
    this.maxRetries = MAX_RETRIES;
    this._backoffMs = typeof backoffMs === 'number' ? backoffMs : DEFAULT_BACKOFF_MS;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * One consult. Returns { json, usage, raw }.
   *
   * A reply that will not parse is treated as a FAILED ATTEMPT, not a success —
   * the model occasionally answers in prose, and returning that as a plan would
   * push an unvalidated object at the caller.
   */
  async consult(systemPrompt, userMessage) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const text = (response?.content || [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim();
        const json = parseJsonBody(text);
        return { json, usage: normaliseUsage(response?.usage), raw: text };
      } catch (error) {
        lastError = error;
        console.error(`[ai-planner] attempt ${attempt}/${this.maxRetries} failed: ${error.message}`);
        if (attempt < this.maxRetries) {
          await this._sleep(this._backoffMs * Math.pow(2, attempt - 1));
        }
      }
    }
    throw new Error(`AI consult failed after ${this.maxRetries} attempts: ${lastError?.message}`);
  }
}

/**
 * The prompt says "JSON only, no fences" and the model mostly complies. Mostly
 * is not always, so strip a fence if present, then fall back to the first
 * brace-delimited span before giving up.
 */
export function parseJsonBody(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('empty model reply');
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const span = s.match(/\{[\s\S]*\}/);
    if (span) return JSON.parse(span[0]);
    throw new Error('model reply was not JSON');
  }
}

/**
 * Flatten provider usage into one shape. DeepSeek's Anthropic-compatible
 * endpoint reports cache hits as `prompt_cache_hit_tokens` while Anthropic uses
 * `cache_read_input_tokens`; read both so cost accounting works either way.
 */
export function normaliseUsage(usage) {
  const u = usage || {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
  };
}
