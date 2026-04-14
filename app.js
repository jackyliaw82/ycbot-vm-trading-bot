import express from 'express';
import cors from 'cors';
import { AiHedgeStrategy } from './ai-hedge-strategy.js';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Firestore, Timestamp, FieldValue } from '@google-cloud/firestore';
import { initializeFirebaseAdmin } from './pushNotificationHelper.js';
import admin from 'firebase-admin';
import { precisionFormatter } from './precisionUtils.js';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import os from 'os';
import wsBroadcast from './ws-broadcast.js';

const app = express();
const PORT = process.env.PORT || 3000;

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const BOT_VERSION = pkg.version;
let updateAvailable = false;
let targetVersion = null;
let isUpdating = false;
let updateStartedAt = null;
let releaseUnsubscribe = null;
let idleUpdateInterval = null;

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
    botVersion: BOT_VERSION,
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

// ─── WebSocket Server (direct frontend connections via nginx) ────────────────

const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 10000;

const wss = new WebSocketServer({ noServer: true });
wsBroadcast.setWss(wss);

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleClientConnection(ws, decoded.uid);
    });
  } catch (err) {
    console.error('[WS] Firebase token verification failed:', err.message);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

function handleClientConnection(ws, uid) {
  console.log(`[WS] Client connected: ${uid}`);

  // Send immediate vm_connected since the client is directly on the VM
  ws.send(JSON.stringify({ type: 'vm_connected', timestamp: Date.now() }));

  // Send current health snapshot
  const healthData = buildHealthPayload();
  ws.send(JSON.stringify({ type: 'health', data: healthData }));

  // Ping/pong keepalive
  let pongTimeout = null;
  const pingInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    pongTimeout = setTimeout(() => {
      console.log(`[WS] Pong timeout for ${uid} — terminating`);
      ws.terminate();
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'pong' && pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${uid}`);
    clearInterval(pingInterval);
    if (pongTimeout) clearTimeout(pongTimeout);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${uid}:`, err.message);
  });
}

function buildHealthPayload() {
  const strategiesStatus = {};
  activeStrategies.forEach((strategy, strategyId) => {
    strategiesStatus[strategyId] = {
      strategyRunning: strategy.isRunning,
      realtimeWsConnected: strategy.realtimeWsConnected,
      userDataWsConnected: strategy.userDataWsConnected,
      profileId: strategy.profileId,
    };
  });
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeStrategiesCount: activeStrategies.size,
    strategies: strategiesStatus,
    vmInstanceHealthy: true,
    botVersion: BOT_VERSION,
    updateAvailable,
    targetVersion,
    isUpdating,
  };
}

// Periodic health broadcast to all connected WebSocket clients
setInterval(() => {
  if (wss.clients.size > 0) {
    wsBroadcast.pushHealth(buildHealthPayload());
  }
}, 10000);

// Health check endpoint
app.get('/health', (req, res) => {
  const strategiesStatus = {};
  activeStrategies.forEach((strategy, strategyId) => {
    strategiesStatus[strategyId] = {
      strategyRunning: strategy.isRunning,
      realtimeWsConnected: strategy.realtimeWsConnected,
      userDataWsConnected: strategy.userDataWsConnected,
      profileId: strategy.profileId // ADDED: Include profileId for ownership validation
    };
  });

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeStrategiesCount: activeStrategies.size,
    strategies: strategiesStatus,
    vmInstanceHealthy: true,
    botVersion: BOT_VERSION,
    updateAvailable,
    targetVersion,
    isUpdating
  });
});

// Generic Firestore query endpoints (used by AI hedge strategy)

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

