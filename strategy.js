import { Firestore } from '@google-cloud/firestore';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { sendStrategyCompletionNotification, sendCapitalProtectionNotification, sendReversalNotification } from './pushNotificationHelper.js';
import { precisionFormatter } from './precisionUtils.js';

// Constants for WebSocket reconnection
const INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
const MAX_RECONNECT_DELAY_MS = 60000; // 60 seconds
const MAX_RECONNECT_ATTEMPTS = 25; // Max attempts before giving up or requiring manual intervention

// Heartbeat constants
const PING_INTERVAL_MS = 30000; // Send ping every 30 seconds
const PONG_TIMEOUT_MS = 10000; // Expect pong within 10 seconds

// Order confirmation constants
const ORDER_CONFIRMATION_TIMEOUT_MS = 15000; // 15 seconds timeout for WebSocket order confirmation
const ORDER_STATUS_POLL_INTERVAL_MS = 2000; // Poll every 2 seconds when using REST API fallback
const MAX_ORDER_STATUS_POLLS = 10; // Maximum number of polling attempts

// Desired profit percentage
const DESIRED_PROFIT_PERCENTAGE = 1.55; // Fixed profit target: 1.55%

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
    this.sessionStartTradeId = null; // First trade ID of current strategy session for verification

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

    // Partial TP states
    this.partialTpLevels = [0.5, 1.0, 2.0]; // Default: 0.5%, 1%, 2.0% from entry
    this.partialTpSizes = [0, 0, 0]; // Default: Disabled, Disabled, Disabled (0 means disabled)
    this.partialTpPrices = [null, null, null]; // Calculated TP price for each level
    this.partialTpExecuted = [false, false, false]; // Track which levels have been executed
    this.currentEntryReference = null; // Reference price for partial TP calculations

    // Custom Final TP Levels - Position Specific
    this.customFinalTpLong = null; // If set, overrides DESIRED_PROFIT_PERCENTAGE for LONG positions
    this.customFinalTpShort = null; // If set, overrides DESIRED_PROFIT_PERCENTAGE for SHORT positions
    this.tpAtBreakeven = false; // If true, sets Final TP to breakeven level, overriding all other calculations

    // Desired Profit Target in USDT
    this.desiredProfitUSDT = null; // If set, strategy stops when total PnL reaches this amount

    // Reversal level percentage
    this.reversalLevelPercentage = null; // Initialize to null, will be set from config

    // Move Reversal Level feature
    this.moveReversalLevel = 'DO_NOT_MOVE'; // 'DO_NOT_MOVE' | 'MOVE_TO_BREAKEVEN'
    this.reversalLevelMoved = false; // Tracks if reversal level has been moved for current position
    this.originalReversalLevel = null; // Stores the original reversal level before moving

    // New Order Type and Direction states
    this.orderType = 'MARKET'; // 'LIMIT' | 'MARKET'
    this.buyLongEnabled = false;
    this.sellShortEnabled = false;
    this.buyLimitPrice = null;
    this.sellLimitPrice = null;

    // WebSocket connection statuses (to be reported to frontend)
    this.realtimeWsConnected = false;
    this.userDataWsConnected = false;

    // WebSocket reconnection state
    this.realtimeReconnectAttempts = 0;
    this.userDataReconnectAttempts = 0;
    this.listenKeyRetryAttempts = 0; // NEW: Track listenKey API request retry attempts
    this.realtimeReconnectTimeout = null;
    this.userDataReconnectTimeout = null;
    this.isUserDataReconnecting = false; // Flag to prevent race condition during intentional reconnections

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
    this.restartPositionSizeUSDT = null; // One-time restart capital - used only for the first trade after restart
    this.RECOVERY_FACTOR = 0.15; // Percentage of accumulated loss to target for recovery in next trade's TP (default: 15%)
    this.MAX_POSITION_SIZE_USDT = 0; // Will be set dynamically in start()
    this.RECOVERY_DISTANCE = 0.005; //0.5%

    // Binance exchange info cache for precision and step size
    this.exchangeInfoCache = {}; // Stores tickSize, stepSize, minQty, maxQty, minNotional for each symbol

    // ===== Volatility Filter State =====
    this.volatilityEnabled = true; // Option to enable/disable volatility filter
    this.volatilityMeasurementActive = false; // Only measure when price hits limit order price
    this.microbarOpen = null;
    this.microbarHigh = null;
    this.microbarLow = null;
    this.microbarClose = null;
    this.microbarTickCount = 0;

    this.MICROBAR_TICK_LIMIT = 15; // number of ticks per synthetic microbar
    this.volatilityLookback = 20; // number of microbars to average
    this.volatilityMultiplier = 1.5; // 50% expansion threshold

    this.microbarHistory = []; // rolling history of microbar body percentages
    this.volatilityExpanded = false; // default false - must measure actual volatility expansion before trading

    // ===== Virtual Position Tracking State =====
    this.virtualPositionActive = false; // True when waiting for volatility expansion
    this.virtualPositionDirection = null; // 'LONG' | 'SHORT' | null
    this.virtualOriginalDirection = null; // Track original direction for flip logic
    this.volatilityWaitStartTime = null; // Timestamp when virtual tracking started
    this.lastVirtualDirectionChange = null; // Timestamp of last direction change
    this.virtualDirectionChanges = []; // Array of {timestamp, price, from, to}
    this.virtualLongLimitOrder = null; // {price, side, quantity, timestamp} - for BUY LIMIT orders
    this.virtualShortLimitOrder = null; // {price, side, quantity, timestamp} - for SELL LIMIT orders
    this.virtualDirectionBuffer = null; // For debounce: {direction, count}
    this.lastVirtualStatusLogTime = null; // For periodic status logging every 30s
    this.virtualEntryLevel = null; // Entry level reference during virtual tracking
    this.virtualReversalLevel = null; // Reversal level reference during virtual tracking
    this.closedPositionType = null; // Track what position was just closed (for direction logic)
    this.virtualLimitFirstTriggered = false; // Track if virtual limit was triggered at least once
    this.isInitializingVirtualLimits = false; // Flag to prevent premature logging during dual-limit setup

    // Testnet status
    this.isTestnet = null;

    // Map to store pending order promises, resolving when order is filled/rejected
    this.pendingOrders = new Map();
    // NEW: Set to track saved trade order IDs to prevent duplicates
    this.savedTradeOrderIds = new Set();

    // Flag for pending log message after position update
    this._pendingLogMessage = null;

    // Summary section data
    this.reversalCount = 0;
    this.partialTpCount = 0; // Track total number of partial TPs executed
    this.tradeSequence = '';
    this.initialWalletBalance = null;
    this.tradingMode = 'NORMAL'; // Trading mode: AGGRESSIVE, NORMAL, or CONSERVATIVE
    this.lastDynamicSizingReversalCount = -1; // Track which reversal number last applied dynamic sizing (-1 = conceptual start before first reversal)
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

    // WebSocket position update tracking (for ACCOUNT_UPDATE events)
    this.lastPositionUpdateFromWebSocket = null; // Timestamp of last WebSocket position update
    this.positionUpdatedViaWebSocket = false; // Flag indicating if position was updated via WebSocket

    // WebSocket health monitoring
    this.wsHealthCheckInterval = null; // Interval for periodic WebSocket status checks

    // Bind methods to ensure 'this' context is correct
    this.connectRealtimeWebSocket = this.connectRealtimeWebSocket.bind(this);
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
      await this.addLog(`CAPITAL PROTECTION WARNING: Loss at ${precisionFormatter.formatPercentage(lossPercentage)}%. Approaching 30% threshold.`);
      await this.saveState();
    }

    if (lossPercentage >= MAX_LOSS_PERCENTAGE) {
      this.capitalProtectionTriggered = true;
      this.circuitBreakerTimestamp = new Date();
      const currentLoss = this.calculateCurrentLoss();

      await this.addLog(`CAPITAL PROTECTION CIRCUIT BREAKER TRIGGERED!`);
      await this.addLog(`Loss: ${precisionFormatter.formatNotional(currentLoss)} USDT (${precisionFormatter.formatPercentage(lossPercentage)}% of initial capital)`);
      await this.addLog(`Realized PnL: ${precisionFormatter.formatNotional(this.accumulatedRealizedPnL)} USDT`);
      await this.addLog(`Trading Fees: ${precisionFormatter.formatNotional(this.accumulatedTradingFees)} USDT`);
      await this.addLog(`Trading stopped automatically to protect remaining capital.`);

      await this.saveState();

      if (this.currentPosition !== 'NONE') {
        await this.addLog('Closing open position due to circuit breaker...');
        try {
          await this.closeCurrentPosition();
          await this._waitForPositionChange('NONE');
          await this.addLog('Position closed successfully.');
        } catch (error) {
          await this.addLog(`ERROR: [TRADING_ERROR] Failed to close position: ${error.message}`);
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
      const rawData = {
        userId: this.userId,
        profileId: this.profileId,
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
        sessionStartTradeId: this.sessionStartTradeId,
        lastUpdated: new Date(),
        isRunning: this.isRunning,
        symbol: this.symbol,
        positionSizeUSDT: this.positionSizeUSDT,
        initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
        MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT,
        reversalLevelPercentage: this.reversalLevelPercentage,
        RECOVERY_FACTOR: this.RECOVERY_FACTOR,
        RECOVERY_DISTANCE: this.RECOVERY_DISTANCE,
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
        // Partial TP states
        partialTpLevels: this.partialTpLevels,
        partialTpSizes: this.partialTpSizes,
        partialTpPrices: this.partialTpPrices,
        partialTpExecuted: this.partialTpExecuted,
        currentEntryReference: this.currentEntryReference,
        // Custom Final TP Levels - Position Specific
        customFinalTpLong: this.customFinalTpLong,
        customFinalTpShort: this.customFinalTpShort,
        tpAtBreakeven: this.tpAtBreakeven,
        desiredProfitUSDT: this.desiredProfitUSDT,
        // Order Type and Direction states
        orderType: this.orderType,
        buyLongEnabled: this.buyLongEnabled,
        sellShortEnabled: this.sellShortEnabled,
        buyLimitPrice: this.buyLimitPrice,
        sellLimitPrice: this.sellLimitPrice,
        // Summary section data
        reversalCount: this.reversalCount,
        partialTpCount: this.partialTpCount,
        tradeSequence: this.tradeSequence,
        initialWalletBalance: this.initialWalletBalance,
        profitPercentage: this.profitPercentage,
        tradingMode: this.tradingMode,
        lastDynamicSizingReversalCount: this.lastDynamicSizingReversalCount,
        strategyStartTime: this.strategyStartTime,
        strategyEndTime: this.strategyEndTime,
        // Capital Protection fields
        capitalProtectionTriggered: this.capitalProtectionTriggered,
        capitalProtectionWarning: this.capitalProtectionWarning,
        maxAllowableLoss: this.maxAllowableLoss,
        circuitBreakerTimestamp: this.circuitBreakerTimestamp,
        // Move Reversal Level feature
        moveReversalLevel: this.moveReversalLevel,
        reversalLevelMoved: this.reversalLevelMoved,
        originalReversalLevel: this.originalReversalLevel,
        // Volatility Filter State
        volatilityEnabled: this.volatilityEnabled,
        volatilityMeasurementActive: this.volatilityMeasurementActive,
        microbarOpen: this.microbarOpen,
        microbarHigh: this.microbarHigh,
        microbarLow: this.microbarLow,
        microbarClose: this.microbarClose,
        microbarTickCount: this.microbarTickCount,
        MICROBAR_TICK_LIMIT: this.MICROBAR_TICK_LIMIT,
        volatilityLookback: this.volatilityLookback,
        volatilityMultiplier: this.volatilityMultiplier,
        microbarHistory: this.microbarHistory,
        volatilityExpanded: this.volatilityExpanded,
        // Virtual Position Tracking State
        virtualPositionActive: this.virtualPositionActive,
        virtualPositionDirection: this.virtualPositionDirection,
        virtualOriginalDirection: this.virtualOriginalDirection,
        volatilityWaitStartTime: this.volatilityWaitStartTime,
        lastVirtualDirectionChange: this.lastVirtualDirectionChange,
        virtualDirectionChanges: this.virtualDirectionChanges,
        virtualLongLimitOrder: this.virtualLongLimitOrder,
        virtualShortLimitOrder: this.virtualShortLimitOrder,
        virtualDirectionBuffer: this.virtualDirectionBuffer,
        lastVirtualStatusLogTime: this.lastVirtualStatusLogTime,
        virtualEntryLevel: this.virtualEntryLevel,
        virtualReversalLevel: this.virtualReversalLevel,
        closedPositionType: this.closedPositionType,
        virtualLimitFirstTriggered: this.virtualLimitFirstTriggered,
      };

      // Filter out undefined values and validate numeric fields to prevent Firestore errors
      const dataToSave = {};
      const numericFields = [
        'entryLevel', 'reversalLevel', 'positionEntryPrice', 'positionSize',
        'currentPrice', 'positionPnL', 'totalPnL', 'accumulatedRealizedPnL',
        'accumulatedTradingFees', 'positionSizeUSDT', 'initialBasePositionSizeUSDT',
        'MAX_POSITION_SIZE_USDT', 'reversalLevelPercentage', 'entryPositionQuantity',
        'currentPositionQuantity', 'lastPositionQuantity', 'lastPositionEntryPrice',
        'breakevenPrice', 'finalTpPrice', 'breakevenPercentage', 'finalTpPercentage',
        'buyLimitPrice', 'sellLimitPrice', 'initialWalletBalance', 'profitPercentage',
        'maxAllowableLoss', 'customFinalTpLong', 'customFinalTpShort', 'desiredProfitUSDT',
        'originalReversalLevel', 'microbarOpen', 'microbarHigh', 'microbarLow', 'microbarClose',
        'microbarTickCount', 'MICROBAR_TICK_LIMIT', 'volatilityLookback', 'volatilityMultiplier',
        'volatilityWaitStartTime', 'lastVirtualDirectionChange', 'lastVirtualStatusLogTime',
        'virtualEntryLevel', 'virtualReversalLevel'
      ];

      for (const key in rawData) {
        if (rawData[key] !== undefined) {
          const value = rawData[key];

          // Validate numeric fields - prevent NaN and invalid numbers
          if (numericFields.includes(key)) {
            if (value === null) {
              dataToSave[key] = null; // Explicitly allow null for optional numeric fields
            } else if (typeof value === 'number') {
              if (Number.isNaN(value)) {
                // Critical accumulated fields must default to 0, others to null
                if (key === 'accumulatedRealizedPnL' || key === 'accumulatedTradingFees') {
                  dataToSave[key] = 0;
                  await this.addLog(`WARNING: NaN detected for ${key}, defaulting to 0`);
                  console.warn(`[${this.strategyId}] NaN detected for ${key}, defaulting to 0`);
                } else {
                  dataToSave[key] = null;
                  await this.addLog(`WARNING: NaN detected for ${key}, setting to null`);
                }
              } else if (!Number.isFinite(value)) {
                // Handle Infinity/-Infinity
                dataToSave[key] = null;
                await this.addLog(`WARNING: Invalid number (Infinity) detected for ${key}, setting to null`);
              } else {
                dataToSave[key] = value; // Valid number
              }
            } else {
              // Non-numeric value in numeric field
              dataToSave[key] = null;
            }
          } else {
            // Non-numeric field, save as-is
            dataToSave[key] = value;
          }
        }
      }

      await this.firestore
        .collection('strategies')
        .doc(this.strategyId)
        .update(dataToSave);
    } catch (error) {
      console.error('Failed to save state to Firestore:', error);
      await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to save state to Firestore: ${error.message}`);
    }
  }

  // Helper method to safely load and validate numeric values from Firestore
  _validateNumericValue(value, fieldName, defaultValue = null) {
    if (value === null || value === undefined) {
      return defaultValue;
    }
    if (typeof value === 'number') {
      if (Number.isNaN(value)) {
        console.warn(`[${this.strategyId}] NaN detected for ${fieldName} during load, using default: ${defaultValue}`);
        return defaultValue;
      }
      if (!Number.isFinite(value)) {
        console.warn(`[${this.strategyId}] Invalid number (Infinity) detected for ${fieldName} during load, using default: ${defaultValue}`);
        return defaultValue;
      }
      return value;
    }
    // Non-numeric value in numeric field
    console.warn(`[${this.strategyId}] Non-numeric value detected for ${fieldName} during load, using default: ${defaultValue}`);
    return defaultValue;
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
        this.entryLevel = this._validateNumericValue(data.entryLevel, 'entryLevel', null);
        this.reversalLevel = this._validateNumericValue(data.reversalLevel, 'reversalLevel', null);
        this.enableSupport = data.enableSupport || false;
        this.enableResistance = data.enableResistance || false;
        this.currentPosition = data.currentPosition || 'NONE';
        this.positionEntryPrice = this._validateNumericValue(data.positionEntryPrice, 'positionEntryPrice', null);
        this.positionSize = this._validateNumericValue(data.positionSize, 'positionSize', null);
        this.activeMode = data.activeMode || 'NONE';
        this.currentPrice = this._validateNumericValue(data.currentPrice, 'currentPrice', null);
        this.positionPnL = this._validateNumericValue(data.positionPnL, 'positionPnL', null);
        this.totalPnL = this._validateNumericValue(data.totalPnL, 'totalPnL', null);
        this.accumulatedRealizedPnL = this._validateNumericValue(data.accumulatedRealizedPnL, 'accumulatedRealizedPnL', 0);
        this.accumulatedTradingFees = this._validateNumericValue(data.accumulatedTradingFees, 'accumulatedTradingFees', 0);
        this.sessionStartTradeId = this._validateNumericValue(data.sessionStartTradeId, 'sessionStartTradeId', null);
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

        this.reversalLevelPercentage = this._validateNumericValue(data.reversalLevelPercentage, 'reversalLevelPercentage', null);

        // Load Position quantity tracking
        this.entryPositionQuantity = this._validateNumericValue(data.entryPositionQuantity, 'entryPositionQuantity', null);
        this.currentPositionQuantity = this._validateNumericValue(data.currentPositionQuantity, 'currentPositionQuantity', null);
        this.feeRate = 0.0005; // Ensure fee rate is set on load

        // Load Persistent position tracking for historical analysis
        this.lastPositionQuantity = this._validateNumericValue(data.lastPositionQuantity, 'lastPositionQuantity', null);
        this.lastPositionEntryPrice = this._validateNumericValue(data.lastPositionEntryPrice, 'lastPositionEntryPrice', null);

        // Load Final TP states
        this.breakevenPrice = this._validateNumericValue(data.breakevenPrice, 'breakevenPrice', null);
        this.finalTpPrice = this._validateNumericValue(data.finalTpPrice, 'finalTpPrice', null);
        this.finalTpActive = data.finalTpActive || false;
        this.finalTpOrderSent = data.finalTpOrderSent || false;
        this.breakevenPercentage = this._validateNumericValue(data.breakevenPercentage, 'breakevenPercentage', null);
        this.finalTpPercentage = this._validateNumericValue(data.finalTpPercentage, 'finalTpPercentage', null);

        // Load Partial TP states
        this.partialTpLevels = data.partialTpLevels || [0.5, 1.0, 2.0];
        this.partialTpSizes = data.partialTpSizes || [0, 0, 0];
        this.partialTpPrices = data.partialTpPrices || [null, null, null];
        this.partialTpExecuted = data.partialTpExecuted || [false, false, false];
        this.currentEntryReference = data.currentEntryReference || null;

        // Load Custom Final TP Levels - Position Specific
        this.customFinalTpLong = this._validateNumericValue(data.customFinalTpLong, 'customFinalTpLong', null);
        this.customFinalTpShort = this._validateNumericValue(data.customFinalTpShort, 'customFinalTpShort', null);
        this.tpAtBreakeven = data.tpAtBreakeven || false;
        this.desiredProfitUSDT = this._validateNumericValue(data.desiredProfitUSDT, 'desiredProfitUSDT', null);

        // Load Order Type and Direction states
        this.orderType = data.orderType || 'MARKET';
        this.buyLongEnabled = data.buyLongEnabled || false;
        this.sellShortEnabled = data.sellShortEnabled || false;
        this.buyLimitPrice = this._validateNumericValue(data.buyLimitPrice, 'buyLimitPrice', null);
        this.sellLimitPrice = this._validateNumericValue(data.sellLimitPrice, 'sellLimitPrice', null);

        // Load Summary section data
        this.reversalCount = data.reversalCount || 0;
        this.partialTpCount = data.partialTpCount || 0;
        this.tradeSequence = data.tradeSequence || '';
        this.initialWalletBalance = this._validateNumericValue(data.initialWalletBalance, 'initialWalletBalance', null);
        this.profitPercentage = this._validateNumericValue(data.profitPercentage, 'profitPercentage', null);
        this.tradingMode = data.tradingMode || 'NORMAL';
        this.lastDynamicSizingReversalCount = data.lastDynamicSizingReversalCount ?? -1;
        this.strategyStartTime = data.strategyStartTime ? data.strategyStartTime.toDate() : null;
        this.strategyEndTime = data.strategyEndTime ? data.strategyEndTime.toDate() : null;

        // Load Capital Protection fields
        this.capitalProtectionTriggered = data.capitalProtectionTriggered || false;
        this.capitalProtectionWarning = data.capitalProtectionWarning || false;
        this.maxAllowableLoss = this._validateNumericValue(data.maxAllowableLoss, 'maxAllowableLoss', null);
        this.circuitBreakerTimestamp = data.circuitBreakerTimestamp ? data.circuitBreakerTimestamp.toDate() : null;

        // Load Move Reversal Level feature
        this.moveReversalLevel = data.moveReversalLevel || 'DO_NOT_MOVE';
        this.reversalLevelMoved = data.reversalLevelMoved || false;
        this.originalReversalLevel = this._validateNumericValue(data.originalReversalLevel, 'originalReversalLevel', null);

        // Load Volatility Filter State
        this.volatilityEnabled = data.volatilityEnabled !== undefined ? data.volatilityEnabled : true;
        this.volatilityMeasurementActive = data.volatilityMeasurementActive || false;
        this.microbarOpen = this._validateNumericValue(data.microbarOpen, 'microbarOpen', null);
        this.microbarHigh = this._validateNumericValue(data.microbarHigh, 'microbarHigh', null);
        this.microbarLow = this._validateNumericValue(data.microbarLow, 'microbarLow', null);
        this.microbarClose = this._validateNumericValue(data.microbarClose, 'microbarClose', null);
        this.microbarTickCount = this._validateNumericValue(data.microbarTickCount, 'microbarTickCount', 0);
        this.MICROBAR_TICK_LIMIT = this._validateNumericValue(data.MICROBAR_TICK_LIMIT, 'MICROBAR_TICK_LIMIT', 80);
        this.volatilityLookback = this._validateNumericValue(data.volatilityLookback, 'volatilityLookback', 20);
        this.volatilityMultiplier = this._validateNumericValue(data.volatilityMultiplier, 'volatilityMultiplier', 1.4);
        this.microbarHistory = Array.isArray(data.microbarHistory) ? data.microbarHistory : [];
        this.volatilityExpanded = data.volatilityExpanded !== undefined ? data.volatilityExpanded : false;

        // Load Virtual Position Tracking State
        this.virtualPositionActive = data.virtualPositionActive || false;
        this.virtualPositionDirection = data.virtualPositionDirection || null;
        this.virtualOriginalDirection = data.virtualOriginalDirection || null;
        this.volatilityWaitStartTime = this._validateNumericValue(data.volatilityWaitStartTime, 'volatilityWaitStartTime', null);
        this.lastVirtualDirectionChange = this._validateNumericValue(data.lastVirtualDirectionChange, 'lastVirtualDirectionChange', null);
        this.virtualDirectionChanges = Array.isArray(data.virtualDirectionChanges) ? data.virtualDirectionChanges : [];
        // Backward compatibility: load from both old (virtualLimitOrder) and new (virtualLongLimitOrder) property names
        this.virtualLongLimitOrder = data.virtualLongLimitOrder || data.virtualLimitOrder || null;
        this.virtualShortLimitOrder = data.virtualShortLimitOrder || null;
        this.virtualDirectionBuffer = data.virtualDirectionBuffer || null;
        this.lastVirtualStatusLogTime = this._validateNumericValue(data.lastVirtualStatusLogTime, 'lastVirtualStatusLogTime', null);
        this.virtualEntryLevel = this._validateNumericValue(data.virtualEntryLevel, 'virtualEntryLevel', null);
        this.virtualReversalLevel = this._validateNumericValue(data.virtualReversalLevel, 'virtualReversalLevel', null);
        this.closedPositionType = data.closedPositionType || null;
        this.virtualLimitFirstTriggered = data.virtualLimitFirstTriggered || false;

        // Log if resuming virtual tracking
        if (this.virtualPositionActive) {
          await this.addLog(`Resuming virtual position tracking from previous session - Direction: ${this.virtualPositionDirection}`);
        }

        await this._getExchangeInfo(this.symbol); // Use the new method to fetch and cache exchange info

        this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
        this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs');

        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to load state from Firestore:', error);
      await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to load state from Firestore: ${error.message}`);
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
        
        // Log the detailed error to the frontend with standardized ERROR prefix
        await this.addLog(`ERROR: [API_ERROR] ${errorDetails}`);
        
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
    return precisionFormatter.formatPrice(price, this.symbol);
  }

  // Format quantity to the correct step size precision
  _formatQuantity(quantity) {
    return precisionFormatter.formatQuantity(quantity, this.symbol);
  }

  // Format notional value (USDT) to a reasonable precision
  _formatNotional(notional) {
    return precisionFormatter.formatNotional(notional);
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

        const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : 0.01;
        const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.000001;

        this.exchangeInfoCache[symbol] = {
          tickSize: tickSize,
          stepSize: stepSize,
          minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0,
          maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : Infinity,
          minNotional: minNotional,
          precision: lotSizeFilter ? this._getPrecision(parseFloat(lotSizeFilter.stepSize)) : 6, // Store precision for quantity
        };

        // Cache precision in the centralized precision formatter
        precisionFormatter.cachePrecision(symbol, tickSize, stepSize, minNotional);

        await this.addLog(
          `Exchange info cached for ${symbol}: ` +
          `minNotional=${this._formatNotional(this.exchangeInfoCache[symbol].minNotional)} USDT, ` +
          `stepSize=${this.exchangeInfoCache[symbol].stepSize}, ` +
          `minQty=${this.exchangeInfoCache[symbol].minQty}, ` +
          `tickSize=${this.exchangeInfoCache[symbol].tickSize}, ` +
          `precision=${this.exchangeInfoCache[symbol].precision}`
        );
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
      this.addLog(`ERROR: [API_ERROR] Error fetching current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  // Round price to the correct tick size
  roundPrice(price) {
    return precisionFormatter.roundPrice(price, this.symbol);
  }

  // Round quantity to the correct step size
  roundQuantity(quantity) {
    return precisionFormatter.roundQuantity(quantity, this.symbol);
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

  // Get all open orders for a specific symbol
  async getAllOpenOrders(symbol) {
    try {
      const openOrders = await this.makeProxyRequest('/fapi/v1/openOrders', 'GET', { symbol }, true, 'futures');
      return openOrders || [];
    } catch (error) {
      console.error(`Failed to get open orders for ${symbol}: ${error.message}`);
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
      await this.addLog(`ERROR: [VALIDATION_ERROR] Pre-start check failed: ${error.message}`);
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
      this.addLog(`ERROR: [REST-API] [API_ERROR] Error querying order ${orderId}: ${error.message}`);
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
        await this.addLog(`[REST-API] Placed LIMIT ${side} order ${result.orderId} for ${roundedQuantity} at ${roundedPrice}.`);
        return result; // Return the initial order response immediately
      } else {
        throw new Error('Limit order placement failed: No orderId in response.');
      }
    } catch (error) {
      await this.addLog(`ERROR: [REST-API] [TRADING_ERROR] Failed to place limit order: ${error.message}`);
      throw error;
    }
  }

  // Cancel an order
  async cancelOrder(symbol, orderId) {
    if (!orderId) return;
    try {
      await this.makeProxyRequest('/fapi/v1/order', 'DELETE', { symbol, orderId }, true, 'futures');
      await this.addLog(`[REST-API] Cancelled order ${orderId}.`);
    } catch (error) {
      // Ignore if order is already filled or cancelled (-2011: Unknown order)
      if (error.binanceErrorCode === -2011) {
        await this.addLog(`[REST-API] Order ${orderId} already filled or cancelled.`);
      } else {
        await this.addLog(`ERROR: [REST-API] [TRADING_ERROR] Failed to cancel order ${orderId}: ${error.message}`);
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
        await this.addLog(`ERROR: [TRADING_ERROR] Failed to close position: ${error.message}`);
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
        // Reset Partial TP states
        await this._resetPartialTpState();
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
  connectRealtimeWebSocket() {
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
      await this.addLog('[WebSocket] Real-time price WS connected.');
      this.realtimeWsConnected = true;
      this.realtimeReconnectAttempts = 0; // Reset attempts on successful connection
      if (this.realtimeReconnectTimeout) clearTimeout(this.realtimeReconnectTimeout);

      // Start heartbeat for Real-time WS
      this.realtimeWsPingInterval = setInterval(() => {
        this.realtimeWs.ping();
        this.realtimeWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] Real-time WS pong timeout. Terminating connection.');
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
      await this.addLog(`[WebSocket] Real-time price WebSocket closed.`);
      // Clear heartbeat on close
      if (this.realtimeWsPingInterval) clearInterval(this.realtimeWsPingInterval);
      if (this.realtimeWsPingTimeout) clearTimeout(this.realtimeWsPingTimeout);

      // Attempt to reconnect if strategy is still running and max attempts not reached
      if (this.isRunning) {
        this.realtimeReconnectAttempts++;
        if (this.realtimeReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.realtimeReconnectAttempts - 1));
          await this.addLog(`[WebSocket] Real-time price WS disconnected. Scheduling reconnect in ${delay / 1000}s (Attempt ${this.realtimeReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          this.realtimeReconnectTimeout = setTimeout(async () => {
            await this.addLog(`[WebSocket] Starting Real-time price WS reconnection attempt ${this.realtimeReconnectAttempts}...`);
            this.connectRealtimeWebSocket();
          }, delay);
        } else {
          await this.addLog(`ERROR: [CONNECTION_ERROR] Max Real-time price WS reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Real-time price updates unavailable.`);
        }
      }
    });
  }

  // Helper method to handle User Data WebSocket reconnection logic
  async attemptUserDataReconnection() {
    if (!this.isRunning) {
      await this.addLog('[WebSocket] Strategy not running, skipping reconnection attempt.');
      return;
    }

    if (this.userDataReconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      await this.addLog(`ERROR: [CONNECTION_ERROR] Max User Data WS reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
      return;
    }

    try {
      await this.addLog(`[WebSocket] Starting User Data WS reconnection attempt ${this.userDataReconnectAttempts}...`);

      // Clear old listenKey and refresh interval before obtaining new one
      if (this.listenKeyRefreshInterval) {
        clearInterval(this.listenKeyRefreshInterval);
        this.listenKeyRefreshInterval = null;
      }

      // Obtain new listenKey
      const listenKeyResponse = await this._retryListenKeyRequest(false);

      if (!this.listenKey) {
        throw new Error('Failed to obtain listenKey - listenKey is null after request');
      }

      await this.addLog(`[WebSocket] ListenKey obtained successfully. Establishing User Data WebSocket connection...`);

      // Connect with new listenKey
      this.connectUserDataStream();

      // Re-establish listenKey refresh interval
      this.listenKeyRefreshInterval = setInterval(async () => {
        try {
          await this._retryListenKeyRequest(true);
        }
        catch (error) {
          console.error(`Failed to refresh listenKey: ${error.message}. Attempting to re-establish stream.`);
          await this.addLog(`ERROR: [CONNECTION_ERROR] ListenKey refresh failed: ${error.message}`);
          // Clear interval and trigger reconnection
          if (this.listenKeyRefreshInterval) {
            clearInterval(this.listenKeyRefreshInterval);
            this.listenKeyRefreshInterval = null;
          }
          // Close existing connection to trigger reconnection with new listenKey
          if (this.userDataWs && this.userDataWs.readyState === 1) { // 1 = OPEN
            this.userDataWs.close(1000, 'Reconnecting due to listenKey refresh failure');
          }
        }
      }, 30 * 60 * 1000);

      await this.addLog(`[WebSocket] User Data WS reconnection successful. ListenKey refresh interval re-established.`);
    } catch (error) {
      console.error(`Failed to reconnect User Data WS: ${error.message}`);
      await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to reconnect User Data WS: ${error.message}`);

      // Schedule another reconnect attempt if we haven't exceeded max attempts
      if (this.userDataReconnectAttempts < MAX_RECONNECT_ATTEMPTS && this.isRunning) {
        this.userDataReconnectAttempts++;
        const retryDelay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.userDataReconnectAttempts - 1));
        await this.addLog(`[WebSocket] Scheduling retry in ${retryDelay / 1000}s (Attempt ${this.userDataReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

        this.userDataReconnectTimeout = setTimeout(() => {
          this.attemptUserDataReconnection();
        }, retryDelay);
      } else {
        await this.addLog(`ERROR: [CONNECTION_ERROR] Max User Data WS reconnect attempts reached or strategy stopped.`);
        await this.addLog(`WARNING: Strategy is operating in DEGRADED MODE - using REST API polling for order confirmations.`);
      }
    }
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
      this.addLog('ERROR: [CONNECTION_ERROR] listenKey is null, cannot connect User Data Stream.');
      return;
    }
    if (this.userDataWs) {
      // Set flag to indicate intentional reconnection (prevents race condition)
      this.isUserDataReconnecting = true;
      this.userDataWs.close(1000, 'Intentional reconnection');
      //this.addLog('Closing existing User Data Stream WebSocket.');
    }

    const wsBaseUrl = this.isTestnet === true
      ? 'wss://stream.binance.com/ws'
      : 'wss://fstream.binance.com/ws';

    const fullWsUrl = `${wsBaseUrl}/${this.listenKey}`;
    this.userDataWs = new WebSocket(fullWsUrl);

    this.userDataWs.on('open', async () => {
      await this.addLog('[WebSocket] User Data WS connected.');
      this.userDataWsConnected = true;
      this.userDataReconnectAttempts = 0; // Reset attempts on successful connection
      if (this.userDataReconnectTimeout) clearTimeout(this.userDataReconnectTimeout);

      // Start heartbeat for User Data WS
      this.userDataWsPingInterval = setInterval(() => {
        this.userDataWs.ping();
        this.userDataWsPingTimeout = setTimeout(() => {
          this.addLog('[WebSocket] User Data WS pong timeout. Terminating connection.');
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
            await this.addLog(`[WebSocket] ORDER_TRADE_UPDATE for order ${order.i}, status: ${order.X}, side: ${order.S}, quantity: ${order.q}, filled: ${order.z}`);
          }

          // FIXED: Capture trade data only from TRADE events (each fill is a distinct trade)
          // Each TRADE event contains incremental values (order.l, order.L, order.rp, order.n)
          // Removed Method 2 to fix bug where duplicate prevention skipped valid fills
          let shouldSaveTrade = false;
          let tradeQty = 0;
          let tradePrice = 0;

          // Only capture TRADE events - each represents a distinct fill with incremental values
          if (order.x === 'TRADE' && parseFloat(order.L) > 0) {
            shouldSaveTrade = true;
            tradeQty = parseFloat(order.l); // Last filled quantity (incremental)
            tradePrice = parseFloat(order.L); // Last filled price
          }

          if (shouldSaveTrade && tradeQty > 0) {
            const realizedPnl = parseFloat(order.rp) || 0; // Realized PnL for this fill (incremental)
            let commission = parseFloat(order.n) || 0; // Commission for this fill (incremental)
            const commissionAsset = order.N || 'USDT';

            // If commission is not provided in the event, calculate it
            if (commission === 0 && tradeQty > 0 && tradePrice > 0) {
              commission = tradeQty * tradePrice * this.feeRate;
            }

            // Accumulate realized PnL and fees (these are incremental values per fill)
            if (!isNaN(realizedPnl) && realizedPnl !== 0) {
              this.accumulatedRealizedPnL += realizedPnl;
              await this.addLog(`Trade: Order ${order.i}, PnL: ${this._formatNotional(realizedPnl)} USDT, Total: ${this._formatNotional(this.accumulatedRealizedPnL)} USDT`);
            }
            if (!isNaN(commission) && commission !== 0) {
              this.accumulatedTradingFees += commission;
              await this.addLog(`Trade: Order ${order.i}, Fee: ${this._formatNotional(commission)} USDT, Total: ${this._formatNotional(this.accumulatedTradingFees)} USDT`);
            }

            // Save individual trade details to Firestore
            const tradeDetails = {
              orderId: order.i,
              symbol: order.s,
              time: order.T,
              price: tradePrice,
              qty: tradeQty,
              quoteQty: tradePrice * tradeQty,
              commission: commission,
              commissionAsset: commissionAsset,
              realizedPnl: realizedPnl,
              isBuyer: order.S === 'BUY',
              role: order.m ? 'Maker' : 'Taker',
            };
            await this.saveTrade(tradeDetails);

            // Note: Removed savedTradeOrderIds.add() here - each TRADE event is unique and should be captured
          }

          // Resolve/Reject pending order promises based on order status
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
        await this.addLog(`ERROR: [CONNECTION_ERROR] Processing User Data Stream message: ${error.message}`);
      }
    });

    this.userDataWs.on('error', async (error) => {
      console.error(`User Data Stream WebSocket error: ${error.message}. Attempting reconnect.`);
      await this.addLog(`ERROR: [CONNECTION_ERROR] User Data Stream WebSocket error: ${error.message}`);
    });

    this.userDataWs.on('close', async (code, reason) => {
      this.userDataWsConnected = false;
      await this.addLog(`[WebSocket] User Data Stream WebSocket closed. Code: ${code}, Reason: ${reason || 'none'}, isRunning: ${this.isRunning}, isUserDataReconnecting: ${this.isUserDataReconnecting}`);

      // Clear heartbeat on close
      if (this.userDataWsPingInterval) clearInterval(this.userDataWsPingInterval);
      if (this.userDataWsPingTimeout) clearTimeout(this.userDataWsPingTimeout);

      // Check if this is an intentional reconnection (race condition prevention)
      // Only skip reconnection for normal closure (1000) with the reconnecting flag
      if (this.isUserDataReconnecting && code === 1000) {
        this.isUserDataReconnecting = false;
        await this.addLog(`[WebSocket] User Data WS closed intentionally during reconnection. Skipping reconnect logic.`);
        return; // Don't trigger reconnection logic for intentional closes
      }

      // Clear the flag in case it was set but this is an abnormal closure
      if (this.isUserDataReconnecting) {
        await this.addLog(`[WebSocket] Abnormal closure detected (code ${code}), clearing isUserDataReconnecting flag and proceeding with reconnection.`);
        this.isUserDataReconnecting = false;
      }

      // Only attempt reconnection if strategy is running and it's not a normal closure
      if (this.isRunning && code !== 1000) { // 1000 is normal closure
        this.userDataReconnectAttempts++;

        if (this.userDataReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.userDataReconnectAttempts - 1));
          await this.addLog(`[WebSocket] User Data WS disconnected. Scheduling reconnect in ${delay / 1000}s (Attempt ${this.userDataReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

          // Clear any existing reconnection timeout before scheduling a new one
          if (this.userDataReconnectTimeout) {
            clearTimeout(this.userDataReconnectTimeout);
            this.userDataReconnectTimeout = null;
          }

          // Schedule reconnection attempt
          this.userDataReconnectTimeout = setTimeout(() => {
            this.attemptUserDataReconnection();
          }, delay);
        } else {
          await this.addLog(`ERROR: [CONNECTION_ERROR] Max User Data WS reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. User Data Stream permanently disconnected.`);
          await this.addLog(`WARNING: Strategy is operating in DEGRADED MODE - using REST API polling for order confirmations.`);
        }
      } else if (code === 1000) {
        await this.addLog(`[WebSocket] User Data WS closed normally (code 1000). No reconnection needed.`);
      } else if (!this.isRunning) {
        await this.addLog(`[WebSocket] User Data WS closed but strategy not running. No reconnection attempt.`);
      }
    });
  }

  // NEW: Helper to retry listenKey API request with exponential backoff
  async _retryListenKeyRequest(isRefresh = false) {
    const maxAttempts = MAX_RECONNECT_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.addLog(`[REST-API] Attempting listenKey ${isRefresh ? 'refresh' : 'request'}... (Attempt ${attempt}/${maxAttempts})`);

        const endpoint = '/fapi/v1/listenKey';
        const method = isRefresh ? 'PUT' : 'POST';
        const params = isRefresh ? { listenKey: this.listenKey } : {};

        const response = await this.makeProxyRequest(endpoint, method, params, true, 'futures');

        if (!isRefresh && response.listenKey) {
          this.listenKey = response.listenKey;
          await this.addLog(`[REST-API] ListenKey obtained successfully on attempt ${attempt}.`);
          this.listenKeyRetryAttempts = 0; // Reset on success
          return response;
        } else if (isRefresh) {
          await this.addLog(`[REST-API] ListenKey refreshed successfully on attempt ${attempt}.`);
          this.listenKeyRetryAttempts = 0; // Reset on success
          return response;
        }
      } catch (error) {
        await this.addLog(`[REST-API] ListenKey ${isRefresh ? 'refresh' : 'request'} attempt ${attempt} failed: ${error.message}`);

        if (attempt < maxAttempts) {
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1));
          await this.addLog(`[REST-API] Retrying listenKey ${isRefresh ? 'refresh' : 'request'} in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to ${isRefresh ? 'refresh' : 'obtain'} listenKey after ${maxAttempts} attempts.`);
          throw error;
        }
      }
    }

    throw new Error(`Failed to ${isRefresh ? 'refresh' : 'obtain'} listenKey after ${maxAttempts} attempts`);
  }

  // NEW: Helper to wait for order confirmation with REST API fallback
  async _waitForOrderConfirmation(orderId, symbol) {
    return new Promise(async (resolve, reject) => {
      let timeoutId;
      let pollIntervalId;
      let resolved = false;

      // Setup WebSocket confirmation handler
      this.pendingOrders.set(orderId, {
        resolve: (order) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            if (pollIntervalId) clearInterval(pollIntervalId);
            this.pendingOrders.delete(orderId);
            resolve({ order, source: 'WebSocket' });
          }
        },
        reject: (error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            if (pollIntervalId) clearInterval(pollIntervalId);
            this.pendingOrders.delete(orderId);
            reject(error);
          }
        }
      });

      // Setup timeout for WebSocket confirmation
      timeoutId = setTimeout(async () => {
        if (!resolved && !this.userDataWsConnected) {
          await this.addLog(`[REST-API-FALLBACK] User Data WS disconnected. Polling order ${orderId} status via REST API...`);

          let pollCount = 0;
          pollIntervalId = setInterval(async () => {
            if (resolved) {
              clearInterval(pollIntervalId);
              return;
            }

            pollCount++;
            if (pollCount > MAX_ORDER_STATUS_POLLS) {
              if (!resolved) {
                resolved = true;
                this.pendingOrders.delete(orderId);
                clearInterval(pollIntervalId);
                reject(new Error(`Order ${orderId} confirmation timeout after ${MAX_ORDER_STATUS_POLLS} polling attempts`));
              }
              return;
            }

            try {
              const order = await this._queryOrder(symbol, orderId);
              await this.addLog(`[REST-API-FALLBACK] Order ${orderId} status: ${order.status} (Poll ${pollCount}/${MAX_ORDER_STATUS_POLLS})`);

              if (order.status === 'FILLED') {
                if (!resolved) {
                  resolved = true;
                  this.pendingOrders.delete(orderId);
                  clearInterval(pollIntervalId);

                  // Manually process the order as if it came from WebSocket
                  await this._processOrderFillViaRestApi(order);

                  resolve({ order, source: 'REST-API-FALLBACK' });
                }
              } else if (order.status === 'CANCELED' || order.status === 'REJECTED' || order.status === 'EXPIRED') {
                if (!resolved) {
                  resolved = true;
                  this.pendingOrders.delete(orderId);
                  clearInterval(pollIntervalId);
                  reject(new Error(`Order ${orderId} ${order.status}`));
                }
              }
            } catch (error) {
              await this.addLog(`[REST-API-FALLBACK] Error polling order ${orderId}: ${error.message}`);
            }
          }, ORDER_STATUS_POLL_INTERVAL_MS);
        } else if (!resolved && this.userDataWsConnected) {
          // WebSocket is connected but no confirmation received
          await this.addLog(`[WebSocket] Order ${orderId} confirmation timeout. Starting REST API polling...`);

          let pollCount = 0;
          pollIntervalId = setInterval(async () => {
            if (resolved) {
              clearInterval(pollIntervalId);
              return;
            }

            pollCount++;
            if (pollCount > MAX_ORDER_STATUS_POLLS) {
              if (!resolved) {
                resolved = true;
                this.pendingOrders.delete(orderId);
                clearInterval(pollIntervalId);
                reject(new Error(`Order ${orderId} confirmation timeout after ${MAX_ORDER_STATUS_POLLS} polling attempts`));
              }
              return;
            }

            try {
              const order = await this._queryOrder(symbol, orderId);
              await this.addLog(`[REST-API-FALLBACK] Order ${orderId} status: ${order.status} (Poll ${pollCount}/${MAX_ORDER_STATUS_POLLS})`);

              if (order.status === 'FILLED') {
                if (!resolved) {
                  resolved = true;
                  this.pendingOrders.delete(orderId);
                  clearInterval(pollIntervalId);

                  // Manually process the order as if it came from WebSocket
                  await this._processOrderFillViaRestApi(order);

                  resolve({ order, source: 'REST-API-FALLBACK' });
                }
              } else if (order.status === 'CANCELED' || order.status === 'REJECTED' || order.status === 'EXPIRED') {
                if (!resolved) {
                  resolved = true;
                  this.pendingOrders.delete(orderId);
                  clearInterval(pollIntervalId);
                  reject(new Error(`Order ${orderId} ${order.status}`));
                }
              }
            } catch (error) {
              await this.addLog(`[REST-API-FALLBACK] Error polling order ${orderId}: ${error.message}`);
            }
          }, ORDER_STATUS_POLL_INTERVAL_MS);
        }
      }, ORDER_CONFIRMATION_TIMEOUT_MS);
    });
  }

  // NEW: Process order fill manually when confirmed via REST API
  async _processOrderFillViaRestApi(order) {
    try {
      // FIXED: Fetch actual trade data from Binance to get real realized PnL and commission
      await this.addLog(`[REST-API-FALLBACK] Fetching trades for order ${order.orderId}...`);

      // Fetch actual trades for this order from Binance
      const trades = await this.makeProxyRequest('/fapi/v1/userTrades', 'GET', {
        symbol: order.symbol,
        orderId: order.orderId
      }, true, 'futures');

      if (!trades || trades.length === 0) {
        await this.addLog(`[REST-API-FALLBACK] Warning: No trades found for order ${order.orderId}, using calculated values`);

        // Fallback to calculated values if no trades found
        const tradeQty = parseFloat(order.executedQty);
        const tradePrice = parseFloat(order.avgPrice);
        const commission = tradeQty * tradePrice * this.feeRate;

        this.accumulatedTradingFees += commission;

        const tradeDetails = {
          orderId: order.orderId,
          symbol: order.symbol,
          time: order.updateTime,
          price: tradePrice,
          qty: tradeQty,
          quoteQty: tradePrice * tradeQty,
          commission: commission,
          commissionAsset: 'USDT',
          realizedPnl: 0,
          isBuyer: order.side === 'BUY',
          role: 'Taker',
        };

        await this.saveTrade(tradeDetails);
        await this.addLog(`[REST-API-FALLBACK] Trade saved (calculated): Fee ${this._formatNotional(commission)} USDT`);
        await this.detectCurrentPosition();
        return;
      }

      // Process each trade returned (orders can have multiple fills)
      await this.addLog(`[REST-API-FALLBACK] Processing ${trades.length} trade(s) for order ${order.orderId}`);

      for (const trade of trades) {
        const tradeQty = parseFloat(trade.qty);
        const tradePrice = parseFloat(trade.price);
        const realizedPnl = parseFloat(trade.realizedPnl) || 0;
        const commission = parseFloat(trade.commission);
        const commissionAsset = trade.commissionAsset;

        // Accumulate realized PnL and fees from Binance trade data
        if (!isNaN(realizedPnl) && realizedPnl !== 0) {
          this.accumulatedRealizedPnL += realizedPnl;
          await this.addLog(`[REST-API-FALLBACK] Trade ${trade.id}: PnL ${this._formatNotional(realizedPnl)} USDT, Total: ${this._formatNotional(this.accumulatedRealizedPnL)} USDT`);
        }
        if (!isNaN(commission) && commission !== 0) {
          this.accumulatedTradingFees += commission;
          await this.addLog(`[REST-API-FALLBACK] Trade ${trade.id}: Fee ${this._formatNotional(commission)} USDT, Total: ${this._formatNotional(this.accumulatedTradingFees)} USDT`);
        }

        // Save individual trade details to Firestore
        const tradeDetails = {
          orderId: order.orderId,
          tradeId: trade.id,
          symbol: trade.symbol,
          time: trade.time,
          price: tradePrice,
          qty: tradeQty,
          quoteQty: parseFloat(trade.quoteQty),
          commission: commission,
          commissionAsset: commissionAsset,
          realizedPnl: realizedPnl,
          isBuyer: trade.buyer,
          role: trade.maker ? 'Maker' : 'Taker',
        };

        await this.saveTrade(tradeDetails);
      }

      await this.addLog(`[REST-API-FALLBACK] Successfully processed ${trades.length} trade(s) for order ${order.orderId}`);

      // Detect position after order fill
      await this.detectCurrentPosition();
    } catch (error) {
      console.error(`Error processing order fill via REST API: ${error.message}`);
      await this.addLog(`ERROR: [REST-API-FALLBACK] Failed to process order fill: ${error.message}`);
    }
  }

  // NEW: Start WebSocket health monitoring
  _startWebSocketHealthMonitoring() {
    // Clear any existing interval
    if (this.wsHealthCheckInterval) {
      clearInterval(this.wsHealthCheckInterval);
    }

    // Check WebSocket health every 5 minutes
    this.wsHealthCheckInterval = setInterval(async () => {
      const realtimeStatus = this.realtimeWsConnected ? 'CONNECTED' : 'DISCONNECTED';
      const userDataStatus = this.userDataWsConnected ? 'CONNECTED' : 'DISCONNECTED';

      await this.addLog(`[Health Check] WebSocket Status - Real-time Price: ${realtimeStatus}, User Data: ${userDataStatus}`);

      // Warn if User Data WebSocket is down
      if (!this.userDataWsConnected) {
        await this.addLog(`WARNING: [Health Check] User Data WebSocket is DISCONNECTED. Strategy is operating in DEGRADED MODE.`);
        await this.addLog(`WARNING: [Health Check] Order confirmations will use REST API polling fallback.`);
      }

      // Warn if Real-time Price WebSocket is down
      if (!this.realtimeWsConnected) {
        await this.addLog(`WARNING: [Health Check] Real-time Price WebSocket is DISCONNECTED. Price updates unavailable.`);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // NEW: Stop WebSocket health monitoring
  _stopWebSocketHealthMonitoring() {
    if (this.wsHealthCheckInterval) {
      clearInterval(this.wsHealthCheckInterval);
      this.wsHealthCheckInterval = null;
    }
  }

  // Helper to determine if dynamic sizing should be applied based on trading mode
  _shouldApplyDynamicSizing() {
    const reversalsSinceLastDynamic = this.reversalCount - this.lastDynamicSizingReversalCount;

    switch (this.tradingMode) {
      case 'AGGRESSIVE':
        return true; // Apply on every reversal
      case 'NORMAL':
        return reversalsSinceLastDynamic >= 3; // Apply every 3rd reversal (at #3, #6, #9, etc.)
      case 'CONSERVATIVE':
        return reversalsSinceLastDynamic >= 5; // Apply every 5th reversal (at #5, #10, #15, etc.)
      default:
        return true; // Default to aggressive if unknown mode
    }
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
            await this.addLog(`Dynamic Sizing: Current Net Loss: ${precisionFormatter.formatNotional(currentNetLoss)}.`);
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

  // NEW: Verify accumulated metrics against Binance trade history
  async _verifyAccumulatedMetrics() {
    try {
      await this.addLog(`[VERIFICATION] Checking accumulated metrics against Binance trade history...`);

      // Fetch recent trades from Binance (last 500 trades, should cover all trades in this strategy)
      const binanceTrades = await this.makeProxyRequest('/fapi/v1/userTrades', 'GET', {
        symbol: this.symbol,
        limit: 500
      }, true, 'futures');

      if (!binanceTrades || binanceTrades.length === 0) {
        await this.addLog(`[VERIFICATION] No trades found in Binance history for ${this.symbol}`);
        return;
      }

      // Filter trades using session start trade ID (baseline captured at strategy start)
      // Only include trades with IDs GREATER than the baseline (not equal, since baseline is pre-session)
      if (this.sessionStartTradeId !== null) {
        await this.addLog(`[VERIFICATION] Filtering trades with ID > ${this.sessionStartTradeId} (baseline)`);
      }

      const strategyTrades = this.sessionStartTradeId !== null
        ? binanceTrades.filter(trade => parseInt(trade.id) > this.sessionStartTradeId)
        : binanceTrades;

      if (strategyTrades.length === 0) {
        await this.addLog(`[VERIFICATION] No trades found for current session`);
        return;
      }

      // Calculate totals from Binance data
      let binanceRealizedPnL = 0;
      let binanceCommission = 0;

      for (const trade of strategyTrades) {
        const realizedPnl = parseFloat(trade.realizedPnl) || 0;
        const commission = parseFloat(trade.commission) || 0;

        binanceRealizedPnL += realizedPnl;
        binanceCommission += commission;
      }

      // Calculate expected trade count from trade sequence
      const expectedTradeCount = this.tradeSequence.split('.').filter(x => x).length;

      await this.addLog(`[VERIFICATION] Current session trades: ${strategyTrades.length} (filtered from ${binanceTrades.length} total)`);
      await this.addLog(`[VERIFICATION] Expected trades from sequence: ${expectedTradeCount}`);
      await this.addLog(`[VERIFICATION] Binance Realized PnL: ${this._formatNotional(binanceRealizedPnL)} USDT`);
      await this.addLog(`[VERIFICATION] Binance Commission: ${this._formatNotional(binanceCommission)} USDT`);
      await this.addLog(`[VERIFICATION] Strategy Realized PnL: ${this._formatNotional(this.accumulatedRealizedPnL)} USDT`);
      await this.addLog(`[VERIFICATION] Strategy Commission: ${this._formatNotional(this.accumulatedTradingFees)} USDT`);

      // Safety check: Warn if Binance returns significantly more trades than expected
      if (strategyTrades.length > expectedTradeCount * 2 && expectedTradeCount > 0) {
        await this.addLog(`[VERIFICATION] WARNING: Binance returned ${strategyTrades.length} trades but expected ~${expectedTradeCount}.`);
        await this.addLog(`[VERIFICATION] This may indicate historical trades are being included. Skipping auto-correction.`);
        return;
      }

      // Calculate differences
      const pnlDifference = Math.abs(binanceRealizedPnL - this.accumulatedRealizedPnL);
      const feeDifference = Math.abs(binanceCommission - this.accumulatedTradingFees);

      // Log discrepancies if significant (> 1 USDT)
      if (pnlDifference > 1.0) {
        await this.addLog(`[VERIFICATION] WARNING: Realized PnL mismatch of ${this._formatNotional(pnlDifference)} USDT detected!`);
        await this.addLog(`[VERIFICATION] Auto-correcting to Binance value...`);
        this.accumulatedRealizedPnL = binanceRealizedPnL;
      } else {
        await this.addLog(`[VERIFICATION] Realized PnL verified (difference: ${this._formatNotional(pnlDifference)} USDT)`);
      }

      if (feeDifference > 1.0) {
        await this.addLog(`[VERIFICATION] WARNING: Commission mismatch of ${this._formatNotional(feeDifference)} USDT detected!`);
        await this.addLog(`[VERIFICATION] Auto-correcting to Binance value...`);
        this.accumulatedTradingFees = binanceCommission;
      } else {
        await this.addLog(`[VERIFICATION] Commission verified (difference: ${this._formatNotional(feeDifference)} USDT)`);
      }

      // Save corrected state if changes were made
      if (pnlDifference > 1.0 || feeDifference > 1.0) {
        await this.saveState();
        await this.addLog(`[VERIFICATION] Corrected values saved to state`);
      }

    } catch (error) {
      console.error(`Error verifying accumulated metrics: ${error.message}`);
      await this.addLog(`[VERIFICATION] WARNING: Could not verify metrics: ${error.message}`);
    }
  }

  // Volatility detection using synthetic microbars
  async _updateMicrobar(tickPrice) {
    // Skip if volatility disabled OR measurement not active yet
    if (!this.volatilityEnabled || !this.volatilityMeasurementActive) {
      return;
    }

    // Initialize microbar on first tick
    if (this.microbarOpen === null) {
      this.microbarOpen = tickPrice;
      this.microbarHigh = tickPrice;
      this.microbarLow = tickPrice;
      this.microbarClose = tickPrice;
      this.microbarTickCount = 1;
      return;
    }

    // Update microbar fields
    this.microbarHigh = Math.max(this.microbarHigh, tickPrice);
    this.microbarLow = Math.min(this.microbarLow, tickPrice);
    this.microbarClose = tickPrice;
    this.microbarTickCount++;

    // Not enough ticks yet → return
    if (this.microbarTickCount < this.MICROBAR_TICK_LIMIT) return;

    // ===== Close microbar =====
    const bodyPercent = Math.abs(this.microbarClose - this.microbarOpen) / this.microbarOpen * 100;

    // Update rolling history
    this.microbarHistory.push(bodyPercent);
    if (this.microbarHistory.length > this.volatilityLookback) {
      this.microbarHistory.shift();
    }

    // Compute volatility expansion
    let volatilityState = 'INITIALIZING';
    if (this.microbarHistory.length >= this.volatilityLookback) {
      const avgBody = this.microbarHistory.reduce((a, b) => a + b, 0) / this.microbarHistory.length;
      const threshold = avgBody * this.volatilityMultiplier;
      const previousState = this.volatilityExpanded;
      this.volatilityExpanded = bodyPercent > threshold;

      volatilityState = this.volatilityExpanded ? 'EXPANDED' : 'CHOPPY';

      // Log state changes (DO NOT REMOVE: Keep this log for future use)
      // if (previousState !== this.volatilityExpanded) {
      //   if (this.volatilityExpanded) {
      //     await this.addLog(`Volatility state changed: CHOPPY → EXPANDED (body ${bodyPercent.toFixed(3)}% > threshold ${threshold.toFixed(3)}%)`);
      //   } else {
      //     await this.addLog(`Volatility state changed: EXPANDED → CHOPPY (body ${bodyPercent.toFixed(3)}% < threshold ${threshold.toFixed(3)}%)`);
      //   }
      //   await this.saveState();
      // }

      // Log microbar closure with full details
      await this.addLog(`Microbar closed | Body: ${bodyPercent.toFixed(3)}% | Avg: ${avgBody.toFixed(3)}% | Threshold: ${threshold.toFixed(3)}% | State: ${volatilityState} | Count: ${this.microbarHistory.length}/${this.volatilityLookback}`);
    } else {
      // During initialization phase, show average of available data
      const currentAvg = this.microbarHistory.length > 0
        ? (this.microbarHistory.reduce((a, b) => a + b, 0) / this.microbarHistory.length).toFixed(3)
        : 'N/A';
      await this.addLog(`Microbar closed | Body: ${bodyPercent.toFixed(3)}% | Avg: ${currentAvg}% | State: ${volatilityState} | Count: ${this.microbarHistory.length}/${this.volatilityLookback}`);
    }

    // Reset microbar
    this.microbarOpen = tickPrice;
    this.microbarHigh = tickPrice;
    this.microbarLow = tickPrice;
    this.microbarClose = tickPrice;
    this.microbarTickCount = 1;
  }

  // Helper to calculate breakeven and final TP after scaling
  async _checkAndMoveReversalLevel(currentPrice) {
    // Only proceed if feature is enabled and not already moved
    if (this.moveReversalLevel !== 'MOVE_TO_BREAKEVEN' || this.reversalLevelMoved) {
      return;
    }

    // Only proceed if we have a position and entry price
    if (this.currentPosition === 'NONE' || !this.positionEntryPrice) {
      return;
    }

    let shouldMove = false;
    let newReversalLevel = null;

    if (this.currentPosition === 'LONG' && currentPrice >= this.positionEntryPrice * 1.005) {
      // LONG position: Price moved 0.5% UP from entry
      shouldMove = true;
      // Move reversal level to 0.05% ABOVE entry (from below to above)
      newReversalLevel = this.positionEntryPrice * 1.0005;

      await this.addLog(`Price moved favorably to ${this._formatPrice(currentPrice)} (+0.50% from entry ${this._formatPrice(this.positionEntryPrice)})`);
    } else if (this.currentPosition === 'SHORT' && currentPrice <= this.positionEntryPrice * 0.995) {
      // SHORT position: Price moved 0.5% DOWN from entry
      shouldMove = true;
      // Move reversal level to 0.05% BELOW entry (from above to below)
      newReversalLevel = this.positionEntryPrice * 0.9995;

      await this.addLog(`Price moved favorably to ${this._formatPrice(currentPrice)} (-0.50% from entry ${this._formatPrice(this.positionEntryPrice)})`);
    }

    if (shouldMove && newReversalLevel !== null) {
      // Validate new reversal level is reasonable (not too close to current price)
      const priceDistance = Math.abs((newReversalLevel - currentPrice) / currentPrice);
      if (priceDistance < 0.001) { // Less than 0.1% from current price
        await this.addLog(`Reversal level movement skipped - too close to current price (${(priceDistance * 100).toFixed(3)}%)`);
        return;
      }

      // Store original reversal level for logging
      this.originalReversalLevel = this.reversalLevel;

      // Calculate percentage change for logging
      const originalPercent = ((this.originalReversalLevel - this.positionEntryPrice) / this.positionEntryPrice) * 100;
      const newPercent = ((newReversalLevel - this.positionEntryPrice) / this.positionEntryPrice) * 100;

      // Update reversal level
      this.reversalLevel = newReversalLevel;
      this.reversalLevelMoved = true;

      // Log the movement
      if (this.currentPosition === 'LONG') {
        await this.addLog(`Reversal Level moved: ${this._formatPrice(this.originalReversalLevel)} → ${this._formatPrice(this.reversalLevel)} (from ${originalPercent.toFixed(2)}% to +${newPercent.toFixed(2)}% of entry) - Profit protection active`);
      } else {
        await this.addLog(`Reversal Level moved: ${this._formatPrice(this.originalReversalLevel)} → ${this._formatPrice(this.reversalLevel)} (from +${originalPercent.toFixed(2)}% to ${newPercent.toFixed(2)}% of entry) - Profit protection active`);
      }

      // Save state to persist the change
      await this.saveState();
    }
  }

  async _calculateBreakevenAndFinalTp() {
    if (!this.currentPositionQuantity || this.currentPositionQuantity <= 0 || !this.positionEntryPrice) {
      await this.addLog(`BE/Final TP Calc: Cannot calculate - invalid position quantity or entry price.`);
      return;
    }

    // Verify accumulated metrics before calculating breakeven
    await this._verifyAccumulatedMetrics();

    // Calculate Breakeven Price
    const netRealizedPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;

    // Count trades from trade sequence
    const tradeCount = this.tradeSequence.split('.').filter(x => x).length;

    await this.addLog(`BE Calc: Accumulated Realized PnL: ${precisionFormatter.formatNotional(this.accumulatedRealizedPnL)} (from ${tradeCount} trades)`);
    await this.addLog(`BE Calc: Accumulated Trading Fees: ${precisionFormatter.formatNotional(this.accumulatedTradingFees)}`);
    await this.addLog(`BE Calc: Net Realized PnL: ${precisionFormatter.formatNotional(netRealizedPnL)}`);
    await this.addLog(`BE Calc: Current Position Quantity: ${this._formatQuantity(this.currentPositionQuantity)}`);

    let breakevenPriceRaw;
    if (this.currentPosition === 'LONG') {
      breakevenPriceRaw = this.positionEntryPrice - (netRealizedPnL / this.currentPositionQuantity);
    } else { // SHORT
      breakevenPriceRaw = this.positionEntryPrice + (netRealizedPnL / this.currentPositionQuantity);
    }

    await this.addLog(`BE Calc: Raw Breakeven Price: ${this._formatPrice(breakevenPriceRaw)}`);
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

    // Check if TP at Breakeven mode is enabled
    if (this.tpAtBreakeven) {
      // Set Final TP to breakeven level with a small offset to ensure validation passes
      // For LONG: TP must be > entry, so use 1.0005 multiplier (0.05% above breakeven)
      // For SHORT: TP must be < entry, so use 0.9995 multiplier (0.05% below breakeven)
      if (this.currentPosition === 'LONG') {
        this.finalTpPrice = this.roundPrice(this.breakevenPrice * 1.0005);
      } else { // SHORT
        this.finalTpPrice = this.roundPrice(this.breakevenPrice * 0.9995);
      }

      // Calculate the percentage for display purposes
      if (this.currentPosition === 'LONG') {
        this.finalTpPercentage = ((this.finalTpPrice - this.positionEntryPrice) / this.positionEntryPrice) * 100;
      } else { // SHORT
        this.finalTpPercentage = ((this.positionEntryPrice - this.finalTpPrice) / this.positionEntryPrice) * 100;
      }

      await this.addLog(`Breakeven Price: ${this._formatPrice(this.breakevenPrice)} (${precisionFormatter.formatPercentage(this.breakevenPercentage)}% from entry).`);
      await this.addLog(`Final TP Price: ${this._formatPrice(this.finalTpPrice)} (${precisionFormatter.formatPercentage(this.finalTpPercentage)}% from entry) - TP AT BREAKEVEN MODE ACTIVE (with 0.05% offset for execution).`);
    } else if ((this.currentPosition === 'LONG' && this.customFinalTpLong !== null) || (this.currentPosition === 'SHORT' && this.customFinalTpShort !== null)) {
      // Use position-specific custom Final TP level
      const customTpValue = this.currentPosition === 'LONG' ? this.customFinalTpLong : this.customFinalTpShort;
      this.finalTpPrice = this.roundPrice(customTpValue);

      // Calculate the percentage for display purposes
      if (this.currentPosition === 'LONG') {
        this.finalTpPercentage = ((this.finalTpPrice - this.positionEntryPrice) / this.positionEntryPrice) * 100;
      } else { // SHORT
        this.finalTpPercentage = ((this.positionEntryPrice - this.finalTpPrice) / this.positionEntryPrice) * 100;
      }

      await this.addLog(`Breakeven Price: ${this._formatPrice(this.breakevenPrice)} (${precisionFormatter.formatPercentage(this.breakevenPercentage)}% from entry).`);
      await this.addLog(`Final TP Price: ${this._formatPrice(this.finalTpPrice)} (${precisionFormatter.formatPercentage(this.finalTpPercentage)}% from entry) - Using custom ${this.currentPosition} price target.`);
    } else if (this.desiredProfitUSDT !== null && this.desiredProfitUSDT > 0) {
      // Calculate TP to achieve desired USDT profit target
      await this.addLog(`Using Desired Profit Target mode: ${this._formatNotional(this.desiredProfitUSDT)} USDT`);

      // Step 1: Calculate current net loss
      const currentNetLoss = -(this.accumulatedRealizedPnL - this.accumulatedTradingFees);
      await this.addLog(`Current Net Loss: ${this._formatNotional(currentNetLoss)} USDT`);

      // Step 2: Calculate current position value
      const currentPositionValue = this.currentPositionQuantity * this.positionEntryPrice;
      await this.addLog(`Current Position Value: ${this._formatNotional(currentPositionValue)} USDT`);

      // Step 3: Calculate trading fee for closing position at TP
      const closingTradingFee = currentPositionValue * this.feeRate;
      await this.addLog(`Estimated Closing Fee: ${this._formatNotional(closingTradingFee)} USDT (${precisionFormatter.formatPercentage(this.feeRate * 100)}%)`);

      // Step 4: Calculate required gross profit (including closing fee)
      const requiredGrossProfit = this.desiredProfitUSDT + currentNetLoss + closingTradingFee;
      await this.addLog(`Required Gross Profit: ${this._formatNotional(requiredGrossProfit)} USDT (includes loss recovery + desired profit + closing fee)`);

      // Step 5: Calculate final TP percentage from entry (this already accounts for everything)
      const finalTpPercentFromEntry = (requiredGrossProfit / currentPositionValue) * 100;
      await this.addLog(`Final TP Percentage from Entry: ${precisionFormatter.formatPercentage(finalTpPercentFromEntry)}%`);

      // Step 6: Validate that the TP makes sense for the position direction
      if (finalTpPercentFromEntry < bePercentFromEntry) {
        await this.addLog(`WARNING: Desired profit target already achieved or too low. Using breakeven + 0.1% as safety.`);
        this.finalTpPercentage = bePercentFromEntry + 0.1;
      } else {
        this.finalTpPercentage = finalTpPercentFromEntry;
      }

      // Step 7: Calculate final TP price
      if (this.currentPosition === 'LONG') {
        this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 + this.finalTpPercentage / 100));

        // Validate LONG TP is above entry
        if (this.finalTpPrice <= this.positionEntryPrice) {
          await this.addLog(`ERROR: Calculated LONG TP (${this._formatPrice(this.finalTpPrice)}) is not above entry. Falling back to default calculation.`);
          const profitTarget = DESIRED_PROFIT_PERCENTAGE;
          this.finalTpPercentage = bePercentFromEntry + profitTarget;
          this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 + this.finalTpPercentage / 100));
        }
      } else { // SHORT
        this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 - this.finalTpPercentage / 100));

        // Validate SHORT TP is below entry
        if (this.finalTpPrice >= this.positionEntryPrice) {
          await this.addLog(`ERROR: Calculated SHORT TP (${this._formatPrice(this.finalTpPrice)}) is not below entry. Falling back to default calculation.`);
          const profitTarget = DESIRED_PROFIT_PERCENTAGE;
          this.finalTpPercentage = bePercentFromEntry + profitTarget;
          this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 - this.finalTpPercentage / 100));
        }
      }

      await this.addLog(`Breakeven Price: ${this._formatPrice(this.breakevenPrice)} (${precisionFormatter.formatPercentage(this.breakevenPercentage)}% from entry).`);
      await this.addLog(`Final TP Price: ${this._formatPrice(this.finalTpPrice)} (${precisionFormatter.formatPercentage(this.finalTpPercentage)}% from entry) - Targeting ${this._formatNotional(this.desiredProfitUSDT)} USDT profit.`);
    } else {
      // Use default percentage calculation
      const profitTarget = DESIRED_PROFIT_PERCENTAGE;
      const finalTpPercentFromEntry = bePercentFromEntry + profitTarget;

      if (this.currentPosition === 'LONG') {
        this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 + finalTpPercentFromEntry / 100));
      } else { // SHORT
        this.finalTpPrice = this.roundPrice(this.positionEntryPrice * (1 - finalTpPercentFromEntry / 100));
      }

      this.finalTpPercentage = finalTpPercentFromEntry;

      await this.addLog(`Breakeven Price: ${this._formatPrice(this.breakevenPrice)} (${precisionFormatter.formatPercentage(this.breakevenPercentage)}% from entry).`);
      await this.addLog(`Final TP Price: ${this._formatPrice(this.finalTpPrice)} (${precisionFormatter.formatPercentage(this.finalTpPercentage)}% from entry).`);
    }

    this.finalTpActive = true;
  }

  async _calculatePartialTpLevels() {
    // Check if any partial TP levels are enabled (size > 0)
    const hasPartialTpEnabled = this.partialTpSizes.some(size => size > 0);
    if (!hasPartialTpEnabled || !this.positionEntryPrice || this.currentPosition === 'NONE') {
      return;
    }

    this.currentEntryReference = this.positionEntryPrice;
    this.partialTpPrices = [null, null, null];
    this.partialTpExecuted = [false, false, false];

    await this.addLog(`Calculating Partial TP levels for ${this.currentPosition} position at entry ${this._formatPrice(this.positionEntryPrice)}`);

    for (let i = 0; i < 3; i++) {
      if (this.partialTpSizes[i] > 0) {
        const percentageDistance = this.partialTpLevels[i];

        if (this.currentPosition === 'LONG') {
          this.partialTpPrices[i] = this.roundPrice(this.positionEntryPrice * (1 + percentageDistance / 100));
        } else {
          this.partialTpPrices[i] = this.roundPrice(this.positionEntryPrice * (1 - percentageDistance / 100));
        }

        await this.addLog(`  Partial TP Level ${i + 1}: ${percentageDistance}% (${this.partialTpSizes[i]}% position) -> Price: ${this._formatPrice(this.partialTpPrices[i])}`);
      } else {
        await this.addLog(`  Partial TP Level ${i + 1}: Disabled (size = 0%)`);
      }
    }
  }

  async _executePartialTp(levelIndex) {
    if (levelIndex < 0 || levelIndex >= 3) {
      await this.addLog(`ERROR: [VALIDATION_ERROR] Invalid partial TP level index: ${levelIndex}`);
      return false;
    }

    if (this.partialTpExecuted[levelIndex]) {
      return false;
    }

    if (this.partialTpSizes[levelIndex] <= 0) {
      return false;
    }

    this.isTradingSequenceInProgress = true;

    try {
      const canTrade = await this.checkCapitalProtection();
      if (!canTrade) {
        this.isTradingSequenceInProgress = false;
        return false;
      }

      const currentPositions = await this.getCurrentPositions();
      const targetPosition = currentPositions.find(p => p.symbol === this.symbol);

      if (!targetPosition || parseFloat(targetPosition.positionAmt) === 0) {
        await this.addLog(`Partial TP Level ${levelIndex + 1}: No active position found.`);
        this.isTradingSequenceInProgress = false;
        return false;
      }

      const currentPositionAmt = Math.abs(parseFloat(targetPosition.positionAmt));
      const percentageToClose = this.partialTpSizes[levelIndex];
      const quantityToClose = currentPositionAmt * (percentageToClose / 100);
      const roundedQuantity = this.roundQuantity(quantityToClose);

      if (roundedQuantity <= 0) {
        await this.addLog(`Partial TP Level ${levelIndex + 1}: Calculated quantity too small (${quantityToClose}). Skipping.`);
        this.isTradingSequenceInProgress = false;
        return false;
      }

      const closingSide = this.currentPosition === 'LONG' ? 'SELL' : 'BUY';
      const targetPrice = this.partialTpPrices[levelIndex];

      await this.addLog(`===== PARTIAL TP LEVEL ${levelIndex + 1} TRIGGERED! =====`);
      await this.addLog(`  Target Price: ${this._formatPrice(targetPrice)}`);
      await this.addLog(`  Closing ${percentageToClose}% of position (${this._formatQuantity(roundedQuantity)} ${this.symbol})`);

      const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', {
        symbol: this.symbol,
        side: closingSide,
        type: 'MARKET',
        quantity: roundedQuantity,
        newOrderRespType: 'FULL'
      }, true, 'futures');

      if (result && result.orderId) {
        await this.addLog(`[REST-API] Partial TP order ${result.orderId} placed. Waiting for confirmation...`);

        // Use new fallback mechanism for order confirmation
        const confirmation = await this._waitForOrderConfirmation(result.orderId, this.symbol);
        await this.addLog(`[${confirmation.source}] Partial TP order ${result.orderId} confirmed as FILLED.`);

        this.partialTpExecuted[levelIndex] = true;
        this.partialTpCount++; // Increment partial TP counter
        this.tradeSequence += `${levelIndex + 1}.`;

        await this.addLog(`Partial TP Level ${levelIndex + 1} executed successfully.`);

        // Position already detected in _processOrderFillViaRestApi if using REST API fallback
        // But call it again to be safe
        await this.detectCurrentPosition();

        // Recalculate BE/Final TP after partial TP execution
        // The BE and Final TP should adjust based on:
        // - Updated accumulated realized PnL (profit from partial TP)
        // - Reduced position quantity (remaining position after partial close)
        await this._calculateBreakevenAndFinalTp();

        if (this.currentPositionQuantity && this.positionEntryPrice) {
          const remainingNotional = this.currentPositionQuantity * this.positionEntryPrice;
          await this.addLog(`Remaining position: ${this._formatQuantity(this.currentPositionQuantity)} (${this._formatNotional(remainingNotional)} USDT)`);
        }

        await this.saveState();
        this.isTradingSequenceInProgress = false;
        return true;
      } else {
        throw new Error('Partial TP order placement failed: No orderId in response.');
      }
    } catch (error) {
      await this.addLog(`ERROR: [TRADING_ERROR] Executing Partial TP Level ${levelIndex + 1}: ${error.message}`);
      this.isTradingSequenceInProgress = false;
      return false;
    }
  }

  async _resetPartialTpState() {
    this.partialTpPrices = [null, null, null];
    this.partialTpExecuted = [false, false, false];
    this.currentEntryReference = null;
  }

  // Helper to check if virtual limit order has been triggered
  async _checkVirtualLimitTrigger(currentPrice) {
    // Early return if still initializing virtual limits (prevents premature logging during dual-limit setup)
    if (this.isInitializingVirtualLimits) return false;

    // Check if we have any virtual limit orders
    if (!this.virtualLongLimitOrder && !this.virtualShortLimitOrder) return false;

    // If virtual limit was already triggered once, don't check again
    // Just return status indicating we're in volatility check mode
    if (this.virtualLimitFirstTriggered) {
      return 'in_volatility_check';
    }

    let limitTriggered = false;
    let triggeredOrder = null;

    // Check primary virtual limit order (virtualLongLimitOrder)
    if (this.virtualLongLimitOrder) {
      if (this.virtualLongLimitOrder.side === 'BUY' && currentPrice <= this.virtualLongLimitOrder.price) {
        limitTriggered = true;
        triggeredOrder = this.virtualLongLimitOrder;
      } else if (this.virtualLongLimitOrder.side === 'SELL' && currentPrice >= this.virtualLongLimitOrder.price) {
        limitTriggered = true;
        triggeredOrder = this.virtualLongLimitOrder;
      }
    }

    // Check secondary virtual limit order (if dual limit setup)
    if (!limitTriggered && this.virtualShortLimitOrder) {
      if (this.virtualShortLimitOrder.side === 'BUY' && currentPrice <= this.virtualShortLimitOrder.price) {
        limitTriggered = true;
        triggeredOrder = this.virtualShortLimitOrder;
      } else if (this.virtualShortLimitOrder.side === 'SELL' && currentPrice >= this.virtualShortLimitOrder.price) {
        limitTriggered = true;
        triggeredOrder = this.virtualShortLimitOrder;
      }
    }

    if (!limitTriggered) {
      // Periodic status logging for virtual limit orders (every 30 seconds)
      const now = Date.now();
      if (!this.lastVirtualStatusLogTime || (now - this.lastVirtualStatusLogTime) >= 30000) {
        // Detect dual-limit mode and show both limits
        if (this.virtualLongLimitOrder && this.virtualShortLimitOrder) {
          await this.addLog(`Virtual LIMIT: Price ${this._formatPrice(currentPrice)} | Waiting for BUY at ${this._formatPrice(this.virtualLongLimitOrder.price)} or SELL at ${this._formatPrice(this.virtualShortLimitOrder.price)}`);
        } else if (this.virtualLongLimitOrder) {
          await this.addLog(`Virtual LIMIT: Price ${this._formatPrice(currentPrice)} | Waiting for ${this.virtualLongLimitOrder.side} trigger at ${this._formatPrice(this.virtualLongLimitOrder.price)}`);
        } else if (this.virtualShortLimitOrder) {
          await this.addLog(`Virtual LIMIT: Price ${this._formatPrice(currentPrice)} | Waiting for ${this.virtualShortLimitOrder.side} trigger at ${this._formatPrice(this.virtualShortLimitOrder.price)}`);
        }
        this.lastVirtualStatusLogTime = now;
      }
      return false;
    }

    // Limit/Market price hit for the FIRST TIME! Mark it and log it
    const orderTypeLabel = triggeredOrder.isMarketOrder ? 'MARKET' : 'LIMIT';
    await this.addLog(`Virtual ${triggeredOrder.side} ${orderTypeLabel} triggered (first time) at ${this._formatPrice(currentPrice)} (limit: ${this._formatPrice(triggeredOrder.price)})`);
    this.virtualLimitFirstTriggered = true;

    await this.addLog(`Checking volatility before opening position...`);

    if (!this.volatilityEnabled || this.volatilityExpanded) {
      // ===== VOLATILITY EXPANDED OR DISABLED - Open position immediately =====
      await this.addLog(`Volatility: ${this.volatilityEnabled ? 'EXPANDED' : 'DISABLED'} - opening position immediately`);

      this.isTradingSequenceInProgress = true;

      try {
        const orderSide = triggeredOrder.side;
        const quantity = triggeredOrder.quantity;
        const newPositionType = orderSide === 'BUY' ? 'LONG' : 'SHORT';

        await this.addLog(`Opening ${newPositionType} position with ${this._formatQuantity(quantity)} contracts`);
        await this.placeMarketOrder(this.symbol, orderSide, quantity);
        await this._waitForPositionChange(newPositionType);

        // Set active mode
        this.activeMode = newPositionType === 'LONG' ? 'SUPPORT_ZONE' : 'RESISTANCE_ZONE';
        this.currentPosition = newPositionType;
        this.entryPositionQuantity = quantity;
        this.currentPositionQuantity = quantity;

        // Set entry and reversal levels
        this.entryLevel = this.positionEntryPrice;
        if (this.reversalLevelPercentage !== null) {
          if (this.activeMode === 'SUPPORT_ZONE') {
            this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
          } else {
            this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
          }
          await this.addLog(`Entry: ${this._formatPrice(this.entryLevel)}, Reversal: ${this._formatPrice(this.reversalLevel)} (${this.activeMode})`);
        }

        // Reset Move Reversal Level state
        this.reversalLevelMoved = false;
        this.originalReversalLevel = null;

        // Set strategy start time if not already set
        if (!this.strategyStartTime) {
          this.strategyStartTime = new Date();
          await this.addLog(`Strategy timer started after virtual limit fill.`);
        }

        // Update trade sequence
        this.tradeSequence += newPositionType === 'LONG' ? 'L.' : 'S.';

        // Calculate BE, final TP, and partial TP
        await this._calculateBreakevenAndFinalTp();
        await this._calculatePartialTpLevels();

        await this.addLog(`Position opened: ${this.currentPosition} at ${this._formatPrice(this.positionEntryPrice)}`);

        // Clear virtual tracking state
        this.virtualPositionActive = false;
        this.virtualPositionDirection = null;
        this.virtualOriginalDirection = null;
        this.virtualLongLimitOrder = null;
        this.virtualShortLimitOrder = null;
        this.volatilityWaitStartTime = null;
        this.lastVirtualStatusLogTime = null;
        this.virtualEntryLevel = null;
        this.virtualReversalLevel = null;
        this.virtualLimitFirstTriggered = false;

        this.isTradingSequenceInProgress = false;
        await this.saveState();
        return true;

      } catch (error) {
        await this.addLog(`ERROR: [TRADING_ERROR] Opening position from virtual limit trigger: ${error.message}`);
        this.isTradingSequenceInProgress = false;
        return false;
      }

    } else {
      // ===== VOLATILITY CHOPPY - Continue virtual tracking with direction monitoring =====
      await this.addLog(`Volatility is CHOPPY - continuing virtual tracking mode with direction monitoring`);

      // Update virtual position direction based on triggered order
      const newDirection = triggeredOrder.side === 'BUY' ? 'LONG' : 'SHORT';

      if (this.virtualPositionDirection !== newDirection) {
        await this.addLog(`Virtual direction changed from ${this.virtualPositionDirection} to ${newDirection}`);
        this.virtualPositionDirection = newDirection;
      }

      // Set original direction if not already set (critical for direction flip logic)
      if (!this.virtualOriginalDirection) {
        this.virtualOriginalDirection = newDirection;
      }

      // Clear the non-triggered order if in dual limit setup
      if (triggeredOrder === this.virtualLongLimitOrder) {
        this.virtualShortLimitOrder = null; // Clear the other limit
      } else if (triggeredOrder === this.virtualShortLimitOrder) {
        this.virtualLongLimitOrder = triggeredOrder; // Promote triggered order to primary
        this.virtualShortLimitOrder = null;
      }

      // Update entry/reversal levels based on triggered direction
      this.entryLevel = triggeredOrder.price;
      this.virtualEntryLevel = triggeredOrder.price;

      if (this.reversalLevelPercentage !== null) {
        if (newDirection === 'LONG') {
          this.reversalLevel = this._calculateAdjustedPrice(triggeredOrder.price, this.reversalLevelPercentage, false);
          this.activeMode = 'SUPPORT_ZONE';
        } else {
          this.reversalLevel = this._calculateAdjustedPrice(triggeredOrder.price, this.reversalLevelPercentage, true);
          this.activeMode = 'RESISTANCE_ZONE';
        }
        this.virtualReversalLevel = this.reversalLevel;
        await this.addLog(`Updated levels: Entry=${this._formatPrice(this.entryLevel)}, Reversal=${this._formatPrice(this.reversalLevel)}`);
      }

      // Mark as waiting for volatility with direction tracking enabled
      if (!this.volatilityWaitStartTime) {
        this.volatilityWaitStartTime = Date.now();
      }
      this.lastVirtualDirectionChange = Date.now();
      this.virtualDirectionChanges = [];
      this.closedPositionType = null; // No position was closed for initial entry

      await this.addLog(`Waiting for volatility expansion - Direction: ${newDirection}`);
      await this.saveState();
      return true; // Continue virtual tracking
    }
  }

  async handleRealtimePrice(currentPrice) {
    // ===== 0. Update microbar for volatility detection =====
    await this._updateMicrobar(currentPrice);

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

    // Early exit if strategy is stopping - prevents duplicate trigger checks
    if (this.isStopping) {
      return;
    }

    // ===== NEW: Check for virtual limit order triggers BEFORE position logic =====
    if (this.virtualPositionActive && (this.virtualLongLimitOrder || this.virtualShortLimitOrder) && this.currentPosition === 'NONE') {
      const triggerStatus = await this._checkVirtualLimitTrigger(currentPrice);

      // Handle different trigger statuses
      if (triggerStatus === 'in_volatility_check') {
        // Already triggered, now in volatility check mode - continue to direction monitoring
        // Don't return, let it fall through to _updateVirtualPositionDirection
      } else if (triggerStatus === true) {
        // Just triggered for first time - handler managed the flow
        return;
      } else if (triggerStatus === false) {
        // Not triggered yet - keep waiting
        return;
      }
    }

    // Check if desired profit target is reached
    if (this.desiredProfitUSDT !== null && this.totalPnL >= this.desiredProfitUSDT) {
      await this.addLog(`===== DESIRED PROFIT TARGET REACHED =====`);
      await this.addLog(`Total PnL: ${precisionFormatter.formatNotional(this.totalPnL)} USDT`);
      await this.addLog(`Target: ${precisionFormatter.formatNotional(this.desiredProfitUSDT)} USDT`);
      await this.addLog(`Strategy stopping automatically.`);
      await this.stop();
      return;
    }

    // ===== NEW: Virtual Position Direction Tracking =====
    if (this.virtualPositionActive) {
      await this._updateVirtualPositionDirection(currentPrice);
      // If position was opened, continue with normal logic
      // If still waiting, return here to avoid other checks
      if (this.virtualPositionActive) {
        return; // Still waiting for volatility
      }
    }

    // Only execute trading logic if strategy is running AND position is open
    if (!this.isRunning || this.currentPosition === 'NONE') {
      return;
    }

    // ===== 0. Check and Move Reversal Level (if enabled) =====
    if (!this.isTradingSequenceInProgress) {
      await this._checkAndMoveReversalLevel(currentPrice);
    }

    // ===== 1. Partial TP Trigger Logic (Highest priority - runs before Final TP) =====
    const hasPartialTpEnabled = this.partialTpSizes.some(size => size > 0);
    if (hasPartialTpEnabled && this.currentPosition !== 'NONE' && !this.isTradingSequenceInProgress) {
      for (let i = 0; i < 3; i++) {
        if (!this.partialTpExecuted[i] && this.partialTpSizes[i] > 0 && this.partialTpPrices[i] !== null) {
          let shouldExecutePartialTp = false;

          if (this.currentPosition === 'LONG' && currentPrice >= this.partialTpPrices[i]) {
            shouldExecutePartialTp = true;
          } else if (this.currentPosition === 'SHORT' && currentPrice <= this.partialTpPrices[i]) {
            shouldExecutePartialTp = true;
          }

          if (shouldExecutePartialTp) {
            const executed = await this._executePartialTp(i);
            if (executed) {
              return;
            }
          }
        }
      }
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
        this.tradeSequence += 'F.';
        await this.addLog(`Final TP hit! Current price: ${this._formatPrice(currentPrice)}, Target: ${this._formatPrice(this.finalTpPrice)}. Closing remaining position and stopping strategy.`);
        try {
          await this.closeCurrentPosition();
          await this.addLog('Final TP: Waiting for position to be fully closed...');
          await this._waitForPositionChange('NONE');
          await this.addLog('Final TP: Position confirmed as NONE. Stopping strategy.');
          await this.stop();
        } catch (error) {
          console.error(`Error closing position for Final TP: ${error.message}`);
          await this.addLog(`ERROR: [TRADING_ERROR] Closing position for Final TP: ${error.message}`);
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
      this.closedPositionType = this.currentPosition; // Track for virtual direction logic

      // ===== PHASE 1: Close existing position (NO VOLATILITY CHECK) =====
      if (this.currentPosition !== 'NONE') {
        await this.addLog(`===== REVERSAL =====`);
        await this.addLog(`Reversal: ${this.currentPosition} position hit ${reversalType} level at ${this._formatPrice(reversalPrice)}. Closing position.`);
        await this.closeCurrentPosition();
        await this._waitForPositionChange('NONE');
        await this.addLog('Reversal: Position confirmed as NONE.');
        this.tradeSequence += 'C.'; // Add close notation
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Step 2: Check capital protection
      const canTrade = await this.checkCapitalProtection();
      if (!canTrade) {
        this.isTradingSequenceInProgress = false;
        return;
      }

      // Step 3: Determine if dynamic sizing should be applied based on trading mode
      const shouldApplyDynamic = this._shouldApplyDynamicSizing();

      if (shouldApplyDynamic) {
        this.positionSizeUSDT = await this._calculateDynamicPositionSize();
        this.lastDynamicSizingReversalCount = this.reversalCount;

        // Calculate next dynamic sizing reversal
        const interval = this.tradingMode === 'NORMAL' ? 3 : this.tradingMode === 'CONSERVATIVE' ? 5 : 1;
        const nextDynamicReversal = (this.reversalCount + 1) + interval;

        await this.addLog(`Reversal #${this.reversalCount + 1}: Applying dynamic position sizing: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
        if (this.tradingMode !== 'AGGRESSIVE') {
          await this.addLog(`Next dynamic sizing at reversal #${nextDynamicReversal}.`);
        }
      } else {
        const interval = this.tradingMode === 'NORMAL' ? 3 : 5;
        const reversalsSinceLastDynamic = this.reversalCount - this.lastDynamicSizingReversalCount;
        const reversalsUntilNext = interval - reversalsSinceLastDynamic;
        const nextDynamicReversal = this.reversalCount + 1 + reversalsUntilNext;
        await this.addLog(`Reversal #${this.reversalCount + 1}: Reusing position size: ${this._formatNotional(this.positionSizeUSDT)} USDT (Dynamic sizing will happen at #${nextDynamicReversal}).`);
      }

      // ===== PHASE 2: Check Volatility Before Opening =====
      if (this.volatilityEnabled && !this.volatilityExpanded) {
        // Enter virtual tracking mode instead of opening position
        this.virtualPositionActive = true;
        this.virtualPositionDirection = newPositionType; // Initial direction
        this.virtualOriginalDirection = newPositionType; // Track original direction for flip logic
        this.volatilityWaitStartTime = Date.now();
        this.lastVirtualDirectionChange = Date.now();
        this.lastVirtualStatusLogTime = Date.now();
        this.virtualDirectionChanges = [];
        this.virtualDirectionBuffer = null;

        // Calculate NEW entry and reversal levels for the virtual position
        // Entry = where reversal just occurred (reversalPrice)
        // Reversal = calculated from new entry based on new position type
        this.virtualEntryLevel = reversalPrice;

        if (newPositionType === 'LONG') {
          // LONG: reversal level is BELOW entry
          this.virtualReversalLevel = this._calculateAdjustedPrice(this.virtualEntryLevel, this.reversalLevelPercentage, false);
        } else {
          // SHORT: reversal level is ABOVE entry
          this.virtualReversalLevel = this._calculateAdjustedPrice(this.virtualEntryLevel, this.reversalLevelPercentage, true);
        }

        await this.addLog(`Entering virtual position tracking mode - waiting for volatility expansion`);
        await this.addLog(`Initial virtual direction: ${newPositionType}, Entry: ${this._formatPrice(this.virtualEntryLevel)}, Reversal: ${this._formatPrice(this.virtualReversalLevel)}`);

        this.isTradingSequenceInProgress = false; // Allow price monitoring
        await this.saveState();
        return; // Don't open position yet
      }

      // ===== PHASE 3: Open Position (Volatility is expanded or disabled) =====
      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);

      if (quantity > 0) {
        const orderSide = (newPositionType === 'LONG') ? 'BUY' : 'SELL';
        await this.addLog(`Reversal: Opening ${newPositionType} position with quantity ${quantity} (Volatility: ${this.volatilityExpanded ? 'EXPANDED' : 'DISABLED'})`);
        await this.placeMarketOrder(this.symbol, orderSide, quantity);
        await this._waitForPositionChange(newPositionType);

        this.currentPosition = newPositionType;
        this.reversalCount++;
        this.tradeSequence += 'R.';
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
        this.finalTpPrice = null;
        this.breakevenPrice = null;
        this.finalTpActive = false;
        this.finalTpOrderSent = false;
        this.breakevenPercentage = null;
        this.finalTpPercentage = null;
        await this._resetPartialTpState();

        // Position-specific custom Final TP levels are preserved during reversal
        // The appropriate custom TP (Long/Short) will be applied based on the new position type
        // NOTE: tpAtBreakeven is also preserved to maintain user's intent to exit at breakeven

        const hasCustomTpForNewPosition = (newPositionType === 'LONG' && this.customFinalTpLong !== null) ||
                                          (newPositionType === 'SHORT' && this.customFinalTpShort !== null);

        if (this.tpAtBreakeven) {
          await this.addLog(`TP at Breakeven mode is ACTIVE - Final TP will be set to the new BE level + buffer for the reversed ${newPositionType} position.`);
        } else if (hasCustomTpForNewPosition) {
          const customTpValue = newPositionType === 'LONG' ? this.customFinalTpLong : this.customFinalTpShort;
          await this.addLog(`Custom ${newPositionType} Final TP preserved: ${this._formatPrice(customTpValue)} - Will be applied after position is established.`);
        } else if (this.desiredProfitUSDT !== null && this.desiredProfitUSDT > 0) {
          await this.addLog(`Desired Profit Target is active: ${this._formatNotional(this.desiredProfitUSDT)} USDT - Will be applied after position is established.`);
        } else {
          await this.addLog(`No custom Final TP set for ${newPositionType} position - Default percentage will be used.`);
        }

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

        // Reset Move Reversal Level state for new reversed position
        this.reversalLevelMoved = false;
        this.originalReversalLevel = null;

        // Step 6: Calculate breakeven, final TP, and partial TP
        await this._calculateBreakevenAndFinalTp();
        await this._calculatePartialTpLevels();

        await this.saveState();
      }
    } catch (error) {
      console.error(`Error during reversal: ${error.message}`);
      await this.addLog(`ERROR: [TRADING_ERROR] During reversal: ${error.message}`);
    } finally {
      this.isTradingSequenceInProgress = false;
    }
  }

  // Virtual Position Direction Tracking
  async _updateVirtualPositionDirection(currentPrice) {
    if (!this.virtualPositionActive) return;

    // ===== 1. Determine which direction current price suggests =====
    let suggestedDirection = this.virtualPositionDirection; // Default: keep current

    // NEW LOGIC: Direction flip based on ORIGINAL and CURRENT virtual direction
    // - Virtual LONG (original) should flip to SHORT when price < reversal level
    // - Virtual LONG (original) should flip back to LONG when price > entry level
    // - Virtual SHORT (original) should flip to LONG when price > reversal level
    // - Virtual SHORT (original) should flip back to SHORT when price < entry level

    if (this.virtualOriginalDirection === 'LONG') {
      // Original direction was LONG
      if (this.virtualPositionDirection === 'LONG') {
        // Current is LONG - check if should flip to SHORT
        if (currentPrice < this.virtualReversalLevel) {
          suggestedDirection = 'SHORT';
        }
      } else if (this.virtualPositionDirection === 'SHORT') {
        // Current is SHORT - check if should flip back to LONG
        if (currentPrice > this.virtualEntryLevel) {
          suggestedDirection = 'LONG';
        }
      }
    } else if (this.virtualOriginalDirection === 'SHORT') {
      // Original direction was SHORT
      if (this.virtualPositionDirection === 'SHORT') {
        // Current is SHORT - check if should flip to LONG
        if (currentPrice > this.virtualReversalLevel) {
          suggestedDirection = 'LONG';
        }
      } else if (this.virtualPositionDirection === 'LONG') {
        // Current is LONG - check if should flip back to SHORT
        if (currentPrice < this.virtualEntryLevel) {
          suggestedDirection = 'SHORT';
        }
      }
    }

    // ===== 2. Apply debounce mechanism =====
    if (suggestedDirection !== this.virtualPositionDirection) {
      // Direction change suggested
      if (!this.virtualDirectionBuffer || this.virtualDirectionBuffer.direction !== suggestedDirection) {
        // First time seeing this new direction
        this.virtualDirectionBuffer = { direction: suggestedDirection, count: 1 };
      } else {
        // Increment counter
        this.virtualDirectionBuffer.count++;

        // Require 3 consecutive ticks to confirm direction change
        if (this.virtualDirectionBuffer.count >= 3) {
          // Direction change confirmed!
          const oldDirection = this.virtualPositionDirection;
          this.virtualPositionDirection = suggestedDirection;
          this.lastVirtualDirectionChange = Date.now();

          // Record change
          this.virtualDirectionChanges.push({
            timestamp: Date.now(),
            price: currentPrice,
            from: oldDirection,
            to: suggestedDirection
          });

          // Determine why the flip happened
          let flipReason = '';
          if (oldDirection === 'LONG' && suggestedDirection === 'SHORT') {
            // Flipping away from LONG or back to SHORT
            if (this.virtualOriginalDirection === 'LONG') {
              flipReason = `(price ${this._formatPrice(currentPrice)} < reversal ${this._formatPrice(this.virtualReversalLevel)})`;
            } else {
              flipReason = `(price ${this._formatPrice(currentPrice)} < entry ${this._formatPrice(this.virtualEntryLevel)})`;
            }
          } else if (oldDirection === 'SHORT' && suggestedDirection === 'LONG') {
            // Flipping away from SHORT or back to LONG
            if (this.virtualOriginalDirection === 'SHORT') {
              flipReason = `(price ${this._formatPrice(currentPrice)} > reversal ${this._formatPrice(this.virtualReversalLevel)})`;
            } else {
              flipReason = `(price ${this._formatPrice(currentPrice)} > entry ${this._formatPrice(this.virtualEntryLevel)})`;
            }
          }

          await this.addLog(`🔄 Virtual direction flipped: ${oldDirection} → ${suggestedDirection} at ${this._formatPrice(currentPrice)} ${flipReason}`);
          await this.saveState();

          // Reset buffer
          this.virtualDirectionBuffer = null;
        }
      }
    } else {
      // Price suggests current direction - reset buffer
      this.virtualDirectionBuffer = null;
    }

    // ===== 3. Periodic status logging (every 30 seconds) =====
    const now = Date.now();
    if (!this.lastVirtualStatusLogTime || (now - this.lastVirtualStatusLogTime) >= 30000) {
      const elapsedSec = Math.floor((now - this.volatilityWaitStartTime) / 1000);
      const elapsedMin = Math.floor(elapsedSec / 60);
      const elapsedSecRemainder = elapsedSec % 60;
      const elapsedStr = `${elapsedMin}m ${elapsedSecRemainder}s`;
      const stateStr = this.volatilityExpanded ? 'EXPANDED' : 'CHOPPY';
      const directionChanges = this.virtualDirectionChanges.length;

      // Enhanced logging to show entry and reversal levels
      await this.addLog(`Virtual tracking | Price: ${this._formatPrice(currentPrice)} | Direction: ${this.virtualPositionDirection} | Entry: ${this._formatPrice(this.virtualEntryLevel)} | Reversal: ${this._formatPrice(this.virtualReversalLevel)} | Volatility: ${stateStr} | Elapsed: ${elapsedStr} | Flips: ${directionChanges}`);
      this.lastVirtualStatusLogTime = now;
    }

    // ===== 4. Check if volatility has expanded =====
    if (this.volatilityExpanded) {
      // Volatility has expanded! Open position in current virtual direction
      const now = Date.now();
      const elapsedMs = now - this.volatilityWaitStartTime;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      const elapsedMin = Math.floor(elapsedSec / 60);
      const elapsedSecRemainder = elapsedSec % 60;
      const elapsedStr = `${elapsedMin}m ${elapsedSecRemainder}s`;
      const directionChanges = this.virtualDirectionChanges.length;

      await this.addLog(`Volatility expanded - opening ${this.virtualPositionDirection} position (waited ${elapsedStr}, ${directionChanges} direction changes)`);

      // Prepare to open position
      this.isTradingSequenceInProgress = true;

      try {
        const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);
        if (quantity > 0) {
          const orderSide = (this.virtualPositionDirection === 'LONG') ? 'BUY' : 'SELL';
          await this.placeMarketOrder(this.symbol, orderSide, quantity);
          await this._waitForPositionChange(this.virtualPositionDirection);

          this.currentPosition = this.virtualPositionDirection;
          this.reversalCount++; // Increment reversal count for scenario 2 (choppy -> expanded)

          // Update trade sequence with wait notation
          if (directionChanges === 0) {
            this.tradeSequence += `W(${this.virtualPositionDirection[0]}).O.`;
          } else if (directionChanges === 1) {
            const fromDir = this.virtualDirectionChanges[0].from[0];
            const toDir = this.virtualDirectionChanges[0].to[0];
            this.tradeSequence += `W(${fromDir}→${toDir}).O.`;
          } else {
            const firstDir = this.virtualDirectionChanges[0].from[0];
            const lastDir = this.virtualDirectionChanges[directionChanges - 1].to[0];
            this.tradeSequence += `W(${firstDir}→…→${lastDir}).O.`;
          }

          this.entryPositionQuantity = quantity;
          this.currentPositionQuantity = quantity;

          // Send position open notification after volatility expansion
          // Note: This may send as a "reversal" notification if a position was previously closed
          try {
            const userId = await this.getUserIdFromProfileId();
            if (userId && this.closedPositionType) {
              await sendReversalNotification(userId, {
                strategyId: this.strategyId,
                symbol: this.symbol,
                oldPosition: this.closedPositionType,
                newPosition: this.currentPosition,
                reversalCount: this.reversalCount,
                currentPrice: this.currentPrice || currentPrice,
              });
            }
          } catch (notifError) {
            console.error(`Error sending reversal notification: ${notifError.message}`);
            await this.addLog(`Warning: Failed to send reversal notification: ${notifError.message}`);
          }

          // Reset states for new position
          this.finalTpPrice = null;
          this.breakevenPrice = null;
          this.finalTpActive = false;
          this.finalTpOrderSent = false;
          this.breakevenPercentage = null;
          this.finalTpPercentage = null;
          await this._resetPartialTpState();

          // Switch activeMode based on new position type
          if (this.currentPosition === 'LONG') {
            this.activeMode = 'SUPPORT_ZONE';
          } else if (this.currentPosition === 'SHORT') {
            this.activeMode = 'RESISTANCE_ZONE';
          }

          // Calculate new entry level and reversal level based on new position
          this.entryLevel = this.positionEntryPrice;

          if (this.activeMode === 'SUPPORT_ZONE') {
            this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
            await this.addLog(`Dynamic Adjustment: New Entry Level: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Support Zone).`);
          } else if (this.activeMode === 'RESISTANCE_ZONE') {
            this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
            await this.addLog(`Dynamic Adjustment: New Entry Level: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Resistance Zone).`);
          }

          // Reset Move Reversal Level state for new position
          this.reversalLevelMoved = false;
          this.originalReversalLevel = null;

          // Calculate breakeven, final TP, and partial TP
          await this._calculateBreakevenAndFinalTp();
          await this._calculatePartialTpLevels();

          await this.addLog(`Position opened: ${this.currentPosition} at ${this._formatPrice(this.positionEntryPrice)} with ${this._formatQuantity(quantity)} contracts`);

          // Reset virtual tracking state
          this.virtualPositionActive = false;
          this.virtualPositionDirection = null;
          this.virtualOriginalDirection = null;
          this.volatilityWaitStartTime = null;
          this.lastVirtualDirectionChange = null;
          this.virtualDirectionChanges = [];
          this.virtualDirectionBuffer = null;
          this.virtualLongLimitOrder = null;
          this.virtualEntryLevel = null;
          this.virtualReversalLevel = null;
          this.closedPositionType = null;
          this.lastVirtualStatusLogTime = null;
          this.virtualLimitFirstTriggered = false;

          this.isTradingSequenceInProgress = false;
          await this.saveState();
        }
      } catch (error) {
        console.error(`Error opening position after virtual tracking: ${error.message}`);
        await this.addLog(`ERROR: [TRADING_ERROR] Opening position after virtual tracking: ${error.message}`);
        this.isTradingSequenceInProgress = false;
      }
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

    // Configure Recovery Factor from config (convert percentage to decimal)
    if (config.recoveryFactor !== undefined && config.recoveryFactor !== null) {
      this.RECOVERY_FACTOR = config.recoveryFactor / 100;
    }

    // Configure Trading Mode from config
    this.tradingMode = config.tradingMode || 'NORMAL';

    this.enableSupport = config.enableSupport !== undefined ? config.enableSupport : false;
    this.enableResistance = config.enableResistance !== undefined ? config.enableResistance : false;

    // Order Type and Direction config
    this.orderType = config.orderType || 'MARKET';
    this.buyLongEnabled = config.buyLongEnabled || false;
    this.sellShortEnabled = config.sellShortEnabled || false;
    this.buyLimitPrice = config.buyLimitPrice || null;
    this.sellLimitPrice = config.sellLimitPrice || null;

    // Partial TP configuration
    if (config.partialTpLevels && Array.isArray(config.partialTpLevels) && config.partialTpLevels.length === 3) {
      this.partialTpLevels = config.partialTpLevels;
    }
    if (config.partialTpSizes && Array.isArray(config.partialTpSizes) && config.partialTpSizes.length === 3) {
      this.partialTpSizes = config.partialTpSizes;
    }

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

    // Reset Partial TP states (preserve config but reset execution state)
    this.partialTpPrices = [null, null, null];
    this.partialTpExecuted = [false, false, false];
    this.currentEntryReference = null;

    // Reset accumulated PnL and fees for the new strategy run
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;
    this.sessionStartTradeId = null; // Reset for new session

    // Reset saved trade order IDs for the new strategy run
    this.savedTradeOrderIds.clear();

    // Reset summary section data
    this.reversalCount = 0;
    this.partialTpCount = 0;
    this.tradeSequence = '';
    this.profitPercentage = null;
    this.lastDynamicSizingReversalCount = -1;
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

    // Capture the latest trade ID at session start for accurate PnL verification
    // This ensures we only count trades that belong to this strategy session
    try {
      const latestTrades = await this.makeProxyRequest('/fapi/v1/userTrades', 'GET', {
        symbol: this.symbol,
        limit: 1
      }, true, 'futures');

      if (latestTrades && latestTrades.length > 0) {
        // Store the latest trade ID - all new trades will have IDs greater than this
        this.sessionStartTradeId = parseInt(latestTrades[0].id);
        await this.addLog(`[SESSION] Captured baseline trade ID: ${this.sessionStartTradeId}`);
      } else {
        await this.addLog(`[SESSION] No previous trades found for ${this.symbol}, starting fresh`);
        this.sessionStartTradeId = 0; // Start from 0 if no previous trades
      }
    } catch (error) {
      await this.addLog(`WARNING: Could not fetch baseline trade ID: ${error.message}`);
      this.sessionStartTradeId = null; // Will fall back to using all trades in verification
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
        userId: this.userId,
        profileId: this.profileId,
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
        sessionStartTradeId: this.sessionStartTradeId,
        isRunning: true,
        createdAt: new Date(),
        lastUpdated: new Date(),
        positionSizeUSDT: this.positionSizeUSDT,
        initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
        MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT,
        reversalLevelPercentage: this.reversalLevelPercentage,
        RECOVERY_FACTOR: this.RECOVERY_FACTOR,
        RECOVERY_DISTANCE: this.RECOVERY_DISTANCE,
        // Position quantity tracking
        entryPositionQuantity: this.entryPositionQuantity,
        currentPositionQuantity: this.currentPositionQuantity,
        // Final TP states
        breakevenPrice: this.breakevenPrice,
        finalTpPrice: this.finalTpPrice,
        finalTpActive: this.finalTpActive,
        finalTpOrderSent: this.finalTpOrderSent,
        breakevenPercentage: this.breakevenPercentage,
        finalTpPercentage: this.finalTpPercentage,
        // Partial TP states
        partialTpLevels: this.partialTpLevels,
        partialTpSizes: this.partialTpSizes,
        partialTpPrices: this.partialTpPrices,
        partialTpExecuted: this.partialTpExecuted,
        currentEntryReference: this.currentEntryReference,
        // Order Type and Direction states
        orderType: this.orderType,
        buyLongEnabled: this.buyLongEnabled,
        sellShortEnabled: this.sellShortEnabled,
        buyLimitPrice: this.buyLimitPrice,
        sellLimitPrice: this.sellLimitPrice,
        // Summary section data
        reversalCount: this.reversalCount,
        partialTpCount: this.partialTpCount,
        tradeSequence: this.tradeSequence,
        initialWalletBalance: this.initialWalletBalance,
        profitPercentage: this.profitPercentage,
        tradingMode: this.tradingMode,
        lastDynamicSizingReversalCount: this.lastDynamicSizingReversalCount,
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
        await this.addLog(`ERROR: [CONNECTION_ERROR] Setting up User Data Stream: ${error.message}`); // NEW LOG
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
        // ===== MARKET ORDER WITH VOLATILITY CHECK =====
        // Activate volatility measurement before placing MARKET order
        this.volatilityMeasurementActive = true;
        await this.addLog(`MARKET order mode: Checking volatility before entry`);

        // Check if volatility is expanded (or disabled)
        if (!this.volatilityEnabled || this.volatilityExpanded) {
          // Volatility is good - proceed with MARKET order
          await this.addLog(`Volatility check: ${this.volatilityEnabled ? 'EXPANDED' : 'DISABLED'} - placing MARKET order immediately`);

          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT);
          if (quantity > 0) {
            if (this.buyLongEnabled) {
              const initialEntryLevel = this.entryLevel;
              await this.placeMarketOrder(this.symbol, 'BUY', quantity);
              await this._waitForPositionChange('LONG');
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

            // Set strategy start time after position is filled (only if not already set)
            if (!this.strategyStartTime) {
              this.strategyStartTime = new Date();
              await this.addLog(`Strategy timer started after initial position filled.`);
            } else {
              await this.addLog(`Strategy timer preserved from original start time: ${this.strategyStartTime.toISOString()}.`);
            }

            // Update trade sequence with initial LONG entry marker
            this.tradeSequence += 'L.';

            // Calculate BE, final TP, and partial TP for initial position
            await this._calculateBreakevenAndFinalTp();
            await this._calculatePartialTpLevels();
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

            // Set strategy start time after position is filled (only if not already set)
            if (!this.strategyStartTime) {
              this.strategyStartTime = new Date();
              await this.addLog(`Strategy timer started after initial position filled.`);
            } else {
              await this.addLog(`Strategy timer preserved from original start time: ${this.strategyStartTime.toISOString()}.`);
            }

            // Update trade sequence with initial SHORT entry marker
            this.tradeSequence += 'S.';

              // Calculate BE, final TP, and partial TP for initial position
              await this._calculateBreakevenAndFinalTp();
              await this._calculatePartialTpLevels();
            }
          } else {
            throw new Error('Calculated quantity for initial MARKET order is zero or negative.');
          }
          this.isTradingSequenceInProgress = false;
        } else {
          // ===== VOLATILITY IS CHOPPY - Enter virtual tracking for MARKET order =====
          await this.addLog(`Volatility is CHOPPY - delaying MARKET order entry, entering virtual tracking mode`);

          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT);
          if (quantity > 0) {
            // Setup virtual tracking state
            this.virtualPositionActive = true;
            this.virtualPositionDirection = this.buyLongEnabled ? 'LONG' : 'SHORT';
            this.virtualOriginalDirection = this.virtualPositionDirection; // Track original direction for flip logic
            this.volatilityWaitStartTime = Date.now();
            this.lastVirtualStatusLogTime = Date.now();

            // Store the intended MARKET order details
            const currentPrice = await this._getCurrentPrice(this.symbol);
            this.virtualLongLimitOrder = {
              price: currentPrice,
              side: this.buyLongEnabled ? 'BUY' : 'SELL',
              quantity: quantity,
              timestamp: Date.now(),
              isMarketOrder: true // Flag to indicate this was originally a MARKET order
            };

            // Set entry/reversal levels for direction tracking
            this.entryLevel = currentPrice;
            if (this.reversalLevelPercentage !== null) {
              if (this.buyLongEnabled) {
                this.reversalLevel = this._calculateAdjustedPrice(currentPrice, this.reversalLevelPercentage, false);
                this.activeMode = 'SUPPORT_ZONE';
              } else {
                this.reversalLevel = this._calculateAdjustedPrice(currentPrice, this.reversalLevelPercentage, true);
                this.activeMode = 'RESISTANCE_ZONE';
              }
              this.virtualEntryLevel = this.entryLevel;
              this.virtualReversalLevel = this.reversalLevel;
            }

            await this.addLog(`Virtual tracking started: Direction=${this.virtualPositionDirection}, Entry=${this._formatPrice(this.entryLevel)}, Reversal=${this._formatPrice(this.reversalLevel)}`);
            await this.addLog(`Waiting for volatility expansion before opening ${this.virtualPositionDirection} position`);

            this.isTradingSequenceInProgress = false; // Allow price monitoring
          } else {
            throw new Error('Calculated quantity for initial MARKET order is zero or negative.');
          }
        }
      } else if (this.orderType === 'LIMIT') {
        // ===== VIRTUAL LIMIT ORDER MODE =====
        // Don't place actual orders on Binance - track virtually and wait for volatility
        await this.addLog(`LIMIT order mode: Setting up virtual limit tracking (no orders placed on exchange)`);

        // Set flag to prevent premature logging during dual-limit setup
        this.isInitializingVirtualLimits = true;

        let virtualLimitSetup = false;

        if (this.buyLongEnabled && this.buyLimitPrice !== null) {
          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT, this.buyLimitPrice);
          if (quantity > 0) {
            // Setup virtual LONG limit tracking
            this.virtualPositionActive = true;
            this.virtualPositionDirection = 'LONG'; // Initial direction, will be updated if dual limit
            this.virtualLongLimitOrder = {
              price: this.buyLimitPrice,
              side: 'BUY',
              quantity: quantity,
              timestamp: Date.now()
            };
            virtualLimitSetup = true;
            await this.addLog(`Virtual BUY LIMIT: ${this._formatQuantity(quantity)} at ${this._formatPrice(this.buyLimitPrice)} - waiting for price trigger`);
          } else {
            throw new Error('Calculated quantity for initial BUY LIMIT order is zero or negative.');
          }
        }

        // Check if SELL limit will be added (for dual-limit mode)
        const willAddSellLimit = this.sellShortEnabled && this.sellLimitPrice !== null;

        if (this.sellShortEnabled && this.sellLimitPrice !== null) {
          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.initialBasePositionSizeUSDT, this.sellLimitPrice);
          if (quantity > 0) {
            // If we already have a BUY limit, this becomes a dual limit setup
            if (virtualLimitSetup) {
              // Store SELL limit in a separate property for dual monitoring
              this.virtualShortLimitOrder = {
                price: this.sellLimitPrice,
                side: 'SELL',
                quantity: quantity,
                timestamp: Date.now()
              };
              // Set direction to null for dual-limit mode (will be determined by which triggers first)
              this.virtualPositionDirection = null;
              await this.addLog(`Virtual SELL LIMIT: ${this._formatQuantity(quantity)} at ${this._formatPrice(this.sellLimitPrice)} - waiting for price trigger`);
              await this.addLog(`Dual-limit mode: Direction will be determined by which limit triggers first`);

              // Clear initialization flag - dual-limit setup is complete
              this.isInitializingVirtualLimits = false;
            } else {
              // Setup virtual SHORT limit tracking only
              this.virtualPositionActive = true;
              this.virtualPositionDirection = 'SHORT';
              this.virtualLongLimitOrder = {
                price: this.sellLimitPrice,
                side: 'SELL',
                quantity: quantity,
                timestamp: Date.now()
              };
              virtualLimitSetup = true;
              await this.addLog(`Virtual SELL LIMIT: ${this._formatQuantity(quantity)} at ${this._formatPrice(this.sellLimitPrice)} - waiting for price trigger`);

              // Clear initialization flag - single limit setup is complete
              this.isInitializingVirtualLimits = false;
            }
          } else {
            throw new Error('Calculated quantity for initial SELL LIMIT order is zero or negative.');
          }
        }

        if (!virtualLimitSetup) {
          this.isTradingSequenceInProgress = false;
          throw new Error('No virtual limit order was configured. Strategy cannot start.');
        }

        // Ensure initialization flag is cleared (safety check for BUY-only or SELL-only cases)
        if (this.isInitializingVirtualLimits) {
          this.isInitializingVirtualLimits = false;
        }

        // Set initial entry/reversal levels for direction tracking
        const currentPrice = await this._getCurrentPrice(this.symbol);
        this.entryLevel = this.buyLongEnabled && this.buyLimitPrice ? this.buyLimitPrice : this.sellLimitPrice;

        if (this.reversalLevelPercentage !== null) {
          if (this.buyLongEnabled) {
            this.reversalLevel = this._calculateAdjustedPrice(this.entryLevel, this.reversalLevelPercentage, false);
          } else {
            this.reversalLevel = this._calculateAdjustedPrice(this.entryLevel, this.reversalLevelPercentage, true);
          }
          this.virtualEntryLevel = this.entryLevel;
          this.virtualReversalLevel = this.reversalLevel;
        }

        // Activate volatility measurement immediately for LIMIT orders
        this.volatilityMeasurementActive = true;
        this.volatilityWaitStartTime = Date.now();
        this.lastVirtualStatusLogTime = Date.now();

        // Detect if dual-limit mode is active
        const isDualLimitMode = this.buyLongEnabled && this.sellShortEnabled && this.buyLimitPrice !== null && this.sellLimitPrice !== null;
        const dualLimitSuffix = isDualLimitMode ? ' (Dual-limit mode)' : '';
        await this.addLog(`Volatility measurement ACTIVE - monitoring ${this.symbol} price for limit trigger + expansion${dualLimitSuffix}`);

        // Skip Entry/Reversal log for dual-limit mode (direction is undetermined)
        if (!isDualLimitMode) {
          await this.addLog(`Entry: ${this._formatPrice(this.entryLevel)}, Reversal: ${this._formatPrice(this.reversalLevel)}`);
        }

        this.isTradingSequenceInProgress = false; // Allow price monitoring
      }
      
    } catch (error) {
      console.error(`Failed to initialize strategy settings: ${error.message}`); 
      await this.addLog(`ERROR: [TRADING_ERROR] During strategy initialization: ${error.message}`);
      // Ensure isRunning is false if initialization fails
      this.isRunning = false;
      this.isTradingSequenceInProgress = false; // Reset flag on error
      throw error;
    }

    await this.addLog(`Strategy started:`);
    await this.addLog(`  Pair: ${this.symbol}`);
    await this.addLog(`  Initial Base Pos. Size: ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT`); // Log initial base
    await this.addLog(`  Allowable Exposure: ${this._formatNotional(this.MAX_POSITION_SIZE_USDT)} USDT`); // Log max exposure
    await this.addLog(`  Leverage: 50x`);
    await this.addLog(`  Pos. Mode: One-way`);
    await this.addLog(`  Reversal %: ${this.reversalLevelPercentage !== null ? `${this.reversalLevelPercentage}%` : 'N/A'}`);
    await this.addLog(`  Move Reversal Level: ${this.moveReversalLevel === 'MOVE_TO_BREAKEVEN' ? 'ACTIVE - Will move to breakeven after 0.5% favorable price movement' : 'Disabled'}`);
    await this.addLog(`  Recovery Factor: ${this.RECOVERY_FACTOR * 100}%`);
    await this.addLog(`  Trading Mode: ${this.tradingMode}`);
    const currentProfitPercentage = 1.55;
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

    // Start WebSocket health monitoring
    this._startWebSocketHealthMonitoring();
    await this.addLog('[Health Check] WebSocket health monitoring started (checks every 5 minutes).');

    return this.strategyId;
  }

  // New method to update strategy configuration
  async updateConfig(newConfig) {
    try {
      if (!this.isRunning) {
        await this.addLog('Cannot update config: Strategy is not running.');
        throw new Error('Strategy is not running.');
      }

      await this.addLog('===== UPDATING STRATEGY CONFIGURATION =====');

    // Update order type if provided
    if (newConfig.orderType !== undefined) {
      const oldOrderType = this.orderType;
      this.orderType = newConfig.orderType;
      await this.addLog(`Updated orderType from ${oldOrderType} to ${this.orderType}.`);
    }

    // Update support zone settings if provided
    if (newConfig.supportZoneEnabled !== undefined) {
      const oldValue = this.buyLongEnabled;
      this.buyLongEnabled = newConfig.supportZoneEnabled;
      this.enableSupport = newConfig.supportZoneEnabled;
      await this.addLog(`Updated supportZoneEnabled from ${oldValue} to ${this.buyLongEnabled}.`);
    }

    // Update resistance zone settings if provided
    if (newConfig.resistanceZoneEnabled !== undefined) {
      const oldValue = this.sellShortEnabled;
      this.sellShortEnabled = newConfig.resistanceZoneEnabled;
      this.enableResistance = newConfig.resistanceZoneEnabled;
      await this.addLog(`Updated resistanceZoneEnabled from ${oldValue} to ${this.sellShortEnabled}.`);
    }

    // Update buy limit price if provided
    if (newConfig.buyLimitPrice !== undefined && newConfig.buyLimitPrice !== null) {
      const oldPrice = this.buyLimitPrice;
      this.buyLimitPrice = newConfig.buyLimitPrice;
      await this.addLog(`Updated buyLimitPrice from ${oldPrice !== null ? '$' + this._formatPrice(oldPrice) : 'null'} to $${this._formatPrice(this.buyLimitPrice)}.`);
    }

    // Update sell limit price if provided
    if (newConfig.sellLimitPrice !== undefined && newConfig.sellLimitPrice !== null) {
      const oldPrice = this.sellLimitPrice;
      this.sellLimitPrice = newConfig.sellLimitPrice;
      await this.addLog(`Updated sellLimitPrice from ${oldPrice !== null ? '$' + this._formatPrice(oldPrice) : 'null'} to $${this._formatPrice(this.sellLimitPrice)}.`);
    }

    // Handle restart-specific position size (used only for first trade after restart, doesn't affect base)
    if (newConfig.restartPositionSizeUSDT !== undefined && newConfig.restartPositionSizeUSDT !== null) {
      this.restartPositionSizeUSDT = newConfig.restartPositionSizeUSDT;
      await this.addLog(`Restart position size set to ${this._formatNotional(this.restartPositionSizeUSDT)} USDT for next opening trade.`);
      await this.addLog(`Note: Base position size (${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT) remains unchanged for dynamic sizing.`);
    }

    // Update specific config parameters
    if (newConfig.initialBasePositionSizeUSDT !== undefined && newConfig.initialBasePositionSizeUSDT !== null) {
      const oldInitialBasePositionSizeUSDT = this.initialBasePositionSizeUSDT;
      this.initialBasePositionSizeUSDT = newConfig.initialBasePositionSizeUSDT;

      await this.addLog(`Updated initialBasePositionSizeUSDT from ${this._formatNotional(oldInitialBasePositionSizeUSDT)} to ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT.`);
    }

    // Handle direct max exposure setting (direct replacement)
    if (newConfig.newMaxExposureUSDT !== undefined && newConfig.newMaxExposureUSDT !== null) {
      // Validate the new exposure amount
      if (isNaN(newConfig.newMaxExposureUSDT) || newConfig.newMaxExposureUSDT <= 0) {
        await this.addLog('Cannot update config: New max exposure must be a positive number.');
        throw new Error('New max exposure (newMaxExposureUSDT) must be a positive number.');
      }

      const oldMaxPositionSize = this.MAX_POSITION_SIZE_USDT;
      this.MAX_POSITION_SIZE_USDT = newConfig.newMaxExposureUSDT;

      await this.addLog(`Allowable Exposure updated from ${this._formatNotional(oldMaxPositionSize)} USDT to ${this._formatNotional(this.MAX_POSITION_SIZE_USDT)} USDT.`);
    }

    // Update partial TP sizes if provided
    if (newConfig.partialTpSizes !== undefined && newConfig.partialTpSizes !== null) {
      const oldSizes = [...this.partialTpSizes];
      this.partialTpSizes = newConfig.partialTpSizes;
      await this.addLog(`Updated partial TP sizes from [${oldSizes.join(', ')}]% to [${this.partialTpSizes.join(', ')}]%.`);

      // Recalculate partial TP prices if there's an active position
      const hasPartialTpEnabled = this.partialTpSizes.some(size => size > 0);
      if (this.currentPosition !== 'NONE' && this.positionEntryPrice !== null && hasPartialTpEnabled) {
        await this._calculatePartialTpLevels();
        await this.addLog(`Recalculated partial TP prices based on new sizes.`);
      }
    }

    // Update partial TP levels if provided
    if (newConfig.partialTpLevels !== undefined && newConfig.partialTpLevels !== null) {
      const oldLevels = [...this.partialTpLevels];
      this.partialTpLevels = newConfig.partialTpLevels;
      await this.addLog(`Updated partial TP levels from [${oldLevels.join(', ')}]% to [${this.partialTpLevels.join(', ')}]%.`);

      // Recalculate partial TP prices if there's an active position
      const hasPartialTpLevelsEnabled = this.partialTpSizes.some(size => size > 0);
      if (this.currentPosition !== 'NONE' && this.positionEntryPrice !== null && hasPartialTpLevelsEnabled) {
        await this._calculatePartialTpLevels();
        await this.addLog(`Recalculated partial TP prices based on new levels.`);
      }
    }

    // Update custom final TP level for LONG positions
    if (newConfig.customFinalTpLong !== undefined) {
      if (newConfig.customFinalTpLong === null) {
        // Reset to auto-calculation for LONG
        this.customFinalTpLong = null;
        await this.addLog(`Custom LONG final TP cleared. Resetting to auto-calculation.`);

        // Recalculate final TP if currently in a LONG position
        if (this.currentPosition === 'LONG' && this.positionEntryPrice !== null) {
          await this._calculateBreakevenAndFinalTp();
          await this.addLog(`Final TP recalculated using auto-calculation for LONG position.`);
        }
      } else {
        // Validate the price target makes sense for LONG position
        if (this.currentPosition === 'LONG' && this.positionEntryPrice !== null) {
          if (newConfig.customFinalTpLong <= this.positionEntryPrice) {
            throw new Error(`For LONG position, final TP price must be greater than entry price ($${this._formatPrice(this.positionEntryPrice)}).`);
          }
        }

        this.customFinalTpLong = newConfig.customFinalTpLong;
        await this.addLog(`Updated custom LONG final TP price target to $${this._formatPrice(this.customFinalTpLong)}.`);

        // Recalculate final TP if currently in a LONG position
        if (this.currentPosition === 'LONG' && this.positionEntryPrice !== null) {
          await this._calculateBreakevenAndFinalTp();
          await this.addLog(`Recalculated final TP based on custom LONG price target.`);
        }
      }
    }

    // Update custom final TP level for SHORT positions
    if (newConfig.customFinalTpShort !== undefined) {
      if (newConfig.customFinalTpShort === null) {
        // Reset to auto-calculation for SHORT
        this.customFinalTpShort = null;
        await this.addLog(`Custom SHORT final TP cleared. Resetting to auto-calculation.`);

        // Recalculate final TP if currently in a SHORT position
        if (this.currentPosition === 'SHORT' && this.positionEntryPrice !== null) {
          await this._calculateBreakevenAndFinalTp();
          await this.addLog(`Final TP recalculated using auto-calculation for SHORT position.`);
        }
      } else {
        // Validate the price target makes sense for SHORT position
        if (this.currentPosition === 'SHORT' && this.positionEntryPrice !== null) {
          if (newConfig.customFinalTpShort >= this.positionEntryPrice) {
            throw new Error(`For SHORT position, final TP price must be less than entry price ($${this._formatPrice(this.positionEntryPrice)}).`);
          }
        }

        this.customFinalTpShort = newConfig.customFinalTpShort;
        await this.addLog(`Updated custom SHORT final TP price target to $${this._formatPrice(this.customFinalTpShort)}.`);

        // Recalculate final TP if currently in a SHORT position
        if (this.currentPosition === 'SHORT' && this.positionEntryPrice !== null) {
          await this._calculateBreakevenAndFinalTp();
          await this.addLog(`Recalculated final TP based on custom SHORT price target.`);
        }
      }
    }

    // Update TP at Breakeven setting if provided
    if (newConfig.tpAtBreakeven !== undefined) {
      const oldValue = this.tpAtBreakeven;
      this.tpAtBreakeven = newConfig.tpAtBreakeven;
      await this.addLog(`Updated TP at Breakeven from ${oldValue} to ${this.tpAtBreakeven}.`);

      // Recalculate final TP if there's an active position
      if (this.currentPosition !== 'NONE' && this.positionEntryPrice !== null) {
        await this._calculateBreakevenAndFinalTp();
        await this.addLog(`Recalculated final TP based on ${this.tpAtBreakeven ? 'breakeven mode' : 'standard calculation'}.`);
      }
    }

    // Update desired profit target if provided
    if (newConfig.desiredProfitUSDT !== undefined) {
      if (newConfig.desiredProfitUSDT === null) {
        const oldValue = this.desiredProfitUSDT;
        this.desiredProfitUSDT = null;
        await this.addLog(`Desired profit target cleared (was ${oldValue !== null ? this._formatNotional(oldValue) + ' USDT' : 'not set'}).`);
        // Recalculate Final TP if position is open (reverts to default percentage)
        if (this.currentPosition !== 'NONE') {
          await this._calculateBreakevenAndFinalTp();
          await this.addLog(`Final TP recalculated based on default percentage.`);
        }
      } else {
        if (isNaN(newConfig.desiredProfitUSDT) || newConfig.desiredProfitUSDT <= 0) {
          await this.addLog('Cannot update config: Desired profit must be a positive number.');
          throw new Error('Desired profit (desiredProfitUSDT) must be a positive number.');
        }
        const oldValue = this.desiredProfitUSDT;
        this.desiredProfitUSDT = newConfig.desiredProfitUSDT;
        await this.addLog(`Updated desired profit target from ${oldValue !== null ? this._formatNotional(oldValue) + ' USDT' : 'not set'} to ${this._formatNotional(this.desiredProfitUSDT)} USDT.`);
        // Recalculate Final TP if position is open (uses new desired profit target)
        if (this.currentPosition !== 'NONE') {
          await this._calculateBreakevenAndFinalTp();
          await this.addLog(`Final TP updated to achieve ${this._formatNotional(this.desiredProfitUSDT)} USDT profit target.`);
        }
      }
    }

    // Update Move Reversal Level setting if provided
    if (newConfig.moveReversalLevel !== undefined && newConfig.moveReversalLevel !== null) {
      const oldValue = this.moveReversalLevel;
      this.moveReversalLevel = newConfig.moveReversalLevel;
      await this.addLog(`Updated Move Reversal Level from ${oldValue} to ${this.moveReversalLevel}.`);

      // If changing from MOVE_TO_BREAKEVEN to DO_NOT_MOVE, reset the moved flag
      if (oldValue === 'MOVE_TO_BREAKEVEN' && newConfig.moveReversalLevel === 'DO_NOT_MOVE') {
        this.reversalLevelMoved = false;
        this.originalReversalLevel = null;
        await this.addLog(`Reset reversal level movement state - feature now disabled.`);
      }

      // Log the feature status
      if (this.moveReversalLevel === 'MOVE_TO_BREAKEVEN') {
        await this.addLog(`Move Reversal Level: ACTIVE - Will move to breakeven after 0.5% favorable price movement.`);
      } else {
        await this.addLog(`Move Reversal Level: Disabled - Reversal level will remain at original setting.`);
      }
    }

      await this.saveState(); // Persist the updated config
      await this.addLog('Strategy configuration updated and saved.');

      return { success: true, message: 'Configuration updated successfully' };
    } catch (error) {
      console.error('Error updating config:', error);
      await this.addLog(`ERROR: Failed to update configuration: ${error.message}`);
      throw error;
    }
  }

  // New method to execute initial orders after restart
  async executeInitialOrdersAfterRestart() {
    try {
      await this.addLog('===== EXECUTING INITIAL ORDERS AFTER RESTART =====');

      // Verify current position is NONE
      if (this.currentPosition !== 'NONE') {
        await this.addLog('WARNING: Cannot execute initial orders - position is not NONE. Current position will be maintained.');
        return { success: false, reason: 'Position already exists' };
      }

      // Verify strategy is running
      if (!this.isRunning) {
        await this.addLog('ERROR: Cannot execute initial orders - strategy is not running.');
        throw new Error('Strategy is not running.');
      }

      // Use restart-specific position size if provided, otherwise calculate dynamic position size
      if (this.restartPositionSizeUSDT !== null && this.restartPositionSizeUSDT > 0) {
        this.positionSizeUSDT = this.restartPositionSizeUSDT;
        await this.addLog(`Restart: Using restart position size: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
        await this.addLog(`Note: This is a one-time opening trade size. Base position size remains ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT.`);
        // Clear the restart position size after using it
        this.restartPositionSizeUSDT = null;
      } else {
        // Determine if dynamic sizing should be applied based on trading mode
        const shouldApplyDynamic = this._shouldApplyDynamicSizing();

        if (shouldApplyDynamic) {
          this.positionSizeUSDT = await this._calculateDynamicPositionSize();
          this.lastDynamicSizingReversalCount = this.reversalCount;
          await this.addLog(`Restart: Applying dynamic position sizing: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
        } else {
          await this.addLog(`Restart: Reusing position size: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
        }
      }

      // Reset partial TP states
      await this._resetPartialTpState();

      // Set flag to prevent overlapping trading sequences
      this.isTradingSequenceInProgress = true;

      // Execute orders based on order type
      if (this.orderType === 'MARKET') {
        await this.addLog(`Restart: Order Type is MARKET. Placing immediate market order.`);

        // Calculate quantity for market order
        const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);

        if (quantity <= 0) {
          throw new Error('Calculated quantity for restart MARKET order is zero or negative.');
        }

        // Double-check position is NONE before opening new MARKET position
        await this.addLog(`Restart: Verifying current position is NONE before opening new MARKET position...`);
        if (this.currentPosition !== 'NONE') {
          await this.addLog(`ERROR: Current position is ${this.currentPosition}, not NONE. Cannot proceed with MARKET restart.`);
          throw new Error(`Cannot execute MARKET restart: position is ${this.currentPosition}, expected NONE`);
        }
        await this.addLog(`Restart: Position verified as NONE. Proceeding with MARKET order.`);

        if (this.buyLongEnabled) {
          await this.addLog(`Restart: Placing BUY MARKET order for ${this._formatQuantity(quantity)} ${this.symbol}.`);
          await this.placeMarketOrder(this.symbol, 'BUY', quantity);
          await this._waitForPositionChange('LONG');
          this.activeMode = 'SUPPORT_ZONE';

          // Set entry position quantity
          this.entryPositionQuantity = this.currentPositionQuantity;

          // Update Entry Level with actual filled position entry price
          this.entryLevel = this.positionEntryPrice;

          // Calculate Reversal Level
          if (this.reversalLevelPercentage !== null) {
            this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
            await this.addLog(`Restart: Entry Level: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Support Zone).`);
          }

          await this.addLog(`Restart: ${this.currentPosition} position established. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);

          // Update trade sequence
          this.tradeSequence += 'L.';

          // Calculate BE, final TP, and partial TP
          await this._calculateBreakevenAndFinalTp();
          await this._calculatePartialTpLevels();

        } else if (this.sellShortEnabled) {
          await this.addLog(`Restart: Placing SELL MARKET order for ${this._formatQuantity(quantity)} ${this.symbol}.`);
          await this.placeMarketOrder(this.symbol, 'SELL', quantity);
          await this._waitForPositionChange('SHORT');
          this.activeMode = 'RESISTANCE_ZONE';

          // Set entry position quantity
          this.entryPositionQuantity = this.currentPositionQuantity;

          // Update Entry Level with actual filled position entry price
          this.entryLevel = this.positionEntryPrice;

          // Calculate Reversal Level
          if (this.reversalLevelPercentage !== null) {
            this.reversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
            await this.addLog(`Restart: Entry Level: ${this._formatPrice(this.entryLevel)}, Reversal Level: ${this._formatPrice(this.reversalLevel)} (Resistance Zone).`);
          }

          await this.addLog(`Restart: ${this.currentPosition} position established. Entry: ${this._formatPrice(this.positionEntryPrice)}, Size: ${this._formatNotional(this.positionSize)}, Qty: ${this._formatQuantity(this.entryPositionQuantity)}. Mode: ${this.activeMode}.`);

          // Update trade sequence
          this.tradeSequence += 'S.';

          // Calculate BE, final TP, and partial TP
          await this._calculateBreakevenAndFinalTp();
          await this._calculatePartialTpLevels();

        } else {
          throw new Error('No zone enabled for MARKET order. Enable support (BUY) or resistance (SELL) zone.');
        }

        this.isTradingSequenceInProgress = false;
        await this.saveState();
        await this.addLog(`Restart: MARKET order execution completed. Strategy is now active.`);
        return { success: true, orderType: 'MARKET', position: this.currentPosition };

      } else if (this.orderType === 'LIMIT') {
        // ===== VIRTUAL LIMIT ORDER MODE FOR RESTART =====
        await this.addLog(`Restart: Order Type is LIMIT. Setting up virtual limit tracking (no orders placed on exchange).`);

        // Set flag to prevent premature logging during dual-limit setup
        this.isInitializingVirtualLimits = true;

        let virtualLimitSetup = false;

        // Setup BUY virtual limit if enabled
        if (this.buyLongEnabled && this.buyLimitPrice !== null) {
          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT, this.buyLimitPrice);

          if (quantity > 0) {
            this.virtualPositionActive = true;
            this.virtualPositionDirection = 'LONG'; // Initial direction, will be updated if dual limit
            this.virtualLongLimitOrder = {
              price: this.buyLimitPrice,
              side: 'BUY',
              quantity: quantity,
              timestamp: Date.now()
            };
            virtualLimitSetup = true;
            await this.addLog(`Restart: Virtual BUY LIMIT: ${this._formatQuantity(quantity)} at ${this._formatPrice(this.buyLimitPrice)}`);
          } else {
            throw new Error('Calculated quantity for restart BUY LIMIT order is zero or negative.');
          }
        }

        // Setup SELL virtual limit if enabled
        if (this.sellShortEnabled && this.sellLimitPrice !== null) {
          const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT, this.sellLimitPrice);

          if (quantity > 0) {
            if (virtualLimitSetup) {
              // Dual limit setup
              this.virtualShortLimitOrder = {
                price: this.sellLimitPrice,
                side: 'SELL',
                quantity: quantity,
                timestamp: Date.now()
              };
              // Set direction to null for dual-limit mode (will be determined by which triggers first)
              this.virtualPositionDirection = null;
              await this.addLog(`Restart: Virtual SELL LIMIT: ${this._formatQuantity(quantity)} at ${this._formatPrice(this.sellLimitPrice)}`);
              await this.addLog(`Restart: Dual-limit mode - direction will be determined by which limit triggers first`);

              // Clear initialization flag - dual-limit setup is complete
              this.isInitializingVirtualLimits = false;
            } else {
              // Single SHORT limit
              this.virtualPositionActive = true;
              this.virtualPositionDirection = 'SHORT';
              this.virtualLongLimitOrder = {
                price: this.sellLimitPrice,
                side: 'SELL',
                quantity: quantity,
                timestamp: Date.now()
              };
              virtualLimitSetup = true;
              await this.addLog(`Restart: Virtual SELL LIMIT: ${this._formatQuantity(quantity)} at ${this._formatPrice(this.sellLimitPrice)}`);

              // Clear initialization flag - single limit setup is complete
              this.isInitializingVirtualLimits = false;
            }
          } else {
            throw new Error('Calculated quantity for restart SELL LIMIT order is zero or negative.');
          }
        }

        if (!virtualLimitSetup) {
          this.isTradingSequenceInProgress = false;
          throw new Error('No virtual limit order was configured after restart.');
        }

        // Ensure initialization flag is cleared (safety check for BUY-only or SELL-only cases)
        if (this.isInitializingVirtualLimits) {
          this.isInitializingVirtualLimits = false;
        }

        // Set entry/reversal levels for direction tracking
        this.entryLevel = this.buyLongEnabled && this.buyLimitPrice ? this.buyLimitPrice : this.sellLimitPrice;

        if (this.reversalLevelPercentage !== null) {
          if (this.buyLongEnabled) {
            this.reversalLevel = this._calculateAdjustedPrice(this.entryLevel, this.reversalLevelPercentage, false);
          } else {
            this.reversalLevel = this._calculateAdjustedPrice(this.entryLevel, this.reversalLevelPercentage, true);
          }
          this.virtualEntryLevel = this.entryLevel;
          this.virtualReversalLevel = this.reversalLevel;
        }

        // Activate volatility measurement
        this.volatilityMeasurementActive = true;
        this.volatilityWaitStartTime = Date.now();
        this.lastVirtualStatusLogTime = Date.now();

        // Detect if dual-limit mode is active
        const isDualLimitMode = this.buyLongEnabled && this.sellShortEnabled && this.buyLimitPrice !== null && this.sellLimitPrice !== null;

        // Skip Entry/Reversal log for dual-limit mode (direction is undetermined)
        if (!isDualLimitMode) {
          await this.addLog(`Restart: Virtual limit tracking active - Entry: ${this._formatPrice(this.entryLevel)}, Reversal: ${this._formatPrice(this.reversalLevel)}`);
        }

        const dualLimitSuffix = isDualLimitMode ? ' (Dual-limit mode)' : '';
        await this.addLog(`Restart: Waiting for price trigger + volatility expansion${dualLimitSuffix}`);

        this.isTradingSequenceInProgress = false; // Allow price monitoring
        await this.saveState();

        const placedOrders = [];
        if (this.virtualLongLimitOrder && this.virtualLongLimitOrder.side === 'BUY') placedOrders.push(`BUY at ${this._formatPrice(this.buyLimitPrice)}`);
        if (this.virtualLongLimitOrder && this.virtualLongLimitOrder.side === 'SELL') placedOrders.push(`SELL at ${this._formatPrice(this.sellLimitPrice)}`);
        if (this.virtualShortLimitOrder) placedOrders.push(`SELL at ${this._formatPrice(this.sellLimitPrice)}`);

        return {
          success: true,
          orderType: 'LIMIT',
          virtualLimitSetup: true,
          buyLimitPrice: this.buyLimitPrice,
          sellLimitPrice: this.sellLimitPrice
        };

      } else {
        throw new Error(`Unknown order type: ${this.orderType}`);
      }

    } catch (error) {
      console.error(`Failed to execute initial orders after restart: ${error.message}`);
      await this.addLog(`ERROR: [TRADING_ERROR] During restart order execution: ${error.message}`);
      this.isTradingSequenceInProgress = false;
      throw error;
    }
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

    // Stop WebSocket health monitoring
    this._stopWebSocketHealthMonitoring();

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

    // Clean up virtual tracking state if active
    if (this.virtualPositionActive) {
      await this.addLog(`Strategy stopped during virtual tracking - no position opened`);
      this.virtualPositionActive = false;
      this.virtualPositionDirection = null;
      this.virtualOriginalDirection = null;
      this.volatilityWaitStartTime = null;
      this.lastVirtualDirectionChange = null;
      this.virtualDirectionChanges = [];
      this.virtualLongLimitOrder = null;
      this.virtualDirectionBuffer = null;
      this.lastVirtualStatusLogTime = null;
      this.virtualEntryLevel = null;
      this.virtualReversalLevel = null;
      this.closedPositionType = null;
      this.virtualLimitFirstTriggered = false;
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
        await this.addLog(`ERROR: [TRADING_ERROR] Failed to close position or confirm closure: ${err.message}`);
        // Even if closing fails, we should still attempt to reset state and save
        // The frontend should then show the strategy as stopped, but with a warning about the position.
      }
    }

    // Calculate profit percentage and platform fee if there was trading activity
    if (this.accumulatedRealizedPnL !== 0 || this.accumulatedTradingFees !== 0 || this.tradeSequence !== '') {
      try {
        // Calculate profit percentage as: Total PnL / Initial Capital * 100
        if (this.initialBasePositionSizeUSDT !== null && this.initialBasePositionSizeUSDT > 0) {
          const totalPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;
          this.profitPercentage = (totalPnL / this.initialBasePositionSizeUSDT) * 100;
          await this.addLog(`Profit Percentage: ${precisionFormatter.formatPercentage(this.profitPercentage)}%.`);

          // Deduct platform fee from reload balance if strategy was profitable
          if (totalPnL > 0) {
            await this.deductPlatformFee(totalPnL);
          } else {
            await this.addLog('No profit made. Skipping platform fee deduction.');
          }
        } else {
          this.profitPercentage = null;
          await this.addLog(`Could not calculate profit percentage. Initial base position size: ${this.initialBasePositionSizeUSDT}`);
        }
      } catch (error) {
        console.error(`Failed to calculate profit percentage: ${error.message}`);
        await this.addLog(`Failed to calculate profit percentage: ${error.message}`);
        this.profitPercentage = null;
      }
    } else {
      await this.addLog('No trading activity detected. Skipping profit calculation.');
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
    this.sessionStartTradeId = null; 

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
    this.partialTpCount = 0;
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

      // Extract userId from the user document reference
      const userId = userDocRef.id;

      // Calculate platform fee
      const platformFee = profitAmount * (PLATFORM_FEE_PERCENTAGE / 100);
      await this.addLog(`Platform Fee Calculation: Profit=${precisionFormatter.formatNotional(profitAmount)} USDT, Fee Rate=${PLATFORM_FEE_PERCENTAGE}%, Fee Amount=${precisionFormatter.formatNotional(platformFee)} USDT`);

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
        await this.addLog(`Warning: Platform fee deduction would result in negative balance. Current: ${precisionFormatter.formatNotional(currentBalance)}, Fee: ${precisionFormatter.formatNotional(platformFee)}, Skipping deduction.`);
        return;
      }

      // Deduct the fee from the reload balance
      await walletRef.update({
        balance: newBalance,
        updatedAt: new Date(),
      });

      await this.addLog(`Platform fee deducted successfully: ${precisionFormatter.formatNotional(platformFee)} USDT. New reload balance: ${precisionFormatter.formatNotional(newBalance)} USDT (was ${precisionFormatter.formatNotional(currentBalance)} USDT)`);

      // Record the fee transaction in reload balance history
      await this.firestore.collection('reload_balance_history').add({
        userId: userId,
        profileId: this.profileId,
        strategyId: this.strategyId,
        timestamp: new Date(),
        balance: newBalance,
        type: 'platform_fee',
        amount: -platformFee,
        description: `Platform fee (${PLATFORM_FEE_PERCENTAGE}%) deducted from profit`,
        metadata: {
          totalPnL: profitAmount,
          feePercentage: PLATFORM_FEE_PERCENTAGE,
        },
      });

    } catch (error) {
      console.error(`Error deducting platform fee: ${error.message}`);
      await this.addLog(`ERROR: [TRADING_ERROR] Deducting platform fee: ${error.message}`);
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
      await this.addLog(`ERROR: [CONNECTION_ERROR] Sending push notification: ${error.message}`);
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
      // Partial TP Configuration
      partialTpLevels: this.partialTpLevels,
      partialTpSizes: this.partialTpSizes,
      tpAtBreakeven: this.tpAtBreakeven,
      customFinalTpLong: this.customFinalTpLong,
      customFinalTpShort: this.customFinalTpShort,
      desiredProfitUSDT: this.desiredProfitUSDT,
      moveReversalLevel: this.moveReversalLevel,
      reversalLevelMoved: this.reversalLevelMoved,
      // Summary fields
      entryLevel: this.entryLevel,
      reversalLevel: this.reversalLevel,
      reversalCount: this.reversalCount,
      partialTpCount: this.partialTpCount,
      breakevenPrice: this.breakevenPrice,
      finalTpPrice: this.finalTpPrice,
      initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
      MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT,
      profitPercentage: this.profitPercentage,
      strategyStartTime: this.strategyStartTime,
      strategyEndTime: this.strategyEndTime,
      tradeSequence: this.tradeSequence,
      breakevenPercentage: this.breakevenPercentage,
      finalTpPercentage: this.finalTpPercentage,
      realtimeWsConnected: this.realtimeWsConnected,
      userDataWsConnected: this.userDataWsConnected,
      // Exchange precision info
      tickSize: this.exchangeInfoCache[this.symbol]?.tickSize ?? null,
      stepSize: this.exchangeInfoCache[this.symbol]?.stepSize ?? null,
      minNotional: this.exchangeInfoCache[this.symbol]?.minNotional ?? null,
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
        sessionStartTradeId: this.sessionStartTradeId,
        currentPositionQuantity: this.currentPositionQuantity,
      }
    };
  }

  async cancelAllOrders() {
    try {
      await this.addLog('===== CANCELLING ALL PENDING ORDERS =====');

      const openOrders = await this.getAllOpenOrders(this.symbol);

      if (openOrders.length === 0) {
        await this.addLog('No pending orders to cancel.');
        return 0;
      }

      let cancelledCount = 0;

      for (const order of openOrders) {
        try {
          await this.cancelOrder(this.symbol, order.orderId);
          await this.addLog(`Cancelled order ${order.orderId}: ${order.side} ${order.type} ${order.origQty}`);
          cancelledCount++;
        } catch (err) {
          await this.addLog(`Warning: Failed to cancel order ${order.orderId}: ${err.message}`);
        }
      }

      await this.addLog(`Cancelled ${cancelledCount} out of ${openOrders.length} orders.`);
      return cancelledCount;
    } catch (error) {
      console.error('Error cancelling orders for restart:', error);
      await this.addLog(`ERROR: Failed to cancel orders: ${error.message}`);
      throw error;
    }
  }


  getAccumulatedMetrics() {
    return {
      accumulatedRealizedPnL: this.accumulatedRealizedPnL,
      accumulatedTradingFees: this.accumulatedTradingFees,
      strategyStartTime: this.strategyStartTime,
    };
  }
}

export default TradingStrategy;
