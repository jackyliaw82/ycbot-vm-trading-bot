import Anthropic from '@anthropic-ai/sdk';

// DeepSeek exposes an Anthropic-compatible endpoint at /anthropic. Pointing the
// @anthropic-ai/sdk at this baseURL lets us reuse messages.create(...) unchanged;
// auth rides on the same x-api-key header the SDK already sends.
// Source: https://api-docs.deepseek.com/guides/anthropic_api
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;
// Per-attempt ceiling on the model call.
//
// The SDK ships with `timeout = 10 minutes` and `maxRetries = 2` (verified
// against the installed 0.39.0). Layered under this class's own MAX_RETRIES
// of 3, that is up to NINE HTTP attempts at ten minutes each - no bound worth
// the name. Nothing downstream survived it: the Ask AI request died at the
// proxy's 60s Cloud Run ceiling as an opaque 504 carrying no CORS headers,
// which the browser could only report as "Failed to fetch", while the VM and
// DeepSeek carried on working for a caller that had already given up.
//
// `maxRetries: 0` is deliberate: this class ALREADY retries with backoff, and
// a second retry loop hidden inside the SDK multiplied the count invisibly.
// One loop, one place, a knowable worst case:
//
//   3 attempts x 45s + 1s + 2s backoff = 138s   <  the proxy's 150s abort
//                                               <  Cloud Run's 180s ceiling
//
// Innermost bound fires first, so a slow model produces a real error message
// rather than a dead connection.
// DEFAULT ceiling, used by the autonomous cycle-start plan. Nobody is waiting
// on that call and nothing upstream times it out — it runs on the VM's own
// tick — so it can afford retries and a generous per-attempt bound.
//
// The INTERACTIVE path cannot: see ASK_BUDGET below.
const AI_REQUEST_TIMEOUT_MS = 90_000;
// 8192, not 2048: long analyses were being truncated mid-JSON, and a truncated
// body fails to parse — which used to send the caller into a retry loop for a
// reason that looked like a provider fault. Output bills per emitted token, not
// per cap, so the headroom is free.
// MEASURED 2026-09-01: a real Ask AI returned `out 7258` against this 8192
// cap — 89% of the ceiling — for a JSON object whose payload is two numbers, a
// sentence and a confidence score. Generation time is dominated by output
// tokens, so this is where the ~60s comes from, not the input (`in 119`).
//
// That same call took 2 attempts. The likely reason is the failure mode this
// constant's own history describes: an answer that reaches the cap is truncated
// mid-JSON, fails to parse, and is retried — so being NEAR the cap costs double.
// Lowering it without first reducing what the model emits would make
// truncation the norm rather than the edge case.
const MAX_TOKENS = 8192;

export class AiPlanner {
  /**
   * `client` and `sleep` are injectable so tests never touch the network or a
   * real timer. Production passes neither.
   */
  constructor(apiKey, model = 'deepseek-v4-flash', { client, backoffMs, sleep } = {}) {
    this.client = client || new Anthropic({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
      timeout: AI_REQUEST_TIMEOUT_MS,
      maxRetries: 0,           // this class owns retries - see the constant
    });
    this.model = model;
    this.provider = 'deepseek';
    this.maxRetries = MAX_RETRIES;
    this._backoffMs = typeof backoffMs === 'number' ? backoffMs : DEFAULT_BACKOFF_MS;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * The model call, with a ceiling WE enforce.
   *
   * The SDK's own `timeout` option is set too (see the constructor) and its
   * source does honour it — `messages.create` passes
   * `this._client._options.timeout ?? ...` straight through. It still did not
   * hold in production: measured on 2026-09-01, one attempt ran 72s and the next
   * 61.3s against a 45s setting, neither aborted. Rather than keep theorising
   * about why, this imposes the bound at a layer we can verify.
   *
   * BOTH mechanisms, deliberately:
   *   - the AbortSignal actually CANCELS the request, so a giving-up caller does
   *     not leave the VM and DeepSeek working on an answer nobody will read;
   *   - the race guarantees THIS function returns by the deadline even if the
   *     signal is ignored downstream.
   * The signal alone would be trusting the same layer that already failed us.
   *
   * Promise.race attaches a handler to both promises, so the SDK's later
   * rejection after an abort is already handled — no unhandled rejection.
   */
  async _createWithTimeout(body, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const e = new Error(`model call exceeded ${timeoutMs / 1000}s`);
        e.isTimeout = true;
        reject(e);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.client.messages.create(body, { signal: controller.signal }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);   // always, or a resolved call leaks a live timer
    }
  }

