import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReversalLadderStrategy } from '../reversal-ladder-strategy.js';
import { LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE, LADDER_STEP_PCT_MAX, LADDER_LEVELS_MAX } from '../ladder-levels.js';
import { buildReversalLadder } from '../reversal-levels.js';
import { precisionFormatter } from '../precisionUtils.js';

// A strategy with both ladders built and nothing open. All I/O stubbed, so a
// tick exercises only the dispatch. bull 102 / bear 98 puts the dead zone at
// 98..102 with price parked at 100 in the middle of it.
function reversalStrategy({ mode = 'SCALING', bull = 102, bear = 98, base = 1000 } = {}) {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  s.isRunning = true;
  s.strategyId = 'reversal_ladder_test';
  s.symbol = 'BTCUSDT';
  s.stepPct = LADDER_STEP_PCT;
  s.levelsPerSide = LADDER_LEVELS_PER_SIDE;
  s.ladderMode = mode;
  s.bullLevel = bull;
  s.bearLevel = bear;
  s.ladderLines = buildReversalLadder(bull, bear, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE);
  s.currentPrice = 100;
  s.lastProcessedPrice = 100;
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
  s._pushHeartbeatNow = () => {};
  s._computeLadderBaseSize = async () => s._ladderBaseSize;
  return s;
}

// Record fills instead of trading. Returns the array the test asserts on.
function captureFills(s) {
  const filled = [];
  s._fillLeg = async (leg) => {
    leg.state = 'POSITION_OPEN';
    leg.quantity = 1;
    leg.fillPrice = leg.price;
    filled.push(`${leg.direction === 'LONG' ? 'L' : 'S'}${leg.index}`);
  };
  return filled;
}

// §14.1 — the dead zone is the whole anti-churn mechanism.
test('dead zone: no fill anywhere strictly between the levels', async () => {
  const s = reversalStrategy();
  const filled = captureFills(s);
  await s.handleRealtimePrice(99);
  await s.handleRealtimePrice(101);
  await s.handleRealtimePrice(99.5);
  assert.deepEqual(filled, []);
  assert.equal(s.heldSide, null);
});

// §14.2 — entry at bull fills L1 only; L1 IS bullLevel.
test('crossing bull fills L1 only, and a continued rise fills L2', async () => {
  const s = reversalStrategy();
  const filled = captureFills(s);
  await s.handleRealtimePrice(102);
  assert.deepEqual(filled, ['L1']);
  assert.equal(s.heldSide, 'LONG');
  await s.handleRealtimePrice(102.31);   // L2 = 102 * 1.003 = 102.306
  assert.deepEqual(filled, ['L1', 'L2']);
});

// §14.3 — a reversal closes, resets the abandoned ledger, and opens the other
// side on the SAME tick. The two-tick rule does NOT apply to a reversal.
test('reversal closes, resets the abandoned side, and opens S1 on the same tick', async () => {
  const s = reversalStrategy();
  const filled = captureFills(s);
  await s.handleRealtimePrice(102);
  assert.deepEqual(filled, ['L1']);

  let closes = 0;
  s._closeConsolidated = async () => { closes++; return true; };
  s._closeQuantity = () => 0;
  await s.handleRealtimePrice(98);

  assert.equal(closes, 1, 'the held LONG must be closed');
  assert.deepEqual(filled, ['L1', 'S1'], 'S1 opens on the same tick');
  assert.equal(s.heldSide, 'SHORT');
  assert.equal(
    s.ladderLines.filter(l => l.direction === 'LONG' && l.state !== 'EMPTY').length, 0,
    'every abandoned LONG leg must be reset to EMPTY',
  );
  assert.equal(s.reversalCount, 1);
});

// §14.4 — a gap that straddles both levels resolves to the LANDING side only.
test('straddle gap opens only the side price landed on', async () => {
  const s = reversalStrategy();
  const filled = captureFills(s);
  s.lastProcessedPrice = 97;   // below bear, but nothing held
  await s.handleRealtimePrice(103);
  assert.ok(filled.every(f => f.startsWith('L')), `expected LONG-only fills, got ${filled}`);
  assert.equal(s.heldSide, 'LONG');
});

// §14.5 — the outermost leg filling is what arms Final TP.
test('filling the outermost leg enters TREND and arms Final TP', async () => {
  const s = reversalStrategy();
  captureFills(s);
  s.activePosition = { quantity: 5, entryPrice: 103, notional: 515, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  await s.handleRealtimePrice(103.5);  // L5 = 102 * 1.012 = 103.224
  assert.equal(s.ladderMode, 'TREND');
  assert.equal(s.trendDirection, 'LONG');
  assert.ok(s.finalTpPrice > 103, 'Final TP must be armed above entry');
});

// An unverified close must never wipe the ledger — the tombstone.
test('reversal aborts and fills nothing when the close cannot be verified', async () => {
  const s = reversalStrategy();
  const filled = captureFills(s);
  await s.handleRealtimePrice(102);
  filled.length = 0;

  s._closeConsolidated = async () => false;
  s._closeQuantity = () => 1;            // inventory still open
  await s.handleRealtimePrice(98);

  assert.deepEqual(filled, [], 'no leg may open while a close is unverified');
  assert.equal(
    s.ladderLines.filter(l => l.direction === 'LONG' && l.state === 'POSITION_OPEN').length, 1,
    'the open LONG leg must stay tracked',
  );
  assert.equal(s.reversalCount, 0, 'an aborted reversal is not counted');
});

// The band must be re-scanned next tick after an abort.
test('an aborted reversal does not advance lastProcessedPrice', async () => {
  const s = reversalStrategy();
  captureFills(s);
  await s.handleRealtimePrice(102);
  s._closeConsolidated = async () => false;
  s._closeQuantity = () => 1;
  await s.handleRealtimePrice(98);
  assert.equal(s.lastProcessedPrice, 102, 'the unprocessed band must be re-scanned');
});

// The empty-ladder gate must never trade without levels.
test('no levels planned: the tick gate builds nothing and opens nothing', async () => {
  const s = reversalStrategy();
  const filled = captureFills(s);
  s.ladderLines = [];
  s.bullLevel = null;
  s.bearLevel = null;
  s._planAndBuildLevels = async () => false;   // planning failed
  await s.handleRealtimePrice(102);
  assert.deepEqual(filled, []);
  assert.equal(s.ladderLines.length, 0);
});

// §14.8 — every close accumulates, INCLUDING profitable ones, which reduce the
// figure. A reduced accumulated loss lowers the Final TP the next TREND must
// reach and relaxes dynamic sizing, so this must not floor at the running max.
test('a profitable close REDUCES cycleAccumulatedLoss', () => {
  const s = reversalStrategy();
  s.accumulatedRealizedPnL = -100;
  s.accumulatedTradingFees = 10;
  s.accumulatedFundingFees = 0;
  assert.equal(s._computeAccLoss(), 110);

  s.accumulatedRealizedPnL = -40;    // a later close banked +60
  assert.equal(s._computeAccLoss(), 50, 'profit must pay the accumulated loss down');

  s.accumulatedRealizedPnL = 200;    // net positive overall
  assert.equal(s._computeAccLoss(), 0, 'accLoss floors at 0, never goes negative');
});

// §14.12 (part 1) — the persisted shape. The anchor-era fields must be gone and
// the level-era fields present, or resume() silently restores nothing.
test('saveState persists the level state and no anchor state', async () => {
  const s = reversalStrategy();
  s.reversalCount = 3;
  let written = null;
  s.saveState = ReversalLadderStrategy.prototype.saveState;   // un-stub
  s.firestore = {
    collection: () => ({ doc: () => ({ set: async (doc) => { written = doc; } }) }),
  };
  await s.saveState();
  assert.equal(written.type, 'REVERSAL_LADDER');
  assert.equal(written.strategyType, 'reversalLadder');
  assert.equal(written.bullLevel, 102);
  assert.equal(written.bearLevel, 98);
  assert.equal(written.ladderMode, 'SCALING');
  assert.equal(written.reversalCount, 3);
  assert.ok(!('anchor' in written), 'the anchor must not be persisted');
  assert.ok(!('flattenCount' in written), 'flattenCount must not be persisted');
  assert.ok(!('startTriggerPrice' in written), 'Start Mode must not be persisted');
  assert.ok(!('trailDirection' in written), 'Anchor Trailing must not be persisted');
});

// ——— _planAndBuildLevels: the real method, unstubbed ——————————————————
//
// Every OTHER test in this file that reaches _planAndBuildLevels stubs it
// directly. These pin the real gate: the in-progress guard, the throttle, the
// !result fail-closed branch, the catch, and (review finding 1) the stale-price
// re-check against the LIVE price after buildLevelContext's awaited fetches.

// A profile whose fallback void pair (via selectVoidPair) is bull 104 / bear
// 97.8 against currentPrice 101 — pinned by test/level-context-e2e.test.js's
// own e2e assertions, reused here rather than re-deriving the void math.
const REAL_PLAN_PROFILE = {
  poc: { price: 100.5 }, vah: 102, val: 99,
  rangeVoids: [{ priceLow: 97, priceHigh: 97.8 }, { priceLow: 104, priceHigh: 105 }],
};

test('_planAndBuildLevels: the in-progress guard returns false without re-planning', async () => {
  const s = reversalStrategy();
  let called = false;
  s.volumeProfile = { getVoidProfile: async () => { called = true; return null; } };
  s._levelPlanInProgress = true;
  const result = await s._planAndBuildLevels('cycle_start');
  assert.equal(result, false);
  assert.equal(called, false, 'no market-context fetch when a plan is already in flight');
});

test('_planAndBuildLevels: a call inside the throttle window returns false without re-planning, and succeeds once it elapses', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  s.ladderLines = [];
  s.currentPrice = 101;
  let calls = 0;
  s.volumeProfile = {
    getVoidProfile: async () => {
      calls++;
      return { window: '24h', profile: REAL_PLAN_PROFILE, pair: { bullLevel: 104, bearLevel: 97.8 } };
    },
  };
  s.marketMetrics = {
    getVolatility: async () => ({ atr: 0.9 }),
    getCvd: async () => ({ cvd: -1200 }),
    getOrderbookDepth: async () => ({ bidVolume: 10, askVolume: 12 }),
    getFundingRate: async () => ({ rate: 0.0001 }),
    getOpenInterestChange: async () => ({ oiChange1h: 3.2 }),
  };

  s._levelPlanLastTs = Date.now(); // just planned a moment ago
  const first = await s._planAndBuildLevels('cycle_start');
  assert.equal(first, false, 'still inside the throttle window');
  assert.equal(calls, 0, 'no re-plan attempt while throttled');

  s._levelPlanLastTs = Date.now() - 31_000; // window elapsed
  const second = await s._planAndBuildLevels('cycle_start');
  assert.equal(second, true, 'throttle elapsed -> re-plans');
  assert.equal(calls, 1);
  assert.equal(s.bullLevel, 104);
  assert.equal(s.bearLevel, 97.8);
});

