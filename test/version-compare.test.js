import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerVersion, parseVersion } from '../version-compare.js';

test('a genuinely newer release arms the update', () => {
  assert.equal(isNewerVersion('1.4.2', '1.4.1'), true);
  assert.equal(isNewerVersion('1.5.0', '1.4.9'), true);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

// THE INCIDENT. Code is pushed to master before the admin release doc is
// bumped, so every VM provisioned in that window runs code NEWER than the
// declared release. The old `!==` check read that as "update available" to an
// OLDER version and auto-triggered a downgrade on boot.
test('a VM AHEAD of the declared release does NOT arm an update', () => {
  assert.equal(isNewerVersion('1.3.1', '1.4.1'), false, 'must never offer a downgrade');
  assert.equal(isNewerVersion('1.4.0', '1.4.1'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
});

test('an identical version does not arm an update', () => {
  assert.equal(isNewerVersion('1.4.1', '1.4.1'), false);
  assert.equal(isNewerVersion('1.4', '1.4.0'), false, 'zero-padded equal');
});

// Numeric ordering, NOT string ordering — '1.10.0' < '1.9.0' as strings, which
// would strand the fleet on 1.9.x forever once the minor hit double digits.
test('compares numerically, not lexicographically', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(isNewerVersion('1.9.0', '1.10.0'), false);
  assert.equal(isNewerVersion('1.4.10', '1.4.9'), true);
});

test('shorter versions zero-pad', () => {
  assert.equal(isNewerVersion('1.4.1', '1.4'), true);
  assert.equal(isNewerVersion('1.4', '1.4.1'), false);
  assert.equal(isNewerVersion('2', '1.9.9'), true);
});

// FAIL-CLOSED. "We cannot tell" must never read as "safe to update" — a
// malformed release doc must leave the fleet on the code it is already running.
test('unparseable versions never arm an update', () => {
  for (const bad of [null, undefined, '', '   ', 'latest', 'v1.4.2', '1.4.2-rc1', '1.4.x', 42, {}, []]) {
    assert.equal(isNewerVersion(bad, '1.4.1'), false, `candidate ${JSON.stringify(bad)} must not arm`);
    assert.equal(isNewerVersion('1.4.2', bad), false, `current ${JSON.stringify(bad)} must not arm`);
  }
});

test('parseVersion rejects anything that is not a plain dotted number', () => {
  assert.deepEqual(parseVersion('1.4.1'), [1, 4, 1]);
  assert.deepEqual(parseVersion(' 1.4.1 '), [1, 4, 1], 'trims');
  assert.equal(parseVersion('v1.4.1'), null);
  assert.equal(parseVersion('1.4.1-rc1'), null, 'a pre-release must not compare EQUAL to the release');
  assert.equal(parseVersion('1..4'), null);
  assert.equal(parseVersion(''), null);
});
