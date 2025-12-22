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
      GOOGLE_CLOUD_PROJECT_ID: 'ycbot-6f336'
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