// Endpoint to fetch strategy flow events
app.get('/strategy/:strategyId/strategyFlow', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const flowRef = firestore.collection('strategies').doc(strategyId).collection('strategyFlow');
    const snapshot = await flowRef.orderBy('timestamp', 'asc').get(); // Order by timestamp ascending

    const flowEvents = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        timestamp: data.timestamp.toDate().getTime(), // Convert Firestore Timestamp to milliseconds
        tradeType: data.tradeType,
        side: data.side,
        entryPrice: data.entryPrice,
        currentQty: data.currentQty,
        breakevenLevel: data.breakevenLevel,
        breakevenPercentage: data.breakevenPercentage,
        takeProfitLevel: data.takeProfitLevel,
        takeProfitPercentage: data.takeProfitPercentage
      };
    });

    res.json(flowEvents);
  } catch (error) {
    console.error('Failed to fetch strategy flow events:', error);
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

process.on('SIGTERM', () => {
  if (releaseUnsubscribe) { releaseUnsubscribe(); releaseUnsubscribe = null; }
  if (idleUpdateInterval) { clearInterval(idleUpdateInterval); idleUpdateInterval = null; }
  shutdown();
});
process.on('SIGINT', () => {
  if (releaseUnsubscribe) { releaseUnsubscribe(); releaseUnsubscribe = null; }
  if (idleUpdateInterval) { clearInterval(idleUpdateInterval); idleUpdateInterval = null; }
  shutdown();
});

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

// ============================
// Update Management Endpoints
// ============================

app.get('/update-status', (req, res) => {
  res.json({
    botVersion: BOT_VERSION,
    updateAvailable,
    targetVersion,
    isUpdating,
    updateStartedAt,
    activeStrategiesCount: activeStrategies.size,
    timestamp: new Date().toISOString()
  });
});

app.post('/system/update', async (req, res) => {
  if (isUpdating) {
    return res.status(409).json({ error: 'Update already in progress.', targetVersion });
  }
  if (!updateAvailable) {
    return res.status(400).json({ error: 'No update available.' });
  }
  if (activeStrategies.size > 0) {
    return res.status(409).json({
      error: 'Cannot update while strategies are running. Stop all strategies first.',
      activeStrategiesCount: activeStrategies.size
    });
  }

  try {
    res.json({ success: true, message: `Self-update to ${targetVersion} initiated.` });
    await triggerSelfUpdate();
  } catch (error) {
    console.error('Self-update failed:', error);
  }
});

app.post('/system/force-update', async (req, res) => {
  if (isUpdating) {
    return res.status(409).json({ error: 'Update already in progress.', targetVersion });
  }
  if (!updateAvailable) {
    return res.status(400).json({ error: 'No update available.' });
  }

  res.json({
    success: true,
    message: `Force update initiated. Stopping ${activeStrategies.size} active strategies before updating to ${targetVersion}.`
  });

  setImmediate(async () => {
    try {
      for (const [strategyId, strategy] of activeStrategies.entries()) {
        if (strategy.isRunning) {
          console.log(`[FORCE-UPDATE] Stopping strategy ${strategyId}...`);
          try {
            await firestore.collection('strategies').doc(strategyId).update({
              stoppingStatus: 'in_progress',
              stoppingStartedAt: Timestamp.now()
            });

            const stopPromise = strategy.stop();
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Stop operation timeout')), 45000)
            );
            await Promise.race([stopPromise, timeoutPromise]);
            activeStrategies.delete(strategyId);

            const strategyDoc = await firestore.collection('strategies').doc(strategyId).get();
            if (strategyDoc.exists) {
              const strategyData = strategyDoc.data();
              const finalPnL = strategyData.totalPnL || 0;
              const userId = strategy.userId || strategyData.userId;

              if (finalPnL > 0 && userId) {
                const FEE_PERCENTAGE = 0.15;
                const feeAmount = Math.round(finalPnL * FEE_PERCENTAGE * 100) / 100;
                const feeId = firestore.collection('temp').doc().id;

                await firestore.collection('strategy_fees').doc(feeId).set({
                  feeId, strategyId, userId,
                  profileId: strategy.profileId,
                  initialPnL: 0, finalPnL, feeAmount,
                  feePercentage: FEE_PERCENTAGE,
                  calculatedAt: Timestamp.now(),
                  status: 'calculated',
                });

                const walletRef = firestore.collection('users').doc(userId).collection('wallets').doc('default');
                const walletDoc = await walletRef.get();
                if (walletDoc.exists) {
                  const currentBalance = walletDoc.data()?.balance || 0;
                  const deductAmount = Math.min(feeAmount, currentBalance);
                  const newBalance = Math.max(0, currentBalance - deductAmount);
                  const now = Timestamp.now();

                  await walletRef.update({ balance: newBalance, updatedAt: now, lastTransactionAt: now });

                  const transactionId = firestore.collection('temp').doc().id;
                  await walletRef.collection('transactions').doc(transactionId).set({
                    transactionId, type: 'debit', amount: deductAmount,
                    balanceBefore: currentBalance, balanceAfter: newBalance,
                    reason: 'platform_fee', relatedResourceType: 'strategy',
                    relatedResourceId: strategyId, createdAt: now,
                  });

                  await firestore.collection('strategy_fees').doc(feeId).update({
                    status: currentBalance >= feeAmount ? 'deducted' : 'insufficient_balance',
                    deductedAt: now, balanceBefore: currentBalance, balanceAfter: newBalance,
                  });

                  if (deductAmount > 0) {
                    const earningId = firestore.collection('temp').doc().id;
                    await firestore.collection('platform_earnings').doc(earningId).set({
                      earningId, feeId, strategyId, userId, amount: deductAmount,
                      collectedAt: now, source: 'performance_fee',
                    });
                  }
                }
              }

              await firestore.collection('strategies').doc(strategyId).update({
                stoppingStatus: 'completed',
                stoppingCompletedAt: Timestamp.now()
              });
            }

            console.log(`[FORCE-UPDATE] Strategy ${strategyId} stopped and fees processed.`);
          } catch (err) {
            console.error(`[FORCE-UPDATE] Error stopping strategy ${strategyId}:`, err);
            activeStrategies.delete(strategyId);
          }
        }
      }

      console.log(`[FORCE-UPDATE] All strategies stopped. Triggering self-update to ${targetVersion}...`);
      await triggerSelfUpdate();
    } catch (error) {
      console.error('[FORCE-UPDATE] Error during force update:', error);
    }
  });
});

