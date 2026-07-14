// Pure grid-crossing action planner. Ports ref-vm-bot-2 _processGridCrossings
// (strategy.js:2960-3110) into a side-effect-free function. Caller applies effects.

const OPEN = (reason, leg) => ({ kind: 'OPEN', reason, leg });
const CLOSE = (reason, leg) => ({ kind: 'CLOSE', reason, leg });

// Grid take-profit ("peel") gate — the four RANGE rules (user-directed 2026-07-14):
//   1. Current price on the profitable side of the side's VWAP
//      (below shortVWAP to buy back a short, above longVWAP to sell a long).
//   2. The CROSSED grid level is at least ONE grid step away from the VWAP, on the
//      profitable side. This is what lets a LONE leg's VWAP sit ON its own level:
//      crossing its own level is 0 grids from the VWAP → no peel; it waits for the
//      first opposite-territory level (≥1 grid away) instead. It also blocks
//      marginal, sub-grid-of-profit peels near the average.
//   3. Never peel AT the anchor (RANGE). Structurally the grid has no leg at the
//      anchor, so this is a belt-and-suspenders guard; the UNWIND anchor tranche
//      sweep is a different code path (this planner only runs in RANGE).
//   4. Always peel the OUTERMOST open leg on that side (see outermostOpen).
// gridStep/gridAnchor are optional; without gridStep, rule 2 falls back to the
// strict "crossed level strictly beyond the VWAP" gate (still lone-leg-safe).
export function planCrossingActions({ prevPrice, currentPrice, legs, vwapLong, vwapShort, gridStep, gridAnchor }) {
  const actions = [];
  if (prevPrice == null || currentPrice === prevPrice) return actions;
  const movingDown = currentPrice < prevPrice;

  const EPS = gridStep != null && gridStep > 0 ? gridStep * 1e-6 : 1e-9;
  const atAnchor = (leg) => gridAnchor != null && Math.abs(leg.price - gridAnchor) <= EPS;

  // Rule 2, short side: the crossed level is ≥1 grid BELOW the short VWAP.
  const distOkShort = (leg) => {
    if (vwapShort == null) return false;
    if (gridStep != null && gridStep > 0) return (vwapShort - leg.price) >= gridStep - EPS;
    return leg.price < vwapShort - EPS; // fallback: strictly below the VWAP
  };
  // Rule 2, long side: the crossed level is ≥1 grid ABOVE the long VWAP.
  const distOkLong = (leg) => {
    if (vwapLong == null) return false;
    if (gridStep != null && gridStep > 0) return (leg.price - vwapLong) >= gridStep - EPS;
    return leg.price > vwapLong + EPS;
  };

  // Shadow state: simulate sequential leg mutation WITHOUT mutating the caller's
  // legs (purity), so outermostOpen() re-evaluates as we peel legs within one tick.
  const stateOf = new Map(legs.map(l => [l, l.state]));
  const isOpen = (l) => stateOf.get(l) === 'POSITION_OPEN' && l.quantity > 0;

  // The OUTERMOST open leg on a side: the highest-price open short / lowest-price
  // open long (farthest from the anchor). Take-profit always peels these FIRST —
  // it keeps the extreme rungs free to re-enter, and re-opening a high short raises
  // the short VWAP while re-opening a low long lowers the long VWAP, both improving
  // the average entry for that side (the whole point of the close-outermost order).
  const outermostOpen = (direction) => {
    const open = legs.filter(l => l.direction === direction && isOpen(l));
    if (!open.length) return null;
    return direction === 'LONG'
      ? open.reduce((d, l) => (l.price < d.price ? l : d))  // lowest-price long
      : open.reduce((d, l) => (l.price > d.price ? l : d)); // highest-price short
  };

  if (movingDown) {
    // Every grid level crossed downward, highest first. At each crossing PEEL the
    // outermost open short as a take-profit — gated by the four rules above:
    // price below shortVWAP (1), the CROSSED level ≥1 grid below shortVWAP (2),
    // and not the anchor (3). Long legs also OPEN as price steps into their
    // territory (CLOSE before OPEN at each level).
    const crossed = legs
      .filter(l => prevPrice > l.price && currentPrice <= l.price)
      .sort((a, b) => b.price - a.price);
    for (const leg of crossed) {
      if (currentPrice < vwapShort && distOkShort(leg) && !atAnchor(leg)) {
        const opp = outermostOpen('SHORT');
        if (opp) { actions.push(CLOSE('TP_PEEL', opp)); stateOf.set(opp, 'EMPTY'); }
      }
      if (leg.direction === 'LONG' && stateOf.get(leg) === 'EMPTY') {
        actions.push(OPEN('ENTRY', leg)); stateOf.set(leg, 'POSITION_OPEN');
      }
    }
  } else {
    // Symmetric on the way up: peel the outermost open long (lowest price) when
    // price is above longVWAP (1) and the CROSSED level is ≥1 grid above longVWAP
    // (2), not the anchor (3). Short legs also OPEN as price steps into theirs.
    const crossed = legs
      .filter(l => prevPrice < l.price && currentPrice >= l.price)
      .sort((a, b) => a.price - b.price);
    for (const leg of crossed) {
      if (currentPrice > vwapLong && distOkLong(leg) && !atAnchor(leg)) {
        const opp = outermostOpen('LONG');
        if (opp) { actions.push(CLOSE('TP_PEEL', opp)); stateOf.set(opp, 'EMPTY'); }
      }
      if (leg.direction === 'SHORT' && stateOf.get(leg) === 'EMPTY') {
        actions.push(OPEN('ENTRY', leg)); stateOf.set(leg, 'POSITION_OPEN');
      }
    }
  }
  return actions;
}

export function averageOpenEntry(legs, direction) {
  const open = legs.filter(l => l.direction === direction && l.state === 'POSITION_OPEN' && l.quantity > 0);
  if (!open.length) return null;
  const cost = open.reduce((s, l) => s + l.price * l.quantity, 0);
  const qty = open.reduce((s, l) => s + l.quantity, 0);
  return qty > 0 ? cost / qty : null;
}
