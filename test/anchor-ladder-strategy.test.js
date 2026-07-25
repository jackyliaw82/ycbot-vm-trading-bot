import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnchorLadderStrategy, validateStartTrigger } from '../anchor-ladder-strategy.js';
import { buildLadder, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE, LADDER_STEP_PCT_MAX, LADDER_LEVELS_MAX } from '../ladder-levels.js';
import { precisionFormatter } from '../precisionUtils.js';

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
  // NOTE: there is deliberately no `_trendFinalTpArmed` seed here any more.
  // It is now DERIVED (ladderMode === 'TREND' && finalTpPrice != null), and
  // assigning it throws by design. This fixture used to seed it to
  // `mode === 'TREND'`, which was a trap: it defaulted every TREND fixture to
  // "armed" independently of finalTpPrice, so a test could assert against the
  // seed rather than the code. A TREND fixture that sets a finalTpPrice is now
  // armed by construction; one that leaves it null genuinely IS unarmed and
  // SHOULD be self-healed by `_reconcileTrendInvariant`.
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

// FIX round 3's FIX 2: without this, an ARMED start-trigger fire (the ladder
// builds mid-run, not at strategy boot) can leave the frontend showing ARMED
// for up to 30s — the WS-connected UI disables its REST poll and relies on
// the 30s strategy_update safety net, and no leg fill can heal it on the
// anchoring tick (price == anchor). Also tightens the harvest re-anchor path,
// which calls initializeLadder() too.
test('initializeLadder pushes an immediate heartbeat after saving state', async () => {
  const s = ladderStrategy();
  let heartbeatCalls = 0;
  s._pushHeartbeatNow = () => { heartbeatCalls++; };
  await s.initializeLadder(105);
  assert.equal(heartbeatCalls, 1, 'the ARMED (or harvest re-anchor) -> live transition must push immediately');
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

// ——— Configurable geometry: the VM is the authority on the bounds ———

function geoStrategy() {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s.addLog = async () => {};
  return s;
}

// NOTE on matchers below: /step/i and /whole number between 3 and 10/ are
// deliberately specific to the BOUNDS error, not just "step"/"level". A bare
// /step/i also matches Binance's stepSize wording, and a bare /level/i also
// matches the min-size error ("for a 2-level ladder") — with initialSize 1000
// these tests clear the size gate today, but a future initialSize change
// could let them pass off the WRONG gate while the bounds check silently
// broke. Pin to the bounds message's own wording so that can't happen.
test('start() rejects a ladder step below the 0.3% fee floor', async () => {
  await assert.rejects(
    () => geoStrategy().start({ symbol: 'BTCUSDT', initialSize: 1000, ladderStepPct: 0.002 }),
    /Ladder step .* must be between 0\.3% and 2\.0%/,
    'the gate must name the step',
  );
});

test('start() rejects a ladder step above the 2% ceiling', async () => {
  await assert.rejects(
    () => geoStrategy().start({ symbol: 'BTCUSDT', initialSize: 1000, ladderStepPct: 0.03 }),
    /Ladder step .* must be between 0\.3% and 2\.0%/,
  );
});

test('start() rejects a level count outside 3-10', async () => {
  await assert.rejects(
    () => geoStrategy().start({ symbol: 'BTCUSDT', initialSize: 1000, ladderLevelsPerSide: 2 }),
    /whole number between 3 and 10/,
  );
  await assert.rejects(
    () => geoStrategy().start({ symbol: 'BTCUSDT', initialSize: 1000, ladderLevelsPerSide: 11 }),
    /whole number between 3 and 10/,
  );
});

test('start() rejects a non-integer level count', async () => {
  await assert.rejects(
    () => geoStrategy().start({ symbol: 'BTCUSDT', initialSize: 1000, ladderLevelsPerSide: 5.5 }),
    /whole number between 3 and 10/,
  );
});

test('start() scales the minimum initial size with the chosen level count', async () => {
  // 8 levels needs 8 * 10 = 80 USDT. 79 must be refused even though it clears
  // the old flat 50.
  await assert.rejects(
    () => geoStrategy().start({ symbol: 'BTCUSDT', initialSize: 79, ladderLevelsPerSide: 8 }),
    /80/,
    'the gate must name the scaled minimum',
  );
});

// REGRESSION PIN. The start-time minNotional gate used to divide by the CONSTANT
// (LADDER_LEVELS_PER_SIDE) while _legNotional() divides by the FIELD
// (this.levelsPerSide). With the constant it validates a 5-rung ladder against an
// N-rung runtime, and for N > 5 it is TOO PERMISSIVE. Here: 10 levels, 100 USDT,
// minNotional 15. The buggy gate checks 100/5 = 20 >= 15 and PASSES; the real legs
// are 100/10 = 10, below the exchange minimum. It must reject.
test('start() sizes the minNotional gate from the CHOSEN level count, not the default', async () => {
  const s = geoStrategy();
  stubBootInternals(s);
  s.exchangeInfoCache = { BTCUSDT: { minNotional: 15 } };
  s.getWalletBalance = async () => 1000;
  try {
    await assert.rejects(
      () => s.start({ symbol: 'BTCUSDT', initialSize: 100, ladderLevelsPerSide: 10, leverage: 10 }),
      /minimum notional/i,
      'legs are 100/10 = 10 USDT, under the 15 USDT minNotional — must refuse',
    );
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }
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

// ——— Task 13: flattenCount ——————————————————————————————————————————————

// A strategy sitting on an open position at the anchor, ready to flatten.
function flattenReady() {
  const s = ladderStrategy();
  s.activePosition = { quantity: 1, notional: 1000, entryPrice: 100 };
  s.currentSide = 'LONG';
  s.ladderLines[0].state = 'POSITION_OPEN';
  s._closeConsolidated = async () => true;
  s._computeLadderBaseSize = async () => s._ladderBaseSize;
  s._computeAccLoss = () => 0;
  return s;
}

test('_flattenAtAnchor increments flattenCount on every committed flatten', async () => {
  const s = flattenReady();
  assert.equal(s.flattenCount, 0, 'a fresh cycle starts at zero');

  await s._flattenAtAnchor();
  assert.equal(s.flattenCount, 1);

  // Re-arm and flatten again — the count accumulates across a cycle.
  s.activePosition = { quantity: 1, notional: 1000, entryPrice: 100 };
  s.currentSide = 'LONG';
  s.ladderLines[0].state = 'POSITION_OPEN';
  await s._flattenAtAnchor();
  assert.equal(s.flattenCount, 2);
});

test('_flattenAtAnchor counts a legs-open-but-flat reset, matching the ANCHOR_FLATTEN trail', async () => {
  // No position, but a leg is still marked open: this path skips the close yet
  // still re-sizes, rebuilds and writes ANCHOR_FLATTEN — so it must count.
  const s = flattenReady();
  s.activePosition = null;
  s.currentSide = null;
  let flows = 0;
  s._writeStrategyFlow = async (t) => { if (t === 'ANCHOR_FLATTEN') flows += 1; };
  await s._flattenAtAnchor();
  assert.equal(s.flattenCount, 1);
  assert.equal(flows, 1, 'flattenCount must track ANCHOR_FLATTEN one-for-one');
});

test('_flattenAtAnchor does NOT count a no-op oscillation', async () => {
  const s = ladderStrategy();   // nothing open, every leg EMPTY
  await s._flattenAtAnchor();
  assert.equal(s.flattenCount, 0, 'an early return is not a flatten');
});

test('_hasNoTradingActivity: a flatten alone marks the cycle as having traded', () => {
  const s = ladderStrategy();
  assert.equal(s._hasNoTradingActivity(), true, 'an untouched cycle is no-trade');
  s.flattenCount = 1;
  assert.equal(s._hasNoTradingActivity(), false, 'a flatten is trading activity');
});

// ——— _closeConsolidated: currentSide state-drift guard ——————————————————

test('_closeConsolidated: currentSide missing is repopulated by a refresh from Binance before closing', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5 };
  s.currentSide = null;
  s._refreshCurrentPosition = async () => { s.currentSide = 'LONG'; };
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty) => { orderArgs = { symbol, side, qty }; return { orderId: 1 }; };
  // The close itself succeeds (WS confirms the fill) — this test is about the
  // currentSide repopulation, not about fill verification tiering.
  s._waitForOrderFillConfirmation = async () => true;
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

// ——— _closeConsolidated: tiered fill verification (WS -> REST ack -> REST position check) ———
//
// _waitForOrderFillConfirmation never REJECTS — it resolves true (WS
// confirmed) or false (3s timeout) — so a close must not be treated as done
// merely because the order was placed without throwing. These tests pin the
// three-tier contract mirroring _resolveFill's tiering on the open path.

test('_closeConsolidated: unverifiable close (WS times out, no REST ack, refresh still shows it open) returns false and leaves state intact', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.placeMarketOrder = async () => ({ orderId: 1 }); // no executedQty in the ack
  s._waitForOrderFillConfirmation = async () => false; // WS timed out
  s._refreshCurrentPosition = async () => {
    // Binance still reports the position open — the close did not land.
    s._lastPositionRefreshFailed = false;
    s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
    s.currentSide = 'LONG';
  };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const result = await s._closeConsolidated('test');

  assert.equal(result, false, 'an unverified close must never be reported as success');
  assert.ok(s.activePosition && s.activePosition.quantity === 0.5, 'activePosition must stay intact, not dropped');
  assert.equal(s.currentSide, 'LONG', 'currentSide must not be cleared on an unverified close');
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('could NOT be verified')),
    'a loud warning is logged instead of a silent drop',
  );
});

test('_closeConsolidated: tier 2 — a full REST-ack executedQty verifies the close when WS times out', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.placeMarketOrder = async () => ({ orderId: 1, executedQty: '0.5' });
  s._waitForOrderFillConfirmation = async () => false; // WS timed out
  let refreshCalled = false;
  s._refreshCurrentPosition = async () => { refreshCalled = true; };

  const result = await s._closeConsolidated('test');

  assert.equal(result, true, 'a full REST-ack fill verifies the close without needing tier 3');
  assert.equal(refreshCalled, false, 'tier 2 succeeding must short-circuit before tier 3\'s REST refresh');
  assert.equal(s.activePosition, null, 'position state is cleared once verified');
  assert.equal(s.currentSide, null);
});

test('_closeConsolidated: tier 3 — a REST refresh confirming flat verifies the close when WS and the ack both miss', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.placeMarketOrder = async () => ({ orderId: 1 }); // no executedQty
  s._waitForOrderFillConfirmation = async () => false; // WS timed out
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false;
    s.activePosition = null; // Binance confirms flat
    s.currentSide = null;
  };

  const result = await s._closeConsolidated('test');

  assert.equal(result, true, 'a confirmed-flat REST refresh verifies the close');
  assert.equal(s.activePosition, null);
  assert.equal(s.currentSide, null);
});

test('_closeConsolidated: tier 3 — a FAILED refresh must NOT read as verified (unknown must never read as closed)', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.placeMarketOrder = async () => ({ orderId: 1 });
  s._waitForOrderFillConfirmation = async () => false; // WS timed out
  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = true; }; // Binance unreachable
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const result = await s._closeConsolidated('test');

  assert.equal(result, false, 'unknown state must never be treated as a verified close');
  assert.ok(s.activePosition && s.activePosition.quantity === 0.5, 'activePosition must NOT be cleared on an unresolved refresh');
  assert.equal(s.currentSide, 'LONG');
  assert.ok(logs.some((m) => m.includes('WARNING')), 'a loud warning is logged, never a silent drop');
});

