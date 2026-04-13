import { Firestore, Timestamp } from '@google-cloud/firestore';
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

// Entry price update constants
const ENTRY_PRICE_UPDATE_MAX_RETRIES = 6; // Max retry attempts to get updated entry price
const ENTRY_PRICE_UPDATE_INITIAL_DELAY_MS = 200; // Initial delay: 200ms
const ENTRY_PRICE_UPDATE_MAX_DELAY_MS = 3200; // Max delay: 3200ms

// Desired profit percentage
const DESIRED_PROFIT_PERCENTAGE = 1.55; // Fixed profit target: 1.55%

// Leverage
const DEFAULT_LEVERAGE = 50;

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
    this.strategyFlowCollectionRef = null; // Firestore collection for strategy flow events
    this.realtimeWs = null;
    this.userDataWs = null; // WebSocket for User Data Stream
    this.listenKey = null; // Binance listenKey for User Data Stream
    this.listenKeyRefreshInterval = null; // Interval for refreshing listenKey
    this.strategyId = null; // Will be set uniquely in start() or loadState()
    this.isRunning = false;
    this.isStopping = false; // Add isStopping flag
    this.willBeDeleted = false; // Flag to indicate strategy will be deleted (prevents log writes)
    this.gcfProxyUrl = gcfProxyUrl; // This is the profile-specific binance-proxy GCF URL
    this.profileId = profileId; // Store the profileId for authentication and logging
    this.sharedVmProxyGcfUrl = sharedVmProxyGcfUrl; // Store the shared VM proxy GCF URL
    
    // Dynamic threshold trading strategy state variables
    this.entryLevel = null;
    this.reversalLevel = null;
    this.initialReversalLevel = null; // Stores the original reversal level calculated at position open (never trails)
    this.anchorMode = 'IMMEDIATE'; // 'IMMEDIATE' | 'TARGET_PRICE'
    this.targetAnchorPrice = null; // number | null — only used in TARGET_PRICE mode
    this.waitingForAnchor = false; // true while strategy is running but anchor not yet captured
    this.currentPosition = 'NONE'; // 'LONG' | 'SHORT' | 'NONE'
    this.positionEntryPrice = null;
    this.positionSize = null; // in notional USDT

    // Real-time price and PnL for status checks
    this.currentPrice = null;
    this.positionPnL = null; // Combined position PnL (LONG + SHORT)
    this.totalPnL = null;

    // PnL breakdown variables (overall accumulated)
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;

    // Per-side PnL tracking (hedge mode)
    this.longPositionPnL = 0;
    this.shortPositionPnL = 0;
    this.longAccumulatedRealizedPnL = 0;
    this.shortAccumulatedRealizedPnL = 0;
    this.longTradingFees = 0;
    this.shortTradingFees = 0;
    // Internal per-side position data for PnL calculation
    this._longEntryPrice = null;
    this._longPositionSize = null;
    this._shortEntryPrice = null;
    this._shortPositionSize = null;

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

    // Custom Final TP Levels - Position Specific
    this.customFinalTpLong = null; // If set, overrides DESIRED_PROFIT_PERCENTAGE for LONG positions
    this.customFinalTpShort = null; // If set, overrides DESIRED_PROFIT_PERCENTAGE for SHORT positions
    this.tpAtBreakeven = false; // If true, sets Final TP to breakeven level, overriding all other calculations

    // Desired Profit Target in USDT
    this.desiredProfitUSDT = null; // If set, strategy stops when total PnL reaches this amount

    // Reversal level percentage
    this.reversalLevelPercentage = null; // Initialize to null, will be set from config

    // OOG reversal levels (calculated from outermost grid levels S5/L5)
    this.oogLongReversalLevel  = null; // Above S5 — triggers LONG consolidated when price goes UP past it
    this.oogShortReversalLevel = null; // Below L5 — triggers SHORT consolidated when price goes DOWN past it
    this.fixedReversalLevelsCalculated = false; // Flag to track if fixed levels have been set

    // Grid trading state variables
    this.gridSize = 0.003; // Grid step size as decimal (e.g., 0.003 = 0.3%)
    this.gridLevelsPerSide = 5; // Number of grid levels on each side of anchor (1–20)
    this.anchorPrice = null; // Price recorded at strategy start; centre of the grid
    this.gridMode = 'WITHIN'; // 'WITHIN' | 'OUT_OF_GRID'
    this.gridBaseSize = null; // Current base size used for grid level sizing (recalculated after OOG reset)
    this.gridLevels = []; // 2*gridLevelsPerSide objects: {levelIndex, direction, price, state, positionSize}
    this.lastProcessedPrice = null; // Previous tick price — used for crossing detection
    // Same-territory TP VWAP state (locked on first TP, recalculated on new open, cleared when all closed)
    this.sameTerritoryVwapShort = null;
    this.sameTerritoryVwapLong = null;

    // Out-of-grid state
    this.outOfGridDirection = null; // 'LONG' | 'SHORT' — direction of consolidated OOG position
    this.outOfGridConsolidatedSize = null; // Total size (USDT) of the OOG consolidated position
    this.outOfGridConsolidatedQuantity = null; // Total quantity (base asset) of the OOG consolidated position
    this.outOfGridTranchesRemaining = 0; // gridLevelsPerSide → 0 as tranches are TP'd
    this.outOfGridTrancheTakenFlags = new Array(this.gridLevelsPerSide).fill(false); // Which tranches have been executed
    this.outOfGridPhase = null; // 'INITIAL' (at reversal level) | 'REENTRY' (crossed back to Level 5)

    this.priceType = 'MARK'; // 'LAST' | 'MARK' - WebSocket price stream type

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
    this.RECOVERY_FACTOR = 0.20; // Percentage of accumulated loss to target for recovery in next trade's TP (default: 20%)
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
    // NEW: Set to track saved trade order IDs to prevent duplicates
    this.savedTradeOrderIds = new Set();

    // Flag for pending log message after position update
    this._pendingLogMessage = null;

    // Summary section data
    this.reversalCount = 0;
    this.tradeSequence = '';
    this.initialWalletBalance = null;
    this.tradingMode = 'NORMAL'; // Trading mode: AGGRESSIVE, NORMAL, or CONSERVATIVE
    this.lastDynamicSizingReversalCount = 0;
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

    // Save log to Firestore (skip if strategy will be deleted)
    if (this.strategyId && !this.willBeDeleted && !messagesToFilter.some(filterMsg => message.includes(filterMsg))) {
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

  // Helper to delete all documents in a subcollection using batch operations
  async deleteSubcollection(collectionRef, subcollectionName) {
    try {
      const batchSize = 500; // Firestore batch limit
      const snapshot = await collectionRef.limit(batchSize).get();

      if (snapshot.empty) {
        console.log(`[${this.strategyId}] Subcollection ${subcollectionName} is empty or does not exist`);
        return;
      }

      const batch = this.firestore.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`[${this.strategyId}] Deleted ${snapshot.size} documents from ${subcollectionName} subcollection`);

      // Recursively delete remaining documents if there are more
      if (snapshot.size === batchSize) {
        await this.deleteSubcollection(collectionRef, subcollectionName);
      }
    } catch (error) {
      console.error(`[${this.strategyId}] Failed to delete ${subcollectionName} subcollection: ${error.message}`);
      throw error;
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

  _calculateTicksBetween(price1, price2) {
    const tickSize = this.exchangeInfoCache[this.symbol]?.tickSize || 0.01;
    const priceDiff = Math.abs(price2 - price1);
    return Math.floor(priceDiff / tickSize);
  }

  _adjustPriceByTicks(basePrice, ticks, increase) {
    const tickSize = this.exchangeInfoCache[this.symbol]?.tickSize || 0.01;
    const adjustment = ticks * tickSize;
    if (increase) {
      return this.roundPrice(basePrice + adjustment);
    } else {
      return this.roundPrice(basePrice - adjustment);
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
        initialReversalLevel: this.initialReversalLevel,
        oogLongReversalLevel: this.oogLongReversalLevel,
        oogShortReversalLevel: this.oogShortReversalLevel,
        fixedReversalLevelsCalculated: this.fixedReversalLevelsCalculated,
        anchorMode: this.anchorMode,
        targetAnchorPrice: this.targetAnchorPrice,
        waitingForAnchor: this.waitingForAnchor,
        currentPosition: this.currentPosition,
        positionEntryPrice: this.positionEntryPrice,
        positionSize: this.positionSize,
        currentPrice: this.currentPrice,
        positionPnL: this.positionPnL,
        totalPnL: this.totalPnL,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        longPositionPnL: this.longPositionPnL,
        shortPositionPnL: this.shortPositionPnL,
        longAccumulatedRealizedPnL: this.longAccumulatedRealizedPnL,
        shortAccumulatedRealizedPnL: this.shortAccumulatedRealizedPnL,
        longTradingFees: this.longTradingFees,
        shortTradingFees: this.shortTradingFees,
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
        // Custom Final TP Levels - Position Specific
        customFinalTpLong: this.customFinalTpLong,
        customFinalTpShort: this.customFinalTpShort,
        tpAtBreakeven: this.tpAtBreakeven,
        desiredProfitUSDT: this.desiredProfitUSDT,
        priceType: this.priceType,
        // Summary section data
        reversalCount: this.reversalCount,
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
        // Grid trading state
        gridSize: this.gridSize,
        gridLevelsPerSide: this.gridLevelsPerSide,
        anchorPrice: this.anchorPrice,
        gridMode: this.gridMode,
        gridBaseSize: this.gridBaseSize,
        gridLevels: this.gridLevels,
        // Out-of-grid state
        outOfGridDirection: this.outOfGridDirection,
        outOfGridConsolidatedSize: this.outOfGridConsolidatedSize,
        outOfGridConsolidatedQuantity: this.outOfGridConsolidatedQuantity,
        outOfGridTranchesRemaining: this.outOfGridTranchesRemaining,
        outOfGridTrancheTakenFlags: this.outOfGridTrancheTakenFlags,
        outOfGridPhase: this.outOfGridPhase,
        sameTerritoryVwapShort: this.sameTerritoryVwapShort,
        sameTerritoryVwapLong: this.sameTerritoryVwapLong,
      };

      // Filter out undefined values and validate numeric fields to prevent Firestore errors
      const dataToSave = {};
      const numericFields = [
        'entryLevel', 'reversalLevel', 'initialReversalLevel', 'oogLongReversalLevel', 'oogShortReversalLevel', 'positionEntryPrice', 'positionSize',
        'currentPrice', 'positionPnL', 'totalPnL', 'accumulatedRealizedPnL',
        'accumulatedTradingFees', 'longAccumulatedRealizedPnL', 'shortAccumulatedRealizedPnL',
        'longTradingFees', 'shortTradingFees', 'positionSizeUSDT', 'initialBasePositionSizeUSDT',
        'MAX_POSITION_SIZE_USDT', 'reversalLevelPercentage',
        'entryPositionQuantity', 'currentPositionQuantity', 'lastPositionQuantity', 'lastPositionEntryPrice',
        'breakevenPrice', 'finalTpPrice', 'breakevenPercentage', 'finalTpPercentage',
        'targetAnchorPrice', 'initialWalletBalance', 'profitPercentage',
        'maxAllowableLoss', 'customFinalTpLong', 'customFinalTpShort', 'desiredProfitUSDT',
        'gridSize', 'gridLevelsPerSide', 'anchorPrice', 'gridBaseSize', 'outOfGridConsolidatedSize', 'outOfGridConsolidatedQuantity',
        'sameTerritoryVwapShort', 'sameTerritoryVwapLong'
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

  async saveStrategyFlowEvent(tradeType, side, entryPrice, currentQty, breakevenLevel, breakevenPercentage, takeProfitLevel, takeProfitPercentage) {
    // Validate strategyId and collection reference
    if (!this.strategyId) {
      console.error('Cannot save strategy flow event: strategyId is not set');
      return;
    }

    if (!this.strategyFlowCollectionRef) {
      console.error('Cannot save strategy flow event: strategyFlowCollectionRef is not initialized');
      await this.addLog(`ERROR: Strategy flow collection reference not initialized`);
      return;
    }

    // Validate critical parameters
    if (entryPrice === null || entryPrice === undefined || currentQty === null || currentQty === undefined) {
      console.error(`Cannot save strategy flow event: Invalid parameters - entryPrice: ${entryPrice}, currentQty: ${currentQty}`);
      await this.addLog(`ERROR: Cannot save strategy flow - missing entry price or quantity`);
      return;
    }

    try {
      const flowEventData = {
        timestamp: Timestamp.now(),
        tradeType: tradeType,
        side: side,
        entryPrice: entryPrice,
        currentQty: currentQty,
        breakevenLevel: breakevenLevel,
        breakevenPercentage: breakevenPercentage,
        takeProfitLevel: takeProfitLevel,
        takeProfitPercentage: takeProfitPercentage
      };

      // Log the data being saved for debugging
      console.log(`[STRATEGY_FLOW] Saving flow event: ${tradeType} (${side}) - Entry: ${entryPrice}, Qty: ${currentQty}, BE: ${breakevenLevel}, TP: ${takeProfitLevel}`);

      await this.strategyFlowCollectionRef.add(flowEventData);

      //await this.addLog(`Strategy flow event saved: ${tradeType} (${side}) - Entry: ${this._formatPrice(entryPrice)}, Qty: ${this._formatQuantity(currentQty)}`);
    } catch (error) {
      console.error('Failed to save strategy flow event to Firestore:', error);
      await this.addLog(`ERROR: [CONNECTION_ERROR] Failed to save strategy flow event: ${error.message}`);
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
        this.initialReversalLevel = this._validateNumericValue(data.initialReversalLevel, 'initialReversalLevel', null);
        this.oogLongReversalLevel  = this._validateNumericValue(data.oogLongReversalLevel  ?? data.shortReversalLevel, 'oogLongReversalLevel',  null);
        this.oogShortReversalLevel = this._validateNumericValue(data.oogShortReversalLevel ?? data.longReversalLevel,  'oogShortReversalLevel', null);
        this.fixedReversalLevelsCalculated = data.fixedReversalLevelsCalculated !== undefined ? data.fixedReversalLevelsCalculated : false;
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
        this.longAccumulatedRealizedPnL = this._validateNumericValue(data.longAccumulatedRealizedPnL, 'longAccumulatedRealizedPnL', 0);
        this.shortAccumulatedRealizedPnL = this._validateNumericValue(data.shortAccumulatedRealizedPnL, 'shortAccumulatedRealizedPnL', 0);
        this.longTradingFees = this._validateNumericValue(data.longTradingFees, 'longTradingFees', 0);
        this.shortTradingFees = this._validateNumericValue(data.shortTradingFees, 'shortTradingFees', 0);
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

        // Load Recovery Factor and Recovery Distance
        this.RECOVERY_FACTOR = this._validateNumericValue(data.RECOVERY_FACTOR, 'RECOVERY_FACTOR', 0.20);
        this.RECOVERY_DISTANCE = this._validateNumericValue(data.RECOVERY_DISTANCE, 'RECOVERY_DISTANCE', 0.005);

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

        // Load Custom Final TP Levels - Position Specific
        this.customFinalTpLong = this._validateNumericValue(data.customFinalTpLong, 'customFinalTpLong', null);
        this.customFinalTpShort = this._validateNumericValue(data.customFinalTpShort, 'customFinalTpShort', null);
        this.tpAtBreakeven = data.tpAtBreakeven || false;
        this.desiredProfitUSDT = this._validateNumericValue(data.desiredProfitUSDT, 'desiredProfitUSDT', null);

        // Load Anchor Mode states
        this.anchorMode = (data.anchorMode === 'IMMEDIATE' || data.anchorMode === 'TARGET_PRICE') ? data.anchorMode : 'IMMEDIATE';
        this.targetAnchorPrice = this._validateNumericValue(data.targetAnchorPrice, 'targetAnchorPrice', null);
        this.waitingForAnchor = data.waitingForAnchor || false;
        this.priceType = data.priceType || 'MARK';

        // Load Summary section data
        this.reversalCount = data.reversalCount || 0;
        this.tradeSequence = data.tradeSequence || '';
        this.initialWalletBalance = this._validateNumericValue(data.initialWalletBalance, 'initialWalletBalance', null);
        this.profitPercentage = this._validateNumericValue(data.profitPercentage, 'profitPercentage', null);
        this.tradingMode = data.tradingMode || 'NORMAL';
        this.lastDynamicSizingReversalCount = data.lastDynamicSizingReversalCount ?? 0;
        this.strategyStartTime = data.strategyStartTime ? data.strategyStartTime.toDate() : null;
        this.strategyEndTime = data.strategyEndTime ? data.strategyEndTime.toDate() : null;

        // Load Capital Protection fields
        this.capitalProtectionTriggered = data.capitalProtectionTriggered || false;
        this.capitalProtectionWarning = data.capitalProtectionWarning || false;
        this.maxAllowableLoss = this._validateNumericValue(data.maxAllowableLoss, 'maxAllowableLoss', null);
        this.circuitBreakerTimestamp = data.circuitBreakerTimestamp ? data.circuitBreakerTimestamp.toDate() : null;

        // Load Grid trading state
        this.gridSize = this._validateNumericValue(data.gridSize, 'gridSize', 0.003);
        this.gridLevelsPerSide = (Number.isInteger(data.gridLevelsPerSide) && data.gridLevelsPerSide >= 1)
          ? data.gridLevelsPerSide : 5;
        this.anchorPrice = this._validateNumericValue(data.anchorPrice, 'anchorPrice', null);
        this.gridMode = data.gridMode || 'WITHIN';
        this.gridBaseSize = this._validateNumericValue(data.gridBaseSize, 'gridBaseSize', null);
        this.gridLevels = Array.isArray(data.gridLevels) ? data.gridLevels : [];
        // Load out-of-grid state
        this.outOfGridDirection = data.outOfGridDirection || null;
        this.outOfGridConsolidatedSize = this._validateNumericValue(data.outOfGridConsolidatedSize, 'outOfGridConsolidatedSize', null);
        this.outOfGridConsolidatedQuantity = this._validateNumericValue(data.outOfGridConsolidatedQuantity, 'outOfGridConsolidatedQuantity', null);
        this.outOfGridTranchesRemaining = typeof data.outOfGridTranchesRemaining === 'number' ? data.outOfGridTranchesRemaining : 0;
        this.outOfGridTrancheTakenFlags = Array.isArray(data.outOfGridTrancheTakenFlags) ? data.outOfGridTrancheTakenFlags : new Array(this.gridLevelsPerSide).fill(false);
        this.outOfGridPhase = data.outOfGridPhase || null;
        this.sameTerritoryVwapShort = this._validateNumericValue(data.sameTerritoryVwapShort, 'sameTerritoryVwapShort', null);
        this.sameTerritoryVwapLong = this._validateNumericValue(data.sameTerritoryVwapLong, 'sameTerritoryVwapLong', null);
        // Backward-compat: ensure tpedInCurrentSequence exists on all loaded levels
        this.gridLevels.forEach(l => { if (l.tpedInCurrentSequence === undefined) l.tpedInCurrentSequence = false; });

        await this._getExchangeInfo(this.symbol); // Use the new method to fetch and cache exchange info

        this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
        this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs');
        this.strategyFlowCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('strategyFlow');

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

    //this.addLog(`Calculated adjusted quantity for ${symbol}: ${adjustedQuantity} (from ${this._formatNotional(positionSizeUSDT)} USDT at ${this._formatPrice(priceUsedForCalculation)} ${priceSource})`);
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
        await this.addLog(`Pos. mode already ${dualSidePosition ? 'Hedge' : 'One-way'}.`);
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
  async placeMarketOrder(symbol, side, quantity, positionSide) {
    // quantity here is already adjusted by _calculateAdjustedQuantity
    if (quantity <= 0) {
      throw new Error('Calculated quantity is zero or negative.');
    }

    return new Promise(async (resolve, reject) => {
      try {
        const orderParams = {
          symbol,
          side,
          type: 'MARKET',
          quantity: quantity,
          newOrderRespType: 'FULL',
        };
        if (positionSide) orderParams.positionSide = positionSide;
        const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', orderParams, true, 'futures');
        
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
  async placeLimitOrder(symbol, side, quantity, price, positionSide) {
    if (quantity <= 0) {
      throw new Error('Calculated quantity is zero or negative.');
    }
    if (price <= 0) {
      throw new Error('Limit price is zero or negative.');
    }

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

        const closeParams = {
          symbol: this.symbol,
          side: closingSide,
          type: 'MARKET',
          quantity: roundedQuantity,
          newOrderRespType: 'FULL',
          positionSide: this.currentPosition,
        };
        const result = await this.makeProxyRequest('/fapi/v1/order', 'POST', closeParams, true, 'futures');

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

  // Close ALL open position sides for the symbol (LONG and SHORT) using MARKET orders
  async closeAllPositions() {
    const currentPositions = await this.getCurrentPositions();
    const activePositions = currentPositions.filter(
      p => p.symbol === this.symbol && Math.abs(parseFloat(p.positionAmt)) > 0
    );

    if (activePositions.length === 0) {
      await this.addLog('No active positions to close.');
      return;
    }

    await this.addLog(`Closing ${activePositions.length} active position side(s) for ${this.symbol}...`);

    for (const position of activePositions) {
      const positionAmt = parseFloat(position.positionAmt);
      const closingSide = positionAmt > 0 ? 'SELL' : 'BUY';
      const positionSide = positionAmt > 0 ? 'LONG' : 'SHORT';
      const roundedQuantity = this.roundQuantity(Math.abs(positionAmt));

      if (roundedQuantity <= 0) {
        await this.addLog(`Skipping ${positionSide} position: quantity rounds to zero.`);
        continue;
      }

      await this.addLog(`Closing ${positionSide}: placing ${closingSide} MARKET for ${this._formatQuantity(roundedQuantity)} ${this.symbol}.`);
      try {
        await this.makeProxyRequest('/fapi/v1/order', 'POST', {
          symbol: this.symbol,
          side: closingSide,
          type: 'MARKET',
          quantity: roundedQuantity,
          newOrderRespType: 'FULL',
          positionSide: positionSide,
        }, true, 'futures');
      } catch (error) {
        await this.addLog(`ERROR: [TRADING_ERROR] Failed to close ${positionSide} position: ${error.message}`);
      }
    }
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
        // Clear per-side position data
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

        // Update persistent fields for historical analysis when position is active
        this.lastPositionQuantity = Math.abs(positionAmt);
        this.lastPositionEntryPrice = parseFloat(p.entryPrice);

        // Set per-side position data
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
        // Multiple positions (hedge mode — both LONG and SHORT open simultaneously)
        const longPos = positions.find(p => parseFloat(p.positionAmt) > 0);
        const shortPos = positions.find(p => parseFloat(p.positionAmt) < 0);

        // Keep backward-compatible primary tracking using the first position
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.entryPositionQuantity = this.entryPositionQuantity || Math.abs(positionAmt);
        this.currentPositionQuantity = Math.abs(positionAmt);

        // Set per-side position data from each side's position
        this._longEntryPrice = longPos ? parseFloat(longPos.entryPrice) : null;
        this._longPositionSize = longPos ? Math.abs(parseFloat(longPos.notional)) : null;
        this._shortEntryPrice = shortPos ? parseFloat(shortPos.entryPrice) : null;
        this._shortPositionSize = shortPos ? Math.abs(parseFloat(shortPos.notional)) : null;

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

  // Helper function to sync position state from Binance API (lightweight, no logging)
  async _syncPositionFromAPI() {
    try {
      const positions = await this.getCurrentPositions();

      if (positions.length === 0) {
        this.currentPosition = 'NONE';
        if (!this.isStopping) {
          this.positionEntryPrice = null;
          this.positionSize = null;
          this.currentPositionQuantity = null;
        }
      } else {
        const p = positions[0];
        const positionAmt = parseFloat(p.positionAmt);
        this.currentPosition = positionAmt > 0 ? 'LONG' : 'SHORT';
        this.positionEntryPrice = parseFloat(p.entryPrice);
        this.positionSize = Math.abs(parseFloat(p.notional));
        this.currentPositionQuantity = Math.abs(positionAmt);

        // Update persistent fields for historical analysis
        this.lastPositionQuantity = Math.abs(positionAmt);
        this.lastPositionEntryPrice = parseFloat(p.entryPrice);
      }
    } catch (error) {
      console.error(`Failed to sync position from API: ${error.message}`);
      throw error;
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

          // If waiting for NONE, attempt to close any remaining dust position
          if (targetPosition === 'NONE') {
            try {
              await this.addLog(`Timeout waiting for position to change to ${targetPosition}. Current: ${this.currentPosition}. Attempting dust close...`);
              const positions = await this.getCurrentPositions();
              const dustPos = positions.find(p => p.symbol === this.symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
              if (dustPos) {
                const dustQty = this.roundQuantity(Math.abs(parseFloat(dustPos.positionAmt)));
                if (dustQty > 0) {
                  const dustSide = parseFloat(dustPos.positionAmt) > 0 ? 'SELL' : 'BUY';
                  const dustPosSide = parseFloat(dustPos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                  await this.addLog(`Dust close: closing ${dustPosSide} ${dustQty} qty.`);
                  await this.placeMarketOrder(this.symbol, dustSide, dustQty, dustPosSide);
                  // Wait again with a shorter timeout for the dust close
                  const dustStart = Date.now();
                  const dustCheck = setInterval(async () => {
                    await this.detectCurrentPosition();
                    if (this.currentPosition === 'NONE') {
                      clearInterval(dustCheck);
                      await this.addLog(`Position confirmed as NONE after dust close (${Date.now() - startTime}ms total).`);
                      resolve();
                    } else if (Date.now() - dustStart > 5000) {
                      clearInterval(dustCheck);
                      await this.addLog(`Timeout waiting for dust close. Current: ${this.currentPosition}`);
                      reject(new Error(`Timeout waiting for position to change to ${targetPosition} (dust close failed)`));
                    }
                  }, 100);
                  return; // Don't reject yet, wait for dust close
                }
              }
            } catch (dustError) {
              await this.addLog(`Dust close attempt failed: ${dustError.message}`);
            }
          }

          await this.addLog(`Timeout waiting for position to change to ${targetPosition}. Current: ${this.currentPosition}`);
          reject(new Error(`Timeout waiting for position to change to ${targetPosition}`));
        }
      }, 100);
    });
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

      // Fast path: WebSocket ORDER_TRADE_UPDATE listener
      this.pendingOrders.set(orderId, {
        resolve: (order) => {
          this.addLog(`Order ${orderId} confirmed FILLED after ${Date.now() - startTime}ms.`);
          settle('resolve', order);
        },
        reject: (error) => settle('reject', error),
      });

      // Parallel path: REST API polling as safety net
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
    // Select stream type based on priceType setting
    const tickerStream = this.priceType === 'LAST'
      ? `${this.symbol.toLowerCase()}@ticker` // Last price WebSocket Stream
      : `${this.symbol.toLowerCase()}@markPrice@1s`; // Mark price WebSocket Stream
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
        // Handle both Last Price and Mark Price based on priceType setting
        if (this.priceType === 'LAST' && message.e === '24hrTicker') {
          await this.handleRealtimePrice(parseFloat(message.c));
        } else if (this.priceType === 'MARK' && message.e === 'markPriceUpdate') {
          await this.handleRealtimePrice(parseFloat(message.p));
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

      // Calculate FIXED reversal levels (only once at initial position)
      // LONG positions: oogLongReversalLevel = entry, oogShortReversalLevel = below entry
      // SHORT positions: oogShortReversalLevel = entry, oogLongReversalLevel = above entry
      if (this.currentPosition === 'LONG') {
        this.oogLongReversalLevel  = this.positionEntryPrice;
        this.oogShortReversalLevel = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, false);
        this.fixedReversalLevelsCalculated = true;

        this.reversalLevel = this.oogShortReversalLevel;
        this.initialReversalLevel = this.oogShortReversalLevel;
        await this.addLog(`Initial LONG position established. Entry: ${this._formatPrice(this.entryLevel)}, OOG Long Reversal: ${this._formatPrice(this.oogLongReversalLevel)}, OOG Short Reversal: ${this._formatPrice(this.oogShortReversalLevel)} (fixed range), Grid Size: ${(this.gridSize * 100).toFixed(2)}%.`);
      } else if (this.currentPosition === 'SHORT') {
        this.oogShortReversalLevel = this.positionEntryPrice;
        this.oogLongReversalLevel  = this._calculateAdjustedPrice(this.positionEntryPrice, this.reversalLevelPercentage, true);
        this.fixedReversalLevelsCalculated = true;

        this.reversalLevel = this.oogLongReversalLevel;
        this.initialReversalLevel = this.oogLongReversalLevel;
        await this.addLog(`Initial SHORT position established. Entry: ${this._formatPrice(this.entryLevel)}, OOG Short Reversal: ${this._formatPrice(this.oogShortReversalLevel)}, OOG Long Reversal: ${this._formatPrice(this.oogLongReversalLevel)} (fixed range), Grid Size: ${(this.gridSize * 100).toFixed(2)}%.`);
      }
    }

    // Set strategy start time after initial LIMIT order is filled (only if not already set)
    if (!this.strategyStartTime) {
      this.strategyStartTime = new Date();
      await this.addLog(`Strategy timer started after initial position filled.`);
    } else {
      await this.addLog(`Strategy timer preserved from original start time: ${this.strategyStartTime.toISOString()}.`);
    }

    // Update trade sequence with initial entry marker
    if (this.activeMode === 'SUPPORT_ZONE') {
      this.tradeSequence += 'L.';
    } else if (this.activeMode === 'RESISTANCE_ZONE') {
      this.tradeSequence += 'S.';
    }

    // Calculate BE and final TP for initial position
    await this._calculateBreakevenAndFinalTp();

    // Save strategy flow event for initial position
    const tradeType = this.activeMode === 'SUPPORT_ZONE' ? 'L' : 'S';
    const side = this.currentPosition;
    await this.saveStrategyFlowEvent(
      tradeType,
      side,
      this.positionEntryPrice,
      this.currentPositionQuantity,
      this.breakevenPrice,
      this.breakevenPercentage,
      this.finalTpPrice,
      this.finalTpPercentage
    );

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
            //await this.addLog(`[WebSocket] ORDER_TRADE_UPDATE for order ${order.i}, status: ${order.X}, side: ${order.S}, quantity: ${order.q}, filled: ${order.z}`); // Jacky Liaw: Comment out for future use
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
            const orderPositionSide = order.ps || 'BOTH'; // 'LONG', 'SHORT', or 'BOTH'
            if (!isNaN(realizedPnl) && realizedPnl !== 0) {
              this.accumulatedRealizedPnL += realizedPnl;
              if (orderPositionSide === 'LONG') this.longAccumulatedRealizedPnL += realizedPnl;
              else if (orderPositionSide === 'SHORT') this.shortAccumulatedRealizedPnL += realizedPnl;
              //await this.addLog(`Trade: Order ${order.i}, PnL: ${this._formatNotional(realizedPnl)} USDT, Total: ${this._formatNotional(this.accumulatedRealizedPnL)} USDT`);
            }
            if (!isNaN(commission) && commission !== 0) {
              this.accumulatedTradingFees += commission;
              if (orderPositionSide === 'LONG') this.longTradingFees += commission;
              else if (orderPositionSide === 'SHORT') this.shortTradingFees += commission;
              //await this.addLog(`Trade: Order ${order.i}, Fee: ${this._formatNotional(commission)} USDT, Total: ${this._formatNotional(this.accumulatedTradingFees)} USDT`);
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

              // Null out the per-side fields for the closed position side
              const closedSide = positionUpdate.ps;
              if (closedSide === 'LONG') {
                this._longEntryPrice = null;
                this._longPositionSize = null;
              } else if (closedSide === 'SHORT') {
                this._shortEntryPrice = null;
                this._shortPositionSize = null;
              } else {
                // One-way mode or unknown: null both
                this._longEntryPrice = null;
                this._longPositionSize = null;
                this._shortEntryPrice = null;
                this._shortPositionSize = null;
              }
            } else if (positionAmount > 0) {
              // LONG position
              this.currentPosition = 'LONG';
              this.positionEntryPrice = entryPrice;
              this.currentPositionQuantity = Math.abs(positionAmount);
              this.positionSize = Math.abs(positionAmount) * entryPrice;

              // Update persistent fields for historical analysis
              this.lastPositionQuantity = Math.abs(positionAmount);
              this.lastPositionEntryPrice = entryPrice;

              // Update per-side fields for PnL calculation
              this._longEntryPrice = entryPrice;
              this._longPositionSize = Math.abs(positionAmount) * entryPrice;
            } else if (positionAmount < 0) {
              // SHORT position
              this.currentPosition = 'SHORT';
              this.positionEntryPrice = entryPrice;
              this.currentPositionQuantity = Math.abs(positionAmount);
              this.positionSize = Math.abs(positionAmount) * entryPrice;

              // Update persistent fields for historical analysis
              this.lastPositionQuantity = Math.abs(positionAmount);
              this.lastPositionEntryPrice = entryPrice;

              // Update per-side fields for PnL calculation
              this._shortEntryPrice = entryPrice;
              this._shortPositionSize = Math.abs(positionAmount) * entryPrice;
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
      //await this.addLog(`[WebSocket] User Data Stream WebSocket closed. Code: ${code}, Reason: ${reason || 'none'}, isRunning: ${this.isRunning}, isUserDataReconnecting: ${this.isUserDataReconnecting}`);
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
        //await this.addLog(`[REST-API] Attempting listenKey ${isRefresh ? 'refresh' : 'request'}... (Attempt ${attempt}/${maxAttempts})`);

        const endpoint = '/fapi/v1/listenKey';
        const method = isRefresh ? 'PUT' : 'POST';
        const params = isRefresh ? { listenKey: this.listenKey } : {};

        const response = await this.makeProxyRequest(endpoint, method, params, true, 'futures');

        if (!isRefresh && response.listenKey) {
          this.listenKey = response.listenKey;
          await this.addLog(`[REST-API] ListenKey obtained successfully on attempt ${attempt}/${maxAttempts}.`);
          this.listenKeyRetryAttempts = 0; // Reset on success
          return response;
        } else if (isRefresh) {
          await this.addLog(`[REST-API] ListenKey refreshed successfully on attempt ${attempt}/${maxAttempts}.`);
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

      //await this.addLog(`[Health Check] WebSocket Status - Real-time Price: ${realtimeStatus}, User Data: ${userDataStatus}`);

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
    let newPositionSizeUSDT = this.positionSizeUSDT;
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
        //await this.addLog(`Final positionSizeUSDT for next trade: ${this._formatNotional(newPositionSizeUSDT)} USDT.`);
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

      // Filter trades to only include those from this strategy (after or at strategy start time)
      // Using >= to ensure the initial entry trade at the exact start time is included
      const strategyTrades = this.strategyStartTime
        ? binanceTrades.filter(trade => trade.time >= this.strategyStartTime.getTime())
        : binanceTrades;

      if (strategyTrades.length === 0) {
        await this.addLog(`[VERIFICATION] No trades found in Binance history for this strategy`);
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

      await this.addLog(`[VERIFICATION] Binance trade history: ${strategyTrades.length} trades`);
      await this.addLog(`[VERIFICATION] Binance Realized PnL: ${this._formatNotional(binanceRealizedPnL)} USDT`);
      await this.addLog(`[VERIFICATION] Binance Commission: ${this._formatNotional(binanceCommission)} USDT`);
      await this.addLog(`[VERIFICATION] Strategy Realized PnL: ${this._formatNotional(this.accumulatedRealizedPnL)} USDT`);
      await this.addLog(`[VERIFICATION] Strategy Commission: ${this._formatNotional(this.accumulatedTradingFees)} USDT`);

      // Calculate differences
      const pnlDifference = Math.abs(binanceRealizedPnL - this.accumulatedRealizedPnL);
      const feeDifference = Math.abs(binanceCommission - this.accumulatedTradingFees);

      // Check Realized PnL verification status
      if (pnlDifference === 0) {
        await this.addLog(`[VERIFICATION] Realized PnL verified - exact match`);
      } else if (pnlDifference > 1.0) {
        await this.addLog(`[VERIFICATION] WARNING: Realized PnL mismatch of ${this._formatNotional(pnlDifference)} USDT detected!`);
        await this.addLog(`[VERIFICATION] Auto-correcting to Binance value...`);
        this.accumulatedRealizedPnL = binanceRealizedPnL;
        this.longAccumulatedRealizedPnL = strategyTrades
          .filter(t => t.positionSide === 'LONG')
          .reduce((sum, t) => sum + (parseFloat(t.realizedPnl) || 0), 0);
        this.shortAccumulatedRealizedPnL = strategyTrades
          .filter(t => t.positionSide === 'SHORT')
          .reduce((sum, t) => sum + (parseFloat(t.realizedPnl) || 0), 0);
      } else if (pnlDifference <= 0.01) {
        await this.addLog(`[VERIFICATION] Realized PnL verified - within tolerance (difference: ${this._formatNotional(pnlDifference)} USDT)`);
      } else {
        await this.addLog(`[VERIFICATION] Realized PnL UNVERIFIED (difference: ${this._formatNotional(pnlDifference)} USDT)`);
      }

      // Check Commission verification status
      if (feeDifference === 0) {
        await this.addLog(`[VERIFICATION] Commission verified - exact match`);
      } else if (feeDifference > 1.0) {
        await this.addLog(`[VERIFICATION] WARNING: Commission mismatch of ${this._formatNotional(feeDifference)} USDT detected!`);
        await this.addLog(`[VERIFICATION] Auto-correcting to Binance value...`);
        this.accumulatedTradingFees = binanceCommission;
        this.longTradingFees = strategyTrades
          .filter(t => t.positionSide === 'LONG')
          .reduce((sum, t) => sum + (parseFloat(t.commission) || 0), 0);
        this.shortTradingFees = strategyTrades
          .filter(t => t.positionSide === 'SHORT')
          .reduce((sum, t) => sum + (parseFloat(t.commission) || 0), 0);
      } else if (feeDifference <= 0.01) {
        await this.addLog(`[VERIFICATION] Commission verified - within tolerance (difference: ${this._formatNotional(feeDifference)} USDT)`);
      } else {
        await this.addLog(`[VERIFICATION] Commission UNVERIFIED (difference: ${this._formatNotional(feeDifference)} USDT)`);
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

  async _calculateBreakevenAndFinalTp() {
    if (!this.currentPositionQuantity || this.currentPositionQuantity <= 0 || !this.positionEntryPrice) {
      await this.addLog(`BE/Final TP Calc: Cannot calculate - invalid position quantity or entry price.`);
      return;
    }

    // Verify accumulated metrics before calculating breakeven
    //await this._verifyAccumulatedMetrics(); Commented out and kept for future use

    // Calculate Breakeven Price
    const netRealizedPnL = this.accumulatedRealizedPnL - this.accumulatedTradingFees;

    // Count trades from trade sequence
    const tradeCount = this.tradeSequence.split('.').filter(x => x).length;

    await this.addLog(`BE Calc: Accumulated Realized PnL: ${precisionFormatter.formatNotional(this.accumulatedRealizedPnL)}`);
    await this.addLog(`BE Calc: Accumulated Trading Fees: ${precisionFormatter.formatNotional(this.accumulatedTradingFees)}`);
    await this.addLog(`BE Calc: Net Realized PnL: ${precisionFormatter.formatNotional(netRealizedPnL)}`);
    //await this.addLog(`BE Calc: Current Position Quantity: ${this._formatQuantity(this.currentPositionQuantity)}`);

    let breakevenPriceRaw;
    if (this.currentPosition === 'LONG') {
      breakevenPriceRaw = this.positionEntryPrice - (netRealizedPnL / this.currentPositionQuantity);
    } else { // SHORT
      breakevenPriceRaw = this.positionEntryPrice + (netRealizedPnL / this.currentPositionQuantity);
    }

    //await this.addLog(`BE Calc: Raw Breakeven Price: ${this._formatPrice(breakevenPriceRaw)}`);
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

  async _updateEntryPriceFromBinance() {
    try {
      const oldEntryPrice = this.positionEntryPrice;

      // Retry with exponential backoff until API returns updated entry price
      for (let attempt = 1; attempt <= ENTRY_PRICE_UPDATE_MAX_RETRIES; attempt++) {
        const currentPositions = await this.getCurrentPositions();
        const targetPosition = currentPositions.find(p => p.symbol === this.symbol);

        if (targetPosition && parseFloat(targetPosition.positionAmt) !== 0) {
          const newEntryPrice = parseFloat(targetPosition.entryPrice);

          if (!isNaN(newEntryPrice) && newEntryPrice > 0) {
            // Check if entry price has actually changed (API has updated)
            const priceChanged = Math.abs(newEntryPrice - oldEntryPrice) > 0.00001;

            if (priceChanged) {
              // Validate that the change is in the expected direction
              const isLong = this.tradingDirection === 'LONG';
              const expectedHigher = isLong; // LONG should have higher new entry, SHORT should have lower
              const actualHigher = newEntryPrice > oldEntryPrice;

              if (expectedHigher === actualHigher) {
                // Valid update - entry price changed in expected direction
                this.positionEntryPrice = newEntryPrice;
                this.entryLevel = newEntryPrice;
                await this.addLog(`Entry price updated from Binance API: ${this._formatPrice(oldEntryPrice)} -> ${this._formatPrice(newEntryPrice)}`);
                return; // Success
              } else {
                // Unexpected direction - log warning but use the value
                await this.addLog(`WARNING: Entry price changed in unexpected direction: ${this._formatPrice(oldEntryPrice)} -> ${this._formatPrice(newEntryPrice)} for ${this.tradingDirection} position`);
                this.positionEntryPrice = newEntryPrice;
                this.entryLevel = newEntryPrice;
                return;
              }
            } else {
              // Entry price hasn't changed yet - API latency
              if (attempt < ENTRY_PRICE_UPDATE_MAX_RETRIES) {
                const delay = Math.min(ENTRY_PRICE_UPDATE_MAX_DELAY_MS, ENTRY_PRICE_UPDATE_INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
                await this.addLog(`Waiting for Binance API to update entry price... (Attempt ${attempt}/${ENTRY_PRICE_UPDATE_MAX_RETRIES}, retrying in ${delay}ms)`);
                await new Promise(resolve => setTimeout(resolve, delay));
              } else {
                // Max retries reached - use current value with warning
                await this.addLog(`WARNING: Binance API entry price unchanged after ${ENTRY_PRICE_UPDATE_MAX_RETRIES} attempts (${this._formatPrice(oldEntryPrice)} -> ${this._formatPrice(newEntryPrice)}). Using current value.`);
                this.positionEntryPrice = newEntryPrice;
                this.entryLevel = newEntryPrice;
                return;
              }
            }
          }
        }
      }
    } catch (error) {
      await this.addLog(`WARNING: Failed to update entry price from Binance API: ${error.message}`);
    }
  }

  async handleRealtimePrice(currentPrice) {
    // Update current price and PnL values (always update these)
    this.currentPrice = currentPrice;

    // Compute per-side unrealized PnL
    this.longPositionPnL = (this._longEntryPrice !== null && this._longPositionSize !== null)
      ? (currentPrice - this._longEntryPrice) * (this._longPositionSize / this._longEntryPrice)
      : 0;
    this.shortPositionPnL = (this._shortEntryPrice !== null && this._shortPositionSize !== null)
      ? (this._shortEntryPrice - currentPrice) * (this._shortPositionSize / this._shortEntryPrice)
      : 0;
    this.positionPnL = this.longPositionPnL + this.shortPositionPnL;

    this.totalPnL = this.positionPnL + this.accumulatedRealizedPnL - this.accumulatedTradingFees;

    // Early exit if strategy is stopping - prevents duplicate trigger checks
    if (this.isStopping) {
      return;
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

    // Only execute trading logic if strategy is running
    if (!this.isRunning) {
      return;
    }

    // ===== Grid Initialization — first price tick after strategy starts =====
    if (this.anchorPrice === null) {
      if (this.anchorMode === 'IMMEDIATE') {
        await this.initializeGrid(currentPrice);
        this.waitingForAnchor = false;
      } else if (this.anchorMode === 'TARGET_PRICE' && this.targetAnchorPrice !== null) {
        const prevPrice = this.lastProcessedPrice;
        const crossed = prevPrice !== null && (
          (prevPrice < this.targetAnchorPrice && currentPrice >= this.targetAnchorPrice) ||
          (prevPrice > this.targetAnchorPrice && currentPrice <= this.targetAnchorPrice)
        );
        if (crossed) {
          await this.addLog(`Target anchor price $${this._formatPrice(this.targetAnchorPrice)} reached. Initializing grid at $${this._formatPrice(currentPrice)}.`);
          await this.initializeGrid(currentPrice);
          this.waitingForAnchor = false;
        }
      }
      this.lastProcessedPrice = currentPrice;
      return;
    }

    // ===== 2. Final TP Trigger Logic (Priority check - runs before guard) =====
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
        await this.addLog(`===== FINAL TP HIT! CONGRATULATIONS, BRO! =====`);
        await this.addLog(`Final TP hit! Current price: ${this._formatPrice(currentPrice)}, Target: ${this._formatPrice(this.finalTpPrice)}. Closing remaining position and stopping strategy.`);

        // Save strategy flow event for Final TP (before closing position)
        await this.saveStrategyFlowEvent(
          'F',
          this.currentPosition,
          this.positionEntryPrice,
          this.currentPositionQuantity,
          this.breakevenPrice,
          this.breakevenPercentage,
          this.finalTpPrice,
          this.finalTpPercentage
        );

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

    // ===== 3. Grid Price Crossing Logic =====
    const prevPrice = this.lastProcessedPrice;
    if (prevPrice !== null && prevPrice !== currentPrice) {
      if (this.gridMode === 'WITHIN') {
        await this._processGridCrossings(prevPrice, currentPrice);
      } else if (this.gridMode === 'OUT_OF_GRID') {
        await this._processOutOfGridCrossings(prevPrice, currentPrice);
      }
    }

    // Update last processed price for next tick
    this.lastProcessedPrice = currentPrice;
  }

  // Handle direct reversal
  async _handleDirectReversal(currentPrice) {
    this.isTradingSequenceInProgress = true;

    // Deactivate Final TP
    this.finalTpActive = false;
    this.finalTpOrderSent = false;

    try {
      const oldPosition = this.currentPosition;
      const newPosition = oldPosition === 'LONG' ? 'SHORT' : 'LONG';
      const oldZone = this.activeMode;
      const newZone = oldZone === 'SUPPORT_ZONE' ? 'RESISTANCE_ZONE' : 'SUPPORT_ZONE';

      await this.addLog(`${oldPosition} position hit reversal at ${this._formatPrice(currentPrice)}. Reversing to ${newPosition} in ${newZone}.`);

      // Step 1: Close existing real position
      await this.closeCurrentPosition();
      await this._waitForPositionChange('NONE');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Step 2: Increment reversal count and update trade sequence
      this.reversalCount++;
      this.tradeSequence += newPosition === 'LONG' ? 'L.' : 'S.';

      // Step 3: Switch zone
      this.activeMode = newZone;
      await this.addLog(`Zone switched from ${oldZone} to ${newZone}.`);

      // Step 4: Check capital protection
      const canTrade = await this.checkCapitalProtection();
      if (!canTrade) {
        this.isTradingSequenceInProgress = false;
        return;
      }

      // Step 5: Apply dynamic sizing
      const shouldApplyDynamic = this._shouldApplyDynamicSizing();

      if (shouldApplyDynamic) {
        this.positionSizeUSDT = await this._calculateDynamicPositionSize();
        this.lastDynamicSizingReversalCount = this.reversalCount;

        const interval = this.tradingMode === 'NORMAL' ? 3 : this.tradingMode === 'CONSERVATIVE' ? 5 : 1;
        const nextDynamicReversal = this.reversalCount + interval;

        await this.addLog(`Applying dynamic position sizing: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
        if (this.tradingMode !== 'AGGRESSIVE') {
          await this.addLog(`Next dynamic sizing at reversal #${nextDynamicReversal}.`);
        }
      } else {
        const interval = this.tradingMode === 'NORMAL' ? 3 : 5;
        const reversalsSinceLastDynamic = this.reversalCount - this.lastDynamicSizingReversalCount;
        const reversalsUntilNext = interval - reversalsSinceLastDynamic;
        const nextDynamicReversal = this.reversalCount + reversalsUntilNext;
        await this.addLog(`Reusing position size: ${this._formatNotional(this.positionSizeUSDT)} USDT (Dynamic sizing will happen at #${nextDynamicReversal}).`);
      }

      // Step 6: Open new position
      const quantity = await this._calculateAdjustedQuantity(this.symbol, this.positionSizeUSDT);

      if (quantity > 0) {
        const orderSide = (newPosition === 'LONG') ? 'BUY' : 'SELL';
        await this.addLog(`Opening ${newPosition} position with quantity ${quantity}.`);
        await this.placeMarketOrder(this.symbol, orderSide, quantity, newPosition);
        await this._waitForPositionChange(newPosition);

        // Add delay to ensure position data is fully synchronized
        //await new Promise(resolve => setTimeout(resolve, 200));

        this.currentPosition = newPosition;
        this.entryPositionQuantity = quantity;
        this.currentPositionQuantity = quantity;

        // Set position states
        this.entryLevel = this.positionEntryPrice;

        // Use FIXED reversal levels (DO NOT recalculate)
        if (newPosition === 'LONG') {
          this.reversalLevel = this.oogShortReversalLevel;
          this.initialReversalLevel = this.oogShortReversalLevel;
          await this.addLog(`Reversal #${this.reversalCount}: LONG position opened at ${this._formatPrice(this.entryLevel)}. Will reverse at OOG Short Reversal: ${this._formatPrice(this.oogShortReversalLevel)} (fixed).`);
        } else if (newPosition === 'SHORT') {
          this.reversalLevel = this.oogLongReversalLevel;
          this.initialReversalLevel = this.oogLongReversalLevel;
          await this.addLog(`Reversal #${this.reversalCount}: SHORT position opened at ${this._formatPrice(this.entryLevel)}. Will reverse at OOG Long Reversal: ${this._formatPrice(this.oogLongReversalLevel)} (fixed).`);
        }

        // Calculate breakeven and final TP
        await this._calculateBreakevenAndFinalTp();

        // Save strategy flow event for reversal
        const reversalTradeType = newPosition === 'LONG' ? 'L' : 'S';
        await this.saveStrategyFlowEvent(
          reversalTradeType,
          newPosition,
          this.positionEntryPrice,
          this.currentPositionQuantity,
          this.breakevenPrice,
          this.breakevenPercentage,
          this.finalTpPrice,
          this.finalTpPercentage
        );

        await this.saveState();
      }
    } catch (error) {
      console.error(`Error during reversal: ${error.message}`);
      await this.addLog(`ERROR: [TRADING_ERROR] During reversal: ${error.message}`);
    } finally {
      this.isTradingSequenceInProgress = false;
    }
  }

  // ===================================================================
  // GRID TRADING SYSTEM — Core Methods
  // ===================================================================

  // Initialize the 10-level grid on the first price tick after strategy start.
  async initializeGrid(currentPrice) {
    this.anchorPrice = currentPrice;
    this.gridBaseSize = this.positionSizeUSDT || this.initialBasePositionSizeUSDT;

    // Build grid levels first so S5/L5 prices are available for OOG formula.
    this.gridLevels = this._buildGridLevels(this.anchorPrice, this.gridBaseSize, this.gridSize);
    this.gridMode = 'WITHIN';

    // OOG reversal levels: beyond the outermost grid level on each side.
    // oogLongReversalLevel  (above S5) → triggers LONG consolidated when price goes UP past it
    // oogShortReversalLevel (below L5) → triggers SHORT consolidated when price goes DOWN past it
    const s5 = this.gridLevels.find(l => l.direction === 'SHORT' && l.levelIndex === this.gridLevelsPerSide);
    const l5 = this.gridLevels.find(l => l.direction === 'LONG'  && l.levelIndex === this.gridLevelsPerSide);
    this.oogLongReversalLevel  = this._calculateAdjustedPrice(s5.price, this.reversalLevelPercentage, true);
    this.oogShortReversalLevel = this._calculateAdjustedPrice(l5.price, this.reversalLevelPercentage, false);
    this.fixedReversalLevelsCalculated = true;
    this.reversalLevel = this.oogLongReversalLevel;
    this.initialReversalLevel = this.oogLongReversalLevel;

    if (!this.strategyStartTime) {
      this.strategyStartTime = new Date();
    }

    await this.addLog(`===== GRID INITIALIZED =====`);
    await this.addLog(`Anchor: ${this._formatPrice(this.anchorPrice)}, Grid Size: ${(this.gridSize * 100).toFixed(2)}%, Base Size: ${this._formatNotional(this.gridBaseSize)} USDT`);
    const longLevels  = this.gridLevels.filter(l => l.direction === 'LONG').map(l => `L${l.levelIndex}@${this._formatPrice(l.price)}`).join(', ');
    const shortLevels = this.gridLevels.filter(l => l.direction === 'SHORT').map(l => `S${l.levelIndex}@${this._formatPrice(l.price)}`).join(', ');
    await this.addLog(`LONG  levels (below anchor): ${longLevels} → OOG SHORT Reversal: ${this._formatPrice(this.oogShortReversalLevel)}`);
    await this.addLog(`SHORT levels (above anchor): ${shortLevels} → OOG LONG  Reversal: ${this._formatPrice(this.oogLongReversalLevel)}`);
    await this.saveState();
  }

  // Build grid level objects from anchor, baseSize, and gridSize decimal.
  _buildGridLevels(anchorPrice, baseSize, gridSize) {
    const levels = [];
    const levelSize = baseSize / this.gridLevelsPerSide;
    const stepPct = gridSize * 100; // Convert decimal to percentage for _calculateAdjustedPrice

    for (let n = 1; n <= this.gridLevelsPerSide; n++) {
      levels.push({
        levelIndex: n,
        direction: 'SHORT',
        price: this._calculateAdjustedPrice(anchorPrice, n * stepPct, true),
        state: 'EMPTY',
        positionSize: levelSize,
        positionQuantity: null,
        tpedInCurrentSequence: false,
      });
      levels.push({
        levelIndex: n,
        direction: 'LONG',
        price: this._calculateAdjustedPrice(anchorPrice, n * stepPct, false),
        state: 'EMPTY',
        positionSize: levelSize,
        positionQuantity: null,
        tpedInCurrentSequence: false,
      });
    }
    return levels;
  }

  // VWAP of currently open grid positions for the given direction.
  _calcAverageGridEntryPrice(direction) {
    const open = this.gridLevels.filter(
      l => l.direction === direction && l.state === 'POSITION_OPEN' && l.positionQuantity > 0
    );
    if (open.length === 0) return null;
    const totalCost = open.reduce((sum, l) => sum + l.price * l.positionQuantity, 0);
    const totalQty  = open.reduce((sum, l) => sum + l.positionQuantity, 0);
    return totalQty > 0 ? totalCost / totalQty : null;
  }

  // Returns the open grid level with the most unrealized profit for a given direction.
  // LONG: lowest price (opened furthest below current price).
  // SHORT: highest price (opened furthest above current price).
  _getDeepestOpenGridLevel(direction) {
    const open = this.gridLevels.filter(
      l => l.direction === direction && l.state === 'POSITION_OPEN' && l.positionQuantity > 0
    );
    if (open.length === 0) return null;
    return direction === 'LONG'
      ? open.reduce((d, l) => l.price < d.price ? l : d)
      : open.reduce((d, l) => l.price > d.price ? l : d);
  }

  // Reset same-territory TP state for a direction (VWAP + tpedInCurrentSequence flags).
  _resetSameTerritoryState(direction) {
    if (direction === 'SHORT') {
      this.sameTerritoryVwapShort = null;
      this.gridLevels.filter(l => l.direction === 'SHORT').forEach(l => { l.tpedInCurrentSequence = false; });
    } else {
      this.sameTerritoryVwapLong = null;
      this.gridLevels.filter(l => l.direction === 'LONG').forEach(l => { l.tpedInCurrentSequence = false; });
    }
  }

  // Open a single grid position (BUY for LONG, SELL for SHORT).
  async _openGridPosition(level, currentPrice) {
    const side = level.direction === 'LONG' ? 'BUY' : 'SELL';
    try {
      const quantity = await this._calculateAdjustedQuantity(this.symbol, level.positionSize);
      await this.addLog(`Grid: Opening ${level.direction} L${level.levelIndex} @ ~${this._formatPrice(level.price)} — size ${this._formatNotional(level.positionSize)} USDT, qty ${quantity}.`);
      const orderResult = await this.placeMarketOrder(this.symbol, side, quantity, level.direction);
      await this._waitForOrderFill(orderResult.orderId);
      level.state = 'POSITION_OPEN';
      level.positionQuantity = quantity;
      // Recalculate same-territory VWAP to include newly opened position
      if (level.direction === 'SHORT') {
        this.sameTerritoryVwapShort = this._calcAverageGridEntryPrice('SHORT');
      } else {
        this.sameTerritoryVwapLong = this._calcAverageGridEntryPrice('LONG');
      }
      const eventType = `WG_OPEN_${level.direction === 'LONG' ? 'L' : 'S'}${level.levelIndex}`;
      await this.saveStrategyFlowEvent(eventType, level.direction, currentPrice, quantity, null, null, null, null);
    } catch (error) {
      await this.addLog(`ERROR: Failed to open grid ${level.direction} L${level.levelIndex}: ${error.message}`);
      throw error;
    }
  }

  // Close a single grid position (SELL for LONG, BUY for SHORT).
  async _closeGridPosition(level, currentPrice, eventType) {
    const closeSide = level.direction === 'LONG' ? 'SELL' : 'BUY';
    const quantity = level.positionQuantity;

    if (!quantity || quantity <= 0) {
      await this.addLog(`WARNING: No stored quantity for grid ${level.direction} L${level.levelIndex}, resetting state only.`);
      level.state = 'EMPTY';
      level.positionQuantity = null;
      return;
    }

    try {
      await this.addLog(`Grid: Closing ${level.direction} L${level.levelIndex} (TP), qty ${quantity}.`);
      const orderResult = await this.placeMarketOrder(this.symbol, closeSide, quantity, level.direction);
      await this._waitForOrderFill(orderResult.orderId);
      level.state = 'EMPTY';
      level.positionQuantity = null;
      if (eventType) {
        await this.saveStrategyFlowEvent(eventType, level.direction, currentPrice, quantity, null, null, null, null);
      }
    } catch (error) {
      await this.addLog(`ERROR: Failed to close grid ${level.direction} L${level.levelIndex}: ${error.message}`);
      throw error;
    }
  }

  // Close all POSITION_OPEN grid levels in two batched market orders (one per side).
  async _closeAllGridPositions() {
    let totalLongQty = 0;
    let totalShortQty = 0;

    for (const level of this.gridLevels) {
      if (level.state === 'POSITION_OPEN' && level.positionQuantity > 0) {
        if (level.direction === 'LONG') totalLongQty += level.positionQuantity;
        else totalShortQty += level.positionQuantity;
      }
    }

    if (totalLongQty > 0) {
      const qty = this.roundQuantity(totalLongQty);
      await this.addLog(`OOG: Closing all LONG grid positions (total qty ${qty}).`);
      await this.placeMarketOrder(this.symbol, 'SELL', qty, 'LONG');
    }
    if (totalShortQty > 0) {
      const qty = this.roundQuantity(totalShortQty);
      await this.addLog(`OOG: Closing all SHORT grid positions (total qty ${qty}).`);
      await this.placeMarketOrder(this.symbol, 'BUY', qty, 'SHORT');
    }

    for (const level of this.gridLevels) {
      level.state = 'EMPTY';
      level.positionQuantity = null;
    }
    this._resetSameTerritoryState('SHORT');
    this._resetSameTerritoryState('LONG');
  }

  // Process within-grid price crossings for one price tick.
  async _processGridCrossings(prevPrice, currentPrice) {
    if (this.isTradingSequenceInProgress) return;

    const movingDown = currentPrice < prevPrice;
    const movingUp   = currentPrice > prevPrice;

    // OOG trigger checks (highest priority — before any level crossings)
    if (movingUp && this.oogLongReversalLevel !== null && prevPrice < this.oogLongReversalLevel && currentPrice >= this.oogLongReversalLevel) {
      this.isTradingSequenceInProgress = true;
      await this.addLog(`===== OOG LONG Reversal triggered (price ${this._formatPrice(currentPrice)} hit ${this._formatPrice(this.oogLongReversalLevel)}) =====`);
      try { await this._triggerOutOfGrid('LONG', currentPrice); }
      finally { this.isTradingSequenceInProgress = false; }
      return;
    }
    if (movingDown && this.oogShortReversalLevel !== null && prevPrice > this.oogShortReversalLevel && currentPrice <= this.oogShortReversalLevel) {
      this.isTradingSequenceInProgress = true;
      await this.addLog(`===== OOG SHORT Reversal triggered (price ${this._formatPrice(currentPrice)} hit ${this._formatPrice(this.oogShortReversalLevel)}) =====`);
      try { await this._triggerOutOfGrid('SHORT', currentPrice); }
      finally { this.isTradingSequenceInProgress = false; }
      return;
    }

    if (movingDown) {
      // Downward: check LONG levels (closest to anchor first = highest price first)
      const longLevels = this.gridLevels
        .filter(l => l.direction === 'LONG')
        .sort((a, b) => b.price - a.price);

      for (const level of longLevels) {
        if (prevPrice > level.price && currentPrice <= level.price) {
          if (this.isTradingSequenceInProgress) break;
          this.isTradingSequenceInProgress = true;
          try {
            const actions = [];
            // Close highest-price open SHORT (most profitable) instead of mirror
            const highestShort = this._getDeepestOpenGridLevel('SHORT');
            if (highestShort) {
              actions.push(this._closeGridPosition(highestShort, currentPrice, `WG_TP_S${highestShort.levelIndex}`));
            }
            if (level.state === 'EMPTY' && !level.tpedInCurrentSequence) {
              actions.push(this._openGridPosition(level, currentPrice));
            }
            if (actions.length > 0) {
              await Promise.all(actions);
              if (this._getDeepestOpenGridLevel('SHORT') === null) {
                this._resetSameTerritoryState('SHORT');
              }
              await this.saveState();
            }
          } catch (error) {
            await this.addLog(`ERROR: Grid crossing at LONG L${level.levelIndex}: ${error.message}`);
          } finally {
            this.isTradingSequenceInProgress = false;
          }
        }
      }

      // Same-territory SHORT TP: close the level crossed if open and strictly below VWAP.
      const shortLevelsForSameTP = this.gridLevels
        .filter(l => l.direction === 'SHORT')
        .sort((a, b) => a.price - b.price); // lowest first (closest to anchor)
      for (const level of shortLevelsForSameTP) {
        if (prevPrice > level.price && currentPrice <= level.price) {
          if (level.state !== 'POSITION_OPEN') continue;
          const vwap = this.sameTerritoryVwapShort;
          if (vwap === null || level.price >= vwap) continue; // not strictly below VWAP
          if (this.isTradingSequenceInProgress) break;
          this.isTradingSequenceInProgress = true;
          try {
            await this.addLog(`Grid: Same-territory SHORT TP at S${level.levelIndex} (price ${this._formatPrice(currentPrice)}, VWAP ${this._formatPrice(vwap)}) — closing S${level.levelIndex}.`);
            await this._closeGridPosition(level, currentPrice, `WG_SAME_TP_S${level.levelIndex}`);
            level.tpedInCurrentSequence = true;
            if (this._getDeepestOpenGridLevel('SHORT') === null) {
              this._resetSameTerritoryState('SHORT');
            }
            await this.saveState();
          } catch (error) {
            await this.addLog(`ERROR: Same-territory SHORT TP at S${level.levelIndex}: ${error.message}`);
          } finally {
            this.isTradingSequenceInProgress = false;
          }
        }
      }
    } else if (movingUp) {
      // Upward: check SHORT levels (closest to anchor first = lowest price first)
      const shortLevels = this.gridLevels
        .filter(l => l.direction === 'SHORT')
        .sort((a, b) => a.price - b.price);

      for (const level of shortLevels) {
        if (prevPrice < level.price && currentPrice >= level.price) {
          if (this.isTradingSequenceInProgress) break;
          this.isTradingSequenceInProgress = true;
          try {
            const actions = [];
            // Close lowest-price open LONG (most profitable) instead of mirror
            const deepestLong = this._getDeepestOpenGridLevel('LONG');
            if (deepestLong) {
              actions.push(this._closeGridPosition(deepestLong, currentPrice, `WG_TP_L${deepestLong.levelIndex}`));
            }
            if (level.state === 'EMPTY' && !level.tpedInCurrentSequence) {
              actions.push(this._openGridPosition(level, currentPrice));
            }
            if (actions.length > 0) {
              await Promise.all(actions);
              if (this._getDeepestOpenGridLevel('LONG') === null) {
                this._resetSameTerritoryState('LONG');
              }
              await this.saveState();
            }
          } catch (error) {
            await this.addLog(`ERROR: Grid crossing at SHORT S${level.levelIndex}: ${error.message}`);
          } finally {
            this.isTradingSequenceInProgress = false;
          }
        }
      }

      // Same-territory LONG TP: close the level crossed if open and strictly above VWAP.
      const longLevelsForSameTP = this.gridLevels
        .filter(l => l.direction === 'LONG')
        .sort((a, b) => b.price - a.price); // highest first (closest to anchor)
      for (const level of longLevelsForSameTP) {
        if (prevPrice < level.price && currentPrice >= level.price) {
          if (level.state !== 'POSITION_OPEN') continue;
          const vwap = this.sameTerritoryVwapLong;
          if (vwap === null || level.price <= vwap) continue; // not strictly above VWAP
          if (this.isTradingSequenceInProgress) break;
          this.isTradingSequenceInProgress = true;
          try {
            await this.addLog(`Grid: Same-territory LONG TP at L${level.levelIndex} (price ${this._formatPrice(currentPrice)}, VWAP ${this._formatPrice(vwap)}) — closing L${level.levelIndex}.`);
            await this._closeGridPosition(level, currentPrice, `WG_SAME_TP_L${level.levelIndex}`);
            level.tpedInCurrentSequence = true;
            if (this._getDeepestOpenGridLevel('LONG') === null) {
              this._resetSameTerritoryState('LONG');
            }
            await this.saveState();
          } catch (error) {
            await this.addLog(`ERROR: Same-territory LONG TP at L${level.levelIndex}: ${error.message}`);
          } finally {
            this.isTradingSequenceInProgress = false;
          }
        }
      }
    }
  }

  // Trigger out-of-grid mode: close all grid positions, open consolidated position with dynamic sizing.
  async _triggerOutOfGrid(direction, currentPrice) {
    await this._closeAllGridPositions();
    if (this.currentPosition !== 'NONE') {
      await this._waitForPositionChange('NONE'); // Wait for fill events to update accumulatedRealizedPnL before dynamic sizing
    }

    this.reversalCount++;
    const shouldApplyDynamic = this._shouldApplyDynamicSizing();
    if (shouldApplyDynamic) {
      this.positionSizeUSDT = await this._calculateDynamicPositionSize();
      this.lastDynamicSizingReversalCount = this.reversalCount;
      await this.addLog(`OOG: Dynamic sizing applied — ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
    } else {
      const reversalsSinceLastDynamic = this.reversalCount - this.lastDynamicSizingReversalCount;
      const modeThreshold = this.tradingMode === 'CONSERVATIVE' ? 5 : this.tradingMode === 'NORMAL' ? 3 : 1;
      const reversalsUntilNext = modeThreshold - reversalsSinceLastDynamic;
      await this.addLog(`OOG: Reversal #${this.reversalCount}. Dynamic sizing not applied (${this.tradingMode} mode — next in ${reversalsUntilNext} reversal(s)).`);
    }

    const consolidatedSize = this.positionSizeUSDT;
    const side = direction === 'SHORT' ? 'SELL' : 'BUY';
    const quantity = await this._calculateAdjustedQuantity(this.symbol, consolidatedSize);

    await this.addLog(`OOG: Opening ${direction} consolidated — ${this._formatNotional(consolidatedSize)} USDT, qty ${quantity}.`);
    await this.placeMarketOrder(this.symbol, side, quantity, direction);

    await this._waitForPositionChange(direction);
    // Force fresh position data from REST API to ensure per-side fields are set correctly
    // This prevents a stale WebSocket ACCOUNT_UPDATE from nulling position state during BE/TP calc
    await this.detectCurrentPosition(true);
    this.currentPositionQuantity = this.currentPositionQuantity || quantity;
    this.currentPosition = direction; // Re-assert direction in case WS event mutated it
    await this._calculateBreakevenAndFinalTp();

    this.gridMode = 'OUT_OF_GRID';
    this.outOfGridDirection = direction;
    this.outOfGridConsolidatedSize = consolidatedSize;
    this.outOfGridConsolidatedQuantity = quantity;
    this.outOfGridTranchesRemaining = this.gridLevelsPerSide;
    this.outOfGridTrancheTakenFlags = new Array(this.gridLevelsPerSide).fill(false);
    this.outOfGridPhase = 'INITIAL';
    this.currentPosition = direction;

    const eventType = direction === 'SHORT' ? 'OG_TRIGGER_S' : 'OG_TRIGGER_L';
    await this.saveStrategyFlowEvent(eventType, direction, currentPrice, quantity, null, null, null, null);
    await this.saveState();
  }

  // Process out-of-grid price crossings for one tick (INITIAL and REENTRY phases).
  async _processOutOfGridCrossings(prevPrice, currentPrice) {
    if (this.isTradingSequenceInProgress) return;

    const movingDown = currentPrice < prevPrice;
    const movingUp   = currentPrice > prevPrice;

    if (this.outOfGridPhase === 'INITIAL') {
      // INITIAL: wait for price to reverse back into the grid from the OOG side.
      // SHORT consolidated (opened going DOWN past L5−%) → re-enter when price bounces UP past L5.
      if (this.outOfGridDirection === 'SHORT' && movingUp) {
        const longLN = this.gridLevels.find(l => l.direction === 'LONG' && l.levelIndex === this.gridLevelsPerSide);
        if (longLN && prevPrice < longLN.price && currentPrice >= longLN.price) {
          this.isTradingSequenceInProgress = true;
          await this.addLog(`OOG REENTRY: Price ${this._formatPrice(currentPrice)} crossed LONG L${this.gridLevelsPerSide} @ ${this._formatPrice(longLN.price)} going UP.`);
          try { await this._reenterGrid('LONG', currentPrice); }
          finally { this.isTradingSequenceInProgress = false; }
          return;
        }
      }
      // LONG consolidated (opened going UP past S5+%) → re-enter when price reverses DOWN past S5.
      if (this.outOfGridDirection === 'LONG' && movingDown) {
        const shortLN = this.gridLevels.find(l => l.direction === 'SHORT' && l.levelIndex === this.gridLevelsPerSide);
        if (shortLN && prevPrice > shortLN.price && currentPrice <= shortLN.price) {
          this.isTradingSequenceInProgress = true;
          await this.addLog(`OOG REENTRY: Price ${this._formatPrice(currentPrice)} crossed SHORT L${this.gridLevelsPerSide} @ ${this._formatPrice(shortLN.price)} going DOWN.`);
          try { await this._reenterGrid('SHORT', currentPrice); }
          finally { this.isTradingSequenceInProgress = false; }
          return;
        }
      }
    } else if (this.outOfGridPhase === 'REENTRY') {
      if (this.outOfGridDirection === 'LONG') {
        // LONG consolidated in REENTRY: tranches fire as price moves UP toward anchor.
        // Opposite reversal: if price drops back to OOG SHORT Reversal, restart OOG SHORT.
        if (movingDown && this.oogShortReversalLevel !== null && prevPrice > this.oogShortReversalLevel && currentPrice <= this.oogShortReversalLevel) {
          this.isTradingSequenceInProgress = true;
          await this.addLog(`OOG REENTRY LONG: price hit OOG SHORT Reversal → restarting OOG SHORT.`);
          try {
            // Query actual position amount from Binance to avoid dust from rounding
            const currentPositions = await this.getCurrentPositions();
            const targetPos = currentPositions.find(p => p.symbol === this.symbol && parseFloat(p.positionAmt) > 0);
            const remainingQty = targetPos ? this.roundQuantity(Math.abs(parseFloat(targetPos.positionAmt))) : 0;
            if (remainingQty > 0) {
              await this.placeMarketOrder(this.symbol, 'SELL', remainingQty, 'LONG');
              await this._waitForPositionChange('NONE');
            }
            await this._triggerOutOfGrid('SHORT', currentPrice);
          } finally { this.isTradingSequenceInProgress = false; }
          return;
        }
        if (movingUp) {
          await this._processLongReentryTranches(prevPrice, currentPrice);
        }
      } else if (this.outOfGridDirection === 'SHORT') {
        // SHORT consolidated in REENTRY: tranches fire as price moves DOWN toward anchor.
        // Opposite reversal: if price rises back to OOG LONG Reversal, restart OOG LONG.
        if (movingUp && this.oogLongReversalLevel !== null && prevPrice < this.oogLongReversalLevel && currentPrice >= this.oogLongReversalLevel) {
          this.isTradingSequenceInProgress = true;
          await this.addLog(`OOG REENTRY SHORT: price hit OOG LONG Reversal → restarting OOG LONG.`);
          try {
            // Query actual position amount from Binance to avoid dust from rounding
            const currentPositions = await this.getCurrentPositions();
            const targetPos = currentPositions.find(p => p.symbol === this.symbol && parseFloat(p.positionAmt) < 0);
            const remainingQty = targetPos ? this.roundQuantity(Math.abs(parseFloat(targetPos.positionAmt))) : 0;
            if (remainingQty > 0) {
              await this.placeMarketOrder(this.symbol, 'BUY', remainingQty, 'SHORT');
              await this._waitForPositionChange('NONE');
            }
            await this._triggerOutOfGrid('LONG', currentPrice);
          } finally { this.isTradingSequenceInProgress = false; }
          return;
        }
        if (movingDown) {
          await this._processShortReentryTranches(prevPrice, currentPrice);
        }
      }
    }
  }

  // Flip OOG consolidated position at Level 5 crossings (INITIAL → REENTRY transition).
  async _reenterGrid(newDirection, currentPrice) {
    const oldDirection = this.outOfGridDirection;
    const closeSide = oldDirection === 'LONG' ? 'SELL' : 'BUY';
    const openSide  = newDirection === 'LONG' ? 'BUY' : 'SELL';

    // Query actual position amount from Binance to avoid dust from rounding
    const currentPositions = await this.getCurrentPositions();
    const targetPos = currentPositions.find(p => p.symbol === this.symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
    const closeQty = targetPos ? this.roundQuantity(Math.abs(parseFloat(targetPos.positionAmt))) : 0;
    if (closeQty > 0) {
      await this.addLog(`OOG REENTRY: Closing ${oldDirection} consolidated (qty ${closeQty}).`);
      await this.placeMarketOrder(this.symbol, closeSide, closeQty, oldDirection);
      await this._waitForPositionChange('NONE');
    }

    const newQty = await this._calculateAdjustedQuantity(this.symbol, this.outOfGridConsolidatedSize);
    await this.addLog(`OOG REENTRY: Opening ${newDirection} consolidated at same size ${this._formatNotional(this.outOfGridConsolidatedSize)} USDT, qty ${newQty}.`);
    await this.placeMarketOrder(this.symbol, openSide, newQty, newDirection);
    await this._waitForPositionChange(newDirection);

    this.outOfGridDirection = newDirection;
    this.outOfGridConsolidatedQuantity = newQty;
    this.outOfGridTranchesRemaining = this.gridLevelsPerSide;
    this.outOfGridTrancheTakenFlags = new Array(this.gridLevelsPerSide).fill(false);
    this.outOfGridPhase = 'REENTRY';
    this.currentPosition = newDirection;
    this.finalTpPrice = null;   // Tranches handle TP during OOG reentry
    this.breakevenPrice = null; // No single BE applies during tranche-based exit

    const eventType = newDirection === 'LONG' ? 'OG_REENTRY_L' : 'OG_REENTRY_S';
    await this.saveStrategyFlowEvent(eventType, newDirection, currentPrice, newQty, null, null, null, null);
    await this.saveState();
  }

  // Fire LONG consolidated tranche TPs as price moves UP from LONG Level 5 toward anchor.
  // Tranche sequence: L4 → L3 → L2 → L1 → anchor (OG_TP_L1 through OG_TP_L5).
  async _processLongReentryTranches(prevPrice, currentPrice) {
    const n = this.gridLevelsPerSide;
    const trancheTargets = [];
    for (let i = 0; i < n - 1; i++) {
      const levelIndex = n - 1 - i; // n-1, n-2, …, 1
      trancheTargets.push({
        idx: i,
        suffix: String(i + 1),
        getPrice: ((li) => () => this.gridLevels.find(l => l.direction === 'LONG' && l.levelIndex === li)?.price)(levelIndex),
      });
    }
    trancheTargets.push({ idx: n - 1, suffix: String(n), getPrice: () => this.anchorPrice });

    for (const t of trancheTargets) {
      if (this.outOfGridTrancheTakenFlags[t.idx]) continue;
      const targetPrice = t.getPrice();
      if (!targetPrice) continue;

      if (prevPrice < targetPrice && currentPrice >= targetPrice) {
        if (this.isTradingSequenceInProgress) break;
        this.isTradingSequenceInProgress = true;
        try {
          const trancheQty = this.roundQuantity((this.outOfGridConsolidatedQuantity || 0) / this.gridLevelsPerSide);
          if (trancheQty > 0) {
            await this.addLog(`OOG LONG tranche ${t.suffix}: TP at ${this._formatPrice(targetPrice)}, closing ${trancheQty} qty.`);
            const orderResult = await this.placeMarketOrder(this.symbol, 'SELL', trancheQty, 'LONG');
            await this._waitForOrderFill(orderResult.orderId);
          }
          this.outOfGridTrancheTakenFlags[t.idx] = true;
          this.outOfGridTranchesRemaining = Math.max(0, this.outOfGridTranchesRemaining - 1);
          await this.saveStrategyFlowEvent(`OG_TP_L${t.suffix}`, 'LONG', currentPrice, trancheQty, null, null, null, null);

          if (this.outOfGridTranchesRemaining === 0) {
            await this._waitForPositionChange('NONE');
            await this._exitOutOfGridMode();
          } else {
            await this.saveState();
          }
        } catch (error) {
          await this.addLog(`ERROR: OOG LONG tranche ${t.suffix}: ${error.message}`);
        } finally {
          this.isTradingSequenceInProgress = false;
        }
        if (this.gridMode === 'WITHIN') break;
      }
    }
  }

  // Fire SHORT consolidated tranche TPs as price moves DOWN from SHORT Level 5 toward anchor.
  // Tranche sequence: S(N-1) → … → S1 → anchor (OG_TP_S1 through OG_TP_S{N}).
  async _processShortReentryTranches(prevPrice, currentPrice) {
    const n = this.gridLevelsPerSide;
    const trancheTargets = [];
    for (let i = 0; i < n - 1; i++) {
      const levelIndex = n - 1 - i; // n-1, n-2, …, 1
      trancheTargets.push({
        idx: i,
        suffix: String(i + 1),
        getPrice: ((li) => () => this.gridLevels.find(l => l.direction === 'SHORT' && l.levelIndex === li)?.price)(levelIndex),
      });
    }
    trancheTargets.push({ idx: n - 1, suffix: String(n), getPrice: () => this.anchorPrice });

    for (const t of trancheTargets) {
      if (this.outOfGridTrancheTakenFlags[t.idx]) continue;
      const targetPrice = t.getPrice();
      if (!targetPrice) continue;

      if (prevPrice > targetPrice && currentPrice <= targetPrice) {
        if (this.isTradingSequenceInProgress) break;
        this.isTradingSequenceInProgress = true;
        try {
          const trancheQty = this.roundQuantity((this.outOfGridConsolidatedQuantity || 0) / this.gridLevelsPerSide);
          if (trancheQty > 0) {
            await this.addLog(`OOG SHORT tranche ${t.suffix}: TP at ${this._formatPrice(targetPrice)}, closing ${trancheQty} qty.`);
            const orderResult = await this.placeMarketOrder(this.symbol, 'BUY', trancheQty, 'SHORT');
            await this._waitForOrderFill(orderResult.orderId);
          }
          this.outOfGridTrancheTakenFlags[t.idx] = true;
          this.outOfGridTranchesRemaining = Math.max(0, this.outOfGridTranchesRemaining - 1);
          await this.saveStrategyFlowEvent(`OG_TP_S${t.suffix}`, 'SHORT', currentPrice, trancheQty, null, null, null, null);

          if (this.outOfGridTranchesRemaining === 0) {
            await this._waitForPositionChange('NONE');
            await this._exitOutOfGridMode();
          } else {
            await this.saveState();
          }
        } catch (error) {
          await this.addLog(`ERROR: OOG SHORT tranche ${t.suffix}: ${error.message}`);
        } finally {
          this.isTradingSequenceInProgress = false;
        }
        if (this.gridMode === 'WITHIN') break;
      }
    }
  }

  // Exit OOG mode: recalculate grid with updated base size, return to WITHIN mode.
  async _exitOutOfGridMode() {
    const newBaseSize = this.outOfGridConsolidatedSize || this.gridBaseSize || this.initialBasePositionSizeUSDT;
    this.gridBaseSize = newBaseSize;
    this.positionSizeUSDT = newBaseSize;

    // Rebuild all 10 grid levels around the fixed anchor, using the new base size.
    this.gridLevels = this._buildGridLevels(this.anchorPrice, this.gridBaseSize, this.gridSize);

    this.outOfGridDirection = null;
    this.outOfGridConsolidatedSize = null;
    this.outOfGridConsolidatedQuantity = null;
    this.outOfGridTranchesRemaining = 0;
    this.outOfGridTrancheTakenFlags = new Array(this.gridLevelsPerSide).fill(false);
    this.outOfGridPhase = null;
    this.currentPosition = 'NONE';
    this.gridMode = 'WITHIN';
    // _buildGridLevels above already creates fresh levels with tpedInCurrentSequence=false;
    // reset VWAP state explicitly since it lives on strategy, not on levels.
    this.sameTerritoryVwapShort = null;
    this.sameTerritoryVwapLong = null;

    await this.addLog(`OOG RESET: Returned to WITHIN grid. New base size: ${this._formatNotional(this.gridBaseSize)} USDT. Grid levels recalculated.`);
    await this.saveStrategyFlowEvent('OG_RESET', 'BOTH', this.anchorPrice, 0, null, null, null, null);
    await this.saveState();
  }

  // ===================================================================
  // END GRID TRADING SYSTEM
  // ===================================================================

  async start(config = {}) {
    await this.addLog(`Hey bro! Starting strategy.. Good luck!🤞`);

    // Generate unique strategyId at the start of the strategy execution
    this.strategyId = `strategy_${this.profileId.slice(-6)}_${Date.now()}`; // Use profileId for context
    
    // Set tradesCollectionRef for the new strategy
    this.tradesCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('trades');
    this.logsCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('logs'); // Initialize logs collection ref
    this.strategyFlowCollectionRef = this.firestore.collection('strategies').doc(this.strategyId).collection('strategyFlow'); // Initialize strategy flow collection ref

    this.symbol = config.symbol || 'BTCUSDT';

    // Strictly take positionSizeUSDT from config
    this.positionSizeUSDT = config.positionSizeUSDT;

    // Validate that positionSizeUSDT is provided and valid (minimum 120 USDT)
    if (this.positionSizeUSDT === null || this.positionSizeUSDT === undefined || this.positionSizeUSDT < 120) {
        throw new Error('Position size (positionSizeUSDT) must be at least 120 USDT.');
    }

    // Set initial base position size (no scaling, use full config size)
    this.initialBasePositionSizeUSDT = this.positionSizeUSDT; // Use full position size for initial entry
    this.MAX_POSITION_SIZE_USDT = (3 / 4) * this.positionSizeUSDT * 50; // Set MAX_POSITION_SIZE_USDT dynamically here
    this.reversalLevelPercentage = config.reversalLevelPercentage !== undefined ? config.reversalLevelPercentage : null;

    // Configure Grid Size from config (default: 0.003)
    this.gridSize = config.gridSize !== undefined ? config.gridSize : 0.003;

    // Configure Trading Mode from config
    this.tradingMode = config.tradingMode || 'NORMAL';

    // Configure Recovery Factor and Recovery Distance from config
    this.RECOVERY_FACTOR = config.recoveryFactor !== undefined ? config.recoveryFactor : 0.20;
    this.RECOVERY_DISTANCE = config.recoveryDistance !== undefined ? config.recoveryDistance : 0.005;

    // Anchor Mode config
    this.anchorMode = config.anchorMode || 'IMMEDIATE';
    this.targetAnchorPrice = config.targetAnchorPrice || null;
    this.priceType = config.priceType || 'MARK';

    // Reset position quantity on start
    this.entryPositionQuantity = null;
    this.currentPositionQuantity = null;
    // Reset Final TP states
    this.breakevenPrice = null;
    this.finalTpPrice = null;
    this.finalTpActive = false;
    this.finalTpOrderSent = false;
    this.breakevenPercentage = null;
    this.finalTpPercentage = null;
    // Reset accumulated PnL and fees for the new strategy run
    this.accumulatedRealizedPnL = 0;
    this.accumulatedTradingFees = 0;
    this.longAccumulatedRealizedPnL = 0;
    this.shortAccumulatedRealizedPnL = 0;
    this.longTradingFees = 0;
    this.shortTradingFees = 0;

    // Reset saved trade order IDs for the new strategy run
    this.savedTradeOrderIds.clear();

    // Reset summary section data
    this.reversalCount = 0;
    this.tradeSequence = '';
    this.profitPercentage = null;
    this.lastDynamicSizingReversalCount = 0;
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
        userId: this.userId,
        profileId: this.profileId,
        symbol: this.symbol,
        entryLevel: this.entryLevel,
        reversalLevel: this.reversalLevel,
        oogLongReversalLevel: this.oogLongReversalLevel,
        oogShortReversalLevel: this.oogShortReversalLevel,
        fixedReversalLevelsCalculated: this.fixedReversalLevelsCalculated,
        anchorMode: this.anchorMode,
        targetAnchorPrice: this.targetAnchorPrice,
        waitingForAnchor: this.waitingForAnchor,
        currentPosition: this.currentPosition,
        positionEntryPrice: this.positionEntryPrice,
        positionSize: this.positionSize,
        currentPrice: this.currentPrice,
        positionPnL: this.positionPnL,
        totalPnL: this.totalPnL,
        accumulatedRealizedPnL: this.accumulatedRealizedPnL,
        accumulatedTradingFees: this.accumulatedTradingFees,
        longPositionPnL: this.longPositionPnL,
        shortPositionPnL: this.shortPositionPnL,
        longAccumulatedRealizedPnL: this.longAccumulatedRealizedPnL,
        shortAccumulatedRealizedPnL: this.shortAccumulatedRealizedPnL,
        longTradingFees: this.longTradingFees,
        shortTradingFees: this.shortTradingFees,
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
        priceType: this.priceType,
        // Summary section data
        reversalCount: this.reversalCount,
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

    let positionModeText = 'Unknown';
    try {
      // Core setup steps that must happen first
      await this._getExchangeInfo(this.symbol);
      await this.setLeverage(this.symbol, DEFAULT_LEVERAGE);
      const currentPositionMode = await this.getPositionMode();
      positionModeText = currentPositionMode.dualSidePosition ? 'Hedge' : 'One-way';
      if (!currentPositionMode.dualSidePosition) {
        await this.setPositionMode(true); // Set to hedge mode
      } else {
        //await this.addLog(`Pos. mode already Hedge.`);
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

      // Set anchor mode — grid will be initialised by the price tick handler
      this.waitingForAnchor = true;
      if (this.anchorMode === 'IMMEDIATE') {
        await this.addLog(`Anchor Mode: IMMEDIATE — anchor will be captured on next price tick.`);
      } else {
        await this.addLog(`Anchor Mode: TARGET PRICE — waiting for market price to reach $${this._formatPrice(this.targetAnchorPrice)}.`);
      }

    } catch (error) {
      console.error(`Failed to initialize strategy settings: ${error.message}`); 
      await this.addLog(`ERROR: [TRADING_ERROR] During strategy initialization: ${error.message}`);
      // Ensure isRunning is false if initialization fails
      this.isRunning = false;
      this.isTradingSequenceInProgress = false; // Reset flag on error
      throw error;
    }

    await this.addLog(`Strategy started: ${this.strategyId}`);
    await this.addLog(`  Pair: ${this.symbol}`);
    await this.addLog(`  Initial Position Size: ${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT`);
    await this.addLog(`  Allowable Exposure: ${this._formatNotional(this.MAX_POSITION_SIZE_USDT)} USDT`);
    await this.addLog(`  Leverage: ${DEFAULT_LEVERAGE}x`);
    await this.addLog(`  Position Mode: ${positionModeText}`);
    await this.addLog(`  Reversal %: ${this.reversalLevelPercentage !== null ? `${this.reversalLevelPercentage}%` : 'N/A'}`);
    await this.addLog(`  Trading Mode: ${this.tradingMode}`);
    await this.addLog(`  Price Type: ${this.priceType === 'LAST' ? 'Last Price' : 'Mark Price'}`);
    await this.addLog(`  Recovery Factor: ${(this.RECOVERY_FACTOR * 100).toFixed(1)}%`);
    await this.addLog(`  Recovery Distance: ${(this.RECOVERY_DISTANCE * 100).toFixed(2)}%`);
    await this.addLog(`  Grid Size: ${(this.gridSize * 100).toFixed(2)}%`);
    await this.addLog(`  Anchor Mode: ${this.anchorMode === 'IMMEDIATE' ? 'Immediate' : `Target Price ($${this._formatPrice(this.targetAnchorPrice)})`}`);
    await this.addLog(`  Maximum Allowable Loss: ${this.maxAllowableLoss !== null ? `${this.maxAllowableLoss}` : 'N/A'}`);

    this.isRunning = true;

    // Start WebSocket health monitoring
    this._startWebSocketHealthMonitoring();
    //await this.addLog('[Health Check] WebSocket health monitoring started (checks every 5 minutes).');

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

    // Update anchor mode if provided (must be processed before targetAnchorPrice/captureNow)
    if (newConfig.anchorMode !== undefined && newConfig.anchorMode !== this.anchorMode) {
      const oldMode = this.anchorMode;
      this.anchorMode = newConfig.anchorMode;
      await this.addLog(`Updated Anchor Mode from ${oldMode} to ${this.anchorMode}.`);

      // If switching to IMMEDIATE, clear target price since it's no longer relevant
      if (this.anchorMode === 'IMMEDIATE') {
        this.targetAnchorPrice = null;
      }
    }

    // Update target anchor price while waiting for anchor (TARGET_PRICE mode only)
    if (newConfig.targetAnchorPrice !== undefined && newConfig.targetAnchorPrice !== null) {
      if (this.anchorPrice !== null) {
        throw new Error('Cannot change target anchor price: anchor is already captured.');
      }
      const oldPrice = this.targetAnchorPrice;
      this.targetAnchorPrice = newConfig.targetAnchorPrice;
      await this.addLog(`Updated target anchor price from ${oldPrice !== null ? '$' + this._formatPrice(oldPrice) : 'N/A'} to $${this._formatPrice(this.targetAnchorPrice)}.`);
    }

    // Capture anchor immediately at current price (only valid while waiting)
    if (newConfig.captureNow === true) {
      if (this.anchorPrice !== null) {
        throw new Error('Cannot capture anchor: anchor is already captured.');
      }
      const currentPrice = this.lastProcessedPrice;
      if (currentPrice === null) {
        throw new Error('Cannot capture anchor: no price tick received yet.');
      }
      await this.addLog(`Capture Now triggered. Initializing grid at current price $${this._formatPrice(currentPrice)}.`);
      await this.initializeGrid(currentPrice);
      this.waitingForAnchor = false;
    }

    // Handle restart-specific position size (used only for first trade after restart, doesn't affect base)
    if (newConfig.restartPositionSizeUSDT !== undefined && newConfig.restartPositionSizeUSDT !== null) {
      this.restartPositionSizeUSDT = newConfig.restartPositionSizeUSDT;
      await this.addLog(`Restart position size set to ${this._formatNotional(this.restartPositionSizeUSDT)} USDT for next opening trade.`);
      await this.addLog(`Note: Base position size (${this._formatNotional(this.initialBasePositionSizeUSDT)} USDT) remains unchanged for dynamic sizing.`);
    }

    // Update price type if provided (requires WebSocket reconnection)
    if (newConfig.priceType !== undefined && newConfig.priceType !== this.priceType) {
      const oldPriceType = this.priceType;
      this.priceType = newConfig.priceType;
      await this.addLog(`Updated priceType from ${oldPriceType === 'LAST' ? 'Last Price' : 'Mark Price'} to ${this.priceType === 'LAST' ? 'Last Price' : 'Mark Price'}.`);
      await this.addLog(`Reconnecting real-time price WebSocket with new price stream...`);
      // Reconnect the real-time WebSocket with new price type
      try {
        this.connectRealtimeWebSocket();
        await this.addLog(`Successfully initiated WebSocket reconnection with ${this.priceType === 'LAST' ? 'Last Price' : 'Mark Price'} stream.`);
      } catch (error) {
        await this.addLog(`ERROR: Failed to reconnect WebSocket: ${error.message}`);
      }
    }

    // Update Recovery Factor if provided
    if (newConfig.recoveryFactor !== undefined) {
      const oldValue = this.RECOVERY_FACTOR;
      this.RECOVERY_FACTOR = newConfig.recoveryFactor;
      await this.addLog(`Updated Recovery Factor from ${(oldValue * 100).toFixed(1)}% to ${(this.RECOVERY_FACTOR * 100).toFixed(1)}%.`);
    }

    // Update Recovery Distance if provided
    if (newConfig.recoveryDistance !== undefined) {
      const oldValue = this.RECOVERY_DISTANCE;
      this.RECOVERY_DISTANCE = newConfig.recoveryDistance;
      await this.addLog(`Updated Recovery Distance from ${(oldValue * 100).toFixed(2)}% to ${(this.RECOVERY_DISTANCE * 100).toFixed(2)}%.`);
    }

    // Update Trading Mode if provided
    if (newConfig.tradingMode !== undefined && newConfig.tradingMode !== this.tradingMode) {
      const oldMode = this.tradingMode;
      this.tradingMode = newConfig.tradingMode;
      await this.addLog(`Updated Trading Mode from ${oldMode} to ${this.tradingMode}.`);
    }

    // Update Reversal Level Percentage if provided
    if (newConfig.reversalLevelPercentage !== undefined && newConfig.reversalLevelPercentage !== null) {
      const oldValue = this.reversalLevelPercentage;
      this.reversalLevelPercentage = newConfig.reversalLevelPercentage;

      await this.addLog(`Updated Reversal Level from ${oldValue !== null ? oldValue + '%' : 'N/A'} to ${this.reversalLevelPercentage}%.`);

      // Recalculate OOG reversal levels from S5/L5 if the grid is initialized.
      if (this.gridLevels && this.gridLevels.length > 0) {
        const s5 = this.gridLevels.find(l => l.direction === 'SHORT' && l.levelIndex === this.gridLevelsPerSide);
        const l5 = this.gridLevels.find(l => l.direction === 'LONG'  && l.levelIndex === this.gridLevelsPerSide);
        if (s5 && l5) {
          const oldLong  = this.oogLongReversalLevel;
          const oldShort = this.oogShortReversalLevel;
          this.oogLongReversalLevel  = this._calculateAdjustedPrice(s5.price, this.reversalLevelPercentage, true);
          this.oogShortReversalLevel = this._calculateAdjustedPrice(l5.price, this.reversalLevelPercentage, false);
          this.reversalLevel = this.oogLongReversalLevel;
          this.initialReversalLevel = this.oogLongReversalLevel;
          await this.addLog(`OOG Reversal Levels recalculated — LONG: ${this._formatPrice(oldLong)} → ${this._formatPrice(this.oogLongReversalLevel)}, SHORT: ${this._formatPrice(oldShort)} → ${this._formatPrice(this.oogShortReversalLevel)}`);
        }
      }
    }

    // Update Grid Size if provided
    if (newConfig.gridSize !== undefined && newConfig.gridSize !== null) {
      const oldValue = this.gridSize;
      this.gridSize = newConfig.gridSize;
      await this.addLog(`Updated Grid Size from ${(oldValue * 100).toFixed(2)}% to ${(this.gridSize * 100).toFixed(2)}%.`);
    }

    // Update Grid Levels Per Side if provided
    if (newConfig.gridLevelsPerSide !== undefined && newConfig.gridLevelsPerSide !== null) {
      const oldValue = this.gridLevelsPerSide;
      this.gridLevelsPerSide = newConfig.gridLevelsPerSide;
      await this.addLog(`Updated Grid Levels Per Side from ${oldValue} to ${this.gridLevelsPerSide}.`);
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
          //await this.addLog(`Recalculated final TP based on custom LONG price target.`);
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
          //await this.addLog(`Recalculated final TP based on custom SHORT price target.`);
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

      await this.saveState(); // Persist the updated config
      await this.addLog('Strategy configuration updated and saved.');

      return { success: true, message: 'Configuration updated successfully' };
    } catch (error) {
      console.error('Error updating config:', error);
      await this.addLog(`ERROR: Failed to update configuration: ${error.message}`);
      throw error;
    }
  }

  // Reset anchor and prepare for grid reinitialization after restart
  async executeInitialOrdersAfterRestart() {
    try {
      await this.addLog('===== RESETTING ANCHOR FOR GRID RESTART =====');

      // Verify strategy is running
      if (!this.isRunning) {
        await this.addLog('ERROR: Cannot reset anchor — strategy is not running.');
        throw new Error('Strategy is not running.');
      }

      // Safety check: close any lingering positions before resetting anchor
      await this.detectCurrentPosition();
      if (this.currentPosition !== 'NONE') {
        await this.addLog('WARNING: Position still open during restart. Closing before resetting anchor.');
        await this.closeAllPositions();
        await this._waitForPositionChange('NONE');
        await this.addLog('All positions confirmed closed before restart.');
      }

      // Apply restart position size if provided
      if (this.restartPositionSizeUSDT !== null && this.restartPositionSizeUSDT > 0) {
        if (this.restartPositionSizeUSDT < 120) {
          await this.addLog('ERROR: Restart position size must be at least 120 USDT.');
          throw new Error('Restart position size must be at least 120 USDT.');
        }
        this.positionSizeUSDT = this.restartPositionSizeUSDT;
        this.gridBaseSize = this.restartPositionSizeUSDT;
        await this.addLog(`Restart: Using restart position size: ${this._formatNotional(this.positionSizeUSDT)} USDT.`);
        this.restartPositionSizeUSDT = null;
      }

      // Reset anchor so the grid reinitializes on the next price tick
      this.anchorPrice = null;
      this.gridMode = 'WITHIN';
      this.waitingForAnchor = true;
      this.sameTerritoryVwapShort = null;
      this.sameTerritoryVwapLong = null;

      // Clear OOG state — position was closed before restart, stale OOG quantities
      // would otherwise inflate longPositionQuantity / shortPositionQuantity in status reports
      this.outOfGridDirection = null;
      this.outOfGridConsolidatedSize = null;
      this.outOfGridConsolidatedQuantity = null;
      this.outOfGridTranchesRemaining = 0;
      this.outOfGridTrancheTakenFlags = new Array(this.gridLevelsPerSide).fill(false);
      this.outOfGridPhase = null;

      if (this.anchorMode === 'IMMEDIATE') {
        await this.addLog('Restart: Anchor Mode IMMEDIATE — anchor will be captured on next price tick.');
      } else {
        await this.addLog(`Restart: Anchor Mode TARGET PRICE — waiting for price to reach ${this._formatPrice(this.targetAnchorPrice)}.`);
      }

      await this.saveState();
      return { success: true, anchorMode: this.anchorMode };

    } catch (error) {
      console.error(`Failed to reset anchor after restart: ${error.message}`);
      await this.addLog(`ERROR: [TRADING_ERROR] During restart anchor reset: ${error.message}`);
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

    // Cancel ALL open orders on both sides
    await this.cancelAllOrders();
    this.longLimitOrderId = null;
    this.shortLimitOrderId = null;

    // Clear any pending initial LIMIT order timeouts
    for (const [orderId, { timeoutId }] of this.pendingInitialLimitOrders.entries()) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.pendingInitialLimitOrders.delete(orderId);
    }

    // Close ALL active positions (both LONG and SHORT sides)
    try {
      await this.closeAllPositions();
      await this._waitForPositionChange('NONE');
      await this.addLog('All positions confirmed as NONE after stop request.');
    } catch (err) {
      console.error(`Failed to close all positions for ${this.symbol}: ${err.message}`);
      await this.addLog(`ERROR: [TRADING_ERROR] Failed to close all positions: ${err.message}`);
      // Even if closing fails, still attempt to reset state and save
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

    // Check if initial position was ever filled
    if (!this.strategyStartTime) {
      // No position was ever filled, mark for deletion
      console.log(`[${this.strategyId}] Strategy will be deleted - no initial position was filled`);
      this.willBeDeleted = true;
    } else {
      // Normal stop - update document with final state
      await this.saveState();
    }

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

    // If strategy was marked for deletion, delete document and subcollections now
    if (this.willBeDeleted) {
      try {
        console.log(`[${this.strategyId}] Deleting strategy document and subcollections`);

        // Delete logs subcollection
        if (this.logsCollectionRef) {
          await this.deleteSubcollection(this.logsCollectionRef, 'logs');
        }

        // Delete trades subcollection
        if (this.tradesCollectionRef) {
          await this.deleteSubcollection(this.tradesCollectionRef, 'trades');
        }

        // Finally, delete the parent strategy document
        await this.firestore
          .collection('strategies')
          .doc(this.strategyId)
          .delete();

        console.log(`[${this.strategyId}] Strategy document and all subcollections deleted successfully`);
      } catch (error) {
        console.error(`[${this.strategyId}] Failed to delete strategy document and subcollections: ${error.message}`);
      }
    }

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
    this.longPositionPnL = 0;
    this.shortPositionPnL = 0;
    this.longAccumulatedRealizedPnL = 0;
    this.shortAccumulatedRealizedPnL = 0;
    this.longTradingFees = 0;
    this.shortTradingFees = 0;
    this._longEntryPrice = null;
    this._longPositionSize = null;
    this._shortEntryPrice = null;
    this._shortPositionSize = null;

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

    // Reset anchor mode to defaults
    this.anchorMode = 'IMMEDIATE';
    this.targetAnchorPrice = null;
    this.waitingForAnchor = false;

    // Reset summary section data
    this.reversalCount = 0;
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
      gridSize: this.gridSize,
      anchorMode: this.anchorMode,
      targetAnchorPrice: this.targetAnchorPrice,
      waitingForAnchor: this.waitingForAnchor,
      tpAtBreakeven: this.tpAtBreakeven,
      customFinalTpLong: this.customFinalTpLong,
      customFinalTpShort: this.customFinalTpShort,
      desiredProfitUSDT: this.desiredProfitUSDT,
      // Summary fields
      entryLevel: this.entryLevel,
      reversalLevel: this.reversalLevel,
      reversalCount: this.reversalCount,
      breakevenPrice: this.breakevenPrice,
      finalTpPrice: this.finalTpPrice,
      initialBasePositionSizeUSDT: this.initialBasePositionSizeUSDT,
      MAX_POSITION_SIZE_USDT: this.MAX_POSITION_SIZE_USDT,
      tradingMode: this.tradingMode,
      priceType: this.priceType,
      RECOVERY_FACTOR: this.RECOVERY_FACTOR,
      RECOVERY_DISTANCE: this.RECOVERY_DISTANCE,
      middleLevelTrailingEnabled: this.middleLevelTrailingEnabled,
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
        longPositionPnL: this.longPositionPnL,
        shortPositionPnL: this.shortPositionPnL,
        longAccumulatedRealizedPnL: this.longAccumulatedRealizedPnL,
        shortAccumulatedRealizedPnL: this.shortAccumulatedRealizedPnL,
        longTradingFees: this.longTradingFees,
        shortTradingFees: this.shortTradingFees,
        currentPositionQuantity: this.currentPositionQuantity,
        longPositionQuantity: this.gridLevels
          .filter(l => l.direction === 'LONG' && l.state === 'POSITION_OPEN')
          .reduce((sum, l) => sum + (l.positionQuantity || 0), 0)
          + (this.outOfGridDirection === 'LONG' && this.outOfGridConsolidatedQuantity
            ? (this.outOfGridTranchesRemaining / this.gridLevelsPerSide) * this.outOfGridConsolidatedQuantity
            : 0),
        shortPositionQuantity: this.gridLevels
          .filter(l => l.direction === 'SHORT' && l.state === 'POSITION_OPEN')
          .reduce((sum, l) => sum + (l.positionQuantity || 0), 0)
          + (this.outOfGridDirection === 'SHORT' && this.outOfGridConsolidatedQuantity
            ? (this.outOfGridTranchesRemaining / this.gridLevelsPerSide) * this.outOfGridConsolidatedQuantity
            : 0),
      },
      // Grid trading state
      gridState: {
        gridSize: this.gridSize,
        gridLevelsPerSide: this.gridLevelsPerSide,
        anchorPrice: this.anchorPrice,
        gridMode: this.gridMode,
        gridBaseSize: this.gridBaseSize,
        gridLevels: this.gridLevels,
        outOfGridDirection: this.outOfGridDirection,
        outOfGridConsolidatedSize: this.outOfGridConsolidatedSize,
        outOfGridConsolidatedQuantity: this.outOfGridConsolidatedQuantity,
        outOfGridTranchesRemaining: this.outOfGridTranchesRemaining,
        outOfGridTrancheTakenFlags: this.outOfGridTrancheTakenFlags,
        outOfGridPhase: this.outOfGridPhase,
        oogLongReversalLevel: this.oogLongReversalLevel,
        oogShortReversalLevel: this.oogShortReversalLevel,
        sameTerritoryVwapShort: this.sameTerritoryVwapShort,
        sameTerritoryVwapLong: this.sameTerritoryVwapLong,
      },
      // Virtual position state
      virtualPositionState: {
        virtualPosition: this.virtualPosition,
        virtualEntryPrice: this.virtualEntryPrice,
        virtualReversalLevel: this.virtualReversalLevel,
        virtualHighestFavorablePrice: this.virtualHighestFavorablePrice,
        virtualLowestFavorablePrice: this.virtualLowestFavorablePrice,
        virtualTrailingReversalActive: this.virtualTrailingReversalActive,
        virtualTicksMovedInFavor: this.virtualTicksMovedInFavor,
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