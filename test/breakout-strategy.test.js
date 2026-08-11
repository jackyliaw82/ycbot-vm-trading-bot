import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReversalLadderStrategy } from '../reversal-ladder-strategy.js';
import { BREAKOUT_PCT } from '../breakout-levels.js';

// A strategy with levels set and nothing open. All I/O stubbed, so a tick
// exercises only the dispatch. bull 100 / bear 98 with breakoutPct 1.5% puts
// the entries at 101.5 and 96.53, and price parked at 99 sits inside the band.
export function breakoutStrategy({ bull = 100, bear = 98, pct = 0.015, base = 1000 } = {}) {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  s.isRunning = true;
  s.strategyId = 'reversal_ladder_test';
  s.symbol = 'BTCUSDT';
  s.breakoutPct = pct;
  s.bullLevel = bull;
  s.bearLevel = bear;
  s.currentPrice = 99;
  s.lastProcessedPrice = 99;
  s.minNotional = 5;
  s._ladderBaseSize = base;
  s.currentInitialSize = base;
  s.initialCapital = base;
  s.openLeg = null;
  s.activePosition = null;
  s.finalTpPrice = null;
  s._pendingEntry = null;
  s._tradingSeqInProgress = false;
  s._manualHarvestRequested = false;
  s.addLog = async () => {};
  s.saveState = async () => {};
  s._writeStrategyFlow = async () => {};
  s._refreshCurrentPosition = async () => {};
  s._postExecuteBookkeeping = async () => {};
  s._pushHeartbeatNow = () => {};
  s._computeLadderBaseSize = async () => s._ladderBaseSize;
  s.roundPrice = (p) => p;              // no tick rounding in tests
  s.roundQuantity = (q) => q;
  s.trailEnabled = false;               // explicit: never depend on a constructor default
  s._deriveBreakoutLevels();
  return s;
}

