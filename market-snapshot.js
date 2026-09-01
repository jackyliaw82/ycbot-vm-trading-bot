import { VolumeProfile } from './volume-profile.js';
import { MarketMetrics } from './market-metrics.js';
import { proxyRequest } from './proxy-request.js';

/**
 * Pre-start market snapshot — the display-only readings the config view's
 * chart and Market Microstructure panel need BEFORE a strategy exists.
 *
 * The running view gets these five fields from `getStatus()`, refreshed by
 * BreakoutStrategy._refreshVolumeSnapshot on a 5-minute cadence. Pre-start
 * there is no strategy to hang that off, so this module owns one long-lived
 * VolumeProfile + MarketMetrics pair and serves the same five fields from the
 * same code. Recomputing volume profile or balance in the frontend instead
 * would have put a second implementation of the maths on the other side of the
 * network, and the two would read differently for the same symbol depending on
 * whether the strategy happened to be running.
 *
 * `VolumeProfile` and `MarketMetrics` reach the network through exactly two
 * members of the object handed to their constructor — `makeProxyRequest` and
 * `currentPrice` — so the shim below is the whole coupling.
 *
 * Cost: both classes cache internally (VP TTL 10min, candles 5min, depth), and
 * the route-level throttle short-circuits ahead of even the CPU. On the
 * frontend's 60s poll this is close to free.
 */

// Route-level throttle. Deliberately shorter than the frontend's 60s poll so a
// scheduled poll is never served a stale-by-a-whole-cycle reading; it exists to
// absorb bursts — a refocus racing the timer, or two devices on the config page.
export const SNAPSHOT_THROTTLE_MS = 20 * 1000;

const REQUIRED_CREDS = ['profileId', 'gcfProxyUrl', 'sharedVmProxyGcfUrl'];

/**
 * @param volumeProfile   anything with get24h(symbol) / getBalance(symbol)
 * @param marketMetrics   anything with getCvd / getOrderbookDepth / getVolatility
 * @param bindCreds       applies the caller's proxy credentials before fetching
 * @param throttleMs      re-serve window, per symbol
 * @param now             clock injection point
 */
export function createMarketSnapshotProvider({
  volumeProfile,
  marketMetrics,
  bindCreds = null,
  throttleMs = SNAPSHOT_THROTTLE_MS,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();    // symbol -> { snapshot, at }
  const inFlight = new Map(); // symbol -> Promise<snapshot>

  // Per-metric catch, exactly as _refreshVolumeSnapshot does it: one dead
  // endpoint must not blank the other four cells. Unlike the running view
  // there is no previous snapshot to keep, so a failure reads as null — which
  // the panel already renders as its "Awaiting…" state.
  const settle = async (label, fetch) => {
    try {
      return (await fetch()) ?? null;
    } catch (e) {
      console.error(`[market-snapshot] ${label} failed: ${e.message}`);
      return null;
    }
  };

  async function build(symbol) {
    const [volumeProfile24h, balance, cvd, orderbookDepth, volatility] = await Promise.all([
      settle('volume profile', () => volumeProfile.get24h(symbol)),
      settle('balance metrics', () => volumeProfile.getBalance(symbol)),
      settle('cvd', () => marketMetrics.getCvd(symbol)),
      settle('orderbook depth', () => marketMetrics.getOrderbookDepth(symbol)),
      settle('atr', () => marketMetrics.getVolatility(symbol)),
    ]);
    return { symbol, volumeProfile24h, balance, cvd, orderbookDepth, volatility, at: now() };
  }

  return {
    /**
     * Rejects rather than returning an empty snapshot on bad input: a snapshot
     * of nulls from a missing proxy URL is indistinguishable from a genuinely
     * quiet market, and "unknown" must never read as an answer.
     */
    async get(symbol, creds) {
      if (!symbol || typeof symbol !== 'string') {
        throw new Error('symbol is required');
      }
      const missing = REQUIRED_CREDS.filter((k) => !creds || !creds[k]);
      if (missing.length) {
        throw new Error(`missing proxy credentials: ${missing.join(', ')}`);
      }

      const key = symbol.toUpperCase();

      const cached = cache.get(key);
      if (cached && (now() - cached.at) < throttleMs) return cached.snapshot;

      // Collapse concurrent callers onto one fetch rather than multiplying the
      // Binance weight by however many tabs are open.
      const pending = inFlight.get(key);
      if (pending) return pending;

      bindCreds?.(creds);

      const p = build(key)
        .then((snapshot) => {
          cache.set(key, { snapshot, at: snapshot.at });
          return snapshot;
        })
        .finally(() => { inFlight.delete(key); });

      inFlight.set(key, p);
      return p;
    },
  };
}

// ——— The VM's singleton ————————————————————————————————————————————————
// One instance for the process, so the VolumeProfile / MarketMetrics caches
// survive across requests. The shim's credentials are rebound per call: a VM
// serves exactly one owner (requireVmOwner gates the route), so every caller
// supplies the same three values.

const shim = {
  profileId: null,
  gcfProxyUrl: null,
  sharedVmProxyGcfUrl: null,
  // MarketMetrics.getVolatility reads this for the ATR percentage denominator.
  // Left null on purpose: computeATR falls back to the last close, which costs
  // nothing, where fetching a mark price here would add a request per refresh
  // for a second-decimal difference in a display-only cell.
  currentPrice: null,
  makeProxyRequest(endpoint, method = 'GET', params = {}, signed = false, apiType = 'futures') {
    return proxyRequest(this, endpoint, method, params, signed, apiType);
  },
};

export const marketSnapshot = createMarketSnapshotProvider({
  volumeProfile: new VolumeProfile(shim),
  marketMetrics: new MarketMetrics(shim),
  bindCreds: ({ profileId, gcfProxyUrl, sharedVmProxyGcfUrl }) => {
    shim.profileId = profileId;
    shim.gcfProxyUrl = gcfProxyUrl;
    shim.sharedVmProxyGcfUrl = sharedVmProxyGcfUrl;
  },
});
