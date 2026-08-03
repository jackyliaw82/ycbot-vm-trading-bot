import express from 'express';
import cors from 'cors';
import { ReversalLadderStrategy } from './reversal-ladder-strategy.js';
import {
  minInitialSizeUSDT,
  resolveLadderGeometry,
} from './ladder-levels.js';
import {
  ownerUidFromInstanceName,
  selectRecoverableStrategies,
} from './ladder-recovery.js';
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
import { httpAuthMiddleware, requireAdmin, createRequireVmOwner, isAllowedVmUser } from './http-auth.js';
import { checkBillingGate } from './billing-gate.js';
import { isNewerVersion, parseVersion } from './version-compare.js';

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
// The last target whose FULL retry chain failed. Read by the idle poller so it
// does not re-attempt a known-impossible update every 60s; cleared whenever the
// release doc names a genuinely different version. Transient by design — a
// restart deserves one fresh attempt rather than inheriting a dead process's
// verdict.
let lastFailedTarget = null;
// Whether this process has already written a resting ("up_to_date") status.
// Ensures a VM booting with a STALE update_failed left in Firestore clears it
// once, without re-writing the same record on every release-doc snapshot.
let reportedRestingState = false;
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

// ─── VM owner identity ───────────────────────────────────────────────────────
// The backend provisions each user's dedicated VM as `vm-user-<uid.toLowerCase()>`
// (backend-service gcf-orchestration.service.ts), so the instance name IS the
// ownership record. Resolved ONCE at boot and used for two things:
//   1. the relay auth token lookup (relay_auth_tokens/<uid.toLowerCase()>)
//   2. the restart-recovery owner filter — without it a VM resumes OTHER users'
//      strategies and trades their Binance accounts (2026-07-25 incident).
// Local dev / manual override: set VM_OWNER_UID in the environment.
let VM_OWNER_UID = null;

// Bounded retries: PM2 (autorestart, restart_delay: 5000) can start the bot
// early in VM boot, when the GCP metadata server may be legitimately slow or
// not yet reachable. Before owner-scoped recovery existed, a metadata blip
// only cost the relay token; now it disables ALL strategy recovery for the
// process lifetime, so a single failed attempt is no longer acceptable. Still
// bounded and still fails closed (returns/throws) — no infinite retry loop.
const INSTANCE_NAME_MAX_ATTEMPTS = 3;
const INSTANCE_NAME_RETRY_DELAYS_MS = [500, 1000];

