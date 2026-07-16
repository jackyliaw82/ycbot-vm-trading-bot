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

test('_computeLadderBaseSize: the formula floors at initialSize', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 0;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.getTotalMarginBalance = async () => 1e9; // margin cap out of the way
  assert.equal(await s._computeLadderBaseSize(), 10000, 'no loss => no growth, never below initial');
});

test('_computeLadderBaseSize: a 50 USDT loss grows a 10k base to 12k', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 50;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.getTotalMarginBalance = async () => 1e9;
  s._computeAccLoss = () => 50;
  // 50 * 0.20 / 0.005 = 2000 additional
  const sized = await s._computeLadderBaseSize();
  assert.equal(sized, 12000);
  s._ladderBaseSize = sized;
  assert.equal(s._legNotional(), 2400, 'the grown base splits evenly across 5 legs');
});

test('_computeLadderBaseSize: a full gauge freezes escalation', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.initialCapital = 10000;
  s.harvestLossThreshold = 0.30;
  s.cycleAccumulatedLoss = 5000; // gauge full
  s._computeAccLoss = () => 5000;
  s._lastLadderSize = 12000;
  s._harvestRestartPending = false;
  // Gauge-full freeze returns _lastLadderSize before ever touching the
  // wallet, so no getTotalMarginBalance stub is needed here.
  assert.equal(await s._computeLadderBaseSize(), 12000, 'reuses the last size instead of growing');
});

test('_computeLadderBaseSize: uses the LIVE margin balance, not a stale one — a small live balance makes the cap bite', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.initialCapital = 1e9; // frozen cycle-start balance is huge (would NOT trigger the cap)
  s.cycleAccumulatedLoss = 50;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.leverage = 10;
  s.activePosition = null;
  s.getTotalMarginBalance = async () => 100; // live balance during drawdown is tiny
  const sized = await s._computeLadderBaseSize();
  assert.equal(sized, s.currentInitialSize, 'the live-balance headroom cap bites and floors to currentInitialSize');
});

test('_computeLadderBaseSize: getTotalMarginBalance() throwing fails CLOSED — capped to currentInitialSize, never left uncapped', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 50;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.getTotalMarginBalance = async () => { throw new Error('-1001 API error'); };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  const sized = await s._computeLadderBaseSize();
  assert.equal(sized, s.currentInitialSize, 'an unknown wallet balance must never read as headroom — cap to the safe floor');
  assert.ok(logs.some((m) => m.includes('fail-closed') || m.includes('failed')), 'the fail-closed cap is logged');
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
  s.getTotalMarginBalance = async () => 1e9;
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.anchor, 103, 'the harvest re-anchors; the anchor flatten does not');
  assert.equal(s.ladderMode, 'RANGE');
  assert.ok(s.ladderLines.every(l => l.state === 'EMPTY'));
});

// ——— Task 9: persistence, status, and resume ——————————————————————————

// resume() does real Binance/WS/Firestore I/O beyond restoring fields
// (setLeverage, listen-key, WS connects, L3 reconcile, funding poll, ...).
// These tests are about the field round-trip through saveState/resume, so
// every network- or Firestore-touching call is stubbed to a no-op.
function stubResumeIO(s) {
  s.setLeverage = async () => {};
  s.setPositionMode = async () => {};
  s._getExchangeInfo = async () => {};
  s._retryListenKeyRequest = async () => {};
  s.connectUserDataStream = () => {};
  s.connectRealtimeWebSocket = () => {};
  s._startWebSocketHealthMonitoring = () => {};
  s._scheduleVolumeRefresh = () => {};
  s._refreshVolumeSnapshot = async () => {};
  s._preloadWsHandledOrderIdsFromFirestore = async () => {};
  s._reconcileRecentTrades = async () => {};
  s.detectCurrentPosition = async () => {};
  s._refreshCurrentPosition = async () => {};
  s._pollFundingIncome = async () => {};
  s._scheduleNextFundingPoll = () => {};
  s.saveState = async () => {};
  return s;
}

