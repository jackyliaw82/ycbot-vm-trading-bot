import { Firestore } from '@google-cloud/firestore';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { sendStrategyCompletionNotification, sendCapitalProtectionNotification, sendReversalNotification } from './pushNotificationHelper.js';

// Constants for WebSocket reconnection
const INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
const MAX_RECONNECT_DELAY_MS = 60000; // 60 seconds
const MAX_RECONNECT_ATTEMPTS = 10; // Max attempts before giving up or requiring manual intervention

// Heartbeat constants
const PING_INTERVAL_MS = 30000; // Send ping every 30 seconds
const PONG_TIMEOUT_MS = 10000; // Expect pong within 10 seconds

// Desired profit percentage
// DESIRED_PROFIT_PERCENTAGE is now dynamically calculated based on exitCount

// Capital Protection Constants
const MAX_LOSS_PERCENTAGE = 100; // Circuit breaker triggers at 30% loss, 100% locks no capital protection
const WARNING_LOSS_PERCENTAGE = 20; // Warning threshold at 20% loss

// Platform Fee Constants
const PLATFORM_FEE_PERCENTAGE = 15; // 15% platform fee on profits

class TradingStrategy {
  constructor(gcfProxyUrl, profileId, sharedVmProxyGcfUrl) {
    // Initialize Firestore project ID and database ID
    this.firestore = new Firestore({
      ignoreUndefinedProperties: true,
      projectId: 'ycbot-6f336',
      databaseId: '(default)',
    });
    this.tradesCollectionRef = null; // Initialized here, set in start() and loadState()
    this.logsCollectionRef = null; // Firestore collection for logs
    this.realtimeWs = null;
    this.userDataWs = null; // WebSocket for User Data Stream
    this.listenKey = null; // Binance listenKey for User Data Stream
    this.listenKeyRefreshInterval = null; // Interval for refreshing listenKey
    this.strategyId = null; // Will be set uniquely in start() or loadState()
    this.isRunning = false;
    this.isStopping = false; // Add isStopping flag
    this.gcfProxyUrl = gcfProxyUrl; // This is the profile-specific binance-proxy GCF URL
    this.profileId = profileId; // Store the profileId for authentication and logging
    this.sharedVmProxyGcfUrl = sharedVmProxyGcfUrl; // Store the shared VM proxy GCF URL
    
    // Dynamic threshold trading strategy state variables
    this.entryLevel = null;
    this.reversalLevel = null;
    this.enableSupport = false; // Indicates if support zone is active for initial entry
    this.enableResistance = false; // Indicates if resistance zone is active for initial entry
    this.currentPosition = 'NONE'; // 'LONG' | 'SHORT' | 'NONE'
    this.positionEntryPrice = null;
    this.positionSize = null; // in notional USDT
    this.activeMode = 'NONE'; // 'RESISTANCE_ZONE' | 'SUPPORT_ZONE' | 'NONE'
    
    // Real-time price and PnL for status checks
    this.currentPrice = null;
    this.positionPnL = null; // Single position PnL
    this.totalPnL = null;

    // PnL breakdown variables (overall accumulated)
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;

    // Position quantity tracking
    this.entryPositionQuantity = null; // Quantity of the position at initial entry (in base asset, e.g., BTC)
    this.currentPositionQuantity = null; // Current quantity of the open position
    this.feeRate = 0.0005; // 0.05% for Binance Futures (Taker fee)

    // Persistent position tracking for historical analysis (not reset when position closes)
    this.lastPositionQuantity = null; // Last active position quantity (preserved for historical data)
    this.lastPositionEntryPrice = null; // Last active position entry price (preserved for historical data)

    // Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null;
    this.finalTpPercentage = null;

    // Reversal level percentage
    this.reversalLevelPercentage = null; // Initialize to null, will be set from config

    // New Order Type and Direction states
    this.orderType = 'MARKET'; // 'LIMIT' | 'MARKET'
    this.buyLongEnabled = false;
    this.sellShortEnabled = false;
    this.buyLimitPrice = null;
    this.sellLimitPrice = null;
    this.longLimitOrderId = null; // To store the orderId of a pending LONG LIMIT order
    this.shortLimitOrderId = null; // To store the orderId of a pending SHORT LIMIT order

    // WebSocket connection statuses (to be reported to frontend)
    this.realtimeWsConnected = false;
    this.userDataWsConnected = false;

    // WebSocket reconnection state
    this.realtimeReconnectAttempts = 0;
    this.userDataReconnectAttempts = 0;
    this.realtimeReconnectTimeout = null;
    this.userDataReconnectTimeout = null;

    // Heartbeat timeouts and intervals
    this.realtimeWsPingTimeout = null;
    this.realtimeWsPingInterval = null;
    this.userDataWsPingTimeout = null;
    this.userDataWsPingInterval = null;
    
    // Configuration
    this.symbol = 'BTCUSDT'; // Default trading symbol
    this.positionSizeUSDT = 0; // Default position size in USDT

    // Dynamic Position Sizing Constants
    this.initialBasePositionSizeUSDT = null; // Initialized to null, must come from config or loaded state
    this.RECOVERY_FACTOR = 0.1; // Percentage of accumulated loss to target for recovery in next trade's TP
    this.MAX_POSITION_SIZE_USDT = 0; // Will be set dynamically in start()
    this.RECOVERY_DISTANCE = 0.005; //0.5%

    // Binance exchange info cache for precision and step size
    this.exchangeInfoCache = {}; // Stores tickSize, stepSize, minQty, maxQty, minNotional for each symbol
    
    // Testnet status
    this.isTestnet = null;

    // Map to store pending order promises, resolving when order is filled/rejected
    this.pendingOrders = new Map();
    // NEW: Map to store timeout IDs for initial LIMIT orders
    this.pendingInitialLimitOrders = new Map();

    // Flag for pending log message after position update
    this._pendingLogMessage = null;

    // Summary section data
    this.reversalCount = 0;
    this.exitCount = 0;
    this.tradeSequence = '';
    this.initialWalletBalance = null;
    this.profitPercentage = null;
    this.strategyStartTime = null;
    this.strategyEndTime = null;

    // Flag to prevent overlapping trading sequences
    this.isTradingSequenceInProgress = false;

    // Capital Protection Properties
    this.capitalProtectionTriggered = false;
    this.capitalProtectionWarning = false;
    this.maxAllowableLoss = null;
    this.circuitBreakerTimestamp = null;

    // Exit threshold - middle point between entry and reversal level
    this.exitThreshold = null;

    // Re-entry monitoring state
    this.reentryMonitoring = false; // Tracks if we're monitoring for re-entry after position close at exit threshold
    this.reentryLevel = null; // Entry level price for re-entry monitoring
    this.previousPositionDirection = null; // Stores 'LONG' or 'SHORT' to maintain same direction on re-entry

    // WebSocket position update tracking (for ACCOUNT_UPDATE events)
    this.lastPositionUpdateFromWebSocket = null; // Timestamp of last WebSocket position update
    this.positionUpdatedViaWebSocket = false; // Flag indicating if position was updated via WebSocket

    // Bind methods to ensure 'this' context is correct
    this.connectRealtimeWebSocket = this.connectRealtimeWebSocket.bind(this); // Renamed
    this.connectUserDataStream = this.connectUserDataStream.bind(this);
  }

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
    
    // Filter out specific messages from being broadcast to the frontend
    const messagesToFilter = [
      'WebSocket client connected for logs',
      'WebSocket client disconnected for logs'
    ];

