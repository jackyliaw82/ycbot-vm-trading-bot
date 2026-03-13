#!/bin/bash

# Enhanced VM Startup Script with Error Handling and Logging
# This script provisions and starts the YCBot trading bot on a GCP VM instance

set -e

LOG_FILE="/var/log/vm-bot-startup.log"
ERROR_LOG="/var/log/vm-bot-startup-error.log"

# Initialize log files
sudo touch "$LOG_FILE" "$ERROR_LOG"
sudo chmod 666 "$LOG_FILE" "$ERROR_LOG"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" | tee -a "$ERROR_LOG"
}

# Write guest attribute for external monitoring
write_guest_attribute() {
  local status="$1"
  local error_msg="${2:-}"

  curl -X PUT --data "$status" \
    "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/ycbot/startup-status" \
    -H "Metadata-Flavor: Google" 2>/dev/null || true

  if [ -n "$error_msg" ]; then
    curl -X PUT --data "$error_msg" \
      "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/ycbot/error-message" \
      -H "Metadata-Flavor: Google" 2>/dev/null || true
  fi
}

# Trap errors and log them
trap 'log_error "Script failed at line $LINENO"; write_guest_attribute "failed" "Script failed at line $LINENO"; exit 1' ERR

log "========== VM Startup Script Started =========="
log "User: $(whoami)"
log "PWD: $(pwd)"

# Write startup status for external monitoring
STATUS_FILE="/tmp/vm-bot-startup-status"
echo "initializing" > "$STATUS_FILE"
chmod 644 "$STATUS_FILE"
write_guest_attribute "initializing"

# --- 1. Update system and install git ---
log "Step 1: Updating system packages..."
write_guest_attribute "installing_packages"
sudo apt-get update >> "$LOG_FILE" 2>&1 || log_error "apt-get update failed"

log "Step 2: Installing git..."
sudo apt-get install -y git >> "$LOG_FILE" 2>&1 || log_error "Failed to install git"

log "Step 3: Installing Node.js and npm..."
sudo apt-get install -y nodejs npm >> "$LOG_FILE" 2>&1 || log_error "Failed to install Node.js and npm"

# Verify Node.js installation
NODE_VERSION=$(node -v)
NPM_VERSION=$(npm -v)
log "Node.js version: $NODE_VERSION"
log "npm version: $NPM_VERSION"

# --- 2. Install PM2 globally ---
log "Step 4: Installing PM2 globally..."
sudo npm install -g pm2 >> "$LOG_FILE" 2>&1 || log_error "Failed to install PM2"
log "PM2 installed successfully"

# --- 3. Clone or Pull Git Repository ---
REPO_URL="https://github.com/jackyliaw82/ycbot-vm-trading-bot.git"
APP_DIR="/opt/vm-bot"
BRANCH="master"

log "Step 5: Setting up application repository..."
write_guest_attribute "cloning_repository"
if [ -d "$APP_DIR" ]; then
  log "Repository already cloned at $APP_DIR. Pulling latest changes..."
  cd "$APP_DIR"
  git checkout "$BRANCH" >> "$LOG_FILE" 2>&1 || log_error "Failed to checkout $BRANCH"
  git reset --hard HEAD >> "$LOG_FILE" 2>&1 || log_error "Failed to reset working tree"
  git pull origin "$BRANCH" >> "$LOG_FILE" 2>&1 || log_error "Failed to pull repository"
else
  log "Cloning repository from $REPO_URL..."
  git clone "$REPO_URL" "$APP_DIR" >> "$LOG_FILE" 2>&1 || log_error "Failed to clone repository"
  cd "$APP_DIR"
fi

log "Repository ready at: $APP_DIR"

# --- 4. Install Application Dependencies (with caching) ---
log "Step 6: Installing application dependencies..."
write_guest_attribute "installing_dependencies"

# Check if node_modules exists and package-lock.json hasn't changed
PACKAGE_LOCK_CHECKSUM_FILE="$APP_DIR/.package-lock.checksum"
CURRENT_CHECKSUM=$(md5sum "$APP_DIR/package-lock.json" | cut -d' ' -f1)

if [ -d "$APP_DIR/node_modules" ] && [ -f "$PACKAGE_LOCK_CHECKSUM_FILE" ]; then
  SAVED_CHECKSUM=$(cat "$PACKAGE_LOCK_CHECKSUM_FILE")
  if [ "$CURRENT_CHECKSUM" == "$SAVED_CHECKSUM" ]; then
    log "npm packages are up to date (checksum match). Skipping npm install."
  else
    log "package-lock.json changed. Running npm install..."
    npm install >> "$LOG_FILE" 2>&1 || log_error "Failed to install npm dependencies"
    echo "$CURRENT_CHECKSUM" > "$PACKAGE_LOCK_CHECKSUM_FILE"
    log "npm dependencies installed successfully"
  fi
else
  log "First-time npm install or node_modules missing. Installing..."
  npm install >> "$LOG_FILE" 2>&1 || log_error "Failed to install npm dependencies"
  echo "$CURRENT_CHECKSUM" > "$PACKAGE_LOCK_CHECKSUM_FILE"
  log "npm dependencies installed successfully"
fi

# --- 5. Retrieve Firebase Service Account Key from Secret Manager ---
echo "retrieving_secrets" > "$STATUS_FILE"
write_guest_attribute "retrieving_secrets"
log "Step 7: Retrieving Firebase service account key from Secret Manager..."
SERVICE_ACCOUNT_KEY_PATH="$APP_DIR/service-account-key.json"