  /**
   * One consult. Returns { json, usage, raw, timing }.
   *
   * `timing` exists because "the AI is slow" was unanswerable: nothing
   * recorded how long the call took or how much it generated, so a timeout
   * told you THAT it failed and never WHY. Generation time is dominated by
   * OUTPUT tokens (the context this sends is a handful of scalars), so
   * duration alongside outputTokens is what distinguishes "the model wrote an
   * essay" from "the provider was slow today".
   *
   * A reply that will not parse is treated as a FAILED ATTEMPT, not a success —
   * the model occasionally answers in prose, and returning that as a plan would
   * push an unvalidated object at the caller.
   */
  async consult(systemPrompt, userMessage, budget = {}) {
    const timeoutMs = budget.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
    const maxAttempts = budget.maxAttempts ?? this.maxRetries;
    let lastError = null;
    const startedAll = Date.now();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      try {
        const response = await this._createWithTimeout({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }, timeoutMs);
        const text = (response?.content || [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim();
        const json = parseJsonBody(text);
        const usage = normaliseUsage(response?.usage);
        return {
          json,
          usage,
          raw: text,
          timing: {
            ms: Date.now() - started,          // this attempt
            totalMs: Date.now() - startedAll,  // including earlier failed attempts
            attempts: attempt,
            model: this.model,
            timeoutMs,
            maxTokens: MAX_TOKENS,   // so a reader can see when output hit the cap
          },
        };
      } catch (error) {
        lastError = error;
        // Elapsed time is the whole point on a failure: an attempt that died
        // at ~45s hit OUR timeout, one that died in 200ms was rejected by the
        // provider. Identical message, opposite causes.
        console.error(
          `[ai-planner] attempt ${attempt}/${maxAttempts} failed after `
          + `${((Date.now() - started) / 1000).toFixed(1)}s (${this.model}, `
          + `timeout ${timeoutMs / 1000}s): ${error.message}`,
        );
        if (attempt < maxAttempts) {
          await this._sleep(this._backoffMs * Math.pow(2, attempt - 1));
        }
      }
    }
    const e = new Error(
      `AI consult failed after ${maxAttempts} attempts in `
      + `${((Date.now() - startedAll) / 1000).toFixed(1)}s: ${lastError?.message}`,
    );
    e.totalMs = Date.now() - startedAll;
    throw e;
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
    // Reasoning tokens, if the provider reports them. This exists to answer one
    // question the four fields above could not: an Ask AI returned 7258 output
    // tokens for a two-number answer, and NOTHING recorded whether that was a
    // long rationale (which a prompt can shorten) or the model thinking out loud
    // (which it cannot). The four normalised fields silently dropped every other
    // key the provider sent, so the deciding number was being thrown away.
    //
    // DeepSeek and OpenAI-compatible endpoints spell this several ways; take the
    // first that is actually a number rather than guessing which applies.
    reasoningTokens: firstNumber(
      u.reasoning_tokens,
      u.output_tokens_details?.reasoning_tokens,
      u.completion_tokens_details?.reasoning_tokens,
    ),
  };
}

/** First finite number among the candidates, else 0. */
function firstNumber(...candidates) {
  for (const v of candidates) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}