async function fetchInstanceName() {
  let lastErr;
  for (let attempt = 1; attempt <= INSTANCE_NAME_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/name',
        { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
      );
      if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
      return (await res.text()).trim();
    } catch (err) {
      lastErr = err;
      if (attempt < INSTANCE_NAME_MAX_ATTEMPTS) {
        const delayMs = INSTANCE_NAME_RETRY_DELAYS_MS[attempt - 1];
        console.warn(`[VM-OWNER] Metadata read attempt ${attempt}/${INSTANCE_NAME_MAX_ATTEMPTS} failed (${err.message}) — retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  console.warn(`[VM-OWNER] Metadata read failed after ${INSTANCE_NAME_MAX_ATTEMPTS} attempts — giving up (${lastErr.message})`);
  throw lastErr;
}

async function resolveVmOwnerUid() {
  if (process.env.VM_OWNER_UID) {
    const uid = process.env.VM_OWNER_UID.trim().toLowerCase();
    console.log(`[VM-OWNER] Using VM_OWNER_UID from env: ${uid}`);
    return uid;
  }
  let instanceName;
  try {
    instanceName = await fetchInstanceName();
  } catch (err) {
    console.warn(`[VM-OWNER] Could not read instance name from GCP metadata (${err.message}) — owner UNKNOWN`);
    return null;
  }
  const uid = ownerUidFromInstanceName(instanceName);
  if (!uid) {
    console.warn(`[VM-OWNER] Instance name '${instanceName}' does not match vm-user-* — owner UNKNOWN`);
    return null;
  }
  console.log(`[VM-OWNER] Resolved owner uid=${uid} from instance name '${instanceName}'`);
  return uid;
}

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
  const docId = VM_OWNER_UID;
  if (!docId) {
    console.warn('[RELAY-AUTH] VM owner uid unresolved; bot will connect to relay without a token');
    return;
  }
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

VM_OWNER_UID = await resolveVmOwnerUid();

// Restricts the per-user endpoints below to this VM's owner. Late-bound getter:
// VM_OWNER_UID is assigned just above by a top-level await.
const requireVmOwner = createRequireVmOwner(() => VM_OWNER_UID);

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
    // A valid token proves WHO is connecting, not WHOSE VM this is. The 25s
    // broadcast below pushes health + every running strategy's heartbeat to all
    // connected clients, so admitting a foreign user leaks another user's live
    // position, PnL and mode. Same ownership rule as the HTTP guard.
    if (!isAllowedVmUser(decoded.uid, VM_OWNER_UID)) {
      console.warn(`[WS] NOT_VM_OWNER — refused ${decoded.uid} (owner=${VM_OWNER_UID})`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
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

/**
 * Is `strategyId` a strategy belonging to `uid`?
 *
 * The `strategies` collection is SHARED across every user's dedicated VM, so a
 * strategyId alone proves nothing — requireVmOwner establishes that the CALLER
 * owns this VM, and this establishes that the DOC belongs to that same caller.
 *
 * Exact-match comparison: `data.userId` and `req.uid` are both the original
 * mixed-case Firebase uid. (Do NOT lowercase here — that is the VM_OWNER_UID
 * rule, which compares against a uid derived from the GCP instance name.)
 *
 * A doc with no `userId` cannot be attributed and is treated as NOT owned —
 * fail closed. It is logged so an orphaned doc is diagnosable rather than just
 * invisible.
 */
async function strategyOwnedByCaller(strategyId, uid) {
  if (!uid) {
    console.warn(`[AUTHZ] no uid on strategyOwnedByCaller(strategyId=${strategyId}) — treating as NOT owned (fail closed; is HTTP_AUTH_REQUIRED=false?)`);
  }
  const doc = await firestore.collection('strategies').doc(strategyId).get();
  if (!doc.exists) return { exists: false, owned: false, data: null };
  const data = doc.data();
  if (!data.userId) {
    console.warn(`[AUTHZ] strategies/${strategyId} has no userId — treating as NOT owned (fail closed)`);
    return { exists: true, owned: false, data };
  }
  return { exists: true, owned: data.userId === uid, data };
}

// New endpoint to fetch strategy-specific trades
app.get('/strategy/:strategyId/trades', requireVmOwner, async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { exists, owned } = await strategyOwnedByCaller(strategyId, req.uid);
    // 404 rather than 403 — see /strategies/:strategyId.
    if (!exists || !owned) {
      return res.status(404).json({ error: 'Strategy not found' });
    }
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
app.get('/strategy/:strategyId/logs', requireVmOwner, async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { exists, owned } = await strategyOwnedByCaller(strategyId, req.uid);
    // 404 rather than 403 — see /strategies/:strategyId.
    if (!exists || !owned) {
      return res.status(404).json({ error: 'Strategy not found' });
    }
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
app.get('/strategy/:strategyId/strategyFlow', requireVmOwner, async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { exists, owned } = await strategyOwnedByCaller(strategyId, req.uid);
    // 404 rather than 403 — see /strategies/:strategyId.
    if (!exists || !owned) {
      return res.status(404).json({ error: 'Strategy not found' });
    }
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
app.get('/wallet-history', requireVmOwner, async (req, res) => {
  res.status(410).json({
    error: 'This endpoint has been deprecated. Futures balance history is no longer tracked.',
    timestamp: new Date().toISOString()
  });
});

// List all strategies endpoint
app.get('/strategies', requireVmOwner, async (req, res) => {
  try {
    if (!req.uid) {
      console.warn(`[AUTHZ] no req.uid on ${req.method} ${req.path} — returning no strategies (fail closed; is HTTP_AUTH_REQUIRED=false?)`);
    }
    // The `strategies` collection is SHARED across every user's dedicated VM, so
    // an unfiltered read returns OTHER users' strategies. (The comment that used
    // to sit here said the VM "doesn't inherently know the user ID" — that has
    // been false since v1.2.5, which resolves the VM's owner at boot; and
    // req.uid is the authenticated caller, already proven by requireVmOwner to
    // be that owner.)
    //
    // Filtered in memory rather than with .where('userId','==',uid): combining a
    // where() with the existing orderBy('createdAt') needs a composite Firestore
    // index, and a missing index fails at RUNTIME. The collection is small
    // (a handful of strategies per user), so this costs nothing and needs no
    // index deployment.
    const strategiesRef = firestore.collection('strategies');
    const snapshot = await strategiesRef.orderBy('createdAt', 'desc').get(); // Order by creation date, newest first

    // Decode each doc's proto once (DocumentSnapshot.data() re-decodes on every
    // call) and carry {id, data} through the filter/map chain below.
    const docs = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));

    // Docs with no userId can't be attributed to anyone and are dropped below —
    // log which ones so a legacy doc vanishing from a user's list is
    // diagnosable rather than silently invisible (mirrors ladder-recovery.js's
    // noUserIdIds).
    const noUserIdIds = docs.filter(({ data }) => !data.userId).map(({ id }) => id);
    if (noUserIdIds.length) {
      console.warn(`[AUTHZ] /strategies dropped ${noUserIdIds.length} doc(s) with no userId: ${noUserIdIds.join(', ')}`);
    }

    const strategies = docs
      .filter(({ data }) => data.userId === req.uid)
      .map(({ id, data }) => ({
        strategyId: id,
        profileId: data.profileId, // ADDED: Include profileId from Firestore document
        symbol: data.symbol,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null, // Convert Firestore Timestamp to ISO string
        totalPnL: data.totalPnL || 0,
        accumulatedRealizedPnL: data.accumulatedRealizedPnL || 0,
        accumulatedTradingFees: data.accumulatedTradingFees || 0,
        isRunning: activeStrategies.has(id) && activeStrategies.get(id).isRunning, // Check if currently running on this VM
      }));

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
app.get('/strategies/:strategyId', requireVmOwner, async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { exists, owned, data } = await strategyOwnedByCaller(strategyId, req.uid);

    // 404 (not 403) when it exists but is not the caller's: a 403 would confirm
    // that this strategyId is real, leaking the existence of other users' rows.
    if (!exists || !owned) {
      return res.status(404).json({ error: 'Strategy not found' });
    }
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
// User-initiated stop still goes through the /reversal-ladder/stop HTTP endpoint,
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

    // FAIL CLOSED. The `strategies` collection is SHARED across every user's
    // dedicated VM, and a resumed doc trades through the proxy carried inside
    // it — i.e. the DOC OWNER's Binance account. A VM that cannot prove which
    // user it belongs to must therefore resume NOTHING; resuming "just in case"
    // is how one user's VM ended up trading another user's account.
    if (!VM_OWNER_UID) {
      console.error(
        '[RECOVERY] ABORT — this VM could not determine its owner uid (owner uid unresolved — see the [VM-OWNER] log line above for the reason). ' +
        'Resuming NOTHING: resuming without verifying ownership would trade another user\'s Binance account.'
      );
      return;
    }

    const snapshot = await firestore.collection('strategies')
      .where('isRunning', '==', true)
      .get();

    if (snapshot.empty) {
      console.log('[RECOVERY] No orphaned strategies found.');
      return;
    }

    const { resume, skippedForeign, skippedNoUserId, noUserIdIds } = selectRecoverableStrategies(
      snapshot.docs.map((d) => ({ id: d.id, userId: d.data().userId })),
      VM_OWNER_UID,
    );
    const resumable = new Set(resume);

    console.log(
      `[RECOVERY] ${snapshot.size} running doc(s) — resuming ${resume.length} owned by ${VM_OWNER_UID}, ` +
      `skipped ${skippedForeign} foreign, ${skippedNoUserId} without a userId.`
    );
    if (noUserIdIds.length) {
      console.warn(`[RECOVERY] Skipped for missing userId: ${noUserIdIds.join(', ')}`);
    }

    if (!resume.length) return;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const strategyId = doc.id;

      // Skip if already in activeStrategies (defensive — shouldn't happen on boot).
      if (activeStrategies.has(strategyId)) {
        console.log(`[RECOVERY] Skipping ${strategyId} — already active`);
        continue;
      }

      // Ownership + strategy-type allowlisting were both decided above by
      // selectRecoverableStrategies(); anything absent from that set is either
      // another user's strategy or a retired doc shape, and must NOT be resumed.
      if (!resumable.has(strategyId)) continue;

      try {
        const strategy = new ReversalLadderStrategy(
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

        // Resume in background — same non-blocking pattern as /reversal-ladder/start.
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

// Scheduled update: restricted to this VM's owner (requireVmOwner).
// Admins pass through for the fleet release rollout (backend forwards the
// admin bearer token). httpAuthMiddleware (global) still enforces a valid
// Firebase token. Admin-only /system/force-update (below) bypasses the
// "wait-for-idle" guard and could disrupt a running strategy.
app.post('/system/update', requireVmOwner, async (req, res) => {
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
  //      for isRunning Reversal Ladder strategies and calls strategy.resume()
  //      on each, which reconciles positions against Binance and reattaches
  //      WS streams.
  //   3. User-initiated stop (/reversal-ladder/stop) is still the only path that
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
        // Remember what just exhausted its retries so the 60s idle poller does
        // not immediately start the same doomed chain again. A new release
        // clears this; a manual /self-update call bypasses it deliberately,
        // because an operator asking explicitly is not the runaway this guards.
        lastFailedTarget = targetVersion;
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

      // ORDERING, never inequality. TOMBSTONE (2026-08-02): this used to be
      // `latestVersion !== BOT_VERSION`, which armed an update whenever the two
      // merely DIFFERED — including when this VM was running code NEWER than
      // the declared release. That is the normal state for every VM provisioned
      // between a master push and the admin release bump, and it made them
      // auto-trigger a DOWNGRADE on boot (a fresh VM has no active strategies,
      // so the auto-trigger gate was always open). The downgrade could never
      // land — self-update.sh always pulls origin/master, which IS the newer
      // code — so it failed and the 60s idle poller retried it forever.
      // See version-compare.js. Do not "simplify" this back to !==.
      if (isNewerVersion(latestVersion, BOT_VERSION)) {
        if (!updateAvailable || targetVersion !== latestVersion) {
          console.log(`[UPDATE] New version detected: ${latestVersion} (current: ${BOT_VERSION})`);
          updateAvailable = true;
          targetVersion = latestVersion;
          // A genuinely different target clears the failure memory below, so a
          // real new release always gets a fresh attempt even if the previous
          // one failed.
          lastFailedTarget = null;

          if (activeStrategies.size === 0 && !isUpdating) {
            console.log(`[UPDATE] No active strategies. Auto-triggering update to ${latestVersion}...`);
            triggerSelfUpdate().catch(err => console.error('[UPDATE] Auto self-update failed:', err));
          } else {
            console.log(`[UPDATE] ${activeStrategies.size} strategies running. Update will apply when idle.`);
          }
        }
      } else if (parseVersion(latestVersion)) {
        // Same version, or this VM is AHEAD of the declared release. Both are
        // "nothing to do". A malformed/absent latestVersion falls through to
        // neither branch on purpose: it is unknown, not "up to date", so the
        // current state is left exactly as it is.
        const wasArmed = updateAvailable;
        updateAvailable = false;
        targetVersion = null;
        lastFailedTarget = null;
        // Clear the PERSISTED status too. Without this the admin UI stays stuck
        // on the old `update_failed` + its stale targetVersion forever:
        // reportUpdateStatus was only ever called with updating /
        // update_failed / restarting, so nothing ever wrote it back to a
        // resting state, and bumping the release doc to match this VM cleared
        // the in-memory flag while leaving the Firestore record untouched.
        //
        // `!reportedRestingState` is what HEALS a VM that is already stuck. On a
        // fresh boot `wasArmed` is false — the in-memory flag starts false — so
        // gating on it alone would leave every VM carrying a stale update_failed
        // from before this fix showing it forever, which is exactly the state
        // this release exists to clear. Report once per process instead, then
        // only on a real armed -> resting transition.
        if (wasArmed || !reportedRestingState) {
          reportedRestingState = true;
          console.log(`[UPDATE] Declared release ${latestVersion} is not newer than ${BOT_VERSION} — clearing update state.`);
          reportUpdateStatus('up_to_date', { latestVersion, botVersion: BOT_VERSION }).catch(() => {});
        }
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
    // `lastFailedTarget` stops this retrying a target that has ALREADY failed
    // its full retry chain. Without it a permanently-impossible update (the
    // 2026-08-02 downgrade loop) re-ran every 60s forever, each round burning
    // five script invocations and writing another update_failed to Firestore.
    // A real new release clears the memory (see setupReleaseListener), so this
    // suppresses only the exact target that just exhausted its retries.
    if (updateAvailable && targetVersion && targetVersion === lastFailedTarget) return;
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

// ——— Reversal Ladder Strategy endpoints ————————————————————————————————

app.post('/reversal-ladder/prepare-symbol', requireVmOwner, (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required' });
  }
  const normalized = symbol.toUpperCase();
  if (warmSymbol === normalized && warmWs && warmWs.readyState === WsClient.OPEN) {
    return res.json({ ok: true, alreadyWarm: true, symbol: normalized });
  }
  _closeWarmWs('switching symbol');
  _openWarmWs(normalized);
  return res.json({ ok: true, symbol: normalized });
});

app.post('/reversal-ladder/start', requireVmOwner, async (req, res) => {
  if (isUpdating) {
    return res.status(503).json({ error: 'VM is currently updating.', code: 'VM_UPDATING' });
  }

  try {
    const { profileId, gcpProxyUrl, sharedVmProxyGcfUrl, config, userId } = req.body;

    if (!profileId || !gcpProxyUrl || !sharedVmProxyGcfUrl || !config) {
      return res.status(400).json({ error: 'profileId, gcpProxyUrl, sharedVmProxyGcfUrl, and config are required.' });
    }

    // Defence in depth — ReversalLadderStrategy.start() gates on the geometry
    // bounds (ladder-levels.js resolveLadderGeometry) too, but those checks
    // fire deep inside the non-blocking start() promise after the 200
    // response has already gone out. Reject here up front, via the SAME
    // validator start() uses, so an out-of-bounds request never even mints a
    // strategyId or touches the billing gate, AND so this gate can never
    // silently re-diverge from start()'s (it did once, within a single task —
    // see resolveLadderGeometry's docstring in ladder-levels.js).
    const geometry = resolveLadderGeometry({
      ladderStepPct: config.ladderStepPct,
      ladderLevelsPerSide: config.ladderLevelsPerSide,
    });
    if (!geometry.ok) {
      return res.status(400).json({ error: geometry.error, code: geometry.code });
    }
    const minSize = minInitialSizeUSDT(geometry.levelsPerSide);
    if (!(Number(config.initialSize) >= minSize)) {
      return res.status(400).json({
        error: `Initial size (${config.initialSize} USDT) is below the ${minSize} USDT minimum for a ${geometry.levelsPerSide}-level ladder.`,
        code: 'INITIAL_SIZE_TOO_LOW',
      });
    }

    // One strategy per profile (matches existing model). User must stop the running strategy first.
    for (const [sId, running] of activeStrategies.entries()) {
      if (running.profileId === profileId) {
        return res.status(400).json({
          error: `A strategy for profile ${profileId} is already running. Stop it before starting Reversal Ladder.`,
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

    const strategy = new ReversalLadderStrategy(gcpProxyUrl, profileId, sharedVmProxyGcfUrl);
    strategy.userId = req.uid || userId;

    const strategyId = `reversal_ladder_${profileId}_${Date.now()}`;
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

    // Persist the doc BEFORE handing the strategyId to the caller.
    //
    // `start()` runs non-blocking and only reaches its own saveState() at the
    // very END — after setLeverage, setPositionMode, exchange info, the wallet
    // snapshot, WS setup, the position refresh and the funding poll. That is
    // seconds of network I/O, and the frontend begins polling the moment it
    // receives this response. Every ownership-scoped route resolves through
    // `strategyOwnedByCaller`, which fail-closes to 404 when the doc does not
    // exist yet — so a perfectly healthy start emitted a burst of
    // "404 Strategy not found" until start() happened to finish.
    //
    // Writing it here also means a crash DURING start() leaves a recoverable
    // doc (userId/profileId/type/isRunning) instead of an orphan the boot scan
    // cannot see. saveState() catches its own errors, so this cannot reject the
    // start request.
    await strategy.saveState();

    console.log(`✓ Reversal Ladder Strategy ${strategyId} starting (non-blocking)...`);
    res.json({
      success: true,
      strategyId,
      message: 'Reversal Ladder Strategy starting',
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
        console.error(`Failed to start Reversal Ladder Strategy ${strategyId}:`, error);
        // NOTE: the parent Firestore doc does not exist yet at this point — the
        // id is freshly minted, initFirestoreCollections only builds
        // references, and addLog writes to the `logs` SUBcollection (leaving
        // the parent a phantom doc). A bare `.doc(strategyId).update({...})`
        // rejects NOT_FOUND and would be silently swallowed by a trailing
        // `.catch(() => {})`, so a start rejected after the non-blocking 200
        // would vanish without a trace. Go through saveState() instead — it
        // already persists criticalError and `.set(..., {merge:true})`s the
        // full doc shape (userId/profileId/type/...) so the frontend's query
        // can actually see it. isRunning must be false BEFORE saveState runs
        // so that is what gets persisted.
        strategy.isRunning = false;
        strategy.criticalError = `start_failed: ${error.message}`;
        activeStrategies.delete(strategyId);
        strategy.saveState().catch(() => {});
      });
  } catch (error) {
    console.error('Failed to start Reversal Ladder Strategy:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/reversal-ladder/stop', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, flatten } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No Reversal Ladder strategy running with ID ${strategyId}` });
    }

    res.json({ success: true, stopping: true, message: 'Reversal Ladder Strategy stop initiated', strategyId });

    setImmediate(async () => {
      try {
        await strategy.stop({ flatten: !!flatten });
        activeStrategies.delete(strategyId);
      } catch (error) {
        console.error(`Error stopping Reversal Ladder Strategy ${strategyId}:`, error);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ReversalLadderStrategy.getStatus() (Task 9) already returns the full ladder
// shape directly — mode, anchor, ladderLines, trendDirection, levelsPerSide,
// stepPct, legNotional, ladderBaseSize — alongside the base TradingBase
// fields. Unlike the retired grid strategy's status route, no extra
// field-bolting is needed here; getStatus() IS the response.
app.get('/reversal-ladder/status', requireVmOwner, (req, res) => {
  const { strategyId } = req.query;

  if (strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy)) {
      return res.status(404).json({ error: `Reversal Ladder strategy ${strategyId} not found.` });
    }
    return res.json(strategy.getStatus());
  }

  const ladderStrategies = {};
  activeStrategies.forEach((strategy, sId) => {
    if (strategy instanceof ReversalLadderStrategy) {
      ladderStrategies[sId] = strategy.getStatus();
    }
  });

  res.json({ strategies: ladderStrategies, count: Object.keys(ladderStrategies).length });
});

// Manual user-driven re-anchor / harvest. Works whether flat or holding — the
// only gate is that the strategy is running. Closes any open position to flat at
// market (reduceOnly; nothing to close when flat), then re-anchors the ladder on
// the live price. A flat run is recorded as a RE-ANCHOR (reanchorCount), not a
// harvest. The frontend labels it Harvest (unrealized >= 0), Re-anchor
// (unrealized < 0), or Re-anchor (flat). The cycle CONTINUES — this does NOT stop
// the strategy. strategy.harvestNow() queues the action via the manual-harvest
// latch honored on the next free tick, so the response is an immediate verdict.
//
// triggerPrice omitted/null → immediate re-anchor (today's behavior); a number
// → arm a one-shot trigger validated + rounded by the strategy. Two error
// shapes: a genuine state conflict ('Strategy is not running.') → 409;
// trigger-price validation failures (bad price, no live price yet, too close to
// the current price) are tagged by the strategy (error.invalidInput) → 400. The
// strategy remains the sole authority on trigger validity — this route does not
// duplicate that logic.
app.post('/reversal-ladder/harvest-now', requireVmOwner, async (req, res) => {
  try {
    // `action` selects what an armed trigger DOES on arrival: 'reanchor'
    // (default, today's behaviour) or 'stop' — close and end the cycle, for
    // banking a profit without rebuilding the ladder. Ignored for an immediate
    // harvest (no triggerPrice), which has nothing to schedule.
    const { strategyId, triggerPrice, action } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.harvestNow(triggerPrice ?? null, { action: action ?? 'reanchor' });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.invalidInput ? 400 : 409).json({ error: error.message });
  }
});

// Cancel an armed harvest/re-anchor Trigger Price (set via harvest-now with a
// triggerPrice). Idempotent — clears the latch if present. 400 if the strategy
// isn't a running Reversal Ladder.
app.post('/reversal-ladder/cancel-harvest-trigger', requireVmOwner, async (req, res) => {
  try {
    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.cancelHarvestTrigger();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Manual user-driven edit of the cycle's desired-profit % while running. The
// bot converts the % to USDT against initialCapital (the cycle-start basis),
// recomputes Final TP, and persists. Allowed in any subState — no trade
// fires here; the new Final TP target just takes effect on the next price
// tick. Shipped user feature carried over from AI Reversal; adjustProfitTarget
// survives unchanged on ReversalLadderStrategy.
// Move the Final TP to a user-chosen LEVEL, or reset it to the config target.
// Body: { strategyId, price } to set, or { strategyId, reset: true } to restore
// the config view's desired profit. The bot back-solves the level into a profit
// target and lets _recomputeFinalTpPrice re-derive the price, so this never
// becomes a second writer of finalTpPrice. 400 on a bad/too-low level (the
// config target is a hard floor), 409 when there is no verified position to
// derive against; the not-found guard returns 400 like its siblings.
app.post('/reversal-ladder/adjust-final-tp', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, price, profitUSDT, reset } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    if (price == null && profitUSDT == null && reset !== true) {
      return res.status(400).json({ error: 'Provide a price, a profitUSDT, or reset: true.' });
    }
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.adjustFinalTp({ price: price ?? null, profitUSDT: profitUSDT ?? null, reset: reset === true });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.invalidInput ? 400 : 409).json({ error: error.message });
  }
});

