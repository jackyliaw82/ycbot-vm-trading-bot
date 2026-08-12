import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerUidFromInstanceName, selectRecoverableStrategies } from '../breakout-recovery.js';

test('ownerUidFromInstanceName: derives the lowercased uid from a provisioned instance name', () => {
  assert.equal(ownerUidFromInstanceName('vm-user-abc123'), 'abc123');
  assert.equal(ownerUidFromInstanceName('vm-user-AbC123'), 'abc123', 'always lowercased');
  assert.equal(ownerUidFromInstanceName('  vm-user-abc123  '), 'abc123', 'metadata text is trimmed');
});

test('ownerUidFromInstanceName: anything not vm-user-* is an UNKNOWN owner, never a guess', () => {
  assert.equal(ownerUidFromInstanceName('ycbot-relay-1'), null);
  assert.equal(ownerUidFromInstanceName('vm-user-'), null, 'an empty uid is unknown, not an empty match');
  assert.equal(ownerUidFromInstanceName(''), null);
  assert.equal(ownerUidFromInstanceName(null), null);
  assert.equal(ownerUidFromInstanceName(undefined), null);
});

test('selectRecoverableStrategies: resumes only this VM owner\'s docs, case-insensitively', () => {
  const records = [
    { id: 'reversal_ladder_p1_1', userId: 'AbC123' },
    { id: 'reversal_ladder_p2_2', userId: 'zzz999' },
  ];
  const out = selectRecoverableStrategies(records, 'abc123');
  assert.deepEqual(out.resume, ['reversal_ladder_p1_1'], 'the owner\'s doc resumes despite mixed case');
  assert.equal(out.skippedForeign, 1, 'another user\'s strategy is NEVER resumed');
  assert.equal(out.skippedNoUserId, 0);
});

test('selectRecoverableStrategies: a doc with no userId is skipped, never assumed to be ours', () => {
  const records = [
    { id: 'reversal_ladder_p1_1' },
    { id: 'reversal_ladder_p2_2', userId: '' },
    { id: 'reversal_ladder_p3_3', userId: 'abc123' },
  ];
  const out = selectRecoverableStrategies(records, 'abc123');
  assert.deepEqual(out.resume, ['reversal_ladder_p3_3']);
  assert.equal(out.skippedNoUserId, 2);
  assert.deepEqual(out.noUserIdIds, ['reversal_ladder_p1_1', 'reversal_ladder_p2_2'], 'the skipped ids are named, not just counted');
});

test('selectRecoverableStrategies: docs outside the recognised prefixes are excluded and not counted as skips', () => {
  const records = [
    { id: 'ai_reversal_old_1', userId: 'abc123' },
    { id: 'anchor_ladder_old_1', userId: 'abc123' },
    { id: 'reversal_ladder_p1_1', userId: 'abc123' },
  ];
  const out = selectRecoverableStrategies(records, 'abc123');
  assert.deepEqual(out.resume, ['reversal_ladder_p1_1']);
  assert.equal(out.skippedForeign, 0);
  assert.equal(out.skippedNoUserId, 0);
});

// DANGEROUS EXCEPTION 1 (breakout rename): new strategies mint `breakout_`,
// but boot recovery must still SELECT a surviving `reversal_ladder_*` doc
// marked isRunning — never skip it. Skipping it silently would orphan
// whatever position it holds. A selected legacy doc still hits resume()'s
// own schema guard, which refuses it loudly — that is the correct, safe
// outcome; silently skipping it here is not.
test('selectRecoverableStrategies: a surviving reversal_ladder_ doc is still SELECTED, not silently skipped', () => {
  const records = [
    { id: 'reversal_ladder_legacy_1', userId: 'abc123' },
    { id: 'breakout_new_1', userId: 'abc123' },
  ];
  const out = selectRecoverableStrategies(records, 'abc123');
  assert.deepEqual(
    out.resume.sort(),
    ['breakout_new_1', 'reversal_ladder_legacy_1'],
    'both the new breakout_ prefix and the legacy reversal_ladder_ prefix must be selected for recovery',
  );
  assert.equal(out.skippedForeign, 0);
  assert.equal(out.skippedNoUserId, 0);
});

test('selectRecoverableStrategies: a falsy ownerUid THROWS — the caller must fail closed', () => {
  const records = [{ id: 'reversal_ladder_p1_1', userId: 'abc123' }];
  assert.throws(() => selectRecoverableStrategies(records, null), /ownerUid is required/);
  assert.throws(() => selectRecoverableStrategies(records, ''), /ownerUid is required/);
});

test('selectRecoverableStrategies: empty or missing input is safe', () => {
  assert.deepEqual(selectRecoverableStrategies([], 'abc123'), { resume: [], skippedForeign: 0, skippedNoUserId: 0, noUserIdIds: [] });
  assert.deepEqual(selectRecoverableStrategies(undefined, 'abc123'), { resume: [], skippedForeign: 0, skippedNoUserId: 0, noUserIdIds: [] });
});