// ============================
// Update Management Functions
// ============================

const UPDATE_NO_COMMITS_EXIT_CODE = 2;
const UPDATE_RETRY_DELAY_MS = 30000;
const UPDATE_MAX_RETRIES = 5;

function triggerSelfUpdate(retryCount = 0) {
  return new Promise((resolve, reject) => {
    isUpdating = true;
    updateStartedAt = new Date().toISOString();
    console.log(`[UPDATE] Starting self-update to ${targetVersion}...${retryCount > 0 ? ` (retry ${retryCount}/${UPDATE_MAX_RETRIES})` : ''}`);

    if (retryCount === 0) {
      reportUpdateStatus('updating', { targetVersion, startedAt: updateStartedAt }).catch(() => {});
    }

    const scriptPath = '/opt/vm-bot/self-update.sh';
    execFile('bash', [scriptPath], {
      timeout: 300000,
      env: {
        ...process.env,
        PM2_HOME: process.env.PM2_HOME || '/root/.pm2',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        TARGET_VERSION: targetVersion || '',
      }
    }, (error, stdout, stderr) => {
      if (error) {
        const exitCode = error.code;

        if (exitCode === UPDATE_NO_COMMITS_EXIT_CODE && retryCount < UPDATE_MAX_RETRIES) {
          console.log(`[UPDATE] No new commits on remote yet. Retrying in ${UPDATE_RETRY_DELAY_MS / 1000}s... (attempt ${retryCount + 1}/${UPDATE_MAX_RETRIES})`);
          setTimeout(() => {
            triggerSelfUpdate(retryCount + 1).then(resolve).catch(reject);
          }, UPDATE_RETRY_DELAY_MS);
          return;
        }

        console.error('[UPDATE] Self-update script failed:', error);
        console.error('[UPDATE] stderr:', stderr);
        isUpdating = false;
        updateStartedAt = null;
        reportUpdateStatus('update_failed', {
          targetVersion,
          error: error.message,
          stderr: stderr?.substring(0, 500),
          failedAt: new Date().toISOString(),
        }).catch(() => {});
        reject(error);
        return;
      }
      console.log('[UPDATE] Self-update script completed. PM2 will restart the process.');
      console.log('[UPDATE] stdout:', stdout);
    });
  });
}

async function reportUpdateStatus(status, details = {}) {
  try {
    const userId = await getVmOwnerUserId();
    if (!userId) return;
    const vmStatusRef = firestore.collection('users').doc(userId).collection('vm_status').doc('current');
    await vmStatusRef.update({
      updateStatus: status,
      updateDetails: details,
      botVersion: BOT_VERSION,
      lastUpdateStatusAt: Timestamp.now(),
    });
    console.log(`[UPDATE] Reported update status: ${status} for user ${userId}`);
  } catch (error) {
    console.error('[UPDATE] Failed to report update status:', error);
  }
}

