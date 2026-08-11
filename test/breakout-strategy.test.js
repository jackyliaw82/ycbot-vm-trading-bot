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

// Final-fix-round CRITICAL 1: `openLeg` had NO writer in saveState's doc
// literal and no reader in resume() — a restart mid-position resumed with
// openLeg/heldSide both null, dropping the Final TP/stop/trail entirely and
// leaving `_openPosition`'s `if (this.openLeg)` guard free to open a SECOND
// full-size position on the very next crossing. Unlike the round-trip test
// above (which is deliberately flat), this one resumes a LIVE position.
test('resume with an OPEN position restores openLeg/heldSide and refuses a second open (Critical 1)', async () => {
  const src = breakoutStrategy({ bull: 100, bear: 98, pct: 0.02 });
  src.openLeg = { direction: 'LONG', quantity: 5, fillPrice: 102, openedAt: 101.9 };
  src.activePosition = { quantity: 5, entryPrice: 102, notional: 510, unrealizedPnl: 12 };
  src.currentSide = 'LONG';

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(src);

  assert.deepEqual(doc.openLeg, src.openLeg, 'openLeg must be written to the persisted doc');

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await assert.doesNotReject(() => dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' }));
  cleanupResumeTimers(dst);

  assert.deepEqual(dst.openLeg, src.openLeg, 'resume must restore openLeg');
  assert.equal(dst.heldSide, 'LONG', 'heldSide must be re-derived from the restored openLeg');
  near(dst.bullBreakout, src.bullBreakout, 'resume must re-derive the same bull entry level');
  near(dst.bearBreakout, src.bearBreakout, 'resume must re-derive the same bear entry level');

  // A subsequent crossing must NOT open a second position — `_openPosition`'s
  // guard reads `this.openLeg`, which must be non-null after a correct resume.
  dst.placeMarketOrder = async () => { throw new Error('must not be called — a position is already open'); };
  await assert.rejects(() => dst._openPosition('SHORT'), /already open/);
});

// ——— openLeg reconciliation on resume (fix round 3) —————————————————————
//
// `_closeConsolidated` nulls `openLeg` in memory, but the `saveState()` that
// persists that null runs several `await`s later. A crash in that window
// leaves the LAST-persisted snapshot holding a non-null `openLeg` for a
// position Binance has already closed. resume() must reconcile it against
// Binance using the SAME flat-vs-unknown protocol `_closeQuantity()` already
// encodes — clearing only when the refresh actually PROVES flat, never on an
// unverified/failed refresh.

test('resume discards a phantom openLeg when Binance is reachable and reports flat', async () => {
  const src = breakoutStrategy({ bull: 100, bear: 98, pct: 0.02 });
  // Simulates the crash window: the position was already closed on Binance,
  // but the persisted snapshot still carries the pre-close leg.
  src.openLeg = { direction: 'LONG', quantity: 5, fillPrice: 102, openedAt: 101.9 };
  src.activePosition = { quantity: 5, entryPrice: 102, notional: 510, unrealizedPnl: 12 };
  src.currentSide = 'LONG';

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  // Binance is reachable and the position is ACTUALLY closed.
  dst._refreshCurrentPosition = async () => {
    dst._lastPositionRefreshFailed = false;
    dst.activePosition = null;
    dst.currentSide = null;
  };
  await assert.doesNotReject(() => dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' }));
  cleanupResumeTimers(dst);

  assert.equal(dst.openLeg, null, 'a phantom leg must be discarded once Binance CONFIRMS flat');
  assert.equal(dst.heldSide, null, 'heldSide must clear so the strategy can trade again');
});

test('resume KEEPS a persisted openLeg when the position refresh fails — unknown must never read as flat', async () => {
  const src = breakoutStrategy({ bull: 100, bear: 98, pct: 0.02 });
  src.openLeg = { direction: 'LONG', quantity: 5, fillPrice: 102, openedAt: 101.9 };
  src.activePosition = { quantity: 5, entryPrice: 102, notional: 510, unrealizedPnl: 12 };
  src.currentSide = 'LONG';

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  // Binance is UNREACHABLE — state is unknown, not flat.
  dst._refreshCurrentPosition = async () => { dst._lastPositionRefreshFailed = true; };
  await assert.doesNotReject(() => dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' }));
  cleanupResumeTimers(dst);

  assert.deepEqual(dst.openLeg, src.openLeg, 'an unverified refresh must never discard a real leg — unknown is not flat');
  assert.equal(dst.heldSide, 'LONG', 'the leg — and therefore heldSide — must survive an unknown refresh');
});

// ——— trail restore (fix round 2, Important 1) ——————————————————————————
//
// Task 3 removed the trail's upper cap so it can ratchet PAST the entry level
// and lock real profit. `_restoreTrailFromSnapshot` must clamp FLOOR-ONLY
// (matching `trailExitLevel`'s own semantics), never back down to the
// two-sided ladder-era clamp — that would discard a locked-in profit on
// every VM restart.

test('_restoreTrailFromSnapshot keeps a locked-in LONG profit above bullLevel unchanged (Important 1)', () => {
  const s = breakoutStrategy({ bull: 100, bear: 98 });
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: 1 };
  s._restoreTrailFromSnapshot({ trailEnabled: true, trailDistanceValue: 1.5, trailExit: 105 });
  assert.equal(s.trailExit, 105, 'a trailExit locked above bullLevel must survive resume unchanged, not clamp down to bullLevel');
});

test('_restoreTrailFromSnapshot mirrors for a locked-in SHORT profit below bearLevel', () => {
  const s = breakoutStrategy({ bull: 100, bear: 98 });
  s.openLeg = { direction: 'SHORT', quantity: 1, fillPrice: 96.5, openedAt: 1 };
  s._restoreTrailFromSnapshot({ trailEnabled: true, trailDistanceValue: 1.5, trailExit: 93 });
  assert.equal(s.trailExit, 93, 'a trailExit locked below bearLevel must survive resume unchanged, not clamp up to bearLevel');
});

test('_restoreTrailFromSnapshot still floors a stale LONG exit back up to bullLevel', () => {
  const s = breakoutStrategy({ bull: 100, bear: 98 });
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: 1 };
  s._restoreTrailFromSnapshot({ trailEnabled: true, trailDistanceValue: 1.5, trailExit: 95 });
  assert.equal(s.trailExit, 100, 'a stale exit below the floor must be pulled back up to bullLevel, not preserved below it');
});

test('_restoreTrailFromSnapshot nulls the exit when nothing is held', () => {
  const s = breakoutStrategy({ bull: 100, bear: 98 });
  s.openLeg = null;
  s._restoreTrailFromSnapshot({ trailEnabled: true, trailDistanceValue: 1.5, trailExit: 105 });
  assert.equal(s.trailExit, null, 'a flat run has no held side and therefore no meaningful exit level');
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

// ——— tick dispatch (Task 6) ————————————————————————————————————————

function captureOpens(s) {
  const opens = [];
  s._openPosition = async (side) => {
    s.openLeg = { direction: side, quantity: 1, fillPrice: side === 'LONG' ? s.bullBreakout : s.bearBreakout, openedAt: s.currentPrice };
    opens.push(side);
  };
  return opens;
}

function captureCloses(s) {
  const closes = [];
  s._closeConsolidated = async (reason) => { s.openLeg = null; closes.push(reason); return true; };
  s._closeQuantity = () => (s.openLeg ? s.openLeg.quantity : 0);
  return closes;
}

test('the band is inert — no order anywhere between the entry levels', async () => {
  const s = breakoutStrategy();
  const opens = captureOpens(s);
  for (const p of [99, 101, 97, 100.9, 96.6, 99]) await s.handleRealtimePrice(p);
  assert.deepEqual(opens, []);
  assert.equal(s.heldSide, null);
});

test('crossing bullBreakout upward opens exactly one LONG', async () => {
  const s = breakoutStrategy();
  const opens = captureOpens(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(103);
  assert.deepEqual(opens, ['LONG'], 'no scaling — one position per cycle leg');
});

test('a LONG closes at bullLevel and the cycle continues', async () => {
  const s = breakoutStrategy();
  captureOpens(s);
  const closes = captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  assert.equal(s.heldSide, 'LONG');
  await s.handleRealtimePrice(99.9);
  assert.equal(s.heldSide, null);
  assert.equal(closes.length, 1);
  assert.equal(s.isRunning, true, 'a stop-out does not end the cycle');
});

// Final-fix-round MINOR: `reversalCount` is write-only (nothing ever
// increments it) yet fed `tradeCount`, so a cycle with several stop-outs
// reported 0 trades. `stopOutCount` is the real counter now.
test('a verified stop-out increments stopOutCount, not the dead reversalCount (Minor)', async () => {
  const s = breakoutStrategy();
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 1 };
  s._closeConsolidated = async () => { s.openLeg = null; s.activePosition = null; return true; };
  s._closeQuantity = () => (s.openLeg ? s.openLeg.quantity : 0);

  const ok = await s._stopOut(99.9);

  assert.equal(ok, true);
  assert.equal(s.stopOutCount, 1, 'a verified stop-out must increment stopOutCount');
  assert.equal(s.reversalCount, 0, 'reversalCount stays dead — nothing writes it anymore');
});

test('an unverified stop-out does not increment stopOutCount', async () => {
  const s = breakoutStrategy();
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 1 };
  s._closeConsolidated = async () => false; // unverified — leg stays tracked
  s._closeQuantity = () => (s.openLeg ? s.openLeg.quantity : 0);

  const ok = await s._stopOut(99.9);

  assert.equal(ok, false);
  assert.equal(s.stopOutCount, 0, 'an aborted stop-out must not count as a trade');
});

test('after closing at bullLevel, no SHORT opens until bearBreakout', async () => {
  const s = breakoutStrategy();
  const opens = captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(99.9);
  await s.handleRealtimePrice(98);       // bearLevel — an exit level, not an entry
  await s.handleRealtimePrice(97);
  assert.deepEqual(opens, ['LONG'], 'no immediate flip');
  await s.handleRealtimePrice(96.4);
  assert.deepEqual(opens, ['LONG', 'SHORT']);
});

test('the two-tick rule: a close opens nothing on the same tick', async () => {
  const s = breakoutStrategy();
  const opens = captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(96.4);              // gap: closes the LONG only
  assert.deepEqual(opens, ['LONG']);
  assert.equal(s._pendingEntry, 'SHORT');
  await s.handleRealtimePrice(96.3);              // next tick consumes the latch
  assert.deepEqual(opens, ['LONG', 'SHORT']);
  assert.equal(s._pendingEntry, null);
});

test('the gap latch is dropped if price returns inside the band', async () => {
  const s = breakoutStrategy();
  const opens = captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(96.4);
  assert.equal(s._pendingEntry, 'SHORT');
  await s.handleRealtimePrice(99);
  assert.equal(s._pendingEntry, null);
  assert.deepEqual(opens, ['LONG']);
});

test('Final TP ends the cycle', async () => {
  const s = breakoutStrategy();
  captureOpens(s);
  let stopped = null;
  s.stop = async (opts) => { stopped = opts; s.isRunning = false; };
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  s.finalTpPrice = 105;
  await s.handleRealtimePrice(105.2);
  assert.deepEqual(stopped, { flatten: true, reason: 'final_tp' });
});

test('with trailing off the stop stays pinned at bullLevel', async () => {
  const s = breakoutStrategy();
  s.trailEnabled = false;
  captureOpens(s);
  const closes = captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(110);              // a big favourable run
  assert.equal(s.heldSide, 'LONG');
  await s.handleRealtimePrice(103);              // above bullLevel — no exit
  assert.equal(s.heldSide, 'LONG');
  await s.handleRealtimePrice(99.9);
  assert.equal(closes.length, 1);
});

test('with trailing on the stop ratchets above the entry and locks profit', async () => {
  const s = breakoutStrategy();
  s.trailEnabled = true;
  captureOpens(s);
  const closes = captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(110);
  assert.ok(s.trailExit > s.bullBreakout, `trail ${s.trailExit} should lock profit above ${s.bullBreakout}`);
  await s.handleRealtimePrice(107);
  assert.equal(closes.length, 1, 'the ratcheted trail owns the close');
});

test('an unverified close leaves the position tracked and re-scans next tick', async () => {
  const s = breakoutStrategy();
  captureOpens(s);
  s._closeConsolidated = async () => false;      // unverified — leg NOT cleared
  s._closeQuantity = () => (s.openLeg ? s.openLeg.quantity : 0);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  const before = s.lastProcessedPrice;
  await s.handleRealtimePrice(99.9);
  assert.equal(s.heldSide, 'LONG', 'the leg must survive an unverified close');
  assert.equal(s.lastProcessedPrice, before, 'the band must be re-scanned next tick');
});

// ——— fix round 1: the gap latch must never re-arm the side that just closed ———
//
// Task 3 removed the trail's upper cap so it can ratchet PAST the entry level
// and lock real profit — which means a routine profitable exit can close a
// LONG at a price still above bullBreakout (or a SHORT still below
// bearBreakout). The latch decision must be keyed off the side that just
// closed, captured BEFORE the close (which nulls openLeg), not off price alone.

test('a trailing LONG that exits ABOVE bullBreakout does not latch a re-entry', async () => {
  const s = breakoutStrategy();
  s.trailEnabled = true;
  const opens = captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(110);              // trail ratchets to 108.5
  await s.handleRealtimePrice(107);               // hit — closes at 107, still > bullBreakout 101.5
  assert.equal(s._pendingEntry, null, 'must not re-arm the side that just closed');
  await s.handleRealtimePrice(107.1);              // still above bullBreakout — no fresh crossing
  assert.deepEqual(opens, ['LONG'], 'no uncommanded re-entry');
});

test('a trailing SHORT that exits BELOW bearBreakout does not latch a re-entry', async () => {
  const s = breakoutStrategy();
  s.trailEnabled = true;
  const opens = captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(96);                // opens SHORT (96 <= bearBreakout 96.53)
  assert.deepEqual(opens, ['SHORT']);
  await s.handleRealtimePrice(90);                 // trail ratchets down to 91.47
  await s.handleRealtimePrice(93);                 // hit — closes at 93, still < bearBreakout 96.53
  assert.equal(s._pendingEntry, null, 'must not re-arm the side that just closed');
  await s.handleRealtimePrice(92.9);               // still below bearBreakout — no fresh crossing
  assert.deepEqual(opens, ['SHORT'], 'no uncommanded re-entry');
});

test('the genuine gap case still latches: a LONG stopped out below bearBreakout arms SHORT', async () => {
  const s = breakoutStrategy();                    // trailEnabled: false — pinned stop at bullLevel
  captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(96.4);                // gap straight through bullLevel past bearBreakout
  assert.equal(s._pendingEntry, 'SHORT', 'a genuine opposite-side gap must still latch');
});

// ——— fix round 1: the latch must survive a failed open ———

test('when _openPosition throws, the latch survives and lastProcessedPrice does not advance', async () => {
  const s = breakoutStrategy();
  captureOpens(s);
  captureCloses(s);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(101.6);
  await s.handleRealtimePrice(96.4);                // stop-out; latches SHORT
  assert.equal(s._pendingEntry, 'SHORT');
  const beforePrice = s.lastProcessedPrice;

  s._openPosition = async () => { throw new Error('Binance rejected the order'); };
  await assert.rejects(() => s.handleRealtimePrice(96.3));  // consumes the latch, open throws

  assert.equal(s._pendingEntry, 'SHORT', 'a failed open must not consume the latch');
  assert.equal(s.lastProcessedPrice, beforePrice, 'a failed open must not advance lastProcessedPrice');
});

// ——— harvest / re-anchor (_harvestToFlat) — Task 7 ——————————————————————
//
// _harvestToFlat is the shipped Harvest / Re-anchor button plus armed price
// triggers. It survived the ladder-to-breakout sweep by name but had gone
// dark — the module it called into was deleted — so it would have thrown a
// TypeError on every real invocation. The test file that covered it was
// deleted earlier in this plan; these tests are its replacement.
//
// _planAndBuildLevels/_closeConsolidated/_writeMetricsSample are the real
// (unstubbed by breakoutStrategy()) prototype methods here, so they are
// stubbed per-test: _planAndBuildLevels and _closeConsolidated would
// otherwise reach real network/AI-planner and Binance calls, and
// _writeMetricsSample would attempt a real Firestore write that rejects
// after the test has already finished.

test('_harvestToFlat runs to completion on a flat run — closes nothing, clears the leg, re-plans', async () => {
  const s = breakoutStrategy();
  s.openLeg = null;
  s.activePosition = null;
  let closeCalls = 0;
  s._closeConsolidated = async () => { closeCalls++; return false; }; // nothing open — matches the real self-gate
  let replanCalls = 0;
  s._planAndBuildLevels = async () => { replanCalls++; return true; };
  s._writeMetricsSample = async () => {};

  const result = await s._harvestToFlat('manual_harvest');

  assert.equal(result, true, 'a flat re-anchor still reaches the re-plan and reports success');
  assert.equal(closeCalls, 1);
  assert.equal(s.openLeg, null, 'stays cleared');
  assert.equal(replanCalls, 1, 'levels must be re-planned');
  assert.equal(s.reanchorCount, 1);
  assert.equal(s.harvestCount, 0, 'a flat run with nothing closed is a re-anchor, not a harvest');
});

test('_harvestToFlat runs to completion while holding a position — closes it, clears the leg, re-plans', async () => {
  const s = breakoutStrategy();
  s.openLeg = { direction: 'LONG', quantity: 2, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 2, unrealizedPnl: 5 };
  let closeCalls = 0;
  s._closeConsolidated = async () => { closeCalls++; s.openLeg = null; s.activePosition = null; return true; };
  let replanCalls = 0;
  s._planAndBuildLevels = async () => { replanCalls++; return true; };
  s._writeMetricsSample = async () => {};

  const result = await s._harvestToFlat('manual_harvest');

  assert.equal(result, true);
  assert.equal(closeCalls, 1, 'the open position must actually be closed');
  assert.equal(s.openLeg, null, 'the leg ledger must be cleared');
  assert.equal(replanCalls, 1, 'levels must be re-planned after the harvest');
  assert.equal(s.harvestCount, 1, 'a verified close with inventory counts as a harvest');
});

// The guard that stops a failed close from orphaning a live position — the
// only thing preventing _harvestToFlat from wiping the leg ledger out from
// under an order that never actually closed.
test('_harvestToFlat aborts and leaves the position tracked when the close is unverified', async () => {
  const s = breakoutStrategy();
  const leg = { direction: 'LONG', quantity: 2, fillPrice: 101.5, openedAt: 1 };
  s.openLeg = leg;
  s.activePosition = { quantity: 2 };
  s._closeConsolidated = async () => false; // unverified close — nothing actually confirmed closed
  let replanCalls = 0;
  s._planAndBuildLevels = async () => { replanCalls++; return true; };
  s._writeMetricsSample = async () => {};

  const result = await s._harvestToFlat('manual_harvest');

  assert.equal(result, false, 'an aborted harvest must not report success');
  assert.equal(s.openLeg, leg, 'the leg ledger must survive an unverified close — the position stays tracked');
  assert.equal(replanCalls, 0, 'must not rebuild levels while a live position is still unaccounted for');
});

// Final-fix-round CRITICAL 2: `_harvestToFlat` nulled bullLevel/bearLevel but
// NOT bullBreakout/bearBreakout. The tick gate in `handleRealtimePrice` keys
// off `this.bullBreakout == null || this.bearBreakout == null` to decide
// whether to re-plan — so when `_planAndBuildLevels` fails (a throttle, the
// AI planner unavailable, the price-staleness discard), the old code left
// non-null stale entry levels behind and the gate never fired again: the
// strategy would trade last cycle's stale levels forever, with a null
// bullLevel/bearLevel silencing both stop framings in
// `_updateTrailAndCheckHit`.
test('_harvestToFlat nulls bullBreakout/bearBreakout when the re-plan fails (Critical 2)', async () => {
  const s = breakoutStrategy();
  s.openLeg = { direction: 'LONG', quantity: 2, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 2, unrealizedPnl: 5 };
  s._closeConsolidated = async () => { s.openLeg = null; s.activePosition = null; return true; };
  s._planAndBuildLevels = async () => false; // throttled / AI unavailable / price-staleness discard
  s._writeMetricsSample = async () => {};

  assert.ok(s.bullBreakout != null && s.bearBreakout != null, 'sanity: the fixture starts with real entry levels');

  const result = await s._harvestToFlat('manual_harvest');

  assert.equal(result, true, 'the harvest itself still completes even though the re-plan failed');
  assert.equal(s.bullLevel, null);
  assert.equal(s.bearLevel, null);
  assert.equal(s.bullBreakout, null, 'a failed re-plan must leave no stale entry level behind — else the tick gate never re-plans again');
  assert.equal(s.bearBreakout, null, 'a failed re-plan must leave no stale entry level behind — else the tick gate never re-plans again');
});

// ——— stop() residual verification (fix round 2, Test 4) ————————————————
//
// stop({flatten:true}) has zero coverage in this file — every other test that
// touches stop() stubs it out entirely. This is the last moment anyone is
// watching: if the close cannot be verified against Binance, the strategy
// must never report a clean "confirmed flat" stop, and must say so loudly
// rather than silently terminating.

function stubStopTail(s) {
  s._pollFundingIncome = async () => {};
  s.cleanupWebSockets = () => {};
  s.deductPlatformFee = async () => {};
  s._recordHeroProfit = async () => {};
  s._deleteNoTradeStrategyDoc = async () => {};
  return s;
}

test('stop({flatten:true}) reports FINAL STATE UNKNOWN — never "confirmed flat" — when the close cannot be verified', async () => {
  const s = stubStopTail(breakoutStrategy());
  s.openLeg = { direction: 'LONG', quantity: 2, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 2, entryPrice: 101.5, notional: 203, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.isRunning = true;

  // Binance is unreachable throughout: the pre-flatten refresh, the close
  // attempt, and the post-flatten residual-verification refresh all fail.
  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = true; };
  s.placeMarketOrder = async () => { throw new Error('-1001 Internal error'); };

  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s.stop({ flatten: true });

  assert.ok(
    !logs.some((m) => m.includes('position confirmed flat')),
    'the user must NEVER be told the position is confirmed flat while the position state is UNKNOWN',
  );
  assert.ok(
    logs.some((m) => m.includes('WARNING') && m.includes('FINAL STATE UNKNOWN')),
    'an unverified close must be reported loudly, not silently — this is the last moment anyone is watching',
  );
  assert.ok(
    logs.some((m) => m.includes('FINAL STATE UNKNOWN') && m.includes('openLeg qty 2')),
    'the warning must name what was still tracked, not silently discard it',
  );
  assert.equal(s.executionState, 'TERMINATED', 'stop() still completes termination — it never hangs open on an unverified close');
});

test('stop({flatten:true}) reports "confirmed flat" when the close is actually verified', async () => {
  const s = stubStopTail(breakoutStrategy());
  s.openLeg = { direction: 'LONG', quantity: 2, fillPrice: 101.5, openedAt: 1 };
  s.activePosition = { quantity: 2, entryPrice: 101.5, notional: 203, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.isRunning = true;

  s._refreshCurrentPosition = async () => { s._lastPositionRefreshFailed = false; };
  s.placeMarketOrder = async () => ({ orderId: 1, executedQty: '2' }); // REST-ack tier verifies the close
  s._waitForOrderFillConfirmation = async () => false; // force tier 2 (REST-ack), not tier 1

  const logs = [];
  s.addLog = async (msg) => { logs.push(msg); };

  await s.stop({ flatten: true });

  assert.ok(logs.some((m) => m.includes('position confirmed flat')), 'a genuinely verified flat is still reported as such');
  assert.ok(!logs.some((m) => m.includes('FINAL STATE UNKNOWN')), 'no cry-wolf on the verified path');
  assert.equal(s.executionState, 'TERMINATED');
});

test('both status channels emit stopOutCount', () => {
  const s = breakoutStrategy();
  s.stopOutCount = 4;
  assert.equal(s.getStatus().stopOutCount, 4, 'getStatus must carry it');
  assert.equal(s.getHeartbeatPayload().stopOutCount, 4, 'the WS payload must agree with getStatus');
});
