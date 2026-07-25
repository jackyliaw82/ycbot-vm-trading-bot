/**
 * Server-side gate for an optional Start Mode trigger on `/anchor-ladder/start`.
 *
 * Extracted out of the Express handler (mirrors http-auth.js's
 * createRequireVmOwner / billing-gate.js's checkBillingGate — this codebase's
 * established pattern for route logic that must be independently unit-testable).
 * `app.js` as a whole opens a real Firestore client and hits GCP instance
 * metadata at import time (see its top-level `VM_OWNER_UID = await
 * resolveVmOwnerUid();`, which calls fetchInstanceName()), so it cannot be
 * exercised via `node:test` the way a plain module can — the fix
 * for that, every time it has come up in this codebase, is to pull the
 * testable logic into its own side-effect-free file rather than importing
 * app.js in a test. Importing THIS file (or anchor-ladder-strategy.js, which
 * it depends on) has no such side effects — no client is created and no
 * network call happens until a function here is actually invoked.
 *
 * Absent / null / '' `stp` (Immediate mode) short-circuits immediately and
 * touches NO network — `makeStrategy` is never even called, so Immediate mode
 * pays zero extra latency, matching what the route requires.
 *
 * With a price: validates shape, warms the exchange-info/precision cache
 * (this route otherwise never calls it, so a freshly restarted VM's first
 * trigger start for a symbol would validate against an unrounded, 2-decimal
 * fallback price — message quality only, but a wrong-looking number in a
 * rejection is exactly what makes a user distrust the gate), fetches a
 * reference price, then runs `validateStartTrigger` — the SAME pure
 * validator `AnchorLadderStrategy.start()` calls as its own authoritative
 * backstop, so the route and start() can never silently re-diverge on what
 * counts as a valid trigger.
 *
 * Returns:
 *   { ok: true, strategy: null }      — Immediate mode, nothing to validate.
 *   { ok: true, strategy }            — validated; `strategy` already has
 *                                        `symbol` set and its exchange-info /
 *                                        precision cache warmed, ready to be
 *                                        reused for the real start instead of
 *                                        building (and reference-price-fetching)
 *                                        a second instance.
 *   { ok: false, status, body }       — the exact Express response to send;
 *                                        always 400 (bad shape, too close to
 *                                        the reference, or the reference price
 *                                        itself could not be fetched/verified —
 *                                        never a 500 for a validation failure).
 *
 * @param {number|string|null|undefined} stp  Raw `config.startTriggerPrice`.
 * @param {{gcpProxyUrl: string, profileId: string, sharedVmProxyGcfUrl: string, symbol: string}} opts
 * @param {(gcpProxyUrl: string, profileId: string, sharedVmProxyGcfUrl: string) => object} [makeStrategy]
 *   Strategy constructor, injectable for tests (default: a real
 *   AnchorLadderStrategy). Only ever called when a trigger price is present.
 */
import { AnchorLadderStrategy, validateStartTrigger } from './anchor-ladder-strategy.js';

export async function resolveStartTrigger(
  stp,
  { gcpProxyUrl, profileId, sharedVmProxyGcfUrl, symbol },
  makeStrategy = (...args) => new AnchorLadderStrategy(...args),
) {
  if (stp == null || stp === '') {
    return { ok: true, strategy: null };
  }

  // Cheap shape check first — no network call for obviously bad input (a
  // string, 0, negative, Infinity). Also what stops garbage from reaching a
  // wasted reference-price fetch below.
  const numeric = Number(stp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Start trigger price must be a positive number.', code: 'START_TRIGGER_INVALID' },
    };
  }

  const strategy = makeStrategy(gcpProxyUrl, profileId, sharedVmProxyGcfUrl);
  strategy.symbol = symbol || 'BTCUSDT';

  let ref;
  try {
    await strategy._getExchangeInfo(strategy.symbol);
    ref = await strategy._fetchReferencePrice();
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: { error: `Could not validate the start trigger price: ${err.message}`, code: 'START_TRIGGER_UNVERIFIABLE' },
    };
  }

  const check = validateStartTrigger(stp, ref, strategy.symbol);
  if (!check.ok) {
    return { ok: false, status: 400, body: { error: check.error, code: 'START_TRIGGER_INVALID' } };
  }

  return { ok: true, strategy };
}
