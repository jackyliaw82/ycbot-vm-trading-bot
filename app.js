import express from 'express';
import cors from 'cors';
import TradingStrategy from './strategy.js';
import http from 'http';
import { Firestore } from '@google-cloud/firestore';

const app = express();
const PORT = process.env.PORT || 3000; // Default to 3000 if PORT is not set

// Initialize Firestore globally
const firestore = new Firestore({
  projectId: 'ycbot-6f336', // Hardcode Firestore project ID
  databaseId: '(default)', // Hardcode Firestore database ID
});

// Middleware
app.use(cors({
  origin: [
    'https://ycbot.trade',
    'https://www.ycbot.trade',
    "https://https://zp1v56uxy8rdx5ypatb0ockcb9tr6a-oci3--5173--96435430.local-credentialless.webcontainer-api.io/",
    'http://localhost:5173',
    'https://localhost:5173',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
}));

app.use(express.json());

// Global map to store active strategy instances, keyed by strategyId (profileId)
const activeStrategies = new Map();

// Create HTTP server
const server = http.createServer(app);

// Health check endpoint
app.get('/health', (req, res) => {
  const strategiesStatus = {};
  activeStrategies.forEach((strategy, strategyId) => {
    strategiesStatus[strategyId] = {
      strategyRunning: strategy.isRunning,
      klineWsConnected: strategy.klineWsConnected,
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
    const { profileId, gcpProxyUrl, config } = req.body;

    if (!profileId || !gcpProxyUrl || !config) {
      return res.status(400).json({ error: 'profileId, gcpProxyUrl, and config are required.' });
    }

    if (activeStrategies.has(profileId) && activeStrategies.get(profileId).isRunning) {
      return res.status(400).json({
        error: `Strategy for profile ${profileId} is already running`,
        strategyId: profileId
      });
    }

    // Validate required parameters for Ycbot strategy
    if (config.enableSupport && (config.supportLevel === null || config.supportLevel === undefined)) {
      return res.status(400).json({
        error: 'Support level is required when support is enabled'
      });
    }
    
    if (config.enableResistance && (config.resistanceLevel === null || config.resistanceLevel === undefined)) {
      return res.status(400).json({
        error: 'Resistance level is required when resistance is enabled'
      });
    }

    const strategy = new TradingStrategy(gcpProxyUrl, profileId); // Pass profileId to constructor
    const strategyId = await strategy.start(config, profileId); // Pass profileId as strategyId
    activeStrategies.set(strategyId, strategy);

    res.json({
      success: true,
      strategyId,
      message: 'Ycbot trading strategy started successfully'
    });
  } catch (error) {
    console.error('Failed to start strategy:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stop strategy endpoint
app.post('/strategy/stop', async (req, res) => {
  try {
    const { profileId } = req.body;

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required.' });
    }

    const strategy = activeStrategies.get(profileId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running for profile ${profileId}`
      });
    }

    await strategy.stop();
    activeStrategies.delete(profileId); // Remove from map after stopping
    
    res.json({
      success: true,
      message: `Ycbot strategy for profile ${profileId} stopped successfully`
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
    const { profileId, supportLevel, resistanceLevel, enableSupport, enableResistance } = req.body;

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required.' });
    }

    const strategy = activeStrategies.get(profileId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running for profile ${profileId} to update levels.`
      });
    }

    // Basic validation
    if (enableSupport && (supportLevel === null || supportLevel === undefined)) {
      return res.status(400).json({
        error: 'Support level is required when support is enabled.'
      });
    }
    if (enableResistance && (resistanceLevel === null || resistanceLevel === undefined)) {
      return res.status(400).json({
        error: 'Resistance level is required when resistance is enabled.'
      });
    }

    // Pass the new configuration to the strategy instance
    await strategy.updateLevels({
      supportLevel,
      resistanceLevel,
      enableSupport,
      enableResistance
    });

    res.json({
      success: true,
      message: `Strategy levels for profile ${profileId} updated successfully.`
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
    const { profileId, initialBasePositionSizeUSDT } = req.body;

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required.' });
    }

    const strategy = activeStrategies.get(profileId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running for profile ${profileId} to update configuration.`
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
      message: `Strategy configuration for profile ${profileId} updated successfully.`
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
    const { profileId } = req.query; // Get profileId from query params

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required.' });
    }

    const strategy = activeStrategies.get(profileId);
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
    const { profileId } = req.body;

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required.' });
    }

    const strategy = activeStrategies.get(profileId);
    if (!strategy || !strategy.isRunning) {
      return res.status(400).json({
        error: `No strategy is currently running for profile ${profileId} to save PnL.`
      });
    }
    await strategy.saveState();
    res.json({
      success: true,
      message: `Current PnL and strategy state for profile ${profileId} saved to Firestore.`
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

    const { startDate, endDate, strategyId } = req.query; // Added strategyId to query

    if (strategyId) {
      query = query.where('strategyId', '==', strategyId); // Filter by strategyId if provided
    }
    if (startDate) {
      query = query.where('timestamp', '>=', new Date(startDate));
    }
    if (endDate) {
      query = query.where('timestamp', '<=', new Date(endDate));
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

    res.json(strategyDoc.data());
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
        error: `Strategy for profile ${strategyId} is already running`
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
