import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakoutStrategy } from './breakout-strategy.test.js';
import { FEE_RATE } from '../fees.js';

// A strategy holding a verified position, with the cycle accumulators set to a
// chosen signed net PnL. Everything the Final TP reads is explicit here.
function holding({ side = 'LONG', entry = 100, qty = 1, realized = 0, fees = 0, funding = 0,
                   desired = 50, ai = 0 } = {}) {
  const s = breakoutStrategy();
  s.accumulatedRealizedPnL = realized;
  s.accumulatedTradingFees = fees;      // stored as a POSITIVE magnitude
  s.accumulatedFundingFees = funding;
  s.desiredProfitUSDT = desired;
  s.aiCostUSD = ai;
  s._lastPositionRefreshFailed = false;
  s.openLeg = { direction: side, quantity: qty, fillPrice: entry, openedAt: 0 };
  // projectProfitAtPrice keys off currentSide while _recomputeFinalTpPrice keys
  // off heldSide (openLeg). Set both so this fixture does not depend on which.
  s.currentSide = side;
  s.activePosition = { quantity: qty, entryPrice: entry, notional: entry * qty };
  s.cycleAccumulatedLoss = s._computeAccLoss();
  return s;
}

// The cycle's REPORTED net if the position were closed at `price` — the exact
// quantity `desiredProfitUSDT` denotes, so it is what the assertions check.
//
// aiCost is subtracted because it is NOT a wallet event: the formula adds it to
// `needed` precisely so that the wallet lands on desiredProfit + aiCost and the
// frontend, which counts AI spend in Net, then reports desiredProfit. Leaving it
// out here would measure the wallet and read the deliberate offset as drift.
const netAtClose = (s, price) => {
  const { quantity: qty, entryPrice: entry } = s.activePosition;
  const gain = s.heldSide === 'LONG' ? (price - entry) * qty : (entry - price) * qty;
  const banked = s.accumulatedRealizedPnL - s.accumulatedTradingFees + s.accumulatedFundingFees;
  return banked + gain - price * qty * FEE_RATE - (s.aiCostUSD || 0);
};
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

// The target can only land on desiredProfit as accurately as the closing-fee
// ESTIMATE allows: the formula charges entry notional, the exchange charges exit
// notional. The gap is exactly the price move times the fee rate — deliberate and
// documented — so assertions about "lands on target" carry that band rather than
// a made-up epsilon that would hide a real drift.
const feeBand = (s) => {
  const { quantity: qty, entryPrice: entry } = s.activePosition;
  return Math.abs(s.finalTpPrice - entry) * qty * FEE_RATE + 1e-6;
};

// ─── the clamp stays where sizing needs it ──────────────────────────────────

test('_computeAccLoss floors at zero — sizing must never see a negative loss', () => {
  const s = breakoutStrategy();
  s.accumulatedRealizedPnL = 40; s.accumulatedTradingFees = 0; s.accumulatedFundingFees = 0;
  assert.equal(s._computeAccLoss(), 0);
  s.accumulatedRealizedPnL = -30;
  assert.equal(s._computeAccLoss(), 30);
});

test('_computeNetSignedPnL keeps the sign the clamp throws away', () => {
  const s = breakoutStrategy();
  s.accumulatedRealizedPnL = 2.5507; s.accumulatedTradingFees = 0.6777; s.accumulatedFundingFees = 0.0543;
  near(s._computeNetSignedPnL(), 1.9273, 1e-4);
  s.accumulatedRealizedPnL = -3.674; s.accumulatedTradingFees = 0.4781; s.accumulatedFundingFees = 0.0082;
  near(s._computeNetSignedPnL(), -4.1439, 1e-4);
});

test('banked profit does not shrink the position back below initial size', () => {
  const s = breakoutStrategy({ base: 1000 });
  s.accumulatedRealizedPnL = 500; s.accumulatedTradingFees = 0; s.accumulatedFundingFees = 0;
  s.cycleAccumulatedLoss = s._computeAccLoss();
  assert.equal(s._computeFormulaSize(), s.currentInitialSize);
});

// ─── the Final TP honours the sign ──────────────────────────────────────────

test('drawdown is unchanged — the target still lands on desiredProfit', () => {
  const s = holding({ realized: -30, desired: 50 });
  s._recomputeFinalTpPrice();
  near(netAtClose(s, s.finalTpPrice), 50, feeBand(s));
});

test('banked profit pulls the target IN instead of being discarded', () => {
  const s = holding({ realized: 40, desired: 50 });
  const flat = holding({ realized: 0, desired: 50 });
  s._recomputeFinalTpPrice(); flat._recomputeFinalTpPrice();
  assert.ok(s.finalTpPrice < flat.finalTpPrice,
    `LONG target must move closer when profit is banked (${s.finalTpPrice} vs ${flat.finalTpPrice})`);
  near(netAtClose(s, s.finalTpPrice), 50, feeBand(s));
});