// ——— _flattenAtAnchor / _flattenGrid: an unverified close must abort the leg-ledger rebuild ———
//
// buildLadder()/the EMPTY-reset loop wipe the POSITION_OPEN leg ledger — the
// ONLY record of open inventory (_closeQuantity sizes every close from it).
// Rebuilding after an unverified close would orphan a live position: it stays
// open on Binance while the bot's own books read "flat, fresh ladder" and
// nothing ever tries to close it again.

test('_flattenAtAnchor: an unverified close aborts the rebuild — flattenCount unchanged, ladder left intact', async () => {
  const s = ladderStrategy({ anchor: 100 });
  const longLegs = s.ladderLines.filter(l => l.direction === 'LONG').slice(0, 2);
  longLegs.forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = { quantity: 1, entryPrice: 100.3, avgEntry: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  // Seed a live TREND state — the anchor flatten is reachable from TREND too
  // (it is one of TREND's two exits). If the abort skipped only the rebuild
  // but not the mode reset above it, these would still get clobbered to
  // RANGE/null/null even though the close was never verified.
  s.ladderMode = 'TREND';
  s.trendDirection = 'LONG';
  s.finalTpPrice = 12345;
  s._closeConsolidated = async () => false; // the close could not be verified
  let sizingCalled = false;
  s._computeLadderBaseSize = async () => { sizingCalled = true; return s._ladderBaseSize; };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s._flattenAtAnchor();

  assert.equal(s.flattenCount, 0, 'an aborted flatten must not count as committed');
  // Vacuous by design (the anchor never moves in `_flattenAtAnchor` even on a
  // committed flatten) — kept only as a cheap guard against a future regression.
  assert.equal(s.anchor, 100, 'the anchor must not move on an aborted flatten');
  assert.equal(sizingCalled, false, 'no re-sizing churn when the close was never verified');
  // The abort must skip the WHOLE reset block, not just the ladder rebuild —
  // otherwise TREND state gets silently discarded even though the position
  // stayed open and untracked.
  assert.equal(s.ladderMode, 'TREND', 'ladderMode must not be reset on an aborted flatten');
  assert.equal(s.trendDirection, 'LONG', 'trendDirection must not be reset on an aborted flatten');
  assert.equal(s.finalTpPrice, 12345, 'finalTpPrice must not be nulled on an aborted flatten');
  // Read off the LIVE array, not the captured `longLegs` references —
  // buildLadder allocates NEW leg objects and _flattenAtAnchor replaces
  // `this.ladderLines` wholesale, so the captured objects would stay
  // POSITION_OPEN even if the ladder WAS rebuilt underneath them — asserting
  // on `longLegs` would prove nothing.
  assert.equal(
    s.ladderLines.filter((l) => l.state === 'POSITION_OPEN').length, 2,
    'the open-leg ledger must survive — it is the only record of the live position',
  );
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('ANCHOR FLATTEN aborted')),
    'a loud warning is logged instead of a silent rebuild',
  );
});

test('_flattenGrid: an unverified close keeps the leg ledger intact and returns false', async () => {
  const s = ladderStrategy({ anchor: 100 });
  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1);
  openLeg.state = 'POSITION_OPEN';
  openLeg.quantity = 0.5;
  s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s._closeConsolidated = async () => false; // unverified
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const result = await s._flattenGrid('test');

  assert.equal(result, false, 'an unverified flatten must report failure, not success');
  // Read off the LIVE array, not the captured `openLeg` reference. This works
  // today only because `_flattenGrid` mutates legs in place — if it ever
  // reallocated (as `buildLadder` does) a stale reference would keep reading
  // POSITION_OPEN even after a wipe underneath it. Same discipline as the
  // `_flattenAtAnchor` test above.
  const stillOpen = s.ladderLines.filter((l) => l.state === 'POSITION_OPEN');
  assert.equal(stillOpen.length, 1, 'the leg ledger must survive an unverified close');
  assert.equal(stillOpen[0].quantity, 0.5);
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('leg ledger left INTACT')),
    'a loud warning is logged instead of a silent leg-wipe',
  );
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

test('_computeLadderBaseSize: a full gauge freezes escalation (returns the locked _lastLadderSize)', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.initialCapital = 10000;
  s.harvestLossThreshold = 0.30;
  s.cycleAccumulatedLoss = 5000; // gauge full
  s._computeAccLoss = () => 5000; // TRAP: _computeLadderBaseSize overwrites accLoss on entry — stub it
  s._lastLadderSize = 12000;      // sentinel: the last GROWN size
  // Gauge-full freeze returns _lastLadderSize before ever touching the
  // wallet, so no getTotalMarginBalance stub is needed here. This is the
  // gauge's sole remaining job: a re-anchor/harvest at a full gauge keeps
  // the locked grown size rather than re-sizing fresh.
  assert.equal(await s._computeLadderBaseSize(), 12000, 'reuses the locked size instead of growing');
});

test('_computeLadderBaseSize: a NOT-full gauge re-sizes fresh, ignoring any locked _lastLadderSize sentinel', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.initialCapital = 10000;
  s.harvestLossThreshold = 0.30;    // full at 3000
  s.cycleAccumulatedLoss = 50;       // below the gate → NOT full
  s._computeAccLoss = () => 50;      // TRAP: stub so the formula proposes a fresh 12000
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s._lastLadderSize = 99999;         // stale sentinel that MUST NOT be returned
  s.getTotalMarginBalance = async () => 1e9; // margin cap out of the way
  const sized = await s._computeLadderBaseSize();
  assert.equal(sized, 12000, 'gauge not full → fresh compute (50*0.20/0.005 = 2000 additional), not the 99999 sentinel');
  assert.notEqual(sized, 99999, 'the stale locked size is ignored when the gauge is not full');
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
  // FIX D: `_computeLadderBaseSize`'s first line overwrites
  // `cycleAccumulatedLoss` with `_computeAccLoss()`'s return. Without
  // stubbing it, the real `_computeAccLoss` (accumulators are all 0 in this
  // fixture) resets accLoss to 0, the formula floors at currentInitialSize
  // (10000) BEFORE the margin-headroom cap is ever consulted, and the
  // assertion below passed trivially — it would still pass with
  // `_applyMarginHeadroomCap` deleted entirely. Stubbing this makes the
  // formula actually propose 12000 so the cap has something to bite.
  s._computeAccLoss = () => 50;
  s.getTotalMarginBalance = async () => 100; // live balance during drawdown is tiny
  const uncapped = s._computeFormulaSize();
  assert.equal(uncapped, 12000, 'sanity: the formula (before any cap) proposes 12000 for this accLoss');
  const sized = await s._computeLadderBaseSize();
  assert.equal(sized, s.currentInitialSize, 'the live-balance headroom cap bites and floors to currentInitialSize (10000), not the uncapped 12000');
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

test('FIX C: getTotalMarginBalance() resolving to NaN (a 200 with a missing/malformed field, no throw) still fails CLOSED — capped, never uncapped', async () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 50;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s._computeAccLoss = () => 50; // formula would otherwise propose 12000 uncapped
  s.getTotalMarginBalance = async () => NaN; // does NOT throw — the exact gap this fix closes
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  const sized = await s._computeLadderBaseSize();
  assert.equal(sized, s.currentInitialSize, 'a NaN wallet balance must never read as infinite headroom — cap to the safe floor, not the uncapped 12000');
  assert.ok(logs.some((m) => m.includes('fail-closed') || m.includes('invalid') || m.includes('unknown')), 'the fail-closed cap is logged');
});

test('FIX C: _applyMarginHeadroomCap directly — a non-finite wallet caps to currentInitialSize instead of returning proposedSize uncapped', () => {
  const s = ladderStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.addLog = async () => {};
  assert.equal(s._applyMarginHeadroomCap(12000, NaN), 10000, 'NaN wallet must fail closed');
  assert.equal(s._applyMarginHeadroomCap(12000, undefined), 10000, 'undefined wallet must fail closed');
  assert.equal(s._applyMarginHeadroomCap(12000, 0), 10000, 'zero wallet must fail closed too (previously fell through to uncapped)');
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

test('_closeQuantity rounds the summed leg qty to stepSize (guards Binance -1111)', () => {
  // stepSize 0.01 → quantityPrecision 2, so 0.28×3 = 0.8400000000000001 must
  // come back as 0.84, not the raw float (which Binance rejects on close).
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();
  s.ladderLines
    .filter((l) => l.direction === 'LONG')
    .slice(0, 3)
    .forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.28; });
  s.activePosition = { quantity: 0.84, entryPrice: 100.6, avgEntry: 100.6, notional: 84.5, unrealizedPnl: 0 };

  const rawSum = s.ladderLines
    .filter((l) => l.state === 'POSITION_OPEN')
    .reduce((a, l) => a + l.quantity, 0);
  assert.notEqual(rawSum, 0.84, 'precondition: 0.28×3 carries an IEEE-754 artifact');

  const qty = s._closeQuantity();
  assert.equal(qty, 0.84, 'summed leg qty must round to the stepSize, not 0.8400000000000001');
  assert.equal(qty.toFixed(2), '0.84');
});

test('placeMarketOrder rounds the quantity to stepSize before sending (order-layer -1111 guard)', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();
  let sentQty = null;
  s.makeProxyRequest = async (_path, _method, params) => { sentQty = params.quantity; return { orderId: 1, status: 'FILLED' }; };
  await s.placeMarketOrder('BTCUSDT', 'SELL', 0.8400000000000001, undefined, { reduceOnly: true });
  assert.equal(sentQty, 0.84, 'the order layer must floor the FP artifact even if the caller does not');
});

test('harvestNow queues when a position is open and the gauge is NOT full (gauge no longer gates)', async () => {
  const s = ladderStrategy();                        // initialCapital 1000, 8% threshold => full at 80
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.cycleAccumulatedLoss = 40;                        // well below the 80 gate → gauge NOT full
  assert.equal(s._isGaugeFull(), false, 'precondition: the gauge is genuinely not full');
  const res = await s.harvestNow();
  assert.equal(res.queued, true, 'queues regardless of gauge fullness — the gauge no longer gates the action');
  assert.equal(s._manualHarvestRequested, true, 'latch set whenever a position is open');
});

test('harvestNow queues when a position is open AND the gauge is full', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.cycleAccumulatedLoss = 100;                       // >= 80 => gauge full
  const res = await s.harvestNow();
  assert.equal(res.queued, true);
  assert.equal(s._manualHarvestRequested, true, 'latch set once eligible');
});

test('harvest re-anchors to the CURRENT price, unlike the anchor flatten', async () => {
  const s = ladderStrategy({ anchor: 100 });
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 10, avgEntry: 100.3, entryPrice: 100.3, notional: 1003 };
  s.currentPrice = 103;
  s._closeConsolidated = async () => { s.activePosition = null; return true; };
  s._computeAccLoss = () => 0;
  s.getTotalMarginBalance = async () => 1e9;
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.anchor, 103, 'the harvest re-anchors; the anchor flatten does not');
  assert.equal(s.ladderMode, 'RANGE');
  assert.ok(s.ladderLines.every(l => l.state === 'EMPTY'));
});

