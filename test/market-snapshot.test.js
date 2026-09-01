import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMarketSnapshotProvider, SNAPSHOT_THROTTLE_MS } from '../market-snapshot.js';

const CREDS = {
  profileId: 'profile-1',
  gcfProxyUrl: 'https://per-user.example/binance',
  sharedVmProxyGcfUrl: 'https://shared.example/proxy',
};

// Counting fakes for the two collaborators. Each records its calls so the
// throttle assertions can prove work was SKIPPED, not merely repeated cheaply.
function fakes(overrides = {}) {
  const calls = { get24h: 0, getBalance: 0, getCvd: 0, getOrderbookDepth: 0, getVolatility: 0 };
  const wrap = (name, value) => async (symbol) => {
    calls[name]++;
    if (typeof overrides[name] === 'function') return overrides[name](symbol);
    return value;
  };
  return {
    calls,
    volumeProfile: {
      get24h: wrap('get24h', { poc: { price: 100, volume: 5 }, vah: 110, val: 90 }),
      getBalance: wrap('getBalance', { vaWidthPct: 2, vaWidthSeries: [2, 3], contraction: 0.7, volumeRatio: 0.9, regime: 'BALANCED_CONTRACTING', samples: 12 }),
    },
    marketMetrics: {
      getCvd: wrap('getCvd', { cvd: 123, cvdTrend: 'rising' }),
      getOrderbookDepth: wrap('getOrderbookDepth', { imbalance: 0.1 }),
      getVolatility: wrap('getVolatility', { atr: 5, atrPercent: 1.2, interpretation: 'normal' }),
    },
  };
}

const provider = (f, opts = {}) => createMarketSnapshotProvider({
  volumeProfile: f.volumeProfile,
  marketMetrics: f.marketMetrics,
  ...opts,
});

test('get: returns the same five display fields the running view gets from getStatus()', async () => {
  const f = fakes();
  const snap = await provider(f).get('BTCUSDT', CREDS);
  assert.deepEqual(Object.keys(snap).sort(), ['at', 'balance', 'cvd', 'orderbookDepth', 'symbol', 'volatility', 'volumeProfile24h']);
  assert.equal(snap.symbol, 'BTCUSDT');
  assert.equal(snap.volumeProfile24h.poc.price, 100);
  assert.equal(snap.balance.regime, 'BALANCED_CONTRACTING');
  assert.equal(snap.cvd.cvd, 123);
  assert.equal(snap.orderbookDepth.imbalance, 0.1);
  assert.equal(snap.volatility.atr, 5);
});

test('get: uppercases the symbol before it reaches the fetchers', async () => {
  const seen = [];
  const f = fakes({ get24h: (s) => { seen.push(s); return null; } });
  const snap = await provider(f).get('btcusdt', CREDS);
  assert.equal(snap.symbol, 'BTCUSDT');
  assert.deepEqual(seen, ['BTCUSDT']);
});

test('get: one dead fetcher must not blank the other four', async () => {
  // Mirrors _refreshVolumeSnapshot's per-metric catch. A display panel with one
  // hole beats a panel with five.
  const f = fakes({ getCvd: () => { throw new Error('binance 418'); } });
  const snap = await provider(f).get('BTCUSDT', CREDS);
  assert.equal(snap.cvd, null);
  assert.ok(snap.volumeProfile24h);
  assert.ok(snap.balance);
  assert.ok(snap.orderbookDepth);
  assert.ok(snap.volatility);
});

test('get: every fetcher failing yields a snapshot of nulls, not a rejection', async () => {
  const boom = () => { throw new Error('down'); };
  const f = fakes({ get24h: boom, getBalance: boom, getCvd: boom, getOrderbookDepth: boom, getVolatility: boom });
  const snap = await provider(f).get('BTCUSDT', CREDS);
  assert.equal(snap.volumeProfile24h, null);
  assert.equal(snap.balance, null);
  assert.equal(snap.cvd, null);
  assert.equal(snap.orderbookDepth, null);
  assert.equal(snap.volatility, null);
});

test('get: a second call inside the throttle window re-serves the cached snapshot without re-fetching', async () => {
  const f = fakes();
  let t = 1_000_000;
  const p = provider(f, { now: () => t, throttleMs: 20_000 });

  const first = await p.get('BTCUSDT', CREDS);
  t += 19_999;
  const second = await p.get('BTCUSDT', CREDS);

  assert.equal(f.calls.get24h, 1, 'the second call must not re-fetch');
  assert.equal(f.calls.getOrderbookDepth, 1);
  assert.equal(second.at, first.at, 'a throttled read carries the original timestamp, not "now"');
});

