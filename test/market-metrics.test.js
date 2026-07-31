import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeATR, computeCvd, summarizeDepth, MarketMetrics } from '../market-metrics.js';

// Candle shape per parseKlines.
const candle = (low, high, close, volume = 10, takerBuyBaseVolume = 5) =>
  ({ open: low, high, low, close, volume, takerBuyBaseVolume });

// ——— ATR ———————————————————————————————————————————————————————————————

test('computeATR: true range is the max of the three Wilder legs, not just high-low', () => {
  // Flat 1.0-wide bars, then one bar that GAPS up: its high-low is still 1.0
  // but |high - prevClose| is 6.0, which must be the true range that wins.
  const candles = [
    ...Array.from({ length: 14 }, () => candle(100, 101, 100.5)),
    candle(106, 107, 106.5),
  ];
  const { atr } = computeATR(candles, 14, 100);
  // 13 bars of TR=1 (close 100.5 → range 100..101) and one of TR=|107-100.5|=6.5.
  const expected = (13 * 1 + 6.5) / 14;
  assert.ok(Math.abs(atr - expected) < 1e-9, `atr was ${atr}, expected ${expected}`);
});

test('computeATR: atrPercent is relative to the supplied currentPrice', () => {
  const candles = Array.from({ length: 20 }, () => candle(99, 101, 100));
  // TR is 2 on every bar → atr 2. At price 100 that is 2%; at 200, 1%.
  assert.equal(computeATR(candles, 14, 100).atrPercent, 2);
  assert.equal(computeATR(candles, 14, 200).atrPercent, 1);
});

test('computeATR: falls back to the last close when no currentPrice is given', () => {
  // Flat 99..101 bars closing at 100, except the last which closes at 101.
  // TR is 2 on every bar either way, so only the denominator differs.
  const candles = [
    ...Array.from({ length: 19 }, () => candle(99, 101, 100)),
    candle(99, 101, 101),
  ];
  // Without the fallback this divides by null → 0.
  assert.ok(Math.abs(computeATR(candles, 14, null).atrPercent - (2 / 101) * 100) < 1e-9);
  // And the explicit price still wins over the last close.
  assert.equal(computeATR(candles, 14, 100).atrPercent, 2);
});

test('computeATR: interpretation bands track atrPercent', () => {
  const at = (pct) => {
    // TR = high-low = pct, price 100 → atrPercent === pct.
    const candles = Array.from({ length: 20 }, () => candle(100 - pct, 100, 100));
    return computeATR(candles, 14, 100).interpretation;
  };
  assert.equal(at(0.2), 'low');
  assert.equal(at(0.7), 'moderate');
  assert.equal(at(1.5), 'high');
  assert.equal(at(3.0), 'extreme');
});

test('computeATR: too few candles returns the unknown answer, not NaN', () => {
  const short = Array.from({ length: 14 }, () => candle(99, 101, 100)); // need period+1
  assert.deepEqual(computeATR(short, 14, 100), { atr: 0, atrPercent: 0, interpretation: 'unknown' });
  assert.deepEqual(computeATR([], 14, 100), { atr: 0, atrPercent: 0, interpretation: 'unknown' });
  assert.deepEqual(computeATR(null, 14, 100), { atr: 0, atrPercent: 0, interpretation: 'unknown' });
});

// ——— CVD ———————————————————————————————————————————————————————————————

test('computeCvd: buy-dominant tape accumulates a positive delta and reads rising', () => {
  // takerBuy 8 of 10 → delta +6 per bar over 24 bars.
  const candles = Array.from({ length: 24 }, () => candle(100, 101, 100.5, 10, 8));
  const r = computeCvd(candles);
  assert.equal(r.cvd, 24 * 6);
  assert.equal(r.cvdTrend, 'rising');
  assert.equal(r.lookbackBars, 24);
  assert.equal(r.lookbackMinutes, 120);
});

test('computeCvd: sell-dominant tape reads falling with a negative cvd', () => {
  const candles = Array.from({ length: 24 }, () => candle(100, 101, 100.5, 10, 2));
  const r = computeCvd(candles);
  assert.equal(r.cvd, 24 * -6);
  assert.equal(r.cvdTrend, 'falling');
});

test('computeCvd: balanced tape reads flat', () => {
  const candles = Array.from({ length: 24 }, () => candle(100, 101, 100.5, 10, 5));
  const r = computeCvd(candles);
  assert.equal(r.cvd, 0);
  assert.equal(r.cvdTrend, 'flat');
});

