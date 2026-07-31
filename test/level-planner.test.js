import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundToTick, validateLevels, ATR_SEPARATION_MULT } from '../level-planner.js';
import { planLevels } from '../level-planner.js';

const opts = (over = {}) => ({ currentPrice: 100, atr: 2, tickSize: 0.1, ...over });

test('roundToTick: snaps to the nearest tick', () => {
  assert.equal(roundToTick(100.04, 0.1), 100.0);
  assert.equal(roundToTick(100.06, 0.1), 100.1);
  assert.equal(roundToTick(104.237, 0.01), 104.24);
});

test('roundToTick: a zero/absent tick size is a passthrough, not a divide-by-zero', () => {
  assert.equal(roundToTick(100.04, 0), 100.04);
  assert.equal(roundToTick(100.04, null), 100.04);
});

test('roundToTick: no floating-point crumbs', () => {
  assert.equal(roundToTick(0.1 + 0.2, 0.01), 0.3);
});

test('roundToTick: survives an exponential-notation tick size', () => {
  // String(0.00000001) is "1e-8" — any decimals-from-string approach rounds
  // every price on this pair to a whole number.
  assert.equal(roundToTick(0.000123456, 0.00000001), 0.00012346);
  assert.equal(roundToTick(1.23456789, 0.00000001), 1.23456789);
});

test('validateLevels: accepts a well-formed pair and returns it tick-rounded', () => {
  const r = validateLevels({ bullLevel: 104.037, bearLevel: 96.042 }, opts());
  assert.equal(r.ok, true);
  assert.equal(r.bullLevel, 104.0);
  assert.equal(r.bearLevel, 96.0);
});

test('validateLevels: rejects bull at or below current price', () => {
  assert.equal(validateLevels({ bullLevel: 100, bearLevel: 96 }, opts()).ok, false);
  assert.equal(validateLevels({ bullLevel: 99, bearLevel: 96 }, opts()).ok, false);
});

test('validateLevels: rejects bear at or above current price', () => {
  assert.equal(validateLevels({ bullLevel: 104, bearLevel: 100 }, opts()).ok, false);
  assert.equal(validateLevels({ bullLevel: 104, bearLevel: 101 }, opts()).ok, false);
});

test('validateLevels: enforces the 1.5x ATR separation floor', () => {
  // atr 2 -> minimum separation 3.
  assert.equal(validateLevels({ bullLevel: 101, bearLevel: 99 }, opts()).ok, false, 'sep 2 < 3');
  assert.equal(validateLevels({ bullLevel: 102, bearLevel: 98 }, opts()).ok, true, 'sep 4 >= 3');
  assert.equal(ATR_SEPARATION_MULT, 1.5);
});

test('validateLevels: a missing or non-finite ATR skips the separation check, not the invariant', () => {
  const r = validateLevels({ bullLevel: 101, bearLevel: 99 }, opts({ atr: null }));
  assert.equal(r.ok, true, 'unknown ATR must not block an otherwise valid pair');
  assert.equal(validateLevels({ bullLevel: 99, bearLevel: 101 }, opts({ atr: null })).ok, false);
});

test('validateLevels: separation EXACTLY 1.5x ATR is accepted (boundary is >=)', () => {
  // atr 2 -> minSep 3 exactly. sep 3 must pass, not fail on a strict '<'.
  const r = validateLevels({ bullLevel: 101.5, bearLevel: 98.5 }, opts());
  assert.equal(r.ok, true, 'separation exactly at the 1.5x ATR floor must be accepted');
});

test('validateLevels: atr:Infinity skips the separation check rather than rejecting', () => {
  // finitePos(Infinity) is false, so an infinite ATR must fall through to
  // "no separation check", the same as a missing/null ATR — never treated
  // as an impossible-to-satisfy minimum separation.
  const r = validateLevels({ bullLevel: 101, bearLevel: 99 }, opts({ atr: Infinity }));
  assert.equal(r.ok, true, 'an infinite ATR must not reject an otherwise valid pair');
});

