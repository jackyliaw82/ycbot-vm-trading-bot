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