// ——— _harvestToFlat: a failed close must abort the rebuild, not orphan the position ———
//
// initializeLadder() resets every leg to EMPTY, and POSITION_OPEN is the ONLY
// record of what this bot has open (_closeQuantity sizes every close off it).
// Rebuilding after a failed close would leave a real position open on Binance
// while the bot's own books read "flat, fresh ladder" — nothing would ever try
// to close it again. These three tests pin: (1) a close that THROWS with
// inventory open aborts and leaves the ladder intact, (2) a close that
// SUCCEEDS still re-anchors and rebuilds exactly as before, (3) genuinely
// nothing-to-close still re-anchors — the abort must not fire on a real no-op.

test('_harvestToFlat: close throws with inventory open -> aborts, ladder left intact, position still tracked', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy({ anchor: 100 });
  const longLegs = s.ladderLines.filter(l => l.direction === 'LONG').slice(0, 2);
  longLegs.forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.currentPrice = 110; // distinct from the anchor — must NOT be adopted
  s.placeMarketOrder = async () => { throw new Error('-1001 Internal error'); };

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 0, 'harvestCount must not increment on an aborted close');
  assert.equal(s.anchor, 100, 'anchor must stay put — no re-anchor on a failed close');

  // Read off the LIVE array, not the captured `longLegs` references: buildLadder
  // allocates NEW leg objects and initializeLadder replaces `this.ladderLines`
  // wholesale, so the captured objects would stay POSITION_OPEN even if the
  // ladder WAS rebuilt underneath them — asserting on `longLegs` proves nothing.
  assert.equal(s.ladderLines.filter((l) => l.state === 'POSITION_OPEN').length, 2,
    'the open-leg ledger must survive — it is the only record of the live position');
  assert.equal(s._tradingSeqInProgress, false, 'the seq lock must still release on the abort path');
});

test('_harvestToFlat: close succeeds -> harvestCount increments and re-anchors on the live price (unchanged behavior)', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy({ anchor: 100 });
  const longLegs = s.ladderLines.filter(l => l.direction === 'LONG').slice(0, 2);
  longLegs.forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.currentPrice = 110; // distinct from the anchor — the re-anchor target
  s.placeMarketOrder = async () => ({ orderId: 1, status: 'FILLED' });
  // The close succeeds (WS confirms the fill) — tier 1 of _closeConsolidated's
  // verification. Was `async () => {}` (falsy/unverified), which under the
  // tightened contract now reads as an UNVERIFIED close; express the intended
  // success explicitly instead.
  s._waitForOrderFillConfirmation = async () => true;
  s.getTotalMarginBalance = async () => 1e9;

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 1, 'harvestCount increments on a genuine close');
  assert.equal(s.anchor, 110, 're-anchored on the live price');
  assert.ok(s.ladderLines.every((l) => l.state !== 'POSITION_OPEN'), 'ladder rebuilt — no leg left open');
});

test('_harvestToFlat: genuinely flat -> still re-anchors — the abort must not fire when nothing was open', async () => {
  const s = ladderStrategy({ anchor: 100 });
  s.activePosition = null;
  s.currentPrice = 105;
  s.getTotalMarginBalance = async () => 1e9;

  await s._harvestToFlat('manual_harvest');

  // A no-op close must not be mistaken for a failed one (the anchor still
  // moves), but per the accounting split it is a RE-ANCHOR, not a HARVEST —
  // see the dedicated "accounting split" tests below for the counters.
  assert.equal(s.harvestCount, 0, 'a flat re-anchor must not be counted as a harvest');
  assert.equal(s.reanchorCount, 1, 'a flat re-anchor still bumps reanchorCount');
  assert.equal(s.anchor, 105, 're-anchors normally when there was nothing to close');
});

test('_harvestToFlat: close returns false WITHOUT throwing (side unresolved) -> aborts, ladder left intact', async () => {
  const s = ladderStrategy({ anchor: 100 });
  // No legs are marked open, so _closeConsolidated's leg-direction fallback
  // finds nothing; combined with currentSide null, the initial side lookup
  // fails outright. Only `activePosition` carries the (drifted) inventory —
  // exactly the "no legs behind it, no side in memory" case the code calls out.
  s.currentSide = null;
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentPrice = 110; // distinct from the anchor — must NOT be adopted
  // `_refreshCurrentPosition` is stubbed to a no-op by the `ladderStrategy()`
  // fixture — it leaves `currentSide` null while the inventory (activePosition)
  // remains, so `_closeConsolidated`'s post-refresh side check ALSO fails and
  // it logs the "side could not be resolved" warning and returns `false`
  // WITHOUT throwing (as opposed to the earlier throw-based abort test above).

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 0, 'harvestCount must not increment on an aborted close');
  assert.equal(s.anchor, 100, 'anchor must stay put — no re-anchor on an unresolved-side abort');
  assert.ok(s.activePosition && s.activePosition.quantity > 0, 'the position must still be tracked, not silently dropped');
  assert.equal(s._tradingSeqInProgress, false, 'the seq lock must still release on the abort path');
});

test('_harvestToFlat: _closeConsolidated refreshes mid-close and proves genuinely flat -> does NOT abort, re-anchors', async () => {
  const s = ladderStrategy({ anchor: 100 });
  // Stale PRE-close reading, same shape as the previous test: no legs marked
  // open, currentSide null, so the initial side lookup fails and
  // `_closeConsolidated` refreshes internally — but THIS time the refresh
  // proves the account genuinely flat (the case Item 1's guard fix targets:
  // a pre-close snapshot would read "had inventory" here and wrongly abort).
  s.currentSide = null;
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s._refreshCurrentPosition = async () => {
    s.activePosition = null; // REST confirms flat
    s.currentSide = null;
  };
  s.currentPrice = 105;
  s.getTotalMarginBalance = async () => 1e9;

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 0, 'the refresh proved flat — nothing was actually closed, so it is a RE-ANCHOR, not a harvest');
  assert.equal(s.reanchorCount, 1, 'but it still counts as a re-anchor');
  assert.equal(s.anchor, 105, 're-anchors on the live price — the abort must not fire on a stale pre-close reading');
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

test('flattenCount survives a save/restore round-trip', async () => {
  const src = ladderStrategy();
  src.flattenCount = 7;
  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(src);
  assert.equal(doc.flattenCount, 7, 'saveState must persist it');

  const dst = stubResumeIO(new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  // Without this the count silently resets to 0 on every VM restart, and
  // _hasNoTradingActivity would then delete a real cycle's doc as "no-trade".
  assert.equal(dst.flattenCount, 7, 'resume must restore it');
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

test('getStatus and the heartbeat both emit flattenCount for the Flattens tile', () => {
  // The frontend types itself off this payload: a field the backend never
  // emits is a silent `undefined` at runtime with no type error.
  const s = ladderStrategy({ anchor: 100 });
  s.flattenCount = 3;
  assert.equal(s.getStatus().flattenCount, 3);
  assert.equal(s.getHeartbeatPayload().flattenCount, 3);
});

test('reversalCount is gone from the emitted payloads', () => {
  const s = ladderStrategy({ anchor: 100 });
  assert.equal('reversalCount' in s.getStatus(), false, 'the ladder has no reversal concept');
  assert.equal('reversalCount' in s.getHeartbeatPayload(), false);
});

test('saveState writes the ANCHOR_LADDER type tags for boot recovery', async () => {
  const s = ladderStrategy({ anchor: 100 });
  let written = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { written = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(s);
  assert.equal(written.type, 'ANCHOR_LADDER');
  assert.equal(written.strategyType, 'anchorLadder');
});

test('_lastLadderSize survives a save/resume round trip', async () => {
  const src = ladderStrategy({ anchor: 100, base: 12000 });
  src._lastLadderSize = 15000;

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await AnchorLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  assert.equal(dst._lastLadderSize, 15000, 'the martingale escalation freeze must survive a restart');
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

test('stop({flatten:true}) closes the legs when the position API is down and memory has no position at all', async () => {
  // The scenario the old "refuse to close on unknown state" guard mishandled:
  // legs say 1.4 is open, `activePosition`/`currentSide` are both null (their
  // only writer is the REST refresh, which is failing), and Binance cannot be
  // reached. The guard closed NOTHING and left the position stranded. The legs
  // know both the size and the side, so the close proceeds on their word.
  const s = stubStopTail(ladderStrategy());
  delete s._refreshCurrentPosition; // use the REAL implementation

  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1);
  openLeg.state = 'POSITION_OPEN';
  openLeg.quantity = 1.4;
  s.activePosition = null;
  s.currentSide = null;
  s.getCurrentPositions = async () => { throw new Error('-1001 Internal error'); };

  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty, price, opts) => { orderArgs = { side, qty, opts }; return {}; };

  await s.stop({ flatten: true });

  assert.deepEqual(
    orderArgs, { side: 'SELL', qty: 1.4, opts: { reduceOnly: true } },
    'the leg qty AND the leg direction drive the close — neither needs the dead position API',
  );
  assert.ok(!logs.some((m) => m.includes('position confirmed flat')), 'must never claim confirmed-flat when the state is unknown');
  assert.ok(!logs.some((m) => m.includes('nothing to flatten')), 'must never claim nothing-to-flatten when the state is unknown');
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('FINAL STATE UNKNOWN')),
    'the residual verification still cannot confirm flat, and says so loudly',
  );
  assert.equal(s.executionState, 'TERMINATED', 'stop() still completes termination — it never hangs open');
});

test('stop({flatten:true}): an unverified _flattenGrid close makes stop() retry via _closeConsolidated exactly ONCE more, not in a loop', async () => {
  // `_flattenGrid` can now return false (unverified close). stop()'s fallback
  // branch then fires a second reduceOnly close for the same position — safe
  // (reduceOnly can never flip a position) and a desirable retry, but newly
  // reachable and previously untested. Every close attempt below is
  // unverifiable (WS times out, no REST-ack qty, refresh still shows it
  // open), so if the retry were ever turned into an unbounded loop this test
  // must catch it — hence counting EVERY call in an array rather than
  // capturing only the last one into a single variable.
  const s = stubStopTail(ladderStrategy());
  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1);
  openLeg.state = 'POSITION_OPEN';
  openLeg.quantity = 0.6;
  s.activePosition = { quantity: 0.6, entryPrice: 100, avgEntry: 100, notional: 60, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s._waitForOrderFillConfirmation = async () => false; // tier 1 always times out
  s._refreshCurrentPosition = async () => {}; // tier 3 + residual check: leaves activePosition open, never fails
  const orderCalls = [];
  s.placeMarketOrder = async (symbol, side, qty, price, opts) => {
    orderCalls.push({ symbol, side, qty, opts });
    return { orderId: orderCalls.length }; // ack carries no executedQty -> tier 2 also misses
  };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s.stop({ flatten: true });

  assert.equal(orderCalls.length, 2, 'exactly two reduceOnly close attempts: _flattenGrid\'s, then stop()\'s fallback retry — never more');
  assert.ok(
    orderCalls.every((c) => c.side === 'SELL' && c.opts?.reduceOnly === true),
    'both attempts close the same LONG position the same way',
  );
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('residual')),
    'the residual left open after both failed attempts is reported',
  );
  assert.equal(s.executionState, 'TERMINATED', 'stop() still completes termination despite both closes failing to verify');
});

// ——— Adversarial re-review fix (Fix B) ———————————————————————————————————
//
// FIX B: `_enterTrend` armed Final TP off `_recomputeFinalTpPrice()`
// regardless of whether its own arming refresh succeeded, baking a wrong
// exit price for the rest of the cycle (Final TP is armed HERE AND ONLY
// HERE — no later leg fills occur in TREND to correct it).

test('FIX B: _enterTrend does NOT arm Final TP when the arming refresh fails (twice) — clears the stale value and logs loudly', async () => {
  const s = ladderStrategy({ anchor: 100 });
  s.ladderLines.filter(l => l.direction === 'LONG').forEach(l => { l.state = 'POSITION_OPEN'; l.quantity = 20; l.fillPrice = l.price; });
  s.activePosition = { quantity: 80, entryPrice: 100.3, avgEntry: 100.3, notional: 8024, unrealizedPnl: 0 }; // stale: only 4 legs' worth
  s.currentSide = 'LONG';
  s.finalTpPrice = 101.9305; // a stale value left by the outermost leg's own (also-stale) _postExecuteBookkeeping recompute
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;

  let refreshCalls = 0;
  s._refreshCurrentPosition = async () => {
    refreshCalls++;
    s._lastPositionRefreshFailed = true; // fails on the initial attempt AND the retry
  };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s._enterTrend('LONG');

  assert.equal(refreshCalls, 2, 'retries once before giving up');
  assert.equal(s._trendFinalTpArmed, false, 'must not be marked armed');
  assert.equal(s.finalTpPrice, null, 'must NOT arm from unverified data — the stale pre-existing value is cleared, not trusted');
  assert.ok(logs.some((m) => m.includes('WARNING')), 'a loud WARNING is logged instead of arming silently');
});

test('FIX B: _enterTrend arms Final TP normally when the refresh succeeds on the first try', async () => {
  const s = ladderStrategy({ anchor: 100 });
  s.ladderLines.filter(l => l.direction === 'LONG').forEach(l => { l.state = 'POSITION_OPEN'; l.quantity = 20; l.fillPrice = l.price; });
  s.currentSide = 'LONG';
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;

  let refreshCalls = 0;
  s._refreshCurrentPosition = async () => {
    refreshCalls++;
    s._lastPositionRefreshFailed = false;
    s.activePosition = { quantity: 100, entryPrice: 100.4, avgEntry: 100.4, notional: 10040, unrealizedPnl: 0 };
  };

  await s._enterTrend('LONG');

  assert.equal(refreshCalls, 1, 'no retry needed when the first refresh succeeds');
  assert.equal(s._trendFinalTpArmed, true);
  assert.ok(s.finalTpPrice != null, 'Final TP is armed from the verified position');
});

test('FIX B: _reconcileTrendInvariant self-heals Final TP once the refresh recovers — not permanently stuck unarmed', async () => {
  const s = ladderStrategy({ mode: 'TREND', anchor: 100 });
  s.trendDirection = 'LONG';
  s.finalTpPrice = null; // arming failed at the original TREND transition => derived unarmed
  s.currentSide = 'LONG';
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;

  let refreshCalls = 0;
  s._refreshCurrentPosition = async () => {
    refreshCalls++;
    s._lastPositionRefreshFailed = false; // the retry now succeeds
    s.activePosition = { quantity: 100, entryPrice: 100.4, avgEntry: 100.4, notional: 10040, unrealizedPnl: 0 };
  };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const healed = await s._reconcileTrendInvariant();

  assert.equal(refreshCalls, 1);
  assert.equal(healed, true);
  assert.equal(s._trendFinalTpArmed, true, 'now marked armed');
  assert.ok(s.finalTpPrice != null, 'Final TP is now armed from the freshly verified position');
  assert.ok(logs.some((m) => m.includes('armed')), 'the successful self-heal is logged');
});

test('FIX B: _reconcileTrendInvariant keeps retrying (does not crash or wedge) while the refresh keeps failing', async () => {
  const s = ladderStrategy({ mode: 'TREND', anchor: 100 });
  s.trendDirection = 'LONG';
  s.finalTpPrice = null; // derived unarmed
  s.currentSide = 'LONG';

  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = true; };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const healed = await s._reconcileTrendInvariant();

  assert.equal(healed, false);
  assert.equal(s._trendFinalTpArmed, false, 'still not armed — nothing to self-heal from yet');
  assert.equal(s.finalTpPrice, null);
  assert.ok(logs.some((m) => m.includes('WARNING')), 'a loud WARNING, never a silent no-op');
});

