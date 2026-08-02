/**
 * HTTP authentication middleware.
 *
 * Verifies a Firebase ID token from the `Authorization: Bearer <token>` header
 * on protected endpoints. Mirrors the WS auth pattern in [ws-auth.js].
 *
 * Behavior is gated by env var HTTP_AUTH_REQUIRED:
 *   - 'true' (default): reject unauthenticated requests with 401.
 *   - 'false': log a warning, allow the request through. Intended for emergency
 *     rollback only — leaves all sensitive endpoints exposed.
 *
 * On successful verification, the decoded user id is attached as `req.uid`.
 * Handlers should use `req.uid` as the source of truth for the user identity
 * (NOT `req.body.userId` — the body field is client-supplied and untrusted).
 *
 * If both `req.uid` (from token) and `req.body.userId` are present and differ,
 * the middleware rejects with 403 — that's an attempt to operate as a different
 * user, suspicious enough to deny.
 */

import admin from 'firebase-admin';

const AUTH_REQUIRED = (process.env.HTTP_AUTH_REQUIRED || 'true').toLowerCase() !== 'false';

// Default verifier delegates to firebase-admin. Tests can override via
// setVerifier() to avoid needing a live Firebase project.
let _verifyIdToken = (token) => admin.auth().verifyIdToken(token);

/**
 * Test-only override hook. Pass null to restore the default firebase-admin
 * verifier. Production code should NEVER call this.
 */
export function setVerifier(fn) {
  _verifyIdToken = (typeof fn === 'function') ? fn : (token) => admin.auth().verifyIdToken(token);
}

// Endpoints the middleware never blocks (health/version checks intended to be
// reachable by uptime monitors and the frontend pre-login).
const PUBLIC_PATHS = new Set([
  '/health',
  '/startup-status',
  '/update-status',
]);

function extractBearerToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Express middleware. Use as `app.use(httpAuthMiddleware)` early in the chain
 * (before route handlers) so it covers everything except the PUBLIC_PATHS.
 *
 * Logs a one-line warning every time auth is enforced or bypassed so ops have
 * visibility into auth state.
 */
export async function httpAuthMiddleware(req, res, next) {
  // OPTIONS preflight bypass — browsers send these without the Authorization
  // header. CORS middleware handles them upstream; we just let them through.
  if (req.method === 'OPTIONS') return next();

  // Public paths skip auth.
  if (PUBLIC_PATHS.has(req.path)) return next();

  const token = extractBearerToken(req);

  if (!token) {
    if (!AUTH_REQUIRED) {
      console.warn(`[http-auth] BYPASS ${req.method} ${req.path} — no token, AUTH_REQUIRED=false`);
      return next();
    }
    return res.status(401).json({
      error: 'Unauthorized — missing Authorization: Bearer <Firebase ID token> header',
      code: 'AUTH_MISSING',
    });
  }

  try {
    const decoded = await _verifyIdToken(token);
    req.uid = decoded.uid;

    // If the body claims a userId, it must match the verified uid. Prevents a
    // user with a valid token from operating as a different user via body
    // spoofing (which the existing endpoints do trust).
    const claimedUserId = req.body && req.body.userId;
    if (claimedUserId && claimedUserId !== decoded.uid) {
      return res.status(403).json({
        error: 'Forbidden — body.userId does not match verified token uid',
        code: 'AUTH_UID_MISMATCH',
      });
    }
    return next();
  } catch (err) {
    if (!AUTH_REQUIRED) {
      console.warn(`[http-auth] BYPASS ${req.method} ${req.path} — token verify failed (${err.code || err.message}), AUTH_REQUIRED=false`);
      return next();
    }
    return res.status(401).json({
      error: `Unauthorized — token verification failed: ${err.code || err.message}`,
      code: 'AUTH_INVALID',
    });
  }
}

/**
 * Per-route middleware that further restricts to admin uids only. Used for
 * /test/* and /system/* endpoints which can disrupt or reconfigure the bot.
 *
 * Admin uids are read from env var HTTP_ADMIN_UIDS as a comma-separated list.
 * If the list is empty AND AUTH_REQUIRED=false, admin endpoints fall back to
 * the same bypass behavior as regular endpoints. When AUTH_REQUIRED=true and
 * the admin list is empty, all admin endpoints reject with 403 — fail-safe.
 */