async function getVmOwnerUserId() {
  try {
    const usersSnapshot = await firestore.collection('users').get();
    const localIps = getLocalIpAddresses();

    if (localIps.length > 0) {
      for (const doc of usersSnapshot.docs) {
        const userData = doc.data();
        if (!userData.vmBotUrl) continue;
        try {
          const urlHost = new URL(userData.vmBotUrl).hostname;
          if (localIps.includes(urlHost)) {
            return doc.id;
          }
        } catch {
          continue;
        }
      }
    }

    const hostname = getLocalHostname();
    if (hostname) {
      for (const doc of usersSnapshot.docs) {
        const userData = doc.data();
        if (userData.vmBotUrl && userData.vmBotUrl.includes(hostname)) {
          return doc.id;
        }
      }
    }
  } catch (error) {
    console.error('[UPDATE] Failed to find VM owner user ID:', error);
  }
  return null;
}

function getLocalIpAddresses() {
  try {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.family === 'IPv4') {
          ips.push(iface.address);
        }
      }
    }
    return ips;
  } catch {
    return [];
  }
}

function getLocalHostname() {
  try {
    return os.hostname();
  } catch {
    return null;
  }
}

function setupReleaseListener() {
  try {
    const releaseRef = firestore.collection('system_config').doc('release_info');
    releaseUnsubscribe = releaseRef.onSnapshot((snapshot) => {
      if (!snapshot.exists) return;
      const data = snapshot.data();
      const latestVersion = data?.latestVersion;

      if (latestVersion && latestVersion !== BOT_VERSION) {
        if (!updateAvailable || targetVersion !== latestVersion) {
          console.log(`[UPDATE] New version detected: ${latestVersion} (current: ${BOT_VERSION})`);
          updateAvailable = true;
          targetVersion = latestVersion;

          if (activeStrategies.size === 0 && !isUpdating) {
            console.log(`[UPDATE] No active strategies. Auto-triggering update to ${latestVersion}...`);
            triggerSelfUpdate().catch(err => console.error('[UPDATE] Auto self-update failed:', err));
          } else {
            console.log(`[UPDATE] ${activeStrategies.size} strategies running. Update will apply when idle.`);
          }
        }
      } else if (latestVersion === BOT_VERSION) {
        updateAvailable = false;
        targetVersion = null;
      }
    }, (error) => {
      console.error('[UPDATE] Release listener error:', error);
    });
    console.log('[UPDATE] Release listener started.');
  } catch (error) {
    console.error('[UPDATE] Failed to setup release listener:', error);
  }
}

function setupIdleUpdatePolling() {
  idleUpdateInterval = setInterval(async () => {
    if (updateAvailable && activeStrategies.size === 0 && !isUpdating) {
      console.log(`[UPDATE] Idle polling: triggering pending update to ${targetVersion}...`);
      try {
        await triggerSelfUpdate();
      } catch (err) {
        console.error('[UPDATE] Idle polling self-update failed:', err);
      }
    }
  }, 60000);
}