// resume() unconditionally starts a real 30-minute listen-key refresh
// setInterval that would otherwise keep the test process (and `node --test`)
// alive indefinitely. Clear it once assertions are done.
function cleanupResumeTimers(s) {
  if (s.listenKeyRefreshInterval) clearInterval(s.listenKeyRefreshInterval);
  if (s._fundingPollTimeout) clearTimeout(s._fundingPollTimeout);
  if (s._volumeRefreshInterval) clearInterval(s._volumeRefreshInterval);
}

test('a ladder round-trips through saveState/resume', async () => {
  const src = ladderStrategy({ anchor: 100, base: 12000 });
  src.ladderMode = 'TREND';
  src.trendDirection = 'LONG';
  src.ladderLines.filter(l => l.direction === 'LONG').forEach((l, i) => {
    Object.assign(l, { state: 'POSITION_OPEN', quantity: 10 + i, fillPrice: 100.3 + i * 0.3 });
  });
  src.lastProcessedPrice = 101.5;
  src.cycleAccumulatedLoss = 89;

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  // ladderStrategy() stubs saveState for the OTHER tests in this file (so a
  // trading-sequence test doesn't need a firestore double); this test is
  // specifically about persistence, so it calls the real prototype method.
  await AnchorLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  assert.equal(dst.anchor, 100);
  assert.equal(dst.ladderMode, 'TREND');
  assert.equal(dst.trendDirection, 'LONG');
  assert.equal(dst.ladderLines.length, 10);
  assert.equal(dst.ladderLines.filter(l => l.state === 'POSITION_OPEN').length, 5);
  assert.equal(dst.lastProcessedPrice, 101.5);
  assert.equal(dst._ladderBaseSize, 12000);
});

test('getStatus reports the ladder shape the frontend needs', () => {
  const s = ladderStrategy({ anchor: 100 });
  s.ladderMode = 'RANGE';
  const st = s.getStatus();
  assert.equal(st.mode, 'RANGE', 'the frontend reads status.mode, not status.ladderMode');
  assert.equal(st.anchor, 100);
  assert.equal(st.ladderLines.length, 10);
  assert.equal(st.levelsPerSide, 5);
  assert.equal(st.stepPct, 0.003);
});

test('getHeartbeatPayload reports the same ladder shape as getStatus', () => {
  const s = ladderStrategy({ anchor: 100 });
  s.ladderMode = 'TREND';
  s.trendDirection = 'SHORT';
  const hb = s.getHeartbeatPayload();
  assert.equal(hb.mode, 'TREND', 'the frontend reads status.mode, not status.ladderMode');
  assert.equal(hb.anchor, 100);
  assert.equal(hb.trendDirection, 'SHORT');
  assert.equal(hb.ladderLines.length, 10);
  assert.equal(hb.strategyType, 'anchorLadder');
});

