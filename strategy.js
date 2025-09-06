import { Firestore } from '@google-cloud/firestore';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Constants for WebSocket reconnection
const INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
const MAX_RECONNECT_DELAY_MS = 60000; // 60 seconds
const MAX_RECONNECT_ATTEMPTS = 10; // Max attempts before giving up or requiring manual intervention

// Heartbeat constants
const PING_INTERVAL_MS = 30000; // Send ping every 30 seconds
const PONG_TIMEOUT_MS = 10000; // Expect pong within 10 seconds

class TradingStrategy {
  constructor(gcfProxyUrl) {
    // Initialize Firestore project ID and database ID
    this.firestore = new Firestore({
      ignoreUndefinedProperties: true,
      projectId: 'atos-fac0d',
      databaseId: 'ycbot-firestore',
    });
    this.tradesCollectionRef = null; // Initialized here, set in start() and loadState()
    this.logsCollectionRef = null; // NEW: Firestore collection for logs
    this.realtimeWs = null;
    this.userDataWs = null; // WebSocket for User Data Stream
    this.listenKey = null; // Binance listenKey for User Data Stream
    this.listenKeyRefreshInterval = null; // Interval for refreshing listenKey
    this.strategyId = null;
    this.isRunning = false;
    this.gcfProxyUrl = gcfProxyUrl;
    
    // Dynamic threshold trading strategy state variables
    this.supportLevel = null;
    this.resistanceLevel = null;
    this.enableSupport = false; // Indicates if support level is active for initial entry
    this.enableResistance = false; // Indicates if resistance level is active for initial entry
    this.currentPosition = 'NONE'; // 'LONG' | 'SHORT' | 'NONE'
    this.positionEntryPrice = null;
    this.positionSize = null; // in notional USDT
    this.activeMode = 'NONE'; // 'RESISTANCE_DRIVEN' | 'SUPPORT_DRIVEN' | 'NONE'
    
    // Real-time price and PnL for status checks
    this.currentPrice = null;
    this.positionPnL = null; // Single position PnL
    this.totalPnL = null;

    // PnL breakdown variables (overall accumulated)
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;

    // NEW: Partial TP states
    this.entryPositionQuantity = null; // Quantity of the position at initial entry (in base asset, e.g., BTC)
    this.currentPositionQuantity = null; // Current quantity of the open position, which will decrease as partial TPs are executed.
    this.partialTp1Hit = false;
    this.accumulatedRealizedPnLForCurrentTrade = 0; // PnL from partial TPs for the current trade
    this.accumulatedTradingFeesForCurrentTrade = 0; // Fees from partial TPs for the current trade
    this.feeRate = 0.0005; // 0.04% for Binance Futures (Taker fee)
    this.partialTpConfig = []; // Initialize as empty, will be set dynamically

    // NEW: Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null; // NEW
    this.finalTpPercentage = null; // NEW

    // Reversal levels
    this.reversalLevelPercentage = null; // Initialize to null, will be set from config
    this.supportReversalLevel = null;
    this.resistanceReversalLevel = null;

    // Reversal Method selection
    this.reversalMethod = 'currentPrice'; // Hardcoded to 'currentPrice'

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
    this.timeframe = '1h';
    this.symbol = 'BTCUSDT'; // Default trading symbol
    this.positionSizeUSDT = 0; // Default position size in USDT

    // Dynamic Position Sizing Constants
    this.initialBasePositionSizeUSDT = null; // Initialized to null, must come from config or loaded state
    this.RECOVERY_FACTOR = 0.2; // Percentage of accumulated loss to target for recovery in next trade's TP
    this.MAX_POSITION_SIZE_USDT = 0; // Will be set dynamically in start()

    // Binance exchange info cache for precision and step size
    this.exchangeInfoCache = {}; // Stores tickSize, stepSize, minQty, maxQty, minNotional for each symbol
    
    // Testnet status
    this.isTestnet = null;

    // Map to store pending order promises, resolving when order is filled/rejected
    this.pendingOrders = new Map();

    // New: Flag for pending log message after position update
    this._pendingLogMessage = null;

    // Summary section data
    this.reversalCount = 0;
    this.partialTpCount = 0;
    this.tradeSequence = ''; // NEW
    this.initialWalletBalance = null;
    this.profitPercentage = null;
    this.strategyStartTime = null;
    this.strategyEndTime = null;

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
    
    const logEntry = `${timestamp}: ${message}`;
    console.log(logEntry);
    
    // Filter out specific messages from being broadcast to the frontend
    const messagesToFilter = [
      'WebSocket client connected for logs',
      'WebSocket client disconnected for logs'
    ];

    // NEW: Save log to Firestore
    if (this.strategyId && !messagesToFilter.some(filterMsg => message.includes(filterMsg))) {
      try {
        await this.logsCollectionRef.add({
          message: logEntry,
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

  async saveState() {
    if (!this.strategyId) return;
    
    try {
      const dataToSave = {
        supportLevel: this.supportLevel,
        resistanceLevel: this.resistanceLevel,
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
        timeframe: this.timeframe,
        symbol: this.symbol,
        positionSizeUSDT: this.positionSizeUSDT,
        initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
        MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT, // ADDED THIS LINE
        supportReversalLevel: this.supportReversalLevel,
        resistanceReversalLevel: this.resistanceReversalLevel,
        reversalMethod: this.reversalMethod,
        reversalLevelPercentage: this.reversalLevelPercentage, // Add to saveState
        // NEW: Partial TP states
        entryPositionQuantity: this.entryPositionQuantity,
        currentPositionQuantity: this.currentPositionQuantity,
        partialTp1Hit: this.partialTp1Hit,
        accumulatedRealizedPnLForCurrentTrade: this.accumulatedRealizedPnLForCurrentTrade,
        accumulatedTradingFeesForCurrentTrade: this.accumulatedTradingFeesForCurrentTrade,
        // NEW: Final TP states
        breakevenPrice: this.breakevenPrice,
        finalTpPrice: this.finalTpPrice,
        finalTpActive: this.finalTpActive,
        finalTpOrderSent: this.finalTpOrderSent,
        breakevenPercentage: this.breakevenPercentage, // NEW
        finalTpPercentage: this.finalTpPercentage,     // NEW
        // NEW: Order Type and Direction states
        orderType: this.orderType,
        buyLongEnabled: this.buyLongEnabled,
        sellShortEnabled: this.sellShortEnabled,
        buyLimitPrice: this.buyLimitPrice,
        sellLimitPrice: this.sellLimitPrice,
        longLimitOrderId: this.longLimitOrderId,
        shortLimitOrderId: this.shortLimitOrderId,
        // NEW: Summary section data
        reversalCount: this.reversalCount,
        partialTpCount: this.partialTpCount,
        tradeSequence: this.tradeSequence, // NEW
        initialWalletBalance: this.initialWalletBalance,
        profitPercentage: this.profitPercentage,
        strategyStartTime: this.strategyStartTime,
        strategyEndTime: this.strategyEndTime,
      };

      await this.firestore
        .collection('strategies')
        .doc(this.strategyId)
        .update(dataToSave);
    } catch (error) {
      console.error('Failed to save state to Firestore:', error);
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
        this.supportLevel = data.supportLevel;
        this.resistanceLevel = data.resistanceLevel;
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
        await this.addLog(`Loaded state. Acc. Fees: ${this.accumulatedTradingFees.toFixed(8)}`);
        this.timeframe = data.timeframe || '1h';
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

        this.supportReversalLevel = data.supportReversalLevel || null;
        this.resistanceReversalLevel = data.resistanceReversalLevel || null;
        this.reversalMethod = data.reversalMethod || 'currentPrice';
        this.reversalLevelPercentage = data.reversalLevelPercentage !== undefined ? data.reversalLevelPercentage : null; // Add to loadState

        // NEW: Load Partial TP states
        this.entryPositionQuantity = data.entryPositionQuantity || null;
        this.currentPositionQuantity = data.currentPositionQuantity || null;
        this.partialTp1Hit = data.partialTp1Hit || false;
        this.accumulatedRealizedPnLForCurrentTrade = data.accumulatedRealizedPnLForCurrentTrade || 0;
        this.accumulatedTradingFeesForCurrentTrade = data.accumulatedTradingFeesForCurrentTrade || 0;
        this.feeRate = 0.0005; // Ensure fee rate is set on load
        
        // NEW: Load Final TP states
        this.breakevenPrice = data.breakevenPrice || null;
        this.finalTpPrice = data.finalTpPrice || null;
        this.finalTpActive = data.finalTpActive || false;
        this.finalTpOrderSent = data.finalTpOrderSent || false;
        this.breakevenPercentage = data.breakevenPercentage || null; // NEW
        this.finalTpPercentage = data.finalTpPercentage || null;     // NEW

        // NEW: Load Order Type and Direction states
        this.orderType = data.orderType || 'MARKET';
        this.buyLongEnabled = data.buyLongEnabled || false;
        this.sellShortEnabled = data.sellShortEnabled || false;
        this.buyLimitPrice = data.buyLimitPrice || null;
        this.sellLimitPrice = data.sellLimitPrice || null;
        this.longLimitOrderId = data.longLimitOrderId || null;
        this.shortLimitOrderId = data.shortLimitOrderId || null;

        // NEW: Load Summary section data
        this.reversalCount = data.reversalCount || 0;
        this.partialTpCount = data.partialTpCount || 0;
        this.tradeSequence = data.tradeSequence || ''; // NEW
        this.initialWalletBalance = data.initialWalletBalance || null;
        this.profitPercentage = data.profitPercentage || null;
        this.strategyStartTime = data.strategyStartTime ? data.strategyStartTime.toDate() : null;
        this.strategyEndTime = data.strategyEndTime ? data.strategyEndTime.toDate() : null;

        // Calculate partialTpConfig based on loaded reversalLevelPercentage
        if (this.reversalLevelPercentage !== null) {
          const tp1PercentFromEntry = (this.reversalLevelPercentage / 100) * 1; //Jacky Liaw: Changed the multiplier from 0.5 to 1
          this.partialTpConfig = [
            { id: 1, percentFromEntry: tp1PercentFromEntry, tpPercentOfEntrySize: 0.3, hitFlag: 'partialTp1Hit' },
          ];
        } else {
          this.partialTpConfig = []; // Or set a default if reversalLevelPercentage is null
        }
        
        await this._getExchangeInfo(this.symbol); // Use the new method to fetch and cache exchange info

        this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
        this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs'); // NEW: Initialize logs collection ref

        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to load state from Firestore:', error);
      return false;
    }
  }

  // Make API calls through GCF proxy
  async makeProxyRequest(endpoint, method = 'GET', params = {}, signed = false, apiType = 'spot') {
    try {
      const response = await fetch(this.gcfProxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint,
          method,
          params,
          apiType,
          signed,
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
    if (notional === null || notional === undefined) return 'N/A';
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

        this.exchangeInfoCache[symbol] = {
          tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
          stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.000001,
          minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0,
          maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : Infinity,
          minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 0,
          precision: lotSizeFilter ? this._getPrecision(parseFloat(lotSizeFilter.stepSize)) : 6, // Store precision for quantity
        };
        //await this.addLog(`Exchange info for ${symbol} fetched and cached.`);
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
  async _calculateAdjustedQuantity(symbol, positionSizeUSDT) {
    const currentPrice = await this._getCurrentPrice(symbol);
    if (!currentPrice || currentPrice <= 0) {
      throw new Error(`Invalid current price for ${symbol}: ${currentPrice}`);
    }

    const { minQty, maxQty, stepSize, precision, minNotional } = await this._getExchangeInfo(symbol);

    let rawQuantity = positionSizeUSDT / currentPrice;

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
    const notionalValue = adjustedQuantity * currentPrice;
    if (notionalValue < minNotional) {
        this.addLog(`Calculated notional value ${this._formatNotional(notionalValue)} is less than minNotional ${this._formatNotional(minNotional)}. Adjusting quantity to meet minNotional.`);
        adjustedQuantity = Math.ceil(minNotional / currentPrice / stepSize) * stepSize;
        adjustedQuantity = parseFloat(adjustedQuantity.toFixed(precision));
        this.addLog(`Adjusted quantity to ${adjustedQuantity} to meet minNotional.`);
    }

    this.addLog(`Calculated adjusted quantity for ${symbol}: ${adjustedQuantity} (from ${this._formatNotional(positionSizeUSDT)} USDT at ${this._formatPrice(currentPrice)} price)`);
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

  // NEW: Check for any existing open orders or positions
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

  // NEW: Place a limit order and return a Promise that resolves upon order fill
  async placeLimitOrder(symbol, side, quantity, price) {
    if (quantity <= 0) {
      throw new Error('Calculated quantity is zero or negative.');
    }
    if (price <= 0) {
      throw new Error('Limit price is zero or negative.');
    }

    const roundedPrice = this.roundPrice(price);
    const roundedQuantity = this.roundQuantity(quantity);

    return new Promise(async (resolve, reject) => {
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
          this.pendingOrders.set(result.orderId, { resolve, reject });
          await this.addLog(`Placed LIMIT ${side} order ${result.orderId} for ${roundedQuantity} at ${roundedPrice}.`);
          resolve(result); // Resolve immediately with order details, actual fill will be handled by WS
        } else {
          reject(new Error('Limit order placement failed: No orderId in response.'));
        }
      } catch (error) {
        await this.addLog(`Failed to place limit order: ${error.message}`);
        reject(error);
      }
    });
  }

  // NEW: Cancel an order
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

  async placePartialTpOrder(symbol, side, quantity) {
    if (quantity <= 0) {
      throw new Error('Calculated quantity for partial TP is zero or negative.');
    }

    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', {
          symbol,
          side,
          type: 'MARKET',
          quantity: quantity,
          newOrderRespType: 'FULL'
        }, true, 'futures');
        
        if (result && result.orderId) {
          this.pendingOrders.set(result.orderId, { resolve, reject });
          resolve(result);
        } else {
          reject(new Error('Partial TP order placement failed: No orderId in response.'));
        }
      } catch (error) {
        await this.addLog(`Failed to place partial TP order: ${error.message}`);
        reject(error); // Re-throw for calling function to handle
      }
    });
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
  async detectCurrentPosition() {
    //await this.addLog(`Current position before detection: ${this.currentPosition}`);
    try {
      const positions = await this.getCurrentPositions();
      
      if (positions.length === 0) {
        this.currentPosition = 'NONE';
        this.positionEntryPrice = null;
        this.positionSize = null;
        this.entryPositionQuantity = null;
        this.currentPositionQuantity = null;
        this.partialTp1Hit = false;
        this.accumulatedRealizedPnLForCurrentTrade = 0;
        this.accumulatedTradingFeesForCurrentTrade = 0;
        // Reset Final TP states
        this.breakevenPrice = null;
        this.finalTpPrice = null;
        this.finalTpActive = false;
        this.finalTpOrderSent = false;
        this.breakevenPercentage = null;
        this.finalTpPercentage = null;
        //await this.addLog(`Partial TP and Final TP flags reset due to position becoming NONE.`);
      } else if (positions.length === 1) {
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);
      } else {
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);
      }

      // NEW: Calculate Breakeven and Final TP after TP1 is hit and position is updated
      if (this.partialTp1Hit && !this.finalTpActive && this.currentPosition !== 'NONE') {
        if (this.currentPositionQuantity > 0 && this.positionEntryPrice !== null) {
          // Calculate Breakeven Price
          let breakevenPriceRaw;
          // Use overall accumulated PnL and fees for breakeven calculation
          const netRealizedPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;

          // Add detailed logging for breakeven calculation
          await this.addLog(`BE Calc: Acc. Realized PnL: ${this.accumulatedRealizedPnL.toFixed(8)}`);
          await this.addLog(`BE Calc: Acc. Trading Fees: ${this.accumulatedTradingFees.toFixed(8)}`);
          await this.addLog(`BE Calc: Net Realized PnL (overall): ${netRealizedPnL.toFixed(8)}`);
          await this.addLog(`BE Calc: Current Position Quantity: ${this.currentPositionQuantity.toFixed(8)}`);

          if (this.currentPosition === 'LONG') {
            breakevenPriceRaw = this.positionEntryPrice - (netRealizedPnL / this.currentPositionQuantity);
          } else { // SHORT
            breakevenPriceRaw = this.positionEntryPrice + (netRealizedPnL / this.currentPositionQuantity);
          }
          await this.addLog(`BE Calc: Raw Breakeven Price: ${breakevenPriceRaw.toFixed(8)}`);
          this.breakevenPrice = this.roundPrice(breakevenPriceRaw);

          // Calculate Breakeven Percentage (NEW)
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
            bePercentFromEntry = 0;
          }

          // Add 0.05% to cover trading fees for the final TP
          const finalTpPercentFromEntry = bePercentFromEntry + 2 + 0.05; 

          let finalTpPriceRaw;
          if (this.currentPosition === 'LONG') {
            finalTpPriceRaw = this.positionEntryPrice * (1 + finalTpPercentFromEntry / 100);
          } else { // SHORT
            finalTpPriceRaw = this.positionEntryPrice * (1 - finalTpPercentFromEntry / 100);
          }
          this.finalTpPrice = this.roundPrice(finalTpPriceRaw);
          this.finalTpActive = true;

          // Calculate Final TP Percentage (NEW)
          if (this.positionEntryPrice !== 0) {
            this.finalTpPercentage = ((this.currentPosition === 'LONG' ? this.finalTpPrice - this.positionEntryPrice : this.positionEntryPrice - this.finalTpPrice) / this.positionEntryPrice) * 100;
            if (this.finalTpPercentage < 0) this.finalTpPercentage = 0; // Ensure non-negative
          } else {
            this.finalTpPercentage = null;
          }

          await this.addLog(`Final TP: Breakeven Price: ${this._formatPrice(this.breakevenPrice)} (${this.breakevenPercentage.toFixed(2)}% from entry).`);
          await this.addLog(`Final TP: Final TP Price: ${this._formatPrice(this.finalTpPrice)} (${this.finalTpPercentage.toFixed(2)}% from entry).`);
        } else {
          await this.addLog(`Final TP: Cannot calculate BE/Final TP: currentPositionQuantity is zero or positionEntryPrice is null.`);
        }
      }

      //await this.addLog(`Updated currentPositionQuantity: ${this._formatQuantity(this.currentPositionQuantity)}`);

      // Trigger consolidated log message after position state is updated
      if (this._pendingLogMessage === 'initial') {
          await this.addLog(`Initial ${this.currentPosition} position established. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);
          this._pendingLogMessage = null;
      } else if (this._pendingLogMessage === 'reversal') {
          await this.addLog(`Position reversed to ${this.currentPosition}. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);
          this._pendingLogMessage = null;
      }
    } catch (error) {
      console.error(`Failed to detect current position for ${this.symbol}: ${error.message}`);
    }
  }

