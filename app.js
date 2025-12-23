import express from 'express';
import cors from 'cors';
import TradingStrategy from './strategy.js';
import http from 'http';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { initializeFirebaseAdmin } from './pushNotificationHelper.js';
import { precisionFormatter } from './precisionUtils.js';

const app = express();
const PORT = process.env.PORT || 3000; // Default to 3000 if PORT is not set

// Track startup status for health checks
let startupStatus = {
  phase: 'initializing',
  startTime: Date.now(),
  firestoreReady: false,
  firebaseReady: false,
  serverReady: false
};

// Middleware
app.use(cors({
  origin: [
    'https://ycbot.trade',
    'https://www.ycbot.trade'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
}));

app.use(express.json());

// Lightweight startup status endpoint - responds immediately without waiting for full initialization
app.get('/startup-status', (req, res) => {
  const uptime = Math.floor((Date.now() - startupStatus.startTime) / 1000);
  res.json({
    phase: startupStatus.phase,
    uptime,
    firestoreReady: startupStatus.firestoreReady,
    firebaseReady: startupStatus.firebaseReady,
    serverReady: startupStatus.serverReady,
    timestamp: new Date().toISOString()
  });
});

// Initialize Firestore globally
startupStatus.phase = 'initializing_firestore';
const firestore = new Firestore({
  projectId: 'ycbot-6f336',
  databaseId: '(default)',
});
startupStatus.firestoreReady = true;

// Initialize Firebase Admin SDK for push notifications
startupStatus.phase = 'initializing_firebase';
initializeFirebaseAdmin();
startupStatus.firebaseReady = true;
startupStatus.phase = 'ready';

// Global map to store active strategy instances, keyed by strategyId
const activeStrategies = new Map();

// Create HTTP server
const server = http.createServer(app);

// Health check endpoint
app.get('/health', (req, res) => {
  const strategiesStatus = {};
  activeStrategies.forEach((strategy, strategyId) => {
    strategiesStatus[strategyId] = {
      strategyRunning: strategy.isRunning,
      realtimeWsConnected: strategy.realtimeWsConnected,
      userDataWsConnected: strategy.userDataWsConnected
    };
  });

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeStrategiesCount: activeStrategies.size,
    strategies: strategiesStatus,
    vmInstanceHealthy: true // NEW: Explicitly indicate VM instance is healthy
  });
});