test('_planAndBuildLevels: planLevels yielding no pair returns false and leaves ladderLines empty', async () => {
  const s = reversalStrategy();
  s.ladderLines = [];
  s.currentPrice = 101;
  // No void straddles price, and there is no AI planner (_aiPlanner is null by
  // default) -> the mechanical fallback also comes up empty -> planLevels
  // returns null.
  s.volumeProfile = { getVoidProfile: async () => null };
  s.marketMetrics = {};
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };

  const result = await s._planAndBuildLevels('cycle_start');

  assert.equal(result, false);
  assert.equal(s.ladderLines.length, 0);
  assert.ok(logs.some((m) => m.includes('produced no valid bull/bear pair')));
});

test('_planAndBuildLevels: a throwing context returns false and leaves ladderLines empty', async () => {
  const s = reversalStrategy();
  s.ladderLines = [];
  s.currentPrice = NaN; // buildLevelContext throws outright on a non-finite currentPrice
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };

  const result = await s._planAndBuildLevels('cycle_start');

  assert.equal(result, false);
  assert.equal(s.ladderLines.length, 0);
  assert.ok(logs.some((m) => m.includes('ERROR: level planning') && m.includes('failed')));
});

// Review finding 1: planLevels validates the pair against `this.currentPrice`
// as read BEFORE buildLevelContext's six awaited fetches. If price leaves the
// band during that window, _buildLadders would otherwise build a ladder that
// sits entirely on one side of the (now live) price, and the next tick back
// through the level would open a position in the WRONG direction.
test('_planAndBuildLevels: discards a pair validated against a now-stale price', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  // Real empty-ladder-gate precondition (and what _harvestToFlat clears to
  // before re-planning): no levels set yet.
  s.ladderLines = [];
  s.bullLevel = null;
  s.bearLevel = null;
  s.currentPrice = 101; // the snapshot planLevels will validate bull 104 / bear 97.8 against
  s.volumeProfile = {
    getVoidProfile: async () => {
      // Simulate a fast move landing WHILE the (real, multi-fetch) context
      // build is in flight — exactly the window the finding describes.
      s.currentPrice = 106;
      return { window: '24h', profile: REAL_PLAN_PROFILE, pair: { bullLevel: 104, bearLevel: 97.8 } };
    },
  };
  s.marketMetrics = {
    getVolatility: async () => ({ atr: 0.9 }),
    getCvd: async () => ({ cvd: -1200 }),
    getOrderbookDepth: async () => ({ bidVolume: 10, askVolume: 12 }),
    getFundingRate: async () => ({ rate: 0.0001 }),
    getOpenInterestChange: async () => ({ oiChange1h: 3.2 }),
  };
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };

  const result = await s._planAndBuildLevels('cycle_start');

  assert.equal(result, false, 'a pair validated against a stale price must be discarded, not built');
  assert.equal(s.ladderLines.length, 0, 'nothing may be built from a stale-validated pair');
  assert.equal(s.bullLevel, null);
  assert.equal(s.bearLevel, null);
  assert.ok(
    logs.some((m) => m.includes('discarded') && m.includes('106')),
    'the reason names the live price that moved',
  );
});

test('_legNotional splits the base evenly across 5 levels', () => {
  const s = reversalStrategy({ base: 10000 });
  assert.equal(s._legNotional(), 2000);
});

// FIX round 3's FIX 2: without this, a ladder rebuild mid-run (e.g. a harvest
// re-plan, which calls _planAndBuildLevels() too) can leave the frontend
// showing stale state for up to 30s — the WS-connected UI disables its REST
// poll and relies on the 30s strategy_update safety net.
test('_buildLadders pushes an immediate heartbeat after saving state', async () => {
  const s = reversalStrategy();
  let heartbeatCalls = 0;
  s._pushHeartbeatNow = () => { heartbeatCalls++; };
  await s._buildLadders({ bullLevel: 105, bearLevel: 95 });
  assert.equal(heartbeatCalls, 1, 'a fresh level build must push immediately');
});

// Same WS-poll-disabled rationale: a reversal rebuilds the abandoned side's
// ladder DIRECTLY (not via _buildLadders), so it must push its own heartbeat
// or the panels/chart show the pre-reversal ladder until the next heartbeat /
// 30s safety net.
test('_reverseTo pushes an immediate heartbeat after a committed reversal', async () => {
  const s = reversalStrategy();
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).quantity = 1;
  s.activePosition = { quantity: 1, notional: 1000, entryPrice: 100 };
  s.currentSide = 'LONG';
  s._closeConsolidated = async () => true;
  s._computeAccLoss = () => 0;
  let heartbeatCalls = 0;
  s._pushHeartbeatNow = () => { heartbeatCalls++; };
  const ok = await s._reverseTo('SHORT');
  assert.equal(ok, true, 'sanity: the committed reversal (not abort) path ran');
  assert.equal(heartbeatCalls, 1, 'the reversal must reach the frontend immediately');
});

// _enterTrend flips ladderMode SCALING -> TREND mid-cycle with no leg fill on the
// tick, so nothing else pushes — the mode switch must broadcast itself or the
// Levels & Targets panel waits up to 30s for the safety-net heartbeat.
test('_enterTrend pushes an immediate heartbeat on the SCALING -> TREND switch', async () => {
  const s = reversalStrategy();
  s.ladderLines.filter(l => l.direction === 'LONG').forEach(l => { l.state = 'POSITION_OPEN'; l.quantity = 20; l.fillPrice = l.price; });
  s.currentSide = 'LONG';
  s.desiredProfitUSDT = 100;
  s._refreshCurrentPosition = async () => {
    s._lastPositionRefreshFailed = false;
    s.activePosition = { quantity: 100, entryPrice: 100.4, avgEntry: 100.4, notional: 10040, unrealizedPnl: 0 };
  };
  let heartbeatCalls = 0;
  s._pushHeartbeatNow = () => { heartbeatCalls++; };
  await s._enterTrend('LONG');
  assert.equal(s.ladderMode, 'TREND', 'sanity: the transition ran');
  assert.equal(heartbeatCalls, 1, 'the SCALING -> TREND switch must reach the frontend immediately');
});

test('start() rejects an initial size below the 50 USDT minimum', async () => {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s.addLog = async () => {};
  await assert.rejects(
    () => s.start({ symbol: 'BTCUSDT', initialSize: 49 }),
    /50/,
    'the gate must name the minimum',
  );
});

// ——— Configurable geometry: the VM is the authority on the bounds ———

