#!/bin/bash
set -e

LOG_FILE="/var/log/vm-bot-update.log"
WORK_DIR="/opt/vm-bot"
CHECKSUM_FILE="$WORK_DIR/.package-lock-checksum"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Starting self-update ==="
cd "$WORK_DIR"

OLD_CHECKSUM=""
if [ -f "$CHECKSUM_FILE" ]; then
  OLD_CHECKSUM=$(cat "$CHECKSUM_FILE")
fi

log "Fetching latest changes..."
git fetch origin master 2>&1 | tee -a "$LOG_FILE"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Already up to date. No changes to pull."
  exit 0
fi

log "Pulling latest changes (local: ${LOCAL:0:8}, remote: ${REMOTE:0:8})..."
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

log "=== Self-update completed ==="
