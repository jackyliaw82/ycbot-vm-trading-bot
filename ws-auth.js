import admin from 'firebase-admin';

/**
 * Verify a Firebase ID token from a WebSocket client connection.
 * Reuses the firebase-admin instance already initialized by trading-base.js.
 * @param {string} token — Firebase ID token from query parameter
 * @returns {{ uid: string }} — decoded user ID
 */
export async function verifyFirebaseToken(token) {
  const decoded = await admin.auth().verifyIdToken(token);
  return { uid: decoded.uid };
}