function geoStrategy() {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
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

// ——— Tick dispatch (beyond Step 1's §14 coverage) ——————————————————————

test('SCALING: a gap fills every level it jumped', async () => {
  const s = reversalStrategy();   // bull 102 / bear 98
  const orders = [];
  s._fillLeg = async (leg) => { orders.push(leg); leg.state = 'POSITION_OPEN'; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(102.7); // past L3=102.612, before L4=102.918
  assert.equal(orders.length, 3);
});

test('TREND is passive: retreating inside the dead zone does nothing', async () => {
  const s = reversalStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.finalTpPrice = 105;
  // Fully scaled — the realistic TREND precondition, and it means every LONG
  // rung is already POSITION_OPEN, so retreating back through them cannot be
  // mistaken for a fresh (re-)fill.
  s.ladderLines.filter(l => l.direction === 'LONG').forEach(l => { l.state = 'POSITION_OPEN'; l.quantity = 1; });
  let acted = false;
  s._fillLeg = async () => { acted = true; };
  s._reverseTo = async () => { acted = true; };
  s.lastProcessedPrice = 103;
  await s.handleRealtimePrice(100); // back inside the dead zone, not past bear
  assert.equal(acted, false);
  assert.equal(s.ladderMode, 'TREND', 'mode holds until the opposite level or Final TP');
});

test('TREND: reaching the opposite level triggers a reversal and returns to SCALING', async () => {
  const s = reversalStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.ladderLines.filter(l => l.direction === 'LONG').forEach(l => { l.state = 'POSITION_OPEN'; l.quantity = 1; });
  s.activePosition = { quantity: 5, entryPrice: 103, notional: 515, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s._closeConsolidated = async () => true;
  s._computeAccLoss = () => 0;
  s._fillLeg = async (leg) => { leg.state = 'POSITION_OPEN'; leg.quantity = 1; leg.fillPrice = leg.price; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(98); // crosses bear -> reverses
  assert.equal(s.heldSide, 'SHORT');
  assert.equal(s.ladderMode, 'SCALING');
  assert.equal(s.reversalCount, 1);
});

test('SCALING never checks Final TP', async () => {
  const s = reversalStrategy();
  s.finalTpPrice = 100.2; // would fire if SCALING checked it
  let stopped = false;
  s.stop = async () => { stopped = true; };
  s._fillLeg = async (leg) => { leg.state = 'POSITION_OPEN'; };
  s.lastProcessedPrice = 100;
  await s.handleRealtimePrice(102);
  assert.equal(stopped, false, 'Final TP is a TREND-only exit');
});

test('TREND: Final TP hit stops the cycle', async () => {
  const s = reversalStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.finalTpPrice = 105;
  let reason = null;
  s.stop = async (opts) => { reason = opts.reason; };
  s.lastProcessedPrice = 104.9;
  await s.handleRealtimePrice(105.05);
  assert.equal(reason, 'final_tp');
});

// ——— Task 13: reversalCount ——————————————————————————————————————————————

// A strategy holding a LONG position (L1 filled), ready to reverse.
function reverseReady() {
  const s = reversalStrategy();
  s.activePosition = { quantity: 1, notional: 1000, entryPrice: 100 };
  s.currentSide = 'LONG';
  s.ladderLines[0].state = 'POSITION_OPEN';
  s.ladderLines[0].quantity = 1;
  s._closeConsolidated = async () => true;
  s._computeLadderBaseSize = async () => s._ladderBaseSize;
  s._computeAccLoss = () => 0;
  return s;
}

test('_reverseTo increments reversalCount on every committed reversal', async () => {
  const s = reverseReady();
  assert.equal(s.reversalCount, 0, 'a fresh cycle starts at zero');

  await s._reverseTo('SHORT');
  assert.equal(s.reversalCount, 1);

  // Re-arm and reverse again — the count accumulates across a cycle.
  s.activePosition = { quantity: 1, notional: 1000, entryPrice: 98 };
  s.currentSide = 'SHORT';
  s.ladderLines.find(l => l.direction === 'SHORT').state = 'POSITION_OPEN';
  await s._reverseTo('LONG');
  assert.equal(s.reversalCount, 2);
});

test('_hasNoTradingActivity: a reversal alone marks the cycle as having traded', () => {
  const s = reversalStrategy();
  assert.equal(s._hasNoTradingActivity(), true, 'an untouched cycle is no-trade');
  s.reversalCount = 1;
  assert.equal(s._hasNoTradingActivity(), false, 'a reversal is trading activity');
});

// ——— _closeConsolidated: currentSide state-drift guard ——————————————————

test('_closeConsolidated: currentSide missing is repopulated by a refresh from Binance before closing', async () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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

// ——— _flattenGrid: an unverified close must abort the leg-ledger rebuild ———
//
// The `_reverseTo` equivalent is covered by Step 1's §14 tombstone tests
// above. `_flattenGrid` is still used by `stop({flatten:true})`, so its own
// tombstone guard needs its own pin.

test('_flattenGrid: an unverified close keeps the leg ledger intact and returns false', async () => {
  const s = reversalStrategy();
  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1);
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
  // reallocated (as `buildReversalLadder` does) a stale reference would keep
  // reading POSITION_OPEN even after a wipe underneath it. Same discipline as
  // the `_reverseTo` tombstone tests above.
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
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // reversalStrategy() stubs this for the tick-dispatch tests; use the REAL method
  s.currentInitialSize = 10000;
  s.cycleAccumulatedLoss = 0;
  s.recoveryFactor = 0.20;
  s.recoveryDistance = 0.005;
  s.getTotalMarginBalance = async () => 1e9; // margin cap out of the way
  assert.equal(await s._computeLadderBaseSize(), 10000, 'no loss => no growth, never below initial');
});

test('_computeLadderBaseSize: a 50 USDT loss grows a 10k base to 12k', async () => {
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // use the REAL method
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
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // use the REAL method
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
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // use the REAL method
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
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // use the REAL method
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
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // use the REAL method
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
  const s = reversalStrategy({ base: 10000 });
  delete s._computeLadderBaseSize; // use the REAL method
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
  const s = reversalStrategy({ base: 10000 });
  s.currentInitialSize = 10000;
  s.addLog = async () => {};
  assert.equal(s._applyMarginHeadroomCap(12000, NaN), 10000, 'NaN wallet must fail closed');
  assert.equal(s._applyMarginHeadroomCap(12000, undefined), 10000, 'undefined wallet must fail closed');
  assert.equal(s._applyMarginHeadroomCap(12000, 0), 10000, 'zero wallet must fail closed too (previously fell through to uncapped)');
});

test('_recomputeFinalTpPrice: no AI cost term', () => {
  const s = reversalStrategy({ mode: 'TREND' });
  s.activePosition = { quantity: 100, avgEntry: 100.9, entryPrice: 100.9, notional: 10090 };
  s.currentSide = 'LONG';
  s.cycleAccumulatedLoss = 89;
  s.desiredProfitUSDT = 100;
  s._recomputeFinalTpPrice();
  // needed = 89 + 100 + 10090*0.0008 = 197.072 ; tp = 100.9 + 197.072/100
  assert.ok(Math.abs(s.finalTpPrice - 102.87072) < 1e-6, `got ${s.finalTpPrice}`);
});

test('_recomputeFinalTpPrice: null with no position', () => {
  const s = reversalStrategy();
  s.activePosition = null;
  s._recomputeFinalTpPrice();
  assert.equal(s.finalTpPrice, null);
});

test('_closeQuantity rounds the summed leg qty to stepSize (guards Binance -1111)', () => {
  // stepSize 0.01 → quantityPrecision 2, so 0.28×3 = 0.8400000000000001 must
  // come back as 0.84, not the raw float (which Binance rejects on close).
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
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
  const s = reversalStrategy();
  let sentQty = null;
  s.makeProxyRequest = async (_path, _method, params) => { sentQty = params.quantity; return { orderId: 1, status: 'FILLED' }; };
  await s.placeMarketOrder('BTCUSDT', 'SELL', 0.8400000000000001, undefined, { reduceOnly: true });
  assert.equal(sentQty, 0.84, 'the order layer must floor the FP artifact even if the caller does not');
});

test('harvestNow queues when a position is open and the gauge is NOT full (gauge no longer gates)', async () => {
  const s = reversalStrategy();                        // initialCapital 1000, 8% threshold => full at 80
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.cycleAccumulatedLoss = 40;                        // well below the 80 gate → gauge NOT full
  assert.equal(s._isGaugeFull(), false, 'precondition: the gauge is genuinely not full');
  const res = await s.harvestNow();
  assert.equal(res.queued, true, 'queues regardless of gauge fullness — the gauge no longer gates the action');
  assert.equal(s._manualHarvestRequested, true, 'latch set whenever a position is open');
});

test('harvestNow queues when a position is open AND the gauge is full', async () => {
  const s = reversalStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.cycleAccumulatedLoss = 100;                       // >= 80 => gauge full
  const res = await s.harvestNow();
  assert.equal(res.queued, true);
  assert.equal(s._manualHarvestRequested, true, 'latch set once eligible');
});

test('harvest clears the levels and re-plans, unlike a reversal', async () => {
  const s = reversalStrategy();
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 10, avgEntry: 100.3, entryPrice: 100.3, notional: 1003 };
  s.currentSide = 'LONG';
  s.currentPrice = 103;
  s._closeConsolidated = async () => { s.activePosition = null; return true; };
  s._computeAccLoss = () => 0;
  s.getTotalMarginBalance = async () => 1e9;
  let bullAtPlanTime = 'unset';
  s._planAndBuildLevels = async () => { bullAtPlanTime = s.bullLevel; return true; };
  await s._harvestToFlat('manual_harvest');
  assert.equal(
    bullAtPlanTime, null,
    'the pair is cleared BEFORE the re-plan runs — unlike a reversal, which keeps the un-abandoned side standing',
  );
  assert.equal(s.ladderMode, 'SCALING');
});

// Review finding 2: _buildLadders is the only OTHER writer of ladderMode /
// trendDirection, and it never runs when the re-plan fails — so a harvest out
// of TREND whose re-plan fails (e.g. a 503) would otherwise persist
// ladderMode:'TREND' over an empty ladder and a flat account. On a VM restart
// resume()'s _reconcileTrendInvariant reads that as the invariant needing a
// self-heal and burns a REST refresh plus a false alarm before the next tick
// clears it.
test('_harvestToFlat clears TREND state even when the re-plan itself fails', async () => {
  const s = reversalStrategy({ mode: 'TREND' });
  s.trendDirection = 'LONG';
  s.finalTpPrice = 103;
  s.activePosition = null; // flat: nothing to close, only the re-plan is under test
  s._planAndBuildLevels = async () => false; // the re-plan fails
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.ladderMode, 'SCALING', 'must not persist TREND over an empty, flat ladder');
  assert.equal(s.trendDirection, null);
});

// ——— _harvestToFlat: a failed close must abort the rebuild, not orphan the position ———
//
// The re-plan resets every leg to EMPTY, and POSITION_OPEN is the ONLY
// record of what this bot has open (_closeQuantity sizes every close off it).
// Rebuilding after a failed close would leave a real position open on Binance
// while the bot's own books read "flat, fresh ladder" — nothing would ever try
// to close it again. These three tests pin: (1) a close that THROWS with
// inventory open aborts and leaves the ladder intact, (2) a close that
// SUCCEEDS still re-plans and rebuilds exactly as before, (3) genuinely
// nothing-to-close still re-plans — the abort must not fire on a real no-op.

test('_harvestToFlat: close throws with inventory open -> aborts, ladder left intact, position still tracked', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  const longLegs = s.ladderLines.filter(l => l.direction === 'LONG').slice(0, 2);
  longLegs.forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.currentPrice = 110;
  s.placeMarketOrder = async () => { throw new Error('-1001 Internal error'); };
  let planCalled = false;
  s._planAndBuildLevels = async () => { planCalled = true; return true; };

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 0, 'harvestCount must not increment on an aborted close');
  assert.equal(planCalled, false, 'no re-plan on a failed close — the levels must stay put');
  assert.equal(s.bullLevel, 102, 'bullLevel must stay put — no re-plan on a failed close');

  // Read off the LIVE array, not the captured `longLegs` references: a re-plan
  // allocates NEW leg objects and replaces `this.ladderLines` wholesale, so the
  // captured objects would stay POSITION_OPEN even if the ladder WAS rebuilt
  // underneath them — asserting on `longLegs` proves nothing.
  assert.equal(s.ladderLines.filter((l) => l.state === 'POSITION_OPEN').length, 2,
    'the open-leg ledger must survive — it is the only record of the live position');
  assert.equal(s._tradingSeqInProgress, false, 'the seq lock must still release on the abort path');
});

