// Pure grid-crossing action planner. Ports ref-vm-bot-2 _processGridCrossings
// (strategy.js:2960-3110) into a side-effect-free function. Caller applies effects.

const OPEN = (reason, leg) => ({ kind: 'OPEN', reason, leg });
const CLOSE = (reason, leg) => ({ kind: 'CLOSE', reason, leg });

function deepestOpen(legs, direction) {
  const open = legs.filter(l => l.direction === direction && l.state === 'POSITION_OPEN' && l.quantity > 0);
  if (!open.length) return null;
  return direction === 'LONG'
    ? open.reduce((d, l) => (l.price < d.price ? l : d))  // lowest-price long
    : open.reduce((d, l) => (l.price > d.price ? l : d)); // highest-price short
}

export function planCrossingActions({ prevPrice, currentPrice, legs, vwapLong, vwapShort }) {
  const actions = [];
  if (prevPrice == null || currentPrice === prevPrice) return actions;
  const movingDown = currentPrice < prevPrice;

  if (movingDown) {
    const longs = legs.filter(l => l.direction === 'LONG').sort((a, b) => b.price - a.price); // highest first
    for (const leg of longs) {
      if (prevPrice > leg.price && currentPrice <= leg.price) {
        const opp = deepestOpen(legs, 'SHORT');
        if (opp) actions.push(CLOSE('TP_OPP', opp));
        if (leg.state === 'EMPTY') actions.push(OPEN('ENTRY', leg));
      }
    }
    const shorts = legs.filter(l => l.direction === 'SHORT').sort((a, b) => a.price - b.price); // lowest first
    for (const leg of shorts) {
      if (prevPrice > leg.price && currentPrice <= leg.price
        && leg.state === 'POSITION_OPEN' && vwapShort != null && leg.price < vwapShort) {
        actions.push(CLOSE('TP_SAME', leg));
      }
    }
  } else {
    const shorts = legs.filter(l => l.direction === 'SHORT').sort((a, b) => a.price - b.price); // lowest first
    for (const leg of shorts) {
      if (prevPrice < leg.price && currentPrice >= leg.price) {
        const opp = deepestOpen(legs, 'LONG');
        if (opp) actions.push(CLOSE('TP_OPP', opp));
        if (leg.state === 'EMPTY') actions.push(OPEN('ENTRY', leg));
      }
    }
    const longs = legs.filter(l => l.direction === 'LONG').sort((a, b) => b.price - a.price); // highest first
    for (const leg of longs) {
      if (prevPrice < leg.price && currentPrice >= leg.price
        && leg.state === 'POSITION_OPEN' && vwapLong != null && leg.price > vwapLong) {
        actions.push(CLOSE('TP_SAME', leg));
      }
    }
  }
  return actions;
}

// VWAP of open legs on a side (locked-average semantics live in the strategy, which
// recomputes on OPEN and nulls when the side is flat).
export function averageOpenEntry(legs, direction) {
  const open = legs.filter(l => l.direction === direction && l.state === 'POSITION_OPEN' && l.quantity > 0);
  if (!open.length) return null;
  const cost = open.reduce((s, l) => s + l.price * l.quantity, 0);
  const qty = open.reduce((s, l) => s + l.quantity, 0);
  return qty > 0 ? cost / qty : null;
}