// ——— I2: a reconciler may only report the state it actually reached ————————
//
// `_reconcileTrendInvariant` armed Final TP and then marked the invariant
// ACHIEVED without checking that it was. A refresh that SUCCEEDS and honestly
// answers "flat" derives no target — so it logged "Final TP armed at N/A",
// returned success, and (while the armed flag was still stored state)
// short-circuited its own retry forever.
//
// Reachable via a process death inside `_flattenAtAnchor` between
// `_closeConsolidated()` and `saveState()` — a window containing a real
// 100-500ms `getTotalMarginBalance()` round trip — which persists
// TREND + every leg POSITION_OPEN while Binance is already flat.

// The persisted contradiction that window leaves behind.
function trendButFlatOnBinance() {
  const s = ladderStrategy({ mode: 'TREND', anchor: 100 });
  s.trendDirection = 'LONG';
  s.ladderLines.filter(l => l.direction === 'LONG').forEach((l) => {
    l.state = 'POSITION_OPEN'; l.quantity = 20; l.fillPrice = l.price;
  });
  s.finalTpPrice = null;
  s.desiredProfitUSDT = 100;
  // The refresh SUCCEEDS — Binance simply says flat (the close committed
  // before the crash). This is the case the old code called an "arm".
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false;
    s.activePosition = null;
    s.currentSide = null;
  };
  return s;
}

test('I2: reconcile does NOT claim an arm when a successful refresh resolves to FLAT', async () => {
  const s = trendButFlatOnBinance();
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };

  const healed = await s._reconcileTrendInvariant();

  assert.equal(healed, false, 'must NOT report success it did not achieve');
  assert.equal(s.finalTpPrice, null, 'no target was derived');
  assert.equal(s._trendFinalTpArmed, false, 'and so it is not armed');
  assert.equal(
    logs.some((m) => m.includes('armed at') && m.includes('N/A')), false,
    'must never log the nonsense "Final TP armed at N/A"',
  );
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('FLAT')),
    'the TREND-but-flat contradiction is reported loudly, naming what it found',
  );
});

test('I2: the arming retry is not short-circuited — it retries on a later tick and self-heals', async () => {
  const s = trendButFlatOnBinance();
  s.addLog = async () => {};

  const first = await s._reconcileTrendInvariant();
  assert.equal(first, false);
  assert.equal(s._trendFinalTpArmed, false);

  // A later tick, past the backoff: the position reappears (or was there all
  // along and Binance finally reports it). The reconcile MUST still be live.
  s._trendArmRetryLastTs = Date.now() - 60_000;
  s.cycleAccumulatedLoss = 89;
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false;
    s.currentSide = 'LONG';
    s.activePosition = { quantity: 100, entryPrice: 100.4, avgEntry: 100.4, notional: 10040, unrealizedPnl: 0 };
  };

  const second = await s._reconcileTrendInvariant();

  assert.equal(second, true, 'the retry was never short-circuited, so it can still self-heal');
  assert.ok(s.finalTpPrice != null, 'Final TP armed once a real position was verified');
  assert.equal(s._trendFinalTpArmed, true);
});

test('I2: the unarmed retry is rate-limited — it does not hit Binance on every tick', async () => {
  const s = trendButFlatOnBinance();
  s.addLog = async () => {};
  let refreshCalls = 0;
  s._refreshCurrentPosition = async () => {
    refreshCalls++;
    s._lastPositionRefreshFailed = false;
    s.activePosition = null;
    s.currentSide = null;
  };

  // 50 ticks in the same instant — the tick loop's real cadence.
  for (let i = 0; i < 50; i++) await s._reconcileTrendInvariant();

  assert.equal(refreshCalls, 1, 'a permanently-unarmed TREND must not hammer Binance REST once per price tick');

  s._trendArmRetryLastTs = Date.now() - 60_000; // interval elapsed
  await s._reconcileTrendInvariant();
  assert.equal(refreshCalls, 2, 'but it DOES retry once the backoff interval passes — never gives up');
});

// ——— I1: finalTpPrice may only ever be derived from VERIFIED position data ——
//
// `_trendFinalTpArmed` used to be a stored field shadowing `finalTpPrice`, and
// `_recomputeFinalTpPrice` wrote a target from whatever `activePosition` held
// — including a STALE one left behind by a failed refresh. The TREND exit gate
// is `if (this.finalTpPrice && ...)`: it trusts ANY non-null value and never
// consults the flag. So the 8-hourly funding poll, the user's profit-target
// pencil, or resume could each resurrect the exact unverified target
// `_enterTrend` had deliberately refused — with armed still false — and the
// bot would close the cycle at it.

// The shared setup: TREND, arming refused (finalTpPrice null), but a STALE
// non-null activePosition still in memory from before the refresh failed.
function unarmedTrendWithStalePosition() {
  const s = ladderStrategy({ mode: 'TREND', anchor: 100 });
  s.trendDirection = 'LONG';
  s.currentSide = 'LONG';
  s.activePosition = { quantity: 80, entryPrice: 100.3, avgEntry: 100.3, notional: 8024, unrealizedPnl: 0 };
  s._lastPositionRefreshFailed = true; // state is UNKNOWN — the position above is a stale guess
  s.finalTpPrice = null;               // _enterTrend refused to arm from it
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;
  return s;
}

test('I1: _recomputeFinalTpPrice refuses to derive a target from an unverified position', () => {
  const s = unarmedTrendWithStalePosition();
  s._recomputeFinalTpPrice();
  assert.equal(s.finalTpPrice, null, 'no target may be derived while the last refresh failed');
  assert.equal(s._trendFinalTpArmed, false, 'and therefore TREND is not armed');
});

test('I1: a funding settlement cannot resurrect the target _enterTrend refused to arm', async () => {
  const s = unarmedTrendWithStalePosition();
  s._lastFundingPollTs = 1;
  // KNOWN TRAP: _computeAccLoss recomputes cycleAccumulatedLoss from the
  // accumulators, silently defeating a directly-seeded value. Stub it.
  s._computeAccLoss = () => 89;
  s.makeProxyRequest = async () => ([{ income: '-0.5', time: 2 }]);
  s._pushHeartbeatNow = () => {};

  const res = await s._pollFundingIncome();

  assert.equal(res.count > 0 || s.accumulatedFundingFees === -0.5, true, 'the poll really ran (guard against a vacuous pass)');
  assert.equal(
    s.finalTpPrice, null,
    'the 8-hourly funding poll must not re-arm an unverified target behind the guard\'s back',
  );
  assert.equal(s._trendFinalTpArmed, false, 'still unarmed — so the reconcile keeps retrying');
});

