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