test('saveState writes the ANCHOR_LADDER type tags for boot recovery', async () => {
  const s = ladderStrategy({ anchor: 100 });
  let written = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { written = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(s);
  assert.equal(written.type, 'ANCHOR_LADDER');
  assert.equal(written.strategyType, 'anchorLadder');
});

test('_lastLadderSize and _harvestRestartPending survive a save/resume round trip', async () => {
  const src = ladderStrategy({ anchor: 100, base: 12000 });
  src._lastLadderSize = 15000;
  src._harvestRestartPending = true;

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  assert.equal(dst._lastLadderSize, 15000, 'the martingale escalation freeze must survive a restart');
  assert.equal(dst._harvestRestartPending, true);
});

test('_recomputeFinalTpPrice keys off trendDirection, not just currentSide (resume race)', () => {
  const s = ladderStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.currentSide = null; // simulates the boot-recovery race: not yet resolved from Binance
  s.activePosition = { quantity: 100, avgEntry: 100.9, entryPrice: 100.9, notional: 10090 };
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;
  s._recomputeFinalTpPrice();
  assert.ok(s.finalTpPrice != null, 'Final TP must arm from trendDirection even when currentSide has not resolved yet');
  assert.ok(Math.abs(s.finalTpPrice - 102.87072) < 1e-6, `got ${s.finalTpPrice}`);
});

// ——— Final-review fixes ——————————————————————————————————————————————
//
// FIX 1: stop({flatten:true}) previously set `closedSomething = true` merely
// because ladder legs were MARKED POSITION_OPEN — not because anything was
// actually closed — which gated off the ONLY residual verification in the
// whole stop path. These tests pin the corrected shape: a source-of-truth
// refresh runs BEFORE deciding there is nothing to close, `closedSomething`
// reflects an ACTUAL close, and the residual verification ALWAYS runs
// afterwards regardless of which branch (if any) closed something.
//
// stop() does a lot of tail bookkeeping unrelated to the flatten logic under
// test (platform fee, hero-profit, no-trade-doc cleanup, WS teardown) —
// stub it all to a no-op so these tests exercise only the flatten +
// residual-verification path.
function stubStopTail(s) {
  s._pollFundingIncome = async () => {};
  s.cleanupWebSockets = () => {};
  s.deductPlatformFee = async () => {};
  s._recordHeroProfit = async () => {};
  s._deleteNoTradeStrategyDoc = async () => {};
  return s;
}

test('Fix 1(a): legs POSITION_OPEN + activePosition null in-memory, Binance still reports a position -> stop({flatten:true}) closes it and runs the residual check', async () => {
  const s = stubStopTail(ladderStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.activePosition = null; // in-memory drift: legs say open, position says flat
  s.currentSide = null;

  let refreshCalls = 0;
  s._refreshCurrentPosition = async () => {
    refreshCalls++;
    if (refreshCalls === 1) {
      // Binance — the source of truth — still reports the position memory lost.
      s.activePosition = { quantity: 1.2 };
      s.currentSide = 'LONG';
    } else {
      // The close succeeded; Binance now confirms flat.
      s.activePosition = null;
      s.currentSide = null;
    }
  };
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty, price, opts) => { orderArgs = { side, qty, opts }; return {}; };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s.stop({ flatten: true });

  assert.ok(orderArgs, 'a close order was placed against the Binance-confirmed position, not skipped as a phantom leg');
  assert.equal(orderArgs.side, 'SELL', 'closing a LONG sells');
  assert.deepEqual(orderArgs.opts, { reduceOnly: true });
  assert.ok(refreshCalls >= 2, 'the residual verification ran (a post-close refresh happened)');
  assert.ok(logs.some((m) => m.includes('confirmed flat')), 'residual verification confirmed flat and said so');
  assert.ok(!logs.some((m) => m.includes('WARNING')), 'no residual was left, so no warning was logged');
});

test('Fix 1(b): the close order throws -> stop() still runs the residual verification and logs a WARNING', async () => {
  const s = stubStopTail(ladderStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 0.8 };
  s.currentSide = 'LONG';

  let refreshCalls = 0;
  // Leaves activePosition/currentSide untouched — Binance genuinely still
  // shows the position open because every close attempt below throws.
  s._refreshCurrentPosition = async () => { refreshCalls++; };
  s.placeMarketOrder = async () => { throw new Error('-1001 Internal error'); };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s.stop({ flatten: true });

  assert.ok(refreshCalls >= 2, 'the residual verification refresh ran despite every close attempt throwing');
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('manually')),
    'a loud warning names the residual instead of a silent termination',
  );
  assert.equal(s.executionState, 'TERMINATED', 'stop() still completes termination — it never hangs open on a throw');
});

test('Fix 1: the normal path (legs open, position known, close succeeds) now runs the residual verification (it previously did not)', async () => {
  const s = stubStopTail(ladderStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 0.5 };
  s.currentSide = 'LONG';

  let refreshCalls = 0;
  s._refreshCurrentPosition = async () => {
    refreshCalls++;
    if (refreshCalls >= 2) { s.activePosition = null; s.currentSide = null; } // the close succeeded
  };
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty, price, opts) => { orderArgs = { side, qty, opts }; return {}; };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s.stop({ flatten: true });

  assert.ok(orderArgs, 'the close order was placed');
  assert.ok(refreshCalls >= 2, 'the residual verification ran on the normal branch-1 path, not only the previously-broken fallback branch');
  assert.ok(logs.some((m) => m.includes('confirmed flat')), 'the residual check found flat and logged it');
});

