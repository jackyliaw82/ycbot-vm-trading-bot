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
    this.listenKey = null;
    this.listenKeyRefreshInterval = null;

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

    // Reconnection state
    this.realtimeReconnectAttempts = 0;
    this.userDataReconnectAttempts = 0;
    this.listenKeyRetryAttempts = 0;
    this.realtimeReconnectTimeout = null;
    this.userDataReconnectTimeout = null;
    this.isUserDataReconnecting = false;

    // Heartbeat timeouts/intervals
    this.realtimeWsPingTimeout = null;
    this.realtimeWsPingInterval = null;
    this.userDataWsPingTimeout = null;
    this.userDataWsPingInterval = null;

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
      await this.tradesCollectionRef.add(tradeData);

      // Broadcast trade to connected WebSocket clients
      wsBroadcast.pushTrade(this.strategyId, tradeData);
    } catch (error) {
      console.error(`Failed to save trade to Firestore: ${error.message}`);
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
    let adjustedQuantity = Math.ceil(rawQuantity / stepSize) * stepSize;
    adjustedQuantity = parseFloat(adjustedQuantity.toFixed(precision));

    if (adjustedQuantity < minQty) adjustedQuantity = minQty;
    if (adjustedQuantity > maxQty) adjustedQuantity = maxQty;

    const notionalValue = adjustedQuantity * priceUsedForCalculation;
    if (notionalValue < minNotional) {
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
      const result = await this.makeProxyRequest('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition }, true, 'futures');
      await this.addLog(`Position mode set to ${dualSidePosition ? 'Hedge' : 'One-way'}.`);
      return result;
    } catch (error) {
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
    const positions = await this.getCurrentPositions();
    const longPos = positions.find(p => parseFloat(p.positionAmt) > 0);
    const shortPos = positions.find(p => parseFloat(p.positionAmt) < 0);

    const result = {
      long: longPos ? {
        entryPrice: parseFloat(longPos.entryPrice),
        quantity: Math.abs(parseFloat(longPos.positionAmt)),
        notional: Math.abs(parseFloat(longPos.notional)),
        unrealizedPnl: parseFloat(longPos.unRealizedProfit || 0),
      } : null,
      short: shortPos ? {
        entryPrice: parseFloat(shortPos.entryPrice),
        quantity: Math.abs(parseFloat(shortPos.positionAmt)),
        notional: Math.abs(parseFloat(shortPos.notional)),
        unrealizedPnl: parseFloat(shortPos.unRealizedProfit || 0),
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

  // ─── WebSocket: Real-time price ────────────────────────────────────────────

  connectRealtimeWebSocket() {
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);
    if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
    if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);
    if (this.realtimeWs) this.realtimeWs.close();

    const wsBaseUrl = this.isTestnet === true
      ? 'wss://stream.binance.com/ws'
      : 'wss://fstream.binance.com/ws';

    const tickerStream = this.priceType === 'LAST'
      ? `${this.symbol.toLowerCase()}@ticker`
      : `${this.symbol.toLowerCase()}@markPrice@1s`;

    this.realtimeWs = new WebSocket(`${wsBaseUrl}/${tickerStream}`);

    this.realtimeWs.on('open', async () => {
      await this.addLog('[WebSocket] Real-time price WS connected.');
      this.realtimeWsConnected = true;
      this.realtimeReconnectAttempts = 0;
      if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);

      this.realtimeWsPingInterval = setInterval(() => {
        this.realtimeWs.ping();
        this.realtimeWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] Real-time WS pong timeout. Terminating connection.');
          this.realtimeWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
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
        if (this.priceType === 'LAST' && message.e === '24hrTicker') {
          await this.handleRealtimePrice(parseFloat(message.c));
        } else if (this.priceType === 'MARK' && message.e === 'markPriceUpdate') {
          await this.handleRealtimePrice(parseFloat(message.p));
        }
      } catch (error) {
        console.error(`Error processing price message: ${error.message}`);
      }
    });

    this.realtimeWs.on('error', (error) => {
      console.error(`Price WebSocket error: ${error.message}`);
    });

    this.realtimeWs.on('close', async (code, reason) => {
      this.realtimeWsConnected = false;
      await this.addLog('[WebSocket] Real-time price WebSocket closed.');
      if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
      if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);

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

    const wsBaseUrl = this.isTestnet === true
      ? 'wss://stream.binance.com/ws'
      : 'wss://fstream.binance.com/ws';

    this.userDataWs = new WebSocket(`${wsBaseUrl}/${this.listenKey}`);

    this.userDataWs.on('open', async () => {
      await this.addLog('[WebSocket] User Data WS connected.');
      this.userDataWsConnected = true;
      this.userDataReconnectAttempts = 0;
      if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);

      this.userDataWsPingInterval = setInterval(() => {
        this.userDataWs.ping();
        this.userDataWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] User Data WS pong timeout. Terminating connection.');
          this.userDataWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
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
          orderId: order.i,
          symbol: order.s,
          time: order.T,
          price: tradePrice,
          qty: tradeQty,
          quoteQty: tradePrice * tradeQty,
          commission,
          commissionAsset,
          realizedPnl,
          isBuyer: order.S === 'BUY',
          role: order.m ? 'Maker' : 'Taker',
        });
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
   */
  async _handleAccountUpdate(positions) {
    const positionUpdate = positions.find(p => p.s === this.symbol);
    if (!positionUpdate) return;

    const positionAmount = parseFloat(positionUpdate.pa);
    const entryPrice = parseFloat(positionUpdate.ep);
    const positionSide = positionUpdate.ps; // 'LONG', 'SHORT', or 'BOTH'

    if (positionAmount === 0) {
      // Position closed on this side
      if (positionSide === 'LONG') {
        this._longEntryPrice = null;
        this._longPositionSize = null;
      } else if (positionSide === 'SHORT') {
        this._shortEntryPrice = null;
        this._shortPositionSize = null;
      } else {
        this._longEntryPrice = null;
        this._longPositionSize = null;
        this._shortEntryPrice = null;
        this._shortPositionSize = null;
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
      this.currentPosition = 'LONG';
      this.positionEntryPrice = entryPrice;
      this.currentPositionQuantity = Math.abs(positionAmount);
      this.positionSize = Math.abs(positionAmount) * entryPrice;
      this.lastPositionQuantity = Math.abs(positionAmount);
      this.lastPositionEntryPrice = entryPrice;
      this._longEntryPrice = entryPrice;
      this._longPositionSize = Math.abs(positionAmount) * entryPrice;
    } else if (positionAmount < 0) {
      this.currentPosition = 'SHORT';
      this.positionEntryPrice = entryPrice;
      this.currentPositionQuantity = Math.abs(positionAmount);
      this.positionSize = Math.abs(positionAmount) * entryPrice;
      this.lastPositionQuantity = Math.abs(positionAmount);
      this.lastPositionEntryPrice = entryPrice;
      this._shortEntryPrice = entryPrice;
      this._shortPositionSize = Math.abs(positionAmount) * entryPrice;
    }

    this.lastPositionUpdateFromWebSocket = Date.now();
    this.positionUpdatedViaWebSocket = true;
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

      this.connectUserDataStream();

      this.listenKeyRefreshInterval = setInterval(async () => {
        try {
          await this._retryListenKeyRequest(true);
        } catch (error) {
          console.error(`Failed to refresh listenKey: ${error.message}`);
          await this.addLog(`ERROR: [CONNECTION_ERROR] ListenKey refresh failed: ${error.message}`);
          if (this.listenKeyRefreshInterval) {
            clearInterval(this.listenKeyRefreshInterval);
            this.listenKeyRefreshInterval = null;
          }
          if (this.userDataWs && this.userDataWs.readyState === 1) {
            this.userDataWs.close(1000, 'Reconnecting due to listenKey refresh failure');
          }
        }
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
    if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
    if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);
    if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);
    if (this.listenKeyRefreshInterval) clearInterval(this.listenKeyRefreshInterval);
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

    this.realtimeWsConnected = false;
    this.userDataWsConnected = false;
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
