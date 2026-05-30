module.exports = {
  apps: [{
    name: 'ycbot',
    script: 'app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '768M',
    // C4: bound restart loops. If the bot crashes within 10s of starting it
    // doesn't count as a "successful" run, and after 5 such failed attempts
    // PM2 stops trying — keeps a poison-pill bug from burning CPU forever
    // and surfaces the failure in `pm2 status` instead of hiding it. Normal
    // restarts (memory cap, code update, post-10s crash) still auto-recover.
    max_restarts: 5,
    min_uptime: '10s',
    restart_delay: 5000,
    // Give graceful shutdown 30s to save state to Firestore before SIGKILL.
    kill_timeout: 30000,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      GOOGLE_APPLICATION_CREDENTIALS: '/opt/vm-bot/service-account-key.json',
      GOOGLE_CLOUD_PROJECT_ID: 'ycbot-6f336',
      // Phase 2: route all Binance WS through the shared ycbot-ws-relay. VM IP
      // never talks directly to Binance, avoiding the IP-reputation class of
      // bans. Leave unset to fall back to direct Binance.
      // v4.4.7: relay migrated from Taiwan (34.80.183.147, asia-east1) to
      // Singapore (34.158.49.25, asia-southeast1) to co-locate with bot VMs.
      // Saves ~48ms per market data round-trip (was TW↔SG cross-region,
      // now intra-region <2ms).
      RELAY_WS_URL: 'ws://34.158.49.25:8080/ws',
      // C5 admin gate: comma-separated list of Firebase UIDs allowed to call
      // /system/* and /test/* endpoints (requireAdmin middleware). Without
      // this set, all admin endpoints reject with "Forbidden — uid is not
      // in the admin list" even when the caller has a valid Firebase token.
      HTTP_ADMIN_UIDS: 'DKcVtSFFJOVvDzHLMrnPlJhAk3B3'
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