// Exchange cost constants. Extracted from ai-risk-guard.js so the fee math
// outlives the AI stack — it is load-bearing in the ladder step floor and the
// Final-TP closing-fee estimate.

// Per SIDE. 0.05% Binance futures taker + 0.03% slippage buffer.
// A round trip is 2x this.
export const FEE_RATE = 0.0008;