test('reduceOnly invariant (live-money): the close order carries reduceOnly:true and no positionSide', async () => {
  const s = stubStopTail(ladderStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 0.7 };
  s.currentSide = 'LONG';
  s._refreshCurrentPosition = async () => {}; // leaves state as-is; irrelevant to this assertion
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty, price, opts) => { orderArgs = { symbol, side, qty, price, opts }; return {}; };
  s.addLog = async () => {};

  await s.stop({ flatten: true });

  assert.ok(orderArgs, 'a close order was placed');
  assert.equal(orderArgs.opts.reduceOnly, true, 'one-way mode closes MUST be reduceOnly');
  assert.equal(orderArgs.opts.positionSide, undefined, 'one-way mode MUST NOT send positionSide — that is a hedge-mode concept');
});

// ——— FIX 2: the RANGE→TREND invariant is derived, not chased —————————————

test('Fix 2: resume() self-heals a snapshot stuck in RANGE fully-scaled — arms TREND + Final TP', async () => {
  const src = ladderStrategy({ anchor: 100, base: 12000 });
  src.ladderMode = 'RANGE'; // the bug: process died between _fillLeg(L5) persisting and _enterTrend running
  src.ladderLines.filter(l => l.direction === 'LONG').forEach((l, i) => {
    Object.assign(l, { state: 'POSITION_OPEN', quantity: 10 + i, fillPrice: 100.3 + i * 0.3 });
  });
  src.activePosition = { quantity: 50, entryPrice: 100.9, avgEntry: 100.9, notional: 5045 };
  src.currentSide = 'LONG';
  src.cycleAccumulatedLoss = 89;
  src.desiredProfitUSDT = 100;
  src.lastProcessedPrice = 101.5;

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  // detectCurrentPosition/_refreshCurrentPosition are stubbed no-ops by
  // stubResumeIO, so the restored snapshot fields (activePosition,
  // currentSide) stand in for "Binance still confirms this position" —
  // exactly what _enterTrend's internal refresh would find live.
  // resume() reconciling to TREND now reaches _enterTrend -> _writeStrategyFlow,
  // which stubResumeIO doesn't cover (no prior resume() path ever hit it) —
  // stub it here too so the test stays network-free.
  dst._writeStrategyFlow = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  assert.equal(dst.ladderMode, 'TREND', 'the invariant self-heals on resume, not just on the next tick');
  assert.equal(dst.trendDirection, 'LONG');
  assert.ok(dst.finalTpPrice != null, 'Final TP is armed — never silently left null');
});

test('Fix 2 regression: filling the outermost leg via the REAL _fillLeg path (not a stub) still transitions to TREND with Final TP armed', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 40, entryPrice: 100.9, avgEntry: 100.9, notional: 4036 };
  s.currentSide = 'LONG';
  s.cycleAccumulatedLoss = 0;
  s.desiredProfitUSDT = 50;
  s.placeMarketOrder = async () => ({}); // no orderId -> _resolveFill falls back to requested qty/level price
  s._quantityFor = async (symbol, notional, price) => notional / price; // skip the real exchange-info/network sizing call
  s.lastProcessedPrice = 100;

  await s.handleRealtimePrice(101.6); // past L5 at 101.5

  assert.ok(
    s.ladderLines.filter((l) => l.direction === 'LONG').every((l) => l.state === 'POSITION_OPEN'),
    'every LONG leg actually filled through the real _fillLeg path',
  );
  assert.equal(s.ladderMode, 'TREND');
  assert.equal(s.trendDirection, 'LONG');
  assert.ok(s.finalTpPrice != null, 'Final TP armed via the real _enterTrend -> _recomputeFinalTpPrice path (no regression from the invariant check)');
});

// ——— FIX 1 (maxPositionSizeUSDT removal): a dead knob must not resurface ——

