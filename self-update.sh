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

# Report the ACTUAL version + commit that the pull landed — do NOT overwrite
# package.json to the release target.
#
# Stamping the target version here (the old behavior) is what let a VM report
# the requested version while still running OLDER code: a git pull can lag a
# freshly-pushed release, so the pull grabs an earlier commit, but the version
# gets rewritten to the target anyway. The admin panel then shows "up to date"
# for stale code, and updateAvailable (a version-string compare against
# BOT_VERSION) never trips again — the update silently sticks.
#
# Reporting the REAL version keeps the updater self-correcting instead: if the
# pull didn't reach the target's commit yet, BOT_VERSION stays the old value,
# updateAvailable stays true, and the next idle poll retries until the pulled
# code's own package.json actually reaches the target. The version can never
# claim to be something the running code isn't.
verify_pulled_version() {
  local actual
  actual=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
  log "Running commit $(git rev-parse --short HEAD 2>/dev/null || echo '?'), package.json version: ${actual}"
  # Safety: confirm the working tree actually contains origin/master (guards a
  # partial/failed pull from restarting on stale code).
  if ! git merge-base --is-ancestor "$REMOTE" HEAD 2>/dev/null; then
    log "ERROR: pulled HEAD does not contain origin/master (${REMOTE:0:8}). Aborting without restart."
    exit 1
  fi
  if [ -n "$TARGET_VERSION" ] && [ "$actual" != "$TARGET_VERSION" ]; then
    log "WARNING: release target ${TARGET_VERSION} != master's package.json (${actual}) — reporting the ACTUAL code version. The update will re-run until master is bumped to ${TARGET_VERSION}. (Did you bump package.json before publishing the release?)"
  fi
}

log "=== Starting self-update ==="
cd "$WORK_DIR"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$CURRENT_BRANCH" != "master" ]; then
  log "Not on master branch (current: ${CURRENT_BRANCH:-detached}). Switching to master..."
  git checkout master 2>&1 | tee -a "$LOG_FILE"
fi

log "Resetting local changes to ensure clean working tree..."
git reset --hard HEAD 2>&1 | tee -a "$LOG_FILE"

PREV_COMMIT=$(git rev-parse HEAD)
log "Current commit: ${PREV_COMMIT:0:8}"
log "Target version: ${TARGET_VERSION:-not set}"

OLD_CHECKSUM=""
if [ -f "$CHECKSUM_FILE" ]; then
  OLD_CHECKSUM=$(cat "$CHECKSUM_FILE")
fi

log "Fetching latest changes..."
git fetch origin master 2>&1 | tee -a "$LOG_FILE"

REMOTE=$(git rev-parse origin/master)

NEEDS_RESTART=false

if [ "$PREV_COMMIT" = "$REMOTE" ]; then
  log "Already on latest commit. No new code to pull."
  log "ERROR: Target version ${TARGET_VERSION} requested but no new commits found on remote."
  exit 2
else
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

  verify_pulled_version
  NEEDS_RESTART=true
fi

if [ "$NEEDS_RESTART" = false ]; then
  log "No restart needed."
  exit 0
fi

log "Restarting bot via PM2..."
sudo pm2 restart /opt/vm-bot/ecosystem.config.cjs --update-env 2>&1 | tee -a "$LOG_FILE"

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

  git reset --hard "$PREV_COMMIT" 2>&1 | tee -a "$LOG_FILE"

  if [ "$OLD_CHECKSUM" != "$NEW_CHECKSUM" ]; then
    log "Restoring previous dependencies..."
    npm install --production 2>&1 | tee -a "$LOG_FILE"
  fi

  sudo pm2 restart /opt/vm-bot/ecosystem.config.cjs --update-env 2>&1 | tee -a "$LOG_FILE"
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