# Check if gcloud SDK is available
if ! command -v gcloud &> /dev/null; then
  log_error "gcloud CLI not found. Installing Google Cloud SDK..."
  curl https://sdk.cloud.google.com | bash >> "$LOG_FILE" 2>&1 || log_error "Failed to install gcloud SDK"
  exec -l $SHELL
fi

gcloud secrets versions access latest \
  --secret="firebase-service-account-key" \
  --project="ycbot-6f336" \
  > "$SERVICE_ACCOUNT_KEY_PATH" 2>> "$ERROR_LOG" || log_error "Failed to retrieve Firebase service account key"

if [ ! -f "$SERVICE_ACCOUNT_KEY_PATH" ]; then
  log_error "Service account key file was not created"
  exit 1
fi

chmod 600 "$SERVICE_ACCOUNT_KEY_PATH"
log "Firebase service account key retrieved and saved to $SERVICE_ACCOUNT_KEY_PATH"

# --- 6. Create logs directory ---
log "Step 8: Setting up PM2 logs directory..."
mkdir -p "$APP_DIR/logs"
chmod 755 "$APP_DIR/logs"
log "Logs directory ready at: $APP_DIR/logs"

# --- 7. Start the application with PM2 ---
echo "starting_application" > "$STATUS_FILE"
write_guest_attribute "starting_application"
log "Step 9: Starting application with PM2..."
export PM2_HOME="/root/.pm2"
export GOOGLE_APPLICATION_CREDENTIALS="$SERVICE_ACCOUNT_KEY_PATH"
export GOOGLE_CLOUD_PROJECT_ID="ycbot-6f336"

# Stop any existing PM2 processes for this app
sudo pm2 delete ycbot 2>> "$ERROR_LOG" || true

# Start the application
sudo PM2_HOME="/root/.pm2" \
  GOOGLE_APPLICATION_CREDENTIALS="$SERVICE_ACCOUNT_KEY_PATH" \
  GOOGLE_CLOUD_PROJECT_ID="ycbot-6f336" \
  pm2 start ecosystem.config.cjs --force >> "$LOG_FILE" 2>&1 || log_error "Failed to start application with PM2"

# Save PM2 process list
sudo pm2 save >> "$LOG_FILE" 2>&1 || log_error "Failed to save PM2 process list"

log "PM2 process started"

# --- 8. Wait for application to be responsive ---
echo "waiting_for_health" > "$STATUS_FILE"
write_guest_attribute "waiting_for_health"
log "Step 10: Waiting for application to become responsive..."
HEALTH_CHECK_URL="http://localhost:3000/startup-status"
MAX_HEALTH_ATTEMPTS=30
HEALTH_ATTEMPT=0

while [ $HEALTH_ATTEMPT -lt $MAX_HEALTH_ATTEMPTS ]; do
  HEALTH_ATTEMPT=$((HEALTH_ATTEMPT + 1))

  if curl -sf "$HEALTH_CHECK_URL" > /dev/null 2>&1; then
    log "Application is healthy and responsive at $HEALTH_CHECK_URL"
    HEALTH_RESPONSE=$(curl -s "$HEALTH_CHECK_URL")
    log "Health check response: $HEALTH_RESPONSE"
    break
  else
    log "Health check attempt $HEALTH_ATTEMPT/$MAX_HEALTH_ATTEMPTS: Application not yet responsive"

    # Check PM2 status
    PM2_STATUS=$(sudo pm2 status 2>&1)
    log "PM2 status: $PM2_STATUS"

    # Check for PM2 errors in logs
    if [ -f "$APP_DIR/logs/err.log" ]; then
      RECENT_ERRORS=$(tail -20 "$APP_DIR/logs/err.log" 2>/dev/null)
      if [ ! -z "$RECENT_ERRORS" ]; then
        log "Recent errors from application: $RECENT_ERRORS"
      fi
    fi

    if [ $HEALTH_ATTEMPT -lt $MAX_HEALTH_ATTEMPTS ]; then
      sleep 4
    fi
  fi
done

if [ $HEALTH_ATTEMPT -ge $MAX_HEALTH_ATTEMPTS ]; then
  log_error "Application failed to become responsive after $((MAX_HEALTH_ATTEMPTS * 4)) seconds"
  log "PM2 process list:"
  sudo pm2 list >> "$LOG_FILE" 2>&1
  log "Application logs:"
  sudo tail -50 "$APP_DIR/logs/err.log" >> "$LOG_FILE" 2>&1 || true
  sudo tail -50 "$APP_DIR/logs/out.log" >> "$LOG_FILE" 2>&1 || true
  write_guest_attribute "failed" "Application failed health check after $((MAX_HEALTH_ATTEMPTS * 4)) seconds"
  exit 1
fi

# --- 9. Configure PM2 to start on boot ---
log "Step 11: Configuring PM2 to start on boot..."
sudo pm2 startup systemd -u root --hp /root >> "$LOG_FILE" 2>&1 || log_error "Failed to set up PM2 startup"

echo "ready" > "$STATUS_FILE"
write_guest_attribute "ready"
log "========== VM Startup Script Completed Successfully =========="
log "Application is running and healthy"
log "PM2 configured to auto-restart on reboot"
