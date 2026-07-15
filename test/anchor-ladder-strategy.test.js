import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnchorLadderStrategy } from '../anchor-ladder-strategy.js';
import { buildLadder, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE } from '../ladder-levels.js';

// A strategy with an anchored ladder and nothing open. All I/O stubbed, so a
// tick exercises only the dispatch. Every later task's tests reuse this.
function ladderStrategy({ mode = 'RANGE', anchor = 100, base = 1000 } = {}) {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  s.isRunning = true;
  s.strategyId = 'anchor_ladder_test';
  s.symbol = 'BTCUSDT';
  s.stepPct = LADDER_STEP_PCT;
  s.levelsPerSide = LADDER_LEVELS_PER_SIDE;
  s.ladderMode = mode;
  s.anchor = anchor;
  s.ladderLines = buildLadder(anchor, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE);
  s.currentPrice = anchor;
  s.lastProcessedPrice = null;
  s.minNotional = 5;
  s._ladderBaseSize = base;
  s.currentInitialSize = base;
  s.initialCapital = base;
  s.activePosition = null;
  s.finalTpPrice = null;
  s._tradingSeqInProgress = false;
  s._manualHarvestRequested = false;
  s.addLog = async () => {};
  s.saveState = async () => {};
  s._writeStrategyFlow = async () => {};
  s._refreshCurrentPosition = async () => {};
  s._postExecuteBookkeeping = async () => {};
  return s;
}

test('_legNotional splits the base evenly across 5 levels', () => {
  const s = ladderStrategy({ base: 10000 });
  assert.equal(s._legNotional(), 2000);
});

test('start() rejects an initial size below the 50 USDT minimum', async () => {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s.addLog = async () => {};
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 49 }),
    /50/,
    'the gate must name the minimum',
  );
});

// ——— Task 7: tick dispatch ——————————————————————————————————————————

test('RANGE: crossing L1 fills it and opens LONG', async () => {
  const s = ladderStrategy();
  const orders = [];
  s._fillLeg = async (leg) => { orders.push(leg); leg.state = 'POSITION_OPEN'; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(100.35);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].direction, 'LONG');
  assert.equal(s.lastProcessedPrice, 100.35);
});

test('RANGE: a gap fills every level it jumped', async () => {
  const s = ladderStrategy();
  const orders = [];
  s._fillLeg = async (leg) => { orders.push(leg); leg.state = 'POSITION_OPEN'; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(100.95);
  assert.equal(orders.length, 3);
});

test('RANGE: filling the outermost leg switches to TREND', async () => {
  const s = ladderStrategy();
  s._fillLeg = async (leg) => { leg.state = 'POSITION_OPEN'; };
  s._recomputeFinalTpPrice = () => { s.finalTpPrice = 999; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(101.6); // past L5 at 101.5
  assert.equal(s.ladderMode, 'TREND');
  assert.equal(s.trendDirection, 'LONG');
  assert.equal(s.finalTpPrice, 999, 'Final TP is armed on entering TREND');
});

test('RANGE: crossing the anchor flattens', async () => {
  const s = ladderStrategy();
  let flattened = false;
  s._flattenAtAnchor = async () => { flattened = true; };
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.lastProcessedPrice = 100.35;
  await s.handleRealtimePrice(99.9);
  assert.equal(flattened, true);
});

test('TREND is passive: retreating inside the ladder does nothing', async () => {
  const s = ladderStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.finalTpPrice = 105;
  let acted = false;
  s._fillLeg = async () => { acted = true; };
  s._flattenAtAnchor = async () => { acted = true; };
  s.lastProcessedPrice = 101.6;
  await s.handleRealtimePrice(100.4); // back inside, but not to the anchor
  assert.equal(acted, false);
  assert.equal(s.ladderMode, 'TREND', 'mode holds until the anchor or Final TP');
});

test('TREND: reaching the anchor flattens and returns to RANGE', async () => {
  const s = ladderStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.ladderLines.filter(l => l.direction === 'LONG').forEach(l => { l.state = 'POSITION_OPEN'; });
  let flattened = false;
  s._flattenAtAnchor = async () => { flattened = true; s.ladderMode = 'RANGE'; };
  s.lastProcessedPrice = 100.4;
  await s.handleRealtimePrice(99.95);
  assert.equal(flattened, true);
  assert.equal(s.ladderMode, 'RANGE');
});

test('RANGE never checks Final TP', async () => {
  const s = ladderStrategy();
  s.finalTpPrice = 100.2; // would fire if RANGE checked it
  let stopped = false;
  s.stop = async () => { stopped = true; };
  s._fillLeg = async (leg) => { leg.state = 'POSITION_OPEN'; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(100.35);
  assert.equal(stopped, false, 'Final TP is a TREND-only exit');
});

test('TREND: Final TP hit stops the cycle', async () => {
  const s = ladderStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.finalTpPrice = 101;
  let reason = null;
  s.stop = async (opts) => { reason = opts.reason; };
  s.lastProcessedPrice = 100.9;
  await s.handleRealtimePrice(101.05);
  assert.equal(reason, 'final_tp');
});

test('the empty-ladder gate anchors on the first tick', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.anchor = null;
  await s.handleRealtimePrice(250);
  assert.equal(s.anchor, 250);
  assert.equal(s.ladderLines.length, 10);
  assert.equal(s.ladderMode, 'RANGE');
});

test('_flattenAtAnchor no-ops when there is nothing open and the ladder is all-EMPTY', async () => {
  const s = ladderStrategy();
  let closeCalled = false;
  s._closeConsolidated = async () => { closeCalled = true; };
  let sizingCalled = false;
  s._computeLadderBaseSize = () => { sizingCalled = true; return s._ladderBaseSize; };
  await s._flattenAtAnchor();
  assert.equal(closeCalled, false, 'no close order for a position that does not exist');
  assert.equal(sizingCalled, false, 'no re-sizing/rebuild churn on a no-op oscillation');
});

// ——— _closeConsolidated: currentSide state-drift guard ——————————————————

test('_closeConsolidated: currentSide missing is repopulated by a refresh from Binance before closing', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5 };
  s.currentSide = null;
  s._refreshCurrentPosition = async () => { s.currentSide = 'LONG'; };
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty) => { orderArgs = { symbol, side, qty }; return {}; };
  const result = await s._closeConsolidated('test');
  assert.equal(result, true, 'the close fires once the refresh repopulates currentSide');
  assert.ok(orderArgs, 'an order was placed');
  assert.equal(orderArgs.side, 'SELL', 'closing a LONG sells');
  assert.equal(orderArgs.qty, 0.5);
});

