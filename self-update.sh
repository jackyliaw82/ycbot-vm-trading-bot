#!/bin/bash
set -e

LOG_FILE="/var/log/vm-bot-update.log"
WORK_DIR="/opt/vm-bot"
CHECKSUM_FILE="$WORK_DIR/.package-lock-checksum"
HEALTH_URL="http://localhost:3000/startup-status"
MAX_HEALTH_ATTEMPTS=20
HEALTH_WAIT_SECONDS=3

export PM2_HOME="${PM2_HOME:-/root/.pm2}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Starting self-update ==="
cd "$WORK_DIR"

PREV_COMMIT=$(git rev-parse HEAD)
log "Current commit: ${PREV_COMMIT:0:8}"

OLD_CHECKSUM=""
if [ -f "$CHECKSUM_FILE" ]; then
  OLD_CHECKSUM=$(cat "$CHECKSUM_FILE")
fi

log "Fetching latest changes..."
git fetch origin master 2>&1 | tee -a "$LOG_FILE"

REMOTE=$(git rev-parse origin/master)

if [ "$PREV_COMMIT" = "$REMOTE" ]; then
  log "Already up to date. No changes to pull."
  exit 0
fi

log "Pulling latest changes (local: ${PREV_COMMIT:0:8}, remote: ${REMOTE:0:8})..."
git pull origin master 2>&1 | tee -a "$LOG_FILE"

NEW_CHECKSUM=""
if [ -f "package-lock.json" ]; then
  NEW_CHECKSUM=$(md5sum package-lock.json | awk '{print $1}')
fi

if [ "$OLD_CHECKSUM" != "$NEW_CHECKSUM" ]; then
  log "package-lock.json changed. Running npm install..."
  npm install --production 2>&1 | tee -a "$LOG_FILE"
else
  log "package-lock.json unchanged. Skipping npm install."
fi

if [ -f "package-lock.json" ]; then
  md5sum package-lock.json | awk '{print $1}' > "$CHECKSUM_FILE"
fi

log "Restarting bot via PM2..."
pm2 restart ycbot 2>&1 | tee -a "$LOG_FILE"

log "Verifying bot health after restart..."
ATTEMPT=0
HEALTHY=false

while [ $ATTEMPT -lt $MAX_HEALTH_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))
  sleep $HEALTH_WAIT_SECONDS

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    HEALTHY=true
    log "Health check passed on attempt $ATTEMPT (HTTP $HTTP_CODE)"
    break
  else
    log "Health check attempt $ATTEMPT/$MAX_HEALTH_ATTEMPTS: HTTP $HTTP_CODE"
  fi
done

if [ "$HEALTHY" = false ]; then
  log "ERROR: Bot failed health check after $MAX_HEALTH_ATTEMPTS attempts."
  log "Rolling back to previous commit ${PREV_COMMIT:0:8}..."

  git checkout "$PREV_COMMIT" 2>&1 | tee -a "$LOG_FILE"

  if [ "$OLD_CHECKSUM" != "$NEW_CHECKSUM" ]; then
    log "Restoring previous dependencies..."
    npm install --production 2>&1 | tee -a "$LOG_FILE"
  fi

  pm2 restart ycbot 2>&1 | tee -a "$LOG_FILE"
  log "Rollback complete. Bot restored to ${PREV_COMMIT:0:8}."

  sleep 5
  ROLLBACK_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$ROLLBACK_CODE" = "200" ]; then
    log "Bot healthy after rollback."
  else
    log "WARNING: Bot may not be healthy after rollback (HTTP $ROLLBACK_CODE)."
  fi

  exit 1
fi

NEW_VERSION=$(curl -s "$HEALTH_URL" 2>/dev/null | grep -o '"botVersion":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
log "Bot is healthy. Running version: $NEW_VERSION"
log "=== Self-update completed successfully ==="