async function reportVersionOnStartup(retryCount = 0) {
  const MAX_RETRIES = 12;
  const RETRY_INTERVAL_MS = 15000;
  try {
    const userId = await getVmOwnerUserId();
    if (userId) {
      const vmStatusRef = firestore.collection('users').doc(userId).collection('vm_status').doc('current');
      await vmStatusRef.set({
        botVersion: BOT_VERSION,
        lastReportedAt: Timestamp.now(),
        status: 'online',
        activeStrategiesCount: activeStrategies.size,
        updateStatus: 'idle',
        updateDetails: FieldValue.delete(),
      }, { merge: true });
      console.log(`[UPDATE] Reported version ${BOT_VERSION} for user ${userId}`);
    } else if (retryCount < MAX_RETRIES) {
      console.warn(`[UPDATE] Could not determine VM owner (attempt ${retryCount + 1}/${MAX_RETRIES}). Retrying in ${RETRY_INTERVAL_MS / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
      return reportVersionOnStartup(retryCount + 1);
    } else {
      console.warn('[UPDATE] Could not determine VM owner after all retries. Version not reported.');
    }
  } catch (error) {
    console.error('[UPDATE] Failed to report version on startup:', error);
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
      return reportVersionOnStartup(retryCount + 1);
    }
  }
}

// ─── AI Hedge Strategy Endpoints ─────────────────────────────────────────────

// Start AI hedge strategy
app.post('/ai-hedge/start', async (req, res) => {
  if (isUpdating) {
    return res.status(503).json({ error: 'VM is currently updating.', code: 'VM_UPDATING' });
  }

  try {
    const { profileId, gcpProxyUrl, sharedVmProxyGcfUrl, config, userId } = req.body;

    if (!profileId || !gcpProxyUrl || !sharedVmProxyGcfUrl || !config) {
      return res.status(400).json({ error: 'profileId, gcpProxyUrl, sharedVmProxyGcfUrl, and config are required.' });
    }

    // Check if any strategy is already running for this profile
    for (const [sId, strategy] of activeStrategies.entries()) {
      if (strategy.profileId === profileId && strategy.isRunning) {
        return res.status(400).json({
          error: `A strategy for profile ${profileId} is already running`,
          strategyId: sId
        });
      }
    }

    const strategy = new AiHedgeStrategy(gcpProxyUrl, profileId, sharedVmProxyGcfUrl);
    strategy.userId = userId;
    await strategy.start(config);

    activeStrategies.set(strategy.strategyId, strategy);

    console.log(`✓ AI Hedge Strategy ${strategy.strategyId} started.`);
    res.json({
      success: true,
      strategyId: strategy.strategyId,
      message: 'AI Hedge Strategy started successfully',
    });
  } catch (error) {
    console.error('Failed to start AI Hedge Strategy:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stop AI hedge strategy
app.post('/ai-hedge/stop', async (req, res) => {
  try {
    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AiHedgeStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No AI Hedge strategy running with ID ${strategyId}` });
    }

    res.json({ success: true, stopping: true, message: 'AI Hedge Strategy stop initiated', strategyId });

    setImmediate(async () => {
      try {
        await strategy.stop('manual');
        activeStrategies.delete(strategyId);
      } catch (error) {
        console.error(`Error stopping AI Hedge Strategy ${strategyId}:`, error);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get AI hedge strategy status
app.get('/ai-hedge/status', (req, res) => {
  const { strategyId } = req.query;

  if (strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AiHedgeStrategy)) {
      return res.status(404).json({ error: `AI Hedge strategy ${strategyId} not found.` });
    }
    return res.json(strategy.getStatus());
  }

  // Return all AI hedge strategies
  const hedgeStrategies = {};
  activeStrategies.forEach((strategy, sId) => {
    if (strategy instanceof AiHedgeStrategy) {
      hedgeStrategies[sId] = strategy.getStatus();
    }
  });

  res.json({ strategies: hedgeStrategies, count: Object.keys(hedgeStrategies).length });
});

// Manually trigger AI replan
app.post('/ai-hedge/replan', async (req, res) => {
  try {
    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AiHedgeStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running AI Hedge strategy with ID ${strategyId}` });
    }

    await strategy.manualReplan();
    res.json({ success: true, message: 'Replan triggered', strategyId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get AI plan history
app.get('/ai-hedge/plan-history', async (req, res) => {
  try {
    const { strategyId, limit: queryLimit } = req.query;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const planLimit = parseInt(queryLimit) || 20;
    const plansRef = firestore.collection('strategies').doc(strategyId).collection('aiPlans');
    const snapshot = await plansRef.orderBy('timestamp', 'desc').limit(planLimit).get();

    const plans = [];
    snapshot.forEach(doc => plans.push({ id: doc.id, ...doc.data() }));

    res.json({ plans, count: plans.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
server.listen(PORT, async () => {
  startupStatus.serverReady = true;
  startupStatus.phase = 'ready';
  console.log(`🚀 YcBot API server running on port ${PORT} (v${BOT_VERSION})`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Startup status: http://localhost:${PORT}/startup-status`);
  console.log(`🤞 Good luck bro! On the road to Million now`);
  await reportVersionOnStartup();
  setupReleaseListener();
  setupIdleUpdatePolling();
});

export default app;