test('_closeConsolidated: currentSide still missing after refresh logs a WARNING and does not close', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5 };
  s.currentSide = null;
  s._refreshCurrentPosition = async () => {}; // Binance refresh does not resolve a side either
  let orderCalled = false;
  s.placeMarketOrder = async () => { orderCalled = true; return {}; };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  const result = await s._closeConsolidated('test');
  assert.equal(result, false, 'never guess the side — refuse to close');
  assert.equal(orderCalled, false, 'no order placed');
  assert.ok(logs.some((m) => m.includes('WARNING')), 'a loud warning was logged, not a silent no-op');
});

test('_closeConsolidated: nothing open returns false quietly, no order, no warning', async () => {
  const s = ladderStrategy();
  s.activePosition = null;
  s.currentSide = null;
  let orderCalled = false;
  s.placeMarketOrder = async () => { orderCalled = true; return {}; };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  const result = await s._closeConsolidated('test');
  assert.equal(result, false);
  assert.equal(orderCalled, false);
  assert.equal(logs.length, 0, 'the normal no-op path stays quiet');
});

// ——— Task 8: dynamic sizing, harvest, Final TP ———————————————————————

test('_computeLadderBaseSize: the formula floors at initialSize', () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 0;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.lastWalletSnapshot = { totalMarginBalance: 1e9 }; // margin cap out of the way
  assert.equal(s._computeLadderBaseSize(), 10000, 'no loss => no growth, never below initial');
});

test('_computeLadderBaseSize: a 50 USDT loss grows a 10k base to 12k', () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 50;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.lastWalletSnapshot = { totalMarginBalance: 1e9 };
  s._computeAccLoss = () => 50;
  // 50 * 0.20 / 0.005 = 2000 additional
  assert.equal(s._computeLadderBaseSize(), 12000);
  assert.equal(s._legNotional !== undefined, true);
});

test('_computeLadderBaseSize: a full gauge freezes escalation', () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.initialCapital = 10000;
  s.harvestLossThreshold = 0.30;
  s.cycleAccumulatedLoss = 5000; // gauge full
  s._computeAccLoss = () => 5000;
  s._lastLadderSize = 12000;
  s._harvestRestartPending = false;
  assert.equal(s._computeLadderBaseSize(), 12000, 'reuses the last size instead of growing');
});

test('_recomputeFinalTpPrice: no AI cost term', () => {
  const s = ladderStrategy({ mode: 'TREND' });
  s.activePosition = { quantity: 100, avgEntry: 100.9, entryPrice: 100.9, notional: 10090 };
  s.currentSide = 'LONG';
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;
  s._recomputeFinalTpPrice();
  // needed = 89 + 100 + 10090*0.0008 = 197.072 ; tp = 100.9 + 197.072/100
  assert.ok(Math.abs(s.finalTpPrice - 102.87072) < 1e-6, `got ${s.finalTpPrice}`);
});

test('_recomputeFinalTpPrice: null with no position', () => {
  const s = ladderStrategy();
  s.activePosition = null;
  s._recomputeFinalTpPrice();
  assert.equal(s.finalTpPrice, null);
});

test('harvestNow refuses when nothing is open', async () => {
  const s = ladderStrategy();
  await assert.rejects(() => s.harvestNow(), /nothing open/i);
});

test('harvest re-anchors to the CURRENT price, unlike the anchor flatten', async () => {
  const s = ladderStrategy({ anchor: 100 });
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 10, avgEntry: 100.3, entryPrice: 100.3, notional: 1003 };
  s.currentPrice = 103;
  s._closeConsolidated = async () => { s.activePosition = null; };
  s._computeAccLoss = () => 0;
  s.lastWalletSnapshot = { totalMarginBalance: 1e9 };
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.anchor, 103, 'the harvest re-anchors; the anchor flatten does not');
  assert.equal(s.ladderMode, 'RANGE');
  assert.ok(s.ladderLines.every(l => l.state === 'EMPTY'));
});
