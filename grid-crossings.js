// Pure grid-crossing action planner. Ports ref-vm-bot-2 _processGridCrossings
// (strategy.js:2960-3110) into a side-effect-free function. Caller applies effects.

const OPEN = (reason, leg) => ({ kind: 'OPEN', reason, leg });
const CLOSE = (reason, leg) => ({ kind: 'CLOSE', reason, leg });

export function planCrossingActions({ prevPrice, currentPrice, legs, vwapLong, vwapShort }) {
  const actions = [];
  if (prevPrice == null || currentPrice === prevPrice) return actions;
  const movingDown = currentPrice < prevPrice;

  // Shadow state: simulate ref-vm-bot-2's sequential leg mutation WITHOUT mutating the
  // caller's legs (purity). Prevents duplicate opposite-territory closes when a single
  // tick crosses multiple same-direction levels but fewer opposite legs are open.
  const stateOf = new Map(legs.map(l => [l, l.state]));
  const isOpen = (l) => stateOf.get(l) === 'POSITION_OPEN' && l.quantity > 0;

  const deepestOpen = (direction) => {
    const open = legs.filter(l => l.direction === direction && isOpen(l));
    if (!open.length) return null;
    return direction === 'LONG'
      ? open.reduce((d, l) => (l.price < d.price ? l : d))  // lowest-price long
      : open.reduce((d, l) => (l.price > d.price ? l : d)); // highest-price short
  };

  if (movingDown) {
    const longs = legs.filter(l => l.direction === 'LONG').sort((a, b) => b.price - a.price); // highest first
    for (const leg of longs) {
      if (prevPrice > leg.price && currentPrice <= leg.price) {
        const opp = deepestOpen('SHORT');
        if (opp) { actions.push(CLOSE('TP_OPP', opp)); stateOf.set(opp, 'EMPTY'); }
        if (stateOf.get(leg) === 'EMPTY') { actions.push(OPEN('ENTRY', leg)); stateOf.set(leg, 'POSITION_OPEN'); }
      }
    }
    const shorts = legs.filter(l => l.direction === 'SHORT').sort((a, b) => a.price - b.price); // lowest first
    for (const leg of shorts) {
      if (prevPrice > leg.price && currentPrice <= leg.price
        && isOpen(leg) && vwapShort != null && leg.price < vwapShort) {
        actions.push(CLOSE('TP_SAME', leg)); stateOf.set(leg, 'EMPTY');
      }
    }
  } else {
    const shorts = legs.filter(l => l.direction === 'SHORT').sort((a, b) => a.price - b.price); // lowest first
    for (const leg of shorts) {
      if (prevPrice < leg.price && currentPrice >= leg.price) {
        const opp = deepestOpen('LONG');
        if (opp) { actions.push(CLOSE('TP_OPP', opp)); stateOf.set(opp, 'EMPTY'); }
        if (stateOf.get(leg) === 'EMPTY') { actions.push(OPEN('ENTRY', leg)); stateOf.set(leg, 'POSITION_OPEN'); }
      }
    }
    const longs = legs.filter(l => l.direction === 'LONG').sort((a, b) => b.price - a.price); // highest first
    for (const leg of longs) {
      if (prevPrice < leg.price && currentPrice >= leg.price
        && isOpen(leg) && vwapLong != null && leg.price > vwapLong) {
        actions.push(CLOSE('TP_SAME', leg)); stateOf.set(leg, 'EMPTY');
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
