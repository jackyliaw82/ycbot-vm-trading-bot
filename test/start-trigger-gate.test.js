import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStartTrigger } from '../start-trigger-gate.js';

// The route (`app.js`'s `/anchor-ladder/start`) cannot be exercised via
// node:test — importing app.js opens a real Firestore client and hits GCP
// instance metadata at import time. resolveStartTrigger is the extracted,
// side-effect-free seam that owns everything the route needs to decide
// before it registers/starts anything, so this is the closest honest surface
// to the route gate itself (mirrors http-auth.test.js's approach for the
// same class of problem).

const OPTS = { gcpProxyUrl: 'http://proxy.invalid', profileId: 'p', sharedVmProxyGcfUrl: 'http://vm.invalid', symbol: 'BTCUSDT' };

function fakeStrategy({ ref = 100, exchangeInfoFails = false, referenceFails = false } = {}) {
  const calls = { getExchangeInfo: 0, fetchReferencePrice: 0, start: 0 };
  return {
    calls,
    symbol: null,
    async _getExchangeInfo() {
      calls.getExchangeInfo++;
      if (exchangeInfoFails) throw new Error('exchangeInfo unreachable');
    },
    async _fetchReferencePrice() {
      calls.fetchReferencePrice++;
      if (referenceFails) throw new Error('Could not read a reference price from Binance to validate the start trigger.');
      return ref;
    },
    // resolveStartTrigger only VALIDATES — it must never call start() itself,
    // that is the route's job, and only after this returns ok.
    async start() { calls.start++; },
  };
}

test('resolveStartTrigger: Immediate mode (no trigger) never constructs a strategy or touches the network', async () => {
  let factoryCalled = false;
  const makeStrategy = () => { factoryCalled = true; return fakeStrategy(); };
  const result = await resolveStartTrigger(null, OPTS, makeStrategy);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, null);
  assert.equal(factoryCalled, false, 'Immediate mode must pay zero extra latency — no strategy, no reference-price fetch');
});

test('resolveStartTrigger: an empty-string trigger is Immediate mode too', async () => {
  let factoryCalled = false;
  const result = await resolveStartTrigger('', OPTS, () => { factoryCalled = true; return fakeStrategy(); });
  assert.equal(result.ok, true);
  assert.equal(result.strategy, null);
  assert.equal(factoryCalled, false);
});

test('resolveStartTrigger: a too-close trigger yields 400 before any strategy is started', async () => {
  const s = fakeStrategy({ ref: 100 }); // 100.05 is inside the 0.1% band around 100
  const result = await resolveStartTrigger(100.05, OPTS, () => s);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'START_TRIGGER_INVALID');
  assert.match(result.body.error, /0\.1%/);
  assert.equal(s.calls.start, 0, 'no strategy may be started off a rejected trigger');
});

test('resolveStartTrigger: a reference-price fetch failure maps to 400, not 500', async () => {
  const s = fakeStrategy({ referenceFails: true });
  const result = await resolveStartTrigger(110, OPTS, () => s);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'START_TRIGGER_UNVERIFIABLE');
  assert.match(result.body.error, /reference price/i);
  assert.equal(s.calls.start, 0);
});

test('resolveStartTrigger: an exchange-info warm-up failure ALSO maps to 400, not 500', async () => {
  const s = fakeStrategy({ exchangeInfoFails: true });
  const result = await resolveStartTrigger(110, OPTS, () => s);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'START_TRIGGER_UNVERIFIABLE');
});

test('resolveStartTrigger: a valid trigger warms exchange info, fetches the reference price, and returns the SAME strategy for reuse', async () => {
  const s = fakeStrategy({ ref: 100 });
  const result = await resolveStartTrigger(110, OPTS, () => s);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, s, 'the same instance must come back for the route to reuse, not a second one');
  assert.equal(s.symbol, 'BTCUSDT');
  assert.equal(s.calls.getExchangeInfo, 1, 'the precision cache must be warmed before validating');
  assert.equal(s.calls.fetchReferencePrice, 1);
  assert.equal(s.calls.start, 0, 'validating is not starting');
});

test('resolveStartTrigger: non-positive / non-finite triggers are all rejected, and none ever reach the strategy factory', async () => {
  let factoryCalls = 0;
  const makeStrategy = () => { factoryCalls++; return fakeStrategy(); };
  for (const bad of [0, -5, Infinity, NaN, 'not-a-number']) {
    const result = await resolveStartTrigger(bad, OPTS, makeStrategy);
    assert.equal(result.ok, false, `${bad} must be rejected`);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'START_TRIGGER_INVALID');
    assert.match(result.body.error, /positive number/);
  }
  assert.equal(factoryCalls, 0, 'shape-invalid input must never reach the strategy factory / network');
});