// `roundPrice` is stubbed to identity in this helper, so the raw IEEE 754
// products are visible here (100 * 1.015 = 101.49999999999999). In production
// roundPrice snaps to tick size and absorbs it. Compare with an epsilon.
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} != ${b}`);

test('breakout levels derive from the pair and the percentage', () => {
  const s = breakoutStrategy();
  near(s.bullBreakout, 101.5);
  near(s.bearBreakout, 96.53);
});

test('editing bullLevel re-derives bullBreakout', () => {
  const s = breakoutStrategy();
  s.bullLevel = 200;
  s._deriveBreakoutLevels();
  near(s.bullBreakout, 203);
});

test('heldSide is derived from the open leg, never stored', () => {
  const s = breakoutStrategy();
  assert.equal(s.heldSide, null);
  s.openLeg = { direction: 'LONG', quantity: 2, fillPrice: 101.5, openedAt: 1 };
  assert.equal(s.heldSide, 'LONG');
  s.openLeg = null;
  assert.equal(s.heldSide, null);
});

test('heldSide has no setter that could let it drift from the leg', () => {
  const s = breakoutStrategy();
  assert.throws(() => { s.heldSide = 'SHORT'; });
});

test('the default breakoutPct is applied when config omits it', () => {
  const s = breakoutStrategy();
  s.breakoutPct = BREAKOUT_PCT;
  s._deriveBreakoutLevels();
  near(s.bullBreakout, 101);
});

// ——— saveState/resume round trip (fix round 1, Critical 1) ————————————
//
// This is the gap that let breakoutPct go unpersisted: saveState still wrote
// the deleted stepPct/levelsPerSide pair and never wrote breakoutPct, so
// resume()'s own migration guard refused every snapshot a healthy breakout
// strategy actually produced. Pin the contract directly: a snapshot this
// class WRITES is a snapshot this class can READ BACK.

// resume() drives a lot of I/O (leverage/position-mode/exchange-info REST
// calls, WS connections, funding polling, L3 reconcile, AI key lookup). None
// of it is under test here, so stub it out — mirrors
// test/reversal-ladder-strategy.test.js's stubResumeIO exactly, since resume()
// itself is untouched infrastructure outside this task's scope.
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
// setInterval that would otherwise keep `node --test` alive indefinitely.
function cleanupResumeTimers(s) {
  if (s.listenKeyRefreshInterval) clearInterval(s.listenKeyRefreshInterval);
  if (s._fundingPollTimeout) clearTimeout(s._fundingPollTimeout);
  if (s._volumeRefreshInterval) clearInterval(s._volumeRefreshInterval);
}

test('a snapshot this class writes is a snapshot this class can read back', async () => {
  const src = breakoutStrategy({ bull: 100, bear: 98, pct: 0.02 });

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  // breakoutStrategy() stubs saveState for the OTHER tests in this file; this
  // test is specifically about persistence, so it calls the real prototype
  // method against a fake firestore.
  await ReversalLadderStrategy.prototype.saveState.call(src);

  // The dead fields must actually be gone, not just falsy — a lingering key
  // set to undefined would still (wrongly) read as "present" to a loose check.
  assert.ok(!('stepPct' in doc), 'stepPct must not be written');
  assert.ok(!('levelsPerSide' in doc), 'levelsPerSide must not be written');
  assert.equal(doc.breakoutPct, 0.02, 'breakoutPct must be written');
  assert.ok(!Array.isArray(doc.ladderLines), 'a fresh breakout doc carries no ladderLines');

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  // Must NOT throw: this is exactly the snapshot a healthy breakout strategy
  // persists, and the migration guard must accept its own output.
  await assert.doesNotReject(() => dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' }));
  cleanupResumeTimers(dst);

  assert.equal(dst.breakoutPct, 0.02, 'resume must restore breakoutPct');
  near(dst.bullBreakout, src.bullBreakout, 'resume must re-derive the same bull entry level');
  near(dst.bearBreakout, src.bearBreakout, 'resume must re-derive the same bear entry level');
});

test('_closeQuantity reads the open leg, not activePosition', () => {
  const s = breakoutStrategy();
  s.roundQuantity = (q) => q;
  s.openLeg = { direction: 'LONG', quantity: 3, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 3 };
  assert.equal(s._closeQuantity(), 3);
});

// The fail-safe that stops a stale REST read orphaning part of a position.
test('_closeQuantity takes the LARGER of leg and REST quantity', () => {
  const s = breakoutStrategy();
  s.roundQuantity = (q) => q;
  s.activePosition = { quantity: 1 };
  s.openLeg = { direction: 'LONG', quantity: 3, fillPrice: 101.5, openedAt: 1 };
  assert.equal(s._closeQuantity(), 3, 'an under-sized close orphans the remainder');
  s.openLeg.quantity = 0.5;
  assert.equal(s._closeQuantity(), 1, 'reduceOnly clamps an over-sized close — max() is safe both ways');
});

// "Flat" and "unknown" are different states.
test('_closeQuantity returns 0 only when Binance was REACHABLE and said flat', () => {
  const s = breakoutStrategy();
  s.roundQuantity = (q) => q;
  s.activePosition = null;
  s.openLeg = { direction: 'LONG', quantity: 3, fillPrice: 101.5, openedAt: 1 };

  s._lastPositionRefreshFailed = false;
  assert.equal(s._closeQuantity(), 0, 'reachable + flat -> the leg is stale bookkeeping');

  s._lastPositionRefreshFailed = true;
  assert.equal(s._closeQuantity(), 3, 'UNKNOWN must never read as flat');
});

test('_openPosition records the ACTUAL fill, never the requested quantity', async () => {
  const s = breakoutStrategy();
  let placed = null;
  s._ladderBaseSize = 1000;
  s._quantityFor = async () => 10;
  s.placeMarketOrder = async (symbol, side, qty) => { placed = { symbol, side, qty }; return { orderId: 7 }; };
  // _resolveFill returns { filledQty, fillPrice, source } — see line 633.
  s._resolveFill = async () => ({ filledQty: 9.4, fillPrice: 101.62, source: 'ws' });

  await s._openPosition('LONG');

  assert.deepEqual(placed, { symbol: 'BTCUSDT', side: 'BUY', qty: 10 });
  assert.equal(s.openLeg.direction, 'LONG');
  assert.equal(s.openLeg.quantity, 9.4, 'the WS fill wins over the requested qty');
  assert.equal(s.openLeg.fillPrice, 101.62);
  assert.equal(s.heldSide, 'LONG');
});

test('_openPosition sells for a SHORT', async () => {
  const s = breakoutStrategy();
  let side = null;
  s._quantityFor = async () => 10;
  s.placeMarketOrder = async (_sym, sd) => { side = sd; return { orderId: 8 }; };
  s._resolveFill = async () => ({ filledQty: 10, fillPrice: 96.5, source: 'ws' });
  await s._openPosition('SHORT');
  assert.equal(side, 'SELL');
  assert.equal(s.heldSide, 'SHORT');
});

test('_openPosition refuses to open while a position is already held', async () => {
  const s = breakoutStrategy();
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: 1 };
  s.placeMarketOrder = async () => { throw new Error('must not be called'); };
  await assert.rejects(() => s._openPosition('SHORT'), /already open/);
});

// Fix round 1 — the review-caught defect: 'OPEN_BREAKOUT' must retry the REST
// position read (Binance's ~100-500ms fill lag), or a lagged read comes back
// null with _lastPositionRefreshFailed still false — which _closeQuantity()
// reads as "reachable and flat" moments after a real position opened. A
// closing action must NOT retry (it expects empty). breakoutStrategy() stubs
// _postExecuteBookkeeping itself, so call the real prototype method directly.
test('_postExecuteBookkeeping retries the position refresh for a fresh OPEN, not for a close', async () => {
  const s = breakoutStrategy();
  const expectNonEmptyCalls = [];
  s._refreshCurrentPosition = async (expectNonEmpty) => { expectNonEmptyCalls.push(expectNonEmpty); };
  // TradingBase's constructor sets a REAL `this.firestore` client (see
  // trading-base.js), so calling the real prototype method (bypassing
  // breakoutStrategy()'s stub) reaches the real, un-mocked
  // _writeMetricsSample and tries to authenticate against GCP — an
  // unhandled rejection that lands after this test's own awaits finish.
  // Stub it, same as breakoutStrategy() already does for saveState /
  // _writeStrategyFlow / addLog / _pushHeartbeatNow.
  s._writeMetricsSample = async () => {};

  await ReversalLadderStrategy.prototype._postExecuteBookkeeping.call(s, 'OPEN_BREAKOUT', {});
  await ReversalLadderStrategy.prototype._postExecuteBookkeeping.call(s, 'STOP_OUT', {});

  assert.deepEqual(expectNonEmptyCalls, [true, false],
    'OPEN_BREAKOUT must retry against Binance REST lag; a close must not');
});

// Fix round 1 — MINOR: pin the openLeg = null placement directly rather than
// by inspection. It sits after the sole `if (!verified) return false;`, so it
// can only ever run on a VERIFIED close.
test('_closeConsolidated nulls openLeg only on a VERIFIED close', async () => {
  const s = breakoutStrategy();
  s.currentSide = 'LONG';
  s.openLeg = { direction: 'LONG', quantity: 3, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 3 };
  s.placeMarketOrder = async () => ({ orderId: 1, executedQty: '3' });
  s._waitForOrderFillConfirmation = async () => true; // tier 1: WS fill confirmed

  const closed = await s._closeConsolidated('test');

  assert.equal(closed, true);
  assert.equal(s.openLeg, null, 'a verified close must clear the leg ledger');
});

test('_closeConsolidated leaves openLeg INTACT on an unverified close', async () => {
  const s = breakoutStrategy();
  s.currentSide = 'LONG';
  const leg = { direction: 'LONG', quantity: 3, fillPrice: 101.5, openedAt: 1 };
  s.openLeg = leg;
  s.activePosition = { quantity: 3 };
  s.placeMarketOrder = async () => ({ orderId: 2 }); // no executedQty — tier 2 can't verify either
  s._waitForOrderFillConfirmation = async () => false; // tier 1: no WS fill event
  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = true; }; // tier 3: still unknown

  const closed = await s._closeConsolidated('test');

  assert.equal(closed, false);
  assert.equal(s.openLeg, leg, 'an unverified close must leave the leg ledger intact — the position stays tracked');
});
