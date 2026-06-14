import admin from 'firebase-admin';
import fs from 'fs';

let adminInitialized = false;

export function initializeFirebaseAdmin() {
  if (adminInitialized) {
    console.log('Firebase Admin SDK already initialized');
    return;
  }

  try {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || 'ycbot-6f336';

    console.log(`Attempting to initialize Firebase Admin SDK...`);
    console.log(`Service account path: ${serviceAccountPath}`);
    console.log(`Project ID: ${projectId}`);

    if (!serviceAccountPath) {
      console.error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.');
      console.error('Push notifications will not be available until Firebase Admin SDK is configured.');
      return;
    }

    // Check if the file exists
    if (!fs.existsSync(serviceAccountPath)) {
      console.error(`Service account file not found at path: ${serviceAccountPath}`);
      console.error('Push notifications will not be available until the service account file is properly configured.');
      return;
    }

    console.log('Service account file found, reading credentials...');

    // Read and parse the service account JSON file
    const serviceAccountContent = fs.readFileSync(serviceAccountPath, 'utf8');
    const serviceAccount = JSON.parse(serviceAccountContent);

    // Validate the credential has required fields
    if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
      console.error('Service account JSON is missing required fields (project_id, private_key, or client_email)');
      console.error('Push notifications will not be available until the service account file is properly configured.');
      return;
    }

    console.log(`Loaded service account for project: ${serviceAccount.project_id}`);
    console.log(`Service account email: ${serviceAccount.client_email}`);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: projectId,
    });

    adminInitialized = true;
    console.log('✓ Firebase Admin SDK initialized successfully for push notifications');
    console.log(`✓ Connected to project: ${projectId}`);

    // Test Firestore connection
    const firestore = admin.firestore();
    console.log('✓ Firestore connection established');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error.message);
    console.error('Error details:', error);
    console.error('Push notifications will not be available.');

    if (error.code === 'EACCES') {
      console.error('Permission denied - check file permissions for service account key');
    } else if (error instanceof SyntaxError) {
      console.error('Invalid JSON in service account file - check file format');
    }
  }
}

