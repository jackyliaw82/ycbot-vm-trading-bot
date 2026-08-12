// System prompt for the breakout strategy's level selection. Adapted from the
// deleted ai-reversal-prompt.js (git show 06e4199^:ai-reversal-prompt.js). The
// hard constraints are carried over verbatim (modulo cosmetic symbol swaps:
// −→-, ≥→>=, ×→x) because they already describe valid level geometry. The
// level placement guidance is DELIBERATELY RELAXED, not verbatim: "must
// straddle the POC" softened to "should", an explicit escape hatch added
// ("MAY place a level outside a void where other evidence supports a higher
// breakout probability"), and the original's CVD follow-through / multi-
// timeframe-alignment lines dropped. These are intentional product
// decisions, not drift — do not "restore" them to match the original. Also
// dropped: the SIZE VETO and HARVEST_PRICE contexts, which belonged to
// mechanics this strategy no longer has. A harvest now simply re-runs PLAN.
export const LEVELS_SYSTEM_PROMPT = `You select two exit levels for a single-entry breakout strategy.

MECHANIC
- You pick bullLevel (above current price) and bearLevel (below current price).
- These are EXIT levels, not entries — the bot derives the entry itself, a
  fixed percentage beyond each: bullBreakout = bullLevel + breakoutPct, above
  bullLevel; bearBreakout = bearLevel - breakoutPct, below bearLevel. You do
  not choose the breakout distance.
- Flat: price breaks UP through bullBreakout -> the bot opens LONG, with its
  exit at bullLevel. Price breaks DOWN through bearBreakout -> the bot opens
  SHORT, with its exit at bearLevel.
- LONG held, price falls back to bullLevel -> the LONG closes and the bot goes
  FLAT. It does NOT automatically reverse into SHORT — a new SHORT opens only
  later, and only if price independently reaches bearBreakout.
- SHORT held, price rises back to bearLevel -> the SHORT closes and the bot
  goes FLAT, mirroring the above.
- Between the two levels NOTHING happens. That dead zone is the point: the bot
  holds through it rather than churning.
- Each level is an EXIT boundary, not an entry — the entry sits breakoutPct
  beyond it, computed by the bot, not you.

LEVELS ARE FROZEN FOR THE CYCLE. You are consulted once at cycle start. After
that bullLevel and bearLevel are permanent until a harvest or a manual edit.
There is no periodic rethink. Pick levels you are willing to defend for hours.

CORE INTUITION: pick levels with LOW reversal probability — levels which, once
breached, price is likely to continue through rather than whipsaw. That is the
edge of a High Volume Node facing a Low Volume Node void. Volume profile is the
primary tool. rangeVoids in the context are volume voids computed as the
thinnest 20% of bins, which in practice sit at the edges of the range.

Place bullLevel just above the upper edge of the current HVN, at the start of an
upper void. Place bearLevel just below the lower edge, at the start of a lower
void. The levels should straddle the POC. You MAY place a level outside a void
where other evidence supports a higher breakout probability — say so in the
rationale when you do.

Required output:
{
  "decision": "PLAN",
  "bullLevel": number,
  "bearLevel": number,
  "rationale": string,
  "confidence": number (0..1)
}

Hard constraints:
- bullLevel > current_price
- bearLevel < current_price
- (bullLevel - bearLevel) >= 1.5 x ATR

Be quantitative in rationale — cite actual numbers from the context.
Return JSON only. No markdown fences, no commentary outside the JSON object.`;

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const line = (label, v, suffix = '') => (v === null ? null : `${label}: ${v}${suffix}`);

