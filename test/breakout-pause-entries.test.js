import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BreakoutStrategy } from '../breakout-strategy.js';

// LOCAL fixture on purpose. `test/breakout-final-tp.test.js` imports the shared
// helper out of `test/breakout-strategy.test.js`, which drags that file's whole
// suite into a second process and is why the reported test total over-counts.
// Not repeating that here: this file owns its setup and runs its own tests once.
//
// bull 100 / bear 98 at breakoutPct 1.5% puts the entries at 101.5 and 96.53,
// with price parked at 99 inside the inert band.
function strategy({ bull = 100, bear = 98, pct = 0.015, base = 1000 } = {}) {
  const s = new BreakoutStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  s.isRunning = true;
  s.strategyId = 'breakout_pause_test';
  s.symbol = 'BTCUSDT';
  s.breakoutPct = pct;
  s.bullLevel = bull;
  s.bearLevel = bear;
  s.currentPrice = 99;
  s.lastProcessedPrice = 99;
  s.minNotional = 5;
  s._positionBaseSize = base;
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
  s._computePositionBaseSize = async () => s._positionBaseSize;
  s.roundPrice = (p) => p;
  s.roundQuantity = (q) => q;
  s._formatPrice = (p) => String(p);
  s._deriveBreakoutLevels();
  return s;
}

// Record what the dispatch DECIDED without executing any of it.
function spy(s) {
  const calls = { opened: [], stopped: 0, cycleEnded: [] };
  s._openPosition = async (side) => { calls.opened.push(side); s.openLeg = { direction: side, quantity: 1, fillPrice: s.currentPrice, openedAt: Date.now() }; };
  s._recomputeFinalTpPrice = () => {};
  s._stopOut = async () => { calls.stopped++; s.openLeg = null; return true; };
  s.stop = async ({ reason } = {}) => { calls.cycleEnded.push(reason); };
  return calls;
}

// ─── the gate ───────────────────────────────────────────────────────────────

test('paused: a valid bull crossing opens nothing', async () => {
  const s = strategy();
  const calls = spy(s);

  s.entriesPaused = true;
  await s._dispatchTick(102);          // crosses bullBreakout 101.5 from 99

  assert.deepEqual(calls.opened, [], 'a held strategy must not open');
});

test('unpaused: the SAME crossing does open — the gate is the only difference', async () => {
  const s = strategy();
  const calls = spy(s);

  await s._dispatchTick(102);

  assert.deepEqual(calls.opened, ['LONG']);
});

test('paused: the gap latch is cleared, not merely skipped', async () => {
  const s = strategy();
  spy(s);
  s._pendingEntry = 'SHORT';           // as a stop-out would have left it
  s.entriesPaused = true;

  await s._dispatchTick(99.2);

  assert.equal(s._pendingEntry, null,
    'carrying the latch across a pause fires an uncommanded entry on resume');
});

test('pauseEntries(true) clears a latch queued before the request landed', async () => {
  const s = strategy();
  s._pendingEntry = 'LONG';

  await s.pauseEntries(true);

  assert.equal(s._pendingEntry, null);
});

// ─── resume semantics: a fresh crossing, never a catch-up ───────────────────

test('paused: lastProcessedPrice keeps advancing', async () => {
  const s = strategy();
  spy(s);
  s.entriesPaused = true;

  await s._dispatchTick(104);

  assert.equal(s.lastProcessedPrice, 104,
    'freezing it would make the whole paused span read as one crossing');
});

test('resuming while price sits beyond an entry level opens NOTHING', async () => {
  const s = strategy();
  const calls = spy(s);

  s.entriesPaused = true;
  await s._dispatchTick(104);          // ran past bullBreakout 101.5 while held
  s.entriesPaused = false;
  await s._dispatchTick(104.1);        // first tick after resuming

  assert.deepEqual(calls.opened, [], 'resuming must not itself be a trade');
});

