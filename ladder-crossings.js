// Pure per-tick planner for the anchor ladder. No I/O, no mutation.
//
// Replaces grid-crossings.js, which is deleted. That module's four rules were
// all mean-reversion (peel the outermost open leg, gate the peel on VWAP
// distance, skip the anchor leg). NONE of it applies here: this design has NO
// take-profit peel. The only closes in the whole strategy are the anchor
// flatten and the Final TP, and both are full closes of one netted position.
//
// The entire rule set:
//   1. Band crosses the anchor            -> flatten, fill NOTHING (two-tick rule)
//   2. Otherwise                          -> fill EVERY empty leg inside the band
//   3. There is no rule 3.

const between = (x, a, b) => x >= Math.min(a, b) && x <= Math.max(a, b);

// "Crosses the anchor" is deliberately NOT just "the anchor is inside the
// band". A tick routinely STARTS exactly at the anchor price (e.g. the tick
// right after a flatten), and moving away from the anchor on that next tick
// must NOT itself read as crossing it — otherwise the strategy would
// re-flatten instantly instead of filling the first leg it reaches. Landing
// exactly ON the anchor from an off-anchor price, or straddling it from one
// side to the other, both still count as crossing.
const crossesAnchor = (anchor, prevPrice, currentPrice) =>
  prevPrice !== anchor && between(anchor, prevPrice, currentPrice);

/**
 * @returns {{ flatten: boolean, fills: Array<object> }} `fills` holds leg
 *   OBJECT REFERENCES from `legs` — the caller mutates them after the fill is
 *   confirmed by the user-data WS. Nothing here mutates.
 */
export function planLadderActions({ prevPrice, currentPrice, anchor, legs }) {
  const none = { flatten: false, fills: [] };
  if (prevPrice == null || !Number.isFinite(prevPrice)) return none;   // first tick: no band
  if (!Number.isFinite(currentPrice) || currentPrice === prevPrice) return none;
  if (!Number.isFinite(anchor)) return none;

  // Rule 1. The anchor wins outright. Deliberately fills nothing even when the
  // band also spans opposite-side levels: the spec's two-tick rule flattens
  // here and lets the next tick open the other side, rather than closing and
  // re-opening inside one price move.
  if (crossesAnchor(anchor, prevPrice, currentPrice)) return { flatten: true, fills: [] };

  // Rule 2. Every empty leg in the band, ordered from the anchor outward so the
  // fill sequence matches the price's actual path through the ladder.
  const fills = (legs || [])
    .filter(l => l.state === 'EMPTY' && between(l.price, prevPrice, currentPrice))
    .sort((a, b) => Math.abs(a.price - anchor) - Math.abs(b.price - anchor));

  return { flatten: false, fills };
}

/**
 * Fill-weighted average entry of the open legs on one side.
 *
 * Uses the ACTUAL fill price where the user-data WS gave us one, falling back
 * to the level price only for a leg that somehow lacks it (an unavailable WS
 * fill). Carried over from grid-crossings.js:100-108 — the one piece of that
 * module that survives.
 */
export function averageOpenEntry(legs, direction) {
  const open = (legs || []).filter(l => l.state === 'POSITION_OPEN' && l.direction === direction && l.quantity > 0);
  if (!open.length) return null;
  const px = (l) => (Number.isFinite(l.fillPrice) && l.fillPrice > 0 ? l.fillPrice : l.price);
  const cost = open.reduce((s, l) => s + px(l) * l.quantity, 0);
  const qty = open.reduce((s, l) => s + l.quantity, 0);
  return qty > 0 ? cost / qty : null;
}
