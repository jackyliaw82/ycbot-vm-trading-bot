// Pure volume-profile → grid geometry. No I/O; unit-tested via node:test.

// Nearest LVN above VAH and below VAL, returned as bin midpoints (or null if none).
export function pickBoundaryLVNs(lvns, vah, val) {
  const above = (lvns || [])
    .filter(l => l.priceLow > vah)
    .sort((a, b) => a.priceLow - b.priceLow);
  const below = (lvns || [])
    .filter(l => l.priceHigh < val)
    .sort((a, b) => b.priceHigh - a.priceHigh);
  const mid = (l) => (l.priceLow + l.priceHigh) / 2;
  return {
    upperLVN: above.length ? mid(above[0]) : null,
    lowerLVN: below.length ? mid(below[0]) : null,
  };
}

// Build EMPTY grid legs from a fixed anchor + boundaries (used by computeGridSetup and RANGE resume).
export function buildGridLines(anchor, upperBoundary, lowerBoundary, gridLevelsPerSide) {
  const N = gridLevelsPerSide;
  const step = (upperBoundary - lowerBoundary) / (2 * N);
  const legs = [];
  for (let k = 1; k <= N; k++) {
    legs.push({ levelIndex: k, direction: 'SHORT', price: anchor + k * step, state: 'EMPTY', quantity: null });
    legs.push({ levelIndex: k, direction: 'LONG',  price: anchor - k * step, state: 'EMPTY', quantity: null });
  }
  return legs;
}

// Build the fixed grid geometry for a RANGE cycle.
export function computeGridSetup({ vah, val, lvns, currentPrice, gridLevelsPerSide, minStepPct, maxWidthPct }) {
  const N = gridLevelsPerSide;
  const anchor = (vah + val) / 2;
  const { upperLVN, lowerLVN } = pickBoundaryLVNs(lvns, vah, val);

  const h0 = (vah - val) / 2;                       // half-width at VAH/VAL
  const hNeeded = N * minStepPct * anchor;          // half-width so step == minStepPct*anchor
  const hCapLVN = Math.min(
    upperLVN != null ? upperLVN - anchor : Infinity,
    lowerLVN != null ? anchor - lowerLVN : Infinity,
  );
  const hCapMax = maxWidthPct * anchor;

  // Widen ONLY when the natural VAH/VAL step is too tight. The LVN and maxWidth
  // caps bound the widening target — they must NOT shrink a naturally-wide value area.
  const h = Math.max(h0, Math.min(hNeeded, hCapLVN, hCapMax));
  const upperBoundary = anchor + h;
  const lowerBoundary = anchor - h;
  const step = h / N;
  const stepPct = step / anchor;
  const priceInside = currentPrice >= lowerBoundary && currentPrice <= upperBoundary;
  const viable = stepPct >= minStepPct - 1e-12 && h > 0 && priceInside;

  const gridLines = buildGridLines(anchor, upperBoundary, lowerBoundary, N);

  return { viable, anchor, upperBoundary, lowerBoundary, upperLVN, lowerLVN, stepPct, priceInside, gridLines };
}
