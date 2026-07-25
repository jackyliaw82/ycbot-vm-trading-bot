// Pure selection logic for the boot-time restart-recovery scan. No I/O.
//
// WHY THIS MODULE EXISTS (2026-07-25 incident):
// recoverActiveStrategies() resumed EVERY isRunning `anchor_ladder_` doc in the
// shared top-level `strategies` collection, with no check that the strategy
// belonged to THIS VM's user. Every user's dedicated VM shares one Firebase
// project, so that collection holds every user's docs — and a resumed doc is
// driven through the proxy carried INSIDE the doc, i.e. the doc owner's Binance
// account. Any VM restart therefore resumed other users' strategies and traded
// their money, and a Stop on one VM could not reach the twin running on another.
//
// The rule lives here, isolated from Express/Firestore, so it is unit-testable.

const INSTANCE_NAME_PREFIX = 'vm-user-';
const STRATEGY_ID_PREFIX = 'anchor_ladder_';

/**
 * Derive the owner uid from a GCP instance name.
 *
 * The backend provisions each dedicated VM as `vm-user-${uid.toLowerCase()}`
 * (backend-service gcf-orchestration.service.ts), so the instance name IS the
 * ownership record — no extra provisioning metadata is required.
 *
 * Returns null for anything that does not match, so the caller can fail closed.
 * Never guess: an unrecognised name means the owner is UNKNOWN.
 */
export function ownerUidFromInstanceName(instanceName) {
  if (typeof instanceName !== 'string') return null;
  const name = instanceName.trim();
  if (!name.startsWith(INSTANCE_NAME_PREFIX)) return null;
  const uid = name.slice(INSTANCE_NAME_PREFIX.length);
  return uid ? uid.toLowerCase() : null;
}

/**
 * Decide which strategy docs this VM is allowed to resume.
 *
 * `records` are plain {id, userId} objects — app.js maps Firestore snapshots
 * into this shape so nothing here touches the database.
 *
 * `ownerUid` MUST be a non-empty lowercased uid. The unknown-owner case is
 * deliberately NOT encoded here: it is handled by the caller, which returns
 * before calling this. Accepting a falsy uid and returning an empty list would
 * make "we don't know who we are" indistinguishable from "there was nothing to
 * resume" — the exact silent-fail-open shape this fix removes.
 *
 * Comparison is case-insensitive: the instance name lowercases the uid, while
 * the stored userId is the original mixed-case Firebase uid.
 *
 * Returns `{ resume, skippedForeign, skippedNoUserId, noUserIdIds }` — `resume`
 * is the list of resumable strategy ids, `skippedForeign`/`skippedNoUserId` are
 * aggregate counts, and `noUserIdIds` additionally lists the ids skipped for a
 * missing/empty `userId` so a caller can log which specific docs need attention
 * instead of just a count.
 */
export function selectRecoverableStrategies(records, ownerUid) {
  if (!ownerUid) {
    throw new Error(
      'selectRecoverableStrategies: ownerUid is required — the caller must handle the unknown-owner case fail-closed',
    );
  }
  const owner = String(ownerUid).toLowerCase();
  const resume = [];
  let skippedForeign = 0;
  let skippedNoUserId = 0;
  const noUserIdIds = [];

  for (const record of records || []) {
    const id = record && record.id;
    // Retired ai_reversal_ / ai_dual_ / ai_hedge_ docs have a different persisted
    // shape and cannot be resumed as a ladder. Excluded silently, as before.
    if (typeof id !== 'string' || !id.startsWith(STRATEGY_ID_PREFIX)) continue;

    const userId = record.userId;
    if (typeof userId !== 'string' || !userId) { skippedNoUserId++; noUserIdIds.push(id); continue; }
    if (userId.toLowerCase() !== owner) { skippedForeign++; continue; }

    resume.push(id);
  }

  return { resume, skippedForeign, skippedNoUserId, noUserIdIds };
}