test('I1: adjustProfitTarget cannot resurrect the target _enterTrend refused to arm', async () => {
  const s = unarmedTrendWithStalePosition();

  await s.adjustProfitTarget({ desiredProfitPercent: 2 });

  assert.equal(s.desiredProfitUSDT, 20, 'the profit target itself still updates');
  assert.equal(
    s.finalTpPrice, null,
    'touching the profit pencil must not silently re-arm an unverified target',
  );
  assert.equal(s._trendFinalTpArmed, false);
});

test('I1: _trendFinalTpArmed is derived, not stored — it cannot drift from finalTpPrice', () => {
  const s = ladderStrategy({ mode: 'TREND', anchor: 100 });
  s.finalTpPrice = null;
  assert.equal(s._trendFinalTpArmed, false, 'null target => unarmed, always');
  s.finalTpPrice = 104.08;
  assert.equal(s._trendFinalTpArmed, true, 'non-null target => armed, always');
  // The invariant is enforced structurally: a silent desync is impossible
  // because the flag cannot be written at all.
  assert.throws(
    () => { s._trendFinalTpArmed = false; },
    /derived/,
    'assigning the derived flag must fail loudly rather than desync the exit gate',
  );
});

test('I1: nothing persists _trendFinalTpArmed — a TREND resume derives it from the restored target', () => {
  const s = ladderStrategy({ mode: 'TREND', anchor: 100 });
  s.finalTpPrice = 104.08;
  s.activePosition = { quantity: 100, entryPrice: 100.4, avgEntry: 100.4, notional: 10040, unrealizedPnl: 0 };
  // saveState's doc is the contract with resume(); armed must not appear in it
  // (it is derived), while finalTpPrice — which it derives FROM — must.
  const doc = s.getStatus();
  assert.equal('_trendFinalTpArmed' in doc, false, 'derived state is never persisted');
  assert.equal(doc.finalTpPrice, 104.08, 'the value it derives from is what persists');
  // A TREND snapshot restored with a live target is armed on arrival — no
  // false "still unarmed" alarm, which is what the unpersisted field caused.
  assert.equal(s._trendFinalTpArmed, true);
});

// ——— Boot recovery must survive a transient position-API failure ————————
//
// REGRESSION PIN. resume() and start() each used to carry a BARE
// `await this.detectCurrentPosition(true)` immediately above their
// `await this._refreshCurrentPosition()` call. Once getCurrentPositions() was
// changed to THROW on an API error (so "flat" and "unknown" stop being the
// same value), that bare, unguarded call made ONE transient 503 during boot
// throw straight out of resume() into app.js's recovery `.catch()`, which does
// `isRunning=false` + `activeStrategies.delete()` + a `recovery_failed` write.
// Boot recovery queries `where('isRunning','==',true)`, so the strategy was
// NEVER picked up again: a live leveraged position left open on Binance with
// no ladder, no Final TP and — by design — no stop-loss, while the UI read
// "stopped". Permanent, never retried.
//
// These tests stub at the NETWORK boundary (makeProxyRequest) so the real
// getCurrentPositions -> detectCurrentPosition -> _refreshCurrentPosition
// chain executes. They deliberately do NOT use ladderStrategy(), whose
// `_refreshCurrentPosition` no-op stub is exactly why this bug was invisible
// to a fully green suite.

const API_503 = () => {
  const err = new Error('Binance proxy error: 503 Service Unavailable');
  err.status = 503;
  return err;
};

// Neutralise every heavy resume()/start() internal EXCEPT the position chain
// under test (detectCurrentPosition / _refreshCurrentPosition), which must run
// for real. Returns the proxy-call log.
function stubBootInternals(s) {
  const proxyCalls = [];
  s.initFirestoreCollections = () => {};
  s.addLog = async () => {};
  s.saveState = async () => {};
  s._writeStrategyFlow = async () => {};
  s.setLeverage = async () => {};
  s.setPositionMode = async () => {};
  s._getExchangeInfo = async () => {};
  s.exchangeInfoCache = { BTCUSDT: { minNotional: 5 } };
  s._retryListenKeyRequest = async () => {};
  s.connectUserDataStream = () => {};
  s.connectRealtimeWebSocket = () => {};
  s._startWebSocketHealthMonitoring = () => {};
  s._scheduleVolumeRefresh = () => {};
  s._refreshVolumeSnapshot = async () => {};
  s._preloadWsHandledOrderIdsFromFirestore = async () => {};
  s._reconcileRecentTrades = async () => {};
  s._pollFundingIncome = async () => {};
  s._scheduleNextFundingPoll = () => {};
  s._scheduledListenKeyRefresh = () => {};
  // THE network boundary. /fapi/v2/account is what getCurrentPositions() hits.
  s.makeProxyRequest = async (endpoint) => {
    proxyCalls.push(endpoint);
    throw API_503();
  };
  return proxyCalls;
}

function bootSnapshot() {
  return {
    strategyId: 'anchor_ladder_boot_test',
    profileId: 'test-profile',
    userId: 'test-user',
    gcfProxyUrl: 'http://proxy.invalid',
    sharedVmProxyGcfUrl: 'http://vm.invalid',
    symbol: 'BTCUSDT',
    leverage: 10,
    ladderMode: 'RANGE',
    anchor: 100,
    ladderLines: buildLadder(100, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE).map((l) =>
      (l.direction === 'LONG' && l.levelIndex === 1)
        ? { ...l, state: 'POSITION_OPEN', quantity: 2 }
        : l,
    ),
    lastProcessedPrice: 100.35,
    currentSide: 'LONG',
    // A REAL live leveraged position — this is what the bug abandoned.
    currentPosition: { quantity: 2, entryPrice: 100.3, avgEntry: 100.3, notional: 200.6, unrealizedPnl: 0 },
    cycleAccumulatedLoss: 12.5,
    initialCapital: 1000,
    currentInitialSize: 1000,
    ladderBaseSize: 1000,
    cycleStartTime: Date.now() - 60_000,
    subState: 'LONG_HELD',
    config: { initialSize: 1000, desiredProfitUSDT: 50 },
  };
}

test('resume() RESOLVES when the position API 503s — a transient boot failure must never abandon a live position', async () => {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  const proxyCalls = stubBootInternals(s);
  const snapshot = bootSnapshot();

  // The pre-fix bare `await this.detectCurrentPosition(true)` rethrows here and
  // rejects resume(), which is what app.js's recovery .catch() turned into a
  // permanent isRunning=false. The finally is mandatory: resume() arms a 30-min
  // listen-key interval BEFORE this point, so a rejection that skipped the
  // clearInterval would hang the test runner instead of failing it.
  try {
    await assert.doesNotReject(
      () => s.resume(snapshot),
      'resume() must swallow a transient position-API failure — a rejection here is what app.js turns into a permanent, never-retried stop',
    );
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }

  assert.ok(
    proxyCalls.includes('/fapi/v2/account'),
    'the real getCurrentPositions -> detectCurrentPosition chain must actually have run (else this test proves nothing)',
  );

  // 1. What app.js's recovery .catch() would have destroyed.
  assert.equal(s.isRunning, true, 'the strategy stays LIVE so the per-tick retry can recover it');
  assert.notEqual(s.criticalError, 'recovery_failed', 'the doc is never marked recovery_failed by a transient 503');

  // 2. The machinery the bare call defeated actually engaged.
  assert.equal(
    s._lastPositionRefreshFailed,
    true,
    'the failure is flagged — position state reads as UNKNOWN, never as flat',
  );

  // 3. The restored position is NOT wiped to flat/null by the failure.
  assert.ok(s.activePosition, 'the restored live position survives the failed refresh');
  assert.equal(s.activePosition.quantity, 2);
  assert.equal(s.activePosition.entryPrice, 100.3);
  assert.equal(s.currentSide, 'LONG', 'side is preserved, not cleared');
  assert.equal(
    s.ladderLines.filter((l) => l.state === 'POSITION_OPEN').length,
    1,
    'the open leg is still marked open — nothing is silently discarded',
  );
});

test('start() RESOLVES when the position API 503s — no bare detectCurrentPosition escapes start() either', async () => {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  const proxyCalls = stubBootInternals(s);
  // getWalletBalance also throws on API error, but it is deliberately unguarded
  // in start() (user-initiated: the error is surfaced to the UI). Stub it so the
  // 503 under test reaches the position chain, not the balance fetch.
  s.getWalletBalance = async () => 1000;

  try {
    await assert.doesNotReject(
      () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, leverage: 10 }),
      'start() must not reject on a transient position-API failure',
    );
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }

  assert.ok(proxyCalls.includes('/fapi/v2/account'), 'the real position chain ran');
  assert.equal(s.isRunning, true);
  assert.equal(s._lastPositionRefreshFailed, true, 'flagged UNKNOWN, not flat');
});

// ——— The close is sized from the WS-true legs, and stop() must never lie ———
//
// THE PIN FOR THE ROOT CAUSE. Every open books its filled qty from the
// user-data WS (`_fillLeg` -> `_resolveFill` -> `leg.quantity`), so the five
// open legs below are a WS-true record of 100. `activePosition.quantity` is
// written ONLY by `_refreshCurrentPosition` (REST), and here that call 503s,
// so it is stuck at the stale 80 it held before the failure.
//
// Closing 80 of the 100 that Binance actually holds ORPHANS the remaining 20.
// That single mistake produced three rounds of bugs — first the orphan, then
// a "refuse to close on unknown state" guard bolted onto every close path
// (which orphans WORSE: it closes nothing at all and wipes the legs), then
// the terminal-path Critical. The close now sizes from the legs, which need
// no network call and therefore cannot go unknown.
//
// Stubbed at the NETWORK boundary so the real getCurrentPositions ->
// detectCurrentPosition -> _refreshCurrentPosition chain genuinely runs and
// genuinely fails: `ladderStrategy()`'s no-op `_refreshCurrentPosition` stub
// is exactly why this class of bug was invisible to a green suite.
function stopFixtureWithFailingRefresh() {
  const s = ladderStrategy({ anchor: 100, base: 1000 });
  const longLegs = s.ladderLines.filter(l => l.direction === 'LONG');
  longLegs.forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 20; l.fillPrice = l.price; });
  // The legs (WS) know 5 x 20 = 100. activePosition (REST) is stale at 80 —
  // the 5th leg's own post-fill refresh 503'd and was never corrected.
  s.activePosition = { quantity: 80, entryPrice: 100.3, avgEntry: 100.3, notional: 8024, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.executionState = 'RUNNING';
  s._lastPositionRefreshFailed = true;
  delete s._refreshCurrentPosition; // expose the REAL method (helper stubs it to a no-op)
  const proxyCalls = [];
  s.makeProxyRequest = async (endpoint) => {
    proxyCalls.push(endpoint);
    const err = new Error('Binance proxy error: 503 Service Unavailable');
    err.status = 503;
    throw err;
  };
  // Neutralise the teardown tail; the flatten block is what is under test.
  s._pollFundingIncome = async () => {};
  s.cleanupWebSockets = () => {};
  s._recordHeroProfit = async () => {};
  s._hasNoTradingActivity = () => true; // routes past the completion notification
  s._deleteNoTradeStrategyDoc = async () => {};
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };
  return { s, proxyCalls, logs };
}

