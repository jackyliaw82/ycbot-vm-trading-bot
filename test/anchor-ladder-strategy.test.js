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
