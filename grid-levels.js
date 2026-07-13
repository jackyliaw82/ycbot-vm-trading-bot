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

  const h = Math.min(Math.max(h0, hNeeded), hCapLVN, hCapMax);
  const upperBoundary = anchor + h;
  const lowerBoundary = anchor - h;
  const step = h / N;
  const stepPct = step / anchor;
  const viable = stepPct >= minStepPct - 1e-12 && h > 0;

  const gridLines = [];
  for (let k = 1; k <= N; k++) {
    gridLines.push({ levelIndex: k, direction: 'SHORT', price: anchor + k * step, state: 'EMPTY', quantity: null });
    gridLines.push({ levelIndex: k, direction: 'LONG',  price: anchor - k * step, state: 'EMPTY', quantity: null });
  }

  return { viable, anchor, upperBoundary, lowerBoundary, upperLVN, lowerLVN, stepPct, gridLines };
}