app.post('/reversal-ladder/adjust-profit-target', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, desiredProfitPercent } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    if (desiredProfitPercent == null) {
      return res.status(400).json({ error: 'desiredProfitPercent is required.' });
    }

    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }

    const result = await strategy.adjustProfitTarget({ desiredProfitPercent: Number(desiredProfitPercent) });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Manual edit of one or both levels (§3). Both bullLevel/bearLevel are
// optional but at least one is required — editLevels() enforces that itself,
// so this route does not duplicate the check. It also refuses a level on the
// wrong side of live price and refuses to move a side that already holds a
// filled leg (see editLevels' docstring in reversal-ladder-strategy.js).
// Error shapes match harvestNow: input errors set .invalidInput = true
// (→ 400); state conflicts are untagged (→ 409).
app.post('/reversal-ladder/edit-levels', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, bullLevel, bearLevel } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.editLevels({ bullLevel: bullLevel ?? null, bearLevel: bearLevel ?? null });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.invalidInput ? 400 : 409).json({ error: error.message });
  }
});

// Ask the planner for a level proposal WITHOUT applying it (§10). This makes
// a LIVE AI round trip, so it is slower than the other action routes above —
// callers should not assume harvest-now/adjust-*-style response latency
// here. Returns a PROPOSAL ONLY; applying it is a separate, explicit
// edit-levels call made by the user.
app.post('/reversal-ladder/ask-ai', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, question } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.askAi(question);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.invalidInput ? 400 : 409).json({ error: error.message });
  }
});

