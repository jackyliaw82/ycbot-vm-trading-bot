import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { proxyRequest } from '../proxy-request.js';

// Minimal fetch stub. Returns a Response-shaped object with just the surface
// proxyRequest touches: ok / status / statusText / headers.get / json().
function stubFetch({ ok = true, status = 200, statusText = 'OK', body = {}, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      statusText,
      headers: { get: (k) => (k in headers ? headers[k] : null) },
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

// The HTTP client is injected via ctx.fetch. proxy-request.js defaults to
// node-fetch (the client trading-base.js has always used), so stubbing the
// GLOBAL fetch here would sail straight past it and hit the network.
const base = {
  profileId: 'profile-1',
  sharedVmProxyGcfUrl: 'https://shared.example/proxy',
  gcfProxyUrl: 'https://per-user.example/binance',
};

let activeFetch = null;
const ctx = () => ({ ...base, fetch: (...args) => activeFetch(...args) });

async function withFetch(stub, run) {
  const previous = activeFetch;
  activeFetch = stub;
  try {
    return await run();
  } finally {
    activeFetch = previous;
  }
}

test('proxyRequest: POSTs to the shared proxy with the profile id header and the full envelope', async () => {
  const fetchStub = stubFetch({ body: { ok: true } });
  const out = await withFetch(fetchStub, () =>
    proxyRequest(ctx(), '/fapi/v1/klines', 'GET', { symbol: 'BTCUSDT' }, false, 'futures'));

  assert.deepEqual(out, { ok: true });
  assert.equal(fetchStub.calls.length, 1);
  const { url, init } = fetchStub.calls[0];
  assert.equal(url, 'https://shared.example/proxy');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-User-Id'], 'profile-1');
  assert.deepEqual(JSON.parse(init.body), {
    endpoint: '/fapi/v1/klines',
    method: 'GET',
    params: { symbol: 'BTCUSDT' },
    signed: false,
    apiType: 'futures',
    profileBinanceApiGcfUrl: 'https://per-user.example/binance',
  });
});

test('proxyRequest: defaults match TradingBase.makeProxyRequest (GET / {} / unsigned / futures)', async () => {
  const fetchStub = stubFetch();
  await withFetch(fetchStub, () => proxyRequest(ctx(), '/fapi/v1/exchangeInfo'));
  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(sent.method, 'GET');
  assert.deepEqual(sent.params, {});
  assert.equal(sent.signed, false);
  assert.equal(sent.apiType, 'futures');
});

test('proxyRequest: reports the testnet header through onTestnet, both ways', async () => {
  const seen = [];
  const onTestnet = (v) => seen.push(v);
  await withFetch(stubFetch({ headers: { 'X-Binance-Testnet': 'true' } }), () =>
    proxyRequest({ ...ctx(), onTestnet }, '/fapi/v1/ping'));
  await withFetch(stubFetch({ headers: { 'X-Binance-Testnet': 'false' } }), () =>
    proxyRequest({ ...ctx(), onTestnet }, '/fapi/v1/ping'));
  assert.deepEqual(seen, [true, false]);
});

test('proxyRequest: a MISSING testnet header leaves the flag untouched', async () => {
  // The header is absent on some proxy paths. Reporting `false` there would
  // silently flip a live-account strategy's flag to mainnet-vs-testnet wrong.
  let called = false;
  await withFetch(stubFetch(), () =>
    proxyRequest({ ...ctx(), onTestnet: () => { called = true; } }, '/fapi/v1/ping'));
  assert.equal(called, false);
});

test('proxyRequest: a Binance error payload surfaces code + message on the thrown error', async () => {
  await withFetch(
    stubFetch({ ok: false, status: 400, statusText: 'Bad Request', body: { code: -4164, msg: 'Order notional must be no smaller than 5' } }),
    async () => {
      await assert.rejects(
        () => proxyRequest(ctx(), '/fapi/v1/order', 'POST', {}, true),
        (err) => {
          assert.equal(err.binanceErrorCode, -4164);
          assert.equal(err.binanceErrorMessage, 'Order notional must be no smaller than 5');
          assert.match(err.message, /Binance API Error: -4164/);
          return true;
        },
      );
    },
  );
});

test('proxyRequest: a proxy-shaped error keeps the status line and leaves the binance fields null', async () => {
  await withFetch(
    stubFetch({ ok: false, status: 502, statusText: 'Bad Gateway', body: { error: 'upstream unavailable' } }),
    async () => {
      await assert.rejects(
        () => proxyRequest(ctx(), '/fapi/v1/klines'),
        (err) => {
          assert.equal(err.binanceErrorCode, null);
          assert.equal(err.binanceErrorMessage, null);
          assert.match(err.message, /Proxy Error: 502 - upstream unavailable/);
          return true;
        },
      );
    },
  );
});

test('proxyRequest: an unparseable error body still throws with the status line', async () => {
  const unparseable = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: { get: () => null },
    json: async () => { throw new Error('not json'); },
  });
  await withFetch(unparseable, async () => {
    await assert.rejects(
      () => proxyRequest(ctx(), '/fapi/v1/klines'),
      /Proxy Error: 500 - Internal Server Error/,
    );
  });
});

test('proxyRequest: awaits ctx.log for an API error, and never logs on success', async () => {
  const logged = [];
  const log = async (m) => { logged.push(m); };

  await withFetch(stubFetch(), () => proxyRequest({ ...ctx(), log }, '/fapi/v1/ping'));
  assert.deepEqual(logged, []);

  await withFetch(stubFetch({ ok: false, status: 418, statusText: 'Teapot', body: {} }), async () => {
    await assert.rejects(() => proxyRequest({ ...ctx(), log }, '/fapi/v1/ping'));
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^ERROR: \[API_ERROR\] Proxy Error: 418/);
});

test('proxyRequest: works with no onTestnet and no log callback at all', async () => {
  // The market-snapshot shim passes neither. A bare ctx must not throw.
  const out = await withFetch(stubFetch({ headers: { 'X-Binance-Testnet': 'true' }, body: { v: 1 } }), () =>
    proxyRequest(ctx(), '/fapi/v1/ping'));  // ctx() carries no onTestnet and no log
  assert.deepEqual(out, { v: 1 });

  await withFetch(stubFetch({ ok: false, status: 400, statusText: 'Bad Request', body: {} }), async () => {
    await assert.rejects(() => proxyRequest(ctx(), '/fapi/v1/ping'), /Proxy Error: 400/);
  });
});

// ——— Single implementation ————————————————————————————————————————————
// The whole point of the extraction: TradingBase must DELEGATE, not keep a
// second copy. Two copies of the proxy envelope drift, and the copy the
// pre-start snapshot route uses would be the one nobody notices going stale.

test('trading-base delegates to proxy-request instead of re-implementing the envelope', async () => {
  const src = await readFile(new URL('../trading-base.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/proxy-request\.js'/, 'trading-base must import proxy-request.js');
  assert.match(src, /proxyRequest\(/, 'makeProxyRequest must call through to proxyRequest');
  assert.doesNotMatch(src, /profileBinanceApiGcfUrl:/, 'the proxy envelope must exist in exactly one place');
});
