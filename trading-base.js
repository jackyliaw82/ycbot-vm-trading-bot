import { Firestore, Timestamp } from '@google-cloud/firestore';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { precisionFormatter } from './precisionUtils.js';
import wsBroadcast from './ws-broadcast.js';

// Constants for WebSocket reconnection
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 25;

// Heartbeat constants
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;

// Stream-stall watchdog. Price streams (@markPrice@1s / @ticker) push ~1 msg/sec,
// so 15s of silence is a confident anomaly. The liquidation WS gets no stall
// watchdog — forceOrder is inherently sporadic for a single symbol; relying on
// ping/pong (every 30s with 10s pong timeout) is sufficient for stuck-stream
// detection without false-positive teardowns during quiet markets.
const STALE_TICK_THRESHOLD_MS = 15000;
const STALE_WATCHDOG_INTERVAL_MS = 5000;

// REST polling fallback for the price feed. If the watchdog terminates the price
// WS REST_FALLBACK_THRESHOLD times within REST_FALLBACK_WINDOW_MS, we treat
// the WS path as broken (Binance ban / network issue) and switch to polling
// /fapi/v1/premiumIndex via the GCF proxy (which has its own clean egress IP).
// Trading continues at degraded latency. While in fallback, a single long-lived
// monitor WS stays subscribed to the price stream — first qualifying message
// exits fallback. Reconnect uses exponential backoff capped at
// MONITOR_WS_MAX_RECONNECT_DELAY_MS so a throttled or down relay can't generate
// connect-storms. Heartbeat log every MONITOR_WS_HEARTBEAT_LOG_MS confirms
// the monitor is alive without flooding during multi-hour outages.
const REST_FALLBACK_THRESHOLD = 3;
const REST_FALLBACK_WINDOW_MS = 2 * 60 * 1000;
const REST_POLL_INTERVAL_MS = 1000;
const MONITOR_WS_INITIAL_RECONNECT_DELAY_MS = 5 * 1000;
const MONITOR_WS_MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
const MONITOR_WS_HEARTBEAT_LOG_MS = 10 * 60 * 1000;
// Slow background retry for the liquidation WS once the standard 25-attempt
// backoff stage gives up. Sporadic stream + non-blocking for execution → 5 min
// is a healthy cadence (vs. 60s for the price probe).
const LIQUIDATION_BACKGROUND_RETRY_INTERVAL_MS = 5 * 60 * 1000;

// Trade-record fallback. After each market order we wait this long for the
// user-data WS path to save the trade record itself. If the orderId hasn't
// been marked as handled by the WS path within the wait window, REST fallback
// fires GET /fapi/v1/userTrades to recover the actual fills (qty, price,
// commission, tradeId). The dedup window is the same value plus a margin so
// a slow WS event arriving after the fallback ran can't double-count.
const REST_FALLBACK_DELAY_MS = 3000;
const REST_FALLBACK_DEDUP_WINDOW_MS = 60_000;

// Default leverage
const DEFAULT_LEVERAGE = 50;

/**
 * TradingBase — shared infrastructure for all trading strategies.
 *
 * Provides:
 *  - Firestore connection & logging
 *  - Binance proxy request layer
 *  - Exchange info cache & precision utilities
 *  - WebSocket connections (real-time price + user data stream)
 *  - Order placement (market, limit, cancel)
 *  - Position detection (hedge mode aware)
 *  - Per-side PnL tracking from ORDER_TRADE_UPDATE
 *
 * Subclasses must implement:
 *  - handleRealtimePrice(price)   — called on every price tick
 *  - saveState()                  — persist strategy-specific state
 *  - loadState()                  — restore strategy-specific state
 */
class TradingBase {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    // Firestore
    this.firestore = new Firestore({
      ignoreUndefinedProperties: true,
      projectId: 'ycbot-6f336',
      databaseId: '(default)',
    });
    this.tradesCollectionRef = null;
    this.logsCollectionRef = null;
    this.strategyFlowCollectionRef = null;

    // Proxy URLs
    this.gcfProxyUrl = gcfProxyUrl;
    this.profileId = profileId;
    this.sharedVmProxyGcfUrl = sharedVmProxyGcfUrl;

    // Strategy identity
    this.strategyId = null;
    this.isRunning = false;
    this.isStopping = false;
    this.willBeDeleted = false;

    // WebSocket handles
    this.realtimeWs = null;
    this.userDataWs = null;
    this.liquidationWs = null;
    this.listenKey = null;
    this.listenKeyRefreshInterval = null;

    // Liquidation stream state (replaces deprecated /fapi/v1/allForceOrders REST)
    this._liqEvents = []; // rolling buffer: [{ side: 'SELL'|'BUY', notional, ts }]
    this._liqWsLastConnectedAt = null; // stale-data guard

    // Position tracking (primary — backward compatible)
    this.currentPosition = 'NONE';
    this.positionEntryPrice = null;
    this.positionSize = null;
    this.currentPositionQuantity = null;
    this.entryPositionQuantity = null;
    this.lastPositionQuantity = null;
    this.lastPositionEntryPrice = null;

    // Per-side position data (hedge mode)
    this._longEntryPrice = null;
    this._longPositionSize = null;
    this._shortEntryPrice = null;
    this._shortPositionSize = null;

    // Real-time price & PnL
    this.currentPrice = null;
    this.positionPnL = null;
    this.totalPnL = null;
    this.longPositionPnL = 0;
    this.shortPositionPnL = 0;

    // Accumulated PnL & fees
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;
    this.longAccumulatedRealizedPnL = 0;
    this.shortAccumulatedRealizedPnL = 0;
    this.longTradingFees = 0;
    this.shortTradingFees = 0;
    this.feeRate = 0.0005; // 0.05% taker fee

    // Symbol & config
    this.symbol = 'BTCUSDT';
    this.priceType = 'MARK'; // 'LAST' | 'MARK'
    this.isTestnet = null;

    // Exchange info cache
    this.exchangeInfoCache = {};

    // WebSocket connection statuses
    this.realtimeWsConnected = false;
    this.userDataWsConnected = false;
    this.liquidationWsConnected = false;

    // User-data WS health flag (separate from .Connected — flips on pong-driven
    // close events to gate L2 REST fallback. Default true so the initial open
    // doesn't fire a misleading "unhealthy → healthy" transition log.
    this._userDataWsHealthy = true;

    // Periodic L3 reconciliation: timestamp of the last full userTrades sweep.
    // Initialized null; first run covers strategy-start to now.
    this._lastReconciliationAt = null;

    // Reconnection state
    this.realtimeReconnectAttempts = 0;
    this.userDataReconnectAttempts = 0;
    this.liquidationReconnectAttempts = 0;
    this.listenKeyRetryAttempts = 0;
    this.realtimeReconnectTimeout = null;
    this.userDataReconnectTimeout = null;
    this.liquidationReconnectTimeout = null;
    this.isUserDataReconnecting = false;

    // Heartbeat timeouts/intervals
    this.realtimeWsPingTimeout = null;
    this.realtimeWsPingInterval = null;
    this.userDataWsPingTimeout = null;
    this.userDataWsPingInterval = null;
    this.liquidationWsPingTimeout = null;
    this.liquidationWsPingInterval = null;

    // Stream-stall watchdog state (price feed only; liquidation has no watchdog)
    this.realtimeWsStaleWatcher = null;
    this.lastRealtimeTickAt = 0;

    // REST polling fallback state for the price feed
    this.streamMode = 'WS'; // 'WS' | 'REST_FALLBACK'
    this._consecutiveStalls = 0;
    this._firstStallAt = null;
    this._restPollInterval = null;
    this._monitorWs = null;
    this._monitorWsReconnectAttempts = 0;
    this._monitorWsReconnectTimeout = null;
    this._monitorWsHeartbeatTimer = null;
    this._monitorWsPingInterval = null;
    this._monitorWsPongTimeout = null;
    this._monitorWsOpenedAt = 0;

    // Trade-record dedup. WS path (_handleOrderTradeUpdate) marks orderIds
    // it has saved trades for; REST fallback (_scheduleRestFallback) checks
    // this map before fetching/saving so the two paths never double-count.
    this._wsHandledOrderIds = new Map(); // orderId → timestamp
    this._restFallbackCount = 0;
    this._lastUserDataMessageAt = 0;

    // In-flight REST-fallback timers. Populated by _scheduleRestFallback,
    // removed when the timer fires. stop() iterates this to synchronously
    // recover any order whose deferred 5s timer hasn't fired yet — otherwise
    // the modal's Net PnL would understate fees of any add-trade placed in
    // the last 5s before the strategy stopped.
    this._pendingRestFallback = new Map(); // orderId → { symbol, positionSide }

    // Liquidation WS background retry — kicks in after the standard 25-attempt
    // backoff stage exhausts itself. Slow cadence; informational stream so we
    // don't need aggressive recovery, just eventual recovery.
    this._liquidationBackgroundRetry = null;

    // Diagnostic tracing (temporary — see plan: silent WS stall investigation)
    this._realtimeWsIdCounter = 0;
    this._userDataWsIdCounter = 0;
    this._liquidationWsIdCounter = 0;
    this._realtimeMessagesSeen = 0;
    this._userDataMessagesSeen = 0;
    this._liquidationMessagesSeen = 0;

    // User-data reconcile flag: set by attemptUserDataReconnection so the next
    // connectUserDataStream() open handler triggers a REST position sync.
    this._needsUserDataReconcileOnOpen = false;

    // Pending orders
    this.pendingOrders = new Map();
    this.savedTradeOrderIds = new Set();

    // WebSocket position update tracking
    this.lastPositionUpdateFromWebSocket = null;
    this.positionUpdatedViaWebSocket = false;

    // WebSocket health monitoring
    this.wsHealthCheckInterval = null;

    // Pending log message
    this._pendingLogMessage = null;

