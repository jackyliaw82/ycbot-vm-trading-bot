// Pure grid-crossing action planner. Ports ref-vm-bot-2 _processGridCrossings
// (strategy.js:2960-3110) into a side-effect-free function. Caller applies effects.

const OPEN = (reason, leg) => ({ kind: 'OPEN', reason, leg });
const CLOSE = (reason, leg) => ({ kind: 'CLOSE', reason, leg });

export function planCrossingActions({ prevPrice, currentPrice, legs, vwapLong, vwapShort }) {
  const actions = [];
  if (prevPrice == null || currentPrice === prevPrice) return actions;
  const movingDown = currentPrice < prevPrice;

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
    // Every grid level crossed downward, in the order price traverses them
    // (highest first). At each crossing PEEL the outermost open short as a
    // take-profit — but ONLY while the tick drove price below the short VWAP, so
    // the buy-back is guaranteed profitable against the average. Long legs
    // additionally OPEN (two-sided inventory) as price steps into their territory
    // — CLOSE before OPEN at each level.
    const crossed = legs
      .filter(l => prevPrice > l.price && currentPrice <= l.price)
      .sort((a, b) => b.price - a.price);
    for (const leg of crossed) {
      if (vwapShort != null && currentPrice < vwapShort) {
        const opp = outermostOpen('SHORT');
        if (opp) { actions.push(CLOSE('TP_PEEL', opp)); stateOf.set(opp, 'EMPTY'); }
      }
      if (leg.direction === 'LONG' && stateOf.get(leg) === 'EMPTY') {
        actions.push(OPEN('ENTRY', leg)); stateOf.set(leg, 'POSITION_OPEN');
      }
    }
  } else {
    // Symmetric on the way up: peel the outermost open long (lowest price) while
    // price is ABOVE the long VWAP (profitable), and OPEN short legs as price
    // steps into their territory.
    const crossed = legs
      .filter(l => prevPrice < l.price && currentPrice >= l.price)
      .sort((a, b) => a.price - b.price);
    for (const leg of crossed) {
      if (vwapLong != null && currentPrice > vwapLong) {
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