test('_harvestToFlat: close succeeds -> harvestCount increments and re-plans the levels (unchanged behavior)', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  const longLegs = s.ladderLines.filter(l => l.direction === 'LONG').slice(0, 2);
  longLegs.forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s.currentPrice = 110;
  s.placeMarketOrder = async () => ({ orderId: 1, status: 'FILLED' });
  // The close succeeds (WS confirms the fill) — tier 1 of _closeConsolidated's
  // verification. Was `async () => {}` (falsy/unverified), which under the
  // tightened contract now reads as an UNVERIFIED close; express the intended
  // success explicitly instead.
  s._waitForOrderFillConfirmation = async () => true;
  s.getTotalMarginBalance = async () => 1e9;
  let planCalled = false;
  s._planAndBuildLevels = async () => { planCalled = true; return true; };

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 1, 'harvestCount increments on a genuine close');
  assert.equal(planCalled, true, 're-plans the levels on a verified close');
  assert.ok(s.ladderLines.every((l) => l.state !== 'POSITION_OPEN'), 'ladder cleared — no leg left open');
});

test('_harvestToFlat: genuinely flat -> still re-plans — the abort must not fire when nothing was open', async () => {
  const s = reversalStrategy();
  s.activePosition = null;
  s.currentPrice = 105;
  s.getTotalMarginBalance = async () => 1e9;
  let planCalled = false;
  s._planAndBuildLevels = async () => { planCalled = true; return true; };

  await s._harvestToFlat('manual_harvest');

  // A no-op close must not be mistaken for a failed one (the re-plan still
  // runs), but per the accounting split it is a RE-ANCHOR, not a HARVEST —
  // see the dedicated "accounting split" tests below for the counters.
  assert.equal(s.harvestCount, 0, 'a flat re-plan must not be counted as a harvest');
  assert.equal(s.reanchorCount, 1, 'a flat re-plan still bumps reanchorCount');
  assert.equal(planCalled, true, 're-plans normally when there was nothing to close');
});

test('_harvestToFlat: close returns false WITHOUT throwing (side unresolved) -> aborts, ladder left intact', async () => {
  const s = reversalStrategy();
  // No legs are marked open, so _closeConsolidated's leg-direction fallback
  // finds nothing; combined with currentSide null, the initial side lookup
  // fails outright. Only `activePosition` carries the (drifted) inventory —
  // exactly the "no legs behind it, no side in memory" case the code calls out.
  s.currentSide = null;
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s.currentPrice = 110;
  // `_refreshCurrentPosition` is stubbed to a no-op by the `reversalStrategy()`
  // fixture — it leaves `currentSide` null while the inventory (activePosition)
  // remains, so `_closeConsolidated`'s post-refresh side check ALSO fails and
  // it logs the "side could not be resolved" warning and returns `false`
  // WITHOUT throwing (as opposed to the earlier throw-based abort test above).
  let planCalled = false;
  s._planAndBuildLevels = async () => { planCalled = true; return true; };

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 0, 'harvestCount must not increment on an aborted close');
  assert.equal(planCalled, false, 'no re-plan on an unresolved-side abort');
  assert.ok(s.activePosition && s.activePosition.quantity > 0, 'the position must still be tracked, not silently dropped');
  assert.equal(s._tradingSeqInProgress, false, 'the seq lock must still release on the abort path');
});

test('_harvestToFlat: _closeConsolidated refreshes mid-close and proves genuinely flat -> does NOT abort, re-plans', async () => {
  const s = reversalStrategy();
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
  let planCalled = false;
  s._planAndBuildLevels = async () => { planCalled = true; return true; };

  await s._harvestToFlat('manual_harvest');

  assert.equal(s.harvestCount, 0, 'the refresh proved flat — nothing was actually closed, so it is a RE-ANCHOR, not a harvest');
  assert.equal(s.reanchorCount, 1, 'but it still counts as a re-anchor');
  assert.equal(planCalled, true, 're-plans on the live price — the abort must not fire on a stale pre-close reading');
});

// ——— _harvestToFlat completion signal ———

test('_harvestToFlat returns false when a trading sequence is already in flight', async () => {
  const s = reversalStrategy();
  s._tradingSeqInProgress = true;
  assert.equal(await s._harvestToFlat('manual_harvest'), false);
});

test('_harvestToFlat returns false when the close is unverified and inventory remains', async () => {
  const s = reversalStrategy();
  s.ladderLines.filter((l) => l.direction === 'LONG').slice(0, 2)
    .forEach((l) => { l.state = 'POSITION_OPEN'; l.quantity = 0.5; });
  // _closeQuantity() reads restQty off activePosition first (see its own
  // "REST reachable and reported flat" short-circuit) — without this, a null
  // activePosition reads as "genuinely flat" regardless of the leg ledger, so
  // the tombstone's `_closeQuantity() > 0` check would never fire. Same
  // "inventory open" precondition the sibling tombstone test above uses.
  s.activePosition = { quantity: 1, avgEntry: 100.3, entryPrice: 100.3, notional: 100.3, unrealizedPnl: 0 };
  s._closeConsolidated = async () => false;        // unverified close
  let rebuilt = false;
  s._planAndBuildLevels = async () => { rebuilt = true; return true; };
  assert.equal(await s._harvestToFlat('manual_harvest'), false);
  assert.equal(rebuilt, false, 'the tombstone must still abort the rebuild');
});