test('computeCvd: trend follows the SECOND half only — an early burst that stops does not read rising', () => {
  // First half heavily bought, second half perfectly balanced. Cumulative CVD
  // stays high and positive, but the recent slope is zero → flat.
  const candles = [
    ...Array.from({ length: 12 }, () => candle(100, 101, 100.5, 10, 10)),
    ...Array.from({ length: 12 }, () => candle(100, 101, 100.5, 10, 5)),
  ];
  const r = computeCvd(candles);
  assert.ok(r.cvd > 0, 'cumulative delta should still be positive');
  assert.equal(r.cvdTrend, 'flat', 'trend must read the second half, not the running total');
});

test('computeCvd: only the trailing 24 bars are counted', () => {
  const candles = [
    ...Array.from({ length: 100 }, () => candle(100, 101, 100.5, 10, 10)), // ignored
    ...Array.from({ length: 24 }, () => candle(100, 101, 100.5, 10, 5)),
  ];
  assert.equal(computeCvd(candles).cvd, 0);
});

test('computeCvd: a partial window returns null rather than a meaningless number', () => {
  assert.equal(computeCvd(Array.from({ length: 23 }, () => candle(100, 101, 100.5))), null);
  assert.equal(computeCvd([]), null);
  assert.equal(computeCvd(null), null);
});

// ——— Orderbook depth ————————————————————————————————————————————————————

test('summarizeDepth: imbalance is signed toward the heavier side', () => {
  const bids = Array.from({ length: 100 }, () => ['100', '3']);   // 300
  const asks = Array.from({ length: 100 }, () => ['101', '1']);   // 100
  const d = summarizeDepth({ bids, asks });
  assert.equal(d.bidVolume, 300);
  assert.equal(d.askVolume, 100);
  assert.equal(d.imbalance, 0.5);        // (300-100)/400, positive = bid-heavy
  assert.equal(d.levels, 100);
});

test('summarizeDepth: top10 imbalance reads only the top of book', () => {
  // Top 10 bids are thin, the deep tail is thick — the two imbalances must disagree.
  const bids = [
    ...Array.from({ length: 10 }, () => ['100', '1']),
    ...Array.from({ length: 90 }, () => ['99', '100']),
  ];
  const asks = Array.from({ length: 100 }, () => ['101', '5']);
  const d = summarizeDepth({ bids, asks });
  assert.equal(d.top10Bids, 10);
  assert.equal(d.top10Asks, 50);
  assert.ok(d.top10Imbalance < 0, 'top of book is ask-heavy');
  assert.ok(d.imbalance > 0, 'full book is bid-heavy');
});

test('summarizeDepth: empty book yields zero imbalance, not NaN', () => {
  const d = summarizeDepth({ bids: [], asks: [] });
  assert.equal(d.imbalance, 0);
  assert.equal(d.top10Imbalance, 0);
});

test('summarizeDepth: a malformed payload returns null', () => {
  assert.equal(summarizeDepth(null), null);
  assert.equal(summarizeDepth({}), null);
  assert.equal(summarizeDepth({ bids: [], asks: 'nope' }), null);
});

// ——— Fetcher posture (display-only: never throw, keep the last snapshot) ———

test('MarketMetrics: a failing depth fetch returns the cached snapshot, never throws', async () => {
  let calls = 0;
  const strategy = {
    currentPrice: 100,
    makeProxyRequest: async () => {
      calls += 1;
      if (calls === 1) return { bids: [['100', '2']], asks: [['101', '1']] };
      throw new Error('binance 418');
    },
  };
  const mm = new MarketMetrics(strategy);
  const first = await mm.getOrderbookDepth('BTCUSDT');
  assert.equal(first.bidVolume, 2);

  mm.invalidate('BTCUSDT');                       // force past the 30s TTL
  const second = await mm.getOrderbookDepth('BTCUSDT');
  // invalidate() dropped the cache, so there is nothing to fall back to.
  assert.equal(second, null, 'a failed fetch with no cache must yield null, not throw');
});

test('MarketMetrics: a failing CVD candle fetch yields null rather than propagating', async () => {
  const mm = new MarketMetrics({ currentPrice: 100, makeProxyRequest: async () => { throw new Error('down'); } });
  assert.equal(await mm.getCvd('BTCUSDT'), null);
});

test('MarketMetrics: a failing ATR candle fetch yields the unknown answer', async () => {
  const mm = new MarketMetrics({ currentPrice: 100, makeProxyRequest: async () => { throw new Error('down'); } });
  assert.deepEqual(await mm.getVolatility('BTCUSDT'), { atr: 0, atrPercent: 0, interpretation: 'unknown' });
});