test('the close is sized from the WS-true legs and is UNAFFECTED by a failing position REST call', async () => {
  const { s, proxyCalls } = stopFixtureWithFailingRefresh();
  let orderArgs = null;
  s.placeMarketOrder = async (symbol, side, qty, price, opts) => {
    orderArgs = { symbol, side, qty, price, opts };
    return { orderId: 1 };
  };
  s._waitForOrderFillConfirmation = async () => {}; // keep the negative path fast; never hang on the real 3s WS timeout

  // stop() clears its own intervals, but a rejection before that point would
  // leave the 30-min listen-key interval live and HANG the runner instead of
  // failing it — a hang is not a failure, and it makes the pin useless.
  try {
    await s.stop({ flatten: true });
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
    clearInterval(s._volumeRefreshInterval);
  }

  assert.ok(orderArgs, 'the position API being down must not stop the close — the legs need no network call');
  assert.equal(
    orderArgs.qty, 100,
    'the close must be sized from the WS-true leg sum (100), NOT the stale REST activePosition (80) — closing 80 orphans 20',
  );
  assert.equal(orderArgs.side, 'SELL', 'closing a LONG sells');
  assert.deepEqual(orderArgs.opts, { reduceOnly: true }, 'one-way close: reduceOnly, never positionSide');
  assert.ok(
    proxyCalls.includes('/fapi/v2/account'),
    'the real getCurrentPositions -> detectCurrentPosition chain must actually have run and failed (else this test proves nothing)',
  );
});

test('C3: stop({flatten:true}) reports FINAL STATE UNKNOWN — never "confirmed flat" — when the refresh never succeeded', async () => {
  const { s, logs } = stopFixtureWithFailingRefresh();
  // Mirror the real `_closeConsolidated`: it nulls activePosition/currentSide
  // unconditionally once the order is away. That null is exactly what the old
  // residual check misread as "flat" when the refresh behind it had failed.
  s._closeConsolidated = async () => {
    s.activePosition = null; s.currentSide = null;
    return true;
  };

  try {
    await s.stop({ flatten: true });
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
    clearInterval(s._volumeRefreshInterval);
  }

  assert.ok(
    !logs.some((m) => m.includes('position confirmed flat')),
    'the user must NEVER be told the position is confirmed flat while the position state is UNKNOWN',
  );
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('FINAL STATE UNKNOWN')),
    'the unknown final state must be reported loudly — this is the last moment anyone is watching',
  );
  assert.ok(
    logs.some((m) => m.includes('FINAL STATE UNKNOWN') && m.includes('BTCUSDT')),
    'the WARNING names the symbol',
  );
});

test('C3: stop({flatten:true}) still reports "confirmed flat" when the refresh actually SUCCEEDS and confirms flat', async () => {
  // The honest-path counterpart: the fix must not turn every stop into a
  // FINAL STATE UNKNOWN cry-wolf.
  const s = ladderStrategy({ anchor: 100, base: 1000 });
  s.ladderLines.filter(l => l.direction === 'LONG').forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 20; });
  s.activePosition = { quantity: 100, entryPrice: 100.3, avgEntry: 100.3, notional: 10030, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.executionState = 'RUNNING';
  s._lastPositionRefreshFailed = false;
  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = false; };
  let closedQty = null;
  s._closeConsolidated = async () => {
    closedQty = s.activePosition.quantity;
    s.activePosition = null; s.currentSide = null;
    return true;
  };
  s._pollFundingIncome = async () => {};
  s.cleanupWebSockets = () => {};
  s._recordHeroProfit = async () => {};
  s._hasNoTradingActivity = () => true;
  s._deleteNoTradeStrategyDoc = async () => {};
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  try {
    await s.stop({ flatten: true });
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
    clearInterval(s._volumeRefreshInterval);
  }

  assert.equal(closedQty, 100, 'a verified position is closed normally');
  assert.ok(logs.some((m) => m.includes('position confirmed flat')), 'a genuinely verified flat is still reported as such');
  assert.ok(!logs.some((m) => m.includes('FINAL STATE UNKNOWN')), 'no cry-wolf on the verified path');
  assert.ok(s.ladderLines.every(l => l.state === 'EMPTY'), 'the ladder resets once the close is against verified state');
});

// ——— Geometry persistence: resume must rebuild the SAME ladder ———

test('saveState persists the ladder geometry', async () => {
  const s = ladderStrategy();
  s.stepPct = 0.005;
  s.levelsPerSide = 8;
  let saved = null;
  // saveState writes via this.firestore.collection('strategies').doc(id).set(doc, {merge:true})
  s.firestore = { collection: () => ({ doc: () => ({ set: async (doc) => { saved = doc; } }) }) };
  s.addLog = async () => {};
  // ladderStrategy() stubs saveState for the OTHER tests in this file (so a
  // trading-sequence test doesn't need a firestore double); this test is
  // specifically about persistence, so it calls the real prototype method
  // (same pattern as the existing save/restore round-trip tests above).
  await AnchorLadderStrategy.prototype.saveState.call(s);
  assert.ok(saved, 'saveState wrote a doc');
  assert.equal(saved.stepPct, 0.005, 'stepPct must round-trip');
  assert.equal(saved.levelsPerSide, 8, 'levelsPerSide must round-trip');
});

test('resume restores non-default geometry from the snapshot', () => {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s._applySnapshotGeometry({ stepPct: 0.005, levelsPerSide: 8 });
  assert.equal(s.stepPct, 0.005, 'a cycle started at 0.5% must resume at 0.5%');
  assert.equal(s.levelsPerSide, 8, 'a cycle started at 8 levels must resume at 8');
});

test('resume falls back to the defaults for a legacy snapshot without geometry', () => {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s._applySnapshotGeometry({});
  assert.equal(s.stepPct, LADDER_STEP_PCT, 'pre-change docs default to 0.3%');
  assert.equal(s.levelsPerSide, LADDER_LEVELS_PER_SIDE, 'pre-change docs default to 5');
});

test('resume THROWS on a present-but-invalid geometry instead of silently defaulting (out-of-bounds step)', () => {
  // A corrupted/out-of-bounds snapshot value is NOT the same as an absent one.
  // Silently coercing it to the default would read "unknown" as "safe" and
  // rebuild a ladder that does not match whatever is actually on the exchange
  // for this cycle — exactly the silent-fail-open shape this codebase forbids.
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  assert.throws(
    () => s._applySnapshotGeometry({ stepPct: LADDER_STEP_PCT_MAX + 1, levelsPerSide: 5 }),
    /step/i,
  );
});

test('resume THROWS on a present-but-invalid geometry instead of silently defaulting (out-of-bounds levels)', () => {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  assert.throws(
    () => s._applySnapshotGeometry({ stepPct: LADDER_STEP_PCT, levelsPerSide: LADDER_LEVELS_MAX + 1 }),
    /level/i,
  );
});

test('resume THROWS on a non-numeric (e.g. stringified) geometry value rather than coercing it', () => {
  // resolveLadderGeometry is strict, not coercing (a numeric string is not a
  // number); _applySnapshotGeometry must inherit that, not re-introduce
  // Number(...) coercion via its own ad hoc checks.
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  assert.throws(() => s._applySnapshotGeometry({ stepPct: '0.005', levelsPerSide: 8 }));
});

// ——— Trigger price: arm / cancel / validate ———

test('harvestNow(triggerPrice) arms an ABOVE trigger and rounds to tick size', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();                       // currentPrice 100
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  const res = await s.harvestNow(101.239);          // ~1.2% above → rounds to 101.24
  assert.equal(res.armed, true);
  assert.equal(s.harvestTriggerPrice, 101.24);
  assert.equal(s.harvestTriggerAbove, true);
  assert.equal(s._manualHarvestRequested, false, 'arming must NOT set the immediate latch');
});

test('harvestNow(triggerPrice) rejects arming with no live price yet', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.currentPrice = null;                            // no live price yet
  await assert.rejects(() => s.harvestNow(101), (err) => {
    assert.match(err.message, /no live price/i);
    assert.equal(err.invalidInput, true, 'client-input validation errors must be tagged invalidInput (route maps to 400)');
    return true;
  });
});

test('harvestNow(triggerPrice) infers a BELOW trigger from the current price', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  await s.harvestNow(98.5);
  assert.equal(s.harvestTriggerPrice, 98.5);
  assert.equal(s.harvestTriggerAbove, false);
});

test('harvestNow(triggerPrice) rejects a level within the 0.1% gap', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();                       // currentPrice 100 → band 99.9..100.1
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  await assert.rejects(() => s.harvestNow(100.05), (err) => {
    assert.match(err.message, /0\.1%|current price/i);
    assert.equal(err.invalidInput, true, 'client-input validation errors must be tagged invalidInput (route maps to 400)');
    return true;
  });
  assert.equal(s.harvestTriggerPrice, null, 'a rejected arm leaves no trigger set');
});

test('harvestNow(triggerPrice) rejects a non-positive price', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  await assert.rejects(() => s.harvestNow(0), (err) => {
    assert.match(err.message, /positive/i);
    assert.equal(err.invalidInput, true, 'client-input validation errors must be tagged invalidInput (route maps to 400)');
    return true;
  });
});

test('harvestNow() with no price latches immediately AND clears any armed trigger', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;   // pre-armed
  const res = await s.harvestNow();
  assert.equal(res.queued, true);
  assert.equal(s._manualHarvestRequested, true);
  assert.equal(s.harvestTriggerPrice, null, 'immediate harvest supersedes a pending trigger');
});

test('cancelHarvestTrigger clears an armed trigger', async () => {
  const s = ladderStrategy();
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;
  const res = await s.cancelHarvestTrigger();
  assert.equal(res.cancelled, true);
  assert.equal(s.harvestTriggerPrice, null);
  assert.equal(s.harvestTriggerAbove, null);
});

// ——— Trigger price: tick-loop firing ———

test('an armed ABOVE trigger fires _harvestToFlat when price reaches the level', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003, unrealizedPnl: 5 };
  s.harvestTriggerPrice = 101; s.harvestTriggerAbove = true;
  let fired = null;
  s._harvestToFlat = async (reason) => { fired = reason; };
  await s.handleRealtimePrice(101);
  assert.equal(fired, 'price_trigger');
  assert.equal(s.harvestTriggerPrice, null, 'one-shot: cleared before acting');
  assert.equal(s.harvestTriggerAbove, null);
});

test('an armed ABOVE trigger does NOT fire while price is below the level', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003, unrealizedPnl: 5 };
  s.harvestTriggerPrice = 101; s.harvestTriggerAbove = true;
  let fired = false;
  s._harvestToFlat = async () => { fired = true; };
  await s.handleRealtimePrice(100.5);
  assert.equal(fired, false);
  assert.equal(s.harvestTriggerPrice, 101, 'still armed');
});

test('an armed BELOW trigger fires when price gaps through the level', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003, unrealizedPnl: -3 };
  s.harvestTriggerPrice = 99; s.harvestTriggerAbove = false;
  let fired = null;
  s._harvestToFlat = async (r) => { fired = r; };
  await s.handleRealtimePrice(98);           // jumped past 99
  assert.equal(fired, 'price_trigger');
  assert.equal(s.harvestTriggerPrice, null);
});