test('_harvestToFlat returns true after a completed re-plan', async () => {
  const s = reversalStrategy();
  s._closeConsolidated = async () => true;
  s._computeAccLoss = () => 0;
  s._computeLadderBaseSize = async () => 1000;
  s._planAndBuildLevels = async () => true;
  assert.equal(await s._harvestToFlat('manual_harvest'), true);
});

test('the harvest header always shows the bare reason label', async () => {
  const s = reversalStrategy();
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };
  s._closeConsolidated = async () => true;
  s._computeAccLoss = () => 0;
  s._computeLadderBaseSize = async () => 1000;
  s._planAndBuildLevels = async () => true;

  await s._harvestToFlat('manual_harvest');
  const header = logs.find((m) => /flatten \+ re-plan levels/.test(m));
  assert.match(header, /\(manual_harvest\)/, `got: ${header}`);
});

test('_harvestToFlat returns true for a flat re-plan (nothing to close)', async () => {
  const s = reversalStrategy();                       // no legs open, activePosition null
  s._closeConsolidated = async () => false;         // nothing closed because nothing was open
  s._computeAccLoss = () => 0;
  s._computeLadderBaseSize = async () => 1000;
  s._planAndBuildLevels = async () => true;
  assert.equal(await s._harvestToFlat('price_trigger'), true, 'a flat re-plan completes; it never aborts');
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
  const src = reversalStrategy({ base: 12000 });
  src.ladderMode = 'TREND';
  src.trendDirection = 'LONG';
  src.ladderLines.filter(l => l.direction === 'LONG').forEach((l, i) => {
    Object.assign(l, { state: 'POSITION_OPEN', quantity: 10 + i, fillPrice: 100.3 + i * 0.3 });
  });
  src.lastProcessedPrice = 101.5;
  src.cycleAccumulatedLoss = 89;

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  // reversalStrategy() stubs saveState for the OTHER tests in this file (so a
  // trading-sequence test doesn't need a firestore double); this test is
  // specifically about persistence, so it calls the real prototype method.
  await ReversalLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  assert.equal(dst.bullLevel, 102);
  assert.equal(dst.bearLevel, 98);
  assert.equal(dst.ladderMode, 'TREND');
  assert.equal(dst.trendDirection, 'LONG');
  assert.equal(dst.ladderLines.length, 10);
  assert.equal(dst.ladderLines.filter(l => l.state === 'POSITION_OPEN').length, 5);
  assert.equal(dst.lastProcessedPrice, 101.5);
  assert.equal(dst._ladderBaseSize, 12000);
});

test('reversalCount survives a save/restore round-trip', async () => {
  const src = reversalStrategy();
  src.reversalCount = 7;
  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(src);
  assert.equal(doc.reversalCount, 7, 'saveState must persist it');

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  // Without this the count silently resets to 0 on every VM restart, and
  // _hasNoTradingActivity would then delete a real cycle's doc as "no-trade".
  assert.equal(dst.reversalCount, 7, 'resume must restore it');
});

test('getStatus reports the ladder shape the frontend needs', () => {
  const s = reversalStrategy();
  s.ladderMode = 'SCALING';
  const st = s.getStatus();
  assert.equal(st.mode, 'SCALING', 'the frontend reads status.mode, not status.ladderMode');
  assert.equal(st.bullLevel, 102);
  assert.equal(st.bearLevel, 98);
  assert.equal(st.ladderLines.length, 10);
  assert.equal(st.levelsPerSide, 5);
  assert.equal(st.stepPct, 0.003);
});

test('getHeartbeatPayload reports the same ladder shape as getStatus', () => {
  const s = reversalStrategy();
  s.ladderMode = 'TREND';
  s.trendDirection = 'SHORT';
  const hb = s.getHeartbeatPayload();
  assert.equal(hb.mode, 'TREND', 'the frontend reads status.mode, not status.ladderMode');
  assert.equal(hb.bullLevel, 102);
  assert.equal(hb.bearLevel, 98);
  assert.equal(hb.trendDirection, 'SHORT');
  assert.equal(hb.ladderLines.length, 10);
  assert.equal(hb.strategyType, 'reversalLadder');
});

test('getStatus and the heartbeat both emit reversalCount for the Reversals tile', () => {
  // The frontend types itself off this payload: a field the backend never
  // emits is a silent `undefined` at runtime with no type error.
  const s = reversalStrategy();
  s.reversalCount = 3;
  assert.equal(s.getStatus().reversalCount, 3);
  assert.equal(s.getHeartbeatPayload().reversalCount, 3);
});

test('saveState writes the REVERSAL_LADDER type tags for boot recovery', async () => {
  const s = reversalStrategy();
  let written = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { written = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(s);
  assert.equal(written.type, 'REVERSAL_LADDER');
  assert.equal(written.strategyType, 'reversalLadder');
});

test('_lastLadderSize survives a save/resume round trip', async () => {
  const src = reversalStrategy({ base: 12000 });
  src._lastLadderSize = 15000;

  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);

  assert.equal(dst._lastLadderSize, 15000, 'the martingale escalation freeze must survive a restart');
});