test('get: past the throttle window it refetches', async () => {
  const f = fakes();
  let t = 1_000_000;
  const p = provider(f, { now: () => t, throttleMs: 20_000 });

  await p.get('BTCUSDT', CREDS);
  t += 20_001;
  await p.get('BTCUSDT', CREDS);

  assert.equal(f.calls.get24h, 2);
});

test('get: the throttle is PER SYMBOL — switching pairs in the config dropdown must not serve the old pair', async () => {
  const f = fakes();
  let t = 1_000_000;
  const p = provider(f, { now: () => t, throttleMs: 20_000 });

  const btc = await p.get('BTCUSDT', CREDS);
  const eth = await p.get('ETHUSDT', CREDS);

  assert.equal(f.calls.get24h, 2);
  assert.equal(btc.symbol, 'BTCUSDT');
  assert.equal(eth.symbol, 'ETHUSDT');
});

test('get: concurrent calls for the same symbol share ONE in-flight fetch', async () => {
  // A config page mounted on two devices, or a refocus racing the 60s poll,
  // must not multiply the Binance weight.
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fakes({ get24h: async () => { await gate; return { poc: { price: 1, volume: 1 }, vah: 2, val: 0 }; } });
  const p = provider(f);

  const both = Promise.all([p.get('BTCUSDT', CREDS), p.get('BTCUSDT', CREDS)]);
  release();
  const [a, b] = await both;

  assert.equal(f.calls.get24h, 1);
  assert.equal(a.at, b.at);
});

test('get: binds the caller credentials before fetching', async () => {
  const bound = [];
  const f = fakes();
  const p = provider(f, { bindCreds: (c) => bound.push(c) });
  await p.get('BTCUSDT', CREDS);
  assert.deepEqual(bound, [CREDS]);
});

test('get: refuses a missing symbol rather than fetching a snapshot of nothing', async () => {
  const f = fakes();
  await assert.rejects(() => provider(f).get('', CREDS), /symbol/i);
  await assert.rejects(() => provider(f).get(null, CREDS), /symbol/i);
  assert.equal(f.calls.get24h, 0);
});

test('get: refuses incomplete credentials loudly instead of returning an empty snapshot', async () => {
  // Fail LOUDLY. A snapshot of nulls from a bad proxy URL is indistinguishable
  // from a genuinely quiet market — "unknown" must never read as an answer.
  const f = fakes();
  for (const missing of ['profileId', 'gcfProxyUrl', 'sharedVmProxyGcfUrl']) {
    const creds = { ...CREDS };
    delete creds[missing];
    await assert.rejects(() => provider(f).get('BTCUSDT', creds), new RegExp(missing));
  }
  assert.equal(f.calls.get24h, 0);
});

test('SNAPSHOT_THROTTLE_MS is well under the frontend 60s poll, so a poll is never starved', () => {
  assert.ok(SNAPSHOT_THROTTLE_MS > 0);
  assert.ok(SNAPSHOT_THROTTLE_MS < 60_000);
});

// ——— Route wiring (asserted against SOURCE TEXT) ————————————————————————
// Importing app.js boots a real express listener plus a 12x15s VM-owner retry
// loop and hangs the suite forever. Assert against its source instead.

test('app.js exposes the market-snapshot route behind requireVmOwner', async () => {
  const src = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const route = src.match(/app\.post\('\/breakout\/market-snapshot'[\s\S]{0,2000}?\n\}\);/);
  assert.ok(route, 'the /breakout/market-snapshot route must exist');
  assert.match(route[0], /requireVmOwner/, 'an unauthenticated route would spend the owner Binance weight for anyone');
  assert.match(route[0], /marketSnapshot/, 'the route must delegate to the shared provider');
});

test('app.js does not re-implement the snapshot fetchers inline', async () => {
  const src = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const route = src.match(/app\.post\('\/breakout\/market-snapshot'[\s\S]{0,2000}?\n\}\);/);
  assert.doesNotMatch(route[0], /computeVolumeProfile|computeBalance/, 'the maths belongs to the shared modules');
});