// Arm/disarm the TREND trailing exit. `enabled` is passed through to
// setTrailEnabled() VERBATIM — do NOT coerce it (no !!enabled, no
// enabled === 'true', no ?? false). setTrailEnabled() deliberately accepts
// only real booleans and rejects everything else with .invalidInput = true,
// so a malformed request surfaces as a visible 400 instead of silently
// reading as "off" and disarming an exit the user believed was armed.
app.post('/reversal-ladder/trail', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, enabled } = req.body;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || !(strategy instanceof ReversalLadderStrategy) || !strategy.isRunning) {
      return res.status(400).json({ error: `No running Reversal Ladder strategy with ID ${strategyId}` });
    }
    const result = await strategy.setTrailEnabled(enabled);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.invalidInput ? 400 : 409).json({ error: error.message });
  }
});

// strategyFlow audit trail for Reversal Ladder. Reads from
// strategies/{strategyId}/strategyFlow subcollection populated by
// ReversalLadderStrategy._writeStrategyFlow inside its post-execute bookkeeping
// on every position event (LADDER_FILL / REVERSAL / TREND_ENTER / TRAILED_EXIT
// / HARVEST / LEVELS_EDITED / FINAL_TP_HIT). Used by the position chart to place TP segment boundaries
// at EXACT event moments instead of heartbeat-resolution timestamps.
app.get('/reversal-ladder/strategy-flow', requireVmOwner, async (req, res) => {
  try {
    const { strategyId, limit: queryLimit } = req.query;
    if (!strategyId) return res.status(400).json({ error: 'strategyId is required.' });

    const { exists, owned } = await strategyOwnedByCaller(strategyId, req.uid);
    // 404 rather than 403 — see /strategies/:strategyId.
    if (!exists || !owned) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

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