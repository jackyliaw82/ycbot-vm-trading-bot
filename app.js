import express from 'express';
import cors from 'cors';
import { AnchorLadderStrategy } from './anchor-ladder-strategy.js';

// TradFi-Perps symbols are gated by Binance behind a separate trading agreement
// (error -4411 fires for unsigned accounts). The reversal strategy's symbol
// dropdown filters these out and /prepare-symbol rejects them server-side.
const TRADFI_PERPS_PREFIXES = ['CL', 'NG', 'GC', 'SI', 'HG', 'ZB', 'ZN', 'ZT', 'MSTR', 'COIN', 'TSLA', 'NVDA', 'AAPL', 'AMZN', 'GOOG', 'META', 'MSFT'];
function isTradFiPerps(symbol) {
  if (!symbol || typeof symbol !== 'string') return false;
  const upper = symbol.toUpperCase();
  return TRADFI_PERPS_PREFIXES.some(p => upper.startsWith(p) && (upper.endsWith('USDT') || upper.endsWith('USDC')));
}
import http from 'http';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { Firestore, Timestamp, FieldValue } from '@google-cloud/firestore';
import { initializeFirebaseAdmin } from './pushNotificationHelper.js';
import admin from 'firebase-admin';
import { precisionFormatter } from './precisionUtils.js';
import { execFile, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import wsBroadcast from './ws-broadcast.js';
import { httpAuthMiddleware, requireAdmin } from './http-auth.js';
import { checkBillingGate } from './billing-gate.js';

const app = express();
const PORT = process.env.PORT || 3000;

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const BOT_VERSION = pkg.version;
// Short git commit the running code is checked out at — surfaced in the admin
// VM Status panel so the version badge can be cross-checked against the ACTUAL
// commit (the version string alone can lag a release; see self-update.sh's
// verify_pulled_version note). Computed once at boot; 'unknown' if git is
// unavailable or this isn't a checkout.
let BOT_COMMIT = 'unknown';
try {
  BOT_COMMIT = execSync('git rev-parse --short HEAD', {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim() || 'unknown';
} catch {
  /* git unavailable or not a repo — leave 'unknown' */
}
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
    'https://app.ycbot.trade',
    'https://www.ycbot.trade'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
}));

app.use(express.json());

// HTTP auth: verifies Firebase ID token from `Authorization: Bearer <token>`
// header on all routes EXCEPT /health, /startup-status, /update-status (those
// are public for monitoring + pre-login frontend probes). On success, attaches
// `req.uid`. Set HTTP_AUTH_REQUIRED=false to bypass for emergency only.
//
// Mounted BEFORE express.json()? No — auth comes after json parsing because
// the userId-vs-token cross-check needs req.body. CORS is already mounted.
app.use(httpAuthMiddleware);

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

// ─── Relay auth token ────────────────────────────────────────────────────────
// Per-VM token stored in Firestore at relay_auth_tokens/{uid.toLowerCase()}.
// Backend writes it at provision time; ycbot-ws-relay validates incoming
// `?token=...` against the same collection. We fetch it here once at boot and
// expose via process.env.RELAY_AUTH_TOKEN so trading-base.js _buildRelayWsUrl
// can pick it up. If RELAY_AUTH_TOKEN is already set (local dev / manual
// override), we trust it and skip the lookup.
async function loadRelayAuthToken() {
  if (process.env.RELAY_AUTH_TOKEN) {
    console.log('[RELAY-AUTH] RELAY_AUTH_TOKEN already set in env; skipping Firestore lookup');
    return;
  }
  let instanceName;
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/name',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
    instanceName = (await res.text()).trim();
  } catch (err) {
    console.warn(`[RELAY-AUTH] Could not read instance name from GCP metadata (${err.message}); bot will connect to relay without a token`);
    return;
  }
  if (!instanceName.startsWith('vm-user-')) {
    console.warn(`[RELAY-AUTH] Instance name '${instanceName}' does not match vm-user-* pattern; skipping token lookup`);
    return;
  }
  const docId = instanceName.slice('vm-user-'.length);
  try {
    const doc = await firestore.collection('relay_auth_tokens').doc(docId).get();
    if (!doc.exists) {
      console.warn(`[RELAY-AUTH] No token doc at relay_auth_tokens/${docId} — bot will be rejected by relay until backend provisions one`);
      return;
    }
    const { token } = doc.data();
    if (!token) {
      console.warn(`[RELAY-AUTH] Token doc relay_auth_tokens/${docId} exists but has no 'token' field`);
      return;
    }
    process.env.RELAY_AUTH_TOKEN = token;
    console.log(`[RELAY-AUTH] Loaded token for uid=${docId} (${token.length} chars) from Firestore`);
  } catch (err) {
    console.error(`[RELAY-AUTH] Failed to load token from Firestore: ${err.message}`);
  }
}
await loadRelayAuthToken();