test('Fix 1: getStatus() no longer emits maxPositionSizeUSDT', () => {
  const s = ladderStrategy({ anchor: 100 });
  const st = s.getStatus();
  assert.equal('maxPositionSizeUSDT' in st, false, 'the dead knob must not resurface in the status payload');
});

test('Fix 1: saveState() no longer persists maxPositionSizeUSDT', async () => {
  const s = ladderStrategy({ anchor: 100 });
  let written = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { written = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(s);
  assert.equal('maxPositionSizeUSDT' in written, false, 'the dead knob must not resurface in the persisted snapshot');
});

// ——— FIX 2: getCurrentPositions() throws instead of swallowing to [] —————
// (proven-by-probe bug: a transient API error was indistinguishable from a
// genuinely flat account, so detectCurrentPosition() wiped real position
// state on a 5xx.)

test('Fix 2: getCurrentPositions() throws when the API call fails, instead of swallowing to []', async () => {
  const s = ladderStrategy();
  s.makeProxyRequest = async () => { throw new Error('-1001 Internal error'); };
  await assert.rejects(() => s.getCurrentPositions(), /-1001/);
});

test('Fix 2: a position refresh failure does NOT wipe activePosition / currentPosition — stale beats falsely flat', async () => {
  const s = ladderStrategy();
  delete s._refreshCurrentPosition; // use the REAL implementation, not the test-helper no-op stub
  // Seed "last known" state as if a real position had already been confirmed.
  s.activePosition = { quantity: 2.5, entryPrice: 100, avgEntry: 100, notional: 250, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.currentPosition = 'LONG';
  s.currentPositionQuantity = 2.5;
  s.positionEntryPrice = 100;
  s.getCurrentPositions = async () => { throw new Error('-1001 Internal error'); }; // the underlying REST call fails
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s._refreshCurrentPosition();

  assert.deepEqual(s.activePosition, { quantity: 2.5, entryPrice: 100, avgEntry: 100, notional: 250, unrealizedPnl: 0 }, 'activePosition must stay exactly as it was — never wiped on a fetch failure');
  assert.equal(s.currentSide, 'LONG', 'currentSide must stay stale, not nulled');
  assert.equal(s._lastPositionRefreshFailed, true, 'the failure must be signalled, not silently absorbed');
  assert.ok(logs.some((m) => m.includes('UNKNOWN')), 'the failure is logged as unknown state, never as flat');
});

test('Fix 2: stop({flatten:true}) with legs POSITION_OPEN and the position API failing logs a WARNING, does NOT wipe the legs, and does not claim flat', async () => {
  const s = stubStopTail(ladderStrategy());
  delete s._refreshCurrentPosition; // use the REAL implementation

  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1);
  openLeg.state = 'POSITION_OPEN';
  openLeg.quantity = 1.4;
  // No last-known position in memory AND Binance cannot be reached — the
  // exact "no known state while ladderLines has POSITION_OPEN legs" scenario.
  s.activePosition = null;
  s.currentSide = null;
  s.getCurrentPositions = async () => { throw new Error('-1001 Internal error'); };

  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  let orderCalled = false;
  s.placeMarketOrder = async () => { orderCalled = true; return {}; };

  await s.stop({ flatten: true });

  assert.ok(logs.some((m) => m.includes('WARNING')), 'a loud WARNING is logged instead of a silent termination');
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('1.4')),
    'the WARNING names the stranded quantity',
  );
  assert.equal(openLeg.state, 'POSITION_OPEN', 'the leg must NOT be wiped to EMPTY when the state is unknown');
  assert.equal(orderCalled, false, 'no close was attempted against a phantom/unknown position');
  assert.ok(!logs.some((m) => m.includes('confirmed flat')), 'must never claim confirmed-flat when the state is unknown');
  assert.ok(!logs.some((m) => m.includes('nothing to flatten')), 'must never claim nothing-to-flatten when the state is unknown');
  assert.equal(s.executionState, 'TERMINATED', 'stop() still completes termination — it never hangs open');
});
