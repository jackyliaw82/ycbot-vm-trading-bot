import nodeFetch from 'node-fetch';

/**
 * The Binance proxy envelope — the ONE place that knows how to talk to the
 * shared vm-proxy Cloud Function.
 *
 * Extracted from TradingBase.makeProxyRequest so callers that have no strategy
 * instance can use it: the pre-start `/breakout/market-snapshot` route builds
 * volume-profile and market-metrics readings for the config view's chart, and
 * `VolumeProfile` / `MarketMetrics` reach the network through nothing but
 * `strategy.makeProxyRequest`. Copying the envelope for that route would have
 * been a second source of truth for the request shape, and the copy nobody
 * exercises daily is the one that goes stale — the same reasoning that keeps
 * `heldSide` and `bullBreakout` derived rather than stored.
 *
 * `ctx` carries only what the request needs:
 *   profileId             — X-User-Id header; selects the caller's Binance keys
 *   sharedVmProxyGcfUrl   — the shared proxy the VM POSTs to
 *   gcfProxyUrl           — the caller's own per-profile Binance proxy
 *   onTestnet?(bool)      — called ONLY when the response carries the header
 *   log?(msg)             — awaited, for API errors only
 *   fetch?               — HTTP client override; tests only
 */
export async function proxyRequest(ctx, endpoint, method = 'GET', params = {}, signed = false, apiType = 'futures') {
  // node-fetch, NOT the global. trading-base.js has always shadowed the global
  // with this import, and moving the live order path onto undici is not a
  // change a display-only feature gets to make as a side effect.
  const doFetch = ctx.fetch ?? nodeFetch;
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-User-Id': ctx.profileId,
    };

    const response = await doFetch(ctx.sharedVmProxyGcfUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        endpoint,
        method,
        params,
        signed,
        apiType,
        profileBinanceApiGcfUrl: ctx.gcfProxyUrl,
      }),
    });

    // A MISSING header leaves the caller's flag untouched. Reporting `false`
    // for an absent header would assert mainnet on a path that simply does not
    // say — "unknown" must never read as an answer.
    const testnetHeader = response.headers.get('X-Binance-Testnet');
    if (testnetHeader !== null) {
      ctx.onTestnet?.(testnetHeader === 'true');
    }

    if (!response.ok) {
      let errorDetails = `Proxy Error: ${response.status} - ${response.statusText}`;
      let binanceErrorCode = null;
      let binanceErrorMessage = null;

      try {
        const errorData = await response.json();
        if (errorData && errorData.code && errorData.msg) {
          binanceErrorCode = errorData.code;
          binanceErrorMessage = errorData.msg;
          errorDetails = `Binance API Error: ${binanceErrorCode} - ${binanceErrorMessage}`;
        } else if (errorData && errorData.error) {
          errorDetails = `Proxy Error: ${response.status} - ${errorData.error}`;
        }
      } catch (parseError) {
        console.error('Failed to parse error response from Binance:', parseError);
      }

      await ctx.log?.(`ERROR: [API_ERROR] ${errorDetails}`);
      const err = new Error(errorDetails);
      err.binanceErrorCode = binanceErrorCode;
      err.binanceErrorMessage = binanceErrorMessage;
      throw err;
    }

    return await response.json();
  } catch (error) {
    console.error('Proxy request failed:', error);
    throw error;
  }
}