test('MarketMetrics: candles are cached per symbol, not shared across them', async () => {
  const seen = [];
  const kline = (i) => [i, '100', '101', '99', '100', '10', i, '1000', 1, '5', '500'];
  const mm = new MarketMetrics({
    currentPrice: 100,
    makeProxyRequest: async (_p, _m, params) => {
      seen.push(params.symbol);
      return Array.from({ length: 30 }, (_, i) => kline(i));
    },
  });
  await mm.getVolatility('BTCUSDT');
  await mm.getVolatility('BTCUSDT');   // cached — no second fetch
  await mm.getVolatility('ETHUSDT');   // different symbol — must fetch
  assert.deepEqual(seen, ['BTCUSDT', 'ETHUSDT']);
});

const fakeStrategy = (impl) => ({ makeProxyRequest: impl, currentPrice: 100 });

test('getFundingRate: parses the premium index', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => ({
    lastFundingRate: '0.0001', nextFundingTime: String(Date.now() + 3 * 3600 * 1000),
  })));
  const r = await mm.getFundingRate('BTCUSDT');
  assert.equal(r.rate, 0.0001);
  assert.match(r.nextFundingTime, /^in \d+h \d+m$/);
});

test('getFundingRate: caches, so a second call does not refetch', async () => {
  let calls = 0;
  const mm = new MarketMetrics(fakeStrategy(async () => {
    calls++;
    return { lastFundingRate: '0.0002', nextFundingTime: String(Date.now() + 3600000) };
  }));
  await mm.getFundingRate('BTCUSDT');
  await mm.getFundingRate('BTCUSDT');
  assert.equal(calls, 1);
});

test('getFundingRate: a failed fetch returns null, never throws', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => { throw new Error('502'); }));
  assert.equal(await mm.getFundingRate('BTCUSDT'), null);
});

test('getFundingRate: a malformed payload yields null rather than NaN', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => ({ lastFundingRate: 'abc' })));
  assert.equal(await mm.getFundingRate('BTCUSDT'), null);
});

const oiRow = (v) => ({ sumOpenInterestValue: String(v) });

test('getOpenInterestChange: computes 5m/1h change and trend', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => [
    oiRow(100), oiRow(101), oiRow(102), oiRow(103), oiRow(104), oiRow(105),
    oiRow(106), oiRow(107), oiRow(108), oiRow(109), oiRow(110), oiRow(120),
  ]));
  const r = await mm.getOpenInterestChange('BTCUSDT');
  assert.ok(Math.abs(r.oiChange1h - 20) < 1e-9, `1h change was ${r.oiChange1h}`);
  assert.ok(r.oiChange5m > 0);
  assert.equal(r.oiTrend, 'RISING');
});

test('getOpenInterestChange: detects a falling trend', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => [
    oiRow(120), oiRow(118), oiRow(110), oiRow(105), oiRow(100),
  ]));
  assert.equal((await mm.getOpenInterestChange('BTCUSDT')).oiTrend, 'FALLING');
});

test('getOpenInterestChange: too few rows yields null, not a divide-by-zero', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => [oiRow(100), oiRow(101)]));
  assert.equal(await mm.getOpenInterestChange('BTCUSDT'), null);
});

test('getOpenInterestChange: a zero baseline yields null rather than Infinity', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => [oiRow(0), oiRow(0), oiRow(5)]));
  const r = await mm.getOpenInterestChange('BTCUSDT');
  assert.equal(r, null, 'dividing by a zero baseline must not produce Infinity');
});

test('getOpenInterestChange: only the oldest reading is zero yields null', async () => {
  // secondLatest (10) is nonzero here, isolating the `oldest === 0` half of the
  // guard — a regressed check of only `secondLatest === 0` would wrongly pass.
  const mm = new MarketMetrics(fakeStrategy(async () => [oiRow(0), oiRow(10), oiRow(12)]));
  const r = await mm.getOpenInterestChange('BTCUSDT');
  assert.equal(r, null, 'dividing by a zero oldest reading must not produce Infinity');
});

test('getOpenInterestChange: only the second-latest reading is zero yields null', async () => {
  // oldest (10) is nonzero here, isolating the `secondLatest === 0` half of the
  // guard — a regressed check of only `oldest === 0` would wrongly pass.
  const mm = new MarketMetrics(fakeStrategy(async () => [oiRow(10), oiRow(0), oiRow(12)]));
  const r = await mm.getOpenInterestChange('BTCUSDT');
  assert.equal(r, null, 'dividing by a zero second-latest reading must not produce Infinity');
});

test('getOpenInterestChange: a failed fetch returns null, never throws', async () => {
  const mm = new MarketMetrics(fakeStrategy(async () => { throw new Error('down'); }));
  assert.equal(await mm.getOpenInterestChange('BTCUSDT'), null);
});
