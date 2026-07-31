import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLevelContext } from '../market-context.js';
import { planLevels } from '../level-planner.js';
import { AiUsageAccumulator, usageCostUsd } from '../ai-cost.js';

const profile = {
  poc: { price: 100.5 }, vah: 102, val: 99,
  rangeVoids: [{ priceLow: 97, priceHigh: 97.8 }, { priceLow: 104, priceHigh: 105 }],
  hvns: [{ priceLow: 100, priceHigh: 101 }],
};
const vp = { getVoidProfile: async () => ({ window: '24h', profile, pair: { bullLevel: 104, bearLevel: 97.8 } }) };
const mm = {
  getVolatility: async () => ({ atr: 0.9 }),
  getCvd: async () => ({ cvd: -1200 }),
  getOrderbookDepth: async () => ({ bidVolume: 10, askVolume: 12 }),
  getFundingRate: async () => ({ rate: 0.0001 }),
  getOpenInterestChange: async () => ({ oiChange1h: 3.2 }),
};
const precision = { getPrecisionData: () => ({ tickSize: 0.1 }) };
const build = () => buildLevelContext({ symbol: 'BTCUSDT', currentPrice: 101, volumeProfile: vp, marketMetrics: mm, precision });

test('e2e: a real context flows through planLevels and the AI pair is used', async () => {
  const context = await build();
  let sentUser = null;
  const planner = {
    consult: async (_sys, user) => {
      sentUser = user;
      return { json: { decision: 'PLAN', bullLevel: 104.03, bearLevel: 97.77, rationale: 'void edges', confidence: 0.7 },
               usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 0, cacheCreation: 0 } };
    },
  };
  const r = await planLevels({ planner, context });

  assert.equal(r.source, 'ai');
  assert.equal(r.bullLevel, 104, 'tick-rounded to the 0.1 grid');
  assert.equal(r.bearLevel, 97.8);
  // The prompt actually carried the assembled market data.
  assert.ok(sentUser.includes('BTCUSDT'));
  assert.ok(sentUser.includes('-1200'), 'negative CVD must reach the model');
  assert.ok(!/undefined|NaN|null/.test(sentUser), `placeholder leaked into the prompt:\n${sentUser}`);
});

test('e2e: a dead AI falls back to the void edges from the same context', async () => {
  const context = await build();
  const r = await planLevels({ planner: { consult: async () => { throw new Error('provider down'); } }, context });
  assert.equal(r.source, 'fallback');
  assert.equal(r.bullLevel, 104);
  assert.equal(r.bearLevel, 97.8);
});

test('e2e: usage from a real consult prices through ai-cost', async () => {
  const context = await build();
  const usage = { inputTokens: 1200, outputTokens: 300, cacheRead: 0, cacheCreation: 0 };
  const r = await planLevels({
    planner: { consult: async () => ({ json: { bullLevel: 104, bearLevel: 97.8 }, usage }) },
    context,
  });
  const acc = new AiUsageAccumulator();
  acc.add(r.usage);
  const cost = acc.costUsd('deepseek-v4-flash');
  assert.ok(Number.isFinite(cost) && cost > 0, `cost was ${cost}`);
  assert.ok(Math.abs(cost - usageCostUsd(usage, 'deepseek-v4-flash')) < 1e-12);
});

test('e2e: a degraded context (every source down) still reaches a verdict', async () => {
  const dead = new Proxy({}, { get: () => async () => { throw new Error('x'); } });
  const context = await buildLevelContext({ symbol: 'BTCUSDT', currentPrice: 101, volumeProfile: dead, marketMetrics: dead, precision });
  const r = await planLevels({
    planner: { consult: async () => ({ json: { bullLevel: 104, bearLevel: 98 }, usage: {} }) },
    context,
  });
  // No profile means no fallback, so the AI pair is the only route — and it is
  // still validated: bull above price, bear below, separation unchecked (no ATR).
  assert.equal(r.source, 'ai');
  assert.equal(r.bullLevel, 104);
});

test('e2e: no profile AND a dead AI yields null, not a guess', async () => {
  const dead = new Proxy({}, { get: () => async () => { throw new Error('x'); } });
  const context = await buildLevelContext({ symbol: 'BTCUSDT', currentPrice: 101, volumeProfile: dead, marketMetrics: dead, precision });
  const r = await planLevels({ planner: { consult: async () => { throw new Error('down'); } }, context });
  assert.equal(r, null);
});