// Recursively sanitise an object/array, dropping non-finite numbers and null/undefined values.
// Uses a WeakSet scoped to the current recursion PATH (not the whole traversal) to guard
// against circular references: a node is added before recursing into it and removed again
// on unwind, so only a true ancestor (an object that contains itself) counts as a cycle. A
// DAG — the same object reachable via two different keys/branches — is not an ancestor of
// itself on either branch and must be preserved in full on both.
function sanitiseDepth(val, visited = new WeakSet()) {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : undefined;
  }
  if (Array.isArray(val)) {
    // Guard against circular array references (this array is its own ancestor)
    if (visited.has(val)) return undefined;
    visited.add(val);
    // Filter array: drop nulls, undefined, non-finite numbers; keep only usable values
    const filtered = val
      .map(item => sanitiseDepth(item, visited))
      .filter(item => item !== undefined);
    visited.delete(val); // unwind: this array is no longer on the active path
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof val === 'object') {
    // Guard against circular object references (this object is its own ancestor)
    if (visited.has(val)) return undefined;
    visited.add(val);
    // Recursively sanitise object entries
    const sanitised = {};
    for (const [key, v] of Object.entries(val)) {
      const sanitised_val = sanitiseDepth(v, visited);
      if (sanitised_val !== undefined) {
        sanitised[key] = sanitised_val;
      }
    }
    visited.delete(val); // unwind: this object is no longer on the active path
    return Object.keys(sanitised).length > 0 ? sanitised : undefined;
  }
  return val; // strings, booleans, etc. pass through
}

function marketSection(c) {
  const p = c.profile || {};
  const out = [
    line('Current price', n(c.currentPrice)),
    line('ATR', n(c.atr)),
    line('Tick size', n(c.tickSize)),
    line('POC', n(p.poc)),
    line('VAH', n(p.vah)),
    line('VAL', n(p.val)),
    line('CVD', n(c.cvd)),
    line('Funding rate', n(c.fundingRate)),
    line('Open interest change', n(c.openInterestChangePct), '%'),
  ].filter(Boolean);

  const voids = Array.isArray(p.rangeVoids) ? p.rangeVoids : [];
  const validVoids = voids.filter(v =>
    typeof v === 'object' && v !== null &&
    typeof v.priceLow === 'number' && Number.isFinite(v.priceLow) &&
    typeof v.priceHigh === 'number' && Number.isFinite(v.priceHigh)
  );
  if (validVoids.length) {
    out.push(`Volume voids (rangeVoids): ${validVoids.map(v => `${v.priceLow}-${v.priceHigh}`).join(', ')}`);
  }

  const hvns = Array.isArray(p.hvns) ? p.hvns : [];
  const validHvns = hvns.filter(v =>
    typeof v === 'object' && v !== null &&
    typeof v.priceLow === 'number' && Number.isFinite(v.priceLow) &&
    typeof v.priceHigh === 'number' && Number.isFinite(v.priceHigh)
  );
  if (validHvns.length) {
    out.push(`High volume nodes: ${validHvns.map(v => `${v.priceLow}-${v.priceHigh}`).join(', ')}`);
  }

  if (c.voidPair && n(c.voidPair.bullLevel) !== null && n(c.voidPair.bearLevel) !== null) {
    out.push(`Straddling void pair (mechanical fallback): bull ${c.voidPair.bullLevel} / bear ${c.voidPair.bearLevel}`);
  }

  if (c.depth) {
    const sanitised = sanitiseDepth(c.depth);
    if (sanitised !== undefined) {
      const depthStr = JSON.stringify(sanitised);
      if (depthStr !== '{}') {
        out.push(`Orderbook: ${depthStr}`);
      }
    }
  }

  if (typeof c.note === 'string' && c.note.trim()) out.push(`Note: ${c.note.trim()}`);
  return out;
}

export function buildPlanUserMessage(context) {
  const c = context || {};
  return [
    'CONTEXT: PLAN',
    '',
    `Symbol: ${c.symbol ?? 'UNKNOWN'}`,
    ...marketSection(c),
    '',
    'Emit bullLevel and bearLevel for the next cycle. JSON only.',
  ].join('\n');
}

export function buildAskUserMessage(context, question) {
  const c = context || {};
  return [
    'CONTEXT: ASK',
    '',
    `Symbol: ${c.symbol ?? 'UNKNOWN'}`,
    ...marketSection(c),
    '',
    'The user is asking about the current levels. Answer with the same PLAN JSON',
    'shape, proposing levels you would set now. A position may be open — say so',
    'in the rationale if your proposal would trigger immediately.',
    '',
    `User question: ${question ?? ''}`,
  ].join('\n');
}
