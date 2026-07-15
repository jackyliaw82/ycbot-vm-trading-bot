import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiDualStrategy } from '../ai-dual-strategy.js';

// Builds a strategy parked in a live mode with a consolidated position open,
// far enough from every trigger (finalTp / boundaries / LVN) that a tick only
// exercises the per-tick bookkeeping and not a trade sequence.
function strategyInMode(mode, { direction = 'LONG', entryPrice = 76.4, quantity = 3.16 } = {}) {
  const s = new AiDualStrategy('http://proxy.invalid', 'test-profile', 'http://vm.invalid');
  s.isRunning = true;
  s.strategyId = 'ai_dual_test';
  s.gridMode = mode;
  s.gridLines = [{ direction: 'LONG', levelIndex: 1, price: 75, state: 'EMPTY', quantity: null }];
  s.currentSide = direction;
  s.trendDirection = direction;
  s.unwindDirection = direction === 'LONG' ? 'SHORT' : 'LONG';
  s.activePosition = { quantity, entryPrice, avgEntry: entryPrice, notional: quantity * entryPrice, unrealizedPnl: 0 };
  // Triggers pushed out of reach so the tick is a pure no-op price move.
  s.finalTpPrice = null;
  s.harvestPrice = null;
  s.gridUpperBoundary = 1e9;
  s.gridLowerBoundary = 0;
  s.upperLVN = 1e9;
  s.lowerLVN = 0;
  s.unwindTranchesRemaining = 0;
  s.addLog = async () => {};
  s.saveState = async () => {};
  return s;
}

test('TREND tick refreshes the consolidated position unrealized PnL from the mark', async () => {
  const s = strategyInMode('TREND');
  s.activePosition.unrealizedPnl = 0.73; // stale value from an earlier mark (~76.63)

  await s.handleRealtimePrice(77.74);

  // LONG 3.16 @ 76.40, mark 77.74 → (77.74 − 76.40) × 3.16
  assert.equal(s.currentPrice, 77.74);
  assert.ok(
    Math.abs(s.activePosition.unrealizedPnl - 4.2344) < 1e-9,
    `expected unrealizedPnl ≈ 4.2344, got ${s.activePosition.unrealizedPnl}`,
  );
});

test('UNWIND tick refreshes the consolidated position unrealized PnL from the mark', async () => {
  const s = strategyInMode('UNWIND', { direction: 'SHORT', entryPrice: 76.4, quantity: 2 });
  s.activePosition.unrealizedPnl = 0;

  await s.handleRealtimePrice(75.4);

  // SHORT 2 @ 76.40, mark 75.40 → (76.40 − 75.40) × 2
  assert.ok(
    Math.abs(s.activePosition.unrealizedPnl - 2) < 1e-9,
    `expected unrealizedPnl ≈ 2, got ${s.activePosition.unrealizedPnl}`,
  );
});