    // Bind methods
    this.connectRealtimeWebSocket = this.connectRealtimeWebSocket.bind(this);
    this.connectUserDataStream = this.connectUserDataStream.bind(this);
  }

  // ─── Logging ───────────────────────────────────────────────────────────────

  async addLog(message) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', {
      hour12: false,
      timeZone: 'Asia/Singapore',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const logPrefix = this.profileId ? `[${this.profileId.slice(-6)}] ` : '[STRATEGY] ';
    const logEntry = `${logPrefix}${timestamp}: ${message}`;
    console.log(logEntry);

    const messagesToFilter = [
      'WebSocket client connected for logs',
      'WebSocket client disconnected for logs'
    ];

    // Broadcast log to connected WebSocket clients
    if (this.strategyId) {
      wsBroadcast.pushLog(this.strategyId, logEntry, now.toISOString());
    }

    if (this.strategyId && !this.willBeDeleted && this.logsCollectionRef &&
        !messagesToFilter.some(filterMsg => message.includes(filterMsg))) {
      try {
        await this.logsCollectionRef.add({
          message: logEntry,
          timestamp: now,
        });
      } catch (error) {
        console.error('Failed to save log to Firestore:', error);
      }
    }
  }

  // ─── Firestore helpers ─────────────────────────────────────────────────────

  initFirestoreCollections(strategyId) {
    this.strategyId = strategyId;
    const strategyRef = this.firestore.collection('strategies').doc(strategyId);
    this.tradesCollectionRef = strategyRef.collection('trades');
    this.logsCollectionRef = strategyRef.collection('logs');
    this.strategyFlowCollectionRef = strategyRef.collection('strategyFlow');
  }

  async saveTrade(tradeDetails) {
    if (!this.tradesCollectionRef) {
      console.error('Cannot save trade: tradesCollectionRef is not initialized.');
      return;
    }
    try {
      const tradeData = {
        ...tradeDetails,
        timestamp: new Date(),
        strategyId: this.strategyId,
      };
      // Idempotent write: use Binance tradeId as the doc ID. Same fill saved
      // twice (e.g. VM restart triggering L3 reconciliation rediscovery) just
      // overwrites the existing doc instead of creating duplicates. Falls
      // back to add() only if tradeId is missing (defensive — should never
      // happen since all save paths pass tradeId).
      if (tradeDetails.tradeId !== undefined && tradeDetails.tradeId !== null) {
        await this.tradesCollectionRef.doc(String(tradeDetails.tradeId)).set(tradeData, { merge: true });
      } else {
        await this.tradesCollectionRef.add(tradeData);
      }

      // Broadcast trade to connected WebSocket clients
      wsBroadcast.pushTrade(this.strategyId, tradeData);
    } catch (error) {
      console.error(`Failed to save trade to Firestore: ${error.message}`);
    }
  }

  /**
   * Deferred REST fallback. The user-data WS path (_handleOrderTradeUpdate) is
   * primary — it carries exact commission and per-fill tradeId. This fallback
   * fires REST_FALLBACK_DELAY_MS after order placement; if the WS path has
   * already saved trades for this orderId, it does nothing. Otherwise it
   * fetches GET /fapi/v1/userTrades to recover the actual fills and saves
   * proper trade records (with tradeId, qty, price, commission) plus
   * accumulates fees and realized PnL.
   *
   * Dedup uses _wsHandledOrderIds (WS marks orderId after each saveTrade).
   * REST fallback re-checks before each per-fill save and once more before
   * accumulating, so a WS event arriving mid-fallback can't double-count.
   */
  _scheduleRestFallback(orderId, symbol, side, positionSide) {
    if (!orderId) return;
    // L2: only schedule when WS is known unhealthy at placement time. When WS
    // is healthy, trust L1 (ORDER_TRADE_UPDATE) to deliver. If L1 silently
    // misses, L3 (_reconcileRecentTrades, runs every 30 min after listenKey
    // refresh) catches the missed fill within 30 min.
    if (this._userDataWsHealthy) return;
    this._pendingRestFallback.set(orderId, { symbol, positionSide });
    setTimeout(async () => {
      const wsHandledAt = this._wsHandledOrderIds.get(orderId);
      if (wsHandledAt && Date.now() - wsHandledAt < REST_FALLBACK_DEDUP_WINDOW_MS) {
        this._pendingRestFallback.delete(orderId);
        return; // WS got there first — nothing to do
      }
      try {
        const fills = await this.makeProxyRequest(
          '/fapi/v1/userTrades',
          'GET',
          { symbol, orderId, limit: 50 },
          true,
          'futures'
        );
        if (!Array.isArray(fills) || fills.length === 0) {
          await this.addLog(`WARN: [REST-FALLBACK] order ${orderId}: WS missed and userTrades returned no fills`);
          return;
        }

        let totalCommission = 0;
        let totalRealizedPnl = 0;
        let lastCommissionAsset = 'USDT';

        for (const fill of fills) {
          // Re-check dedup per-fill in case WS arrived mid-loop.
          if (this._wsHandledOrderIds.get(orderId)) break;
          const commission = parseFloat(fill.commission) || 0;
          const realizedPnl = parseFloat(fill.realizedPnl) || 0;
          totalCommission += commission;
          totalRealizedPnl += realizedPnl;
          lastCommissionAsset = fill.commissionAsset || 'USDT';
          await this.saveTrade({
            tradeId: fill.id,
            orderId: fill.orderId,
            symbol: fill.symbol,
            side: fill.side,
            positionSide: fill.positionSide || positionSide,
            time: fill.time || Date.now(),
            price: parseFloat(fill.price) || 0,
            qty: parseFloat(fill.qty) || 0,
            quoteQty: parseFloat(fill.quoteQty) || 0,
            commission,
            commissionAsset: lastCommissionAsset,
            realizedPnl,
            isBuyer: fill.buyer,
            isMaker: fill.maker,
            role: fill.maker ? 'Maker' : 'Taker',
            source: 'rest-fallback',
          });
        }

        // Accumulate ONCE outside the loop, only if WS still hasn't handled it.
        if (!this._wsHandledOrderIds.get(orderId)) {
          if (totalCommission > 0) {
            this.accumulatedTradingFees += totalCommission;
            if (positionSide === 'LONG') this.longTradingFees += totalCommission;
            else if (positionSide === 'SHORT') this.shortTradingFees += totalCommission;
          }
          if (totalRealizedPnl !== 0) {
            this.accumulatedRealizedPnL += totalRealizedPnl;
            if (positionSide === 'LONG') this.longAccumulatedRealizedPnL += totalRealizedPnl;
            else if (positionSide === 'SHORT') this.shortAccumulatedRealizedPnL += totalRealizedPnl;
          }
          // Mark so a slow WS event can't re-double-count later.
          this._wsHandledOrderIds.set(orderId, Date.now());
          this._restFallbackCount++;
          await this.addLog(`[REST-FALLBACK] order ${orderId}: WS missed for ${REST_FALLBACK_DELAY_MS / 1000}s — recovered ${fills.length} fill(s) via REST. fees=${totalCommission.toFixed(4)} ${lastCommissionAsset}, realizedPnl=${totalRealizedPnl.toFixed(4)}`);
        }
      } catch (error) {
        await this.addLog(`ERROR: [REST-FALLBACK] order ${orderId}: ${error.message}`);
      } finally {
        this._pendingRestFallback.delete(orderId);
        this._pruneWsHandledMap();
      }
    }, REST_FALLBACK_DELAY_MS);
  }

  /**
   * L3: periodic reconciliation against userTrades. Hooked into listenKey
   * refresh success path so it runs every 30 min on the same cadence. Sweeps
   * fills since _lastReconciliationAt; for any orderId not in
   * _wsHandledOrderIds, recovers the trade record + accumulators.
   *
   * Idempotent against L1 and L2 via _wsHandledOrderIds dedup map AND
   * idempotent against duplicate Firestore writes via saveTrade's
   * tradeId-as-doc-ID write (set+merge instead of add).
   */
  async _reconcileRecentTrades() {
    if (!this.isRunning) return;
    if (!this.symbol) return;
    const startTime = this._lastReconciliationAt
      || (this.strategyStartTime ? new Date(this.strategyStartTime).getTime() : Date.now() - 30 * 60 * 1000);
    const endTime = Date.now();

    try {
      const fills = await this.makeProxyRequest(
        '/fapi/v1/userTrades',
        'GET',
        { symbol: this.symbol, startTime, limit: 1000 },
        true,
        'futures'
      );
      if (!Array.isArray(fills) || fills.length === 0) {
        this._lastReconciliationAt = endTime;
        return;
      }

      let recoveredCount = 0;
      let recoveredCommission = 0;
      let recoveredRealizedPnl = 0;

      for (const fill of fills) {
        if (this._wsHandledOrderIds.has(fill.orderId)) continue;

        const commission = parseFloat(fill.commission) || 0;
        const realizedPnl = parseFloat(fill.realizedPnl) || 0;
        const positionSide = fill.positionSide || 'BOTH';

        await this.saveTrade({
          tradeId: fill.id,
          orderId: fill.orderId,
          symbol: fill.symbol,
          side: fill.side,
          positionSide,
          time: fill.time || Date.now(),
          price: parseFloat(fill.price) || 0,
          qty: parseFloat(fill.qty) || 0,
          quoteQty: parseFloat(fill.quoteQty) || 0,
          commission,
          commissionAsset: fill.commissionAsset || 'USDT',
          realizedPnl,
          isBuyer: fill.buyer,
          isMaker: fill.maker,
          role: fill.maker ? 'Maker' : 'Taker',
          source: 'reconciliation',
        });

        if (commission > 0) {
          this.accumulatedTradingFees += commission;
          if (positionSide === 'LONG') this.longTradingFees += commission;
          else if (positionSide === 'SHORT') this.shortTradingFees += commission;
        }
        if (realizedPnl !== 0) {
          this.accumulatedRealizedPnL += realizedPnl;
          if (positionSide === 'LONG') this.longAccumulatedRealizedPnL += realizedPnl;
          else if (positionSide === 'SHORT') this.shortAccumulatedRealizedPnL += realizedPnl;
        }
        this._wsHandledOrderIds.set(fill.orderId, Date.now());
        recoveredCount++;
        recoveredCommission += commission;
        recoveredRealizedPnl += realizedPnl;
      }

      this._lastReconciliationAt = endTime;
      if (recoveredCount > 0) {
        await this.addLog(`[RECONCILE] Recovered ${recoveredCount} fill(s) missed by L1+L2. fees=${recoveredCommission.toFixed(4)}, realizedPnl=${recoveredRealizedPnl.toFixed(4)}`);
      }
    } catch (err) {
      await this.addLog(`ERROR: [RECONCILE] failed: ${err.message}`);
    }
  }

  _pruneWsHandledMap() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [oid, ts] of this._wsHandledOrderIds) {
      if (ts < cutoff) this._wsHandledOrderIds.delete(oid);
    }
  }

  /**
   * Synchronous fill recovery for a specific orderId. Used by stop() to ensure
   * the closing trades' realized PnL + fees are accumulated before reading the
   * final Net PnL — bypasses the 5s grace period of _scheduleRestFallback.
   *
   * Idempotent: returns immediately if WS path already handled this orderId.
   * If WS missed, polls order status (every 250ms, max 5s) until FILLED, then
   * fetches /fapi/v1/userTrades and accumulates fees + realized PnL exactly
   * like _scheduleRestFallback does. Marks orderId in _wsHandledOrderIds so a
   * late-arriving WS event or the deferred timer can't double-count.
   */
  async _recoverOrderSync(orderId, symbol, positionSide) {
    if (!orderId) return;

    // Already handled by WS path? Fast no-op.
    const wsHandledAt = this._wsHandledOrderIds.get(orderId);
    if (wsHandledAt && Date.now() - wsHandledAt < REST_FALLBACK_DEDUP_WINDOW_MS) {
      return;
    }

    // Poll order status until FILLED (or terminal non-fill state).
    const statusDeadline = Date.now() + 5_000;
    const statusPollMs = 250;
    let order = null;
    while (Date.now() < statusDeadline) {
      // Late WS arrival short-circuits the loop.
      if (this._wsHandledOrderIds.get(orderId)) return;
      try {
        order = await this.makeProxyRequest('/fapi/v1/order', 'GET', { symbol, orderId }, true, 'futures');
        if (order && (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED')) break;
        if (order && (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED')) {
          await this.addLog(`[STOP-RECOVER] order ${orderId} terminated as ${order.status} — no fills to recover`);
          return;
        }
      } catch (err) {
        await this.addLog(`WARN: [STOP-RECOVER] order ${orderId} status query failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, statusPollMs));
    }

    // Re-check dedup after status poll — WS may have arrived during the wait.
    if (this._wsHandledOrderIds.get(orderId)) return;

    // Fetch trade details + accumulate fees + realized PnL.
    try {
      const fills = await this.makeProxyRequest(
        '/fapi/v1/userTrades',
        'GET',
        { symbol, orderId, limit: 50 },
        true,
        'futures'
      );
      if (!Array.isArray(fills) || fills.length === 0) {
        await this.addLog(`WARN: [STOP-RECOVER] order ${orderId}: no fills returned by userTrades`);
        return;
      }

      let totalCommission = 0;
      let totalRealizedPnl = 0;
      let lastCommissionAsset = 'USDT';

      for (const fill of fills) {
        if (this._wsHandledOrderIds.get(orderId)) break;
        const commission = parseFloat(fill.commission) || 0;
        const realizedPnl = parseFloat(fill.realizedPnl) || 0;
        totalCommission += commission;
        totalRealizedPnl += realizedPnl;
        lastCommissionAsset = fill.commissionAsset || 'USDT';
        await this.saveTrade({
          tradeId: fill.id,
          orderId: fill.orderId,
          symbol: fill.symbol,
          side: fill.side,
          positionSide: fill.positionSide || positionSide,
          time: fill.time || Date.now(),
          price: parseFloat(fill.price) || 0,
          qty: parseFloat(fill.qty) || 0,
          quoteQty: parseFloat(fill.quoteQty) || 0,
          commission,
          commissionAsset: lastCommissionAsset,
          realizedPnl,
          isBuyer: fill.buyer,
          isMaker: fill.maker,
          role: fill.maker ? 'Maker' : 'Taker',
          source: 'stop-sync-recover',
        });
      }

      if (!this._wsHandledOrderIds.get(orderId)) {
        if (totalCommission > 0) {
          this.accumulatedTradingFees += totalCommission;
          if (positionSide === 'LONG') this.longTradingFees += totalCommission;
          else if (positionSide === 'SHORT') this.shortTradingFees += totalCommission;
        }
        if (totalRealizedPnl !== 0) {
          this.accumulatedRealizedPnL += totalRealizedPnl;
          if (positionSide === 'LONG') this.longAccumulatedRealizedPnL += totalRealizedPnl;
          else if (positionSide === 'SHORT') this.shortAccumulatedRealizedPnL += totalRealizedPnl;
        }
        this._wsHandledOrderIds.set(orderId, Date.now());
        await this.addLog(`[STOP-RECOVER] order ${orderId}: recovered ${fills.length} fill(s) via REST. fees=${totalCommission.toFixed(4)} ${lastCommissionAsset}, realizedPnl=${totalRealizedPnl.toFixed(4)}`);
      }
    } catch (err) {
      await this.addLog(`ERROR: [STOP-RECOVER] order ${orderId}: ${err.message}`);
    }
  }

  async deleteSubcollection(collectionRef, subcollectionName) {
    try {
      const batchSize = 500;
      const snapshot = await collectionRef.limit(batchSize).get();
      if (snapshot.empty) return;
      const batch = this.firestore.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      if (snapshot.size === batchSize) {
        await this.deleteSubcollection(collectionRef, subcollectionName);
      }
    } catch (error) {
      console.error(`[${this.strategyId}] Failed to delete ${subcollectionName}: ${error.message}`);
      throw error;
    }
  }

  // ─── Proxy request ─────────────────────────────────────────────────────────

  async makeProxyRequest(endpoint, method = 'GET', params = {}, signed = false, apiType = 'futures') {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-User-Id': this.profileId,
      };

      const response = await fetch(this.sharedVmProxyGcfUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint,
          method,
          params,
          signed,
          apiType,
          profileBinanceApiGcfUrl: this.gcfProxyUrl,
        }),
      });

      const testnetHeader = response.headers.get('X-Binance-Testnet');
      if (testnetHeader !== null) {
        this.isTestnet = testnetHeader === 'true';
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

        await this.addLog(`ERROR: [API_ERROR] ${errorDetails}`);
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

  // ─── Precision utilities ───────────────────────────────────────────────────

  _getPrecision(value) {
    if (value === null || value === undefined || value === 0) return 0;
    const parts = value.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }

  _formatPrice(price) { return precisionFormatter.formatPrice(price, this.symbol); }
  _formatQuantity(quantity) { return precisionFormatter.formatQuantity(quantity, this.symbol); }
  _formatNotional(notional) { return precisionFormatter.formatNotional(notional); }
  roundPrice(price) { return precisionFormatter.roundPrice(price, this.symbol); }
  roundQuantity(quantity) { return precisionFormatter.roundQuantity(quantity, this.symbol); }

  // ─── Exchange info ─────────────────────────────────────────────────────────

  async _fetchAndCacheExchangeInfo(symbol) {
    try {
      const exchangeInfo = await this.makeProxyRequest('/fapi/v1/exchangeInfo', 'GET', {}, false, 'futures');
      const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

      if (symbolInfo) {
        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        let minNotional = 5.0;
        if (minNotionalFilter) {
          const notionalValue = parseFloat(minNotionalFilter.notional || minNotionalFilter.minNotional);
          if (!isNaN(notionalValue) && notionalValue > 0) {
            minNotional = notionalValue;
          }
        }

        const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : 0.01;
        const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.000001;

        this.exchangeInfoCache[symbol] = {
          tickSize,
          stepSize,
          minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0,
          maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : Infinity,
          minNotional,
          precision: lotSizeFilter ? this._getPrecision(parseFloat(lotSizeFilter.stepSize)) : 6,
        };

        precisionFormatter.cachePrecision(symbol, tickSize, stepSize, minNotional);

        await this.addLog(
          `Exchange info cached for ${symbol}: ` +
          `minNotional=${this._formatNotional(minNotional)} USDT, ` +
          `stepSize=${stepSize}, minQty=${this.exchangeInfoCache[symbol].minQty}, ` +
          `tickSize=${tickSize}, precision=${this.exchangeInfoCache[symbol].precision}`
        );
        return this.exchangeInfoCache[symbol];
      }
      throw new Error(`Symbol ${symbol} not found in exchange info.`);
    } catch (error) {
      console.error(`Failed to fetch exchange info: ${error.message}`);
      throw error;
    }
  }

  async _getExchangeInfo(symbol) {
    if (this.exchangeInfoCache[symbol]) return this.exchangeInfoCache[symbol];
    return this._fetchAndCacheExchangeInfo(symbol);
  }

  // ─── Price & quantity helpers ──────────────────────────────────────────────

  async _getCurrentPrice(symbol) {
    try {
      const ticker = await this.makeProxyRequest('/fapi/v1/ticker/price', 'GET', { symbol }, false, 'futures');
      return parseFloat(ticker.price);
    } catch (error) {
      this.addLog(`ERROR: [API_ERROR] Error fetching current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async _calculateAdjustedQuantity(symbol, positionSizeUSDT, calculationPrice = null) {
    let priceUsedForCalculation;

    if (calculationPrice !== null && calculationPrice > 0) {
      priceUsedForCalculation = calculationPrice;
    } else {
      priceUsedForCalculation = await this._getCurrentPrice(symbol);
    }

    if (!priceUsedForCalculation || priceUsedForCalculation <= 0) {
      throw new Error(`Invalid price for ${symbol}: ${priceUsedForCalculation}`);
    }

    const { minQty, maxQty, stepSize, precision, minNotional } = await this._getExchangeInfo(symbol);

    let rawQuantity = positionSizeUSDT / priceUsedForCalculation;
    // Floor (not ceil) to avoid overshooting the intended sizeUSDT — overshoot
    // can trip max-position / liquidation caps at the boundary, and (critically)
    // makes CUT actions reject with `-2018 insufficient position`. A small
    // shortfall is acceptable; a few stepSizes of overshoot is not.
    let adjustedQuantity = Math.floor(rawQuantity / stepSize) * stepSize;
    adjustedQuantity = parseFloat(adjustedQuantity.toFixed(precision));

    if (adjustedQuantity < minQty) adjustedQuantity = minQty;
    if (adjustedQuantity > maxQty) adjustedQuantity = maxQty;

    const notionalValue = adjustedQuantity * priceUsedForCalculation;
    if (notionalValue < minNotional) {
      // Bump UP to satisfy Binance minNotional — this Math.ceil is intentional
      // and the only place it's used. The notional floor is a hard exchange
      // requirement; a tiny overshoot here is preferable to order rejection.
      adjustedQuantity = Math.ceil(minNotional / priceUsedForCalculation / stepSize) * stepSize;
      adjustedQuantity = parseFloat(adjustedQuantity.toFixed(precision));
    }

    return adjustedQuantity;
  }

  _calculateAdjustedPrice(basePrice, percentage, increase) {
    const factor = percentage / 100;
    return increase
      ? this.roundPrice(basePrice * (1 + factor))
      : this.roundPrice(basePrice * (1 - factor));
  }

  // ─── Leverage & position mode ──────────────────────────────────────────────

  async setLeverage(symbol, leverage) {
    try {
      return await this.makeProxyRequest('/fapi/v1/leverage', 'POST', { symbol, leverage }, true, 'futures');
    } catch (error) {
      console.error(`Failed to set leverage: ${error.message}`);
      throw error;
    }
  }

  async getPositionMode() {
    try {
      return await this.makeProxyRequest('/fapi/v1/positionSide/dual', 'GET', {}, true, 'futures');
    } catch (error) {
      console.error(`Failed to get position mode: ${error.message}`);
      throw error;
    }
  }

  async setPositionMode(dualSidePosition) {
    try {
      // Pre-flight check: avoid the noisy -4059 "no need to change" error
      // from Binance when the account is already in the requested mode.
      const current = await this.getPositionMode();
      const currentDual = current?.dualSidePosition === true || current?.dualSidePosition === 'true';
      if (currentDual === dualSidePosition) {
        await this.addLog(`Pos. mode already ${dualSidePosition ? 'Hedge' : 'One-way'}.`);
        return { dualSidePosition };
      }

      const result = await this.makeProxyRequest('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition }, true, 'futures');
      await this.addLog(`Position mode set to ${dualSidePosition ? 'Hedge' : 'One-way'}.`);
      return result;
    } catch (error) {
      // Defensive: covers a race where mode changes between GET and POST.
      if (error.message.includes('-4059') && error.message.includes('No need to change position side')) {
        await this.addLog(`Pos. mode already ${dualSidePosition ? 'Hedge' : 'One-way'}.`);
        return { dualSidePosition };
      }
      console.error(`Failed to set position mode: ${error.message}`);
      throw error;
    }
  }

  // ─── Position detection ────────────────────────────────────────────────────

  async getCurrentPositions() {
    try {
      const accountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
      return accountInfo.positions.filter(pos =>
        parseFloat(pos.positionAmt) !== 0 && pos.symbol === this.symbol
      );
    } catch (error) {
      console.error(`Failed to get current positions: ${error.message}`);
      return [];
    }
  }

  // Liquidation price lives on /fapi/v2/positionRisk, not /fapi/v2/account.
  // Returns a map keyed by positionSide ('LONG' / 'SHORT') with numeric liq prices.
  async getPositionRiskMap() {
    try {
      const rows = await this.makeProxyRequest(
        '/fapi/v2/positionRisk',
        'GET',
        { symbol: this.symbol },
        true,
        'futures'
      );
      const out = { LONG: null, SHORT: null };
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row.symbol !== this.symbol) continue;
          const side = row.positionSide;
          const liq = parseFloat(row.liquidationPrice);
          if (side === 'LONG' || side === 'SHORT') {
            out[side] = (isFinite(liq) && liq > 0) ? liq : null;
          }
        }
      }
      return out;
    } catch (error) {
      console.error(`Failed to get position risk: ${error.message}`);
      return { LONG: null, SHORT: null };
    }
  }

  async getAllOpenOrders(symbol) {
    try {
      return (await this.makeProxyRequest('/fapi/v1/openOrders', 'GET', { symbol }, true, 'futures')) || [];
    } catch (error) {
      console.error(`Failed to get open orders for ${symbol}: ${error.message}`);
      return [];
    }
  }

  async detectCurrentPosition(forceRestApi = false) {
    try {
      const wsUpdateAge = this.lastPositionUpdateFromWebSocket ? Date.now() - this.lastPositionUpdateFromWebSocket : null;
      const useWebSocketData = !forceRestApi && wsUpdateAge !== null && wsUpdateAge < 2000;

      if (useWebSocketData) {
        this.positionUpdatedViaWebSocket = false;
        return;
      }

      const positions = await this.getCurrentPositions();

      if (positions.length === 0) {
        this.currentPosition = 'NONE';
        if (!this.isStopping) {
          this.positionEntryPrice = null;
          this.positionSize = null;
          this.entryPositionQuantity = null;
          this.currentPositionQuantity = null;
        }
        this._longEntryPrice = null;
        this._longPositionSize = null;
        this._shortEntryPrice = null;
        this._shortPositionSize = null;
      } else if (positions.length === 1) {
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);

        this.lastPositionQuantity = Math.abs(positionAmt);
        this.lastPositionEntryPrice = parseFloat(p.entryPrice);

        if (this.currentPosition === 'LONG') {
          this._longEntryPrice = this.positionEntryPrice;
          this._longPositionSize = this.positionSize;
          this._shortEntryPrice = null;
          this._shortPositionSize = null;
        } else {
          this._shortEntryPrice = this.positionEntryPrice;
          this._shortPositionSize = this.positionSize;
          this._longEntryPrice = null;
          this._longPositionSize = null;
        }
      } else {
        // Multiple positions (hedge mode — both LONG and SHORT open)
        const longPos = positions.find(p => parseFloat(p.positionAmt) > 0);
        const shortPos = positions.find(p => parseFloat(p.positionAmt) < 0);

        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);

        this._longEntryPrice = longPos ? parseFloat(longPos.entryPrice) : null;
        this._longPositionSize = longPos ? Math.abs(parseFloat(longPos.notional)) : null;
        this._shortEntryPrice = shortPos ? parseFloat(shortPos.entryPrice) : null;
        this._shortPositionSize = shortPos ? Math.abs(parseFloat(shortPos.notional)) : null;

        this.lastPositionQuantity = Math.abs(positionAmt);
        this.lastPositionEntryPrice = parseFloat(p.entryPrice);
      }
    } catch (error) {
      console.error(`Failed to detect current position for ${this.symbol}: ${error.message}`);
    }
  }

  /**
   * Detect per-side positions for hedge mode (returns structured data).
   * Unlike detectCurrentPosition which updates the legacy single-position fields,
   * this returns a clean object with both sides.
   */
  async detectHedgePositions() {
    const [positions, riskMap] = await Promise.all([
      this.getCurrentPositions(),
      this.getPositionRiskMap(),
    ]);
    const longPos = positions.find(p => parseFloat(p.positionAmt) > 0);
    const shortPos = positions.find(p => parseFloat(p.positionAmt) < 0);

    const result = {
      long: longPos ? {
        entryPrice: parseFloat(longPos.entryPrice),
        quantity: Math.abs(parseFloat(longPos.positionAmt)),
        notional: Math.abs(parseFloat(longPos.notional)),
        unrealizedPnl: parseFloat(longPos.unRealizedProfit || 0),
        liquidationPrice: riskMap.LONG,
      } : null,
      short: shortPos ? {
        entryPrice: parseFloat(shortPos.entryPrice),
        quantity: Math.abs(parseFloat(shortPos.positionAmt)),
        notional: Math.abs(parseFloat(shortPos.notional)),
        unrealizedPnl: parseFloat(shortPos.unRealizedProfit || 0),
        liquidationPrice: riskMap.SHORT,
      } : null,
    };

    // Update internal per-side fields too
    if (result.long) {
      this._longEntryPrice = result.long.entryPrice;
      this._longPositionSize = result.long.notional;
    } else {
      this._longEntryPrice = null;
      this._longPositionSize = null;
    }
    if (result.short) {
      this._shortEntryPrice = result.short.entryPrice;
      this._shortPositionSize = result.short.notional;
    } else {
      this._shortEntryPrice = null;
      this._shortPositionSize = null;
    }

    return result;
  }

  // ─── Order placement ───────────────────────────────────────────────────────

  async placeMarketOrder(symbol, side, quantity, positionSide) {
    if (quantity <= 0) throw new Error('Calculated quantity is zero or negative.');

    return new Promise(async (resolve, reject) => {
      try {
        const orderParams = {
          symbol,
          side,
          type: 'MARKET',
          quantity,
          newOrderRespType: 'FULL',
        };
        if (positionSide) orderParams.positionSide = positionSide;
        const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', orderParams, true, 'futures');

        if (result && result.orderId) {
          this.pendingOrders.set(result.orderId, { resolve, reject });
          resolve(result);
        } else {
          reject(new Error('Order placement failed: No orderId in response.'));
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  async _queryOrder(symbol, orderId) {
    try {
      return await this.makeProxyRequest('/fapi/v1/order', 'GET', { symbol, orderId }, true, 'futures');
    } catch (error) {
      this.addLog(`ERROR: [REST-API] [API_ERROR] Error querying order ${orderId}: ${error.message}`);
      throw error;
    }
  }

  async placeLimitOrder(symbol, side, quantity, price, positionSide) {
    if (quantity <= 0) throw new Error('Calculated quantity is zero or negative.');
    if (price <= 0) throw new Error('Limit price is zero or negative.');

    const roundedPrice = this.roundPrice(price);
    const roundedQuantity = this.roundQuantity(quantity);

    try {
      const orderParams = {
        symbol,
        side,
        type: 'LIMIT',
        quantity: roundedQuantity,
        price: roundedPrice,
        timeInForce: 'GTC',
        newOrderRespType: 'FULL',
      };
      if (positionSide) orderParams.positionSide = positionSide;
      const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', orderParams, true, 'futures');

      if (result && result.orderId) {
        await this.addLog(`[REST-API] Placed LIMIT ${side} order ${result.orderId} for ${roundedQuantity} at ${roundedPrice}.`);
        return result;
      }
      throw new Error('Limit order placement failed: No orderId in response.');
    } catch (error) {
      await this.addLog(`ERROR: [REST-API] [TRADING_ERROR] Failed to place limit order: ${error.message}`);
      throw error;
    }
  }

  async cancelOrder(symbol, orderId) {
    if (!orderId) return;
    try {
      await this.makeProxyRequest('/fapi/v1/order', 'DELETE', { symbol, orderId }, true, 'futures');
      await this.addLog(`[REST-API] Cancelled order ${orderId}.`);
    } catch (error) {
      if (error.binanceErrorCode === -2011) {
        await this.addLog(`[REST-API] Order ${orderId} already filled or cancelled.`);
      } else {
        await this.addLog(`ERROR: [REST-API] [TRADING_ERROR] Failed to cancel order ${orderId}: ${error.message}`);
      }
    }
  }

  async _waitForOrderFill(orderId, timeoutMs = 5000) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let pollIntervalId;

      const settle = (type, value) => {
        if (settled) return;
        settled = true;
        this.pendingOrders.delete(orderId);
        if (pollIntervalId) clearInterval(pollIntervalId);
        if (type === 'resolve') resolve(value);
        else reject(value);
      };

      this.pendingOrders.set(orderId, {
        resolve: (order) => {
          this.addLog(`Order ${orderId} confirmed FILLED after ${Date.now() - startTime}ms.`);
          settle('resolve', order);
        },
        reject: (error) => settle('reject', error),
      });

      pollIntervalId = setInterval(async () => {
        if (settled) { clearInterval(pollIntervalId); return; }
        try {
          const order = await this._queryOrder(this.symbol, orderId);
          if (order && order.status === 'FILLED') {
            await this.addLog(`Order ${orderId} confirmed FILLED after ${Date.now() - startTime}ms.`);
            settle('resolve', order);
          } else if (Date.now() - startTime > timeoutMs) {
            await this.addLog(`Timeout waiting for order ${orderId} to fill. Last status: ${order?.status}`);
            settle('reject', new Error(`Timeout waiting for order ${orderId} to fill`));
          }
        } catch (error) {
          if (Date.now() - startTime > timeoutMs) {
            settle('reject', error);
          }
        }
      }, 200);
    });
  }

  // ─── WebSocket base URL ────────────────────────────────────────────────────
  //
  // If RELAY_WS_URL is set (e.g. ws://34.142.xxx.xxx:8080/ws), MARKET-data WS
  // connections route through the ycbot-ws-relay so Binance only ever sees the
  // relay's static IP — keeps user-VM IPs out of Binance's market-data IP-rep
  // tracking and avoids the full re-architecture if a user-VM IP gets banned.
  //
  // USER-DATA WS deliberately bypasses the relay even when RELAY_WS_URL is set.
  // User-data is auth'd by listenKey (account-bound, not IP-bound), so there's
  // no IP-rep concern there. Routing it through the relay introduced a silent-
  // stuck failure mode where the relay's upstream stayed open but Binance never
  // pushed ORDER_TRADE_UPDATE / ACCOUNT_UPDATE events through it (12+ hour run
  // produced zero events, breaking saveTrade and PnL/fee accumulation). Direct
  // bot → Binance restores the pre-v1.0.4 behavior for this stream type only.
  //
  // Without RELAY_WS_URL, both market and user-data fall back to direct Binance
  // — backwards-compatible with any deploy that hasn't pointed at a relay yet.
  //
  // Binance Futures WS routing (per docs, 2026):
  //   /market — market data (markPrice, ticker, kline, aggTrade, forceOrder)
  //   /private — user-data (listenKey)
  //   /public — high-frequency public (not used here)
  // Connections without a routed path only receive Public-endpoint data, which
  // is why bare `/ws/<stream>` for market streams silently delivers no frames
  // (SUBSCRIBE acks, no data). Spot endpoint (stream.binance.com) does NOT
  // require this — spot testnet still uses /ws.

  _getWsBaseUrl(streamType = 'market') {
    // Spot testnet uses unprefixed /ws (no routing requirement).
    if (this.isTestnet === true) {
      return 'wss://stream.binance.com/ws';
    }
    // Futures production: routed paths are required for market and user-data.
    if (streamType === 'userdata') {
      return 'wss://fstream.binance.com/private/ws';
    }
    // Market: prefer the relay (which itself uses /market routing internally).
    if (process.env.RELAY_WS_URL) return process.env.RELAY_WS_URL;
    // Direct fallback to Binance with /market routing.
    return 'wss://fstream.binance.com/market/ws';
  }

  // Build a market-stream WS URL. When connecting through the relay AND a
  // RELAY_AUTH_TOKEN is configured, append it as a query param. Direct-Binance
  // URLs (relay unset) are returned untouched — Binance has no auth concept
  // for market data and would reject a stray ?token=.
  _buildRelayWsUrl(stream) {
    const baseUrl = this._getWsBaseUrl();
    const url = `${baseUrl}/${stream}`;
    const token = process.env.RELAY_AUTH_TOKEN;
    if (token && process.env.RELAY_WS_URL) {
      return `${url}?token=${encodeURIComponent(token)}`;
    }
    return url;
  }

  // ─── WebSocket: Real-time price ────────────────────────────────────────────

  connectRealtimeWebSocket() {
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);
    if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
    if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);
    if (this.realtimeWsStaleWatcher) clearInterval(this.realtimeWsStaleWatcher);
    const prevReadyState = this.realtimeWs?.readyState ?? 'null';
    if (this.realtimeWs) this.realtimeWs.close();

    const tickerStream = this.priceType === 'LAST'
      ? `${this.symbol.toLowerCase()}@ticker`
      : `${this.symbol.toLowerCase()}@markPrice@1s`;

    const wsUrl = this._buildRelayWsUrl(tickerStream);
    const wsId = ++this._realtimeWsIdCounter;
    this._realtimeMessagesSeen = 0;
    // Tracks whether this specific WS instance ever transitioned to OPEN. Used in
    // the close handler to distinguish "stalled after open" (existing watchdog
    // already counts this) from "couldn't even open" (relay unreachable / network
    // outage / kernel routing block) — both should count toward REST fallback.
    let wsEverOpened = false;
    this.addLog(`[DIAG] connectRealtimeWebSocket called. prevReadyState=${prevReadyState}, newWsId=${wsId}, url=${wsUrl}`);
    this.realtimeWs = new WebSocket(wsUrl);
    const currentWs = this.realtimeWs;

    this.realtimeWs.on('open', async () => {
      wsEverOpened = true;
      await this.addLog(`[DIAG] WS ${wsId} OPEN`);
      await this.addLog('[WebSocket] Real-time price WS connected.');
      this.realtimeWsConnected = true;
      this.realtimeReconnectAttempts = 0;
      this.lastRealtimeTickAt = Date.now();
      if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);

      this.realtimeWsPingInterval = setInterval(() => {
        this.realtimeWs.ping();
        this.realtimeWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] Real-time WS pong timeout. Terminating connection.');
          this.realtimeWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);

      // Stream-stall watchdog: if no price message arrives within STALE_TICK_THRESHOLD_MS
      // while the socket reports connected, terminate — the existing close handler then
      // schedules reconnect with the normal backoff. Also tracks consecutive stalls so
      // we can switch to REST polling fallback when WS is persistently broken.
      this.realtimeWsStaleWatcher = setInterval(async () => {
        if (!this.realtimeWsConnected) return;
        const silentFor = Date.now() - this.lastRealtimeTickAt;
        if (silentFor > STALE_TICK_THRESHOLD_MS) {
          await this.addLog(`WARN: Real-time price stream stalled — no tick in ${Math.round(silentFor / 1000)}s (wsId=${wsId}). Terminating for reconnect.`);

          // Track stall window: count consecutive stalls within REST_FALLBACK_WINDOW_MS.
          const now = Date.now();
          if (this._firstStallAt === null || now - this._firstStallAt > REST_FALLBACK_WINDOW_MS) {
            this._firstStallAt = now;
            this._consecutiveStalls = 1;
          } else {
            this._consecutiveStalls++;
          }

          try { currentWs.terminate(); } catch (_) { /* ignore */ }

          // If we've stalled too many times in the window AND we're still in WS mode,
          // switch to REST polling fallback. The close handler that follows will see
          // streamMode === 'REST_FALLBACK' and skip auto-reconnect.
          if (this.streamMode === 'WS' && this._consecutiveStalls >= REST_FALLBACK_THRESHOLD) {
            await this._enterRestFallbackMode();
          }
        }
      }, STALE_WATCHDOG_INTERVAL_MS);
    });

    this.realtimeWs.on('pong', () => {
      if (this.realtimeWsPingTimeout) {
        clearTimeout(this.realtimeWsPingTimeout);
        this.realtimeWsPingTimeout = null;
      }
    });

    this.realtimeWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.lastRealtimeTickAt = Date.now();

        // Reset stall tracking — we got real data, so the WS path is healthy.
        if (this._consecutiveStalls > 0 || this._firstStallAt !== null) {
          this._consecutiveStalls = 0;
          this._firstStallAt = null;
        }

        // Log only the first 3 messages per socket for diagnostics, then silent.
        if (this._realtimeMessagesSeen < 3) {
          this._realtimeMessagesSeen++;
          await this.addLog(`[DIAG] WS ${wsId} MESSAGE #${this._realtimeMessagesSeen} e=${message.e}`);
        }
        if (this.priceType === 'LAST' && message.e === '24hrTicker') {
          await this.handleRealtimePrice(parseFloat(message.c));
        } else if (this.priceType === 'MARK' && message.e === 'markPriceUpdate') {
          await this.handleRealtimePrice(parseFloat(message.p));
        }
      } catch (error) {
        console.error(`Error processing price message: ${error.message}`);
        await this.addLog(`ERROR: [WS_MESSAGE] Price message handler failed: ${error.message}`);
      }
    });

    this.realtimeWs.on('error', async (error) => {
      console.error(`Price WebSocket error: ${error.message}`);
      await this.addLog(`ERROR: [WS_ERROR] Price WebSocket error (wsId=${wsId}): ${error.message}`);
    });

    this.realtimeWs.on('close', async (code, reason) => {
      this.realtimeWsConnected = false;
      await this.addLog(`[DIAG] WS ${wsId} CLOSE code=${code} reason=${reason || 'none'}`);
      await this.addLog('[WebSocket] Real-time price WebSocket closed.');
      if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
      if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);
      if (this.realtimeWsStaleWatcher) clearInterval(this.realtimeWsStaleWatcher);

      // Connect-failure path: WS never reached OPEN (relay unreachable, route blocked,
      // DNS broken, etc). Existing stall watchdog only counts post-open silence, so
      // these failures wouldn't trigger REST fallback on their own. Count them into
      // the same window so REST fallback engages when the WS path is genuinely down.
      if (!wsEverOpened && this.streamMode === 'WS' && this.isRunning) {
        const now = Date.now();
        if (this._firstStallAt === null || now - this._firstStallAt > REST_FALLBACK_WINDOW_MS) {
          this._firstStallAt = now;
          this._consecutiveStalls = 1;
        } else {
          this._consecutiveStalls++;
        }
        if (this._consecutiveStalls >= REST_FALLBACK_THRESHOLD) {
          await this._enterRestFallbackMode();
          // _enterRestFallbackMode sets streamMode = 'REST_FALLBACK' — the early
          // return below now kicks in and skips the standard reconnect loop.
        }
      }

      // In REST fallback mode, the background WS retry loop owns reconnect attempts.
      // Skip the normal close-handler reconnect to avoid duplicating connections.
      if (this.streamMode === 'REST_FALLBACK') return;

      if (this.isRunning) {
        this.realtimeReconnectAttempts++;
        if (this.realtimeReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.realtimeReconnectAttempts - 1));
          await this.addLog(`[WebSocket] Real-time price WS disconnected. Scheduling reconnect in ${delay / 1000}s (Attempt ${this.realtimeReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          this.realtimeReconnectTimeout = setTimeout(() => {
            this.connectRealtimeWebSocket();
          }, delay);
        } else {
          await this.addLog(`ERROR: [CONNECTION_ERROR] Max Real-time price WS reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
        }
      }
    });
  }

  // ─── REST polling fallback for price feed ──────────────────────────────────
  // Activated when the watchdog detects REST_FALLBACK_THRESHOLD consecutive
  // stalls within REST_FALLBACK_WINDOW_MS. Polls /fapi/v1/premiumIndex via the
  // GCF proxy (clean egress IP) and feeds prices to handleRealtimePrice().
  // A long-lived monitor WS (see _openMonitorWs) watches for stream recovery;
  // first qualifying message exits fallback automatically.

  async _enterRestFallbackMode() {
    if (this.streamMode === 'REST_FALLBACK') return;
    this.streamMode = 'REST_FALLBACK';
    await this.addLog(`[MODE] Switching to REST polling fallback (${REST_FALLBACK_THRESHOLD} consecutive stalls in <${Math.round(REST_FALLBACK_WINDOW_MS / 1000)}s). Trading continues at degraded latency.`);

    // Cancel any pending WS reconnect — fallback owns the price feed now.
    if (this.realtimeReconnectTimeout) {
      clearTimeout(this.realtimeReconnectTimeout);
      this.realtimeReconnectTimeout = null;
    }
    this.realtimeReconnectAttempts = 0;

    // M2 staleness thresholds. lastRealtimeTickAt is updated only on
    // SUCCESSFUL polls in fallback mode, so it's a clean staleness signal.
    const STALENESS_WARN_MS = 30 * 1000;
    const STALENESS_BLOCK_MS = 60 * 1000;
    const STALENESS_HALT_MS = 5 * 60 * 1000;
    this._priceFeedStale = false;
    this._restPollErrorCount = 0;
    this._restPollLastErrorLoggedAt = 0;

    // Start REST polling for the mark price.
    this._restPollInterval = setInterval(async () => {
      if (this.streamMode !== 'REST_FALLBACK' || !this.isRunning) return;
      try {
        const data = await this.makeProxyRequest(
          '/fapi/v1/premiumIndex',
          'GET',
          { symbol: this.symbol },
          false,
          'futures'
        );
        if (data && data.markPrice) {
          this.lastRealtimeTickAt = Date.now();
          if (this._priceFeedStale) {
            await this.addLog('[REST_FALLBACK] Price feed RECOVERED. Resuming normal operation.');
            this._priceFeedStale = false;
            this._restPollErrorCount = 0;
          }
          await this.handleRealtimePrice(parseFloat(data.markPrice));
        }
      } catch (error) {
        this._restPollErrorCount++;
        // M2: escalating log cadence — log first failure immediately,
        // then 5th, 15th, 50th, 150th, ... so a sustained outage is
        // surfaced loudly at the start (when the user can do something
        // about it) without flooding logs over hours.
        const c = this._restPollErrorCount;
        const shouldLog = c === 1 || c === 5 || c === 15 || c === 50 || c % 150 === 0;
        if (shouldLog) {
          await this.addLog(`WARN: [REST_FALLBACK] poll error (#${c}): ${error.message}`);
          this._restPollLastErrorLoggedAt = Date.now();
        }
      }

      // M2: staleness watchdog. Runs every poll regardless of success/fail.
      const now = Date.now();
      const stalenessMs = now - (this.lastRealtimeTickAt || now);
      if (stalenessMs >= STALENESS_HALT_MS) {
        // Past the no-trade-anyway threshold. Hard halt — force-stop with
        // price_feed_dead so the user gets a notification + the positions
        // are closed cleanly while we still trust the last known prices
        // for the close-orders to land sensibly.
        await this.addLog(`ERROR: [REST_FALLBACK] Price feed dead for ${Math.round(stalenessMs / 1000)}s. Halting strategy — positions will be closed.`);
        this.criticalError = 'price_feed_dead';
        clearInterval(this._restPollInterval);
        this._restPollInterval = null;
        this.stop('price_feed_dead').catch(err => console.error(`[REST_FALLBACK] halt failed: ${err.message}`));
        return;
      }
      if (stalenessMs >= STALENESS_BLOCK_MS && !this._priceFeedStale) {
        this._priceFeedStale = true;
        await this.addLog(`ERROR: [REST_FALLBACK] Price feed stale for ${Math.round(stalenessMs / 1000)}s. Trading actions blocked until recovery; will halt at ${STALENESS_HALT_MS / 1000}s if not recovered.`);
      }
    }, REST_POLL_INTERVAL_MS);

    // Open the long-lived monitor WS that watches for WS recovery.
    this._openMonitorWs();
  }

  // ─── Monitor WS during REST fallback ───────────────────────────────────────
  // Single long-lived subscription to the price stream. First qualifying
  // message exits fallback. Active ping/pong detects silent-stuck connections
  // (a throttled WS looks identical to a healthy-but-quiet one). Reconnect
  // uses exponential backoff so a down/throttled relay can't churn connections.

  _openMonitorWs() {
    if (this.streamMode !== 'REST_FALLBACK' || !this.isRunning) return;

    // Defensive: if a previous monitor WS exists, close it cleanly first.
    this._closeMonitorWs({ silent: true });

    const tickerStream = this.priceType === 'LAST'
      ? `${this.symbol.toLowerCase()}@ticker`
      : `${this.symbol.toLowerCase()}@markPrice@1s`;
    const wsUrl = this._buildRelayWsUrl(tickerStream);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      this._scheduleMonitorReconnect();
      return;
    }
    this._monitorWs = ws;
    this._monitorWsOpenedAt = Date.now();

    ws.on('open', async () => {
      if (this._monitorWsReconnectAttempts > 0) {
        await this.addLog(`[MODE] Monitor WS reconnected after ${this._monitorWsReconnectAttempts} attempt(s); waiting for first message to exit fallback.`);
      } else {
        await this.addLog(`[MODE] Monitor WS opened on ${tickerStream}; will exit REST fallback on first message.`);
      }
      this._monitorWsReconnectAttempts = 0;
      this._startMonitorHeartbeatLog();
      this._startMonitorPingLoop(ws);
    });

    ws.on('pong', () => {
      if (this._monitorWsPongTimeout) {
        clearTimeout(this._monitorWsPongTimeout);
        this._monitorWsPongTimeout = null;
      }
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.e === 'markPriceUpdate' || msg.e === '24hrTicker') {
          // _exitRestFallbackMode → _closeMonitorWs() removes listeners before
          // .close() fires, so this close won't recurse into reconnect.
          await this._exitRestFallbackMode();
        }
      } catch (_) { /* ignore parse errors */ }
    });

    ws.on('error', () => { /* close handler owns retry */ });

    ws.on('close', () => {
      this._stopMonitorPingLoop();
      this._stopMonitorHeartbeatLog();
      if (this._monitorWs === ws) this._monitorWs = null;
      if (this.streamMode === 'REST_FALLBACK' && this.isRunning) {
        this._scheduleMonitorReconnect();
      }
    });
  }

  _startMonitorPingLoop(ws) {
    this._stopMonitorPingLoop();
    this._monitorWsPingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); } catch (_) { /* ignore */ }
      if (this._monitorWsPongTimeout) clearTimeout(this._monitorWsPongTimeout);
      this._monitorWsPongTimeout = setTimeout(() => {
        // No pong → assume silent-stuck. Force-close; close handler reconnects.
        try { ws.terminate(); } catch (_) { /* ignore */ }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  _stopMonitorPingLoop() {
    if (this._monitorWsPingInterval) {
      clearInterval(this._monitorWsPingInterval);
      this._monitorWsPingInterval = null;
    }
    if (this._monitorWsPongTimeout) {
      clearTimeout(this._monitorWsPongTimeout);
      this._monitorWsPongTimeout = null;
    }
  }

  _scheduleMonitorReconnect() {
    if (this._monitorWsReconnectTimeout) return;
    this._monitorWsReconnectAttempts++;
    const delay = Math.min(
      MONITOR_WS_MAX_RECONNECT_DELAY_MS,
      MONITOR_WS_INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this._monitorWsReconnectAttempts - 1)
    );
    this._monitorWsReconnectTimeout = setTimeout(() => {
      this._monitorWsReconnectTimeout = null;
      this._openMonitorWs();
    }, delay);
  }

  _startMonitorHeartbeatLog() {
    this._stopMonitorHeartbeatLog();
    this._monitorWsHeartbeatTimer = setInterval(async () => {
      if (this.streamMode !== 'REST_FALLBACK') return;
      const upMin = Math.round((Date.now() - this._monitorWsOpenedAt) / 60000);
      await this.addLog(`[MODE] REST fallback active — monitor WS listening (open ${upMin} min, no recovery message yet).`);
    }, MONITOR_WS_HEARTBEAT_LOG_MS);
  }

  _stopMonitorHeartbeatLog() {
    if (this._monitorWsHeartbeatTimer) {
      clearInterval(this._monitorWsHeartbeatTimer);
      this._monitorWsHeartbeatTimer = null;
    }
  }

  _closeMonitorWs({ silent = false } = {}) {
    if (this._monitorWsReconnectTimeout) {
      clearTimeout(this._monitorWsReconnectTimeout);
      this._monitorWsReconnectTimeout = null;
    }
    this._stopMonitorHeartbeatLog();
    this._stopMonitorPingLoop();
    if (this._monitorWs) {
      try {
        this._monitorWs.removeAllListeners();
        this._monitorWs.close();
      } catch (_) { /* ignore */ }
      this._monitorWs = null;
    }
    if (!silent) this._monitorWsReconnectAttempts = 0;
  }

  async _exitRestFallbackMode() {
    if (this.streamMode !== 'REST_FALLBACK') return;
    await this.addLog(`[MODE] WS feed recovered. Exiting REST fallback.`);

    // Stop polling and tear down the monitor WS.
    if (this._restPollInterval) {
      clearInterval(this._restPollInterval);
      this._restPollInterval = null;
    }
    this._closeMonitorWs();
    this._restPollErrorCount = 0;

    // Reset state for fresh WS lifecycle.
    this.streamMode = 'WS';
    this._consecutiveStalls = 0;
    this._firstStallAt = null;
    this.realtimeReconnectAttempts = 0;

    // Re-establish a proper WS connection via the normal connect path.
    this.connectRealtimeWebSocket();
  }

  // ─── WebSocket: User Data Stream ───────────────────────────────────────────

  connectUserDataStream() {
    if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);
    if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
    if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);

    if (!this.listenKey) {
      console.error('Cannot connect User Data Stream: listenKey is null.');
      this.addLog('ERROR: [CONNECTION_ERROR] listenKey is null, cannot connect User Data Stream.');
      return;
    }

    if (this.userDataWs) {
      this.isUserDataReconnecting = true;
      this.userDataWs.close(1000, 'Intentional reconnection');
    }

    // User-data bypasses the relay — see _getWsBaseUrl() for rationale.
    const wsBaseUrl = this._getWsBaseUrl('userdata');

    const userDataUrl = `${wsBaseUrl}/${this.listenKey}`;
    const wsId = ++this._userDataWsIdCounter;
    this._userDataMessagesSeen = 0;
    this.addLog(`[DIAG] connectUserDataStream called. newWsId=${wsId}`);
    this.userDataWs = new WebSocket(userDataUrl);

    this.userDataWs.on('open', async () => {
      await this.addLog(`[DIAG] User Data WS ${wsId} OPEN`);
      await this.addLog('[WebSocket] User Data WS connected.');
      this.userDataWsConnected = true;
      // L2 health flag: log only on transition from unhealthy → healthy.
      // Initial open (was already true from constructor) is silent.
      if (!this._userDataWsHealthy) {
        await this.addLog('[USER-DATA-WS] unhealthy → healthy, WS path active');
        this._userDataWsHealthy = true;
      }
      this.userDataReconnectAttempts = 0;
      if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);

      this.userDataWsPingInterval = setInterval(() => {
        this.userDataWs.ping();
        this.userDataWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] User Data WS pong timeout. Terminating connection.');
          this.userDataWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);

      // Reconcile on reconnect — pull latest positions via REST to catch any
      // ACCOUNT_UPDATE or ORDER_TRADE_UPDATE events missed during the outage window.
      if (this._needsUserDataReconcileOnOpen) {
        this._needsUserDataReconcileOnOpen = false;
        await this._reconcilePositionsAfterUserDataReconnect();
      }
    });

    this.userDataWs.on('pong', () => {
      if (this.userDataWsPingTimeout) {
        clearTimeout(this.userDataWsPingTimeout);
        this.userDataWsPingTimeout = null;
      }
    });

    this.userDataWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._lastUserDataMessageAt = Date.now();

        if (this._userDataMessagesSeen < 3) {
          this._userDataMessagesSeen++;
          await this.addLog(`[DIAG] User Data WS ${wsId} MESSAGE #${this._userDataMessagesSeen} e=${message.e}`);
        }

        // ORDER_TRADE_UPDATE — trade fills, PnL, fees
        if (message.e === 'ORDER_TRADE_UPDATE' && message.o.s === this.symbol) {
          await this._handleOrderTradeUpdate(message.o);
        }

        // ACCOUNT_UPDATE — position changes
        if (message.e === 'ACCOUNT_UPDATE' && message.a && message.a.P) {
          await this._handleAccountUpdate(message.a.P);
        }
      } catch (error) {
        console.error(`Error processing User Data Stream message: ${error.message}`);
        await this.addLog(`ERROR: [CONNECTION_ERROR] Processing User Data Stream message: ${error.message}`);
      }
    });

    this.userDataWs.on('error', async (error) => {
      console.error(`User Data Stream WebSocket error: ${error.message}`);
      await this.addLog(`ERROR: [CONNECTION_ERROR] User Data Stream WebSocket error: ${error.message}`);
    });

    this.userDataWs.on('close', async (code, reason) => {
      this.userDataWsConnected = false;
      // L2 health flag: log only on transition from healthy → unhealthy.
      if (this._userDataWsHealthy) {
        await this.addLog('[USER-DATA-WS] healthy → unhealthy, REST fallback active');
        this._userDataWsHealthy = false;
      }
      await this.addLog(`[DIAG] User Data WS ${wsId} CLOSE code=${code} reason=${reason || 'none'}`);
      await this.addLog(`[WebSocket] User Data Stream WebSocket closed. Code: ${code}, Reason: ${reason || 'none'}, isRunning: ${this.isRunning}`);

      if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
      if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);

      if (this.isUserDataReconnecting && code === 1000) {
        this.isUserDataReconnecting = false;
        return;
      }
      if (this.isUserDataReconnecting) {
        this.isUserDataReconnecting = false;
      }

      if (this.isRunning && code !== 1000) {
        this.userDataReconnectAttempts++;
        if (this.userDataReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.userDataReconnectAttempts - 1));
          await this.addLog(`[WebSocket] User Data WS disconnected. Scheduling reconnect in ${delay / 1000}s (Attempt ${this.userDataReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);
          this.userDataReconnectTimeout = setTimeout(() => {
            this.attemptUserDataReconnection();
          }, delay);
        } else {
          await this.addLog(`ERROR: [CONNECTION_ERROR] Max User Data WS reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
        }
      }
    });
  }

  /**
   * Handle ORDER_TRADE_UPDATE events — accumulates PnL, fees, saves trades.
   * Subclasses can override to add strategy-specific order handling.
   */
  async _handleOrderTradeUpdate(order) {
    // Capture trade data from TRADE events
    if (order.x === 'TRADE' && parseFloat(order.L) > 0) {
      const tradeQty = parseFloat(order.l);
      const tradePrice = parseFloat(order.L);

      if (tradeQty > 0) {
        const realizedPnl = parseFloat(order.rp) || 0;
        let commission = parseFloat(order.n) || 0;
        const commissionAsset = order.N || 'USDT';

        if (commission === 0 && tradeQty > 0 && tradePrice > 0) {
          commission = tradeQty * tradePrice * this.feeRate;
        }

        const orderPositionSide = order.ps || 'BOTH';
        if (!isNaN(realizedPnl) && realizedPnl !== 0) {
          this.accumulatedRealizedPnL += realizedPnl;
          if (orderPositionSide === 'LONG') this.longAccumulatedRealizedPnL += realizedPnl;
          else if (orderPositionSide === 'SHORT') this.shortAccumulatedRealizedPnL += realizedPnl;
        }
        if (!isNaN(commission) && commission !== 0) {
          this.accumulatedTradingFees += commission;
          if (orderPositionSide === 'LONG') this.longTradingFees += commission;
          else if (orderPositionSide === 'SHORT') this.shortTradingFees += commission;
        }

        await this.saveTrade({
          tradeId: order.t,                      // Binance trade ID — unique per fill (differs across partial fills of one order)
          orderId: order.i,
          symbol: order.s,
          side: order.S,                        // 'BUY' or 'SELL'
          positionSide: orderPositionSide,       // 'LONG' or 'SHORT'
          time: order.T || Date.now(),           // Fall back to local clock if Binance omits T — `ignoreUndefinedProperties: true` would otherwise strip the field and break orderBy queries

          price: tradePrice,
          qty: tradeQty,
          quoteQty: tradePrice * tradeQty,
          commission,
          commissionAsset,
          realizedPnl,
          isBuyer: order.S === 'BUY',
          role: order.m ? 'Maker' : 'Taker',
        });

        // Mark this orderId as handled by the WS path so the deferred REST
        // fallback (scheduled at order placement) skips its userTrades fetch.
        this._wsHandledOrderIds.set(order.i, Date.now());
      }
    }

    // Resolve/reject pending order promises
    if (this.pendingOrders.has(order.i)) {
      const { resolve, reject } = this.pendingOrders.get(order.i);
      if (order.X === 'FILLED') {
        resolve(order);
        this.pendingOrders.delete(order.i);
        await this.detectCurrentPosition();
      } else if (order.X === 'CANCELED' || order.X === 'REJECTED' || order.X === 'EXPIRED') {
        reject(new Error(`Order ${order.i} ${order.X}`));
        this.pendingOrders.delete(order.i);
      }
    }
  }

  /**
   * Handle ACCOUNT_UPDATE events — position state updates from exchange.
   *
   * Mirrors each per-side update into both the legacy internal fields
   * (_longEntryPrice / _shortEntryPrice / ...) and the structured per-side
   * objects (longPosition / shortPosition) that the AI hedge strategy,
   * frontend, risk guard, and status payload all read from. This makes the
   * WS push the primary source of truth for position state — REST polling
   * becomes a reconciliation fallback only.
   */
  async _handleAccountUpdate(positions) {
    const symbolUpdates = positions.filter(p => p.s === this.symbol);
    if (symbolUpdates.length === 0) return;

    for (const positionUpdate of symbolUpdates) {
      const positionAmount = parseFloat(positionUpdate.pa);
      const entryPrice = parseFloat(positionUpdate.ep);
      const unrealizedPnl = parseFloat(positionUpdate.up || 0);
      const positionSide = positionUpdate.ps; // 'LONG', 'SHORT', or 'BOTH'

      if (positionAmount === 0) {
        // Position closed on this side
        if (positionSide === 'LONG') {
          this._longEntryPrice = null;
          this._longPositionSize = null;
          this.longPosition = null;
        } else if (positionSide === 'SHORT') {
          this._shortEntryPrice = null;
          this._shortPositionSize = null;
          this.shortPosition = null;
        } else {
          this._longEntryPrice = null;
          this._longPositionSize = null;
          this._shortEntryPrice = null;
          this._shortPositionSize = null;
          this.longPosition = null;
          this.shortPosition = null;
        }

        // If neither side has position, set to NONE
        if (this._longEntryPrice === null && this._shortEntryPrice === null) {
          if (this.currentPositionQuantity !== null && this.currentPositionQuantity > 0) {
            this.lastPositionQuantity = this.currentPositionQuantity;
          }
          if (this.positionEntryPrice !== null) {
            this.lastPositionEntryPrice = this.positionEntryPrice;
          }
          this.currentPosition = 'NONE';
          this.positionEntryPrice = null;
          this.currentPositionQuantity = null;
          this.positionSize = null;
        }
      } else if (positionAmount > 0) {
        const qty = Math.abs(positionAmount);
        const notional = qty * entryPrice;
        this.currentPosition = 'LONG';
        this.positionEntryPrice = entryPrice;
        this.currentPositionQuantity = qty;
        this.positionSize = notional;
        this.lastPositionQuantity = qty;
        this.lastPositionEntryPrice = entryPrice;
        this._longEntryPrice = entryPrice;
        this._longPositionSize = notional;
        // Preserve last-known liquidationPrice from REST; WS events don't carry it.
        const prevLongLiq = this.longPosition?.liquidationPrice ?? null;
        this.longPosition = { entryPrice, quantity: qty, notional, unrealizedPnl, liquidationPrice: prevLongLiq };
      } else if (positionAmount < 0) {
        const qty = Math.abs(positionAmount);
        const notional = qty * entryPrice;
        this.currentPosition = 'SHORT';
        this.positionEntryPrice = entryPrice;
        this.currentPositionQuantity = qty;
        this.positionSize = notional;
        this.lastPositionQuantity = qty;
        this.lastPositionEntryPrice = entryPrice;
        this._shortEntryPrice = entryPrice;
        this._shortPositionSize = notional;
        const prevShortLiq = this.shortPosition?.liquidationPrice ?? null;
        this.shortPosition = { entryPrice, quantity: qty, notional, unrealizedPnl, liquidationPrice: prevShortLiq };
      }
    }

    // Recompute derived hedge metrics after all per-side updates in this event
    if (this.longPosition && this.shortPosition) {
      this.hedgeGap = this.shortPosition.entryPrice - this.longPosition.entryPrice;
      const minQty = Math.min(this.longPosition.quantity, this.shortPosition.quantity);
      this.lockedProfit = this.hedgeGap * minQty;
    } else {
      this.hedgeGap = 0;
      this.lockedProfit = 0;
    }

    this.lastPositionUpdateFromWebSocket = Date.now();
    this.positionUpdatedViaWebSocket = true;
  }

  /**
   * Reconcile position state from REST after a user-data WS reconnect.
   * Catches any ACCOUNT_UPDATE / ORDER_TRADE_UPDATE events that fired while
   * the socket was disconnected. Maps the REST /fapi/v2/positionRisk response
   * shape into the ACCOUNT_UPDATE shape expected by _handleAccountUpdate().
   */
  async _reconcilePositionsAfterUserDataReconnect() {
    try {
      const rows = await this.makeProxyRequest(
        '/fapi/v2/positionRisk',
        'GET',
        { symbol: this.symbol },
        true,
        'futures'
      );
      if (!Array.isArray(rows)) return;

      const mapped = rows
        .filter(r => r.symbol === this.symbol && (r.positionSide === 'LONG' || r.positionSide === 'SHORT'))
        .map(r => ({
          s: r.symbol,
          pa: r.positionAmt,
          ep: r.entryPrice,
          up: r.unRealizedProfit || '0',
          ps: r.positionSide,
        }));

      if (mapped.length > 0) {
        await this.addLog('[Reconcile] Syncing position state from REST after User Data WS reconnect...');
        await this._handleAccountUpdate(mapped);
      }
    } catch (error) {
      await this.addLog(`WARN: [Reconcile] Failed to reconcile positions after reconnect: ${error.message}`);
    }
  }

  // ─── WebSocket: Liquidation stream ─────────────────────────────────────────
  // Replaces deprecated GET /fapi/v1/allForceOrders REST endpoint.
  // Aggregates forceOrder events into a 15m rolling buffer consumed by ai-market-context.

  connectLiquidationWebSocket() {
    if (this.liquidationReconnectTimeout) clearTimeout(this.liquidationReconnectTimeout);
    if (this.liquidationWsPingInterval) clearInterval(this.liquidationWsPingInterval);
    if (this.liquidationWsPingTimeout) clearTimeout(this.liquidationWsPingTimeout);
    if (this.liquidationWs) this.liquidationWs.close();

    const stream = `${this.symbol.toLowerCase()}@forceOrder`;

    const wsId = ++this._liquidationWsIdCounter;
    this._liquidationMessagesSeen = 0;
    this.addLog(`[DIAG] connectLiquidationWebSocket called. newWsId=${wsId}`);
    this.liquidationWs = new WebSocket(this._buildRelayWsUrl(stream));
    const currentWs = this.liquidationWs;

    this.liquidationWs.on('open', async () => {
      await this.addLog(`[DIAG] Liquidation WS ${wsId} OPEN`);
      await this.addLog('[WebSocket] Liquidation WS connected.');
      this.liquidationWsConnected = true;
      this._liqWsLastConnectedAt = Date.now();
      this.lastLiquidationTickAt = Date.now();
      this.liquidationReconnectAttempts = 0;
      if (this.liquidationReconnectTimeout) clearTimeout(this.liquidationReconnectTimeout);
      // Cancel the slow background retry — standard backoff handles it from here.
      if (this._liquidationBackgroundRetry) {
        clearInterval(this._liquidationBackgroundRetry);
        this._liquidationBackgroundRetry = null;
      }

      this.liquidationWsPingInterval = setInterval(() => {
        this.liquidationWs.ping();
        this.liquidationWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] Liquidation WS pong timeout. Terminating connection.');
          this.liquidationWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);

      // No stale-tick watchdog on liquidation stream — forceOrder is inherently
      // sporadic for a single symbol. Ping/pong (above) handles stuck-stream
      // detection without false-positive teardowns during quiet markets.
    });

    this.liquidationWs.on('pong', () => {
      if (this.liquidationWsPingTimeout) {
        clearTimeout(this.liquidationWsPingTimeout);
        this.liquidationWsPingTimeout = null;
      }
    });

    this.liquidationWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.lastLiquidationTickAt = Date.now();
        if (this._liquidationMessagesSeen < 3) {
          this._liquidationMessagesSeen++;
          await this.addLog(`[DIAG] Liquidation WS ${wsId} MESSAGE #${this._liquidationMessagesSeen} e=${message.e}`);
        }
        if (message.e !== 'forceOrder' || !message.o) return;
        const o = message.o;
        const avgPrice = parseFloat(o.ap);
        const filledQty = parseFloat(o.z);
        if (!isFinite(avgPrice) || !isFinite(filledQty) || filledQty <= 0) return;
        this._liqEvents.push({
          side: o.S, // 'SELL' = long liquidated, 'BUY' = short liquidated
          notional: avgPrice * filledQty,
          ts: o.T || Date.now(),
        });
      } catch (error) {
        console.error(`Error processing liquidation message: ${error.message}`);
        await this.addLog(`ERROR: [WS_MESSAGE] Liquidation message handler failed: ${error.message}`);
      }
    });

    this.liquidationWs.on('error', async (error) => {
      console.error(`Liquidation WebSocket error: ${error.message}`);
      await this.addLog(`ERROR: [WS_ERROR] Liquidation WebSocket error (wsId=${wsId}): ${error.message}`);
    });

    this.liquidationWs.on('close', async (code, reason) => {
      this.liquidationWsConnected = false;
      await this.addLog(`[DIAG] Liquidation WS ${wsId} CLOSE code=${code} reason=${reason || 'none'}`);
      await this.addLog('[WebSocket] Liquidation WebSocket closed.');
      if (this.liquidationWsPingInterval) clearInterval(this.liquidationWsPingInterval);
      if (this.liquidationWsPingTimeout) clearTimeout(this.liquidationWsPingTimeout);

      if (this.isRunning) {
        this.liquidationReconnectAttempts++;
        if (this.liquidationReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.liquidationReconnectAttempts - 1));
          await this.addLog(`[WebSocket] Liquidation WS disconnected. Scheduling reconnect in ${delay / 1000}s (Attempt ${this.liquidationReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          this.liquidationReconnectTimeout = setTimeout(() => {
            this.connectLiquidationWebSocket();
          }, delay);
        } else {
          // Standard backoff exhausted. Liquidation has no REST fallback (Binance
          // does not expose live liquidations via REST), so just keep poking the
          // WS forever at a slow cadence. On a successful reconnect, the on('open')
          // handler resets liquidationReconnectAttempts to 0 and the standard
          // backoff is available again from the next failure.
          if (!this._liquidationBackgroundRetry) {
            const everyMin = Math.round(LIQUIDATION_BACKGROUND_RETRY_INTERVAL_MS / 60000);
            await this.addLog(`ERROR: [CONNECTION_ERROR] Max Liquidation WS reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Switching to background retry every ${everyMin} min.`);
            this._liquidationBackgroundRetry = setInterval(() => {
              if (!this.isRunning) {
                clearInterval(this._liquidationBackgroundRetry);
                this._liquidationBackgroundRetry = null;
                return;
              }
              // Reset so the standard backoff schedule applies fresh from the next call.
              this.liquidationReconnectAttempts = 0;
              this.connectLiquidationWebSocket();
            }, LIQUIDATION_BACKGROUND_RETRY_INTERVAL_MS);
          }
        }
      }
    });
  }

  // Returns { longLiqVolume15m, shortLiqVolume15m, liqDominance, cascadeActive } or null.
  // ai-market-context adds isAbnormal on top using its own threshold.
  getLiquidationSnapshot() {
    // Never connected yet — no data at all
    if (!this._liqWsLastConnectedAt) return null;

    // Disconnected and stale beyond our comfort window → don't let AI trust an empty/old buffer
    if (!this.liquidationWsConnected && (Date.now() - this._liqWsLastConnectedAt > 5 * 60 * 1000)) {
      return null;
    }

    const cutoff = Date.now() - 15 * 60 * 1000;
    if (this._liqEvents.length > 0 && this._liqEvents[0].ts < cutoff) {
      this._liqEvents = this._liqEvents.filter(e => e.ts >= cutoff);
    }

    let longLiqVolume15m = 0;
    let shortLiqVolume15m = 0;
    const timestamps = [];

    for (const evt of this._liqEvents) {
      if (evt.side === 'SELL') longLiqVolume15m += evt.notional;
      else if (evt.side === 'BUY') shortLiqVolume15m += evt.notional;
      timestamps.push(evt.ts);
    }

    let liqDominance = 'BALANCED';
    if (longLiqVolume15m > shortLiqVolume15m * 2) liqDominance = 'LONG';
    else if (shortLiqVolume15m > longLiqVolume15m * 2) liqDominance = 'SHORT';

    let cascadeActive = false;
    if (timestamps.length >= 10) {
      timestamps.sort((a, b) => a - b);
      for (let i = 0; i <= timestamps.length - 10; i++) {
        if (timestamps[i + 9] - timestamps[i] <= 2 * 60 * 1000) {
          cascadeActive = true;
          break;
        }
      }
    }

    return { longLiqVolume15m, shortLiqVolume15m, liqDominance, cascadeActive };
  }

  // ─── ListenKey management ──────────────────────────────────────────────────

  async _retryListenKeyRequest(isRefresh = false) {
    const maxAttempts = MAX_RECONNECT_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const endpoint = '/fapi/v1/listenKey';
        const method = isRefresh ? 'PUT' : 'POST';
        const params = isRefresh ? { listenKey: this.listenKey } : {};

        const response = await this.makeProxyRequest(endpoint, method, params, true, 'futures');

        if (!isRefresh && response.listenKey) {
          this.listenKey = response.listenKey;
          await this.addLog(`[REST-API] ListenKey obtained successfully on attempt ${attempt}/${maxAttempts}.`);
          this.listenKeyRetryAttempts = 0;
          return response;
        } else if (isRefresh) {
          await this.addLog(`[REST-API] ListenKey refreshed successfully on attempt ${attempt}/${maxAttempts}.`);
          this.listenKeyRetryAttempts = 0;
          // L3: piggy-back the 30-min reconciliation sweep on the listenKey
          // refresh cadence. Listenkey refresh succeeding proves REST API is
          // reachable — natural precondition for the userTrades query.
          // Fire-and-forget so it doesn't block the refresh return.
          this._reconcileRecentTrades().catch((err) => {
            console.error(`[RECONCILE] Background reconciliation error: ${err.message}`);
          });
          return response;
        }
      } catch (error) {
        await this.addLog(`[REST-API] ListenKey ${isRefresh ? 'refresh' : 'request'} attempt ${attempt} failed: ${error.message}`);
        if (attempt < maxAttempts) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1));
          await this.addLog(`[REST-API] Retrying listenKey in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to ${isRefresh ? 'refresh' : 'obtain'} listenKey after ${maxAttempts} attempts.`);
          throw error;
        }
      }
    }

    throw new Error(`Failed to ${isRefresh ? 'refresh' : 'obtain'} listenKey after ${maxAttempts} attempts`);
  }

  /**
   * M1 — wait for WS to confirm an orderId fill (via _handleOrderTradeUpdate
   * setting _wsHandledOrderIds) before reading positions. The race we're
   * closing: REST ACK can land before the WS ACCOUNT_UPDATE for the same
   * fill, leaving longPosition/shortPosition reflecting the PRE-fill state.
   * The existing _refreshHedgePositions retry only triggers when both sides
   * are empty, so it doesn't catch "one side has the OLD quantity".
   *
   * Bounded by timeoutMs (default 1500ms — well past Binance's typical WS
   * propagation). Returns true if confirmed within the window, false on
   * timeout. Caller can still proceed on false; positions might be 100-
   * 500ms stale and the next price tick / replan will reconcile.
   */
  async _waitForOrderFillConfirmation(orderId, timeoutMs = 1500) {
    if (!orderId) return false;
    if (this._wsHandledOrderIds.has(orderId)) return true;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this._wsHandledOrderIds.has(orderId)) return resolve(true);
        if (Date.now() - startedAt >= timeoutMs) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /**
   * M3 fix: smart listenKey refresh handler invoked from the periodic
   * setInterval. Old behavior force-closed the user-data WS on a single
   * refresh-cycle failure — leaving the bot blind to fills for up to
   * 30 min until the next interval. Binance listenKeys live 60 min, so
   * we have ~30 min runway after a missed refresh before the key actually
   * expires.
   *
   * New behavior: on failure, schedule near-term retries (1min, 5min)
   * before falling back to WS close. _retryListenKeyRequest already
   * retries N times internally with backoff on each call, so this gives
   * us up to 3 separate retry rounds across 6 minutes before declaring
   * the key dead.
   */
  async _scheduledListenKeyRefresh() {
    if (!this.isRunning) return;
    try {
      await this._retryListenKeyRequest(true);
      this._listenKeyRefreshFailureCount = 0;
    } catch (error) {
      this._listenKeyRefreshFailureCount = (this._listenKeyRefreshFailureCount || 0) + 1;
      console.error(`Failed to refresh listenKey (#${this._listenKeyRefreshFailureCount}/3): ${error.message}`);
      await this.addLog(`ERROR: [CONNECTION_ERROR] ListenKey refresh failed (#${this._listenKeyRefreshFailureCount}/3): ${error.message}`);

      if (this._listenKeyRefreshFailureCount >= 3) {
        await this.addLog('ERROR: [CONNECTION_ERROR] 3 consecutive listenKey refresh failures — forcing user-data WS reconnect.');
        this._listenKeyRefreshFailureCount = 0;
        if (this.listenKeyRefreshInterval) {
          clearInterval(this.listenKeyRefreshInterval);
          this.listenKeyRefreshInterval = null;
        }
        if (this.userDataWs && this.userDataWs.readyState === 1) {
          this.userDataWs.close(1000, 'Reconnecting due to repeated listenKey refresh failures');
        }
        return;
      }

      // Schedule near-term retry: 1min after 1st failure, 5min after 2nd.
      const retryDelayMs = this._listenKeyRefreshFailureCount === 1 ? 60_000 : 5 * 60_000;
      await this.addLog(`[REST-API] Scheduling listenKey refresh retry in ${retryDelayMs / 1000}s.`);
      setTimeout(() => {
        if (this.isRunning) {
          this._scheduledListenKeyRefresh().catch(err => {
            console.error(`[REST-API] Retry scheduler error: ${err.message}`);
          });
        }
      }, retryDelayMs);
    }
  }

  async attemptUserDataReconnection() {
    if (!this.isRunning) return;
    if (this.userDataReconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      await this.addLog(`ERROR: [CONNECTION_ERROR] Max User Data WS reconnect attempts reached.`);
      return;
    }

    try {
      await this.addLog(`[WebSocket] Starting User Data WS reconnection attempt ${this.userDataReconnectAttempts}...`);

      if (this.listenKeyRefreshInterval) {
        clearInterval(this.listenKeyRefreshInterval);
        this.listenKeyRefreshInterval = null;
      }

      await this._retryListenKeyRequest(false);

      if (!this.listenKey) throw new Error('Failed to obtain listenKey');

      // Flag the next connectUserDataStream() open handler to run a REST
      // reconcile — catches any ACCOUNT_UPDATE / ORDER_TRADE_UPDATE events that
      // fired while the socket was down.
      this._needsUserDataReconcileOnOpen = true;
      this.connectUserDataStream();

      // M3: scheduledListenKeyRefresh handles retry-with-backoff before
      // falling back to WS close.
      this.listenKeyRefreshInterval = setInterval(() => {
        this._scheduledListenKeyRefresh();
      }, 30 * 60 * 1000);

    } catch (error) {
      console.error(`Failed to reconnect User Data WS: ${error.message}`);
      await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to reconnect User Data WS: ${error.message}`);

      if (this.userDataReconnectAttempts < MAX_RECONNECT_ATTEMPTS && this.isRunning) {
        this.userDataReconnectAttempts++;
        const retryDelay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.userDataReconnectAttempts - 1));
        await this.addLog(`[WebSocket] Scheduling retry in ${retryDelay / 1000}s...`);
        this.userDataReconnectTimeout = setTimeout(() => {
          this.attemptUserDataReconnection();
        }, retryDelay);
      }
    }
  }

  // ─── WebSocket health monitoring ───────────────────────────────────────────

  _startWebSocketHealthMonitoring() {
    if (this.wsHealthCheckInterval) clearInterval(this.wsHealthCheckInterval);
    this.wsHealthCheckInterval = setInterval(async () => {
      if (!this.userDataWsConnected) {
        await this.addLog('WARNING: [Health Check] User Data WebSocket is DISCONNECTED.');
      }
      if (!this.realtimeWsConnected) {
        await this.addLog('WARNING: [Health Check] Real-time Price WebSocket is DISCONNECTED.');
      }
      // Removed in v1.0.24: the 30-min stale-message check on user-data WS.
      // It produced false-alarm warnings during legitimate quiet periods because
      // Binance only pushes user-data events on actual position/balance changes
      // — a healthy hedge with no triggers can be silent for hours. Replaced
      // by the L1+L2+L3 defense (pong-driven health flag, conditional REST
      // fallback when unhealthy, periodic 30-min reconciliation) which catches
      // missed fills without false-alarming.
    }, 5 * 60 * 1000);
  }

  _stopWebSocketHealthMonitoring() {
    if (this.wsHealthCheckInterval) {
      clearInterval(this.wsHealthCheckInterval);
      this.wsHealthCheckInterval = null;
    }
  }

  // ─── Wallet balance ────────────────────────────────────────────────────────

  async getWalletBalance() {
    try {
      const accountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
      const totalWalletBalance = parseFloat(accountInfo.totalWalletBalance);
      return totalWalletBalance;
    } catch (error) {
      console.error(`Failed to get wallet balance: ${error.message}`);
      throw error;
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  cleanupWebSockets() {
    if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
    if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);
    if (this.realtimeWsStaleWatcher) clearInterval(this.realtimeWsStaleWatcher);
    if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
    if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);
    if (this.liquidationWsPingInterval) clearInterval(this.liquidationWsPingInterval);
    if (this.liquidationWsPingTimeout) clearTimeout(this.liquidationWsPingTimeout);
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);
    if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);
    if (this.liquidationReconnectTimeout) clearTimeout(this.liquidationReconnectTimeout);
    if (this.listenKeyRefreshInterval) clearInterval(this.listenKeyRefreshInterval);
    if (this._restPollInterval) clearInterval(this._restPollInterval);
    this._closeMonitorWs();
    if (this._liquidationBackgroundRetry) {
      clearInterval(this._liquidationBackgroundRetry);
      this._liquidationBackgroundRetry = null;
    }
    this._stopWebSocketHealthMonitoring();

    if (this.realtimeWs) {
      this.realtimeWs.removeAllListeners();
      this.realtimeWs.close();
      this.realtimeWs = null;
    }
    if (this.userDataWs) {
      this.userDataWs.removeAllListeners();
      this.userDataWs.close();
      this.userDataWs = null;
    }
    if (this.liquidationWs) {
      this.liquidationWs.removeAllListeners();
      this.liquidationWs.close();
      this.liquidationWs = null;
    }

    this.realtimeWsConnected = false;
    this.userDataWsConnected = false;
    this.liquidationWsConnected = false;
    this._liqEvents = [];
    this._liqWsLastConnectedAt = null;
  }

  // ─── Abstract methods (must be implemented by subclasses) ──────────────────

  /**
   * Called on every real-time price tick. Must be implemented by subclass.
   * @param {number} price — current price from WebSocket
   */
  async handleRealtimePrice(price) {
    throw new Error('handleRealtimePrice() must be implemented by subclass');
  }
}

export default TradingBase;
export { TradingBase, DEFAULT_LEVERAGE, INITIAL_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS, MAX_RECONNECT_ATTEMPTS };