const ADMIN_UIDS = new Set(
  (process.env.HTTP_ADMIN_UIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

export function requireAdmin(req, res, next) {
  if (!AUTH_REQUIRED) {
    console.warn(`[http-auth] ADMIN BYPASS ${req.method} ${req.path} — AUTH_REQUIRED=false`);
    return next();
  }
  if (!req.uid) {
    return res.status(401).json({ error: 'Unauthorized — no verified uid', code: 'AUTH_MISSING' });
  }
  if (ADMIN_UIDS.size === 0) {
    return res.status(403).json({
      error: 'Forbidden — admin endpoint, but HTTP_ADMIN_UIDS env is empty (no admins configured)',
      code: 'ADMIN_NOT_CONFIGURED',
    });
  }
  if (!ADMIN_UIDS.has(req.uid)) {
    return res.status(403).json({
      error: 'Forbidden — uid is not in the admin list',
      code: 'NOT_ADMIN',
    });
  }
  return next();
}

/**
 * The single definition of "may this uid operate this VM?".
 *
 * Shared by createRequireVmOwner (HTTP) and the /ws upgrade handler so the
 * ownership rule has ONE definition. Two copies of one rule drift, and a drift
 * here fails open — which is the bug class this codebase keeps producing.
 *
 * Case-insensitive against ownerUid: VM_OWNER_UID is lowercased (derived from
 * the GCP instance name `vm-user-<uid.toLowerCase()>`) while a Firebase uid is
 * mixed case. Admins are allowed on any VM — the fleet release rollout drives
 * other users' VMs. Fail closed on an unresolved owner.
 */
export function isAllowedVmUser(uid, ownerUid) {
  if (!uid) return false;
  if (ADMIN_UIDS.has(uid)) return true;
  if (!ownerUid) return false;
  return String(uid).toLowerCase() === String(ownerUid).toLowerCase();
}

/**
 * Per-route middleware restricting an endpoint to THIS VM's owner.
 *
 * Each user gets a dedicated VM, but every VM is publicly addressable via its
 * per-user A record (https://vm-user-<uid>.vm.ycbot.trade). httpAuthMiddleware
 * proves WHO the caller is; it never checks WHOSE VM is being called. Without
 * this guard any authenticated user can POST /reversal-ladder/start to another
 * user's VM with their own credentials in the body. That trades the caller's
 * OWN account (no fund breach), but it strands a live instance on a foreign VM
 * while the strategy doc carries the caller's uid — so the caller's own VM
 * resumes the same doc on its next restart and two instances trade one account.
 * That is the 2026-07-25 duplicate-instance incident, reachable deliberately,
 * and the caller's Stop button cannot reach the twin.
 *
 * Admin uids pass through: the fleet release rollout legitimately drives other
 * users' VMs (backend-service release.service.ts -> /system/update,
 * /system/force-update).
 *
 * FAIL CLOSED: when the VM cannot determine its own owner it serves NOBODY —
 * the same rule the recovery scan follows. Unknown must never read as safe.
 * Set the VM_OWNER_UID env var as the escape hatch if metadata is unavailable.
 *
 * @param getOwnerUid function returning the lowercased owner uid (or null).
 *   MUST be a function: app.js assigns VM_OWNER_UID via a top-level await, so a
 *   by-value capture would be null forever.
 */
export function createRequireVmOwner(getOwnerUid) {
  return function requireVmOwner(req, res, next) {
    if (!AUTH_REQUIRED) {
      console.warn(`[http-auth] VM-OWNER BYPASS ${req.method} ${req.path} — AUTH_REQUIRED=false`);
      return next();
    }
    if (!req.uid) {
      return res.status(401).json({ error: 'Unauthorized — no verified uid', code: 'AUTH_MISSING' });
    }
    const ownerUid = getOwnerUid();
    if (isAllowedVmUser(req.uid, ownerUid)) return next();

    // Not allowed — the remaining branches only choose which reason to report.
    if (!ownerUid) {
      return res.status(403).json({
        error: 'Forbidden — this VM cannot determine its owner, so it is refusing all user requests. See the [VM-OWNER] log line for the reason.',
        code: 'VM_OWNER_UNKNOWN',
      });
    }
    console.warn(`[http-auth] NOT_VM_OWNER ${req.method} ${req.path} — caller=${req.uid} owner=${ownerUid}`);
    return res.status(403).json({
      error: 'Forbidden — this VM does not belong to you.',
      code: 'NOT_VM_OWNER',
    });
  };
}

/**
 * Test-only export: lets unit tests inspect or override the public-path set
 * without poking at module internals.
 */
export const __test = {
  PUBLIC_PATHS,
  ADMIN_UIDS,
  AUTH_REQUIRED,
  extractBearerToken,
};
