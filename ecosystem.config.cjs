module.exports = {
  apps: [{
    name: 'ycbot',
    script: 'app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '768M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      GOOGLE_APPLICATION_CREDENTIALS: '/opt/vm-bot/service-account-key.json',
      GOOGLE_CLOUD_PROJECT_ID: 'ycbot-6f336',
      // Phase 2: route all Binance WS through the shared ycbot-ws-relay. VM IP
      // never talks directly to Binance, avoiding the IP-reputation class of
      // bans. Leave unset to fall back to direct Binance.
      RELAY_WS_URL: 'ws://34.126.80.106:8080/ws'
      // RELAY_AUTH_TOKEN is fetched at runtime by app.js loadRelayAuthToken()
      // from Firestore (relay_auth_tokens/<uid>). No env var needed in PROD.
      // Local dev: export RELAY_AUTH_TOKEN=... to skip the Firestore lookup.
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    mode: 'fork',
    exec_mode: 'fork',
    cwd: '/opt/vm-bot'
  }]
};