startupStatus.phase = 'ready';

// Global map to store active strategy instances, keyed by strategyId
const activeStrategies = new Map();

// ─── Wallet snapshot ─────────────────────────────────────────────────────────
// Periodically write the user's total futures wallet balance to Firestore so
// the frontend's balance sparkline can show real history instead of a synthetic
// random-walk. Hourly cadence is plenty for a 24h sparkline (24 points).
// Tied to strategy lifecycle: starts on strategy start (after start() resolves
// so wallet is reachable), stops on onStopComplete. When no strategy is running
// the bot doesn't snapshot — that's the limitation; sparkline will only have
// data points from active trading sessions.
const WALLET_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

async function _snapshotWallet(strategy) {
  if (!strategy?.userId) return;
  try {
    const balance = await strategy.getWalletBalance();
    await firestore.collection('users').doc(strategy.userId)
      .collection('wallet-history').add({
        ts: Date.now(),
        totalUsdt: balance,
        strategyId: strategy.strategyId || null,
      });
    console.log(`[WALLET-SNAPSHOT] uid=${strategy.userId} total=$${Number(balance).toFixed(2)}`);
  } catch (err) {
    console.warn(`[WALLET-SNAPSHOT] failed for uid=${strategy.userId}: ${err.message}`);
  }
}

// ─── Warm subscription manager ───────────────────────────────────────────────
// Holds a single WS subscription to the relay for the symbol the user has
// currently selected on the config page. Purpose: keep the relay's upstream
// for that symbol hot so when the user clicks Start, the strategy WS inherits
// a hot upstream and gets messages immediately (no cold-start REST fallback).
// Server-level state — not tied to any strategy instance.
let warmWs = null;
let warmSymbol = null;
let warmReconnectTimeout = null;
const WARM_RECONNECT_DELAY_MS = 5_000;

function _getWarmStreamUrl(symbolUpper) {
  const base = process.env.RELAY_WS_URL || 'wss://fstream.binance.com/ws';
  const url = `${base}/${symbolUpper.toLowerCase()}@markPrice@1s`;
  const token = process.env.RELAY_AUTH_TOKEN;
  if (token && process.env.RELAY_WS_URL) {
    return `${url}?token=${encodeURIComponent(token)}`;
  }
  return url;
}

function _closeWarmWs(reason) {
  if (warmReconnectTimeout) {
    clearTimeout(warmReconnectTimeout);
    warmReconnectTimeout = null;
  }
  if (warmWs) {
    try { warmWs.removeAllListeners(); } catch (_) { /* ignore */ }
    try { warmWs.close(); } catch (_) { /* ignore */ }
    console.log(`[WARM] Closed subscription (was ${warmSymbol}) — reason: ${reason}`);
    warmWs = null;
  }
}

