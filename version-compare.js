// Semver ordering for the self-update gate. Pure: no I/O, no state.
//
// WHY THIS EXISTS (2026-08-02 incident):
// `setupReleaseListener` used to arm an update on `latestVersion !== BOT_VERSION`
// — INEQUALITY, not ordering. A VM running code NEWER than the declared release
// therefore read as "update available" pointing at an OLDER version, and since a
// freshly provisioned VM has no active strategies, it auto-triggered a DOWNGRADE
// on boot. The downgrade could never land (self-update.sh always pulls
// origin/master, which is the newer code), so it failed, and the 60s idle poller
// retried the same doomed update forever.
//
// A VM ahead of the declared release is NORMAL: code is pushed to master before
// the admin release doc is bumped, and every VM provisioned in that window
// clones the newer code. That window must be inert, not a failure loop.

/**
 * Parse a dotted numeric version into comparable parts.
 *
 * Returns null for anything that is not a plain numeric version. Pre-release
 * and build suffixes are deliberately NOT supported: this project has never
 * used them, and silently accepting half of one ("1.4.1-rc" -> 1.4.1) would
 * make a release candidate compare EQUAL to the real release and suppress a
 * genuine update. Unparseable must stay unparseable so the caller can refuse.
 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  const parts = s.split('.').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/**
 * Is `candidate` strictly newer than `current`?
 *
 * FAIL-CLOSED: any version this cannot parse returns FALSE — "we cannot tell"
 * must never read as "safe to update", which in this codebase is the dominant
 * failure mode. A garbage release doc leaves every VM on the code it is
 * already running rather than sending the fleet somewhere unknown.
 *
 * Shorter versions compare as if zero-padded, so 1.4 < 1.4.1 and 1.4 === 1.4.0.
 */
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false; // equal
}