  // New helper function to wait for a specific position state
  async _waitForPositionChange(targetPosition, timeoutMs = 15000) {
    const startTime = Date.now();
    await this.addLog(`Waiting for position to become: ${targetPosition}. Current: ${this.currentPosition}`);
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
          this.addLog('Real-time WS pong timeout. Closing connection.');
          this.realtimeWs.close(); // Close to trigger reconnect logic
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
      await this.addLog(`Real-time price WebSocket closed. Code: ${code}, Reason: ${reason}.`);
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
      this.addLog('Closing existing User Data Stream WebSocket.');
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
          this.addLog('User Data WS pong timeout. Closing connection.');
          this.userDataWs.close(); // Close to trigger reconnect logic
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
          await this.addLog(`Received ORDER_TRADE_UPDATE for order ${order.i}, status: ${order.X}, side: ${order.S}, quantity: ${order.q}, filled: ${order.z}`);
          
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

          // Resolve/Reject pending order promises based on order status
          if (this.pendingOrders.has(order.i)) { // order.i is the orderId
            const { resolve, reject } = this.pendingOrders.get(order.i);
            if (order.X === 'FILLED') { // Execution Type 'TRADE' and Order Status 'FILLED'
              resolve(order);
              this.pendingOrders.delete(order.i);
              // Re-detect position after order fill to update entry price and size
              await this.detectCurrentPosition(); 
              // NEW: Handle initial LIMIT order fill
              if (this.orderType === 'LIMIT') {
                if (order.i === this.longLimitOrderId) {
                  this.activeMode = 'SUPPORT_DRIVEN';
                  await this.addLog(`LONG LIMIT order ${order.i} filled. Entering SUPPORT_DRIVEN mode.`);
                  await this.cancelOrder(this.symbol, this.shortLimitOrderId); // Cancel other pending limit order
                  this.longLimitOrderId = null;
                  this.shortLimitOrderId = null;
                } else if (order.i === this.shortLimitOrderId) {
                  this.activeMode = 'RESISTANCE_DRIVEN';
                  await this.addLog(`SHORT LIMIT order ${order.i} filled. Entering RESISTANCE_DRIVEN mode.`);
                  await this.cancelOrder(this.symbol, this.longLimitOrderId); // Cancel other pending limit order
                  this.longLimitOrderId = null;
                  this.shortLimitOrderId = null;
                }
              }

            } else if (order.X === 'CANCELED' || order.X === 'REJECTED' || order.X === 'EXPIRED') {
              reject(new Error(`Order ${order.i} ${order.X}`));
              this.pendingOrders.delete(order.i);
              // NEW: Clear pending limit order IDs if cancelled/rejected
              if (order.i === this.longLimitOrderId) this.longLimitOrderId = null;
              if (order.i === this.shortLimitOrderId) this.shortLimitOrderId = null;
            }
          }
          // Always save state after processing an order update to ensure PnL and fees are persisted
          await this.saveState();
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
      await this.addLog(`User Data Stream WebSocket closed. Code: ${code}, Reason: ${reason}.`);
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
        await this.addLog(`Dynamic Sizing: Current Net Loss: ${currentNetLoss.toFixed(2)}.`);
        loggedEntry = true;

        const recoveryTargetForNextTrade = currentNetLoss * this.RECOVERY_FACTOR;
        // Assuming initialLevelPercentage is a reasonable proxy for average TP gain
        const additionalSizeNeeded = recoveryTargetForNextTrade / this.partialTpConfig[0].percentFromEntry;
        
        newPositionSizeUSDT = this.initialBasePositionSizeUSDT + additionalSizeNeeded;
        
        if (newPositionSizeUSDT > this.MAX_POSITION_SIZE_USDT) {
            newPositionSizeUSDT = this.MAX_POSITION_SIZE_USDT;
        }
    } else {
        if (this.positionSizeUSDT !== this.initialBasePositionSizeUSDT) {
            await this.addLog(`Dynamic Sizing: Current Net Loss: ${currentNetLoss.toFixed(2)}.`);
            loggedEntry = true;
            newPositionSizeUSDT = this.initialBasePositionSizeUSDT;
            await this.addLog(`Pos. size reset to ${this._formatNotional(newPositionSizeUSDT)} USDT.`);
        }
    }
    