test('_recomputeFinalTpPrice keys off trendDirection, not just currentSide (resume race)', () => {
  const s = reversalStrategy({ mode: 'TREND' });
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
  const s = stubStopTail(reversalStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
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
  const s = stubStopTail(reversalStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
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
  const s = stubStopTail(reversalStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
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
  const s = stubStopTail(reversalStrategy());
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
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

// ——— FIX 2: the SCALING→TREND invariant is derived, not chased —————————————

test('Fix 2: resume() self-heals a snapshot stuck in SCALING fully-scaled — arms TREND + Final TP', async () => {
  const src = reversalStrategy({ base: 12000 });
  src.ladderMode = 'SCALING'; // the bug: process died between _fillLeg(L5) persisting and _enterTrend running
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
  await ReversalLadderStrategy.prototype.saveState.call(src);

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
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
  const s = reversalStrategy();
  s.activePosition = { quantity: 40, entryPrice: 100.9, avgEntry: 100.9, notional: 4036 };
  s.currentSide = 'LONG';
  s.cycleAccumulatedLoss = 0;
  s.desiredProfitUSDT = 50;
  s.placeMarketOrder = async () => ({}); // no orderId -> _resolveFill falls back to requested qty/level price
  s._quantityFor = async (symbol, notional, price) => notional / price; // skip the real exchange-info/network sizing call
  s.lastProcessedPrice = 100;

  await s.handleRealtimePrice(103.5); // past L5 = 102 * 1.012 = 103.224

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
  const s = reversalStrategy();
  const st = s.getStatus();
  assert.equal('maxPositionSizeUSDT' in st, false, 'the dead knob must not resurface in the status payload');
});

test('Fix 1: saveState() no longer persists maxPositionSizeUSDT', async () => {
  const s = reversalStrategy();
  let written = null;
  s.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { written = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(s);
  assert.equal('maxPositionSizeUSDT' in written, false, 'the dead knob must not resurface in the persisted snapshot');
});

// ——— FIX 2: getCurrentPositions() throws instead of swallowing to [] —————
// (proven-by-probe bug: a transient API error was indistinguishable from a
// genuinely flat account, so detectCurrentPosition() wiped real position
// state on a 5xx.)

test('Fix 2: getCurrentPositions() throws when the API call fails, instead of swallowing to []', async () => {
  const s = reversalStrategy();
  s.makeProxyRequest = async () => { throw new Error('-1001 Internal error'); };
  await assert.rejects(() => s.getCurrentPositions(), /-1001/);
});

test('Fix 2: a position refresh failure does NOT wipe activePosition / currentPosition — stale beats falsely flat', async () => {
  const s = reversalStrategy();
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
  const s = stubStopTail(reversalStrategy());
  delete s._refreshCurrentPosition; // use the REAL implementation

  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1);
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
  const s = stubStopTail(reversalStrategy());
  const openLeg = s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1);
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy({ mode: 'TREND' });
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
  const s = reversalStrategy({ mode: 'TREND' });
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
// Reachable via a process death inside `_reverseTo` between
// `_closeConsolidated()` and `saveState()` — a window containing a real
// 100-500ms `getTotalMarginBalance()` round trip — which persists
// TREND + every leg POSITION_OPEN while Binance is already flat.

// The persisted contradiction that window leaves behind.
function trendButFlatOnBinance() {
  const s = reversalStrategy({ mode: 'TREND' });
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
  const s = reversalStrategy({ mode: 'TREND' });
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
  const s = reversalStrategy({ mode: 'TREND' });
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
  const s = reversalStrategy({ mode: 'TREND' });
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
// chain executes. They deliberately do NOT use reversalStrategy(), whose
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
    strategyId: 'reversal_ladder_boot_test',
    profileId: 'test-profile',
    userId: 'test-user',
    gcfProxyUrl: 'http://proxy.invalid',
    sharedVmProxyGcfUrl: 'http://vm.invalid',
    symbol: 'BTCUSDT',
    leverage: 10,
    ladderMode: 'SCALING',
    bullLevel: 102,
    bearLevel: 98,
    ladderLines: buildReversalLadder(102, 98, LADDER_STEP_PCT, LADDER_LEVELS_PER_SIDE).map((l) =>
      (l.direction === 'LONG' && l.index === 1)
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
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
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
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
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

// start() ends with an UNCONDITIONAL this._pushHeartbeatNow?.() after
// saveState(). Without it, the freshly-started strategy would only reach the
// WS-connected frontend (which disables its 3s REST poll) via the 30s
// strategy_update safety net — up to 30s where the UI cannot even confirm the
// strategy actually started. Was previously covered only incidentally by a
// Start-Mode arming test (deleted with Start Mode); this pins the same
// invariant directly against start()'s own ordinary path.
test('start() pushes an immediate heartbeat after saving state', async () => {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  stubBootInternals(s);
  s.getWalletBalance = async () => 1000;
  let heartbeatCalls = 0;
  s._pushHeartbeatNow = () => { heartbeatCalls++; };
  try {
    await s.start({ symbol: 'BTCUSDT', initialSize: 1000, leverage: 10 });
    assert.equal(heartbeatCalls, 1, 'start() must reach the frontend immediately, not wait on the 30s safety net');
  } finally {
    clearInterval(s.listenKeyRefreshInterval);
  }
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
// genuinely fails: `reversalStrategy()`'s no-op `_refreshCurrentPosition` stub
// is exactly why this class of bug was invisible to a green suite.
function stopFixtureWithFailingRefresh() {
  const s = reversalStrategy({ base: 1000 });
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
  const s = reversalStrategy({ base: 1000 });
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
  const s = reversalStrategy();
  s.stepPct = 0.005;
  s.levelsPerSide = 8;
  let saved = null;
  // saveState writes via this.firestore.collection('strategies').doc(id).set(doc, {merge:true})
  s.firestore = { collection: () => ({ doc: () => ({ set: async (doc) => { saved = doc; } }) }) };
  s.addLog = async () => {};
  // reversalStrategy() stubs saveState for the OTHER tests in this file (so a
  // trading-sequence test doesn't need a firestore double); this test is
  // specifically about persistence, so it calls the real prototype method
  // (same pattern as the existing save/restore round-trip tests above).
  await ReversalLadderStrategy.prototype.saveState.call(s);
  assert.ok(saved, 'saveState wrote a doc');
  assert.equal(saved.stepPct, 0.005, 'stepPct must round-trip');
  assert.equal(saved.levelsPerSide, 8, 'levelsPerSide must round-trip');
});

test('resume restores non-default geometry from the snapshot', () => {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s._applySnapshotGeometry({ stepPct: 0.005, levelsPerSide: 8 });
  assert.equal(s.stepPct, 0.005, 'a cycle started at 0.5% must resume at 0.5%');
  assert.equal(s.levelsPerSide, 8, 'a cycle started at 8 levels must resume at 8');
});

test('resume falls back to the defaults for a legacy snapshot without geometry', () => {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  s._applySnapshotGeometry({});
  assert.equal(s.stepPct, LADDER_STEP_PCT, 'pre-change docs default to 0.3%');
  assert.equal(s.levelsPerSide, LADDER_LEVELS_PER_SIDE, 'pre-change docs default to 5');
});

test('resume THROWS on a present-but-invalid geometry instead of silently defaulting (out-of-bounds step)', () => {
  // A corrupted/out-of-bounds snapshot value is NOT the same as an absent one.
  // Silently coercing it to the default would read "unknown" as "safe" and
  // rebuild a ladder that does not match whatever is actually on the exchange
  // for this cycle — exactly the silent-fail-open shape this codebase forbids.
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  assert.throws(
    () => s._applySnapshotGeometry({ stepPct: LADDER_STEP_PCT_MAX + 1, levelsPerSide: 5 }),
    /step/i,
  );
});

test('resume THROWS on a present-but-invalid geometry instead of silently defaulting (out-of-bounds levels)', () => {
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  assert.throws(
    () => s._applySnapshotGeometry({ stepPct: LADDER_STEP_PCT, levelsPerSide: LADDER_LEVELS_MAX + 1 }),
    /level/i,
  );
});

test('resume THROWS on a non-numeric (e.g. stringified) geometry value rather than coercing it', () => {
  // resolveLadderGeometry is strict, not coercing (a numeric string is not a
  // number); _applySnapshotGeometry must inherit that, not re-introduce
  // Number(...) coercion via its own ad hoc checks.
  const s = new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid');
  assert.throws(() => s._applySnapshotGeometry({ stepPct: '0.005', levelsPerSide: 8 }));
});

// ——— Trigger price: arm / cancel / validate ———

test('harvestNow(triggerPrice) arms an ABOVE trigger and rounds to tick size', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();                       // currentPrice 100
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  const res = await s.harvestNow(101.239);          // ~1.2% above → rounds to 101.24
  assert.equal(res.armed, true);
  assert.equal(s.harvestTriggerPrice, 101.24);
  assert.equal(s.harvestTriggerAbove, true);
  assert.equal(s._manualHarvestRequested, false, 'arming must NOT set the immediate latch');
});

test('harvestNow(triggerPrice) rejects arming with no live price yet', async () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  await s.harvestNow(98.5);
  assert.equal(s.harvestTriggerPrice, 98.5);
  assert.equal(s.harvestTriggerAbove, false);
});

test('harvestNow(triggerPrice) rejects a level within the 0.1% gap', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();                       // currentPrice 100 → band 99.9..100.1
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  await assert.rejects(() => s.harvestNow(100.05), (err) => {
    assert.match(err.message, /0\.1%|current price/i);
    assert.equal(err.invalidInput, true, 'client-input validation errors must be tagged invalidInput (route maps to 400)');
    return true;
  });
  assert.equal(s.harvestTriggerPrice, null, 'a rejected arm leaves no trigger set');
});

test('harvestNow(triggerPrice) rejects a non-positive price', async () => {
  const s = reversalStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  await assert.rejects(() => s.harvestNow(0), (err) => {
    assert.match(err.message, /positive/i);
    assert.equal(err.invalidInput, true, 'client-input validation errors must be tagged invalidInput (route maps to 400)');
    return true;
  });
});

test('harvestNow() with no price latches immediately AND clears any armed trigger', async () => {
  const s = reversalStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003 };
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;   // pre-armed
  const res = await s.harvestNow();
  assert.equal(res.queued, true);
  assert.equal(s._manualHarvestRequested, true);
  assert.equal(s.harvestTriggerPrice, null, 'immediate harvest supersedes a pending trigger');
});

test('cancelHarvestTrigger clears an armed trigger', async () => {
  const s = reversalStrategy();
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;
  const res = await s.cancelHarvestTrigger();
  assert.equal(res.cancelled, true);
  assert.equal(s.harvestTriggerPrice, null);
  assert.equal(s.harvestTriggerAbove, null);
});

// ——— Trigger price: tick-loop firing ———

test('an armed ABOVE trigger fires _harvestToFlat when price reaches the level', async () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();
  s.activePosition = { quantity: 10, entryPrice: 100.3, avgEntry: 100.3, notional: 1003, unrealizedPnl: 5 };
  s.harvestTriggerPrice = 101; s.harvestTriggerAbove = true;
  let fired = false;
  s._harvestToFlat = async () => { fired = true; };
  await s.handleRealtimePrice(100.5);
  assert.equal(fired, false);
  assert.equal(s.harvestTriggerPrice, 101, 'still armed');
});

test('an armed BELOW trigger fires when price gaps through the level', async () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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

test('an armed trigger NOT yet reached survives a real reversal', async () => {
  // Precondition: the tick must genuinely reverse (not merely "make one up") —
  // stub _reverseTo and assert it fired. Otherwise a tick that never reverses
  // would pass this test while proving nothing.
  const s = reversalStrategy();               // bull 102 / bear 98
  let reversed = false;
  s._reverseTo = async () => { reversed = true; return true; };
  s._fillLeg = async (leg) => { leg.state = 'POSITION_OPEN'; };
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
  s.lastProcessedPrice = 103;
  s.harvestTriggerPrice = 105; s.harvestTriggerAbove = true;   // armed, nowhere near this tick
  await s.handleRealtimePrice(98);                             // crosses bear -> reverses
  assert.equal(reversed, true, 'precondition: the reversal actually ran');
  assert.equal(s.harvestTriggerPrice, 105, 'the trigger must survive a reversal untouched');
  assert.equal(s.harvestTriggerAbove, true);
});

test('the trigger fires BEFORE the reversal dispatch on the same tick', async () => {
  const s = reversalStrategy();                // bull 102 / bear 98
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 10, entryPrice: 102, avgEntry: 102, notional: 1020, unrealizedPnl: -2 };
  s.currentSide = 'LONG';
  s.lastProcessedPrice = 100;
  s.harvestTriggerPrice = 98; s.harvestTriggerAbove = false;  // trigger AT bear
  let harvested = false, reversed = false;
  s._harvestToFlat = async () => { harvested = true; };
  s._reverseTo = async () => { reversed = true; return true; };
  await s.handleRealtimePrice(98);          // crosses bear AND hits trigger
  assert.equal(harvested, true, 'trigger wins');
  assert.equal(reversed, false, 'reversal dispatch did not run this tick');
});

// ——— Trigger price: persistence + status ———

test('getStatus surfaces the armed trigger', () => {
  const s = reversalStrategy();
  s.harvestTriggerPrice = 105.5; s.harvestTriggerAbove = true;
  const st = s.getStatus();
  assert.equal(st.harvestTriggerPrice, 105.5);
  assert.equal(st.harvestTriggerAbove, true);
});

test('getHeartbeatPayload surfaces the armed trigger', () => {
  const s = reversalStrategy();
  s.harvestTriggerPrice = 98; s.harvestTriggerAbove = false;
  const hb = s.getHeartbeatPayload();
  assert.equal(hb.harvestTriggerPrice, 98);
  assert.equal(hb.harvestTriggerAbove, false);
});

test('saveState persists the armed trigger fields', async () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();                 // flat: activePosition null, no open legs
  s.currentPrice = 110;
  s.harvestCount = 3;
  let planCalled = false;
  s._planAndBuildLevels = async () => { planCalled = true; return true; };
  await s._harvestToFlat('manual_harvest');
  assert.equal(s.harvestCount, 3, 'a flat re-plan must NOT count as a harvest');
  assert.equal(s.reanchorCount, 1, 'reanchorCount bumps on every re-plan');
  assert.equal(planCalled, true, 're-plans on the live price');
});

test('_harvestToFlat while HOLDING bumps BOTH harvestCount and reanchorCount', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
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
  const s = reversalStrategy();                 // flat
  const res = await s.harvestNow();
  assert.equal(res.queued, true);
  assert.equal(s._manualHarvestRequested, true);
});

test('harvestNow(triggerPrice) arms a trigger while flat', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();                 // flat, currentPrice 100
  const res = await s.harvestNow(101.2);
  assert.equal(res.armed, true);
  assert.equal(s.harvestTriggerPrice, 101.2);
});

test('a trigger that fires while FLAT re-anchors (no longer disarms quietly)', async () => {
  const s = reversalStrategy();                 // flat
  s.harvestTriggerPrice = 101; s.harvestTriggerAbove = true;
  let fired = null;
  s._harvestToFlat = async (reason) => { fired = reason; };
  await s.handleRealtimePrice(101);
  assert.equal(fired, 'price_trigger', 'flat-at-fire now re-anchors instead of disarming');
  assert.equal(s.harvestTriggerPrice, null, 'one-shot cleared');
});

// ——— Flat re-anchor: persistence + status ———

test('getStatus and getHeartbeatPayload surface reanchorCount', () => {
  const s = reversalStrategy();
  s.reanchorCount = 7;
  assert.equal(s.getStatus().reanchorCount, 7);
  assert.equal(s.getHeartbeatPayload().reanchorCount, 7);
});

test('saveState persists reanchorCount', async () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();
  assert.equal(s._isReduceOnlyRejected(new Error('Proxy Error: 500 - Binance API Error: -2022 - ReduceOnly Order is rejected.')), true);
  assert.equal(s._isReduceOnlyRejected(Object.assign(new Error('rejected'), { code: -2022 })), true);
  assert.equal(s._isReduceOnlyRejected(new Error('Binance API Error: -1021 - Timestamp for this request')), false);
  assert.equal(s._isReduceOnlyRejected(null), false);
});