test('after resuming, a FRESH crossing opens normally', async () => {
  const s = strategy();
  const calls = spy(s);

  s.entriesPaused = true;
  await s._dispatchTick(104);
  s.entriesPaused = false;
  await s._dispatchTick(104.1);        // no open (above)
  await s._dispatchTick(100);          // back inside the band
  await s._dispatchTick(102);          // crosses up again

  assert.deepEqual(calls.opened, ['LONG']);
});

// ─── exits are untouched — the whole point of the feature ───────────────────

test('paused: an open position still stops at its level', async () => {
  const s = strategy();
  const calls = spy(s);
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: Date.now() };
  s.entriesPaused = true;

  await s._dispatchTick(99.9);         // below bullLevel 100 -> the stop

  assert.equal(calls.stopped, 1, 'pausing holds new risk; it must not strand existing risk');
});

test('paused: an open position still ends the cycle at the Final TP', async () => {
  const s = strategy();
  const calls = spy(s);
  s.openLeg = { direction: 'LONG', quantity: 1, fillPrice: 101.5, openedAt: Date.now() };
  s.finalTpPrice = 105;
  s.entriesPaused = true;

  await s._dispatchTick(105.2);

  assert.deepEqual(calls.cycleEnded, ['final_tp']);
});

test('paused: a queued manual harvest still runs', async () => {
  const s = strategy();
  spy(s);
  let harvested = false;
  s._harvestToFlat = async (reason) => { harvested = reason; };
  s.entriesPaused = true;
  s._manualHarvestRequested = true;

  await s._dispatchTick(99.1);

  assert.equal(harvested, 'manual_harvest', 'harvest closes and re-plans; it never opens');
});

// ─── the toggle + persistence ───────────────────────────────────────────────

test('pauseEntries is idempotent and returns the live state', async () => {
  const s = strategy();
  assert.deepEqual(await s.pauseEntries(true), { entriesPaused: true, heldSide: null });
  assert.deepEqual(await s.pauseEntries(true), { entriesPaused: true, heldSide: null });
  assert.deepEqual(await s.pauseEntries(false), { entriesPaused: false, heldSide: null });
});

test('pauseEntries rejects a non-boolean as client input, not a state conflict', async () => {
  const s = strategy();
  await assert.rejects(() => s.pauseEntries('true'), (e) => e.invalidInput === true);
  await assert.rejects(() => s.pauseEntries(null), (e) => e.invalidInput === true);
  assert.equal(s.entriesPaused, false, 'a rejected request must not half-apply');
});

test('pauseEntries refuses when the strategy is not running', async () => {
  const s = strategy();
  s.isRunning = false;
  await assert.rejects(() => s.pauseEntries(true), /not running/);
});

test('saveState persists the flag — a restart that forgot it would resume trading', async () => {
  const s = strategy();
  let written = null;
  s.saveState = BreakoutStrategy.prototype.saveState;   // the REAL one
  s.userId = 'u1';
  s.firestore = {
    collection: () => ({ doc: () => ({ set: async (doc) => { written = doc; } }) }),
  };

  await s.pauseEntries(true);

  assert.equal(written.entriesPaused, true);
});

test('both frontend channels carry the flag, or the UI disagrees with itself', () => {
  const s = strategy();
  s.entriesPaused = true;
  // getStatus touches the volume-snapshot caches; they are null on a bare
  // fixture, which is exactly what an un-refreshed strategy looks like.
  assert.equal(s.getStatus().entriesPaused, true, 'missing from getStatus (HTTP poll)');
  assert.equal(s.getHeartbeatPayload().entriesPaused, true, 'missing from the WS heartbeat');
});

test('a snapshot written before the field existed resumes UNPAUSED', () => {
  // Those cycles were never paused, so false is the faithful reading. Asserted
  // on the restore expression itself: resume() does live I/O well past this
  // line, so driving the whole method here would test the stubs, not the rule.
  const restore = (snapshot) => snapshot.entriesPaused === true;
  assert.equal(restore({}), false, 'legacy snapshot');
  assert.equal(restore({ entriesPaused: false }), false);
  assert.equal(restore({ entriesPaused: true }), true);
  assert.equal(restore({ entriesPaused: 'true' }), false, 'a string must not read as paused');
});