function _openWarmWs(symbolUpper) {
  const url = _getWarmStreamUrl(symbolUpper);
  console.log(`[WARM] Opening subscription: ${symbolUpper} → ${url}`);
  const ws = new WsClient(url);
  warmWs = ws;
  warmSymbol = symbolUpper;

  ws.on('open', () => {
    console.log(`[WARM] Subscription open: ${symbolUpper}`);
  });

  // Discard messages — this connection exists only to keep the relay's upstream warm.
  ws.on('message', () => { /* intentional no-op */ });

  ws.on('error', (err) => {
    console.warn(`[WARM] Subscription error (${symbolUpper}): ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    console.log(`[WARM] Subscription closed (${symbolUpper}, code=${code}, reason=${reason ? reason.toString() : 'none'})`);
    if (warmWs === ws && warmSymbol === symbolUpper) {
      warmWs = null;
      warmReconnectTimeout = setTimeout(() => {
        if (warmSymbol === symbolUpper) _openWarmWs(symbolUpper);
      }, WARM_RECONNECT_DELAY_MS);
    }
  });
}

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
  const connectedAt = Date.now();
  let connectLogged = false;

  // Defer the "connected" log — skip logging churny short-lived sockets
  // (common on mobile when backgrounded tabs flap). Only log if the client
  // stays connected >5s, indicating a real session.
  const connectLogTimer = setTimeout(() => {
    connectLogged = true;
    console.log(`[WS] Client connected: ${uid}`);
  }, 5000);

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

  ws.on('close', (code) => {
    clearTimeout(connectLogTimer);
    clearInterval(pingInterval);
    if (pongTimeout) clearTimeout(pongTimeout);

    // Log disconnect only if the matching connect was logged, OR if the
    // close code is unexpected (not a normal/abnormal close). Codes 1000
    // (normal), 1001 (going away), 1006 (abnormal, typical on mobile
    // suspend) are expected and get suppressed for short-lived sockets.
    const expected = code === 1000 || code === 1001 || code === 1006;
    if (connectLogged || !expected) {
      const aliveSec = Math.round((Date.now() - connectedAt) / 1000);
      console.log(`[WS] Client disconnected: ${uid} (alive ${aliveSec}s, code ${code})`);
    }
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
    botCommit: BOT_COMMIT,
    updateAvailable,
    targetVersion,
    isUpdating,
  };
}

// Periodic health + strategy_update broadcast to all connected WebSocket clients.
// Cadence: 30s safety-net heartbeat. Strategies also fire pushStrategyUpdate
// immediately after every bookkeeping change (trade fill, flow event, AI consult,
// harvest-price set) so the frontend sees sub-second updates in practice — the
// 30s tick is purely re-sync insurance against a dropped event frame.
// Payload: getHeartbeatPayload() returns only TRUE LIVE fields (executionState,
// subState, isRunning, position state, accumulators, AI cost). Static config
// fields (leverage, priceType, recovery params, etc.) are loaded once via the
// initial REST fetch — sending them every push wasted ~75% of the bandwidth.
setInterval(() => {
  if (wss.clients.size > 0) {
    wsBroadcast.pushHealth(buildHealthPayload());
    activeStrategies.forEach((strategy, strategyId) => {
      if (!strategy.isRunning) return;
      const payload = typeof strategy.getHeartbeatPayload === 'function'
        ? strategy.getHeartbeatPayload()
        : (typeof strategy.getStatus === 'function' ? strategy.getStatus() : null);
      if (payload) wsBroadcast.pushStrategyUpdate(strategyId, payload);
    });
  }
}, 30000);

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
    botCommit: BOT_COMMIT,
    updateAvailable,
    targetVersion,
    isUpdating
  });
});

// Generic Firestore query endpoints (used by AI strategies)

// New endpoint to fetch strategy-specific trades
app.get('/strategy/:strategyId/trades', async (req, res) => {
  try {
    const { strategyId } = req.params;
    // Hardcode Firestore project ID and database ID
    const tradesRef = firestore.collection('strategies').doc(strategyId).collection('trades');
    // Use `timestamp` (always set in saveTrade via `new Date()`) rather than `time`
    // (Binance order.T) — Firestore.orderBy implicitly filters out docs that lack
    // the field, and with `ignoreUndefinedProperties: true` an undefined order.T
    // would have produced docs without a `time` field, hiding them from the query.
    const snapshot = await tradesRef.orderBy('timestamp', 'desc').get();
    
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

// Graceful shutdown handling.
//
// C4 change: SIGTERM / SIGINT no longer call strategy.stop() (which would
// close all positions on Binance). PM2 fires SIGTERM on `pm2 restart` (e.g.
// code update, memory-cap restart) — we want positions to SURVIVE those so
// the new process can reattach via the boot recovery scan. The latest state
// is already in Firestore; we just save once more for freshness and exit.
//
// User-initiated stop still goes through the /anchor-ladder/stop HTTP endpoint,
// which does close positions. SIGTERM is reserved for restart-recovery.
const shutdown = async () => {
  console.log('[SHUTDOWN] Received signal — saving state and exiting (positions preserved for restart recovery).');
  for (const [strategyId, strategy] of activeStrategies.entries()) {
    try {
      await strategy.saveState();
      console.log(`[SHUTDOWN] State saved for ${strategyId}`);
    } catch (err) {
      console.error(`[SHUTDOWN] Failed to save state for ${strategyId}: ${err.message}`);
    }
  }
  console.log('[SHUTDOWN] All states saved. Exiting cleanly.');
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

// ─── C4: restart-recovery scan ───────────────────────────────────────────────
// Runs once after server.listen completes. Queries Firestore for any strategy
// doc with `isRunning: true` (meaning we crashed mid-run) and resumes them.
// Each strategy reattaches WS streams, reconciles positions against Binance
// (source of truth), and resumes monitoring. If positions are gone, the
// strategy marks itself stopped and removes from activeStrategies.
async function recoverActiveStrategies() {
  try {
    console.log('[RECOVERY] Scanning Firestore for orphaned strategies...');
    // Single query for ALL running strategies; the loop below allowlists on
    // the `anchor_ladder_` id prefix and skips everything else (retired
    // ai_reversal_ / ai_dual_ / ai_hedge_ docs) — see the allowlist comment
    // inside the loop for the full rationale.
    const snapshot = await firestore.collection('strategies')
      .where('isRunning', '==', true)
      .get();

    if (snapshot.empty) {
      console.log('[RECOVERY] No orphaned strategies found.');
      return;
    }

    console.log(`[RECOVERY] Found ${snapshot.size} orphaned strategy(s) — resuming...`);

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const strategyId = doc.id;

      // Skip if already in activeStrategies (defensive — shouldn't happen on boot).
      if (activeStrategies.has(strategyId)) {
        console.log(`[RECOVERY] Skipping ${strategyId} — already active`);
        continue;
      }

      // AnchorLadder is the only strategy that exists. Anything else in
      // `strategies` is a leftover doc from a retired one (ai_reversal_ /
      // ai_dual_ / ai_hedge_) whose persisted state is a different shape and
      // cannot be resumed as a ladder. Skip silently — no live user can have
      // one: every account onboarded from here only ever runs AnchorLadder.
      if (!strategyId.startsWith('anchor_ladder_')) continue;

      try {
        const strategy = new AnchorLadderStrategy(
          data.gcfProxyUrl || null,
          data.profileId,
          data.sharedVmProxyGcfUrl || null
        );
        strategy.strategyId = strategyId;
        strategy.profileId = data.profileId;
        strategy.userId = data.userId;
        strategy.isRunning = true;

        let walletSnapshotInterval = null;
        strategy.onStopComplete = () => {
          if (walletSnapshotInterval) {
            clearInterval(walletSnapshotInterval);
            walletSnapshotInterval = null;
          }
          _snapshotWallet(strategy).catch(() => { /* logged inside */ });
          activeStrategies.delete(strategyId);
        };

        activeStrategies.set(strategyId, strategy);

        // Resume in background — same non-blocking pattern as /anchor-ladder/start.
        strategy.resume(data)
          .then(() => {
            // Only continue wallet snapshot loop if resume left strategy running.
            if (strategy.isRunning) {
              _snapshotWallet(strategy).catch(() => {});
              walletSnapshotInterval = setInterval(
                () => _snapshotWallet(strategy).catch(() => {}),
                WALLET_SNAPSHOT_INTERVAL_MS
              );
              console.log(`[RECOVERY] ✓ ${strategyId} recovered (symbol=${data.symbol}, mode=${strategy.ladderMode}, legs=${Array.isArray(strategy.ladderLines) ? strategy.ladderLines.length : 0})`);
            } else {
              console.log(`[RECOVERY] ${strategyId} marked stopped during resume (positions gone)`);
            }
          })
          .catch((error) => {
            console.error(`[RECOVERY] ✗ Failed to resume ${strategyId}:`, error);
            strategy.isRunning = false;
            activeStrategies.delete(strategyId);
            firestore.collection('strategies').doc(strategyId).update({
              isRunning: false,
              criticalError: `recovery_failed: ${error.message}`,
              lastUpdated: new Date(),
            }).catch(() => {});
          });
      } catch (err) {
        console.error(`[RECOVERY] ✗ Failed to instantiate strategy ${strategyId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[RECOVERY] Top-level scan failed:', err);
  }
}

// ============================
// Testing Endpoints (Admin Only)
// ============================

// Force disconnect Real-time Price WebSocket
app.post('/test/force-disconnect-realtime-ws', requireAdmin, async (req, res) => {
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
app.post('/test/force-disconnect-userdata-ws', requireAdmin, async (req, res) => {
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
app.post('/test/force-disconnect-websockets', requireAdmin, async (req, res) => {
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
app.post('/test/invalidate-listenkey', requireAdmin, async (req, res) => {
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
app.post('/test/force-clear-listenkey', requireAdmin, async (req, res) => {
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
app.post('/test/reset-reconnection-state', requireAdmin, async (req, res) => {
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

// Self-service update: any authenticated user can trigger a regular update
// of THEIR own bot (it's their VM). httpAuthMiddleware (global) still
// enforces a valid Firebase token. Admin-only is reserved for the
// /system/force-update endpoint below, which bypasses the "wait-for-idle"
// guard and could disrupt a running strategy.
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

app.post('/system/force-update', requireAdmin, async (req, res) => {
  if (isUpdating) {
    return res.status(409).json({ error: 'Update already in progress.', targetVersion });
  }
  if (!updateAvailable) {
    return res.status(400).json({ error: 'No update available.' });
  }

  // Force update no longer closes positions. The C4 restart-recovery design
  // (saveState on SIGTERM + recoverActiveStrategies on boot) preserves
  // running strategies across the restart cycle:
  //   1. PM2 restart sends SIGTERM → shutdown handler (line ~552) saves
  //      each strategy's state to Firestore with isRunning: true.
  //   2. New bot process boots → recoverActiveStrategies queries Firestore
  //      for isRunning Anchor Ladder strategies and calls strategy.resume()
  //      on each, which reconciles positions against Binance and reattaches
  //      WS streams.
  //   3. User-initiated stop (/anchor-ladder/stop) is still the only path that
  //      closes positions + processes platform fees. Force-update is now
  //      strictly a fast-restart-with-state-preservation operation.
  const activeCount = activeStrategies.size;
  res.json({
    success: true,
    message: activeCount > 0
      ? `Force update to ${targetVersion} initiated. ${activeCount} active strategy/strategies will be preserved across the restart and resumed automatically.`
      : `Force update to ${targetVersion} initiated. No active strategies.`,
  });

  setImmediate(async () => {
    try {
      console.log(`[FORCE-UPDATE] ${activeCount} active strategy/strategies — state will be saved by SIGTERM handler; recoverActiveStrategies will resume them on boot. Triggering self-update to ${targetVersion}...`);
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
    }, async (error, stdout, stderr) => {
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

      // Mark 'restarting' before PM2 kills us so the admin UI shows the
      // correct phase during the PM2 restart gap (port 3000 ECONNREFUSED).
      // Wait up to 2s for the Firestore write to land — PM2 typically gives
      // us at least that before SIGTERM.
      try {
        await Promise.race([
          reportUpdateStatus('restarting', {
            targetVersion,
            restartingAt: new Date().toISOString(),
          }),
          new Promise((res) => setTimeout(res, 2000)),
        ]);
      } catch (e) {
        console.error('[UPDATE] Failed to report restarting status:', e);
      }
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
      botCommit: BOT_COMMIT,
      lastUpdateStatusAt: Timestamp.now(),
    });
    console.log(`[UPDATE] Reported update status: ${status} for user ${userId}`);
  } catch (error) {
    console.error('[UPDATE] Failed to report update status:', error);
  }
}

// Owner user-id is fixed for the lifetime of this process — cache once after
// first successful resolution so subsequent reportUpdateStatus calls don't
// re-scan the full users collection. Critical during the PM2 restart gap:
// the 'restarting' write must land in <2s, and the cold-start 'idle' write
// on the new bot's boot path resolves faster too.
let _cachedVmOwnerUserId = null;

async function getVmOwnerUserId() {
  if (_cachedVmOwnerUserId) return _cachedVmOwnerUserId;
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
            _cachedVmOwnerUserId = doc.id;
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
          _cachedVmOwnerUserId = doc.id;
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
        botCommit: BOT_COMMIT,
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

// ——— Anchor Ladder Strategy endpoints ————————————————————————————————

app.post('/anchor-ladder/prepare-symbol', (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required' });
  }
  const normalized = symbol.toUpperCase();
  if (isTradFiPerps(normalized)) {
    return res.status(400).json({
      error: `${normalized} is a TradFi-Perps contract; sign the Binance TradFi-Perps agreement in the UI before trading. Anchor Ladder does not support these symbols.`,
      code: 'TRADFI_PERPS_BLOCKED',
    });
  }
  if (warmSymbol === normalized && warmWs && warmWs.readyState === WsClient.OPEN) {
    return res.json({ ok: true, alreadyWarm: true, symbol: normalized });
  }
  _closeWarmWs('switching symbol');
  _openWarmWs(normalized);
  return res.json({ ok: true, symbol: normalized });
});

app.post('/anchor-ladder/start', async (req, res) => {
  if (isUpdating) {
    return res.status(503).json({ error: 'VM is currently updating.', code: 'VM_UPDATING' });
  }

  try {
    const { profileId, gcpProxyUrl, sharedVmProxyGcfUrl, config, userId } = req.body;

    if (!profileId || !gcpProxyUrl || !sharedVmProxyGcfUrl || !config) {
      return res.status(400).json({ error: 'profileId, gcpProxyUrl, sharedVmProxyGcfUrl, and config are required.' });
    }

    if (isTradFiPerps(config.symbol)) {
      return res.status(400).json({
        error: `${config.symbol} is a TradFi-Perps contract; not supported by Anchor Ladder.`,
        code: 'TRADFI_PERPS_BLOCKED',
      });
    }

    // Defence in depth — AnchorLadderStrategy.start() gates on
    // MIN_INITIAL_SIZE_USDT (50 USDT, ladder-levels.js) too, but that check
    // fires deep inside the non-blocking start() promise after the 200
    // response has already gone out. Reject here up front so an
    // under-minimum request never even mints a strategyId or touches the
    // billing gate.
    if (!(Number(config.initialSize) >= 50)) {
      return res.status(400).json({
        error: `Initial size (${config.initialSize} USDT) is below the 50 USDT minimum for a 5-level ladder.`,
        code: 'INITIAL_SIZE_TOO_LOW',
      });
    }

    // One strategy per profile (matches existing model). User must stop the running strategy first.
    for (const [sId, strategy] of activeStrategies.entries()) {
      if (strategy.profileId === profileId) {
        return res.status(400).json({
          error: `A strategy for profile ${profileId} is already running. Stop it before starting Anchor Ladder.`,
          strategyId: sId,
        });
      }
    }

    // ── Billing gate (server-side enforcement) ────────────────────────────
    // Fail-closed mirror of backend-service /billing/preflight's read-only
    // checks. The frontend calls preflight (which also lazily charges the
    // 30 USD subscription) before reaching here, but that verdict is only
    // *enforced* client-side — a caller that bypasses the React app would
    // otherwise start ungated. Block unless the machine subscription is active
    // AND Reload Balance is positive. CHECK-ONLY: does NOT charge (the 30 USD
    // renewal stays owned by preflight + first-profile creation). Prefer the
    // token-derived req.uid over the client-supplied body userId.
    const billingUid = req.uid || userId;
    let gate;
    try {
      gate = await checkBillingGate(firestore, billingUid);
    } catch (gateErr) {
      console.error(`[BILLING_GATE] Verification failed for ${billingUid}:`, gateErr.message);
      return res.status(402).json({
        error: 'Could not verify your machine subscription / Reload Balance. Please try again.',
        code: 'BILLING_GATE_UNVERIFIED',
      });
    }
    if (!gate.canStart) {
      const msg =
        gate.reason === 'subscription_unpaid'
          ? 'Machine subscription is inactive. Reload your Balance and start from the app to renew (30 USD/mo).'
          : gate.reason === 'negative_balance'
          ? 'Your Reload Balance is negative. Top up above 0 USD to start a strategy.'
          : gate.reason === 'zero_balance'
          ? 'Your Reload Balance is 0 USD. Reload to start a strategy.'
          : 'Reload Balance / subscription check failed. Top up and try again.';
      console.warn(`[BILLING_GATE] Blocked start for ${billingUid} (reason=${gate.reason}, balance=${gate.balance}).`);
      return res.status(402).json({ error: msg, code: 'BILLING_GATE_BLOCKED', reason: gate.reason });
    }
    // ──────────────────────────────────────────────────────────────────────

    const strategy = new AnchorLadderStrategy(gcpProxyUrl, profileId, sharedVmProxyGcfUrl);
    strategy.userId = userId;

    const strategyId = `anchor_ladder_${profileId}_${Date.now()}`;
    strategy.strategyId = strategyId;
    strategy.isRunning = true;
    activeStrategies.set(strategyId, strategy);

    let walletSnapshotInterval = null;
    strategy.onStopComplete = () => {
      if (walletSnapshotInterval) {
        clearInterval(walletSnapshotInterval);
        walletSnapshotInterval = null;
      }
      _snapshotWallet(strategy).catch(() => { /* logged inside */ });
      activeStrategies.delete(strategyId);
    };

    console.log(`✓ Anchor Ladder Strategy ${strategyId} starting (non-blocking)...`);
    res.json({
      success: true,
      strategyId,
      message: 'Anchor Ladder Strategy starting',
    });

    strategy.start(config)
      .then(() => {
        _snapshotWallet(strategy).catch(() => { /* logged inside */ });
        walletSnapshotInterval = setInterval(
          () => _snapshotWallet(strategy).catch(() => { /* logged inside */ }),
          WALLET_SNAPSHOT_INTERVAL_MS
        );
      })
      .catch((error) => {
        console.error(`Failed to start Anchor Ladder Strategy ${strategyId}:`, error);
        strategy.isRunning = false;
        activeStrategies.delete(strategyId);
      });
  } catch (error) {
    console.error('Failed to start Anchor Ladder Strategy:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/anchor-ladder/stop', async (req, res) => {
  try {
    const { strategyId, flatten } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AnchorLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No Anchor Ladder strategy running with ID ${strategyId}` });
    }

    res.json({ success: true, stopping: true, message: 'Anchor Ladder Strategy stop initiated', strategyId });

    setImmediate(async () => {
      try {
        await strategy.stop({ flatten: !!flatten });
        activeStrategies.delete(strategyId);
      } catch (error) {
        console.error(`Error stopping Anchor Ladder Strategy ${strategyId}:`, error);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AnchorLadderStrategy.getStatus() (Task 9) already returns the full ladder
// shape directly — mode, anchor, ladderLines, trendDirection, levelsPerSide,
// stepPct, legNotional, ladderBaseSize — alongside the base TradingBase
// fields. Unlike the retired grid strategy's status route, no extra
// field-bolting is needed here; getStatus() IS the response.
app.get('/anchor-ladder/status', (req, res) => {
  const { strategyId } = req.query;

  if (strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AnchorLadderStrategy)) {
      return res.status(404).json({ error: `Anchor Ladder strategy ${strategyId} not found.` });
    }
    return res.json(strategy.getStatus());
  }

  const ladderStrategies = {};
  activeStrategies.forEach((strategy, sId) => {
    if (strategy instanceof AnchorLadderStrategy) {
      ladderStrategies[sId] = strategy.getStatus();
    }
  });

  res.json({ strategies: ladderStrategies, count: Object.keys(ladderStrategies).length });
});

// Manual user-driven re-anchor / harvest. Single gate: a position must be open
// (the gauge no longer gates this). Closes the open leg to flat at market
// (reduceOnly), then re-anchors the ladder on the live price. The frontend
// labels it Harvest (unrealized >= 0) or Re-anchor (unrealized < 0), but both
// call this identical action. The cycle CONTINUES — this does NOT stop the
// strategy. strategy.harvestNow() validates eligibility synchronously and
// queues the close via the manual-harvest latch honored on the next free tick,
// so the response is an immediate eligibility verdict. Ineligibility throws → 409.
app.post('/anchor-ladder/harvest-now', async (req, res) => {
  try {
    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AnchorLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Anchor Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.harvestNow();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

// Manual user-driven edit of the cycle's desired-profit % while running. The
// bot converts the % to USDT against initialCapital (the cycle-start basis),
// recomputes Final TP, and persists. Allowed in any subState — no trade
// fires here; the new Final TP target just takes effect on the next price
// tick. Shipped user feature carried over from AI Reversal; adjustProfitTarget
// survives unchanged on AnchorLadderStrategy.
app.post('/anchor-ladder/adjust-profit-target', async (req, res) => {
  try {
    const { strategyId, desiredProfitPercent } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    if (desiredProfitPercent == null) {
      return res.status(400).json({ error: 'desiredProfitPercent is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof AnchorLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Anchor Ladder strategy with ID ${strategyId}` });
    }

    const result = await strategy.adjustProfitTarget({ desiredProfitPercent: Number(desiredProfitPercent) });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// strategyFlow audit trail for Anchor Ladder. Reads from
// strategies/{strategyId}/strategyFlow subcollection populated by
// AnchorLadderStrategy._writeStrategyFlow inside its post-execute bookkeeping
// on every position event (open / reverse / harvest / anchor-flatten /
// final_tp_hit). Used by the position chart to place TP segment boundaries
// at EXACT event moments instead of heartbeat-resolution timestamps.
app.get('/anchor-ladder/strategy-flow', async (req, res) => {
  try {
    const { strategyId, limit: queryLimit } = req.query;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const flowLimit = parseInt(queryLimit) || 200;
    const flowRef = firestore.collection('strategies').doc(strategyId).collection('strategyFlow');
    const snapshot = await flowRef.orderBy('timestamp', 'desc').limit(flowLimit).get();

    const flow = [];
    snapshot.forEach(doc => flow.push({ id: doc.id, ...doc.data() }));

    res.json({ flow, count: flow.length });
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
  // C4: scan for crashed-mid-run strategies and resume them. Runs once at
  // boot. Non-blocking — server is already accepting requests above.
  recoverActiveStrategies().catch(err => console.error('[RECOVERY] unhandled:', err));
});

export default app;