test('SHORT banked profit moves the target UP toward entry', () => {
  const s = holding({ side: 'SHORT', realized: 40, desired: 50 });
  const flat = holding({ side: 'SHORT', realized: 0, desired: 50 });
  s._recomputeFinalTpPrice(); flat._recomputeFinalTpPrice();
  assert.ok(s.finalTpPrice > flat.finalTpPrice, 'SHORT target must move closer');
  near(netAtClose(s, s.finalTpPrice), 50, feeBand(s));
});

test('target already banked — TP never lands on the losing side of entry', () => {
  for (const side of ['LONG', 'SHORT']) {
    const s = holding({ side, realized: 500, desired: 50 });   // banked far exceeds the target
    s._recomputeFinalTpPrice();
    assert.ok(s.finalTpPrice != null, `${side}: must still arm a target`);
    if (side === 'LONG') assert.ok(s.finalTpPrice > 100, `${side}: TP ${s.finalTpPrice} below entry`);
    else assert.ok(s.finalTpPrice < 100, `${side}: TP ${s.finalTpPrice} above entry`);
    assert.ok(netAtClose(s, s.finalTpPrice) >= 50, `${side}: closing there must still clear the target`);
  }
});

// ─── the editor's preview must keep inverting the target ────────────────────

test('projectProfitAtPrice still inverts the Final TP when profit is banked', () => {
  const s = holding({ realized: 40, desired: 50 });
  s._recomputeFinalTpPrice();
  const p = s.projectProfitAtPrice(s.finalTpPrice);
  near(p.projectedProfitUSDT, 50, 1e-6);
});

// ─── regression: the real CL/USDT cycle ─────────────────────────────────────

test('CL/USDT 08/25 — banked 1.9273 is credited against the 3.13 target', () => {
  const s = holding({
    side: 'SHORT', entry: 85.73, qty: 0.58,
    realized: 2.5507, fees: 0.6777, funding: 0.0543,
    desired: 3.13, ai: 0.004,
  });
  assert.equal(s.cycleAccumulatedLoss, 0, 'accLoss stays clamped for sizing');
  s._recomputeFinalTpPrice();
  near(s.finalTpPrice, 83.58, 0.02);            // was 80.26 with the profit discarded
  near(netAtClose(s, s.finalTpPrice), 3.13, feeBand(s));
});

// ─── the editor round-trip, in the case the change actually alters ──────────

test('adjustFinalTp(price) round-trips through the signed value', async () => {
  // adjustFinalTp(price) back-solves desiredProfitUSDT from projectProfitAtPrice,
  // then _recomputeFinalTpPrice re-derives the level from it. If those two ever
  // disagreed about the sign, asking for a level would arm a DIFFERENT one — the
  // exact failure the shared helper exists to prevent. Only bites when banked
  // profit is non-zero, which no pre-existing test covers.
  for (const side of ['LONG', 'SHORT']) {
    // ai > 0 deliberately: the preview had no aiCost term while the target did,
    // so asking for a level armed one off by aiCost/qty.
    const s = holding({ side, realized: 40, desired: 50, ai: 0.75 });
    s.minDesiredProfitUSDT = 0;
    s.currentPrice = 100;
    const want = side === 'LONG' ? 130 : 70;
    await s.adjustFinalTp({ price: want });
    near(s.finalTpPrice, want, 1e-6);
    near(netAtClose(s, s.finalTpPrice), s.desiredProfitUSDT, feeBand(s));
  }
});

test('adjustFinalTp(profitUSDT) above the banked amount nets exactly that profit', async () => {
  const s = holding({ realized: 40, desired: 50 });
  s.minDesiredProfitUSDT = 0;
  await s.adjustFinalTp({ profitUSDT: 60 });
  near(netAtClose(s, s.finalTpPrice), 60, feeBand(s));
});

test('a target BELOW what is already banked cannot arm a losing exit', async () => {
  // Asking for 12 when 40 is banked makes `needed` negative. The floor turns
  // that into "close as soon as the open leg is not itself down", so the level
  // stays just ABOVE entry for a LONG and the cycle ends over-target rather
  // than the TP crossing below entry and firing as an uncommanded stop.
  const s = holding({ realized: 40, desired: 50 });
  s.minDesiredProfitUSDT = 0;
  await s.adjustFinalTp({ profitUSDT: 12 });
  assert.ok(s.finalTpPrice > s.activePosition.entryPrice,
    `TP ${s.finalTpPrice} must stay above entry ${s.activePosition.entryPrice}`);
  assert.ok(netAtClose(s, s.finalTpPrice) >= 12, 'closing there must still clear the asked-for target');
});
