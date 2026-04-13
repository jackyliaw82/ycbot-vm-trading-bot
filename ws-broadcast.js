import WebSocket from 'ws';

/**
 * WsBroadcast — drop-in replacement for WsRelayClient.
 *
 * Exposes the same interface (pushStrategyUpdate, pushLog, pushTrade, isConnected)
 * so strategies don't need any code changes. Instead of relaying through Cloud Run,
 * broadcasts directly to frontend WebSocket clients connected to the local server.
 */
class WsBroadcast {
  constructor() {
    this.wss = null;
  }

  /**
   * Register the WebSocketServer instance.
   * @param {import('ws').WebSocketServer} wss
   */
  setWss(wss) {
    this.wss = wss;
  }

  /**
   * Whether any clients are connected.
   */
  get isConnected() {
    return this.wss && this.wss.clients.size > 0;
  }

  /**
   * Broadcast a message to all connected clients.
   */
  _broadcast(message) {
    if (!this.wss) return;
    const json = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(json); } catch {}
      }
    }
  }

  /**
   * Push strategy status update — same signature as WsRelayClient.
   */
  pushStrategyUpdate(strategyId, statusData) {
    this._broadcast({ type: 'strategy_update', strategyId, data: statusData });
  }

  /**
   * Push log entry — same signature as WsRelayClient.
   */
  pushLog(strategyId, logEntry, timestamp) {
    this._broadcast({ type: 'log', strategyId, data: { message: logEntry, timestamp } });
  }

  /**
   * Push trade — same signature as WsRelayClient.
   */
  pushTrade(strategyId, tradeData) {
    this._broadcast({ type: 'trade', strategyId, data: tradeData });
  }

  /**
   * Push health data.
   */
  pushHealth(healthData) {
    this._broadcast({ type: 'health', data: healthData });
  }

  /**
   * Get connected client count.
   */
  getClientCount() {
    return this.wss ? this.wss.clients.size : 0;
  }
}

// Singleton instance
const wsBroadcast = new WsBroadcast();
export { WsBroadcast, wsBroadcast };
export default wsBroadcast;
