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
      RELAY_WS_URL: 'ws://34.126.80.106:8080/ws',
      // Shared-secret token for relay auth. SET VIA SHELL ENV — never hardcode
      // here (repo is public). Must match RELAY_AUTH_TOKEN on the relay VM.
      // Example deploy step:
      //   export RELAY_AUTH_TOKEN=$(cat /etc/ycbot-relay-token)
      //   pm2 restart ecosystem.config.cjs --update-env
      RELAY_AUTH_TOKEN: process.env.RELAY_AUTH_TOKEN
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