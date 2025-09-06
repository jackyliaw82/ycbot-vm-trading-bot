import express from 'express';
import cors from 'cors';
import TradingStrategy from './strategy.js';
import http from 'http';
import { Firestore } from '@google-cloud/firestore';

const app = express();
const PORT = process.env.PORT;
const GCF_PROXY_URL = process.env.GCF_PROXY_URL || 'https://asia-southeast1-atos-fac0d.cloudfunctions.net/binance-proxy';

// Initialize Firestore globally
const firestore = new Firestore({
  projectId: 'atos-fac0d', // Hardcode Firestore project ID
  databaseId: 'ycbot-firestore', // Hardcode Firestore database ID
});

// Middleware
app.use(cors({
  origin: [
    'https://ycbotv41.netlify.app',
    "https://zp1v56uxy8rdx5ypatb0ockcb9tr6a-oci3--5173--96435430.local-credentialless.webcontainer-api.io",
    'https://youngflock.com',
    'https://www.youngflock.com',
    'http://localhost:5173',
    'https://localhost:5173',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
}));

app.use(express.json());

// Global strategy instance
let globalStrategy = null;

// Create HTTP server
const server = http.createServer(app);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    strategyRunning: globalStrategy ? globalStrategy.isRunning : false,
    strategyId: globalStrategy ? globalStrategy.strategyId : null,
    klineWsConnected: globalStrategy ? globalStrategy.klineWsConnected : false,
    realtimeWsConnected: globalStrategy ? globalStrategy.realtimeWsConnected : false,
    userDataWsConnected: globalStrategy ? globalStrategy.userDataWsConnected : false
  });
});

// Start strategy endpoint
app.post('/strategy/start', async (req, res) => {
  try {
    if (globalStrategy && globalStrategy.isRunning) {
      return res.status(400).json({
        error: 'Strategy is already running',
        strategyId: globalStrategy.strategyId
      });
    }

    const config = req.body;
    
    // Validate required parameters for hedge strategy
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

    globalStrategy = new TradingStrategy(GCF_PROXY_URL);
    const strategyId = await globalStrategy.start(config);

    res.json({
      success: true,
      strategyId,
      message: 'Hedge trading strategy started successfully'
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
    if (!globalStrategy || !globalStrategy.isRunning) {
      return res.status(400).json({
        error: 'No strategy is currently running'
      });
    }

    await globalStrategy.stop();
    
    res.json({
      success: true,
      message: 'Hedge strategy stopped successfully'
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
    if (!globalStrategy || !globalStrategy.isRunning) {
      return res.status(400).json({
        error: 'No strategy is currently running to update levels.'
      });
    }

    const { supportLevel, resistanceLevel, enableSupport, enableResistance } = req.body;

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
    await globalStrategy.updateLevels({
      supportLevel,
      resistanceLevel,
      enableSupport,
      enableResistance
    });

    res.json({
      success: true,
      message: 'Strategy levels updated successfully.'
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
    if (!globalStrategy || !globalStrategy.isRunning) {
      return res.status(400).json({
        error: 'No strategy is currently running to update configuration.'
      });
    }

    const { initialBasePositionSizeUSDT } = req.body;

    if (initialBasePositionSizeUSDT === undefined || initialBasePositionSizeUSDT === null || isNaN(initialBasePositionSizeUSDT) || initialBasePositionSizeUSDT <= 0) {
      return res.status(400).json({
        error: 'Invalid initialBasePositionSizeUSDT provided.'
      });
    }

    await globalStrategy.updateConfig({ initialBasePositionSizeUSDT });

    res.json({
      success: true,
      message: 'Strategy configuration updated successfully.'
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
    if (!globalStrategy) {
      return res.json({
        isRunning: false,
        strategy: null
      });
    }

    const status = await globalStrategy.getStatus();
    
    res.json({
      isRunning: globalStrategy.isRunning,
      strategyId: globalStrategy.strategyId,
      strategy: status,
      currentState: {
        currentPosition: globalStrategy.currentPosition,
        thresholdLevel: globalStrategy.thresholdLevel,
        thresholdType: globalStrategy.thresholdType,
        positionEntryPrice: globalStrategy.positionEntryPrice,
        positionSize: globalStrategy.positionSize,
        currentPrice: globalStrategy.currentPrice,
        positionPnL: globalStrategy.positionPnL,
        totalPnL: globalStrategy.totalPnL,
        accumulatedRealizedPnL: globalStrategy.accumulatedRealizedPnL,
        accumulatedTradingFees: globalStrategy.accumulatedTradingFees,
        currentPositionQuantity: globalStrategy.currentPositionQuantity, // ADDED THIS LINE
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
    if (!globalStrategy || !globalStrategy.isRunning) {
      return res.status(400).json({
        error: 'No strategy is currently running to save PnL.'
      });
    }
    await globalStrategy.saveState();
    res.json({
      success: true,
      message: 'Current PnL and strategy state saved to Firestore.'
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
        isRunning: data.isRunning || false, // Include running status
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
    if (globalStrategy && globalStrategy.isRunning) {
      return res.status(400).json({
        error: 'Another strategy is already running'
      });
    }

    const strategyId = req.params.strategyId;
    globalStrategy = new TradingStrategy(GCF_PROXY_URL);
    globalStrategy.strategyId = strategyId;
    
    const loaded = await globalStrategy.loadState(strategyId);
    if (!loaded) {
      return res.status(404).json({
        error: 'Strategy not found'
      });
    }

    globalStrategy.isRunning = true;
    globalStrategy.connectRealtimeWebSocket(); // Connect real-time WS
    globalStrategy.connectUserDataStream(); // Connect user data WS
    await globalStrategy.addLog('🔄 Hedge strategy resumed from saved state (manual resume)');
    await globalStrategy.saveState();

    res.json({
      success: true,
      strategyId,
      message: 'Hedge strategy resumed successfully'
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
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (globalStrategy && globalStrategy.isRunning) {
    await globalStrategy.stop();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  if (globalStrategy && globalStrategy.isRunning) {
    await globalStrategy.stop();
  }
  process.exit(0);
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 YcBot API server running on port ${PORT}`);
  console.log(`📡 Using GCF Proxy: ${GCF_PROXY_URL}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🤞 Good luck bro! On the road to Million now`);
});

export default app;