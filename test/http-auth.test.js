import { test } from 'node:test';
import assert from 'node:assert/strict';

// ADMIN_UIDS + AUTH_REQUIRED are read at module load — set env BEFORE importing.
process.env.HTTP_ADMIN_UIDS = 'admin-uid-1';
process.env.HTTP_AUTH_REQUIRED = 'true';
const { createRequireVmOwner, isAllowedVmUser } = await import('../http-auth.js');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function run(middleware, req) {
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('requireVmOwner: the VM owner is allowed through', () => {
  const mw = createRequireVmOwner(() => 'abc123');
  const { res, nextCalled } = run(mw, { uid: 'abc123', method: 'POST', path: '/breakout/start' });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null, 'no response written — the request continues');
});

test('requireVmOwner: owner match is case-insensitive (mixed-case Firebase uid vs lowercased instance name)', () => {
  const mw = createRequireVmOwner(() => 'abc123');
  const { res, nextCalled } = run(mw, { uid: 'AbC123', method: 'POST', path: '/breakout/start' });
  assert.equal(nextCalled, true, 'a real Firebase uid is mixed-case; lowercasing must not 403 the owner');
  assert.equal(res.statusCode, null, 'no response written — the request continues');
});

test('requireVmOwner: a different user is refused with NOT_VM_OWNER', () => {
  const mw = createRequireVmOwner(() => 'abc123');
  const { res, nextCalled } = run(mw, { uid: 'someone-else', method: 'POST', path: '/breakout/start' });
  assert.equal(nextCalled, false, 'the handler must never run for a foreign caller');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'NOT_VM_OWNER');
});

test('requireVmOwner: an unresolved owner refuses EVERYONE (fail closed)', () => {
  const mw = createRequireVmOwner(() => null);
  const { res, nextCalled } = run(mw, { uid: 'abc123', method: 'POST', path: '/breakout/start' });
  assert.equal(nextCalled, false, 'unknown ownership must never read as permitted');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'VM_OWNER_UNKNOWN');
});

test('requireVmOwner: an admin uid passes through to any VM (fleet release rollout)', () => {
  const mw = createRequireVmOwner(() => 'abc123');
  const { nextCalled } = run(mw, { uid: 'admin-uid-1', method: 'POST', path: '/breakout/status' });
  assert.equal(nextCalled, true, 'admins legitimately drive other users\' VMs');
});

test('requireVmOwner: an admin still passes when the owner is unresolved (metadata outage must not lock admins out)', () => {
  const mw = createRequireVmOwner(() => null);
  const { res, nextCalled } = run(mw, { uid: 'admin-uid-1', method: 'POST', path: '/breakout/status' });
  assert.equal(nextCalled, true, 'an admin passes even when the owner is unresolved (a metadata outage must not lock admins out)');
  assert.equal(res.statusCode, null, 'no response written — the request continues');
});

test('requireVmOwner: a missing verified uid is 401, not a silent pass', () => {
  const mw = createRequireVmOwner(() => 'abc123');
  const { res, nextCalled } = run(mw, { method: 'POST', path: '/breakout/start' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_MISSING');
});

test('requireVmOwner: getOwnerUid is called per request, not captured once', () => {
  let owner = null;
  const mw = createRequireVmOwner(() => owner);
  const first = run(mw, { uid: 'abc123', method: 'GET', path: '/breakout/status' });
  assert.equal(first.res.body.code, 'VM_OWNER_UNKNOWN', 'unresolved at first call');
  owner = 'abc123'; // resolved later, as the top-level await does at boot
  const second = run(mw, { uid: 'abc123', method: 'GET', path: '/breakout/status' });
  assert.equal(second.nextCalled, true, 'late binding — the getter must be re-read each request');
});

test('isAllowedVmUser: the VM owner is allowed, case-insensitively', () => {
  assert.equal(isAllowedVmUser('abc123', 'abc123'), true);
  assert.equal(isAllowedVmUser('AbC123', 'abc123'), true, 'a mixed-case Firebase uid must match the lowercased owner uid');
});

test('isAllowedVmUser: a different user is refused', () => {
  assert.equal(isAllowedVmUser('someone-else', 'abc123'), false);
});

test('isAllowedVmUser: an unresolved owner refuses everyone except admins (fail closed)', () => {
  assert.equal(isAllowedVmUser('abc123', null), false);
  assert.equal(isAllowedVmUser('abc123', ''), false);
  assert.equal(isAllowedVmUser('admin-uid-1', null), true, 'admins must not be locked out by a metadata outage');
});

test('isAllowedVmUser: an admin is allowed on any VM', () => {
  assert.equal(isAllowedVmUser('admin-uid-1', 'someone-elses-vm'), true);
});

test('isAllowedVmUser: a missing uid is refused', () => {
  assert.equal(isAllowedVmUser(null, 'abc123'), false);
  assert.equal(isAllowedVmUser(undefined, 'abc123'), false);
  assert.equal(isAllowedVmUser('', 'abc123'), false);
});
