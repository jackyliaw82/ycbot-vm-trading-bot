/**
 * Server-side billing gate for AI Reversal strategy START.
 *
 * This is a fail-closed mirror of the read-only checks in backend-service's
 * `/billing/preflight`. The React frontend calls preflight (which ALSO lazily
 * charges the 30 USD machine subscription) before it ever calls the VM bot —
 * but that gate is only *enforced* client-side: the VM's `/ai-reversal/start`
 * handler historically trusted whatever reached it, so a caller that bypassed
 * the frontend (a direct request with their own valid token) could start a
 * strategy with a lapsed subscription and/or an empty Reload Balance.
 *
 * This gate closes that hole. It is CHECK-ONLY and does NOT charge — the 30 USD
 * renewal stays owned by `/billing/preflight` + first-profile creation (the two
 * `ensureSubscriptionActive` callers). On the normal path the subscription is
 * already active by the time we run, so this is a redundant safety net; on the
 * bypass path it refuses the start.
 *
 * Blocks when (reason strings match backend-service's preflight vocabulary):
 *   - subscriptionExpiresAt is missing or <= now  -> 'subscription_unpaid'
 *   - Reload wallet balance < 0                    -> 'negative_balance'
 *   - Reload wallet balance === 0                  -> 'zero_balance'
 *
 * A positive balance of any size (even 0.01 USD) passes, matching preflight.
 */

/** Firestore Timestamp | Date | string | null -> Date | null */
function toDate(raw) {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

/**
 * @param {import('@google-cloud/firestore').Firestore} firestore
 * @param {string} userId  Trusted user id (prefer req.uid from the verified token).
 * @param {Date}   [now]   Injectable clock (tests).
 * @returns {Promise<{ canStart: boolean, reason: string|null, balance: number, subscriptionExpiresAt: Date|null }>}
 */
export async function checkBillingGate(firestore, userId, now = new Date()) {
  if (!userId) {
    // No identity -> cannot verify entitlement -> fail closed.
    return { canStart: false, reason: 'unknown_user', balance: 0, subscriptionExpiresAt: null };
  }

  const userRef = firestore.collection('users').doc(userId);
  const [userSnap, walletSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('wallets').doc('default').get(),
  ]);

  const subscriptionExpiresAt = toDate(userSnap.exists ? userSnap.data()?.subscriptionExpiresAt : null);
  const balance = walletSnap.exists ? (walletSnap.data()?.balance || 0) : 0;

  // Subscription must be active (matches subscription.service: active iff expiry > now).
  if (!subscriptionExpiresAt || subscriptionExpiresAt <= now) {
    return { canStart: false, reason: 'subscription_unpaid', balance, subscriptionExpiresAt };
  }
  // Reload Balance must be strictly positive (mirrors preflight's < 0 / === 0 split).
  if (balance < 0) {
    return { canStart: false, reason: 'negative_balance', balance, subscriptionExpiresAt };
  }
  if (balance === 0) {
    return { canStart: false, reason: 'zero_balance', balance, subscriptionExpiresAt };
  }

  return { canStart: true, reason: null, balance, subscriptionExpiresAt };
}