    // Save log to Firestore
    if (this.strategyId && !messagesToFilter.some(filterMsg => message.includes(filterMsg))) {
      try {
        await this.logsCollectionRef.add({
          message: logEntry, // Use the prefixed logEntry for Firestore
          timestamp: now, // Use the Date object directly for Firestore Timestamp
        });
      } catch (error) {
        console.error('Failed to save log to Firestore:', error);
      }
    }
  }

  // Helper to calculate a price adjusted by a percentage
  _calculateAdjustedPrice(basePrice, percentage, increase) {
    const factor = percentage / 100;
    if (increase) {
      return this.roundPrice(basePrice * (1 + factor));
    } else {
      return this.roundPrice(basePrice * (1 - factor));
    }
  }

  calculateCurrentLoss() {
    const netLoss = -(this.accumulatedRealizedPnL - this.accumulatedTradingFees);
    return netLoss > 0 ? netLoss : 0;
  }

  calculateLossPercentage() {
    if (!this.initialWalletBalance || this.initialWalletBalance <= 0) {
      return 0;
    }
    const currentLoss = this.calculateCurrentLoss();
    return (currentLoss / this.initialWalletBalance) * 100;
  }

  async checkCapitalProtection() {
    if (this.capitalProtectionTriggered) {
      await this.addLog('CAPITAL PROTECTION: Trading blocked. Circuit breaker already triggered.');
      return false;
    }

    if (!this.initialWalletBalance || this.initialWalletBalance <= 0) {
      return true;
    }

    const lossPercentage = this.calculateLossPercentage();

    if (lossPercentage >= WARNING_LOSS_PERCENTAGE && !this.capitalProtectionWarning) {
      this.capitalProtectionWarning = true;
      await this.addLog(`CAPITAL PROTECTION WARNING: Loss at ${lossPercentage.toFixed(2)}%. Approaching 30% threshold.`);
      await this.saveState();
    }

    if (lossPercentage >= MAX_LOSS_PERCENTAGE) {
      this.capitalProtectionTriggered = true;
      this.circuitBreakerTimestamp = new Date();
      const currentLoss = this.calculateCurrentLoss();

      await this.addLog(`CAPITAL PROTECTION CIRCUIT BREAKER TRIGGERED!`);
      await this.addLog(`Loss: ${currentLoss.toFixed(2)} USDT (${lossPercentage.toFixed(2)}% of initial capital)`);
      await this.addLog(`Realized PnL: ${this.accumulatedRealizedPnL.toFixed(2)} USDT`);
      await this.addLog(`Trading Fees: ${this.accumulatedTradingFees.toFixed(2)} USDT`);
      await this.addLog(`Trading stopped automatically to protect remaining capital.`);

      await this.saveState();

      if (this.currentPosition !== 'NONE') {
        await this.addLog('Closing open position due to circuit breaker...');
        try {
          await this.closeCurrentPosition();
          await this._waitForPositionChange('NONE');
          await this.addLog('Position closed successfully.');
        } catch (error) {
          await this.addLog(`ERROR closing position: ${error.message}`);
        }
      }

      await this.stop();
      return false;
    }

    return true;
  }

  async saveState() {
    if (!this.strategyId) return;
    
    try {
      const dataToSave = {
        profileId: this.profileId, // ADDED: Save profileId to Firestore
        entryLevel: this.entryLevel,
        reversalLevel: this.reversalLevel,
        enableSupport: this.enableSupport,
        enableResistance: this.enableResistance,
        currentPosition: this.currentPosition,
        positionEntryPrice: this.positionEntryPrice,
        positionSize: this.positionSize,
        activeMode: this.activeMode,
        currentPrice: this.currentPrice,
        positionPnL: this.positionPnL,
        totalPnL: this.totalPnL,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        lastUpdated: new Date(),
        isRunning: this.isRunning,
        symbol: this.symbol,
        positionSizeUSDT: this.positionSizeUSDT,
        initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
        MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT, // ADDED THIS LINE
        reversalLevelPercentage: this.reversalLevelPercentage,
        // Position quantity tracking
        entryPositionQuantity: this.entryPositionQuantity,
        currentPositionQuantity: this.currentPositionQuantity,
        // Persistent position tracking for historical analysis
        lastPositionQuantity: this.lastPositionQuantity,
        lastPositionEntryPrice: this.lastPositionEntryPrice,
        // Final TP states
        breakevenPrice: this.breakevenPrice,
        finalTpPrice: this.finalTpPrice,
        finalTpActive: this.finalTpActive,
        finalTpOrderSent: this.finalTpOrderSent,
        breakevenPercentage: this.breakevenPercentage,
        finalTpPercentage: this.finalTpPercentage,
        // Order Type and Direction states
        orderType: this.orderType,
        buyLongEnabled: this.buyLongEnabled,
        sellShortEnabled: this.sellShortEnabled,
        buyLimitPrice: this.buyLimitPrice,
        sellLimitPrice: this.sellLimitPrice,
        longLimitOrderId: this.longLimitOrderId,
        shortLimitOrderId: this.shortLimitOrderId,
        // Summary section data
        reversalCount: this.reversalCount,
        exitCount: this.exitCount,
        tradeSequence: this.tradeSequence,
        initialWalletBalance: this.initialWalletBalance,
        profitPercentage: this.profitPercentage,
        strategyStartTime: this.strategyStartTime,
        strategyEndTime: this.strategyEndTime,
        // Capital Protection fields
        capitalProtectionTriggered: this.capitalProtectionTriggered,
        capitalProtectionWarning: this.capitalProtectionWarning,
        maxAllowableLoss: this.maxAllowableLoss,
        circuitBreakerTimestamp: this.circuitBreakerTimestamp,
        // Exit threshold and re-entry monitoring state
        exitThreshold: this.exitThreshold,
        reentryMonitoring: this.reentryMonitoring,
        reentryLevel: this.reentryLevel,
        previousPositionDirection: this.previousPositionDirection,
      };

      await this.firestore
        .collection('strategies')
        .doc(this.strategyId)
        .update(dataToSave);
    } catch (error) {
      console.error('Failed to save state to Firestore:', error);
      await this.addLog('Failed to save state to Firestore:', error);
    }
  }

  async loadState(strategyId) {
    try {
      const doc = await this.firestore
        .collection('strategies')
        .doc(strategyId)
        .get();
      
      if (doc.exists) {
        const data = doc.data();
        this.strategyId = strategyId; // Set strategyId on load
        this.profileId = data.profileId; // ADDED: Load profileId
        this.entryLevel = data.entryLevel || null;
        this.reversalLevel = data.reversalLevel || null;
        this.enableSupport = data.enableSupport || false;
        this.enableResistance = data.enableResistance || false;
        this.currentPosition = data.currentPosition || 'NONE';
        this.positionEntryPrice = data.positionEntryPrice;
        this.positionSize = data.positionSize;
        this.activeMode = data.activeMode || 'NONE';
        this.currentPrice = data.currentPrice || null;
        this.positionPnL = data.positionPnL || null;
        this.totalPnL = data.totalPnL || null;
        this.accumulatedRealizedPnL = data.accumulatedRealizedPnL || 0;
        this.accumulatedTradingFees = data.accumulatedTradingFees || 0;
        this.symbol = data.symbol || 'BTCUSDT';
        this.isRunning = data.isRunning || false;

        // Strictly load positionSizeUSDT and initialBasePositionSizeUSDT
        this.positionSizeUSDT = data.positionSizeUSDT;
        this.initialBasePositionSizeUSDT = data.initialBasePositionSizeUSDT;
        this.MAX_POSITION_SIZE_USDT = data.MAX_POSITION_SIZE_USDT; // Load MAX_POSITION_SIZE_USDT
        // Recalculate MAX_POSITION_SIZE_USDT on load to ensure consistency with current logic
        if (this.initialBasePositionSizeUSDT !== null && this.initialBasePositionSizeUSDT > 0) {
            this.MAX_POSITION_SIZE_USDT = (3 / 4) * this.initialBasePositionSizeUSDT * 50;
        } else {
            this.MAX_POSITION_SIZE_USDT = 0;
        }


        // Validate loaded values
        if (this.positionSizeUSDT === null || this.positionSizeUSDT === undefined || this.positionSizeUSDT <= 0 ||
            this.initialBasePositionSizeUSDT === null || this.initialBasePositionSizeUSDT === undefined || this.initialBasePositionSizeUSDT <= 0) {
            throw new Error('Loaded strategy state is missing valid position size data (positionSizeUSDT or initialBasePositionSizeUSDT).');
        }

        this.reversalLevelPercentage = data.reversalLevelPercentage !== undefined ? data.reversalLevelPercentage : null; // Add to loadState

        // Load Position quantity tracking
        this.entryPositionQuantity = data.entryPositionQuantity || null;
        this.currentPositionQuantity = data.currentPositionQuantity || null;
        this.feeRate = 0.0005; // Ensure fee rate is set on load

        // Load Persistent position tracking for historical analysis
        this.lastPositionQuantity = data.lastPositionQuantity || null;
        this.lastPositionEntryPrice = data.lastPositionEntryPrice || null;

        // Load Final TP states
        this.breakevenPrice = data.breakevenPrice || null;
        this.finalTpPrice = data.finalTpPrice || null;
        this.finalTpActive = data.finalTpActive || false;
        this.finalTpOrderSent = data.finalTpOrderSent || false;
        this.breakevenPercentage = data.breakevenPercentage || null;
        this.finalTpPercentage = data.finalTpPercentage || null;

        // Load Order Type and Direction states
        this.orderType = data.orderType || 'MARKET';
        this.buyLongEnabled = data.buyLongEnabled || false;
        this.sellShortEnabled = data.sellShortEnabled || false;
        this.buyLimitPrice = data.buyLimitPrice || null;
        this.sellLimitPrice = data.sellLimitPrice || null;
        this.longLimitOrderId = data.longLimitOrderId || null;
        this.shortLimitOrderId = data.shortLimitOrderId || null;

        // Load Summary section data
        this.reversalCount = data.reversalCount || 0;
        this.exitCount = data.exitCount || 0;
        this.tradeSequence = data.tradeSequence || '';
        this.initialWalletBalance = data.initialWalletBalance || null;
        this.profitPercentage = data.profitPercentage || null;
        this.strategyStartTime = data.strategyStartTime ? data.strategyStartTime.toDate() : null;
        this.strategyEndTime = data.strategyEndTime ? data.strategyEndTime.toDate() : null;

        // Load Capital Protection fields
        this.capitalProtectionTriggered = data.capitalProtectionTriggered || false;
        this.capitalProtectionWarning = data.capitalProtectionWarning || false;
        this.maxAllowableLoss = data.maxAllowableLoss || null;
        this.circuitBreakerTimestamp = data.circuitBreakerTimestamp ? data.circuitBreakerTimestamp.toDate() : null;

        // Load Exit threshold and re-entry monitoring state
        this.exitThreshold = data.exitThreshold || null;
        this.reentryMonitoring = data.reentryMonitoring || false;
        this.reentryLevel = data.reentryLevel || null;
        this.previousPositionDirection = data.previousPositionDirection || null;
        
        await this._getExchangeInfo(this.symbol); // Use the new method to fetch and cache exchange info

        this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
        this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs');

        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to load state from Firestore:', error);
      await this.addLog('Failed to load state from Firestore:', error);
      return false;
    }
  }

  // Make API calls through GCF proxy
  async makeProxyRequest(endpoint, method = 'GET', params = {}, signed = false, apiType = 'futures') {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-User-Id': this.profileId, // Use this.profileId for X-User-Id header
      };

      // MODIFIED: Call the shared VM proxy GCF
      const response = await fetch(this.sharedVmProxyGcfUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          endpoint,
          method,
          params,
          signed,
          apiType,
          profileBinanceApiGcfUrl: this.gcfProxyUrl,
        }),
      });

      // Update testnet status from proxy response
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
          // Binance API errors typically have 'code' and 'msg' fields
          if (errorData && errorData.code && errorData.msg) {
            binanceErrorCode = errorData.code;
            binanceErrorMessage = errorData.msg;
            errorDetails = `Binance API Error: ${binanceErrorCode} - ${binanceErrorMessage}`;
          } else if (errorData && errorData.error) {
            // Fallback for other error formats
            errorDetails = `Proxy Error: ${response.status} - ${errorData.error}`;
          }
        } catch (parseError) {
          console.error('Failed to parse error response from Binance:', parseError);
        }
        
        // Log the detailed error to the frontend
        await this.addLog(`API Request Failed: ${errorDetails}`);
        
        // Throw a new error with the detailed message to be caught by the outer try-catch
        const err = new Error(errorDetails);
        err.binanceErrorCode = binanceErrorCode;
        err.binanceErrorMessage = binanceErrorMessage;
        throw err;
      }

      return await response.json();
    } catch (error) {
      console.error('Proxy request failed:', error);
      throw error; // Re-throw the error for calling functions to handle
    }
  }

  // Utility to get number of decimal places from a step/tick size
  _getPrecision(value) {
    if (value === null || value === undefined || value === 0) return 0;
    const parts = value.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }

  // Format price to the correct tick size precision
  _formatPrice(price) {
    if (price === null || price === undefined) return 'N/A';
    const symbolInfo = this.exchangeInfoCache[this.symbol];
    const precision = symbolInfo && symbolInfo.tickSize !== undefined
      ? this._getPrecision(symbolInfo.tickSize)
      : 2; // Default to 2 decimal places for price
    return price.toFixed(precision);
  }

  // Format quantity to the correct step size precision
  _formatQuantity(quantity) {
    if (quantity === null || quantity === undefined) return 'N/A';
    const symbolInfo = this.exchangeInfoCache[this.symbol];
    const precision = symbolInfo && symbolInfo.stepSize !== undefined
      ? this._getPrecision(symbolInfo.stepSize)
      : 6; // Default to 6 decimal places for quantity
    return quantity.toFixed(precision);
  }

  // Format notional value (USDT) to a reasonable precision
  _formatNotional(notional) {
    if (notional === null || notional === undefined || isNaN(notional)) return 'N/A';
    return notional.toFixed(2); // Notional values are typically in USDT, 2 decimal places is common
  }

  // Fetch exchange information for precision rules and cache it
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
          } else {
            console.warn(`[${symbol}] MIN_NOTIONAL filter found but value is invalid:`, minNotionalFilter);
            console.warn(`[${symbol}] Using default minNotional: ${minNotional} USDT`);
          }
        } else {
          console.warn(`[${symbol}] MIN_NOTIONAL filter not found. Using default: ${minNotional} USDT`);
        }

        this.exchangeInfoCache[symbol] = {
          tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
          stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.000001,
          minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0,
          maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : Infinity,
          minNotional: minNotional,
          precision: lotSizeFilter ? this._getPrecision(parseFloat(lotSizeFilter.stepSize)) : 6, // Store precision for quantity
        };
        await this.addLog(`Exchange info cached for ${symbol}: minNotional=${this._formatNotional(this.exchangeInfoCache[symbol].minNotional)} USDT, stepSize=${this.exchangeInfoCache[symbol].stepSize}, minQty=${this.exchangeInfoCache[symbol].minQty}`);
        return this.exchangeInfoCache[symbol];
      }
      throw new Error(`Symbol ${symbol} not found in exchange info.`);
    } catch (error) {
      console.error(`Failed to fetch exchange info: ${error.message}`);
      throw error;
    }
  }

  // Get exchange information from cache or fetch it
  async _getExchangeInfo(symbol) {
    if (this.exchangeInfoCache[symbol]) {
      return this.exchangeInfoCache[symbol];
    }
    return this._fetchAndCacheExchangeInfo(symbol);
  }

  // Get current price for a symbol
  async _getCurrentPrice(symbol) {
    try {
      const ticker = await this.makeProxyRequest('/fapi/v1/ticker/price', 'GET', { symbol }, false, 'futures');
      return parseFloat(ticker.price);
    } catch (error) {
      this.addLog(`Error fetching current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  // Round price to the correct tick size
  roundPrice(price) {
    const symbolInfo = this.exchangeInfoCache[this.symbol];
    if (!symbolInfo || !symbolInfo.tickSize) return price;
    const precision = this._getPrecision(symbolInfo.tickSize);
    return parseFloat(price.toFixed(precision));
  }

  // Round quantity to the correct step size
  roundQuantity(quantity) {
    const symbolInfo = this.exchangeInfoCache[this.symbol];
    if (!symbolInfo || !symbolInfo.stepSize) return quantity;
    const precision = this._getPrecision(symbolInfo.stepSize);
    return parseFloat(quantity.toFixed(precision));
  }

  // Calculate adjusted quantity based on USDT amount, current price, and exchange rules
  async _calculateAdjustedQuantity(symbol, positionSizeUSDT, calculationPrice = null) { // Added calculationPrice parameter
    let priceUsedForCalculation;
    let priceSource;

    if (calculationPrice !== null && calculationPrice > 0) {
      priceUsedForCalculation = calculationPrice;
      priceSource = 'specified limit price';
    } else {
      priceUsedForCalculation = await this._getCurrentPrice(symbol);
      priceSource = 'current market price';
    }

    if (!priceUsedForCalculation || priceUsedForCalculation <= 0) {
      throw new Error(`Invalid price for ${symbol}: ${priceUsedForCalculation}`);
    }

    const { minQty, maxQty, stepSize, precision, minNotional } = await this._getExchangeInfo(symbol);

    let rawQuantity = positionSizeUSDT / priceUsedForCalculation;

    // Round up to the nearest step
    let adjustedQuantity = Math.ceil(rawQuantity / stepSize) * stepSize;

    // Apply precision
    adjustedQuantity = parseFloat(adjustedQuantity.toFixed(precision));

    // Validate against min/max qty
    if (adjustedQuantity < minQty) {
      this.addLog(`Calculated quantity ${adjustedQuantity} is less than minQty ${minQty}. Adjusting to minQty.`);
      adjustedQuantity = minQty;
    }
    if (adjustedQuantity > maxQty) {
      this.addLog(`Calculated quantity ${adjustedQuantity} is greater than maxQty ${maxQty}. Adjusting to maxQty.`);
      adjustedQuantity = maxQty;
    }

    // Validate against MIN_NOTIONAL
    const notionalValue = adjustedQuantity * priceUsedForCalculation;
    if (notionalValue < minNotional) {
        this.addLog(`Notional value ${this._formatNotional(notionalValue)} USDT below MIN_NOTIONAL ${this._formatNotional(minNotional)} USDT.`);
        this.addLog(`Adjusting quantity from ${adjustedQuantity} to meet MIN_NOTIONAL of ${this._formatNotional(minNotional)} USDT.`);
        adjustedQuantity = Math.ceil(minNotional / priceUsedForCalculation / stepSize) * stepSize;
        adjustedQuantity = parseFloat(adjustedQuantity.toFixed(precision));
        const newNotionalValue = adjustedQuantity * priceUsedForCalculation;
        this.addLog(`Adjusted quantity to ${adjustedQuantity} (notional: ${this._formatNotional(newNotionalValue)} USDT) to meet minNotional.`);
    }

    this.addLog(`Calculated adjusted quantity for ${symbol}: ${adjustedQuantity} (from ${this._formatNotional(positionSizeUSDT)} USDT at ${this._formatPrice(priceUsedForCalculation)} ${priceSource})`);
    return adjustedQuantity;
  }

  // Save trade details to Firestore
  async saveTrade(tradeDetails) {
    if (!this.tradesCollectionRef) {
      console.error('Cannot save trade: tradesCollectionRef is not initialized.');
      return;
    }
    try {
      await this.tradesCollectionRef.add({
        ...tradeDetails,
        timestamp: new Date(),
        strategyId: this.strategyId,
      });
      //await this.addLog(`Trade added to Firestore: ${tradeDetails.qty} at ${tradeDetails.price}`); //Keep for future use
    } catch (error) {
      console.error(`Failed to save trade to Firestore: ${error.message}`);
    }
  }

  // Set leverage for the trading symbol
  async setLeverage(symbol, leverage) {
    try {
      const result = await this.makeProxyRequest('/fapi/v1/leverage', 'POST', {
        symbol,
        leverage,
      }, true, 'futures');
      
      //await this.addLog(`Leverage set to ${leverage}x for ${symbol}.`);
      return result;
    } catch (error) {
      console.error(`Failed to set leverage: ${error.message}`);
      throw error;
    }
  }

  // Get current position mode (Hedge or One-way)
  async getPositionMode() {
    try {
      const result = await this.makeProxyRequest('/fapi/v1/positionSide/dual', 'GET', {}, true, 'futures');
      //await this.addLog(`Position mode: ${result.dualSidePosition ? 'Hedge' : 'One-way'}.`);
      return result;
    } catch (error) {
      console.error(`Failed to get position mode: ${error.message}`);
      throw error;
    }
  }

  // Set position mode to one-way (no hedging needed for this strategy)
  async setPositionMode(dualSidePosition) {
    try {
      const result = await this.makeProxyRequest('/fapi/v1/positionSide/dual', 'POST', {
        dualSidePosition,
      }, true, 'futures');
      
      await this.addLog(`Position mode set to ${dualSidePosition ? 'Hedge' : 'One-way'}.`);
      return result;
    } catch (error) {
      // Handle specific error if mode is already set
      if (error.message.includes('-4059') && error.message.includes('No need to change position side')) {
        await this.addLog(`Pos. mode already One-way.`);
        return { dualSidePosition };
      }
      console.error(`Failed to set position mode: ${error.message}`);
      throw error;
    }
  }

  // Get current open positions for the trading symbol
  async getCurrentPositions() {
    try {
      const accountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
      
      // Filter positions with non-zero amounts for the current symbol
      const openPositions = accountInfo.positions.filter(pos => 
        parseFloat(pos.positionAmt) !== 0 && pos.symbol === this.symbol
      );
      
      return openPositions;
    } catch (error) {
      console.error(`Failed to get current positions: ${error.message}`);
      return [];
    }
  }

  // Check for any existing open orders or positions
  async _checkExistingOrdersAndPositions() {
    //await this.addLog('Checking for existing open orders or positions...');
    try {
      const openOrders = await this.makeProxyRequest('/fapi/v1/openOrders', 'GET', { symbol: this.symbol }, true, 'futures');
      if (openOrders && openOrders.length > 0) {
        throw new Error(`Existing open orders found for ${this.symbol}. Please cancel them before starting the strategy.`);
      }
      const currentPositions = await this.getCurrentPositions();
      if (currentPositions && currentPositions.length > 0) {
        throw new Error(`Existing open positions found for ${this.symbol}. Please close them before starting the strategy.`);
      }
      //await this.addLog('No existing open orders or positions found. Proceeding.');
    } catch (error) {
      await this.addLog(`Pre-start check failed: ${error.message}`);
      throw error; // Re-throw to stop strategy startup
    }
  }

  // Place a market order and return a Promise that resolves upon order fill
  async placeMarketOrder(symbol, side, quantity) {
    // quantity here is already adjusted by _calculateAdjustedQuantity
    if (quantity <= 0) {
      throw new Error('Calculated quantity is zero or negative.');
    }

    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', {
          symbol,
          side,
          type: 'MARKET',
          quantity: quantity,
          newOrderRespType: 'FULL' // Request full response for orderId
        }, true, 'futures');
        
        if (result && result.orderId) {
          this.pendingOrders.set(result.orderId, { resolve, reject });
          resolve(result); // Resolve immediately with order details
        } else {
          reject(new Error('Order placement failed: No orderId in response.'));
        }
      } catch (error) {
        reject(error); // Re-throw for calling function to handle
      }
    });
  }

  // NEW: Helper to query order status via REST API
  async _queryOrder(symbol, orderId) {
    try {
      const order = await this.makeProxyRequest('/fapi/v1/order', 'GET', { symbol, orderId }, true, 'futures');
      return order;
    } catch (error) {
      this.addLog(`Error querying order ${orderId}: ${error.message}`);
      throw error;
    }
  }

  // Place a limit order and return the initial order response
  async placeLimitOrder(symbol, side, quantity, price) {
    if (quantity <= 0) {
      throw new Error('Calculated quantity is zero or negative.');
    }
    if (price <= 0) {
      throw new Error('Limit price is zero or negative.');
    }

    const roundedPrice = this.roundPrice(price);
    const roundedQuantity = this.roundQuantity(quantity);

    try {
      const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', {
        symbol,
        side,
        type: 'LIMIT',
        quantity: roundedQuantity,
        price: roundedPrice,
        timeInForce: 'GTC', // Good Till Cancelled
        newOrderRespType: 'FULL'
      }, true, 'futures');

      if (result && result.orderId) {
        await this.addLog(`Placed LIMIT ${side} order ${result.orderId} for ${roundedQuantity} at ${roundedPrice}.`);
        return result; // Return the initial order response immediately
      } else {
        throw new Error('Limit order placement failed: No orderId in response.');
      }
    } catch (error) {
      await this.addLog(`Failed to place limit order: ${error.message}`);
      throw error;
    }
  }

  // Cancel an order
  async cancelOrder(symbol, orderId) {
    if (!orderId) return;
    try {
      await this.makeProxyRequest('/fapi/v1/order', 'DELETE', { symbol, orderId }, true, 'futures');
      await this.addLog(`Cancelled order ${orderId}.`);
    } catch (error) {
      // Ignore if order is already filled or cancelled (-2011: Unknown order)
      if (error.binanceErrorCode === -2011) {
        await this.addLog(`Order ${orderId} already filled or cancelled.`);
      } else {
        await this.addLog(`Failed to cancel order ${orderId}: ${error.message}`);
      }
    }
  }


  // Close the current open position and return a Promise that resolves upon order fill
  async closeCurrentPosition() {
    if (this.currentPosition === 'NONE') {
      return Promise.resolve({ status: 'NO_POSITION' });
    }

    return new Promise(async (resolve, reject) => {
      try {
        const currentPositions = await this.getCurrentPositions();
        const targetPosition = currentPositions.find(p => p.symbol === this.symbol);

        if (!targetPosition || parseFloat(targetPosition.positionAmt) === 0) {
          await this.addLog(`No active position found for ${this.symbol} to close.`);
          return resolve({ status: 'NO_POSITION' });
        }

        const positionAmount = Math.abs(parseFloat(targetPosition.positionAmt));

        // BUGFIX: Preserve last position data BEFORE closing
        // This ensures we capture the actual final position values for historical analysis
        this.lastPositionQuantity = positionAmount;
        this.lastPositionEntryPrice = this.positionEntryPrice || parseFloat(targetPosition.entryPrice);

        await this.addLog(`Attempting to close position. Current positionAmt from Binance: ${targetPosition.positionAmt}.`);
        const closingSide = parseFloat(targetPosition.positionAmt) > 0 ? 'SELL' : 'BUY';
        const roundedQuantity = this.roundQuantity(positionAmount);

        if (roundedQuantity <= 0) {
          return reject(new Error('Calculated quantity is zero or negative for closing.'));
        }

        await this.addLog(`Placing ${closingSide} close order for ${this._formatQuantity(roundedQuantity)} ${this.symbol}.`);

        const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', {
          symbol: this.symbol,
          side: closingSide,
          type: 'MARKET',
          quantity: roundedQuantity,
          newOrderRespType: 'FULL'
        }, true, 'futures');

        if (result && result.orderId) {
          this.pendingOrders.set(result.orderId, { resolve, reject });
          // Resolve immediately with order details, actual fill will be handled by WS
          resolve(result); 
        } else {
          reject(new Error('Order placement failed: No orderId in response.'));
        }
      } catch (error) {
        await this.addLog(`Failed to close position: ${error.message}`);
        reject(error);
      }
    });
  }

  // Detect current position from account and update strategy state
  async detectCurrentPosition(forceRestApi = false) {
    //await this.addLog(`Current position before detection: ${this.currentPosition}`);
    try {
      // Check if position was recently updated via WebSocket (within last 2 seconds)
      const wsUpdateAge = this.lastPositionUpdateFromWebSocket ? Date.now() - this.lastPositionUpdateFromWebSocket : null;
      const useWebSocketData = !forceRestApi && wsUpdateAge !== null && wsUpdateAge < 2000;

      if (useWebSocketData) {
        // Position data already updated via WebSocket, skip REST API call
        // Reset flag after using the data
        this.positionUpdatedViaWebSocket = false;
        return;
      }

      // Fall back to REST API query
      const positions = await this.getCurrentPositions();
      
      if (positions.length === 0) {
        this.currentPosition = 'NONE';
        // Only null these if the strategy is NOT in the process of stopping.
        // When stopping, we want to preserve their last values for saveState().
        if (!this.isStopping) {
          this.positionEntryPrice = null;
          this.positionSize = null;
          this.entryPositionQuantity = null;
          this.currentPositionQuantity = null;
          this.breakevenPrice = null;
          this.finalTpPrice = null;
          this.breakevenPercentage = null;
          this.finalTpPercentage = null;
        }
        // Reset Final TP states
        this.finalTpActive = false;
        this.finalTpOrderSent = false;
      } else if (positions.length === 1) {
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);

        // Update persistent fields for historical analysis when position is active
        this.lastPositionQuantity = Math.abs(positionAmt);
        this.lastPositionEntryPrice = parseFloat(p.entryPrice);
      } else {
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);

        // Update persistent fields for historical analysis when position is active
        this.lastPositionQuantity = Math.abs(positionAmt);
        this.lastPositionEntryPrice = parseFloat(p.entryPrice);
      }

      // NOTE: BE/Final TP calculation removed from detectCurrentPosition
      // This now only happens after scaling at 2x profit level in _calculateBreakevenAndFinalTp()

      //await this.addLog(`Updated currentPositionQuantity: ${this._formatQuantity(this.currentPositionQuantity)}`);

      // Trigger consolidated log message after position state is updated
      if (this._pendingLogMessage === 'reversal_closing' && this.currentPosition === 'NONE') { // Log when position becomes NONE during reversal
          await this.addLog(`Position reversed to NONE. Entry: N/A, Size: N/A, Qty: N/A. Mode: ${this.activeMode}.`);
          this._pendingLogMessage = null; // Clear after logging NONE state
      } else if (this._pendingLogMessage === 'reversal_opening' && this.currentPosition !== 'NONE') { // Log when new position is opened during reversal
          await this.addLog(`Position reversed to ${this.currentPosition}. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);
          this._pendingLogMessage = null; // Clear after logging new position
      }
    } catch (error) {
      console.error(`Failed to detect current position for ${this.symbol}: ${error.message}`);
    }
  }

  // Helper function to wait for a specific position state
  async _waitForPositionChange(targetPosition, timeoutMs = 15000) {
    const startTime = Date.now();
    //await this.addLog(`Waiting for position to become: ${targetPosition}. Current: ${this.currentPosition}`);
    return new Promise(async (resolve, reject) => {
      const checkInterval = setInterval(async () => {
        await this.detectCurrentPosition(); 

        if (this.currentPosition === targetPosition) {
          clearInterval(checkInterval);
          await this.addLog(`Position confirmed as ${targetPosition} after ${Date.now() - startTime}ms.`);
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          await this.addLog(`Timeout waiting for position to change to ${targetPosition}. Current: ${this.currentPosition}`);
          reject(new Error(`Timeout waiting for position to change to ${targetPosition}`));
        }
      }, 500);
    });
  }

  // Connect to Binance Real-time Price WebSocket
  connectRealtimeWebSocket() { // Renamed method
    // Clear any existing reconnection timeouts before attempting to connect
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);

    // Clear existing heartbeat interval and timeout
    if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
    if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);

    // Close existing connections before opening new ones
    if (this.realtimeWs) {
      this.realtimeWs.close();
    }

    const wsBaseUrl = this.isTestnet === true
      ? 'wss://stream.binance.com/ws'
      : 'wss://fstream.binance.com/ws';
    
    // Real-time price WebSocket for current price updates
    const tickerStream = `${this.symbol.toLowerCase()}@ticker`;
    this.realtimeWs = new WebSocket(`${wsBaseUrl}/${tickerStream}`);

    this.realtimeWs.on('open', async () => {
      await this.addLog('Real-time price WS connected.');
      this.realtimeWsConnected = true;
      this.realtimeReconnectAttempts = 0; // Reset attempts on successful connection
      if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);

      // Start heartbeat for Real-time WS
      this.realtimeWsPingInterval = setInterval(() => {
        this.realtimeWs.ping();
        this.realtimeWsPingTimeout = setTimeout(() => {
          this.addLog('Real-time WS pong timeout. Terminating connection.');
          this.realtimeWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
    });

    // Handle pong for Real-time WS
    this.realtimeWs.on('pong', () => {
      if (this.realtimeWsPingTimeout) {
        clearTimeout(this.realtimeWsPingTimeout);
        this.realtimeWsPingTimeout = null;
      }
    });

    this.realtimeWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.e === '24hrTicker') {
          await this.handleRealtimePrice(parseFloat(message.c));
        }
      } catch (error) {
        console.error(`Error processing price message: ${error.message}`);
      }
    });

    this.realtimeWs.on('error', async (error) => {
      console.error(`Price WebSocket error: ${error.message}`);
    });

    this.realtimeWs.on('close', async (code, reason) => {
      this.realtimeWsConnected = false;
      //await this.addLog(`Real-time price WebSocket closed. Code: ${code}, Reason: ${reason}.`);
      await this.addLog(`Real-time price WebSocket closed.`);
      // Clear heartbeat on close
      if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
      if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);

      // Attempt to reconnect if strategy is still running and max attempts not reached
      if (this.isRunning) {
        this.realtimeReconnectAttempts++;
        if (this.realtimeReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.realtimeReconnectAttempts - 1));
          await this.addLog(`Attempting Real-time price WS reconnect in ${delay / 1000}s (Attempt ${this.realtimeReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          this.realtimeReconnectTimeout = setTimeout(() => this.connectRealtimeWebSocket(), delay); // Call renamed method
        } else {
          await this.addLog(`Max Real-time price WS reconnect attempts reached. Stopping further attempts.`);
        }
      }
    });
  }

  // NEW: Helper to handle initial LIMIT order fill
  async _handleInitialLimitOrderFill(order) {
    // Clear pending limit order IDs
    if (order.i === this.longLimitOrderId) {
      this.longLimitOrderId = null;
      this.activeMode = 'SUPPORT_ZONE';
      await this.addLog(`LONG LIMIT order ${order.i} filled. Entering SUPPORT_ZONE mode.`);
      await this.cancelOrder(this.symbol, this.shortLimitOrderId); // Cancel other pending limit order
      this.shortLimitOrderId = null;
    } else if (order.i === this.shortLimitOrderId) {
      this.shortLimitOrderId = null;
      this.activeMode = 'RESISTANCE_ZONE';
      await this.addLog(`SHORT LIMIT order ${order.i} filled. Entering RESISTANCE_ZONE mode.`);
      await this.cancelOrder(this.symbol, this.longLimitOrderId); // Cancel other pending limit order
      this.longLimitOrderId = null;
    }
    this.isTradingSequenceInProgress = false; // Reset flag after initial LIMIT order fill
    await this.detectCurrentPosition(); // Re-detect position after order fill to update entry price and size

    // Calculate and set Entry Level and Reversal Level based on actual filled position
    if (this.reversalLevelPercentage !== null && this.positionEntryPrice !== null) {
      this.entryLevel = this.positionEntryPrice;

      if (this.activeMode === 'SUPPORT_ZONE') {
        // For Support Zone, reversal level is below entry level
        this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
        await this.addLog(`Entry Level set: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Support Zone).`);
      } else if (this.activeMode === 'RESISTANCE_ZONE') {
        // For Resistance Zone, reversal level is above entry level
        this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
        await this.addLog(`Entry Level set: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Resistance Zone).`);
      }
    }

    // Set strategy start time after initial LIMIT order is filled
    this.strategyStartTime = new Date();
    await this.addLog(`Strategy timer started after initial position filled.`);

    // Calculate exit threshold, BE, and final TP for initial position
    await this._calculateExitThreshold();
    await this._calculateBreakevenAndFinalTp();

    await this.saveState();
  }

  // NEW: Helper to handle initial LIMIT order failure
  async _handleInitialLimitOrderFailure(order) {
    // Clear pending limit order IDs
    if (order.i === this.longLimitOrderId) this.longLimitOrderId = null;
    if (order.i === this.shortLimitOrderId) this.shortLimitOrderId = null;
    this.isTradingSequenceInProgress = false; // Reset flag on failure

    // MODIFIED: Only stop the strategy if no active position has been established yet.
    // If activeMode is not NONE, it means one of the initial LIMIT orders has already filled.
    if (this.activeMode === 'NONE') {
      await this.addLog(`Initial LIMIT order ${order.i} ${order.X}. Stopping strategy.`);
      await this.stop(); // Stop the strategy if initial order fails and no position is active
    } else {
      await this.addLog(`Initial LIMIT order ${order.i} ${order.X}, but an active position is already established. Continuing strategy.`);
    }
    await this.saveState();
  }

  // Connect to Binance User Data Stream for order and trade updates
  connectUserDataStream() {
    // Clear any existing reconnection timeout before attempting to connect
    if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);

    // Clear existing heartbeat interval and timeout
    if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
    if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);

    if (!this.listenKey) {
      console.error('Cannot connect User Data Stream: listenKey is null.');
      this.addLog('ERROR: listenKey is null, cannot connect User Data Stream.');
      return;
    }
    if (this.userDataWs) {
      this.userDataWs.close();
      //this.addLog('Closing existing User Data Stream WebSocket.');
    }

    const wsBaseUrl = this.isTestnet === true
      ? 'wss://stream.binance.com/ws'
      : 'wss://fstream.binance.com/ws';

    const fullWsUrl = `${wsBaseUrl}/${this.listenKey}`;
    this.userDataWs = new WebSocket(fullWsUrl);

    this.userDataWs.on('open', async () => {
      await this.addLog('User Data WS connected.');
      this.userDataWsConnected = true;
      this.userDataReconnectAttempts = 0; // Reset attempts on successful connection
      if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);

      // Start heartbeat for User Data WS
      this.userDataWsPingInterval = setInterval(() => {
        this.userDataWs.ping();
        this.userDataWsPingTimeout = setTimeout(() => {
          this.addLog('User Data WS pong timeout. Terminating connection.');
          this.userDataWs.terminate();
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
    });

    // Handle pong for User Data WS
    this.userDataWs.on('pong', () => {
      if (this.userDataWsPingTimeout) {
        clearTimeout(this.userDataWsPingTimeout);
        this.userDataWsPingTimeout = null;
      }
    });

    this.userDataWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.e === 'ORDER_TRADE_UPDATE' && message.o.s === this.symbol) {
          const order = message.o;
          // Only log if status is not PARTIALLY_FILLED
          if (order.X !== 'PARTIALLY_FILLED') {
            await this.addLog(`ORDER_TRADE_UPDATE for order ${order.i}, status: ${order.X}, side: ${order.S}, quantity: ${order.q}, filled: ${order.z}`);
          }

          if (order.x === 'TRADE' && parseFloat(order.L) > 0) {
            const realizedPnl = parseFloat(order.rp);
            const commission = parseFloat(order.n);
            const commissionAsset = order.N;

            if (!isNaN(realizedPnl) && realizedPnl !== 0) {
              this.accumulatedRealizedPnL += realizedPnl;
            }
            if (!isNaN(commission) && commission !== 0) {
              this.accumulatedTradingFees += commission;
            }

            // Save individual trade details to Firestore
            const tradeDetails = {
              orderId: order.i,
              symbol: order.s,
              time: order.T,
              price: parseFloat(order.ap),
              qty: parseFloat(order.l),
              quoteQty: parseFloat(order.ap) * parseFloat(order.l),
              commission: parseFloat(order.n),
              commissionAsset: order.N,
              realizedPnl: parseFloat(order.rp),
              isBuyer: order.S === 'BUY',
              role: order.m ? 'Maker' : 'Taker',
            };
            await this.saveTrade(tradeDetails);
          }

          // Check if this is one of the initial LIMIT orders
          const isInitialLimitOrder = (order.i === this.longLimitOrderId || order.i === this.shortLimitOrderId);

          // Clear timeout if it exists for this order
          if (isInitialLimitOrder && this.pendingInitialLimitOrders.has(order.i)) {
            const { timeoutId } = this.pendingInitialLimitOrders.get(order.i);
            if (timeoutId) {
              clearTimeout(timeoutId);
              this.pendingInitialLimitOrders.delete(order.i); // Remove from pendingInitialLimitOrders after clearing timeout
            }
          }

          // Resolve/Reject pending order promises based on order status (for other order types)
          if (this.pendingOrders.has(order.i)) { // This block handles MARKET, Partial TP, Close Position orders
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

          // Handle initial LIMIT order specifically
          if (isInitialLimitOrder) {
            if (order.X === 'FILLED') {
              await this._handleInitialLimitOrderFill(order);
            } else if (order.X === 'CANCELED' || order.X === 'REJECTED' || order.X === 'EXPIRED') {
              await this._handleInitialLimitOrderFailure(order);
            }
          }
          // Always save state after processing an order update to ensure PnL and fees are persisted
          await this.saveState();
        }

        // Handle ACCOUNT_UPDATE events for real-time position updates
        if (message.e === 'ACCOUNT_UPDATE' && message.a && message.a.P) {
          const positions = message.a.P;
          const positionUpdate = positions.find(p => p.s === this.symbol);

          if (positionUpdate) {
            const positionAmount = parseFloat(positionUpdate.pa);
            const entryPrice = parseFloat(positionUpdate.ep);

            // Update internal state from WebSocket event
            if (positionAmount === 0) {
              // BUGFIX: Preserve last position data BEFORE setting to NONE
              // Only preserve if we have valid current position data
              if (this.currentPositionQuantity !== null && this.currentPositionQuantity > 0) {
                this.lastPositionQuantity = this.currentPositionQuantity;
              }
              if (this.positionEntryPrice !== null) {
                this.lastPositionEntryPrice = this.positionEntryPrice;
              }

              // Position closed
              this.currentPosition = 'NONE';
              this.positionEntryPrice = null;
              this.currentPositionQuantity = null;
              this.positionSize = null;
            } else if (positionAmount > 0) {
              // LONG position
              this.currentPosition = 'LONG';
              this.positionEntryPrice = entryPrice;
              this.currentPositionQuantity = Math.abs(positionAmount);
              this.positionSize = Math.abs(positionAmount) * entryPrice;

              // Update persistent fields for historical analysis
              this.lastPositionQuantity = Math.abs(positionAmount);
              this.lastPositionEntryPrice = entryPrice;
            } else if (positionAmount < 0) {
              // SHORT position
              this.currentPosition = 'SHORT';
              this.positionEntryPrice = entryPrice;
              this.currentPositionQuantity = Math.abs(positionAmount);
              this.positionSize = Math.abs(positionAmount) * entryPrice;

              // Update persistent fields for historical analysis
              this.lastPositionQuantity = Math.abs(positionAmount);
              this.lastPositionEntryPrice = entryPrice;
            }

            // Mark position as updated via WebSocket
            this.lastPositionUpdateFromWebSocket = Date.now();
            this.positionUpdatedViaWebSocket = true;

            // Log position update from WebSocket
            //await this.addLog(`Position updated via WebSocket: ${this.currentPosition}, Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.currentPositionQuantity)}`);

            // Save state after position update
            await this.saveState();
          }
        }
      } catch (error) {
        console.error(`Error processing User Data Stream message: ${error.message}`);
        await this.addLog(`ERROR processing User Data Stream message: ${error.message}`);
      }
    });

    this.userDataWs.on('error', async (error) => {
      console.error(`User Data Stream WebSocket error: ${error.message}. Attempting reconnect.`);
      await this.addLog(`User Data Stream WebSocket error: ${error.message}.`);
    });

    this.userDataWs.on('close', async (code, reason) => {
      this.userDataWsConnected = false;
      //await this.addLog(`User Data Stream WebSocket closed. Code: ${code}, Reason: ${reason}.`);
      await this.addLog(`User Data Stream WebSocket closed.`);
      // Clear heartbeat on close
      if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
      if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);

      if (this.isRunning && code !== 1000) { // 1000 is normal closure
        this.userDataReconnectAttempts++;
        if (this.userDataReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.userDataReconnectAttempts - 1));
          await this.addLog(`Attempting User Data WS reconnect in ${delay / 1000}s (Attempt ${this.userDataReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          this.userDataReconnectTimeout = setTimeout(async () => {
            // Re-obtain listenKey before reconnecting
            try {
              const listenKeyResponse = await this.makeProxyRequest('/fapi/v1/listenKey', 'POST', {}, true, 'futures');
              this.listenKey = listenKeyResponse.listenKey;
              await this.addLog(`ListenKey re-obtained for User Data WS reconnect.`);
              this.connectUserDataStream();
              // Re-establish listenKey refresh interval
              if (this.listenKeyRefreshInterval) clearInterval(this.listenKeyRefreshInterval);
              this.listenKeyRefreshInterval = setInterval(async () => {
                try {
                  await this.makeProxyRequest('/fapi/v1/listenKey', 'PUT', { listenKey: this.listenKey }, true, 'futures');
                  await this.addLog(`ListenKey refreshed.`); 
                }
                catch (error) {
                  console.error(`Failed to refresh listenKey: ${error.message}. Attempting to re-establish stream.`);
                  clearInterval(this.listenKeyRefreshInterval);
                  this.connectUserDataStream();
                }
              }, 30 * 60 * 1000);
            } catch (error) {
              console.error(`Failed to re-obtain listenKey for User Data WS reconnect: ${error.message}`);
              await this.addLog(`ERROR: Failed to re-obtain listenKey for User Data WS reconnect: ${error.message}`);
            }
          }, delay);
        } else {
          await this.addLog(`Max User Data WS reconnect attempts reached. Stopping further attempts.`);
        }
      }
    });
  }

  // Helper to calculate dynamic position size and log it
  async _calculateDynamicPositionSize() {
    let newPositionSizeUSDT = this.initialBasePositionSizeUSDT;
    let loggedEntry = false;

    const currentNetLoss = -(this.accumulatedRealizedPnL - this.accumulatedTradingFees);

    if (currentNetLoss > 0) { // If there's a net accumulated loss
        await this.addLog(`Dynamic Sizing: Current Net Loss: ${currentNetLoss.toFixed(4)}.`);
        loggedEntry = true;

        const recoveryTargetForNextTrade = currentNetLoss * this.RECOVERY_FACTOR;
        // Assuming initialLevelPercentage is a reasonable proxy for average TP gain
        const additionalSizeNeeded = recoveryTargetForNextTrade / this.RECOVERY_DISTANCE;
        
        newPositionSizeUSDT = this.initialBasePositionSizeUSDT + additionalSizeNeeded;
        
        if (newPositionSizeUSDT > this.MAX_POSITION_SIZE_USDT) {
            newPositionSizeUSDT = this.MAX_POSITION_SIZE_USDT;
        }
    } else {
        if (this.positionSizeUSDT !== this.initialBasePositionSizeUSDT) {
            await this.addLog(`Dynamic Sizing: Current Net Loss: ${currentNetLoss.toFixed(4)}.`);
            loggedEntry = true;
            newPositionSizeUSDT = this.initialBasePositionSizeUSDT;
            await this.addLog(`Pos. size reset to ${this._formatNotional(newPositionSizeUSDT)} USDT.`);
        }
    }
    
    // Apply MIN_NOTIONAL filter with safety buffer
    const symbolInfo = await this._getExchangeInfo(this.symbol);
    if (symbolInfo && symbolInfo.minNotional !== undefined) {
        const minNotionalWithBuffer = symbolInfo.minNotional * 1.1; // 10% safety buffer
        if (newPositionSizeUSDT < minNotionalWithBuffer) {
            await this.addLog(`Adjusting position size from ${this._formatNotional(newPositionSizeUSDT)} to meet MIN_NOTIONAL (${this._formatNotional(symbolInfo.minNotional)} + 10% buffer = ${this._formatNotional(minNotionalWithBuffer)}) USDT.`);
            newPositionSizeUSDT = minNotionalWithBuffer;
        }
    }

    if (loggedEntry || this.positionSizeUSDT !== newPositionSizeUSDT) {
        await this.addLog(`Final positionSizeUSDT for next trade: ${this._formatNotional(newPositionSizeUSDT)} USDT.`);
    }
    return newPositionSizeUSDT;
  }


  // Helper to calculate and set scaling level after position entry (midpoint between entry and reversal)
  async _calculateExitThreshold() {
    if (!this.positionEntryPrice) {
      await this.addLog(`Cannot calculate exit threshold: Entry price not available.`);
      return;
    }

    if (this.reversalLevel === null) {
      await this.addLog(`Cannot calculate exit threshold: Reversal level not set.`);
      return;
    }

    this.exitThreshold = this.roundPrice((this.positionEntryPrice + this.reversalLevel) / 2);

    await this.addLog(`Exit Threshold: ${this._formatPrice(this.exitThreshold)} (midpoint between entry ${this._formatPrice(this.positionEntryPrice)} and reversal ${this._formatPrice(this.reversalLevel)}).`);

    await this.saveState();
  }

  // Helper to calculate breakeven and final TP after scaling
  async _calculateBreakevenAndFinalTp() {
    if (!this.currentPositionQuantity || this.currentPositionQuantity <= 0 || !this.positionEntryPrice) {
      await this.addLog(`BE/Final TP Calc: Cannot calculate - invalid position quantity or entry price.`);
      return;
    }

    // Calculate Breakeven Price
    const netRealizedPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;

    await this.addLog(`BE Calc: Accumulated Realized PnL: ${this.accumulatedRealizedPnL.toFixed(8)}`);
    await this.addLog(`BE Calc: Accumulated Trading Fees: ${this.accumulatedTradingFees.toFixed(8)}`);
    await this.addLog(`BE Calc: Net Realized PnL: ${netRealizedPnL.toFixed(8)}`);
    await this.addLog(`BE Calc: Current Position Quantity: ${this.currentPositionQuantity.toFixed(8)}`);

    let breakevenPriceRaw;
    if (this.currentPosition === 'LONG') {
      breakevenPriceRaw = this.positionEntryPrice - (netRealizedPnL / this.currentPositionQuantity);
    } else { // SHORT
      breakevenPriceRaw = this.positionEntryPrice + (netRealizedPnL / this.currentPositionQuantity);
    }

    await this.addLog(`BE Calc: Raw Breakeven Price: ${breakevenPriceRaw.toFixed(8)}`);
    this.breakevenPrice = this.roundPrice(breakevenPriceRaw);

    // Calculate Breakeven Percentage
    if (this.positionEntryPrice !== 0) {
      this.breakevenPercentage = ((this.currentPosition === 'LONG' ? this.breakevenPrice - this.positionEntryPrice : this.positionEntryPrice - this.breakevenPrice) / this.positionEntryPrice) * 100;
      if (this.breakevenPercentage < 0) this.breakevenPercentage = 0; // Ensure non-negative
    } else {
      this.breakevenPercentage = null;
    }

    // Calculate Final TP Price
    let bePercentFromEntry;
    if (this.currentPosition === 'LONG') {
      bePercentFromEntry = ((this.breakevenPrice - this.positionEntryPrice) / this.positionEntryPrice) * 100;
    } else { // SHORT
      bePercentFromEntry = ((this.positionEntryPrice - this.breakevenPrice) / this.positionEntryPrice) * 100;
    }

    // Ensure breakeven percentage is not negative
    if (bePercentFromEntry < 0) {
      this.breakevenPrice = this.positionEntryPrice;
      bePercentFromEntry = 0;
    }

    const DESIRED_PROFIT_PERCENTAGE = this.exitCount >= 16 ? 1.05 : 1.55; // Dynamic: 1.05% after 16+ exits, otherwise 1.55%
    const finalTpPercentFromEntry = bePercentFromEntry + DESIRED_PROFIT_PERCENTAGE;

    if (this.currentPosition === 'LONG') {
      this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 + finalTpPercentFromEntry / 100));
    } else { // SHORT
      this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 - finalTpPercentFromEntry / 100));
    }

    this.finalTpPercentage = finalTpPercentFromEntry;
    this.finalTpActive = true;

    await this.addLog(`Breakeven Price: ${this._formatPrice(this.breakevenPrice)} (${this.breakevenPercentage.toFixed(4)}% from entry).`);
    await this.addLog(`Final TP Price: ${this._formatPrice(this.finalTpPrice)} (${this.finalTpPercentage.toFixed(4)}% from entry).`);
  }

  async handleRealtimePrice(currentPrice) {
    // Update current price and PnL values (always update these)
    this.currentPrice = currentPrice;

    if (this.currentPosition !== 'NONE' && this.positionEntryPrice !== null && this.positionSize !== null) {
      this.positionPnL = this.currentPosition === 'LONG'
        ? (currentPrice - this.positionEntryPrice) * (this.positionSize / this.positionEntryPrice)
        : (this.positionEntryPrice - currentPrice) * (this.positionSize / this.positionEntryPrice);
    } else {
      this.positionPnL = 0;
    }

    this.totalPnL = this.positionPnL + this.accumulatedRealizedPnL - this.accumulatedTradingFees;

    // Only execute trading logic if strategy is running AND (position is open OR re-entry monitoring is active)
    if (!this.isRunning || (this.currentPosition === 'NONE' && !this.reentryMonitoring)) {
      return;
    }

    // ===== 1. Final TP Trigger Logic (Priority check - runs before guard) =====
    if (this.finalTpActive && this.currentPosition !== 'NONE' && !this.finalTpOrderSent && this.finalTpPrice !== null) {
      // Validate that Final TP price is appropriate for current position direction
      let isFinalTpValid = false;
      if (this.currentPosition === 'LONG') {
        // For LONG: Final TP must be ABOVE entry price (profit when price rises)
        isFinalTpValid = this.finalTpPrice > this.positionEntryPrice;
      } else if (this.currentPosition === 'SHORT') {
        // For SHORT: Final TP must be BELOW entry price (profit when price falls)
        isFinalTpValid = this.finalTpPrice < this.positionEntryPrice;
      }

      // If Final TP is invalid for current position, recalculate it
      if (!isFinalTpValid) {
        await this.addLog(`Final TP validation failed: Price ${this._formatPrice(this.finalTpPrice)} is invalid for ${this.currentPosition} position at entry ${this._formatPrice(this.positionEntryPrice)}. Recalculating...`);
        await this._calculateBreakevenAndFinalTp();
      }

      let triggerFinalTp = false;
      if (this.currentPosition === 'LONG' && currentPrice >= this.finalTpPrice && this.finalTpPrice > this.positionEntryPrice) {
        triggerFinalTp = true;
      } else if (this.currentPosition === 'SHORT' && currentPrice <= this.finalTpPrice && this.finalTpPrice < this.positionEntryPrice) {
        triggerFinalTp = true;
      }

      if (triggerFinalTp) {
        this.isTradingSequenceInProgress = true;
        this.finalTpOrderSent = true;
        this.tradeSequence += 'F';
        await this.addLog(`Final TP hit! Current price: ${this._formatPrice(currentPrice)}, Target: ${this._formatPrice(this.finalTpPrice)}. Closing remaining position and stopping strategy.`);
        try {
          await this.closeCurrentPosition();
          await this.addLog('Final TP: Waiting for position to be fully closed...');
          await this._waitForPositionChange('NONE');
          await this.addLog('Final TP: Position confirmed as NONE. Stopping strategy.');
          await this.stop();
        } catch (error) {
          console.error(`Error closing position for Final TP: ${error.message}`);
          await this.addLog(`ERROR closing position for Final TP: ${error.message}`);
          this.finalTpOrderSent = false;
          this.isTradingSequenceInProgress = false;
        }
        return;
      }
    }

    // Guard to prevent overlapping trading sequences (after Final TP check)
    if (this.isTradingSequenceInProgress) {
      return;
    }

    // ===== 2. Exit Threshold Logic (Close position if price hits exit threshold) =====
    if (this.currentPosition !== 'NONE' && this.exitThreshold !== null && !this.isTradingSequenceInProgress) {
      let shouldClosePosition = false;

      if (this.currentPosition === 'LONG' && currentPrice <= this.exitThreshold) {
        shouldClosePosition = true;
      } else if (this.currentPosition === 'SHORT' && currentPrice >= this.exitThreshold) {
        shouldClosePosition = true;
      }

      if (shouldClosePosition) {
        this.isTradingSequenceInProgress = true;
        await this.addLog(`Current price ${this._formatPrice(currentPrice)} hit exit threshold ${this._formatPrice(this.exitThreshold)}. Closing position.`);

        try {
          const positionBeforeClose = this.currentPosition;
          const entryPriceBeforeClose = this.positionEntryPrice;

          await this.closeCurrentPosition();
          await this._waitForPositionChange('NONE');

          // Add 'X' to trade sequence for exit threshold closure
          this.exitCount++;
          this.tradeSequence += 'X';

          // Activate re-entry monitoring at entry level
          this.previousPositionDirection = positionBeforeClose;
          this.reentryLevel = entryPriceBeforeClose;
          this.reentryMonitoring = true;

          await this.addLog(`Position closed. Activating re-entry monitoring for ${positionBeforeClose} position.`);
          await this.addLog(`  Re-entry will trigger when price returns to ${this._formatPrice(this.reentryLevel)}`);

          // Save state to persist lastPositionQuantity and lastPositionEntryPrice
          await this.saveState();

        } catch (error) {
          console.error(`Error closing position at exit threshold: ${error.message}`);
          await this.addLog(`ERROR closing position at exit threshold: ${error.message}`);
        } finally {
          this.isTradingSequenceInProgress = false;
        }
        return;
      }
    }

    // ===== 3. Re-entry at Entry Level Logic (when position is NONE and monitoring is active) =====
    if (this.currentPosition === 'NONE' && this.reentryMonitoring && this.reentryLevel !== null && this.previousPositionDirection !== null && !this.isTradingSequenceInProgress) {
      let reentryTriggered = false;

      // Check if price returns to entry level
      if (this.previousPositionDirection === 'LONG' && currentPrice >= this.reentryLevel) {
        reentryTriggered = true;
      } else if (this.previousPositionDirection === 'SHORT' && currentPrice <= this.reentryLevel) {
        reentryTriggered = true;
      }

      if (reentryTriggered) {
        this.isTradingSequenceInProgress = true;

        try {
          const canTrade = await this.checkCapitalProtection();
          if (!canTrade) {
            this.isTradingSequenceInProgress = false;
            return;
          }

          // Calculate dynamic position size and assign to this.positionSizeUSDT
          this.positionSizeUSDT = await this._calculateDynamicPositionSize();
          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);

          if (quantity > 0) {
            const orderSide = (this.previousPositionDirection === 'LONG') ? 'BUY' : 'SELL';
            const positionType = this.previousPositionDirection;

            await this.addLog(`Re-entry triggered: Price ${this._formatPrice(currentPrice)} returned to entry level ${this._formatPrice(this.reentryLevel)}`);
            await this.addLog(`Opening ${positionType} position with ${this._formatNotional(this.positionSizeUSDT)} USDT (dynamic sizing).`);

            await this.placeMarketOrder(this.symbol, orderSide, quantity);
            await this._waitForPositionChange(positionType);

            this.entryPositionQuantity = quantity;
            this.currentPositionQuantity = quantity;

            // Deactivate re-entry monitoring
            this.reentryMonitoring = false;
            const previousPositionType = this.previousPositionDirection;
            this.previousPositionDirection = null;
            this.reentryLevel = null;

            // Switch activeMode based on re-entered position type
            if (previousPositionType === 'LONG') {
              this.activeMode = 'SUPPORT_ZONE';
            } else if (previousPositionType === 'SHORT') {
              this.activeMode = 'RESISTANCE_ZONE';
            }

            // Dynamic adjustment: Update entry level and reversal level based on new position
            const previousReversalLevel = this.reversalLevel;
            this.entryLevel = this.positionEntryPrice;

            if (this.activeMode === 'SUPPORT_ZONE') {
              // For Support Zone (LONG), reversal level is below entry level
              this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
              await this.addLog(`Dynamic Adjustment: Previous Reversal Level: ${this._formatPrice(previousReversalLevel)}, New Entry Level: ${this._formatPrice(this.entryLevel)}, New Reversal Level: ${this._formatPrice(this.reversalLevel)} (Support Zone).`);
            } else if (this.activeMode === 'RESISTANCE_ZONE') {
              // For Resistance Zone (SHORT), reversal level is above entry level
              this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
              await this.addLog(`Dynamic Adjustment: Previous Reversal Level: ${this._formatPrice(previousReversalLevel)}, New Entry Level: ${this._formatPrice(this.entryLevel)}, New Reversal Level: ${this._formatPrice(this.reversalLevel)} (Resistance Zone).`);
            }

            // Calculate exit threshold, breakeven, and final TP for new position
            await this._calculateExitThreshold();
            await this._calculateBreakevenAndFinalTp();

            await this.saveState();
          }
        } catch (error) {
          console.error(`Error during re-entry: ${error.message}`);
          await this.addLog(`ERROR during re-entry: ${error.message}`);
        } finally {
          this.isTradingSequenceInProgress = false;
        }
        return;
      }
    }

    // ===== 3B. Reversal Detection During Re-entry Monitoring (when position is NONE and price hits reversal level) =====
    if (this.currentPosition === 'NONE' && this.reentryMonitoring && this.reversalLevel !== null && this.previousPositionDirection !== null && this.activeMode !== 'NONE' && !this.isTradingSequenceInProgress) {
      let shouldReverseFromMonitoring = false;
      let newPositionType = null;

      if (this.activeMode === 'SUPPORT_ZONE') {
        if (this.previousPositionDirection === 'LONG' && currentPrice <= this.reversalLevel) {
          // Previous LONG position in support zone, price continues down to reversal level - reverse to SHORT
          shouldReverseFromMonitoring = true;
          newPositionType = 'SHORT';
        } else if (this.previousPositionDirection === 'SHORT' && currentPrice >= this.reversalLevel) {
          // Previous SHORT position in support zone, price continues up to reversal level - reverse to LONG
          shouldReverseFromMonitoring = true;
          newPositionType = 'LONG';
        }
      } else if (this.activeMode === 'RESISTANCE_ZONE') {
        if (this.previousPositionDirection === 'LONG' && currentPrice <= this.reversalLevel) {
          // Previous LONG position in resistance zone, price continues down to reversal level - reverse to SHORT
          shouldReverseFromMonitoring = true;
          newPositionType = 'SHORT';
        } else if (this.previousPositionDirection === 'SHORT' && currentPrice >= this.reversalLevel) {
          // Previous SHORT position in resistance zone, price continues up to reversal level - reverse to LONG
          shouldReverseFromMonitoring = true;
          newPositionType = 'LONG';
        }
      }

      if (shouldReverseFromMonitoring && newPositionType) {
        await this.addLog(`Reversal triggered during re-entry monitoring: Price ${this._formatPrice(currentPrice)} hit reversal level ${this._formatPrice(this.reversalLevel)}`);

        // Deactivate re-entry monitoring before opening reversal position
        this.reentryMonitoring = false;
        this.previousPositionDirection = null;
        this.reentryLevel = null;

        await this._handleReversal(newPositionType, this.reversalLevel, 'reversal');
        return;
      }
    }

    // ===== 4. Reversal Logic (only if a position is open and an active mode is set) =====
    if (this.currentPosition !== 'NONE' && this.activeMode !== 'NONE' && this.reversalLevel !== null) {
      let shouldReverse = false;
      let newPositionType = null;

      if (this.activeMode === 'RESISTANCE_ZONE') {
        if (this.currentPosition === 'LONG' && currentPrice <= this.reversalLevel) {
          // LONG position in resistance zone hits reversal level below entry
          shouldReverse = true;
          newPositionType = 'SHORT';
        } else if (this.currentPosition === 'SHORT' && currentPrice >= this.reversalLevel) {
          // SHORT position in resistance zone hits reversal level above entry
          shouldReverse = true;
          newPositionType = 'LONG';
        }
      } else if (this.activeMode === 'SUPPORT_ZONE') {
        if (this.currentPosition === 'SHORT' && currentPrice >= this.reversalLevel) {
          // SHORT position in support zone hits reversal level above entry
          shouldReverse = true;
          newPositionType = 'LONG';
        } else if (this.currentPosition === 'LONG' && currentPrice <= this.reversalLevel) {
          // LONG position in support zone hits reversal level below entry
          shouldReverse = true;
          newPositionType = 'SHORT';
        }
      }

      if (shouldReverse && newPositionType) {
        await this._handleReversal(newPositionType, this.reversalLevel, 'reversal');
        return;
      }
    }
  }

  // Helper method to handle reversal logic
  async _handleReversal(newPositionType, reversalPrice, reversalType) {
    this.isTradingSequenceInProgress = true;

    // CRITICAL: Immediately deactivate Final TP to prevent race conditions
    this.finalTpActive = false;
    this.finalTpOrderSent = false;

    try {
      // Capture old position before reversal for notification
      const oldPosition = this.currentPosition;

      // Step 1: Close existing position if one exists
      if (this.currentPosition !== 'NONE') {
        await this.addLog(`Reversal: ${this.currentPosition} position hit ${reversalType} level. Closing position.`);
        await this.closeCurrentPosition();
        await this._waitForPositionChange('NONE');
        await this.addLog('Reversal: Position confirmed as NONE. Proceeding with reversal.');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Step 2: Check capital protection
      const canTrade = await this.checkCapitalProtection();
      if (!canTrade) {
        this.isTradingSequenceInProgress = false;
        return;
      }

      // Step 3: Calculate dynamic position size
      this.positionSizeUSDT = await this._calculateDynamicPositionSize();
      await this.addLog(`Reversal: Using dynamic position size: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);

      if (quantity > 0) {
        const orderSide = (newPositionType === 'LONG') ? 'BUY' : 'SELL';
        await this.addLog(`Reversal: Opening ${newPositionType} position with quantity ${quantity}.`);
        await this.placeMarketOrder(this.symbol, orderSide, quantity);
        await this._waitForPositionChange(newPositionType);

        this.currentPosition = newPositionType;
        this.reversalCount++;
        this.tradeSequence += 'R';
        this.entryPositionQuantity = quantity;
        this.currentPositionQuantity = quantity;

        // Send reversal push notification
        try {
          const userId = await this.getUserIdFromProfileId();
          if (userId) {
            await sendReversalNotification(userId, {
              strategyId: this.strategyId,
              symbol: this.symbol,
              oldPosition: oldPosition,
              newPosition: newPositionType,
              reversalCount: this.reversalCount,
              currentPrice: this.currentPrice || reversalPrice,
            });
          } else {
            await this.addLog('Warning: Could not find userId for reversal notification.');
          }
        } catch (notifError) {
          console.error(`Error sending reversal notification: ${notifError.message}`);
          await this.addLog(`Warning: Failed to send reversal notification: ${notifError.message}`);
        }

        // Reset states for new position
        this.exitThreshold = null;
        this.reentryMonitoring = false;
        this.previousPositionDirection = null;
        this.reentryLevel = null;
        this.finalTpPrice = null;
        this.breakevenPrice = null;
        this.finalTpActive = false;
        this.finalTpOrderSent = false;
        this.breakevenPercentage = null;
        this.finalTpPercentage = null;

        // Step 4: Switch activeMode based on new position type
        if (newPositionType === 'LONG') {
          this.activeMode = 'SUPPORT_ZONE';
        } else if (newPositionType === 'SHORT') {
          this.activeMode = 'RESISTANCE_ZONE';
        }

        // Step 5: Calculate new entry level and reversal level based on new position
        this.entryLevel = this.positionEntryPrice;

        if (this.activeMode === 'SUPPORT_ZONE') {
          // For Support Zone (LONG), reversal level is below entry level
          this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
          await this.addLog(`Dynamic Adjustment: New Entry Level: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Support Zone).`);
        } else if (this.activeMode === 'RESISTANCE_ZONE') {
          // For Resistance Zone (SHORT), reversal level is above entry level
          this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
          await this.addLog(`Dynamic Adjustment: New Entry Level: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Resistance Zone).`);
        }

        // Step 6: Calculate exit threshold, breakeven, and final TP
        await this._calculateExitThreshold();
        await this._calculateBreakevenAndFinalTp();

        await this.saveState();
      }
    } catch (error) {
      console.error(`Error during reversal: ${error.message}`);
      await this.addLog(`ERROR during reversal: ${error.message}`);
    } finally {
      this.isTradingSequenceInProgress = false;
    }
  }

  async start(config = {}) {
    await this.addLog(`Hey bro! Starting strategy.. Good luck!🤞`);
    
    // Generate unique strategyId at the start of the strategy execution
    this.strategyId = `strategy_${this.profileId.slice(-6)}_${Date.now()}`; // Use profileId for context
    
    // Set tradesCollectionRef for the new strategy
    this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
    this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs'); // Initialize logs collection ref
    
    this.symbol = config.symbol || 'BTCUSDT';

    // Strictly take positionSizeUSDT from config
    this.positionSizeUSDT = config.positionSizeUSDT;

    // Validate that positionSizeUSDT is provided and valid
    if (this.positionSizeUSDT === null || this.positionSizeUSDT === undefined || this.positionSizeUSDT <= 0) {
        throw new Error('Position size (positionSizeUSDT) must be provided from the UI and be a positive number.');
    }

    // Set initial base position size (no scaling, use full config size)
    this.initialBasePositionSizeUSDT = this.positionSizeUSDT; // Use full position size for initial entry
    this.MAX_POSITION_SIZE_USDT = (3 / 4) * this.positionSizeUSDT * 50; // Set MAX_POSITION_SIZE_USDT dynamically here
    this.reversalLevelPercentage = config.reversalLevelPercentage !== undefined ? config.reversalLevelPercentage : null;

    this.enableSupport = config.enableSupport !== undefined ? config.enableSupport : false;
    this.enableResistance = config.enableResistance !== undefined ? config.enableResistance : false;

    // Order Type and Direction config
    this.orderType = config.orderType || 'MARKET';
    this.buyLongEnabled = config.buyLongEnabled || false;
    this.sellShortEnabled = config.sellShortEnabled || false;
    this.buyLimitPrice = config.buyLimitPrice || null;
    this.sellLimitPrice = config.sellLimitPrice || null;

    // Calculate initial entryLevel and reversalLevel based on order type and enabled zones
    // For LIMIT orders, wait until position is filled before calculating these levels
    // For MARKET orders, calculate immediately since they fill right away
    if (this.reversalLevelPercentage !== null && this.orderType === 'MARKET') {
      const currentPriceAtStart = await this._getCurrentPrice(this.symbol); // Always fetch current price

      let basePrice = currentPriceAtStart;

      // Set initial entry level based on which zone is enabled
      if (this.enableSupport) {
        this.entryLevel = this.roundPrice(basePrice);
        // For Support Zone, reversal level is below entry level
        this.reversalLevel = this.roundPrice(basePrice * (1 - this.reversalLevelPercentage / 100));
      } else if (this.enableResistance) {
        this.entryLevel = this.roundPrice(basePrice);
        // For Resistance Zone, reversal level is above entry level
        this.reversalLevel = this.roundPrice(basePrice * (1 + this.reversalLevelPercentage / 100));
      } else {
        this.entryLevel = null;
        this.reversalLevel = null;
      }
    } else {
      // For LIMIT orders or when reversalLevelPercentage is null, set to null initially
      // These will be calculated after the LIMIT order is filled
      this.entryLevel = null;
      this.reversalLevel = null;
    }

    // Reset position quantity on start
    this.entryPositionQuantity = null;
    this.currentPositionQuantity = null;
    // Reset Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null;
    this.finalTpPercentage = null;     // NEW

    // Reset accumulated PnL and fees for the new strategy run
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;

    // Reset summary section data
    this.reversalCount = 0;
    this.exitCount = 0;
    this.tradeSequence = '';
    this.profitPercentage = null;
    this.strategyStartTime = null; // Will be set when initial position is filled
    this.strategyEndTime = null; // Reset end time

    // Fetch initial wallet balance
    try {
      const futuresAccountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
      this.initialWalletBalance = parseFloat(futuresAccountInfo.totalWalletBalance);
    } catch (error) {
      await this.addLog(`WARNING: Could not fetch initial wallet balance: ${error.message}`);
      this.initialWalletBalance = null; // Set to null if fetching fails
    }

    // Reset capital protection for new strategy run
    this.capitalProtectionTriggered = false;
    this.capitalProtectionWarning = false;
    this.maxAllowableLoss = this.initialWalletBalance ? this.initialWalletBalance * (MAX_LOSS_PERCENTAGE / 100) : null;
    this.circuitBreakerTimestamp = null;

    // Create strategy document in Firestore immediately
    await this.firestore
      .collection('strategies')
      .doc(this.strategyId)
      .set({
        profileId: this.profileId, // ADDED: Save profileId to Firestore
        symbol: this.symbol,
        entryLevel: this.entryLevel,
        reversalLevel: this.reversalLevel,
        enableSupport: this.enableSupport,
        enableResistance: this.enableResistance,
        currentPosition: this.currentPosition,
        positionEntryPrice: this.positionEntryPrice,
        positionSize: this.positionSize,
        activeMode: this.activeMode,
        currentPrice: this.currentPrice,
        positionPnL: this.positionPnL,
        totalPnL: this.totalPnL,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        isRunning: true,
        createdAt: new Date(),
        lastUpdated: new Date(),
        positionSizeUSDT: this.positionSizeUSDT,
        initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
        MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT, // ADDED THIS LINE
        reversalLevelPercentage: this.reversalLevelPercentage,
        // Position quantity tracking
        entryPositionQuantity: this.entryPositionQuantity,
        currentPositionQuantity: this.currentPositionQuantity,
        // Final TP states
        breakevenPrice: this.breakevenPrice,
        finalTpPrice: this.finalTpPrice,
        finalTpActive: this.finalTpActive,
        finalTpOrderSent: this.finalTpOrderSent,
        breakevenPercentage: this.breakevenPercentage, // NEW
        finalTpPercentage: this.finalTpPercentage,     // NEW
        // Order Type and Direction states
        orderType: this.orderType,
        buyLongEnabled: this.buyLongEnabled,
        sellShortEnabled: this.sellShortEnabled,
        buyLimitPrice: this.buyLimitPrice,
        sellLimitPrice: this.sellLimitPrice,
        longLimitOrderId: this.longLimitOrderId,
        shortLimitOrderId: this.shortLimitOrderId,
        // Summary section data
        reversalCount: this.reversalCount,
        exitCount: this.exitCount,
        tradeSequence: this.tradeSequence,
        initialWalletBalance: this.initialWalletBalance,
        profitPercentage: this.profitPercentage,
        strategyStartTime: this.strategyStartTime,
        strategyEndTime: this.strategyEndTime,
        // Capital Protection fields
        capitalProtectionTriggered: this.capitalProtectionTriggered,
        capitalProtectionWarning: this.capitalProtectionWarning,
        maxAllowableLoss: this.maxAllowableLoss,
        circuitBreakerTimestamp: this.circuitBreakerTimestamp,
      });

    try {
      // Core setup steps that must happen first
      await this._getExchangeInfo(this.symbol); 
      await this.setLeverage(this.symbol, 50); 
      const currentPositionMode = await this.getPositionMode(); 
      if (currentPositionMode.dualSidePosition) {
        await this.setPositionMode(false); // Set to one-way mode
      } else {
        //await this.addLog(`Pos. mode already One-way.`); 
      }
      await this._checkExistingOrdersAndPositions();

      // User Data Stream setup - MOVED HERE
      try {
        const listenKeyResponse = await this.makeProxyRequest('/fapi/v1/listenKey', 'POST', {}, true, 'futures');
        this.listenKey = listenKeyResponse.listenKey;
        //await this.addLog(`ListenKey obtained: ${this.listenKey}.`);
        this.connectUserDataStream();
        // Keep listenKey alive every 30 minutes
        this.listenKeyRefreshInterval = setInterval(async () => {
          try {
            await this.makeProxyRequest('/fapi/v1/listenKey', 'PUT', { listenKey: this.listenKey }, true, 'futures');
            await this.addLog(`ListenKey refreshed.`); 
          }
          catch (error) {
            console.error(`Failed to refresh listenKey: ${error.message}. Attempting to re-establish stream.`); 
            clearInterval(this.listenKeyRefreshInterval);
            this.connectUserDataStream();
          }
        }, 30 * 60 * 1000);
      } catch (error) {
        console.error(`Failed to set up User Data Stream: ${error.message}`);
        await this.addLog(`ERROR setting up User Data Stream: ${error.message}`); // NEW LOG
        throw error; // Re-throw to stop strategy if WS setup fails
      }
      
      // Connect Real-time Price WebSocket here
      this.connectRealtimeWebSocket(); // Call renamed method

      // Detect existing position (initial check) - MOVED HERE
      await this.detectCurrentPosition();

      const canTrade = await this.checkCapitalProtection();
      if (!canTrade) {
        throw new Error('Capital protection circuit breaker triggered. Strategy cannot start.');
      }

      this.isTradingSequenceInProgress = true; // Set flag for initial order sequence

      // Initial order placement based on UI selection
      if (this.orderType === 'MARKET') {
        // For MARKET orders, _calculateAdjustedQuantity will use the current market price by default
        const quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT);
        if (quantity > 0) {
          if (this.buyLongEnabled) {
            //await this.addLog(`Placing initial BUY MARKET order for ${quantity} ${this.symbol}.`);
            const initialEntryLevel = this.entryLevel;
            await this.placeMarketOrder(this.symbol, 'BUY', quantity);
            await this._waitForPositionChange('LONG'); // Wait for position to be LONG
            this.activeMode = 'SUPPORT_ZONE';

            // Explicitly set entryPositionQuantity from current position quantity
            this.entryPositionQuantity = this.currentPositionQuantity;

            // Update Entry Level with actual filled position entry price
            this.entryLevel = this.positionEntryPrice;

            // Recalculate Reversal Level based on actual Entry Level
            if (this.reversalLevelPercentage !== null) {
              const previousReversalLevel = this.reversalLevel;
              this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
              await this.addLog(`Entry Level updated: ${this._formatPrice(initialEntryLevel)} -> ${this._formatPrice(this.entryLevel)} (actual fill price).`);
              await this.addLog(`Reversal Level updated: ${this._formatPrice(previousReversalLevel)} -> ${this._formatPrice(this.reversalLevel)} (Support Zone).`);
            }

            // Log initial position immediately after confirmation
            await this.addLog(`Initial ${this.currentPosition} position established. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);

            // Set strategy start time after position is filled
            this.strategyStartTime = new Date();
            await this.addLog(`Strategy timer started after initial position filled.`);

            // Calculate exit threshold, BE, and final TP for initial position
            await this._calculateExitThreshold();
            await this._calculateBreakevenAndFinalTp();
          } else if (this.sellShortEnabled) {
            //await this.addLog(`Placing initial SELL MARKET order for ${quantity} ${this.symbol}.`);
            const initialEntryLevel = this.entryLevel;
            await this.placeMarketOrder(this.symbol, 'SELL', quantity);
            await this._waitForPositionChange('SHORT'); // Wait for position to be SHORT
            this.activeMode = 'RESISTANCE_ZONE';

            // Explicitly set entryPositionQuantity from current position quantity
            this.entryPositionQuantity = this.currentPositionQuantity;

            // Update Entry Level with actual filled position entry price
            this.entryLevel = this.positionEntryPrice;

            // Recalculate Reversal Level based on actual Entry Level
            if (this.reversalLevelPercentage !== null) {
              const previousReversalLevel = this.reversalLevel;
              this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
              await this.addLog(`Entry Level updated: ${this._formatPrice(initialEntryLevel)} -> ${this._formatPrice(this.entryLevel)} (actual fill price).`);
              await this.addLog(`Reversal Level updated: ${this._formatPrice(previousReversalLevel)} -> ${this._formatPrice(this.reversalLevel)} (Resistance Zone).`);
            }

            // Log initial position immediately after confirmation
            await this.addLog(`Initial ${this.currentPosition} position established. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);

            // Set strategy start time after position is filled
            this.strategyStartTime = new Date();
            await this.addLog(`Strategy timer started after initial position filled.`);

            // Calculate exit threshold, BE, and final TP for initial position
            await this._calculateExitThreshold();
            await this._calculateBreakevenAndFinalTp();
          }
        } else {
          throw new Error('Calculated quantity for initial MARKET order is zero or negative.');
        }
        this.isTradingSequenceInProgress = false; // Reset flag after initial MARKET order sequence
      } else if (this.orderType === 'LIMIT') {
        // For LIMIT orders, _calculateAdjustedQuantity will use the specified limit price
        let quantity;
        let initialOrderPlaced = false; // Flag to track if any limit order was successfully placed

        if (this.buyLongEnabled && this.buyLimitPrice !== null) {
          quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT, this.buyLimitPrice);
          if (quantity > 0) {
            try {
              const orderResult = await this.placeLimitOrder(this.symbol, 'BUY', quantity, this.buyLimitPrice);
              this.longLimitOrderId = orderResult.orderId;
              initialOrderPlaced = true;
              // Store timeout for this order
              const timeoutId = setTimeout(async () => {
                await this.addLog(`Timeout for initial BUY LIMIT order ${this.longLimitOrderId}. Querying status via REST API.`);
                try {
                  const queriedOrder = await this._queryOrder(this.symbol, this.longLimitOrderId);
                  if (queriedOrder.status === 'FILLED') {
                    await this.addLog(`Initial BUY LIMIT order ${this.longLimitOrderId} found FILLED via REST API after WS timeout.`);
                    await this._handleInitialLimitOrderFill(queriedOrder);
                  } else if (queriedOrder.status === 'CANCELED' || queriedOrder.status === 'REJECTED' || queriedOrder.status === 'EXPIRED') {
                    await this.addLog(`Initial BUY LIMIT order ${this.longLimitOrderId} found ${queriedOrder.status} via REST API after WS timeout.`);
                    await this._handleInitialLimitOrderFailure(queriedOrder);
                  } else {
                    // Order is still NEW or PARTIALLY_FILLED. Log and continue waiting via WS.
                    await this.addLog(`Initial BUY LIMIT order ${this.longLimitOrderId} still ${queriedOrder.status} via REST API after WS timeout. Continuing to wait for WS update.`);
                  }
                } catch (queryError) {
                  await this.addLog(`Error during REST API query for initial BUY LIMIT order ${this.longLimitOrderId} after WS timeout: ${queryError.message}`);
                  await this._handleInitialLimitOrderFailure({ i: this.longLimitOrderId, X: 'QUERY_FAILED' }); // Treat query failure as order failure
                } finally {
                  this.pendingInitialLimitOrders.delete(this.longLimitOrderId); // Clean up timeout entry
                }
              }, 15000); // 15 seconds timeout
              this.pendingInitialLimitOrders.set(this.longLimitOrderId, { timeoutId }); // Store timeoutId
            } catch (error) {
              await this.addLog(`Initial BUY LIMIT order placement failed: ${error.message}`);
              this.isTradingSequenceInProgress = false; // Reset flag on placement failure
              throw error; // Re-throw to stop strategy if initial order fails
            }
          } else {
            throw new Error('Calculated quantity for initial BUY LIMIT order is zero or negative.');
          }
        }
        
        if (this.sellShortEnabled && this.sellLimitPrice !== null) {
          quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT, this.sellLimitPrice);
          if (quantity > 0) {
            try {
              //await this.addLog(`Placing initial SELL LIMIT order for ${quantity} at ${this.sellLimitPrice}.`);
              this._pendingLogMessage = 'initial'; // Set flag before order
              const orderResult = await this.placeLimitOrder(this.symbol, 'SELL', quantity, this.sellLimitPrice);
              this.shortLimitOrderId = orderResult.orderId;
              initialOrderPlaced = true;
              // Store timeout for this order
              const timeoutId = setTimeout(async () => {
                await this.addLog(`Timeout for initial SELL LIMIT order ${this.shortLimitOrderId}. Querying status via REST API.`);
                try {
                  const queriedOrder = await this._queryOrder(this.symbol, this.shortLimitOrderId);
                  if (queriedOrder.status === 'FILLED') {
                    await this.addLog(`Initial SELL LIMIT order ${this.shortLimitOrderId} found FILLED via REST API after WS timeout.`);
                    await this._handleInitialLimitOrderFill(queriedOrder);
                  } else if (queriedOrder.status === 'CANCELED' || queriedOrder.status === 'REJECTED' || queriedOrder.status === 'EXPIRED') {
                    await this.addLog(`Initial SELL LIMIT order ${this.shortLimitOrderId} found ${queriedOrder.status} via REST API after WS timeout.`);
                    await this._handleInitialLimitOrderFailure(queriedOrder);
                  } else {
                    // Order is still NEW or PARTIALLY_FILLED. Log and continue waiting via WS.
                    await this.addLog(`Initial SELL LIMIT order ${this.shortLimitOrderId} still ${queriedOrder.status} via REST API after WS timeout. Continuing to wait for WS update.`);
                  }
                } catch (queryError) {
                  await this.addLog(`Error during REST API query for initial SELL LIMIT order ${this.shortLimitOrderId} after WS timeout: ${queryError.message}`);
                  await this._handleInitialLimitOrderFailure({ i: this.shortLimitOrderId, X: 'QUERY_FAILED' }); // Treat query failure as order failure
                } finally {
                  this.pendingInitialLimitOrders.delete(this.shortLimitOrderId); // Clean up timeout entry
                }
              }, 16000); // 15 seconds timeout
              this.pendingInitialLimitOrders.set(this.shortLimitOrderId, { timeoutId }); // Store timeoutId
            } catch (error) {
              await this.addLog(`Initial SELL LIMIT order placement failed: ${error.message}`);
              this.isTradingSequenceInProgress = false; // Reset flag on placement failure
              throw error; // Re-throw to stop strategy if initial order fails
            }
          } else {
            throw new Error('Calculated quantity for initial SELL LIMIT order is zero or negative.');
          }
        }

        if (!initialOrderPlaced) {
          // If no initial LIMIT order was even placed (e.g., due to quantity error or neither buy/sell enabled)
          this.isTradingSequenceInProgress = false; // Reset flag
          throw new Error('No initial LIMIT order was placed. Strategy cannot start.');
        }
        // isTradingSequenceInProgress remains true until the LIMIT order is filled (handled in userDataWs.on('message') or timeout)
      }
      
    } catch (error) {
      console.error(`Failed to initialize strategy settings: ${error.message}`); 
      await this.addLog(`ERROR during strategy initialization: ${error.message}`);
      // Ensure isRunning is false if initialization fails
      this.isRunning = false;
      this.isTradingSequenceInProgress = false; // Reset flag on error
      throw error;
    }

    await this.addLog(`Strategy started:`);
    await this.addLog(`  Pair: ${this.symbol}`);
    await this.addLog(`  Initial Base Pos. Size: ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT`); // Log initial base
    await this.addLog(`  Max Exposure: ${this._formatNotional(this.MAX_POSITION_SIZE_USDT)} USDT`); // Log max exposure
    await this.addLog(`  Leverage: 50x`);
    await this.addLog(`  Pos. Mode: One-way`);
    await this.addLog(`  Reversal %: ${this.reversalLevelPercentage !== null ? `${this.reversalLevelPercentage}%` : 'N/A'}`);
    await this.addLog(`  Recovery Factor: ${this.RECOVERY_FACTOR * 100}%`);
    const currentProfitPercentage = this.exitCount >= 16 ? 1.05 : 1.55;
    await this.addLog(`  Desired Profit %: ${currentProfitPercentage}%`);
    await this.addLog(`  Order Type: ${this.orderType}`);
    await this.addLog(`  Buy/Long Enabled: ${this.buyLongEnabled}`);
    if (this.buyLongEnabled && this.buyLimitPrice !== null) await this.addLog(`    Buy Limit Price: ${this.buyLimitPrice}`);
    await this.addLog(`  Sell/Short Enabled: ${this.sellShortEnabled}`);
    if (this.sellShortEnabled && this.sellLimitPrice !== null) await this.addLog(`    Sell Limit Price: ${this.sellLimitPrice}`);

    // Entry Level and Reversal Level logging
    if (this.orderType === 'LIMIT') {
      // For LIMIT orders, Entry Level and Reversal Level are calculated after position fill
      await this.addLog(`  Entry Level: Awaiting position fill`);
      await this.addLog(`  Reversal Level: Awaiting position fill`);
    } else if (this.orderType === 'MARKET' && this.entryLevel !== null) {
      // For MARKET orders, show the corrected Entry Level (actual fill price)
      await this.addLog(`  Entry Level: ${this._formatPrice(this.entryLevel)} (actual fill)`);
      await this.addLog(`  Reversal Level: ${this.reversalLevel !== null ? this._formatPrice(this.reversalLevel) : 'N/A'}`);
    } else {
      // Fallback for edge cases
      await this.addLog(`  Entry Level: ${this.entryLevel !== null ? this._formatPrice(this.entryLevel) : 'N/A'}`);
      await this.addLog(`  Reversal Level: ${this.reversalLevel !== null ? this._formatPrice(this.reversalLevel) : 'N/A'}`);
    }

    // For LIMIT orders, Active Zone is determined after position fill
    if (this.orderType === 'LIMIT' && this.activeMode === 'NONE') {
      await this.addLog(`  Active Zone: Awaiting position fill`);
    } else {
      await this.addLog(`  Active Zone: ${this.activeMode === 'SUPPORT_ZONE' ? 'Support Zone' : this.activeMode === 'RESISTANCE_ZONE' ? 'Resistance Zone' : 'N/A'}`);
    }
    await this.addLog(`  Maximum Allowable Loss: ${this.maxAllowableLoss !== null ? `${this.maxAllowableLoss}` : 'N/A'}`);
    
    this.isRunning = true;
    return this.strategyId;
  }

  // New method to update strategy configuration
  async updateConfig(newConfig) {
    if (!this.isRunning) {
      await this.addLog('Cannot update config: Strategy is not running.');
      throw new Error('Strategy is not running.');
    }
    
    // Update specific config parameters
    if (newConfig.initialBasePositionSizeUSDT !== undefined && newConfig.initialBasePositionSizeUSDT !== null) {
      const oldInitialBasePositionSizeUSDT = this.initialBasePositionSizeUSDT;
      this.initialBasePositionSizeUSDT = newConfig.initialBasePositionSizeUSDT;
      
      // Recalculate MAX_POSITION_SIZE_USDT based on the new initialBasePositionSizeUSDT
      this.MAX_POSITION_SIZE_USDT = (3 / 4) * this.initialBasePositionSizeUSDT * 50;

      await this.addLog(`Updated initialBasePositionSizeUSDT from ${this._formatNotional(oldInitialBasePositionSizeUSDT)} to ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT.`);
      await this.addLog(`New Max Exposure calculated: ${this._formatNotional(this.MAX_POSITION_SIZE_USDT)} USDT.`);
    }
    // Add other configurable parameters here as needed
    
    await this.saveState(); // Persist the updated config
    await this.addLog('Strategy configuration updated and saved.');
  }

  async stop() {
    // Prevent multiple calls to stop()
    if (this.isStopping) {
      await this.addLog('Stop already in progress, ignoring duplicate stop request.');
      return;
    }
    
    this.isRunning = false;
    this.isStopping = true; // Set flag to indicate strategy is stopping
    this.strategyEndTime = new Date(); // Set end time

    // Clear all pending timeouts and intervals FIRST to prevent race conditions
    if (this.listenKeyRefreshInterval) {
      clearInterval(this.listenKeyRefreshInterval);
      this.listenKeyRefreshInterval = null;
    }
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);
    if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);
    if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
    if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);
    if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
    if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);

    // Cancel any pending limit orders first
    if (this.longLimitOrderId) {
      await this.cancelOrder(this.symbol, this.longLimitOrderId);
      this.longLimitOrderId = null;
    }
    if (this.shortLimitOrderId) {
      await this.cancelOrder(this.symbol, this.shortLimitOrderId);
      this.shortLimitOrderId = null;
    }

    // Clear any pending initial LIMIT order timeouts
    for (const [orderId, { timeoutId }] of this.pendingInitialLimitOrders.entries()) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.pendingInitialLimitOrders.delete(orderId);
    }

    // Close active position first, if any
    if (this.currentPosition !== 'NONE') {
      try {
        await this.closeCurrentPosition(); // This places the market order to close
        await this.addLog(`Position closed: ${this.currentPosition} for ${this.symbol}.`);
        // Wait for confirmation that position is NONE, then detectCurrentPosition will null out internal state
        await this._waitForPositionChange('NONE'); 
        await this.addLog('Position confirmed as NONE after stop request.');
      } catch (err) {
        console.error(`Failed to close position or confirm closure for ${this.symbol}: ${err.message}`);
        await this.addLog(`ERROR: Failed to close position or confirm closure: ${err.message}`);
        // Even if closing fails, we should still attempt to reset state and save
        // The frontend should then show the strategy as stopped, but with a warning about the position.
      }
    }

    // Only save wallet balance if there was trading activity (position opened/closed)
    if (this.accumulatedRealizedPnL !== 0 || this.accumulatedTradingFees !== 0 || this.tradeSequence !== '') {
      try {
        const futuresAccountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
        const totalWalletBalance = parseFloat(futuresAccountInfo.totalWalletBalance);
        if (!isNaN(totalWalletBalance)) {
          await this.firestore.collection('wallet_history').add({
            strategyId: this.strategyId,
            profileId: this.profileId, // ADDED: Save profileId with wallet history
            timestamp: new Date(),
            balance: totalWalletBalance,
          });
          await this.addLog(`Wallet balance ${totalWalletBalance.toFixed(2)} recorded to Firestore.`);

          // Calculate profitPercentage
          if (this.initialWalletBalance !== null && !isNaN(totalWalletBalance) && this.initialWalletBalance > 0) {
            //this.profitPercentage = ((totalWalletBalance - this.initialWalletBalance) / this.initialWalletBalance) * 100; // Calculate profit percentage relative to initial wallet balance
            this.profitPercentage = ((totalWalletBalance - this.initialWalletBalance) / this.initialBasePositionSizeUSDT) * 100; // Calculate profit percentage relative to config position size
            await this.addLog(`Profit Percentage: ${this.profitPercentage.toFixed(2)}%.`);

            // Deduct platform fee from reload balance if strategy was profitable
            const profitAmount = totalWalletBalance - this.initialWalletBalance;
            if (profitAmount > 0) {
              await this.deductPlatformFee(profitAmount);
            } else {
              await this.addLog('No profit made. Skipping platform fee deduction.');
            }
          } else {
            this.profitPercentage = null;
            await this.addLog(`Could not calculate profit percentage. Initial balance: ${this.initialWalletBalance}, Final balance: ${totalWalletBalance}`);
          }
        }
      } catch (error) {
        console.error(`Failed to record wallet balance or calculate profit percentage: ${error.message}`);
        await this.addLog(`Failed to record wallet balance or calculate profit percentage: ${error.message}`);
        this.profitPercentage = null; // Ensure it's null on error
      }
    } else {
      await this.addLog('No trading activity detected. Skipping wallet balance save.');
    }

    await this.saveState();

    await this.sendPushNotificationIfEnabled();

    // Now close WebSockets and invalidate ListenKey
    const closePromises = [];

    if (this.realtimeWs) {
      const realtimeClosePromise = new Promise(resolve => {
        this.realtimeWs.on('close', resolve);
        this.realtimeWs.close();
      });
      closePromises.push(realtimeClosePromise);
      this.realtimeWs = null;
      //await this.addLog('Closed Real-time Price WebSocket...');
    }

    if (this.userDataWs) {
      const userDataClosePromise = new Promise(resolve => {
        this.userDataWs.on('close', resolve);
        this.userDataWs.close();
      });
      closePromises.push(userDataClosePromise);
      this.userDataWs = null;
      //await this.addLog('Closed User Data Stream WebSocket...');
    }
    if (this.listenKey) {
      try {
        await this.makeProxyRequest('/fapi/v1/listenKey', 'DELETE', { listenKey: this.listenKey }, true, 'futures');
        await this.addLog(`ListenKey invalidated.`);
      } catch (error) {
        // Only log if strategy is not already stopping to avoid confusion
        if (!this.isStopping) {
          console.error(`Failed to invalidate listenKey: ${error.message}`);
        }
      }
      this.listenKey = null;
    }

    await Promise.all(closePromises);

    await this.addLog('Strategy stopped.');

    // Reset strategy state variables AFTER saving to Firestore and closing connections.
    // These resets are for the *instance* of the strategy, not for the historical record.
    this.currentPosition = 'NONE';
    this.positionEntryPrice = null;
    this.positionSize = null;
    this.activeMode = 'NONE';
    this.currentPrice = null;
    this.positionPnL = null;
    this.totalPnL = null;
    this.accumulatedRealizedPnL = 0; 
    this.accumulatedTradingFees = 0; 

    this.entryPositionQuantity = null;
    this.currentPositionQuantity = null;
    // Reset Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null;
    this.finalTpPercentage = null;

    this.supportLevel = null;
    this.resistanceLevel = null;
    this.enableSupport = false;
    this.enableResistance = false;
    this.supportReversalLevel = null;
    this.resistanceReversalLevel = null;

    this.orderType = 'MARKET';
    this.buyLongEnabled = false;
    this.sellShortEnabled = false;
    this.buyLimitPrice = null;
    this.sellLimitPrice = null;

    // Reset summary section data
    this.reversalCount = 0;
    this.exitCount = 0;
    this.tradeSequence = '';
    this.initialWalletBalance = null;
    this.profitPercentage = null;
    this.strategyStartTime = null;
    this.strategyEndTime = null;
    this.isStopping = false; // Reset flag at the very end
    this.isTradingSequenceInProgress = false;
  }

  async deductPlatformFee(profitAmount) {
    try {
      if (!this.profileId) {
        await this.addLog('No profileId available. Cannot deduct platform fee.');
        return;
      }

      // Find the user document by profileId
      const usersSnapshot = await this.firestore.collection('users').get();
      let userDocRef = null;

      for (const doc of usersSnapshot.docs) {
        const profilesSnapshot = await this.firestore.collection('users').doc(doc.id).collection('profiles').where('profileId', '==', this.profileId).limit(1).get();
        if (!profilesSnapshot.empty) {
          userDocRef = this.firestore.collection('users').doc(doc.id);
          break;
        }
      }

      if (!userDocRef) {
        await this.addLog('User document not found for platform fee deduction.');
        return;
      }

      // Calculate platform fee
      const platformFee = profitAmount * (PLATFORM_FEE_PERCENTAGE / 100);
      await this.addLog(`Platform Fee Calculation: Profit=${profitAmount.toFixed(8)} USDT, Fee Rate=${PLATFORM_FEE_PERCENTAGE}%, Fee Amount=${platformFee.toFixed(8)} USDT`);

      // Get user's wallet document
      const walletRef = userDocRef.collection('wallets').doc('default');
      const walletDoc = await walletRef.get();

      if (!walletDoc.exists) {
        await this.addLog('User wallet not found. Cannot deduct platform fee.');
        return;
      }

      const currentBalance = walletDoc.data().balance || 0;
      const newBalance = currentBalance - platformFee;

      if (newBalance < 0) {
        await this.addLog(`Warning: Platform fee deduction would result in negative balance. Current: ${currentBalance.toFixed(2)}, Fee: ${platformFee.toFixed(8)}, Skipping deduction.`);
        return;
      }

      // Deduct the fee from the reload balance
      await walletRef.update({
        balance: newBalance,
        updatedAt: new Date(),
      });

      await this.addLog(`Platform fee deducted successfully: ${platformFee.toFixed(8)} USDT. New reload balance: ${newBalance.toFixed(2)} USDT (was ${currentBalance.toFixed(2)} USDT)`);

      // Record the fee transaction in wallet history
      await this.firestore.collection('wallet_history').add({
        strategyId: this.strategyId,
        profileId: this.profileId,
        timestamp: new Date(),
        balance: newBalance,
        type: 'platform_fee',
        amount: -platformFee,
        description: `Platform fee (${PLATFORM_FEE_PERCENTAGE}%) deducted from profit`,
      });

    } catch (error) {
      console.error(`Error deducting platform fee: ${error.message}`);
      await this.addLog(`ERROR deducting platform fee: ${error.message}`);
    }
  }

  async getUserIdFromProfileId() {
    try {
      if (!this.profileId) {
        return null;
      }

      const usersSnapshot = await this.firestore.collection('users').get();

      for (const doc of usersSnapshot.docs) {
        const profilesSnapshot = await this.firestore.collection('users').doc(doc.id).collection('profiles').where('profileId', '==', this.profileId).limit(1).get();
        if (!profilesSnapshot.empty) {
          return doc.id;
        }
      }

      return null;
    } catch (error) {
      console.error(`Error looking up userId from profileId: ${error.message}`);
      return null;
    }
  }

  async sendPushNotificationIfEnabled() {
    try {
      if (!this.profileId) {
        await this.addLog('No profileId available. Skipping push notification.');
        return;
      }

      const userId = await this.getUserIdFromProfileId();

      if (!userId) {
        await this.addLog('User not found for push notification.');
        return;
      }

      const userDoc = await this.firestore.collection('users').doc(userId).get();
      if (!userDoc.exists) {
        await this.addLog('User not found for this profile. Skipping push notification.');
        return;
      }

      const userData = userDoc.data();

      const pushEnabled = userData.notificationPreferences?.pushNotificationsEnabled ?? false;

      if (!pushEnabled) {
        await this.addLog('Push notifications disabled for user. Skipping notification.');
        return;
      }

      if (this.capitalProtectionTriggered) {
        const lossAmount = this.initialWalletBalance !== null ? this.accumulatedRealizedPnL - this.accumulatedTradingFees : 0;
        const lossPercentage = this.initialWalletBalance > 0 ? (lossAmount / this.initialWalletBalance) * 100 : 0;

        const result = await sendCapitalProtectionNotification(userId, {
          strategyId: this.strategyId,
          symbol: this.symbol,
          lossAmount: lossAmount,
          lossPercentage: lossPercentage,
        });

        if (result.success) {
          await this.addLog(`Capital protection push notification sent successfully. Success: ${result.successCount}`);
        } else {
          await this.addLog(`Failed to send capital protection push notification: ${result.error}`);
        }
      } else if (this.finalTpActive && this.profitPercentage !== null) {
        const timeTaken = this.strategyStartTime && this.strategyEndTime
          ? this.calculateTimeTaken(this.strategyStartTime, this.strategyEndTime)
          : 'N/A';

        const netPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;

        const result = await sendStrategyCompletionNotification(userId, {
          strategyId: this.strategyId,
          symbol: this.symbol,
          netPnL: netPnL,
          profitPercentage: this.profitPercentage,
          timeTaken: timeTaken,
          tradeCount: this.tradeSequence.length,
        });

        if (result.success) {
          await this.addLog(`Strategy completion push notification sent successfully. Success: ${result.successCount}`);
        } else {
          await this.addLog(`Failed to send strategy completion push notification: ${result.error}`);
        }
      }
    } catch (error) {
      console.error('Error sending push notification:', error);
      await this.addLog(`Error sending push notification: ${error.message}`);
    }
  }

  calculateTimeTaken(startTime, endTime) {
    const diffMs = endTime - startTime;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;

    if (diffHours > 0) {
      return `${diffHours}h ${mins}m`;
    }
    return `${mins}m`;
  }

  async getStatus() {
    // In a real scenario, this would fetch live data from Binance
    // For simulation, we return current internal state
    return {
      strategyId: this.strategyId,
      symbol: this.symbol,
      positionSizeUSDT: this.positionSizeUSDT,
      supportLevel: this.supportLevel,
      resistanceLevel: this.resistanceLevel,
      enableSupport: this.enableSupport,
      enableResistance: this.enableResistance,
      reversalLevelPercentage: this.reversalLevelPercentage,
      orderType: this.orderType,
      buyLongEnabled: this.buyLongEnabled,
      sellShortEnabled: this.sellShortEnabled,
      buyLimitPrice: this.buyLimitPrice,
      sellLimitPrice: this.sellLimitPrice,
      // Summary fields
      reversalCount: this.reversalCount,
      exitCount: this.exitCount,
      breakevenPrice: this.breakevenPrice,
      finalTpPrice: this.finalTpPrice,
      initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
      exitThreshold: this.exitThreshold,
      MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT,
      reentryMonitoring: this.reentryMonitoring,
      reentryLevel: this.reentryLevel,
      previousPositionDirection: this.previousPositionDirection,
      profitPercentage: this.profitPercentage,
      strategyStartTime: this.strategyStartTime,
      strategyEndTime: this.strategyEndTime,
      tradeSequence: this.tradeSequence,
      breakevenPercentage: this.breakevenPercentage,
      finalTpPercentage: this.finalTpPercentage,
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,
      // Capital Protection Status
      capitalProtection: {
        triggered: this.capitalProtectionTriggered,
        warning: this.capitalProtectionWarning,
        currentLossPercentage: this.calculateLossPercentage(),
        maxLossPercentage: MAX_LOSS_PERCENTAGE,
        warningLossPercentage: WARNING_LOSS_PERCENTAGE,
        initialWalletBalance: this.initialWalletBalance,
        currentLoss: this.calculateCurrentLoss(),
        maxAllowableLoss: this.maxAllowableLoss,
        circuitBreakerTimestamp: this.circuitBreakerTimestamp,
      },
      // Current state for display
      currentState: {
        currentPosition: this.currentPosition,
        positionEntryPrice: this.positionEntryPrice,
        positionSize: this.positionSize,
        currentPrice: this.currentPrice,
        positionPnL: this.positionPnL,
        totalPnL: this.totalPnL,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        currentPositionQuantity: this.currentPositionQuantity,
      }
    };
  }
}

export default TradingStrategy;