test('a trigger reached while position state is UNKNOWN still harvests (never reads unknown as flat)', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();
  // Legs are the WS-true ledger: a leg filled, but the REST refresh that would
  // populate activePosition failed. That is UNKNOWN, not flat.
  s.ladderLines.filter((l) => l.direction === 'LONG').slice(0, 2)
    .forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = null;
  s._lastPositionRefreshFailed = true;
  s.harvestTriggerPrice = 101; s.harvestTriggerAbove = true;
  let fired = null;
  s._harvestToFlat = async (r) => { fired = r; };
  await s.handleRealtimePrice(101);
  assert.equal(fired, 'price_trigger', 'unknown state must NOT disarm quietly');
  assert.equal(s.harvestTriggerPrice, null);
});

test('an armed trigger NOT yet reached survives a real anchor flatten', async () => {
  // Precondition: the tick must genuinely flatten (not merely "make one up") —
  // stub _flattenAtAnchor and assert it fired, exactly like the plain
  // "RANGE: crossing the anchor flattens" test above. Otherwise a tick that
  // never flattens would pass this test while proving nothing.
  const s = ladderStrategy();
  let flattened = false;
  s._flattenAtAnchor = async () => { flattened = true; };
  s.ladderLines.find(l => l.direction === 'LONG' && l.levelIndex === 1).state = 'POSITION_OPEN';
  s.lastProcessedPrice = 100.35;
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;   // armed, nowhere near this tick
  await s.handleRealtimePrice(99.9);                           // crosses back below the anchor
  assert.equal(flattened, true, 'precondition: the anchor flatten actually ran');
  assert.equal(s.harvestTriggerPrice, 105, 'the trigger must survive an anchor flatten untouched');
  assert.equal(s.harvestTriggerAbove, true);
});

test('the trigger fires BEFORE the anchor-flatten dispatch on the same tick', async () => {
  const s = ladderStrategy();                // anchor 100
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003, unrealizedPnl: 2 };
  s.lastProcessedPrice = 100.5;
  s.harvestTriggerPrice = 100; s.harvestTriggerAbove = false;  // trigger AT the anchor
  let harvested = false, flattened = false;
  s._harvestToFlat = async () => { harvested = true; };
  s._flattenAtAnchor = async () => { flattened = true; };
  await s.handleRealtimePrice(100);          // crosses anchor AND hits trigger
  assert.equal(harvested, true, 'trigger wins');
  assert.equal(flattened, false, 'anchor flatten did not run this tick');
});

// ——— Trigger price: persistence + status ———

test('getStatus surfaces the armed trigger', () => {
  const s = ladderStrategy();
  s.harvestTriggerPrice = 105.5; s.harvestTriggerAbove = true;
  const st = s.getStatus();
  assert.equal(st.harvestTriggerPrice, 105.5);
  assert.equal(st.harvestTriggerAbove, true);
});

test('getHeartbeatPayload surfaces the armed trigger', () => {
  const s = ladderStrategy();
  s.harvestTriggerPrice = 98; s.harvestTriggerAbove = false;
  const hb = s.getHeartbeatPayload();
  assert.equal(hb.harvestTriggerPrice, 98);
  assert.equal(hb.harvestTriggerAbove, false);
});

test('saveState persists the armed trigger fields', async () => {
  const s = ladderStrategy();
  delete s.saveState;                        // restore the real prototype method (fixture stubs it)
  let captured = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (doc) => { captured = doc; } }) }) };
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;
  await s.saveState();
  assert.equal(captured.harvestTriggerPrice, 105);
  assert.equal(captured.harvestTriggerAbove, true);
});

// ——— Flat re-anchor: accounting split ———

test('_harvestToFlat while FLAT re-anchors, bumps reanchorCount, NOT harvestCount', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();                 // flat: activePosition null, no open legs
  s.currentPrice = 110;                        // re-anchor target (live price)
  s.harvestCount = 3;
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.harvestCount, 3, 'a flat re-anchor must NOT count as a harvest');
  assert.equal(s.reanchorCount, 1, 'reanchorCount bumps on every re-anchor');
  assert.equal(s.anchor, 110, 're-anchored on the live price');
});

test('_harvestToFlat while HOLDING bumps BOTH harvestCount and reanchorCount', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();
  s.ladderLines.filter(l => l.direction === 'LONG').slice(0, 2)
    .forEach(l => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = { quantity: 1, entryPrice: 100.3, avgEntry: 100.3, notional: 100, unrealizedPnl: 5 };
  s.currentSide = 'LONG';
  s._closeConsolidated = async () => true;     // verified close
  s.harvestCount = 3;
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.harvestCount, 4, 'a real harvest counts');
  assert.equal(s.reanchorCount, 1, 'and also bumps reanchorCount');
});

// ——— Flat re-anchor: enablement (gate + trigger fire) ———

test('harvestNow() no longer throws when flat — it latches an immediate re-anchor', async () => {
  const s = ladderStrategy();                 // flat
  const res = await s.harvestNow();
  assert.equal(res.queued, true);
  assert.equal(s._manualHarvestRequested, true);
});

test('harvestNow(triggerPrice) arms a trigger while flat', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = ladderStrategy();                 // flat, currentPrice 100
  const res = await s.harvestNow(101.2);
  assert.equal(res.armed, true);
  assert.equal(s.harvestTriggerPrice, 101.2);
});

test('a trigger that fires while FLAT re-anchors (no longer disarms quietly)', async () => {
  const s = ladderStrategy();                 // flat
  s.harvestTriggerPrice = 101; s.harvestTriggerAbove = true;
  let fired = null;
  s._harvestToFlat = async (reason) => { fired = reason; };
  await s.handleRealtimePrice(101);
  assert.equal(fired, 'price_trigger', 'flat-at-fire now re-anchors instead of disarming');
  assert.equal(s.harvestTriggerPrice, null, 'one-shot cleared');
});

// ——— Flat re-anchor: persistence + status ———

test('getStatus and getHeartbeatPayload surface reanchorCount', () => {
  const s = ladderStrategy();
  s.reanchorCount = 7;
  assert.equal(s.getStatus().reanchorCount, 7);
  assert.equal(s.getHeartbeatPayload().reanchorCount, 7);
});

test('saveState persists reanchorCount', async () => {
  const s = ladderStrategy();
  delete s.saveState;                          // restore the real prototype method
  let captured = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { captured = d; } }) }) };
  s.reanchorCount = 7;
  await s.saveState();
  assert.equal(captured.reanchorCount, 7);
});

// ——— _closeConsolidated: reduceOnly (-2022) rejection falls through to verification ———
//
// 2026-07-25 incident: a rejected reduceOnly close THREW out of
// _closeConsolidated, aborting the whole tick before the verification tiers
// below it could ask Binance what was actually open. activePosition stayed
// stale, so _closeQuantity() kept returning it and the identical doomed close
// was re-issued every tick for 85+ minutes. A -2022 is the exchange saying
// "there is nothing to reduce" — it must reach tier 3, which reconciles.

test('_isReduceOnlyRejected matches the proxy-flattened -2022 message and a raw code', () => {
  const s = ladderStrategy();
  assert.equal(s._isReduceOnlyRejected(new Error('Proxy Error: 500 - Binance API Error: -2022 - ReduceOnly Order is rejected.')), true);
  assert.equal(s._isReduceOnlyRejected(Object.assign(new Error('rejected'), { code: -2022 })), true);
  assert.equal(s._isReduceOnlyRejected(new Error('Binance API Error: -1021 - Timestamp for this request')), false);
  assert.equal(s._isReduceOnlyRejected(null), false);
});

test('_isReduceOnlyRejected matches the real makeProxyRequest shape (binanceErrorCode)', () => {
  const s = ladderStrategy();
  assert.equal(
    s._isReduceOnlyRejected(Object.assign(new Error('Binance API Error: -2022 - ReduceOnly Order is rejected.'), { binanceErrorCode: -2022 })),
    true,
  );
  assert.equal(
    s._isReduceOnlyRejected(Object.assign(new Error('Binance API Error: -2011 - Unknown order sent.'), { binanceErrorCode: -2011 })),
    false,
  );
});

test('_closeConsolidated: -2022 + Binance confirms flat verifies the close and clears state', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.26, entryPrice: 100, avgEntry: 100, notional: 26, unrealizedPnl: 0 };
  s.currentSide = 'SHORT';
  s.finalTpPrice = 95;
  s.placeMarketOrder = async () => {
    throw new Error('Proxy Error: 500 - Binance API Error: -2022 - ReduceOnly Order is rejected.');
  };
  s._waitForOrderFillConfirmation = async () => {
    throw new Error('tier 1 must not run — there is no orderId after a rejection');
  };
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false;
    s.activePosition = null; // Binance: genuinely flat
    s.currentSide = null;
  };
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const result = await s._closeConsolidated('anchor_flatten');

  assert.equal(result, true, 'a -2022 on a confirmed-flat account IS a completed close');
  assert.equal(s.activePosition, null, 'state cleared so _closeQuantity() returns 0 and the loop cannot recur');
  assert.equal(s.currentSide, null);
  assert.equal(s.finalTpPrice, null);
  assert.ok(logs.some((m) => m.includes('-2022')), 'the rejection is logged, never silently swallowed');
});

test('_closeConsolidated: -2022 + a FAILED refresh leaves state INTACT (unknown never reads as flat)', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.26, entryPrice: 100, avgEntry: 100, notional: 26, unrealizedPnl: 0 };
  s.currentSide = 'SHORT';
  s.placeMarketOrder = async () => {
    throw new Error('Proxy Error: 500 - Binance API Error: -2022 - ReduceOnly Order is rejected.');
  };
  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = true; }; // Binance unreachable
  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  const result = await s._closeConsolidated('anchor_flatten');

  assert.equal(result, false, 'an unreachable Binance must never read as a completed close');
  assert.ok(s.activePosition && s.activePosition.quantity === 0.26, 'position state survives an unresolved refresh');
  assert.equal(s.currentSide, 'SHORT');
  assert.ok(logs.some((m) => m.includes('WARNING')), 'the unverified close is logged loudly');
});

test('_closeConsolidated: -2022 while the position is still OPEN returns false and keeps state', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.26, entryPrice: 100, avgEntry: 100, notional: 26, unrealizedPnl: 0 };
  s.currentSide = 'SHORT';
  s.placeMarketOrder = async () => {
    throw new Error('Proxy Error: 500 - Binance API Error: -2022 - ReduceOnly Order is rejected.');
  };
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false;
    s.activePosition = { quantity: 0.26, entryPrice: 100, avgEntry: 100, notional: 26, unrealizedPnl: 0 };
    s.currentSide = 'SHORT';
  };
  s.addLog = async () => {};

  const result = await s._closeConsolidated('anchor_flatten');

  assert.equal(result, false, 'the position is still open — the close genuinely did not land');
  assert.ok(s.activePosition && s.activePosition.quantity === 0.26);
  assert.equal(s.currentSide, 'SHORT');
});

