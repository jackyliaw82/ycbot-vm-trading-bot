import WebSocket from 'ws';

// Constants matching trading-base.js patterns
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 25;
const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 10000;

export class WsRelayClient {
  /**
   * @param {Object} options
   * @param {string} options.proxyUrl - Cloud Run WS proxy URL (wss://...)
   * @param {string} options.userId - Firebase user ID for routing
   * @param {string} options.secret - Shared secret for auth
   * @param {function} options.getHealthData - Returns health payload (same as /health endpoint)
   * @param {string} [options.botVersion] - Bot version string
   */
  constructor({ proxyUrl, userId, secret, getHealthData, botVersion }) {
    this.proxyUrl = proxyUrl;
    this.userId = userId;
    this.secret = secret;
    this.getHealthData = getHealthData;
    this.botVersion = botVersion || 'unknown';

    this.ws = null;
    this._connected = false;
    this._registered = false;
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.pingInterval = null;
    this.pongTimeout = null;
    this.heartbeatInterval = null;
    this._intentionalClose = false;
  }

  get isConnected() {
    return this._connected && this._registered;
  }

  // ─── Connection Lifecycle ────────────────────────────────────────────────────

  connect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    }

    this._intentionalClose = false;
    console.log(`[WsRelay] Connecting to ${this.proxyUrl}...`);
    this.ws = new WebSocket(this.proxyUrl);

    this.ws.on('open', () => {
      console.log('[WsRelay] Connected to Cloud Run proxy. Sending registration...');
      this._connected = true;
      this.reconnectAttempts = 0;

      // Send registration message
      this._send({
        type: 'vm:register',
        userId: this.userId,
        secret: this.secret,
        botVersion: this.botVersion,
      });
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'proxy:registered':
          console.log('[WsRelay] Registration confirmed by proxy');
          this._registered = true;
          this._startHeartbeat();
          this._startPingPong();
          break;

        case 'proxy:ping':
          this._send({ type: 'vm:pong' });
          break;

        default:
          break;
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[WsRelay] WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this._connected = false;
      this._registered = false;
      this._stopHeartbeat();
      this._stopPingPong();

      const reasonStr = reason ? reason.toString() : '';
      console.log(`[WsRelay] Connection closed (code: ${code}, reason: ${reasonStr})`);

      if (!this._intentionalClose) {
        this._scheduleReconnect(code);
      }
    });
  }

  disconnect() {
    this._intentionalClose = true;
    this._stopHeartbeat();
    this._stopPingPong();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Graceful shutdown');
      }
      this.ws = null;
    }
    this._connected = false;
    this._registered = false;
    console.log('[WsRelay] Disconnected');
  }

  // ─── Push Methods (called by app.js and strategy code) ───────────────────────

  pushLog(strategyId, logEntry, timestamp) {
    if (!this.isConnected) return;
    this._send({
      type: 'vm:log',
      strategyId,
      data: { message: logEntry, timestamp },
    });
  }

  pushTrade(strategyId, tradeData) {
    if (!this.isConnected) return;
    this._send({
      type: 'vm:trade',
      strategyId,
      data: tradeData,
    });
  }

  pushStrategyUpdate(strategyId, statusData) {
    if (!this.isConnected) return;
    this._send({
      type: 'vm:strategy_update',
      strategyId,
      data: statusData,
    });
  }

  pushPlanUpdate(strategyId, planData) {
    if (!this.isConnected) return;
    this._send({
      type: 'vm:plan_update',
      strategyId,
      data: planData,
    });
  }

  pushFlowEvent(strategyId, eventData) {
    if (!this.isConnected) return;
    this._send({
      type: 'vm:flow_event',
      strategyId,
      data: eventData,
    });
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    // Send initial heartbeat immediately
    this._sendHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this._sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  _sendHeartbeat() {
    if (!this.isConnected) return;
    try {
      const healthData = this.getHealthData();
      this._send({ type: 'vm:heartbeat', data: healthData });
    } catch (err) {
      console.error('[WsRelay] Error generating heartbeat data:', err.message);
    }
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _startPingPong() {
    this._stopPingPong();
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimeout = setTimeout(() => {
        console.log('[WsRelay] Pong timeout — terminating connection');
        if (this.ws) this.ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    this.ws.on('pong', () => {
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    });
  }

  _stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  _scheduleReconnect(closeCode) {
    // Clean close (1000) from Cloud Run timeout — reconnect immediately
    if (closeCode === 1000) {
      console.log('[WsRelay] Clean close — reconnecting immediately');
      setTimeout(() => this.connect(), 500);
      return;
    }

    this.reconnectAttempts++;
    if (this.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1)
      );
      console.log(`[WsRelay] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      this.reconnectTimeout = setTimeout(() => this.connect(), delay);
    } else {
      // Max attempts reached — fall back to periodic retry every 60s
      console.log(`[WsRelay] Max reconnect attempts reached. Retrying every ${MAX_RECONNECT_DELAY_MS / 1000}s...`);
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectAttempts = 0; // Reset counter for next batch
        this.connect();
      }, MAX_RECONNECT_DELAY_MS);
    }
  }
}
