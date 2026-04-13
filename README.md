# VM Trading Bot

A continuously running trading bot designed to run on a Virtual Machine (VM) with persistent strategy execution.

## Features

- **Continuous Operation**: Runs 24/7 without cold starts
- **State Persistence**: Uses Google Cloud Firestore for state management
- **Secure API Access**: Routes all Binance API calls through Google Cloud Function proxy
- **Process Management**: PM2 integration for production deployment
- **Graceful Shutdown**: Properly handles stop signals and closes positions

## Setup Instructions

### 1. VM Requirements

- Node.js 18+ installed
- npm or yarn package manager
- Network access to Google Cloud services
- Minimum 1GB RAM, 1 CPU core

### 2. Environment Variables

Create a `.env` file in the VM application directory:

```env
# Google Cloud Function Proxy URL (your existing GCF)
GCF_PROXY_URL=https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/binance-proxy

# Server configuration
PORT=3000
NODE_ENV=production

# Google Cloud credentials (if not using VM service account)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

### 3. Installation

```bash
# Install dependencies
npm install

# Install PM2 globally (for production)
npm install -g pm2

# Create logs directory
mkdir -p logs
```

### 4. Development

```bash
# Run in development mode with auto-restart
npm run dev

# Or run directly
npm start
```

### 5. Production Deployment

```bash
# Start with PM2
npm run pm2:start

# Check status
pm2 status

# View logs
npm run pm2:logs

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop
```

## API Endpoints

### Strategy Management
- `POST /strategy/start` - Start a new trading strategy
- `POST /strategy/stop` - Stop the current strategy
- `GET /strategy/status` - Get current strategy status
- `GET /strategy/logs?limit=50` - Get strategy logs
- `POST /strategy/resume/:strategyId` - Resume a strategy by ID

### System
- `GET /health` - Health check endpoint

## Configuration

### Strategy Configuration
```json
{
  "timeframe": "1m",
  "openingTime": "08:00",
  "reversalThreshold": 0.2,
  "lossSize": 2
}
```

### PM2 Configuration
The `ecosystem.config.js` file contains PM2 configuration:
- Auto-restart on crashes
- Memory limit: 768MB
- Log rotation
- Environment variables

## Architecture

```
Frontend (Browser) 
    ↓ (Strategy Management)
VM Trading Bot (Node.js + Express)
    ↓ (Binance API Calls)
Google Cloud Function (Secure Proxy)
    ↓ (Authenticated Requests)
Binance API (Testnet/Mainnet)
```

## Security Features

- **No API Keys on VM**: All Binance API credentials remain in GCF
- **Encrypted State**: Firestore handles encryption at rest
- **Secure Communication**: HTTPS between all components
- **Process Isolation**: Runs in isolated VM environment

## Monitoring

### Health Checks
```bash
curl http://localhost:3000/health
```

### PM2 Monitoring
```bash
pm2 monit
pm2 logs trading-bot
pm2 show trading-bot
```

### Strategy Status
```bash
curl http://localhost:3000/strategy/status
```

## Troubleshooting

### Common Issues

1. **GCF Connection Failed**
   - Verify `GCF_PROXY_URL` is correct
   - Check network connectivity
   - Ensure GCF is deployed and accessible

2. **Firestore Permission Denied**
   - Verify service account has Firestore access
   - Check `GOOGLE_APPLICATION_CREDENTIALS` path
   - Ensure VM has proper IAM roles

3. **WebSocket Connection Issues**
   - Check internet connectivity
   - Verify Binance WebSocket endpoints are accessible
   - Review firewall settings

4. **Strategy Not Starting**
   - Check logs: `npm run pm2:logs`
   - Verify configuration parameters
   - Ensure no other strategy is running

### Logs Location
- PM2 logs: `./logs/`
- Application logs: Console output via PM2
- Strategy logs: Stored in Firestore

## Deployment Checklist

- [ ] VM provisioned with Node.js 18+
- [ ] Environment variables configured
- [ ] Google Cloud credentials set up
- [ ] Firestore database accessible
- [ ] GCF proxy URL updated
- [ ] PM2 installed and configured
- [ ] Health check endpoint responding
- [ ] Strategy can start/stop successfully
- [ ] Logs are being written correctly

---

**⚠️ Important**: This is a production trading system. Always test thoroughly in a testnet environment before using with real funds.