test('_isReduceOnlyRejected matches the real makeProxyRequest shape (binanceErrorCode)', () => {
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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
  const s = reversalStrategy();
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

// getStatus carries the pair's real price precision so the frontend formats
// every price at tick precision instead of a magnitude heuristic.
test('getStatus surfaces the pair price precision from the cached exchange info', () => {
  precisionFormatter.cachePrecision('TESTUSDT', 0.001, 0.01, 5); // tickSize 0.001 -> 3 decimals
  const s = reversalStrategy();
  s.symbol = 'TESTUSDT';
  s._computeAccLoss = () => 0;
  assert.equal(s.getStatus().pricePrecision, 3);
});

// ——— Final TP manual level ———

function tpStrategy({ side = 'LONG', entry = 100, qty = 10, accLoss = 0, minProfit = 5 } = {}) {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy({ mode: 'TREND' });
  s.trendDirection = side;
  s.activePosition = { quantity: qty, entryPrice: entry, avgEntry: entry, notional: entry * qty, unrealizedPnl: 0 };
  s.cycleAccumulatedLoss = accLoss;
  s.desiredProfitUSDT = minProfit;
  s.minDesiredProfitUSDT = minProfit;
  s._recomputeFinalTpPrice();
  return s;
}

test('projectProfitAtPrice inverts the Final TP formula exactly', () => {
  const s = tpStrategy();                       // entry 100, qty 10, accLoss 0, floor 5
  // At the armed Final TP the projection must equal the desired profit itself —
  // if these disagree the editor previews one number and arms another.
  const p = s.projectProfitAtPrice(s.finalTpPrice);
  assert.ok(Math.abs(p.projectedProfitUSDT - s.desiredProfitUSDT) < 1e-6,
    `projected ${p.projectedProfitUSDT} != desired ${s.desiredProfitUSDT}`);
});

test('a higher Final TP projects more profit and is accepted (LONG)', async () => {
  const s = tpStrategy();
  const base = s.finalTpPrice;
  const r = await s.adjustFinalTp({ price: base + 1 });        // +1 * qty 10 = +10 USDT
  assert.ok(r.desiredProfitUSDT > 5, `expected > floor, got ${r.desiredProfitUSDT}`);
  assert.ok(Math.abs(s.finalTpPrice - (base + 1)) < 1e-6, 'the armed TP must land on the level asked for');
});

// THE INVERSION: a SHORT's Final TP sits BELOW entry, so more profit = LOWER price.
// A price-based "must be higher" check would reject the good level and accept a bad one.
test('for a SHORT, a LOWER Final TP is the more profitable one and is accepted', async () => {
  const s = tpStrategy({ side: 'SHORT' });
  const base = s.finalTpPrice;
  assert.ok(base < 100, 'precondition: a SHORT TP sits below entry');
  const r = await s.adjustFinalTp({ price: base - 1 });
  assert.ok(r.desiredProfitUSDT > 5);
  assert.ok(Math.abs(s.finalTpPrice - (base - 1)) < 1e-6);
});

test('a level projecting LESS than the config floor is rejected as bad input', async () => {
  const s = tpStrategy();
  const base = s.finalTpPrice;
  await assert.rejects(() => s.adjustFinalTp({ price: base - 0.5 }), (err) => {
    assert.equal(err.invalidInput, true, 'floor breach is a 400, not a 409');
    return /config/i.test(err.message);
  });
  assert.equal(s.desiredProfitUSDT, 5, 'a rejected edit must not move the target');
});

test('the SHORT floor is enforced in the inverted direction too', async () => {
  const s = tpStrategy({ side: 'SHORT' });
  const base = s.finalTpPrice;
  await assert.rejects(() => s.adjustFinalTp({ price: base + 0.5 }), (err) => err.invalidInput === true);
});

test('reset returns to the config target, not to the last edited value', async () => {
  const s = tpStrategy();
  const base = s.finalTpPrice;
  await s.adjustFinalTp({ price: base + 3 });
  assert.ok(s.desiredProfitUSDT > 5);
  const r = await s.adjustFinalTp({ reset: true });
  assert.equal(r.desiredProfitUSDT, 5, 'floor is the CONFIG value, not the raised one');
  assert.ok(Math.abs(s.finalTpPrice - base) < 1e-6, 'and the price returns to the original target');
});

test('adjustFinalTp refuses on unverified position state (never guesses a target)', async () => {
  const s = tpStrategy();
  s._lastPositionRefreshFailed = true;
  await assert.rejects(() => s.adjustFinalTp({ price: s.finalTpPrice + 5 }), (err) => {
    assert.equal(err.invalidInput, undefined, 'a state conflict is a 409, not a 400');
    return /no verified open position/i.test(err.message);
  });
});

test('adjustFinalTp rejects a non-positive level', async () => {
  const s = tpStrategy();
  await assert.rejects(() => s.adjustFinalTp({ price: 0 }), (err) => err.invalidInput === true);
});

// ——— Final TP: the % path must work in SCALING / while flat ———

// Regression: gating the editor on TREND removed the ability to set the profit
// target during SCALING, where it still matters — it is what _recomputeFinalTpPrice
// derives from the moment the outermost leg trips TREND.
test('profitUSDT sets the target while FLAT in SCALING (no position to price off)', async () => {
  const s = reversalStrategy();      // SCALING, activePosition null
  s.minDesiredProfitUSDT = 5;
  s.desiredProfitUSDT = 5;
  const r = await s.adjustFinalTp({ profitUSDT: 12 });
  assert.equal(r.desiredProfitUSDT, 12);
  assert.equal(s.finalTpPrice, null, 'no position yet, so no armed level — by design');
});

test('the profitUSDT path enforces the same config floor as the price path', async () => {
  const s = reversalStrategy();
  s.minDesiredProfitUSDT = 5;
  s.desiredProfitUSDT = 5;
  await assert.rejects(() => s.adjustFinalTp({ profitUSDT: 4 }), (err) => {
    assert.equal(err.invalidInput, true);
    return /config/i.test(err.message);
  });
  assert.equal(s.desiredProfitUSDT, 5, 'a rejected target must not move');
});

test('a profitUSDT set in SCALING arms the expected Final TP once TREND begins', async () => {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  s.minDesiredProfitUSDT = 5; s.desiredProfitUSDT = 5;
  await s.adjustFinalTp({ profitUSDT: 20 });
  // Now the cycle scales out and enters TREND with a real position.
  s.ladderMode = 'TREND';
  s.trendDirection = 'LONG';
  s.activePosition = { quantity: 10, entryPrice: 100, avgEntry: 100, notional: 1000, unrealizedPnl: 0 };
  s.cycleAccumulatedLoss = 0;
  s._recomputeFinalTpPrice();
  const back = s.projectProfitAtPrice(s.finalTpPrice);
  assert.ok(Math.abs(back.projectedProfitUSDT - 20) < 1e-6,
    `the SCALING-set target must survive into TREND; got ${back.projectedProfitUSDT}`);
});

// ——— A manual profit target carries across a reversal — loudly ———

function trendEntryStrategy({ desired = 5, floor = 5 } = {}) {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  s.desiredProfitUSDT = desired;
  s.minDesiredProfitUSDT = floor;
  s.activePosition = { quantity: 10, entryPrice: 97, avgEntry: 97, notional: 970, unrealizedPnl: 0 };
  s.currentSide = 'SHORT';
  s._refreshCurrentPosition = async () => {};
  s._writeStrategyFlow = async () => {};
  s._pushHeartbeatNow = () => {};
  return s;
}

test('_enterTrend announces a manual target carried in from an earlier direction', async () => {
  const s = trendEntryStrategy({ desired: 29.2, floor: 5 });
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };
  await s._enterTrend('SHORT');
  const carry = logs.find((m) => /carrying the manual profit target/i.test(m));
  assert.ok(carry, `expected a carry-over notice; got: ${JSON.stringify(logs)}`);
  assert.match(carry, /29\.20/, 'names the carried target');
  assert.match(carry, /5\.00/, 'and the config target it exceeds');
});

test('_enterTrend stays quiet when the target is still the config one', async () => {
  const s = trendEntryStrategy({ desired: 5, floor: 5 });
  const logs = [];
  s.addLog = async (m) => { logs.push(m); };
  await s._enterTrend('SHORT');
  assert.equal(logs.some((m) => /carrying the manual profit target/i.test(m)), false,
    'an untouched target is not worth a warning');
});

// The behaviour the notice explains: the target itself must NOT reset.
test('a reversal disarms the price but keeps the profit target', async () => {
  const s = reversalStrategy();
  s.desiredProfitUSDT = 29.2;
  s.minDesiredProfitUSDT = 5;
  s.ladderMode = 'TREND';
  s.trendDirection = 'LONG';
  s.finalTpPrice = 103;
  s.ladderLines.find(l => l.direction === 'LONG' && l.index === 1).state = 'POSITION_OPEN';
  s.activePosition = { quantity: 10, entryPrice: 100, avgEntry: 100, notional: 1000, unrealizedPnl: 0 };
  s.currentSide = 'LONG';
  s._closeConsolidated = async () => true;
  s._computeAccLoss = () => 20;
  s._computeLadderBaseSize = async () => 1000;
  await s._reverseTo('SHORT');
  assert.equal(s.finalTpPrice, null, 'the level dies with the position');
  assert.equal(s.desiredProfitUSDT, 29.2, 'the cycle-level goal survives');
  assert.equal(s.minDesiredProfitUSDT, 5, 'and the config floor is untouched');
});

// ——— Armed trigger: 'stop' action ends the cycle instead of re-anchoring ———

function triggerActionStrategy({ action = 'reanchor' } = {}) {
  precisionFormatter.cachePrecision('BTCUSDT', 0.01, 0.01, 5);
  const s = reversalStrategy();
  s.activePosition = { quantity: 10, entryPrice: 98, avgEntry: 98, notional: 980, unrealizedPnl: 20 };
  s.harvestTriggerPrice = 99;
  s.harvestTriggerAbove = false;          // set BELOW price -> fires on a fall
  s.harvestTriggerAction = action;
  return s;
}

test("a 'stop' trigger ends the cycle rather than re-anchoring", async () => {
  const s = triggerActionStrategy({ action: 'stop' });
  let stopped = null, reanchored = false;
  s.stop = async (o) => { stopped = o; };
  s._harvestToFlat = async () => { reanchored = true; return true; };
  await s.handleRealtimePrice(99);
  assert.equal(reanchored, false, 'must NOT rebuild the ladder');
  assert.deepEqual(stopped, { flatten: true, reason: 'protect' });
});

test("the default 'reanchor' trigger still re-anchors and keeps trading", async () => {
  const s = triggerActionStrategy({ action: 'reanchor' });
  let stopped = false, fired = null;
  s.stop = async () => { stopped = true; };
  s._harvestToFlat = async (r) => { fired = r; return true; };
  await s.handleRealtimePrice(99);
  assert.equal(fired, 'price_trigger');
  assert.equal(stopped, false, 'the cycle must continue');
});

// One-shot discipline: the action is read BEFORE the clears, and reset after, so
// a stale 'stop' can never attach itself to a later plain re-anchor trigger.
test('firing clears the action back to reanchor', async () => {
  const s = triggerActionStrategy({ action: 'stop' });
  s.stop = async () => {};
  await s.handleRealtimePrice(99);
  assert.equal(s.harvestTriggerPrice, null);
  assert.equal(s.harvestTriggerAction, 'reanchor');
});

test('harvestNow arms the stop action and rejects an unknown one', async () => {
  const s = reversalStrategy();
  s.currentPrice = 100;
  const r = await s.harvestNow(98, { action: 'stop' });
  assert.equal(r.action, 'stop');
  assert.equal(s.harvestTriggerAction, 'stop');

  await assert.rejects(() => s.harvestNow(97, { action: 'liquidate' }), (err) => {
    assert.equal(err.invalidInput, true, 'an unknown action is client input, not a state conflict');
    return /reanchor.*stop/i.test(err.message);
  });
});

test('an armed stop survives a save/resume round trip', async () => {
  const src = reversalStrategy();
  src.harvestTriggerPrice = 98; src.harvestTriggerAbove = false; src.harvestTriggerAction = 'stop';
  let doc = null;
  src.firestore = { collection: () => ({ doc: () => ({ set: async (d) => { doc = d; } }) }) };
  await ReversalLadderStrategy.prototype.saveState.call(src);
  assert.equal(doc.harvestTriggerAction, 'stop');

  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({ ...doc, isRunning: true, symbol: 'BTCUSDT' });
  cleanupResumeTimers(dst);
  assert.equal(dst.harvestTriggerAction, 'stop', 'a redeploy must not downgrade a stop to a re-anchor');
});

// A snapshot written before this field existed was armed under the old
// behaviour; resuming it as a cycle-ending stop would be a nasty surprise.
test('a legacy snapshot without the field resumes as reanchor', async () => {
  const dst = stubResumeIO(new ReversalLadderStrategy('http://proxy.invalid', 'p', 'http://vm.invalid'));
  dst.addLog = async () => {};
  await dst.resume({
    strategyId: 'reversal_ladder_legacy_test',   // resume() needs it for Firestore init
    isRunning: true, symbol: 'BTCUSDT',
    harvestTriggerPrice: 98, harvestTriggerAbove: false,   // note: no harvestTriggerAction
  });
  cleanupResumeTimers(dst);
  assert.equal(dst.harvestTriggerAction, 'reanchor');
});