    // Apply MIN_NOTIONAL filter
    const symbolInfo = await this._getExchangeInfo(this.symbol);
    if (symbolInfo && symbolInfo.minNotional !== undefined) {
        if (newPositionSizeUSDT < symbolInfo.minNotional) {
            await this.addLog(`Adjusting position size from ${this._formatNotional(newPositionSizeUSDT)} to meet MIN_NOTIONAL of ${this._formatNotional(symbolInfo.minNotional)} USDT.`);
            newPositionSizeUSDT = symbolInfo.minNotional;
        }
    }

    if (loggedEntry || this.positionSizeUSDT !== newPositionSizeUSDT) {
        await this.addLog(`Final positionSizeUSDT for next trade: ${this._formatNotional(newPositionSizeUSDT)} USDT.`);
    }
    return newPositionSizeUSDT;
  }

  async handleRealtimePrice(currentPrice) {
    // Update current price and PnL values
    this.currentPrice = currentPrice;

    if (this.currentPosition !== 'NONE' && this.positionEntryPrice !== null && this.positionSize !== null) {
      this.positionPnL = this.currentPosition === 'LONG' 
        ? (currentPrice - this.positionEntryPrice) * (this.positionSize / this.positionEntryPrice)
        : (this.positionEntryPrice - currentPrice) * (this.positionSize / this.positionEntryPrice);
    } else {
      this.positionPnL = 0;
    }
    
    this.totalPnL = this.positionPnL + this.accumulatedRealizedPnL - this.accumulatedTradingFees;

    // Only execute trading logic if strategy is running AND a position is already open
    if (!this.isRunning || this.currentPosition === 'NONE') {
      return;
    }

    // NEW: Partial Take Profit Logic
    if (this.currentPosition !== 'NONE' && this.positionEntryPrice !== null && this.entryPositionQuantity !== null) {
      for (const tp of this.partialTpConfig) {
        if (!this[tp.hitFlag]) { // If this TP level has not been hit yet
          let tpPrice;
          let triggerCondition;
          let orderSide;
          

          if (this.currentPosition === 'LONG') {
            tpPrice = this.roundPrice(this.positionEntryPrice * (1 + tp.percentFromEntry));
            triggerCondition = currentPrice >= tpPrice;
            orderSide = 'SELL';
          } else if (this.currentPosition === 'SHORT') {
            tpPrice = this.roundPrice(this.positionEntryPrice * (1 - tp.percentFromEntry));
            triggerCondition = currentPrice <= tpPrice;
            orderSide = 'BUY';
          } else {
            continue; // Skip if no valid position
          }
          
          if (triggerCondition) {
            let tpQuantity = this.roundQuantity(this.entryPositionQuantity * tp.tpPercentOfEntrySize);
            
            // Ensure TP quantity does not exceed remaining position quantity
            if (tpQuantity > this.currentPositionQuantity) {
              tpQuantity = this.currentPositionQuantity;
            }

            // Ensure TP quantity meets minimum notional value
            const symbolInfo = this.exchangeInfoCache[this.symbol];
            if (symbolInfo && symbolInfo.minNotional !== undefined) {
              const tpNotional = tpQuantity * currentPrice;
              if (tpNotional < symbolInfo.minNotional) {
                continue; // Skip this TP if it's too small
              }
            }

            if (tpQuantity > 0) {
              // Calculate PnL here, after tpQuantity is defined
              let pnl;
              if (this.currentPosition === 'LONG') {
                pnl = (currentPrice - this.positionEntryPrice) * tpQuantity;
              } else if (this.currentPosition === 'SHORT') {
                pnl = (this.positionEntryPrice - currentPrice) * tpQuantity;
              }

              try {
                this[tp.hitFlag] = true; // CRITICAL FIX: Mark as hit BEFORE placing order
                const closeOrder = await this.placePartialTpOrder(this.symbol, orderSide, tpQuantity);
                
                if (closeOrder && closeOrder.orderId) {
                  // Calculate PnL and fees for this partial TP
                  const fee = currentPrice * tpQuantity * this.feeRate;
                  this.accumulatedRealizedPnLForCurrentTrade += pnl; // Use calculated PnL
                  this.accumulatedTradingFeesForCurrentTrade += fee;
                  this.partialTpCount++; // Increment partial TP count
                  this.tradeSequence += 'P'; // NEW: Append 'P' for Partial TP
                  await this.addLog(`Partial TP ${tp.id} order sent. PNL: ${pnl.toFixed(2)}, Fees: ${fee.toFixed(8)}. Remaining Qty (before fill update): ${this._formatQuantity(this.currentPositionQuantity - tpQuantity)}.`);
                  // currentPositionQuantity will be updated by detectCurrentPosition after order fill
                } else {
                  console.error(`Failed to get orderId for Partial TP ${tp.id} close order.`);
                }
              } catch (error) {
                console.error(`Error executing Partial TP ${tp.id}: ${error.message}`);
              }
            }
          }
        }
      }
    }

    // NEW: Final TP Trigger Logic
    if (this.finalTpActive && this.currentPosition !== 'NONE' && !this.finalTpOrderSent) {
      let triggerFinalTp = false;
      if (this.currentPosition === 'LONG' && this.finalTpPrice !== null && currentPrice >= this.finalTpPrice) {
        triggerFinalTp = true;
      } else if (this.currentPosition === 'SHORT' && this.finalTpPrice !== null && currentPrice <= this.finalTpPrice) {
        triggerFinalTp = true;
      }

      if (triggerFinalTp) {
        this.finalTpOrderSent = true; // Set flag to prevent re-triggering
        this.tradeSequence += 'F'; // NEW: Append 'F' for Final TP
        await this.addLog(`Final TP hit! Closing remaining position and stopping strategy.`);
        try {
          await this.closeCurrentPosition();
          await this.addLog('Final TP: Waiting for position to be fully closed...');
          await this._waitForPositionChange('NONE'); // Wait for position to be NONE
          await this.addLog('Final TP: Position confirmed as NONE. Stopping strategy.');
          await this.stop(); // Stop the entire strategy
        } catch (error) {
          console.error(`Error closing position for Final TP: ${error.message}`);
          // If closing fails, reset flag to allow re-attempt or manual intervention
          this.finalTpOrderSent = false; 
        }
      }
    }

    // Reversal logic based on Current Price (only if a position is open and an active mode is set)
    if (this.reversalMethod === 'currentPrice' && this.currentPosition !== 'NONE' && this.activeMode !== 'NONE') {
          if (this.activeMode === 'RESISTANCE_DRIVEN') {
              if (this.currentPosition === 'LONG') {
                  // Reversal from LONG to SHORT: current price hits or below resistance reversal level
                  if (this.resistanceReversalLevel !== null && currentPrice <= this.resistanceReversalLevel) {
                      try {
                          await this.closeCurrentPosition(); 
                          await this.addLog('Reversal: Waiting for position to be fully closed...'); // New log
                          await this._waitForPositionChange('NONE'); // Wait for position to be NONE
                          await this.addLog('Reversal: Position confirmed as NONE. Proceeding with reversal.'); // New log
                          await new Promise(resolve => setTimeout(resolve, 500)); // Small delay to ensure state propagation
                      } catch (error) {
                          console.error(`Error closing LONG position before reversal: ${error.message}`);
                          return; 
                      }
                      
                      this.positionSizeUSDT = await this._calculateDynamicPositionSize(); // Apply dynamic sizing for new trade
                      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
                      if (quantity > 0) {
                          try {
                              await this.placeMarketOrder(this.symbol, 'SELL', quantity); 
                              this.currentPosition = 'SHORT';
                              this._pendingLogMessage = 'reversal'; // Set flag for consolidated log
                              this.reversalCount++; // Increment reversal count
                              this.tradeSequence += 'R'; // NEW: Append 'R' for Reversal
                              // NEW: Initialize partial TP states for new trade
                              this.entryPositionQuantity = quantity;
                              this.currentPositionQuantity = quantity;
                              this.partialTp1Hit = false;
                              this.accumulatedRealizedPnLForCurrentTrade = 0;
                              this.accumulatedTradingFeesForCurrentTrade = 0;

                              // Calculate new resistance level after reversal
                              this.resistanceLevel = this._calculateAdjustedPrice(this.resistanceReversalLevel, this.reversalLevelPercentage, true);
                              this.resistanceReversalLevel = null; // Set reversal level to null
                              await this.addLog(`Dynamic Adjustment: New Resistance Level: ${this._formatPrice(this.resistanceLevel)}. Resistance Reversal Level set to null.`);

                          } catch (error) {
                              console.error(`Error opening SHORT position after LONG reversal: ${error.message}`);
                          }
                      }
                  }
              } else if (this.currentPosition === 'SHORT') {
                  // Reversal from SHORT to LONG: current price hits or above resistance level
                  if (this.resistanceLevel !== null && currentPrice >= this.resistanceLevel) {
                      try {
                          await this.closeCurrentPosition(); 
                          await this.addLog('Reversal: Waiting for position to be fully closed...'); // New log
                          await this._waitForPositionChange('NONE'); // Wait for position to be NONE
                          await this.addLog('Reversal: Position confirmed as NONE. Proceeding with reversal.'); // New log
                          await new Promise(resolve => setTimeout(resolve, 500)); // Small delay to ensure state propagation
                      } catch (error) {
                          console.error(`Error closing SHORT position before re-entry: ${error.message}`);
                          return; 
                      }

                      this.positionSizeUSDT = await this._calculateDynamicPositionSize(); // Apply dynamic sizing for new trade
                      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
                      if (quantity > 0) {
                          try {
                              await this.placeMarketOrder(this.symbol, 'BUY', quantity); 
                              this.currentPosition = 'LONG';
                              this._pendingLogMessage = 'reversal'; // Set flag for consolidated log
                              this.reversalCount++; // Increment reversal count
                              this.tradeSequence += 'R'; // NEW: Append 'R' for Reversal
                              // NEW: Initialize partial TP states for new trade
                              this.entryPositionQuantity = quantity;
                              this.currentPositionQuantity = quantity;
                              this.partialTp1Hit = false;
                              this.accumulatedRealizedPnLForCurrentTrade = 0;
                              this.accumulatedTradingFeesForCurrentTrade = 0;

                              // Calculate new resistance reversal level after reversal
                              this.resistanceReversalLevel = this._calculateAdjustedPrice(this.resistanceLevel, this.reversalLevelPercentage * 1.0, false);
                              this.resistanceLevel = null; // Set resistance level to null
                              await this.addLog(`Dynamic Adjustment: New Resistance Reversal Level: ${this._formatPrice(this.resistanceReversalLevel)}. Resistance Level set to null.`);

                          } catch (error) {
                              console.error(`Error opening LONG position after SHORT re-entry: ${error.message}`);
                          }
                      }
                  }
              }
          } else if (this.activeMode === 'SUPPORT_DRIVEN') {
              if (this.currentPosition === 'SHORT') {
                  // Reversal from SHORT to LONG: current price hits or above support reversal level
                  if (this.supportReversalLevel !== null && currentPrice >= this.supportReversalLevel) {
                      try {
                          await this.closeCurrentPosition(); 
                          await this.addLog('Reversal: Waiting for position to be fully closed...'); // New log
                          await this._waitForPositionChange('NONE'); // Wait for position to be NONE
                          await this.addLog('Reversal: Position confirmed as NONE. Proceeding with reversal.'); // New log
                          await new Promise(resolve => setTimeout(resolve, 500)); // Small delay to ensure state propagation
                      } catch (error) {
                          console.error(`Error closing SHORT position before reversal: ${error.message}`);
                          return; 
                      }

                      this.positionSizeUSDT = await this._calculateDynamicPositionSize(); // Apply dynamic sizing for new trade
                      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
                      if (quantity > 0) {
                          try {
                              await this.placeMarketOrder(this.symbol, 'BUY', quantity); 
                              this.currentPosition = 'LONG';
                              this._pendingLogMessage = 'reversal'; // Set flag for consolidated log
                              this.reversalCount++; // Increment reversal count
                              this.tradeSequence += 'R'; // NEW: Append 'R' for Reversal
                              // NEW: Initialize partial TP states for new trade
                              this.entryPositionQuantity = quantity;
                              this.currentPositionQuantity = quantity;
                              this.partialTp1Hit = false;
                              this.accumulatedRealizedPnLForCurrentTrade = 0;
                              this.accumulatedTradingFeesForCurrentTrade = 0;

                              // Calculate new support level after reversal
                              this.supportLevel = this._calculateAdjustedPrice(this.supportReversalLevel, this.reversalLevelPercentage, false);
                              this.supportReversalLevel = null; // Set reversal level to null
                              await this.addLog(`Dynamic Adjustment: New Support Level: ${this._formatPrice(this.supportLevel)}. Support Reversal Level set to null.`);

                          } catch (error) {
                              console.error(`Error opening LONG position after SHORT reversal: ${error.message}`);
                          }
                      }
                  }
              } else if (this.currentPosition === 'LONG') {
                  // Reversal from LONG to SHORT: current price hits or below support level
                  if (this.supportLevel !== null && currentPrice <= this.supportLevel) {
                      try {
                          await this.closeCurrentPosition(); 
                          await this.addLog('Reversal: Waiting for position to be fully closed...'); // New log
                          await this._waitForPositionChange('NONE'); // Wait for position to be NONE
                          await this.addLog('Reversal: Position confirmed as NONE. Proceeding with reversal.'); // New log
                          await new Promise(resolve => setTimeout(resolve, 500)); // Small delay to ensure state propagation
                      } catch (error) {
                          console.error(`Error closing LONG position before re-entry: ${error.message}`);
                          return; 
                      }

                      this.positionSizeUSDT = await this._calculateDynamicPositionSize(); // Apply dynamic sizing for new trade
                      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
                      if (quantity > 0) {
                          try {
                              await this.placeMarketOrder(this.symbol, 'SELL', quantity); 
                              this.currentPosition = 'SHORT';
                              this._pendingLogMessage = 'reversal'; // Set flag for consolidated log
                              this.reversalCount++; // Increment reversal count
                              this.tradeSequence += 'R'; // NEW: Append 'R' for Reversal
                              // NEW: Initialize partial TP states for new trade
                              this.entryPositionQuantity = quantity;
                              this.currentPositionQuantity = quantity;
                              this.partialTp1Hit = false;
                              this.accumulatedRealizedPnLForCurrentTrade = 0;
                              this.accumulatedTradingFeesForCurrentTrade = 0;

                              // Calculate new support reversal level after reversal
                              this.supportReversalLevel = this._calculateAdjustedPrice(this.supportLevel, this.reversalLevelPercentage * 1.0, true);
                              this.supportLevel = null; // Set support level to null
                              await this.addLog(`Dynamic Adjustment: New Support Reversal Level: ${this._formatPrice(this.supportReversalLevel)}. Support Level set to null.`);

                          } catch (error) {
                              console.error(`Error opening SHORT position after LONG re-entry: ${error.message}`);
                          }
                      }
                  }
              }
          }
    }
  }

  async start(config = {}) {
    this.timeframe = config.timeframe || this.timeframe;
    this.symbol = config.symbol || 'BTCUSDT';

    // Strictly take positionSizeUSDT from config
    this.positionSizeUSDT = config.positionSizeUSDT;

    // Validate that positionSizeUSDT is provided and valid
    if (this.positionSizeUSDT === null || this.positionSizeUSDT === undefined || this.positionSizeUSDT <= 0) {
        throw new Error('Position size (positionSizeUSDT) must be provided from the UI and be a positive number.');
    }

    // Ensure initialBasePositionSizeUSDT always reflects the user's chosen base
    this.initialBasePositionSizeUSDT = this.positionSizeUSDT;
    this.MAX_POSITION_SIZE_USDT = (3 / 4) * this.initialBasePositionSizeUSDT * 50; // Set MAX_POSITION_SIZE_USDT dynamically here
    
    this.reversalMethod = 'currentPrice'; // Hardcoded to currentPrice
    this.reversalLevelPercentage = config.reversalLevelPercentage !== undefined ? config.reversalLevelPercentage : null; // Get from config
    
    // Manually set S/R levels from config
    this.supportLevel = config.supportLevel !== undefined ? config.supportLevel : null;
    this.resistanceLevel = config.resistanceLevel !== undefined ? config.resistanceLevel : null;
    // NEW: Set reversal levels to null at start
    this.supportReversalLevel = null;
    this.resistanceReversalLevel = null;

    this.enableSupport = config.enableSupport !== undefined ? config.enableSupport : false;
    this.enableResistance = config.enableResistance !== undefined ? config.enableResistance : false;

    // NEW: Order Type and Direction config
    this.orderType = config.orderType || 'MARKET';
    this.buyLongEnabled = config.buyLongEnabled || false;
    this.sellShortEnabled = config.sellShortEnabled || false;
    this.buyLimitPrice = config.buyLimitPrice || null;
    this.sellLimitPrice = config.sellLimitPrice || null;

    // Calculate partialTpConfig based on reversalLevelPercentage
    if (this.reversalLevelPercentage !== null) {
      const tp1PercentFromEntry = (this.reversalLevelPercentage / 100) * 1; //Jacky Liaw: Changed the multiplier from 0.5 to 1
      this.partialTpConfig = [
        { id: 1, percentFromEntry: tp1PercentFromEntry, tpPercentOfEntrySize: 0.3, hitFlag: 'partialTp1Hit' },
      ];
      await this.addLog(`TP1 set to ${tp1PercentFromEntry * 100}% of entry price.`);
    } else {
      this.partialTpConfig = []; // Clear if reversalLevelPercentage is not set
    }

    // NEW: Reset Partial TP states on start
    this.entryPositionQuantity = null;
    this.currentPositionQuantity = null;
    this.partialTp1Hit = false;
    this.accumulatedRealizedPnLForCurrentTrade = 0;
    this.accumulatedTradingFeesForCurrentTrade = 0;
    // NEW: Reset Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null; // NEW
    this.finalTpPercentage = null;     // NEW

    // Reset accumulated PnL and fees for the new strategy run
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;

    // Reset summary section data
    this.reversalCount = 0;
    this.partialTpCount = 0;
    this.tradeSequence = ''; // NEW
    this.profitPercentage = null;
    this.strategyStartTime = new Date(); // Set start time
    this.strategyEndTime = null; // Reset end time

    // Fetch initial wallet balance
    try {
      const futuresAccountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
      this.initialWalletBalance = parseFloat(futuresAccountInfo.totalWalletBalance);
      await this.addLog(`Initial wallet balance recorded: ${this.initialWalletBalance.toFixed(2)} USDT.`);
    } catch (error) {
      await this.addLog(`WARNING: Could not fetch initial wallet balance: ${error.message}`);
      this.initialWalletBalance = null; // Set to null if fetching fails
    }

    this.strategyId = `threshold_strategy_${Date.now()}`;

    // Set tradesCollectionRef for the new strategy
    this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
    this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs'); // NEW: Initialize logs collection ref

    // Create strategy document in Firestore immediately
    await this.firestore
      .collection('strategies')
      .doc(this.strategyId)
      .set({
        timeframe: this.timeframe,
        symbol: this.symbol,
        supportLevel: this.supportLevel,
        resistanceLevel: this.resistanceLevel,
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
        supportReversalLevel: this.supportReversalLevel, // Will be null
        resistanceReversalLevel: this.resistanceReversalLevel, // Will be null
        reversalMethod: this.reversalMethod,
        reversalLevelPercentage: this.reversalLevelPercentage, // Add to Firestore
        // NEW: Partial TP states
        entryPositionQuantity: this.entryPositionQuantity,
        currentPositionQuantity: this.currentPositionQuantity,
        partialTp1Hit: this.partialTp1Hit,
        accumulatedRealizedPnLForCurrentTrade: this.accumulatedRealizedPnLForCurrentTrade,
        accumulatedTradingFeesForCurrentTrade: this.accumulatedTradingFeesForCurrentTrade,
        // NEW: Final TP states
        breakevenPrice: this.breakevenPrice,
        finalTpPrice: this.finalTpPrice,
        finalTpActive: this.finalTpActive,
        finalTpOrderSent: this.finalTpOrderSent,
        breakevenPercentage: this.breakevenPercentage, // NEW
        finalTpPercentage: this.finalTpPercentage,     // NEW
        // NEW: Order Type and Direction states
        orderType: this.orderType,
        buyLongEnabled: this.buyLongEnabled,
        sellShortEnabled: this.sellShortEnabled,
        buyLimitPrice: this.buyLimitPrice,
        sellLimitPrice: this.sellLimitPrice,
        longLimitOrderId: this.longLimitOrderId,
        shortLimitOrderId: this.shortLimitOrderId,
        // NEW: Summary section data
        reversalCount: this.reversalCount,
        partialTpCount: this.partialTpCount,
        tradeSequence: this.tradeSequence, // NEW
        initialWalletBalance: this.initialWalletBalance,
        profitPercentage: this.profitPercentage,
        strategyStartTime: this.strategyStartTime,
        strategyEndTime: this.strategyEndTime,
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
        await this.addLog(`ListenKey obtained: ${this.listenKey}.`);
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

      // Initial order placement based on UI selection
      if (this.orderType === 'MARKET') {
        const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
        if (quantity > 0) {
          if (this.buyLongEnabled) {
            await this.placeMarketOrder(this.symbol, 'BUY', quantity);
            this.activeMode = 'SUPPORT_DRIVEN';
            this._pendingLogMessage = 'initial';
          } else if (this.sellShortEnabled) {
            await this.placeMarketOrder(this.symbol, 'SELL', quantity);
            this.activeMode = 'RESISTANCE_DRIVEN';
            this._pendingLogMessage = 'initial';
          }
        } else {
          throw new Error('Calculated quantity for initial MARKET order is zero or negative.');
        }
      } else if (this.orderType === 'LIMIT') {
        const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
        if (quantity > 0) {
          if (this.buyLongEnabled && this.buyLimitPrice !== null) {
            const orderResult = await this.placeLimitOrder(this.symbol, 'BUY', quantity, this.buyLimitPrice);
            this.longLimitOrderId = orderResult.orderId;
            //await this.addLog(`Initial LONG LIMIT order ${this.longLimitOrderId} placed at ${this.buyLimitPrice}.`);
          }
          if (this.sellShortEnabled && this.sellLimitPrice !== null) {
            const orderResult = await this.placeLimitOrder(this.symbol, 'SELL', quantity, this.sellLimitPrice);
            this.shortLimitOrderId = orderResult.orderId;
            //await this.addLog(`Initial SHORT LIMIT order ${this.shortLimitOrderId} placed at ${this.sellLimitPrice}.`);
          }
        } else {
          throw new Error('Calculated quantity for initial LIMIT order is zero or negative.');
        }
      }
      
    } catch (error) {
      console.error(`Failed to initialize strategy settings: ${error.message}`); 
      await this.addLog(`ERROR during strategy initialization: ${error.message}`);
      throw error;
    }

    await this.addLog(`Strategy started:`); 
    await this.addLog(`  Pair: ${this.symbol}`); 
    await this.addLog(`  Initial Base Pos. Size: ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT`); // Log initial base
    await this.addLog(`  Max Exposure: ${this._formatNotional(this.MAX_POSITION_SIZE_USDT)} USDT`); // Log max exposure
    await this.addLog(`  Leverage: 50x`); 
    await this.addLog(`  Pos. Mode: One-way`); 
    await this.addLog(`  Reversal Level: ${this.reversalLevelPercentage !== null ? `${this.reversalLevelPercentage}%` : 'N/A'}`); // Log the new value
    await this.addLog(`  Order Type: ${this.orderType}`);
    await this.addLog(`  Buy/Long Enabled: ${this.buyLongEnabled}`);
    if (this.buyLongEnabled && this.buyLimitPrice !== null) await this.addLog(`    Buy Limit Price: ${this.buyLimitPrice}`);
    await this.addLog(`  Sell/Short Enabled: ${this.sellShortEnabled}`);
    if (this.sellShortEnabled && this.sellLimitPrice !== null) await this.addLog(`    Sell Limit Price: ${this.sellLimitPrice}`);
    await this.addLog(`  Support: ${this.supportLevel !== null ? this._formatPrice(this.supportLevel) : 'N/A'}`);
    await this.addLog(`  Resistance: ${this.resistanceLevel !== null ? this._formatPrice(this.resistanceLevel) : 'N/A'}`);
    await this.addLog(`  Support Rev: ${this.supportReversalLevel !== null ? this._formatPrice(this.supportReversalLevel) : 'N/A'}`);
    await this.addLog(`  Resistance Rev: ${this.resistanceReversalLevel !== null ? this._formatPrice(this.resistanceReversalLevel) : 'N/A'}`);

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
    this.isRunning = false;
    this.strategyEndTime = new Date(); // Set end time

    // Cancel any pending limit orders first
    if (this.longLimitOrderId) {
      await this.cancelOrder(this.symbol, this.longLimitOrderId);
      this.longLimitOrderId = null;
    }
    if (this.shortLimitOrderId) {
      await this.cancelOrder(this.symbol, this.shortLimitOrderId);
      this.shortLimitOrderId = null;
    }

    // Close active position first, if any
    if (this.currentPosition !== 'NONE') {
      try {
        await this.closeCurrentPosition(); // This places the market order to close
        await this.addLog(`Position closed: ${this.currentPosition} for ${this.symbol}.`);
        // Wait for confirmation that position is NONE, then reset flag
        await this._waitForPositionChange('NONE'); // This waits for the position to be NONE
        await this.addLog('Position confirmed as NONE after stop request.');
      } catch (err) {
        console.error(`Failed to close position or confirm closure for ${this.symbol}: ${err.message}`);
        await this.addLog(`ERROR: Failed to close position or confirm closure: ${err.message}`);
        // Even if closing fails, we should still attempt to reset state and save
        // The frontend should then show the strategy as stopped, but with a warning about the position.
      } finally {
        // No _strategyInitiatedClose to reset here
      }
    }  

    // Fetch and record wallet balance and calculate profit percentage AFTER saving state
    try {
      const futuresAccountInfo = await this.makeProxyRequest('/fapi/v2/account', 'GET', {}, true, 'futures');
      const totalWalletBalance = parseFloat(futuresAccountInfo.totalWalletBalance);
      if (!isNaN(totalWalletBalance)) {
        await this.firestore.collection('wallet_history').add({
          strategyId: this.strategyId,
          timestamp: new Date(),
          balance: totalWalletBalance,
        });
        await this.addLog(`Wallet balance ${totalWalletBalance.toFixed(2)} recorded to Firestore.`);

        // Calculate profitPercentage
        if (this.initialWalletBalance !== null && !isNaN(totalWalletBalance) && this.initialBasePositionSizeUSDT !== null && this.initialBasePositionSizeUSDT > 0) {
          this.profitPercentage = ((totalWalletBalance - this.initialWalletBalance) / this.initialBasePositionSizeUSDT) * 100;
          await this.addLog(`Profit Percentage: ${this.profitPercentage.toFixed(2)}%.`);
        } else {
          this.profitPercentage = null;
          await this.addLog(`Could not calculate profit percentage. Initial balance: ${this.initialWalletBalance}, Final balance: ${totalWalletBalance}, Initial position size: ${this.initialBasePositionSizeUSDT}`);
        }

      }
    } catch (error) {
      console.error(`Failed to record wallet balance or calculate profit percentage: ${error.message}`);
      await this.addLog(`Failed to record wallet balance or calculate profit percentage: ${error.message}`);
      this.profitPercentage = null; // Ensure it's null on error
    }

    await this.saveState();

    // Now close WebSockets and invalidate ListenKey
    const closePromises = [];

    // Clear any pending reconnection timeouts
    if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);
    if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);

    // Clear heartbeat intervals and timeouts
    if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
    if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);
    if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
    if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);
    
    if (this.realtimeWs) {
      const realtimeClosePromise = new Promise(resolve => {
        this.realtimeWs.on('close', resolve);
        this.realtimeWs.close();
      });
      closePromises.push(realtimeClosePromise);
      this.realtimeWs = null;
      await this.addLog('Closed Real-time Price WebSocket...');
    }

    if (this.listenKeyRefreshInterval) {
      clearInterval(this.listenKeyRefreshInterval);
      this.listenKeyRefreshInterval = null;
    }
    if (this.userDataWs) {
      const userDataClosePromise = new Promise(resolve => {
        this.userDataWs.on('close', resolve);
        this.userDataWs.close();
      });
      closePromises.push(userDataClosePromise);
      this.userDataWs = null;
      await this.addLog('Closed User Data Stream WebSocket...');
    }
    if (this.listenKey) {
      try {
        await this.makeProxyRequest('/fapi/v1/listenKey', 'DELETE', { listenKey: this.listenKey }, true, 'futures');
        await this.addLog(`ListenKey invalidated.`);
      } catch (error) {
        console.error(`Failed to invalidate listenKey: ${error.message}`);
      }
      this.listenKey = null;
    }

    await Promise.all(closePromises);

    await this.addLog('Strategy stopped.');

    // Reset strategy state variables AFTER saving
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
    this.partialTp1Hit = false;
    this.accumulatedRealizedPnLForCurrentTrade = 0;
    this.accumulatedTradingFeesForCurrentTrade = 0;
    // Reset Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null; // NEW
    this.finalTpPercentage = null;     // NEW

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
    this.partialTpCount = 0;
    this.tradeSequence = ''; // NEW
    this.initialWalletBalance = null;
    this.profitPercentage = null;
    this.strategyStartTime = null;
    this.strategyEndTime = null;
  }

  async getStatus() {
    // In a real scenario, this would fetch live data from Binance
    // For simulation, we return current internal state
    return {
      timeframe: this.timeframe,
      symbol: this.symbol,
      positionSizeUSDT: this.positionSizeUSDT,
      reversalMethod: this.reversalMethod,
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
      partialTpCount: this.partialTpCount,
      breakevenPrice: this.breakevenPrice,
      finalTpPrice: this.finalTpPrice,
      initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT, // Include in status
      MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT, // Include in status
      profitPercentage: this.profitPercentage,
      strategyStartTime: this.strategyStartTime,
      strategyEndTime: this.strategyEndTime,
      tradeSequence: this.tradeSequence,
      breakevenPercentage: this.breakevenPercentage,
      finalTpPercentage: this.finalTpPercentage,
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,
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