test('_closeConsolidated: a NON-reduceOnly order error still propagates (no blanket swallowing)', async () => {
  const s = ladderStrategy();
  s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.placeMarketOrder = async () => {
    throw new Error('Proxy Error: 500 - Binance API Error: -1021 - Timestamp for this request is outside of the recvWindow.');
  };
  let refreshCalled = false;
  s._refreshCurrentPosition = async () => { refreshCalled = true; };
  s.addLog = async () => {};

  await assert.rejects(
    () => s._closeConsolidated('anchor_flatten'),
    /-1021/,
    'only -2022 falls through to verification; every other failure must still surface',
  );
  assert.equal(refreshCalled, false, 'no verification runs for an unrelated failure');
  assert.ok(s.activePosition, 'state untouched');
});

// ——— Start Mode: an armed start trigger defers the ladder ———
//
// start() validates the level against a freshly fetched reference price (the
// WS has not ticked yet at that point), stores it, and the tick gate holds the
// ladder until the price reaches it. The anchor is then the LIVE price, not the
// trigger level.

test('startArmed is DERIVED: true only while a trigger is set AND no ladder exists', () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = null;
  assert.equal(s.startArmed, false, 'no trigger = not armed');
  s.startTriggerPrice = 90;
  assert.equal(s.startArmed, true, 'trigger + no ladder = armed');
  s.ladderLines = buildLadder(100, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE);
  assert.equal(s.startArmed, false, 'once the ladder exists the strategy is live, not armed');
  // Getter-only — no setter was defined, so ESM strict mode throws on
  // assignment. Free regression lock against someone later turning this back
  // into a stored field (the exact drift `_trendFinalTpArmed` tombstones).
  assert.throws(() => { s.startArmed = true; });
});

test('start trigger: a tick that has NOT reached the level does not build the ladder', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = 90;
  s.startTriggerAbove = false;      // armed below → fires on a fall
  let built = false;
  s.initializeLadder = async () => { built = true; };
  await s.handleRealtimePrice(95);
  assert.equal(built, false, 'price has not fallen to the trigger — the ladder must stay unbuilt');
  assert.equal(s.startTriggerPrice, 90, 'the trigger stays armed');
});

test('start trigger: reaching the level clears it and anchors on the LIVE price', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = 90;
  s.startTriggerAbove = false;
  let anchoredAt = null;
  s.initializeLadder = async (p) => { anchoredAt = p; };
  await s.handleRealtimePrice(89.7);   // gapped THROUGH the trigger
  assert.equal(anchoredAt, 89.7, 'the anchor is the live price, not the 90 trigger level');
  assert.equal(s.startTriggerPrice, null, 'one-shot — the trigger is cleared');
  assert.equal(s.startTriggerAbove, null);
});

test('start trigger: an upward trigger fires on a rise', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = 110;
  s.startTriggerAbove = true;
  let anchoredAt = null;
  s.initializeLadder = async (p) => { anchoredAt = p; };
  await s.handleRealtimePrice(105);
  assert.equal(anchoredAt, null, 'not yet reached');
  await s.handleRealtimePrice(110.4);
  assert.equal(anchoredAt, 110.4);
});

test('start trigger: with NO trigger armed the ladder builds on the first tick as before', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = null;
  let anchoredAt = null;
  s.initializeLadder = async (p) => { anchoredAt = p; };
  await s.handleRealtimePrice(100);
  assert.equal(anchoredAt, 100, 'Immediate mode is unchanged');
});

// ——— Start Mode: arm-time validation in start() ———
//
// Mirrors harvestNow(triggerPrice)'s dedicated arm-time tests above: rounding,
// both directions, the 0.1% gap, and bad input — but through start(), which is
// where the brief's central safety rule lives ("an already-satisfied or
// too-close level must be REJECTED"). Reuses stubBootInternals() (the same
// harness the existing "sizes the minNotional gate" start()-test drives) so
// start() can run all the way through its network-touching setup in tests.
// _fetchReferencePrice is stubbed directly rather than through
// makeProxyRequest — stubBootInternals' makeProxyRequest always throws (it
// exists to prove _refreshCurrentPosition fails safely), which would be the
// wrong signal for a reference-price fetch that's meant to succeed.

function startModeStrategy() {
  const s = new AnchorLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  stubBootInternals(s);
  s.getWalletBalance = async () => 1000;
  s._fetchReferencePrice = async () => 100; // reference price for every test below
  // Genuinely flat by default (mirrors ladderStrategy()'s own no-op stub) —
  // stubBootInternals' makeProxyRequest always throws, which would otherwise
  // make _refreshCurrentPosition fail and trip the FIX-3 refusal below for
  // every test here, not just the ones that mean to exercise it.
  s._refreshCurrentPosition = async () => {};
  return s;
}

test('start(): a start trigger inside the 0.1% gap is rejected and nothing is armed', async () => {
  const s = startModeStrategy();
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 100.05 }),
    /0\.1%/,
  );
  assert.equal(s.startTriggerPrice, null, 'a rejected arm leaves no trigger set');
  assert.equal(s.startTriggerAbove, null);
});

test('start(): a trigger ABOVE the reference arms startTriggerAbove=true', async () => {
  const s = startModeStrategy();
  try {
    await s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 110 });
    assert.equal(s.startTriggerPrice, 110);
    assert.equal(s.startTriggerAbove, true);
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }
});

test('start(): a trigger BELOW the reference arms startTriggerAbove=false', async () => {
  const s = startModeStrategy();
  try {
    await s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 90 });
    assert.equal(s.startTriggerPrice, 90);
    assert.equal(s.startTriggerAbove, false);
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }
});

test('start(): a non-positive start trigger price is rejected', async () => {
  const s = startModeStrategy();
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 0 }),
    /positive number/,
  );
  assert.equal(s.startTriggerPrice, null);
});

test('start(): a non-finite start trigger price is rejected', async () => {
  const s = startModeStrategy();
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 'not-a-number' }),
    /positive number/,
  );
  assert.equal(s.startTriggerPrice, null);
});

test('start(): a failed reference-price fetch refuses the start and arms nothing', async () => {
  const s = startModeStrategy();
  s._fetchReferencePrice = async () => {
    throw new Error('Could not read a reference price from Binance to validate the start trigger.');
  };
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 110 }),
    /reference price/,
    'an unknown reference must refuse the start, never arm on a guess',
  );
  assert.equal(s.startTriggerPrice, null, 'unknown must never read as armed');
  assert.equal(s.startTriggerAbove, null);
});

// ——— Start Mode: refuse to arm over an existing/unverifiable position ———
//
// While ARMED, the tick returns before any RANGE/TREND dispatch, so a
// pre-existing position would have no anchor, no Final TP, and no stop-loss
// for an unbounded period. Two distinct failure shapes, both refused.

test('start(): refuses to arm a start trigger over an existing position', async () => {
  const s = startModeStrategy();
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false; // Binance WAS reachable...
    s.activePosition = { quantity: 0.5, entryPrice: 100, avgEntry: 100, notional: 50, unrealizedPnl: 0 };
    s.currentSide = 'LONG'; // ...and answered "not flat"
  };
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 110 }),
    /existing position/i,
  );
  assert.equal(s.startTriggerPrice, null, 'a refused arm must not persist a spurious armed trigger');
  assert.equal(s.startTriggerAbove, null);
});

test('start(): refuses to arm a start trigger when the position check could not complete', async () => {
  const s = startModeStrategy();
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = true; // Binance was NOT reachable — "flat" cannot be trusted
  };
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 110 }),
    /did not complete|not known whether/i,
  );
  assert.equal(s.startTriggerPrice, null);
  assert.equal(s.startTriggerAbove, null);
});

test('start(): arms fine when the account is confirmed genuinely flat', async () => {
  const s = startModeStrategy(); // default stub: _lastPositionRefreshFailed stays false, activePosition stays null
  try {
    await s.start({ symbol: 'BTCUSDT', initialSize: 1000, startTriggerPrice: 110 });
    assert.equal(s.startTriggerPrice, 110);
    assert.equal(s.startTriggerAbove, true);
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }
});

// ——— validateStartTrigger: the shared pure validator (FIX round 3) ———
//
// The SAME function both the /anchor-ladder/start route and start() call —
// "one validator, two gates", mirroring resolveLadderGeometry's pattern.
// Tested directly since it is a pure, exported function: the most honest
// surface, no strategy fixture needed.

test('validateStartTrigger: rejects a level inside the 0.1% gap', () => {
  const result = validateStartTrigger(100.05, 100, 'BTCUSDT');
  assert.equal(result.ok, false);
  assert.match(result.error, /0\.1%/);
});

test('validateStartTrigger: a level ABOVE the reference is valid with above=true', () => {
  const result = validateStartTrigger(110, 100, 'BTCUSDT');
  assert.equal(result.ok, true);
  assert.equal(result.above, true);
  assert.equal(result.rounded, 110);
});

test('validateStartTrigger: a level BELOW the reference is valid with above=false', () => {
  const result = validateStartTrigger(90, 100, 'BTCUSDT');
  assert.equal(result.ok, true);
  assert.equal(result.above, false);
  assert.equal(result.rounded, 90);
});

test('validateStartTrigger: rejects a non-numeric price', () => {
  const result = validateStartTrigger('not-a-number', 100, 'BTCUSDT');
  assert.equal(result.ok, false);
  assert.match(result.error, /positive number/);
});

test('validateStartTrigger: rejects zero', () => {
  const result = validateStartTrigger(0, 100, 'BTCUSDT');
  assert.equal(result.ok, false);
  assert.match(result.error, /positive number/);
});

test('validateStartTrigger: rejects a negative price', () => {
  const result = validateStartTrigger(-50, 100, 'BTCUSDT');
  assert.equal(result.ok, false);
  assert.match(result.error, /positive number/);
});

test('validateStartTrigger: rejects Infinity', () => {
  const result = validateStartTrigger(Infinity, 100, 'BTCUSDT');
  assert.equal(result.ok, false);
  assert.match(result.error, /positive number/);
});

// ——— Start Mode: a pending harvest is refused / cleared, not replayed ———
//
// While ARMED there is no ladder and no position — a harvest requested now
// would sit on the `_manualHarvestRequested` latch until the trigger fires,
// then fire on the very next tick and flatten the ladder that had just been
// built. harvestNow() refuses up front (FIX A); the fire path also clears the
// latch belt-and-braces (FIX B) so that safety never rests on an invariant
// enforced only by a different method.

test('harvestNow() while the start trigger is armed refuses and never sets the latch', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = 90;
  s.startTriggerAbove = false;
  await assert.rejects(() => s.harvestNow(), (err) => {
    assert.match(err.message, /start trigger/i);
    assert.equal(err.invalidInput, undefined, 'a state conflict must NOT be tagged invalidInput (route maps to 409, not 400)');
    return true;
  });
  assert.equal(s._manualHarvestRequested, false, 'a meaningless request must never arm the latch');
});

test('start trigger fire path clears any harvest latch that slipped through (belt-and-braces)', async () => {
  const s = ladderStrategy();
  s.ladderLines = [];
  s.startTriggerPrice = 90;
  s.startTriggerAbove = false;
  s._manualHarvestRequested = true; // forced on, as if it had slipped past harvestNow()'s guard
  let built = false;
  s.initializeLadder = async () => { built = true; };
  await s.handleRealtimePrice(89.7); // crosses the trigger
  assert.equal(built, true, 'the ladder still builds');
  assert.equal(
    s._manualHarvestRequested, false,
    'a harvest requested before the ladder existed must not be replayed against the ladder that just built',
  );
});