test('validateLevels: rejects non-numeric, NaN and non-positive levels', () => {
  for (const bad of [{ bullLevel: 'x', bearLevel: 96 }, { bullLevel: NaN, bearLevel: 96 },
                     { bullLevel: 104, bearLevel: 0 }, { bullLevel: 104, bearLevel: -5 }, null]) {
    assert.equal(validateLevels(bad, opts()).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('validateLevels: rounding must not violate the invariant it just checked', () => {
  // bull 100.04 rounds DOWN to 100.0 == currentPrice, which is no longer valid.
  const r = validateLevels({ bullLevel: 100.04, bearLevel: 90 }, opts({ tickSize: 0.1 }));
  assert.equal(r.ok, false, 'a level that rounds onto current price must be rejected');
});

test('validateLevels: rejects a level that overflows to Infinity after rounding', () => {
  // 1e308 / 0.1 tick-rounds to Infinity, which then sails through every
  // relational check (> currentPrice, < currentPrice, ATR-separated) unless
  // finiteness is re-checked AFTER rounding.
  const r = validateLevels({ bullLevel: 1e308, bearLevel: 50 }, opts());
  assert.equal(r.ok, false, 'an Infinity level must never validate');
  assert.equal(typeof r.reason, 'string');
  assert.ok(/finite/i.test(r.reason), `reason should call out non-finiteness: ${r.reason}`);
});

test('validateLevels: every rejection carries a reason', () => {
  const r = validateLevels({ bullLevel: 99, bearLevel: 96 }, opts());
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});

const planCtx = (over = {}) => ({
  symbol: 'BTCUSDT', currentPrice: 100, atr: 2, tickSize: 0.1,
  profile: { rangeVoids: [{ priceLow: 90, priceHigh: 94 }, { priceLow: 106, priceHigh: 110 }] },
  ...over,
});
const okPlanner = (json, usage = { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreation: 0 }) =>
  ({ consult: async () => ({ json, usage }) });

test('planLevels: uses the AI pair when it validates', async () => {
  // Raw AI values are off-tick (0.1 tick size) on purpose: this pins that
  // planLevels returns the ROUNDED verdict values, not the raw json ones
  // (json.bullLevel/json.bearLevel would still be 105.04/94.96).
  const r = await planLevels({
    planner: okPlanner({ decision: 'PLAN', bullLevel: 105.04, bearLevel: 94.96, rationale: 'because', confidence: 0.7 }),
    context: planCtx(),
  });
  assert.equal(r.source, 'ai');
  assert.equal(r.bullLevel, 105);
  assert.equal(r.bearLevel, 95);
  assert.equal(r.rationale, 'because');
  assert.equal(r.usage.inputTokens, 1);
});

test('planLevels: falls back to the void edges when the AI throws', async () => {
  const r = await planLevels({
    planner: { consult: async () => { throw new Error('provider down'); } },
    context: planCtx(),
  });
  assert.equal(r.source, 'fallback');
  assert.equal(r.bullLevel, 106, 'inner edge of the upper void');
  assert.equal(r.bearLevel, 94, 'inner edge of the lower void');
  assert.ok(/provider down/.test(r.error));
});

test('planLevels: falls back when the AI pair FAILS validation', async () => {
  // bull below current price — invalid, must not be trusted.
  const r = await planLevels({
    planner: okPlanner({ decision: 'PLAN', bullLevel: 99, bearLevel: 95 }),
    context: planCtx(),
  });
  assert.equal(r.source, 'fallback');
  assert.equal(r.bullLevel, 106);
  assert.ok(/bullLevel/.test(r.error), `reason should name the failure: ${r.error}`);
});

test('planLevels: returns null when the fallback pair itself FAILS validation', async () => {
  // Two voids that straddle price (98-99 below, 101-102 above) so
  // selectVoidPair returns a NON-null pair (bull 101 / bear 99), but the
  // separation is only 2 while atr:2 demands >= 3 (1.5x). The fallback must
  // be run through the SAME validation as the AI path, not trusted blindly.
  const r = await planLevels({
    planner: { consult: async () => { throw new Error('down'); } },
    context: planCtx({ profile: { rangeVoids: [{ priceLow: 98, priceHigh: 99 }, { priceLow: 101, priceHigh: 102 }] } }),
  });
  assert.equal(r, null, 'a fallback pair that fails validation must yield null, not the raw pair');
});

test('planLevels: fallback is still validated, not trusted blindly', async () => {
  // Voids exist but sit entirely above price, so no straddling pair.
  const r = await planLevels({
    planner: { consult: async () => { throw new Error('down'); } },
    context: planCtx({ profile: { rangeVoids: [{ priceLow: 106, priceHigh: 110 }] } }),
  });
  assert.equal(r, null, 'no valid pair from either route must return null');
});

test('planLevels: AI usage is reported even when the pair is rejected', async () => {
  const r = await planLevels({
    planner: okPlanner({ decision: 'PLAN', bullLevel: 99, bearLevel: 95 }, { inputTokens: 9, outputTokens: 3, cacheRead: 0, cacheCreation: 0 }),
    context: planCtx(),
  });
  assert.equal(r.source, 'fallback');
  assert.equal(r.usage.inputTokens, 9, 'a rejected consult still cost money and must be billed');
});

test('planLevels: ask mode sends the ASK message and returns the proposal', async () => {
  let seenUser = null;
  const r = await planLevels({
    planner: { consult: async (_s, u) => { seenUser = u; return { json: { bullLevel: 105, bearLevel: 95 }, usage: {} }; } },
    context: planCtx(),
    mode: 'ask',
    question: 'tighter?',
  });
  assert.ok(seenUser.includes('CONTEXT: ASK'));
  assert.ok(seenUser.includes('tighter?'));
  assert.equal(r.source, 'ai');
});

test('planLevels: a missing planner goes straight to fallback rather than throwing', async () => {
  const r = await planLevels({ planner: null, context: planCtx() });
  assert.equal(r.source, 'fallback');
  assert.equal(r.bullLevel, 106);
});