async function sendWithRetry(message, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      return response;
    } catch (error) {
      lastError = error;
      
      // Don't retry on certain errors
      const errorCode = error?.code || error?.errorInfo?.code;
      if (errorCode === 'messaging/invalid-registration-token' ||
          errorCode === 'messaging/registration-token-not-registered' ||
          errorCode === 'messaging/invalid-argument') {
        throw error; // Don't retry these
      }
      
      // For internal errors and transient failures, retry with exponential backoff
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`Push notification attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

// M8: per-user token-bucket rate limiter. Caps FCM pushes at 10/min per
// user with a max burst of 10. A misbehaving strategy (rapid state flips
// during cascade) used to be able to fire hundreds of pushes in minutes.
// Now extras are dropped — important alerts will queue back into the
// bucket as it refills. Process-local state; resets on restart, which is
// fine since the upstream events that drive pushes also reset.
const FCM_RATE_LIMIT_PER_MIN = 10;
const FCM_BUCKET_CAP = 10;
const _fcmRateBuckets = new Map(); // userId -> { tokens, lastRefill }

function _consumeFcmRateLimitToken(userId) {
  const now = Date.now();
  const bucket = _fcmRateBuckets.get(userId) || { tokens: FCM_BUCKET_CAP, lastRefill: now };
  const elapsedMs = now - bucket.lastRefill;
  const refill = (elapsedMs / 60_000) * FCM_RATE_LIMIT_PER_MIN;
  bucket.tokens = Math.min(FCM_BUCKET_CAP, bucket.tokens + refill);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    _fcmRateBuckets.set(userId, bucket);
    return false;
  }
  bucket.tokens -= 1;
  _fcmRateBuckets.set(userId, bucket);
  return true;
}

export async function sendPushNotification(userId, notificationData) {
  if (!adminInitialized) {
    console.warn('Firebase Admin SDK not initialized. Skipping push notification.');
    return { success: false, error: 'Firebase Admin SDK not initialized' };
  }

  // Critical, terminal alerts bypass the rate limiter entirely. These fire at
  // most once per cycle (strategy stopped by the circuit breaker, or cycle
  // completed at Final TP) and the user MUST see them — a burst of frequent
  // reversal pings must never be able to drain the bucket and starve one out.
  // Only high-frequency types (reversal, etc.) stay rate-limited.
  const notifType = notificationData?.data?.type;
  const isCriticalAlert = notifType === 'capital_protection' || notifType === 'final_tp';

  // M8: rate-limit non-critical pushes before doing any Firestore lookups. Drop
  // quietly with a single log line — frequent drops would themselves clutter
  // logs, but the user IS notified that limiting kicked in.
  if (!isCriticalAlert && !_consumeFcmRateLimitToken(userId)) {
    console.warn(`[FCM-RATE-LIMIT] Dropping push for user ${userId}: bucket empty (>${FCM_RATE_LIMIT_PER_MIN}/min)`);
    return { success: false, error: 'rate_limited' };
  }

  try {
    const firestore = admin.firestore();
    const userDoc = await firestore.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      console.error(`User ${userId} not found in Firestore`);
      return { success: false, error: 'User not found' };
    }

    const userData = userDoc.data();
    const fcmTokens = userData.fcmTokens || [];

    if (fcmTokens.length === 0) {
      console.log(`No FCM tokens registered for user ${userId}`);
      return { success: false, error: 'No FCM tokens registered' };
    }

    const tokens = fcmTokens.map(tokenData => tokenData.token);

    // Validate notification data
    const title = String(notificationData.title || 'Notification').substring(0, 1024);
    const body = String(notificationData.body || '').substring(0, 4096);

    // Convert data values to strings and limit size
    const data = {};
    if (notificationData.data) {
      for (const [key, value] of Object.entries(notificationData.data)) {
        if (value !== null && value !== undefined) {
          data[key] = String(value).substring(0, 1024);
        }
      }
    }

    const isCapitalProtection = data.type === 'capital_protection';
    // tag/thread-id groups notifications per strategy so a newer push for
    // the same cycle replaces the older one on the device instead of
    // stacking — same semantic on Web Push, APNs (thread-id), and
    // Android FCM (tag).
    const tagId = data.strategyId || 'strategy-notification';
    const linkPath = data.strategyId ? `/?strategyId=${data.strategyId}` : '/';

    const message = {
      // Top-level notification — FCM auto-displays this on the device when
      // the app is in the background. Replaces the prior data-only path
      // that (a) was invisible on iOS because aps.content-available:1
      // with no alert is a silent background push, and (b) on Android
      // depended on the SW being woken in time (Doze/battery-saver could
      // suppress it). When `notification` is present, the SW's
      // onBackgroundMessage does NOT fire — FCM handles display directly,
      // so no double-display. Foreground onMessage still fires with the
      // full payload, so in-app banners keep working unchanged.
      notification: {
        title: title,
        body: body,
      },
      // data — consumed by the SW's notificationclick handler for
      // strategyId-based navigation, and by the foreground onMessage
      // listener to render the in-app banner. title/body kept inside
      // data so the foreground listener (which reads payload.data)
      // doesn't change shape.
      data: {
        ...data,
        title: title,
        body: body,
      },
      tokens: tokens,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          tag: tagId,
          // sticky = ongoing notification (Android equivalent of
          // requireInteraction). Capital-protection alerts shouldn't be
          // auto-dismissed before the user acts on them.
          sticky: isCapitalProtection,
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          // Required on iOS 13+ for visible alert pushes.
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert: {
              title: title,
              body: body,
            },
            sound: 'default',
            badge: 1,
            'thread-id': tagId,
            // time-sensitive interruption level pierces Focus modes on
            // iOS 15+. Reserved for capital-protection where the user
            // needs the alert immediately even if Do-Not-Disturb is on.
            ...(isCapitalProtection ? { 'interruption-level': 'time-sensitive' } : {}),
          },
        },
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          icon: '/icon-light-192.png',
          badge: '/icon-light-192.png',
          tag: tagId,
          vibrate: [200, 100, 200],
          requireInteraction: isCapitalProtection,
          actions: [
            { action: 'view', title: 'View Details' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
        },
        fcmOptions: { link: linkPath },
      },
    };

    const response = await sendWithRetry(message);

    console.log(`Push notification sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

    if (response.failureCount > 0) {
      const tokensToUpdate = [];
      const tokensToRemove = [];

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code || resp.error?.errorInfo?.code;
          const errorMessage = resp.error?.message || 'Unknown error';
          const tokenData = fcmTokens[idx];

          console.error(`Failed to send to token ${tokens[idx].substring(0, 20)}...: ${errorCode} - ${errorMessage}`);

          // Handle definitely invalid tokens
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            tokensToRemove.push(tokenData);
          }
          // Track internal errors and remove after 3 consecutive failures
          else if (errorCode === 'messaging/internal-error') {
            const currentFailures = (tokenData.consecutiveFailures || 0) + 1;
            console.warn(`Internal FCM error for token ${tokens[idx].substring(0, 20)}... - failure count: ${currentFailures}/3`);

            if (currentFailures >= 3) {
              console.error(`Token ${tokens[idx].substring(0, 20)}... has failed 3 consecutive times with internal-error. Removing token.`);
              tokensToRemove.push(tokenData);
            } else {
              tokensToUpdate.push({
                ...tokenData,
                consecutiveFailures: currentFailures,
                lastErrorCode: errorCode,
                lastErrorMessage: errorMessage,
                lastFailureTimestamp: Date.now(),
                status: currentFailures >= 2 ? 'warning' : 'active',
              });
            }
          }
        } else {
          // Reset failure count on success
          const tokenData = fcmTokens[idx];
          if (tokenData.consecutiveFailures && tokenData.consecutiveFailures > 0) {
            tokensToUpdate.push({
              ...tokenData,
              consecutiveFailures: 0,
              lastErrorCode: null,
              lastErrorMessage: null,
              lastSuccessTimestamp: Date.now(),
              status: 'active',
            });
          }
        }
      });

      // Update tokens with new failure counts
      if (tokensToUpdate.length > 0) {
        await updateTokenHealthStatus(userId, tokensToUpdate, fcmTokens);
      }

      // Remove invalid tokens
      if (tokensToRemove.length > 0) {
        await cleanupInvalidTokens(userId, tokensToRemove);

        // Log notification for user about failed tokens
        await logNotificationEvent(userId, {
          type: 'token_removed',
          message: `${tokensToRemove.length} device(s) removed due to repeated delivery failures. Please re-enable push notifications if needed.`,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } else {
      // All notifications succeeded - reset any failure counts
      const tokensToUpdate = fcmTokens
        .filter(tokenData => tokenData.consecutiveFailures && tokenData.consecutiveFailures > 0)
        .map(tokenData => ({
          ...tokenData,
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastSuccessTimestamp: Date.now(),
          status: 'active',
        }));

      if (tokensToUpdate.length > 0) {
        await updateTokenHealthStatus(userId, tokensToUpdate, fcmTokens);
      }
    }

    return {
      success: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (error) {
    console.error('Error sending push notification:', error);
    const errorCode = error?.code || error?.errorInfo?.code;
    console.error(`Error code: ${errorCode}`);
    return { success: false, error: error.message };
  }
}

async function updateTokenHealthStatus(userId, tokensToUpdate, allTokens) {
  try {
    const firestore = admin.firestore();
    const userRef = firestore.collection('users').doc(userId);

    // Create updated tokens array by merging updates
    const updatedTokens = allTokens.map(token => {
      const update = tokensToUpdate.find(t => t.token === token.token);
      return update || token;
    });

    await userRef.update({
      fcmTokens: updatedTokens,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Updated health status for ${tokensToUpdate.length} FCM token(s) for user ${userId}`);
  } catch (error) {
    console.error('Error updating token health status:', error);
  }
}

async function cleanupInvalidTokens(userId, invalidTokens) {
  try {
    const firestore = admin.firestore();
    const userRef = firestore.collection('users').doc(userId);

    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return;
    }

    const currentTokens = userDoc.data().fcmTokens || [];
    const validTokens = currentTokens.filter(
      tokenData => !invalidTokens.some(invalid => invalid.token === tokenData.token)
    );

    await userRef.update({
      fcmTokens: validTokens,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Cleaned up ${invalidTokens.length} invalid FCM tokens for user ${userId}`);
  } catch (error) {
    console.error('Error cleaning up invalid tokens:', error);
  }
}

async function logNotificationEvent(userId, eventData) {
  try {
    const firestore = admin.firestore();
    const notificationRef = firestore
      .collection('users')
      .doc(userId)
      .collection('notificationLogs')
      .doc();

    await notificationRef.set({
      ...eventData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Logged notification event for user ${userId}: ${eventData.type}`);
  } catch (error) {
    console.error('Error logging notification event:', error);
  }
}

export async function sendStrategyCompletionNotification(userId, strategyData) {
  // Validate and provide defaults for strategyData
  const netPnL = typeof strategyData?.netPnL === 'number' ? strategyData.netPnL : 0;
  const profitPercentage = typeof strategyData?.profitPercentage === 'number' ? strategyData.profitPercentage : 0;
  const symbol = strategyData?.symbol || 'Unknown';
  const timeTaken = strategyData?.timeTaken || 'N/A';
  const tradeCount = strategyData?.tradeCount || 0;

  const isProfitable = netPnL > 0;
  const profitSign = isProfitable ? '+' : '';
  const profitPercentSign = profitPercentage > 0 ? '+' : '';

  const notificationData = {
    title: `${isProfitable ? '🎉' : '📊'} Final TP Reached - ${symbol}`,
    body: `Net PnL: ${profitSign}$${netPnL.toFixed(2)} (${profitPercentSign}${profitPercentage.toFixed(2)}%)\nTime: ${timeTaken} | Trades: ${tradeCount}`,
    data: {
      type: 'final_tp',
      strategyId: strategyData?.strategyId || '',
      symbol: symbol,
      netPnL: netPnL.toString(),
      profitPercentage: profitPercentage.toString(),
    },
  };

  return await sendPushNotification(userId, notificationData);
}

export async function sendCapitalProtectionNotification(userId, protectionData) {
  // Validate and provide defaults for protectionData
  const lossAmount = typeof protectionData?.lossAmount === 'number' ? protectionData.lossAmount : 0;
  const lossPercentage = typeof protectionData?.lossPercentage === 'number' ? protectionData.lossPercentage : 0;
  const symbol = protectionData?.symbol || 'Unknown';

  const notificationData = {
    title: `⚠️ Capital Protection - ${symbol}`,
    body: `Circuit breaker triggered!\nLoss: $${Math.abs(lossAmount).toFixed(2)} (${lossPercentage.toFixed(2)}%)\nStrategy stopped automatically.`,
    data: {
      type: 'capital_protection',
      strategyId: protectionData?.strategyId || '',
      symbol: symbol,
      lossAmount: lossAmount.toString(),
      lossPercentage: lossPercentage.toString(),
    },
  };

  return await sendPushNotification(userId, notificationData);
}

export async function sendReversalNotification(userId, reversalData) {
  // Validate and provide defaults for reversalData
  const currentPrice = typeof reversalData?.currentPrice === 'number' ? reversalData.currentPrice : 0;
  const reversalCount = typeof reversalData?.reversalCount === 'number' ? reversalData.reversalCount : 0;
  const symbol = reversalData?.symbol || 'Unknown';
  const oldPosition = reversalData?.oldPosition || 'NONE';
  const newPosition = reversalData?.newPosition || 'NONE';

  const notificationData = {
    title: `🔄 Reversal #${reversalCount} - ${symbol}`,
    body: `Position reversed: ${oldPosition} → ${newPosition}\nPrice: $${currentPrice.toFixed(2)}\nTotal reversals: ${reversalCount}`,
    data: {
      type: 'reversal',
      strategyId: reversalData?.strategyId || '',
      symbol: symbol,
      oldPosition: oldPosition,
      newPosition: newPosition,
      reversalCount: reversalCount.toString(),
      currentPrice: currentPrice.toString(),
    },
  };

  return await sendPushNotification(userId, notificationData);
}