// Start strategy endpoint
app.post('/strategy/start', async (req, res) => {
  try {
    const { profileId, gcpProxyUrl, sharedVmProxyGcfUrl, config, userId } = req.body;

    if (!profileId || !gcpProxyUrl || !sharedVmProxyGcfUrl || !config) {
      console.error('Missing required parameters for /strategy/start');
      return res.status(400).json({ error: 'profileId, gcpProxyUrl, sharedVmProxyGcfUrl, and config are required.' });
    }

    if (!userId) {
      console.error('Missing userId for balance validation');
      return res.status(400).json({ error: 'userId is required for balance validation.' });
    }

    const requiredCapital = config.positionSizeUSDT || 0;
    if (requiredCapital <= 0) {
      return res.status(400).json({ error: 'Invalid initial capital for balance validation.' });
    }

    // Validate recovery factor if provided
    if (config.recoveryFactor !== undefined && config.recoveryFactor !== null) {
      if (![10, 15, 20].includes(config.recoveryFactor)) {
        return res.status(400).json({ error: 'Invalid recoveryFactor. Must be 10, 15, or 20.' });
      }
    }

    // Validate trading mode if provided
    if (config.tradingMode !== undefined && config.tradingMode !== null) {
      if (!['AGGRESSIVE', 'NORMAL', 'CONSERVATIVE'].includes(config.tradingMode)) {
        return res.status(400).json({ error: 'Invalid tradingMode. Must be AGGRESSIVE, NORMAL, or CONSERVATIVE.' });
      }
    }

    // PRE-START VALIDATION 1: Validate Reload Balance (for platform fees)
    // This balance is checked to ensure the user can cover platform fees
    const walletRef = firestore.collection('users').doc(userId).collection('wallets').doc('default');
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      return res.status(400).json({
        error: 'Reload wallet not found. Please reload your account first.',
        code: 'WALLET_NOT_FOUND'
      });
    }

    const reloadBalance = walletDoc.data()?.balance || 0;
    if (reloadBalance <= 0) {
      return res.status(400).json({
        error: `Insufficient Reload Balance. You have ${precisionFormatter.formatNotional(reloadBalance)} USDT. Please reload your wallet to cover platform fees.`,
        code: 'INSUFFICIENT_RELOAD_BALANCE',
        reloadBalance,
        requiredCapital
      });
    }

    // PRE-START VALIDATION 2: Validate Binance Futures Balance (for trading capital)
    // This balance is checked BEFORE the strategy starts to ensure sufficient trading capital
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-User-Id': profileId,
      };

      const binanceAccountResponse = await fetch(sharedVmProxyGcfUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          endpoint: '/fapi/v2/account',
          method: 'GET',
          params: {},
          signed: true,
          apiType: 'futures',
          profileBinanceApiGcfUrl: gcpProxyUrl,
        }),
      });

      if (!binanceAccountResponse.ok) {
        const errorData = await binanceAccountResponse.json().catch(() => ({}));
        console.error('Failed to fetch Binance Futures Balance:', errorData);
        return res.status(400).json({
          error: 'Failed to fetch Binance Futures Balance. Please check your API credentials and try again.',
          code: 'BINANCE_ACCOUNT_FETCH_FAILED'
        });
      }

      const binanceAccountInfo = await binanceAccountResponse.json();
      const futuresBalance = parseFloat(binanceAccountInfo.totalWalletBalance || 0);

      if (futuresBalance < requiredCapital) {
        return res.status(400).json({
          error: `Insufficient Binance Futures Balance. You have ${precisionFormatter.formatNotional(futuresBalance)} USDT in your Binance Futures account but need ${precisionFormatter.formatNotional(requiredCapital)} USDT. Please deposit more USDT to your Binance Futures account.`,
          code: 'INSUFFICIENT_FUTURES_BALANCE',
          futuresBalance,
          requiredCapital
        });
      }

      console.log(`✓ Binance Futures Balance validated: ${precisionFormatter.formatNotional(futuresBalance)} USDT >= ${precisionFormatter.formatNotional(requiredCapital)} USDT`);
    } catch (error) {
      console.error('Error validating Binance Futures Balance:', error);
      return res.status(500).json({
        error: 'Failed to validate Binance Futures Balance. Please try again.',
        code: 'BINANCE_VALIDATION_ERROR'
      });
    }

    let existingStrategyIdForProfile = null;
    for (const [sId, strategy] of activeStrategies.entries()) {
      if (strategy.profileId === profileId && strategy.isRunning) {
        existingStrategyIdForProfile = sId;
        break;
      }
    }

    if (existingStrategyIdForProfile) {
      console.error(`Strategy for profile ${profileId} (strategyId: ${existingStrategyIdForProfile}) is already running`);
      return res.status(400).json({
        error: `Strategy for profile ${profileId} is already running`,
        strategyId: existingStrategyIdForProfile
      });
    }

    const strategy = new TradingStrategy(gcpProxyUrl, profileId, sharedVmProxyGcfUrl);
    strategy.userId = userId;
    const strategyId = await strategy.start(config);

    activeStrategies.set(strategyId, strategy);

    console.log(`✓ Strategy ${strategyId} started successfully. Reload Balance: ${reloadBalance} USDT | Futures Balance validated: ${requiredCapital} USDT`);
    res.json({
      success: true,
      strategyId,
      message: 'Ycbot trading strategy started successfully',
      balancesValidated: true,
      reloadBalance,
      futuresBalanceValidated: requiredCapital
    });
  } catch (error) {
    console.error('Failed to start strategy:', error);
    console.error('Full error object for /strategy/start:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stop strategy endpoint
app.post('/strategy/stop', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running with ID ${strategyId}`
      });
    }

    // Set stopping status in Firestore immediately
    await firestore.collection('strategies').doc(strategyId).update({
      stoppingStatus: 'in_progress',
      stoppingStartedAt: Timestamp.now()
    });

    // Respond immediately to prevent timeout
    res.json({
      success: true,
      stopping: true,
      message: 'Strategy stop initiated',
      strategyId
    });

    // Continue with stop operations asynchronously
    setImmediate(async () => {
      try {
        // Wrap stop operation with timeout protection
        const stopPromise = strategy.stop();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stop operation timeout')), 45000)
        );

        await Promise.race([stopPromise, timeoutPromise]);
        activeStrategies.delete(strategyId);

        const strategyDoc = await firestore.collection('strategies').doc(strategyId).get();
        if (!strategyDoc.exists) {
          console.warn(`Strategy ${strategyId} not found in Firestore, skipping fee calculation`);
          await firestore.collection('strategies').doc(strategyId).update({
            stoppingStatus: 'completed',
            stoppingCompletedAt: Timestamp.now()
          });
          return;
        }

        const strategyData = strategyDoc.data();
        const finalPnL = strategyData.totalPnL || 0;
        const userId = strategy.userId || strategyData.userId;
        const profileId = strategy.profileId || strategyData.profileId;

        if (!userId) {
          console.error(`UserId not found for strategy ${strategyId}, skipping fee calculation`);
          await firestore.collection('strategies').doc(strategyId).update({
            stoppingStatus: 'completed',
            stoppingCompletedAt: Timestamp.now()
          });
          return;
        }

        let feeResult = null;
        if (finalPnL > 0) {
          const FEE_PERCENTAGE = 0.15;
          const feeAmount = Math.round(finalPnL * FEE_PERCENTAGE * 100) / 100;
          const feeId = firestore.collection('temp').doc().id;

          const strategyFee = {
            feeId,
            strategyId,
            userId,
            profileId,
            initialPnL: 0,
            finalPnL,
            feeAmount,
            feePercentage: FEE_PERCENTAGE,
            calculatedAt: Timestamp.now(),
            status: 'calculated',
          };

          await firestore.collection('strategy_fees').doc(feeId).set(strategyFee);

          const walletRef = firestore.collection('users').doc(userId).collection('wallets').doc('default');
          const walletDoc = await walletRef.get();

          if (!walletDoc.exists) {
            console.error(`Wallet not found for user ${userId}, fee calculated but not deducted`);
            feeResult = {
              feeCalculated: true,
              feeAmount,
              feeDeducted: false,
              reason: 'Wallet not found'
            };
          } else {
            const currentBalance = walletDoc.data()?.balance || 0;
            let deductAmount = feeAmount;
            let feeStatus = 'deducted';

            if (currentBalance < feeAmount) {
              deductAmount = currentBalance;
              feeStatus = 'insufficient_balance';
              console.warn(`Insufficient balance for full fee. Available: ${currentBalance}, Required: ${feeAmount}`);
            }

            const newBalance = Math.max(0, currentBalance - deductAmount);
            const now = Timestamp.now();

            await walletRef.update({
              balance: newBalance,
              updatedAt: now,
              lastTransactionAt: now,
            });

            const transactionId = firestore.collection('temp').doc().id;
            const transactionRef = walletRef.collection('transactions').doc(transactionId);
            await transactionRef.set({
              transactionId,
              type: 'debit',
              amount: deductAmount,
              balanceBefore: currentBalance,
              balanceAfter: newBalance,
              reason: 'platform_fee',
              relatedResourceType: 'strategy',
              relatedResourceId: strategyId,
              createdAt: now,
            });

            await firestore.collection('strategy_fees').doc(feeId).update({
              status: feeStatus,
              deductedAt: now,
              balanceBefore: currentBalance,
              balanceAfter: newBalance,
            });

            if (deductAmount > 0) {
              const earningId = firestore.collection('temp').doc().id;
              await firestore.collection('platform_earnings').doc(earningId).set({
                earningId,
                feeId,
                strategyId,
                userId,
                amount: deductAmount,
                collectedAt: now,
                source: 'performance_fee',
              });
            }

            console.log(`Performance fee of ${precisionFormatter.formatNotional(deductAmount)} USDT deducted from user ${userId}. Status: ${feeStatus}`);

            feeResult = {
              feeCalculated: true,
              feeAmount,
              feeDeducted: true,
              deductedAmount: deductAmount,
              newBalance,
              status: feeStatus
            };
          }
        } else {
          console.log(`Strategy ${strategyId} ended with non-positive PnL (${finalPnL}). No fee charged.`);
          feeResult = {
            feeCalculated: false,
            finalPnL,
            reason: 'Non-positive PnL'
          };
        }

        // Mark as completed
        await firestore.collection('strategies').doc(strategyId).update({
          stoppingStatus: 'completed',
          stoppingCompletedAt: Timestamp.now()
        });

        console.log(`Strategy ${strategyId} stopped successfully. Fee result:`, feeResult);
      } catch (error) {
        console.error(`Error in async stop operation for strategy ${strategyId}:`, error);
        // Mark as error but still consider it stopped
        await firestore.collection('strategies').doc(strategyId).update({
          stoppingStatus: 'error',
          stoppingError: error.message,
          stoppingCompletedAt: Timestamp.now()
        }).catch(err => console.error('Failed to update stopping status:', err));
      }
    });
  } catch (error) {
    console.error('Error stopping strategy:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restart strategy endpoint
app.post('/strategy/restart', async (req, res) => {
  try {
    const { strategyId, newConfig } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    if (!newConfig) {
      return res.status(400).json({ error: 'newConfig is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running with ID ${strategyId}`
      });
    }

    console.log(`Restarting strategy ${strategyId} with new configuration...`);

    const { realizedPnL, tradingFee } = await strategy.closeCurrentPosition();

    // Wait for position to become NONE before proceeding (similar to reversal logic)
    if (strategy.currentPosition !== 'NONE') {
      console.log(`Waiting for position to become NONE after closing...`);
      await strategy._waitForPositionChange('NONE');
      console.log(`Position confirmed as NONE. Proceeding with restart.`);
      // Add a small delay to ensure the position state is fully settled
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await strategy.cancelAllOrders();

    // Validate and update accumulated values - ensure they're valid numbers
    const validRealizedPnL = (typeof realizedPnL === 'number' && Number.isFinite(realizedPnL)) ? realizedPnL : 0;
    const validTradingFee = (typeof tradingFee === 'number' && Number.isFinite(tradingFee)) ? tradingFee : 0;

    strategy.accumulatedRealizedPnL += validRealizedPnL;
    strategy.accumulatedTradingFees += validTradingFee;

    // Additional validation after addition to prevent NaN propagation
    if (!Number.isFinite(strategy.accumulatedRealizedPnL)) {
      console.warn(`[${strategyId}] accumulatedRealizedPnL became invalid after update, resetting to 0`);
      strategy.accumulatedRealizedPnL = 0;
    }
    if (!Number.isFinite(strategy.accumulatedTradingFees)) {
      console.warn(`[${strategyId}] accumulatedTradingFees became invalid after update, resetting to 0`);
      strategy.accumulatedTradingFees = 0;
    }

    console.log(`Position closed. PnL: ${precisionFormatter.formatNotional(validRealizedPnL)}, Fee: ${precisionFormatter.formatNotional(validTradingFee)}`);
    console.log(`New accumulated PnL: ${precisionFormatter.formatNotional(strategy.accumulatedRealizedPnL)}, Total fees: ${precisionFormatter.formatNotional(strategy.accumulatedTradingFees)}`);

    // Reset BE level and Final TP level (will be recalculated when new position opens)
    strategy.breakevenPrice = null;
    strategy.finalTpPrice = null;
    strategy.breakevenPercentage = null;
    strategy.finalTpPercentage = null;
    strategy.customFinalTpLevel = null;
    strategy.tpAtBreakeven = false;
    strategy.finalTpActive = false;
    strategy.finalTpOrderSent = false;

    await strategy.updateConfig(newConfig);

    // Execute initial orders after config update (for both MARKET and LIMIT orders)
    let orderExecutionResult = null;
    try {
      orderExecutionResult = await strategy.executeInitialOrdersAfterRestart();
      console.log(`Initial orders executed after restart: ${JSON.stringify(orderExecutionResult)}`);
    } catch (orderError) {
      console.error(`Failed to execute initial orders after restart: ${orderError.message}`);
      // Don't fail the entire restart - log the error and continue
      orderExecutionResult = { success: false, error: orderError.message };
    }

    const strategyRef = firestore.collection('strategies').doc(strategyId);
    const strategyDoc = await strategyRef.get();

    if (strategyDoc.exists) {
      // Clean configSnapshot by removing undefined values
      const cleanedConfigSnapshot = {};
      for (const key in newConfig) {
        if (newConfig[key] !== undefined) {
          cleanedConfigSnapshot[key] = newConfig[key];
        }
      }

      const restartEvent = {
        timestamp: Timestamp.now(),
        reason: 'manual_restart',
        configSnapshot: cleanedConfigSnapshot,
        realizedPnLAtRestart: validRealizedPnL,
        tradingFeeAtRestart: validTradingFee,
      };

      const currentData = strategyDoc.data();
      const restartEvents = currentData.restartEvents || [];
      restartEvents.push(restartEvent);

      // Build update object dynamically, only including defined values
      // Explicitly validate accumulated values before saving
      const updateData = {
        restartEvents,
        lastRestartTime: Timestamp.now(),
        accumulatedRealizedPnL: Number.isFinite(strategy.accumulatedRealizedPnL) ? strategy.accumulatedRealizedPnL : 0,
        accumulatedTradingFees: Number.isFinite(strategy.accumulatedTradingFees) ? strategy.accumulatedTradingFees : 0,
        // Reset BE and Final TP levels
        breakevenPrice: null,
        finalTpPrice: null,
        breakevenPercentage: null,
        finalTpPercentage: null,
        customFinalTpLevel: null,
        tpAtBreakeven: false,
      };

      // Only add fields if they have defined values
      if (newConfig.orderType !== undefined) {
        updateData.orderType = newConfig.orderType;
      } else if (currentData.orderType !== undefined) {
        updateData.orderType = currentData.orderType;
      }

      if (newConfig.supportZoneEnabled !== undefined) {
        updateData.supportZoneEnabled = newConfig.supportZoneEnabled;
      } else if (currentData.supportZoneEnabled !== undefined) {
        updateData.supportZoneEnabled = currentData.supportZoneEnabled;
      }

      if (newConfig.resistanceZoneEnabled !== undefined) {
        updateData.resistanceZoneEnabled = newConfig.resistanceZoneEnabled;
      } else if (currentData.resistanceZoneEnabled !== undefined) {
        updateData.resistanceZoneEnabled = currentData.resistanceZoneEnabled;
      }

      // Handle limit prices: explicitly set to null for disabled zones in MARKET mode
      const finalOrderType = updateData.orderType || strategy.orderType;
      const finalSupportEnabled = updateData.supportZoneEnabled ?? strategy.supportZoneEnabled;
      const finalResistanceEnabled = updateData.resistanceZoneEnabled ?? strategy.resistanceZoneEnabled;

      if (finalOrderType === 'MARKET') {
        // For MARKET orders, clear the limit price for the disabled zone
        if (finalSupportEnabled && !finalResistanceEnabled) {
          // Support zone enabled (LONG) - set sell limit price to null
          updateData.buyLimitPrice = newConfig.buyLimitPrice !== undefined ? newConfig.buyLimitPrice : currentData.buyLimitPrice;
          updateData.sellLimitPrice = null;
        } else if (finalResistanceEnabled && !finalSupportEnabled) {
          // Resistance zone enabled (SHORT) - set buy limit price to null
          updateData.buyLimitPrice = null;
          updateData.sellLimitPrice = newConfig.sellLimitPrice !== undefined ? newConfig.sellLimitPrice : currentData.sellLimitPrice;
        }
      } else {
        // For LIMIT orders, use provided values or fallback to current values
        if (newConfig.buyLimitPrice !== undefined) {
          updateData.buyLimitPrice = newConfig.buyLimitPrice;
        } else if (currentData.buyLimitPrice !== undefined) {
          updateData.buyLimitPrice = currentData.buyLimitPrice;
        }

        if (newConfig.sellLimitPrice !== undefined) {
          updateData.sellLimitPrice = newConfig.sellLimitPrice;
        } else if (currentData.sellLimitPrice !== undefined) {
          updateData.sellLimitPrice = currentData.sellLimitPrice;
        }
      }

      if (newConfig.initialBasePositionSizeUSDT !== undefined) {
        updateData.initialBasePositionSizeUSDT = newConfig.initialBasePositionSizeUSDT;
      } else if (currentData.initialBasePositionSizeUSDT !== undefined) {
        updateData.initialBasePositionSizeUSDT = currentData.initialBasePositionSizeUSDT;
      }

      await strategyRef.update(updateData);
    }

    res.json({
      success: true,
      message: `Strategy ${strategyId} restarted successfully`,
      accumulatedRealizedPnL: strategy.accumulatedRealizedPnL,
      accumulatedTradingFees: strategy.accumulatedTradingFees,
      strategyStartTime: strategy.strategyStartTime,
      initialBasePositionSizeUSDT: strategy.initialBasePositionSizeUSDT,
      orderType: strategy.orderType,
      supportZoneEnabled: strategy.supportZoneEnabled,
      resistanceZoneEnabled: strategy.resistanceZoneEnabled,
      buyLimitPrice: strategy.buyLimitPrice,
      sellLimitPrice: strategy.sellLimitPrice,
      orderExecution: orderExecutionResult, // Include order execution result
      currentPosition: strategy.currentPosition, // Include current position state
    });
  } catch (error) {
    console.error('Failed to restart strategy:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Update strategy levels endpoint
app.post('/strategy/update-levels', async (req, res) => {
  try {
    // MODIFIED: Removed supportLevel and resistanceLevel from req.body
    const { strategyId, reversalThreshold, enableSupport, enableResistance } = req.body; 

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running with ID ${strategyId} to update levels.`
      });
    }

    // Basic validation for enable flags remains
    // REMOVED: Validation for supportLevel and resistanceLevel
    if (enableSupport && (reversalThreshold === null || reversalThreshold === undefined)) {
      return res.status(400).json({
        error: 'Reversal threshold is required when support is enabled.'
      });
    }
    if (enableResistance && (reversalThreshold === null || reversalThreshold === undefined)) {
      return res.status(400).json({
        error: 'Reversal threshold is required when resistance is enabled'
      });
    }

    // Pass the new configuration to the strategy instance
    await strategy.updateLevels({
      reversalThreshold, // MODIFIED: Pass reversalThreshold instead of support/resistance levels
      enableSupport,
      enableResistance
    });

    res.json({
      success: true,
      message: `Strategy levels for ${strategyId} updated successfully.`
    });
  } catch (error) {
    console.error('Failed to update strategy levels:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// NEW: Endpoint to update strategy configuration (e.g., initialBasePositionSizeUSDT, newMaxExposureUSDT, partialTpSizes, partialTpLevels, customFinalTpLong, customFinalTpShort, tpAtBreakeven)
app.post('/strategy/update-config', async (req, res) => {
  try {
    const { strategyId, initialBasePositionSizeUSDT, newMaxExposureUSDT, partialTpSizes, partialTpLevels, customFinalTpLong, customFinalTpShort, tpAtBreakeven, desiredProfitUSDT, moveReversalLevel } = req.body; // Expect strategyId and optional config fields

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running with ID ${strategyId} to update configuration.`
      });
    }

    // Validate initialBasePositionSizeUSDT if provided
    if (initialBasePositionSizeUSDT !== undefined && initialBasePositionSizeUSDT !== null) {
      if (isNaN(initialBasePositionSizeUSDT) || initialBasePositionSizeUSDT <= 0) {
        return res.status(400).json({
          error: 'Invalid initialBasePositionSizeUSDT provided.'
        });
      }
    }

    // Validate newMaxExposureUSDT if provided
    if (newMaxExposureUSDT !== undefined && newMaxExposureUSDT !== null) {
      if (isNaN(newMaxExposureUSDT) || newMaxExposureUSDT <= 0) {
        return res.status(400).json({
          error: 'Invalid newMaxExposureUSDT provided. Must be a positive number.'
        });
      }
    }

    // Validate partialTpSizes if provided
    if (partialTpSizes !== undefined && partialTpSizes !== null) {
      if (!Array.isArray(partialTpSizes) || partialTpSizes.length !== 3) {
        return res.status(400).json({
          error: 'Invalid partialTpSizes provided. Must be an array of 3 values.'
        });
      }
      for (const size of partialTpSizes) {
        if (isNaN(size) || size < 0 || size > 90) {
          return res.status(400).json({
            error: 'Invalid partialTpSizes value. Each size must be between 0 and 90.'
          });
        }
      }
    }

    // Validate partialTpLevels if provided
    if (partialTpLevels !== undefined && partialTpLevels !== null) {
      if (!Array.isArray(partialTpLevels) || partialTpLevels.length !== 3) {
        return res.status(400).json({
          error: 'Invalid partialTpLevels provided. Must be an array of 3 values.'
        });
      }
      for (const level of partialTpLevels) {
        if (isNaN(level) || level <= 0) {
          return res.status(400).json({
            error: 'Invalid partialTpLevels value. Each level must be a positive number.'
          });
        }
      }
    }

    // Validate customFinalTpLong if provided (expects a price value for LONG positions)
    // Allow null to reset to auto-calculation
    if (customFinalTpLong !== undefined && customFinalTpLong !== null) {
      if (isNaN(customFinalTpLong) || customFinalTpLong <= 0) {
        return res.status(400).json({
          error: 'Invalid customFinalTpLong provided. Must be a positive price value.'
        });
      }
    }

    // Validate customFinalTpShort if provided (expects a price value for SHORT positions)
    // Allow null to reset to auto-calculation
    if (customFinalTpShort !== undefined && customFinalTpShort !== null) {
      if (isNaN(customFinalTpShort) || customFinalTpShort <= 0) {
        return res.status(400).json({
          error: 'Invalid customFinalTpShort provided. Must be a positive price value.'
        });
      }
    }

    // Validate tpAtBreakeven if provided
    if (tpAtBreakeven !== undefined && tpAtBreakeven !== null) {
      if (typeof tpAtBreakeven !== 'boolean') {
        return res.status(400).json({
          error: 'Invalid tpAtBreakeven provided. Must be a boolean value.'
        });
      }
    }

    // Validate desiredProfitUSDT if provided
    if (desiredProfitUSDT !== undefined && desiredProfitUSDT !== null) {
      if (isNaN(desiredProfitUSDT) || desiredProfitUSDT <= 0) {
        return res.status(400).json({
          error: 'Invalid desiredProfitUSDT provided. Must be a positive number.'
        });
      }
    }

    // Validate moveReversalLevel if provided
    if (moveReversalLevel !== undefined && moveReversalLevel !== null) {
      if (moveReversalLevel !== 'DO_NOT_MOVE' && moveReversalLevel !== 'MOVE_TO_BREAKEVEN') {
        return res.status(400).json({
          error: 'Invalid moveReversalLevel provided. Must be either DO_NOT_MOVE or MOVE_TO_BREAKEVEN.'
        });
      }
    }

    // Build update config object
    const updateConfig = {};
    if (initialBasePositionSizeUSDT !== undefined && initialBasePositionSizeUSDT !== null) {
      updateConfig.initialBasePositionSizeUSDT = initialBasePositionSizeUSDT;
    }
    if (newMaxExposureUSDT !== undefined && newMaxExposureUSDT !== null) {
      updateConfig.newMaxExposureUSDT = newMaxExposureUSDT;
    }
    if (partialTpSizes !== undefined && partialTpSizes !== null) {
      updateConfig.partialTpSizes = partialTpSizes;
    }
    if (partialTpLevels !== undefined && partialTpLevels !== null) {
      updateConfig.partialTpLevels = partialTpLevels;
    }
    // Handle customFinalTpLong: allow null to reset to auto-calculation
    if (customFinalTpLong !== undefined) {
      updateConfig.customFinalTpLong = customFinalTpLong;
    }
    // Handle customFinalTpShort: allow null to reset to auto-calculation
    if (customFinalTpShort !== undefined) {
      updateConfig.customFinalTpShort = customFinalTpShort;
    }
    if (tpAtBreakeven !== undefined && tpAtBreakeven !== null) {
      updateConfig.tpAtBreakeven = tpAtBreakeven;
    }
    // Handle desiredProfitUSDT: allow null to clear target
    if (desiredProfitUSDT !== undefined) {
      updateConfig.desiredProfitUSDT = desiredProfitUSDT;
    }
    if (moveReversalLevel !== undefined && moveReversalLevel !== null) {
      updateConfig.moveReversalLevel = moveReversalLevel;
    }

    await strategy.updateConfig(updateConfig);

    res.json({
      success: true,
      message: `Strategy configuration for ${strategyId} updated successfully.`
    });
  } catch (error) {
    console.error('Failed to update strategy config:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get strategy status endpoint
app.get('/strategy/status', async (req, res) => {
  try {
    const { strategyId } = req.query; // Get strategyId from query params

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.json({
        isRunning: false,
        strategy: null
      });
    }

    const status = await strategy.getStatus();

    // Helper function to validate and sanitize numeric values
    const sanitizeNumber = (value, defaultValue = null) => {
      if (value === null || value === undefined) return defaultValue;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      return defaultValue;
    };

    res.json({
      isRunning: strategy.isRunning,
      strategyId: strategy.strategyId,
      strategy: status,
      currentState: {
        currentPosition: strategy.currentPosition,
        thresholdLevel: strategy.thresholdLevel,
        thresholdType: strategy.thresholdType,
        positionEntryPrice: sanitizeNumber(strategy.positionEntryPrice),
        positionSize: sanitizeNumber(strategy.positionSize),
        currentPrice: sanitizeNumber(strategy.currentPrice),
        positionPnL: sanitizeNumber(strategy.positionPnL),
        totalPnL: sanitizeNumber(strategy.totalPnL),
        accumulatedRealizedPnL: sanitizeNumber(strategy.accumulatedRealizedPnL, 0),
        accumulatedTradingFees: sanitizeNumber(strategy.accumulatedTradingFees, 0),
        currentPositionQuantity: sanitizeNumber(strategy.currentPositionQuantity),
      }
    });
  } catch (error) {
    console.error('Failed to get strategy status:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// New endpoint to save PnL to Firestore
app.post('/strategy/save-pnl', async (req, res) => {
  try {
    const { strategyId } = req.body; // Expect strategyId

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running with ID ${strategyId} to save PnL.`
      });
    }
    await strategy.saveState();
    res.json({
      success: true,
      message: `Current PnL and strategy state for ${strategyId} saved to Firestore.`
    });
  } catch (error) {
    console.error('Failed to save PnL to Firestore:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// New endpoint to fetch strategy-specific trades
app.get('/strategy/:strategyId/trades', async (req, res) => {
  try {
    const { strategyId } = req.params;
    // Hardcode Firestore project ID and database ID
    const tradesRef = firestore.collection('strategies').doc(strategyId).collection('trades');
    const snapshot = await tradesRef.orderBy('time', 'desc').get(); // Order by trade time (Binance trade time)
    
    const trades = snapshot.docs.map(doc => ({
      id: doc.id, // Document ID
      ...doc.data()
    }));
    
    res.json(trades);
  } catch (error) {
    console.error('Failed to fetch strategy trades:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// NEW: Endpoint to fetch strategy-specific logs
app.get('/strategy/:strategyId/logs', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const logsRef = firestore.collection('strategies').doc(strategyId).collection('logs');
    const snapshot = await logsRef.orderBy('timestamp', 'asc').get(); // Order by timestamp ascending
    
    const logs = snapshot.docs.map(doc => ({
      id: doc.id,
      message: doc.data().message,
      timestamp: doc.data().timestamp.toDate().getTime(), // Convert Firestore Timestamp to milliseconds
    }));
    
    res.json(logs);
  } catch (error) {
    console.error('Failed to fetch strategy logs:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint to fetch futures balance history (DEPRECATED - no longer used)
app.get('/wallet-history', async (req, res) => {
  res.status(410).json({
    error: 'This endpoint has been deprecated. Futures balance history is no longer tracked.',
    timestamp: new Date().toISOString()
  });
});

// List all strategies endpoint
app.get('/strategies', async (req, res) => {
  try {
    // For a "one user per VM" setup, this endpoint should ideally be filtered by the user associated with this VM.
    // However, since the VM itself doesn't inherently know the user ID without a request context,
    // we'll fetch all strategies from Firestore and let the frontend filter.
    // In a more advanced setup, you'd pass a userId to this endpoint.
    const strategiesRef = firestore.collection('strategies');
    const snapshot = await strategiesRef.orderBy('createdAt', 'desc').get(); // Order by creation date, newest first
    
    const strategies = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        strategyId: doc.id,
        profileId: data.profileId, // ADDED: Include profileId from Firestore document
        symbol: data.symbol,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null, // Convert Firestore Timestamp to ISO string
        totalPnL: data.totalPnL || 0,
        accumulatedRealizedPnL: data.accumulatedRealizedPnL || 0,
        accumulatedTradingFees: data.accumulatedTradingFees || 0,
        isRunning: activeStrategies.has(doc.id) && activeStrategies.get(doc.id).isRunning, // Check if currently running on this VM
      };
    });
    
    res.json({ strategies });
  } catch (error) {
    console.error('Failed to list strategies:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// New endpoint to fetch specific strategy details
app.get('/strategies/:strategyId', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const strategyDoc = await firestore.collection('strategies').doc(strategyId).get();

    if (!strategyDoc.exists) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const data = strategyDoc.data();
    const formattedData = { ...data };

    // Convert Firestore Timestamps to ISO strings for frontend consumption
    if (formattedData.createdAt && typeof formattedData.createdAt.toDate === 'function') {
      formattedData.createdAt = formattedData.createdAt.toDate().toISOString();
    }
    if (formattedData.updatedAt && typeof formattedData.updatedAt.toDate === 'function') {
      formattedData.updatedAt = formattedData.updatedAt.toDate().toISOString();
    }
    if (formattedData.strategyStartTime && typeof formattedData.strategyStartTime.toDate === 'function') {
      formattedData.strategyStartTime = formattedData.strategyStartTime.toDate().toISOString();
    }
    if (formattedData.strategyEndTime && typeof formattedData.strategyEndTime.toDate === 'function') {
      formattedData.strategyEndTime = formattedData.strategyEndTime.toDate().toISOString();
    }

    res.json(formattedData);
  } catch (error) {
    console.error('Failed to fetch strategy details:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Resume strategy endpoint
app.post('/strategy/resume/:strategyId', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { gcpProxyUrl } = req.body; // Expect gcpProxyUrl in body for resume

    if (!gcpProxyUrl) {
      return res.status(400).json({ error: 'gcpProxyUrl is required to resume a strategy.' });
    }

    if (activeStrategies.has(strategyId) && activeStrategies.get(strategyId).isRunning) {
      return res.status(400).json({
        error: `Strategy with ID ${strategyId} is already running`
      });
    }

    const strategy = new TradingStrategy(gcpProxyUrl); // Initialize with provided GCF URL
    strategy.strategyId = strategyId; // Set strategyId for the instance
    
    const loaded = await strategy.loadState(strategyId);
    if (!loaded) {
      return res.status(404).json({
        error: 'Strategy not found'
      });
    }

    strategy.isRunning = true;
    strategy.connectRealtimeWebSocket(); // Connect real-time WS
    strategy.connectUserDataStream(); // Connect user data WS
    await strategy.addLog('🔄 Ycbot strategy resumed from saved state (manual resume)');
    await strategy.saveState();
    activeStrategies.set(strategyId, strategy); // Add to map

    res.json({
      success: true,
      strategyId,
      message: 'Ycbot strategy resumed successfully'
    });
  } catch (error) {
    console.error('Failed to resume strategy:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Graceful shutdown handling
const shutdown = async () => {
  console.log('Received shutdown signal, stopping all active strategies...');
  for (const [strategyId, strategy] of activeStrategies.entries()) {
    if (strategy.isRunning) {
      console.log(`Stopping strategy ${strategyId}...`);
      await strategy.stop();
    }
  }
  console.log('All strategies stopped. Exiting.');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============================
// Testing Endpoints (Admin Only)
// ============================

// Force disconnect Real-time Price WebSocket
app.post('/test/force-disconnect-realtime-ws', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found or not active' });
    }

    if (!strategy.isRunning) {
      return res.status(400).json({ error: 'Strategy is not running' });
    }

    // Force close the Real-time WebSocket
    if (strategy.realtimeWs) {
      await strategy.addLog('[TEST] Manually forcing Real-time Price WebSocket disconnection for testing...');
      strategy.realtimeWs.terminate();
      res.json({
        success: true,
        message: 'Real-time Price WebSocket forcefully disconnected for testing',
        strategyId
      });
    } else {
      res.status(400).json({ error: 'Real-time Price WebSocket is not connected' });
    }
  } catch (error) {
    console.error('Error forcing Real-time WebSocket disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force disconnect User Data WebSocket
app.post('/test/force-disconnect-userdata-ws', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found or not active' });
    }

    if (!strategy.isRunning) {
      return res.status(400).json({ error: 'Strategy is not running' });
    }

    // Force close the User Data WebSocket
    if (strategy.userDataWs) {
      await strategy.addLog('[TEST] Manually forcing User Data WebSocket disconnection for testing...');
      strategy.userDataWs.terminate();
      res.json({
        success: true,
        message: 'User Data WebSocket forcefully disconnected for testing',
        strategyId
      });
    } else {
      res.status(400).json({ error: 'User Data WebSocket is not connected' });
    }
  } catch (error) {
    console.error('Error forcing User Data WebSocket disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force disconnect both WebSockets
app.post('/test/force-disconnect-websockets', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found or not active' });
    }

    if (!strategy.isRunning) {
      return res.status(400).json({ error: 'Strategy is not running' });
    }

    await strategy.addLog('[TEST] Manually forcing both WebSocket connections to disconnect for testing...');

    let realtimeDisconnected = false;
    let userDataDisconnected = false;

    // Force close the Real-time WebSocket
    if (strategy.realtimeWs) {
      strategy.realtimeWs.terminate();
      realtimeDisconnected = true;
    }

    // Force close the User Data WebSocket
    if (strategy.userDataWs) {
      strategy.userDataWs.terminate();
      userDataDisconnected = true;
    }

    res.json({
      success: true,
      message: 'Both WebSockets forcefully disconnected for testing',
      strategyId,
      realtimeDisconnected,
      userDataDisconnected
    });
  } catch (error) {
    console.error('Error forcing WebSocket disconnects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Invalidate listenKey (simulates expired key)
app.post('/test/invalidate-listenkey', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found or not active' });
    }

    if (!strategy.isRunning) {
      return res.status(400).json({ error: 'Strategy is not running' });
    }

    if (!strategy.listenKey) {
      return res.status(400).json({ error: 'No active listenKey found' });
    }

    await strategy.addLog('[TEST] Manually invalidating listenKey to test renewal mechanism...');

    // Set listenKey to an invalid value to simulate expiration
    const originalListenKey = strategy.listenKey;
    strategy.listenKey = 'INVALID_TEST_KEY_' + Date.now();

    // Close the User Data WebSocket to trigger reconnection with invalid key
    if (strategy.userDataWs) {
      strategy.userDataWs.terminate();
    }

    res.json({
      success: true,
      message: 'ListenKey invalidated for testing. Watch for renewal attempts.',
      strategyId,
      originalListenKey: originalListenKey.substring(0, 10) + '...',
      invalidKey: strategy.listenKey.substring(0, 20) + '...'
    });
  } catch (error) {
    console.error('Error invalidating listenKey:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear listenKey completely (tests full re-acquisition)
app.post('/test/force-clear-listenkey', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found or not active' });
    }

    if (!strategy.isRunning) {
      return res.status(400).json({ error: 'Strategy is not running' });
    }

    await strategy.addLog('[TEST] Manually clearing listenKey and stopping refresh interval for testing...');

    // Clear listenKey refresh interval
    if (strategy.listenKeyRefreshInterval) {
      clearInterval(strategy.listenKeyRefreshInterval);
      strategy.listenKeyRefreshInterval = null;
    }

    // Clear listenKey
    const hadListenKey = !!strategy.listenKey;
    strategy.listenKey = null;

    // Close User Data WebSocket
    if (strategy.userDataWs) {
      strategy.userDataWs.terminate();
    }

    res.json({
      success: true,
      message: 'ListenKey cleared. Watch for complete re-acquisition process.',
      strategyId,
      hadListenKey,
      refreshIntervalCleared: true
    });
  } catch (error) {
    console.error('Error clearing listenKey:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset reconnection state (clear retry counters and timers)
app.post('/test/reset-reconnection-state', async (req, res) => {
  try {
    const { strategyId } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found or not active' });
    }

    if (!strategy.isRunning) {
      return res.status(400).json({ error: 'Strategy is not running' });
    }

    await strategy.addLog('[TEST] Resetting reconnection state (clearing retry counters and timers)...');

    // Reset reconnection attempt counters
    strategy.realtimeReconnectAttempts = 0;
    strategy.userDataReconnectAttempts = 0;
    strategy.listenKeyRetryAttempts = 0;

    // Clear reconnection timeouts if they exist
    if (strategy.realtimeReconnectTimeout) {
      clearTimeout(strategy.realtimeReconnectTimeout);
      strategy.realtimeReconnectTimeout = null;
    }

    if (strategy.userDataReconnectTimeout) {
      clearTimeout(strategy.userDataReconnectTimeout);
      strategy.userDataReconnectTimeout = null;
    }

    res.json({
      success: true,
      message: 'Reconnection state reset successfully',
      strategyId,
      resetCounters: {
        realtimeReconnectAttempts: 0,
        userDataReconnectAttempts: 0,
        listenKeyRetryAttempts: 0
      }
    });
  } catch (error) {
    console.error('Error resetting reconnection state:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
server.listen(PORT, () => {
  startupStatus.serverReady = true;
  startupStatus.phase = 'ready';
  console.log(`🚀 YcBot API server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Startup status: http://localhost:${PORT}/startup-status`);
  console.log(`🤞 Good luck bro! On the road to Million now`);
});

export default app;
