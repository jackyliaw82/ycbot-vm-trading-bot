import express from 'express';
import cors from 'cors';
import TradingStrategy from './strategy.js';
import http from 'http';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { initializeFirebaseAdmin } from './pushNotificationHelper.js';

const app = express();
const PORT = process.env.PORT || 3000; // Default to 3000 if PORT is not set

// Initialize Firestore globally
const firestore = new Firestore({
  projectId: 'ycbot-6f336',
  databaseId: '(default)',
});

// Initialize Firebase Admin SDK for push notifications
initializeFirebaseAdmin();

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

    const requiredBalance = config.positionSizeUSDT || 0;
    if (requiredBalance <= 0) {
      return res.status(400).json({ error: 'Invalid position size for balance validation.' });
    }

    const walletRef = firestore.collection('users').doc(userId).collection('wallets').doc('default');
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      return res.status(400).json({
        error: 'Wallet not found. Please reload your account first.',
        code: 'WALLET_NOT_FOUND'
      });
    }

    const currentBalance = walletDoc.data()?.balance || 0;
    if (currentBalance < requiredBalance) {
      return res.status(400).json({
        error: `Insufficient reload balance. You have ${currentBalance.toFixed(2)} USDT but need ${requiredBalance.toFixed(2)} USDT.`,
        code: 'INSUFFICIENT_BALANCE',
        currentBalance,
        requiredBalance
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

    console.log(`Strategy ${strategyId} started successfully with validated balance: ${currentBalance} USDT`);
    res.json({
      success: true,
      strategyId,
      message: 'Ycbot trading strategy started successfully',
      balanceValidated: true,
      currentBalance
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

    await strategy.stop();
    activeStrategies.delete(strategyId);

    const strategyDoc = await firestore.collection('strategies').doc(strategyId).get();
    if (!strategyDoc.exists) {
      console.warn(`Strategy ${strategyId} not found in Firestore, skipping fee calculation`);
      return res.json({
        success: true,
        message: `Ycbot strategy ${strategyId} stopped successfully`,
        feeProcessed: false
      });
    }

    const strategyData = strategyDoc.data();
    const finalPnL = strategyData.totalPnL || 0;
    const userId = strategy.userId || strategyData.userId;
    const profileId = strategy.profileId || strategyData.profileId;

    if (!userId) {
      console.error(`UserId not found for strategy ${strategyId}, skipping fee calculation`);
      return res.json({
        success: true,
        message: `Ycbot strategy ${strategyId} stopped successfully`,
        feeProcessed: false,
        error: 'UserId not found'
      });
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

        console.log(`Performance fee of ${deductAmount.toFixed(2)} USDT deducted from user ${userId}. Status: ${feeStatus}`);

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

    res.json({
      success: true,
      message: `Ycbot strategy ${strategyId} stopped successfully`,
      feeProcessed: true,
      feeDetails: feeResult
    });
  } catch (error) {
    console.error('Failed to stop strategy:', error);
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

// NEW: Endpoint to update strategy configuration (e.g., initialBasePositionSizeUSDT)
app.post('/strategy/update-config', async (req, res) => {
  try {
    const { strategyId, initialBasePositionSizeUSDT } = req.body; // Expect strategyId

    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running with ID ${strategyId} to update configuration.`
      });
    }

    if (initialBasePositionSizeUSDT === undefined || initialBasePositionSizeUSDT === null || isNaN(initialBasePositionSizeUSDT) || initialBasePositionSizeUSDT <= 0) {
      return res.status(400).json({
        error: 'Invalid initialBasePositionSizeUSDT provided.'
      });
    }

    await strategy.updateConfig({ initialBasePositionSizeUSDT });

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
    
    res.json({
      isRunning: strategy.isRunning,
      strategyId: strategy.strategyId,
      strategy: status,
      currentState: {
        currentPosition: strategy.currentPosition,
        thresholdLevel: strategy.thresholdLevel,
        thresholdType: strategy.thresholdType,
        positionEntryPrice: strategy.positionEntryPrice,
        positionSize: strategy.positionSize,
        currentPrice: strategy.currentPrice,
        positionPnL: strategy.positionPnL,
        totalPnL: strategy.totalPnL,
        accumulatedRealizedPnL: strategy.accumulatedRealizedPnL,
        accumulatedTradingFees: strategy.accumulatedTradingFees,
        currentPositionQuantity: strategy.currentPositionQuantity,
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

// NEW: Endpoint to fetch wallet history
app.get('/wallet-history', async (req, res) => {
  try {
    let query = firestore.collection('wallet_history').orderBy('timestamp');

    const { startDate, endDate, profileId } = req.query;
    
    if (profileId) {
      query = query.where('profileId', '==', profileId);
    }
    if (startDate) {
      query = query.where('timestamp', '>=', new Date(startDate));
    }
    if (endDate) {
      // To include the entire end date, set the filter to be strictly less than the start of the next day
      const nextDay = new Date(endDate);
      nextDay.setDate(nextDay.getDate() + 1); // Increment to the next day
      query = query.where('timestamp', '<', nextDay);
    }

    const snapshot = await query.get();
    const history = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(history);
  } catch (error) {
    console.error('Failed to fetch wallet history:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
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

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 YcBot API server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🤞 Good luck bro! On the road to Million now`);
});

export default app;
