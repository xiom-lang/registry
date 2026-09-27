// XIOM Package Registry -- account store tests (notification prefs, A2).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccountStore, normalizeNotifyKinds } = require('../src/accounts');

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-accounts-')), 'accounts.json');
}

test('accounts default every structured notification kind to on', () => {
  const store = new AccountStore({ path: tempPath() });
  const account = store.upsert({ id: '42', login: 'alice' });
  assert.deepEqual(account.notifyKinds, { claim: true, report: true, review: true });
  assert.deepEqual(store.get('42').notifyKinds, { claim: true, report: true, review: true });
});

test('setNotifyKinds stores only the allowlist and survives a reload', () => {
  const file = tempPath();
  const store = new AccountStore({ path: file });
  store.upsert({ id: '42', login: 'alice' });
  const saved = store.setNotifyKinds('42', { claim: true, report: false, admin: false });
  assert.deepEqual(saved, { claim: true, report: false, review: true });

  const reloaded = new AccountStore({ path: file });
  assert.deepEqual(reloaded.get('42').notifyKinds, { claim: true, report: false, review: true });
  assert.throws(() => reloaded.setNotifyKinds('99', {}), /account not found/);
});

test('accounts written before A2 load with every kind on', () => {
  const file = tempPath();
  fs.writeFileSync(file, JSON.stringify({
    version: '1.0.0',
    updated_at: new Date().toISOString(),
    accounts: {
      7: { githubId: '7', login: 'legacy', notifyEmail: 'legacy@example.com', createdAt: '', lastLoginAt: '' },
    },
  }));
  const store = new AccountStore({ path: file });
  assert.deepEqual(store.get('7').notifyKinds, { claim: true, report: true, review: true });
  // D7: an address written before the gate is unverified and never mails.
  assert.equal(store.isEmailVerified('7'), false);
  assert.equal(store.get('7').notifyEmailVerifiedAt, '');
});

test('notification email verification is single-use, bounded, and reload-safe', () => {
  const file = tempPath();
  const store = new AccountStore({ path: file });
  store.upsert({ id: '42', login: 'alice' });
  assert.equal(store.setNotifyEmail('42', 'alice@example.com'), 'alice@example.com');
  assert.equal(store.isEmailVerified('42'), false);

  const started = store.ensureEmailVerification('42', { now: new Date('2026-09-27T10:00:00Z') });
  assert.equal(started.created, true);
  assert.match(started.token, /^[0-9a-f]{48}$/);
  assert.equal(started.expiresAt, '2026-09-28T10:00:00.000Z');

  // A live token is never re-issued (the raw value is not recoverable).
  const again = store.ensureEmailVerification('42', { now: new Date('2026-09-27T11:00:00Z') });
  assert.equal(again.created, false);
  assert.equal(again.reason, 'pending');

  // Wrong token changes nothing.
  assert.equal(store.verifyEmail('42', 'not-the-token'), 'invalid');
  assert.equal(store.isEmailVerified('42'), false);

  // The right token verifies once.
  assert.equal(
    store.verifyEmail('42', started.token, { now: new Date('2026-09-27T12:00:00Z') }),
    'verified',
  );
  assert.equal(store.isEmailVerified('42'), true);
  assert.equal(store.verifyEmail('42', started.token), 'invalid');
  assert.equal(store.get('42').notifyEmailVerifiedAt, '2026-09-27T12:00:00.000Z');
  assert.equal(store.ensureEmailVerification('42').reason, 'verified');

  // Reload keeps the verification and drops the token digest.
  const reloaded = new AccountStore({ path: file });
  assert.equal(reloaded.isEmailVerified('42'), true);
  assert.equal(reloaded.get('42').notifyEmailTokenHash, '');
});

test('changing the notification email invalidates verification', () => {
  const store = new AccountStore({ path: tempPath() });
  store.upsert({ id: '42', login: 'alice' });
  store.setNotifyEmail('42', 'alice@example.com');
  const { token } = store.ensureEmailVerification('42');
  store.verifyEmail('42', token);
  assert.equal(store.isEmailVerified('42'), true);

  // Re-saving the same address keeps the verification.
  store.setNotifyEmail('42', 'alice@example.com');
  assert.equal(store.isEmailVerified('42'), true);

  // A different address resets both verification and the pending token.
  store.setNotifyEmail('42', 'other@example.com');
  assert.equal(store.isEmailVerified('42'), false);
  assert.equal(store.get('42').notifyEmailTokenHash, '');
  assert.equal(store.ensureEmailVerification('42').created, true);

  // Clearing the address clears the verification state entirely.
  store.setNotifyEmail('42', '');
  assert.equal(store.isEmailVerified('42'), false);
  assert.equal(store.get('42').notifyEmailTokenHash, '');
  assert.equal(store.ensureEmailVerification('42').reason, 'no-email');
});

test('an expired verification token is refused and cleared', () => {
  const store = new AccountStore({ path: tempPath() });
  store.upsert({ id: '42', login: 'alice' });
  store.setNotifyEmail('42', 'alice@example.com');
  const { token } = store.ensureEmailVerification('42', { now: new Date('2026-09-27T10:00:00Z') });
  assert.equal(
    store.verifyEmail('42', token, { now: new Date('2026-09-28T10:00:01Z') }),
    'expired',
  );
  assert.equal(store.isEmailVerified('42'), false);
  assert.equal(store.get('42').notifyEmailTokenHash, '');
  // A fresh start issues a new token.
  assert.equal(store.ensureEmailVerification('42').created, true);
});

test('upsert preserves stored prefs and normalization ignores junk', () => {
  const store = new AccountStore({ path: tempPath() });
  store.upsert({ id: '42', login: 'alice' });
  store.setNotifyKinds('42', { claim: false, report: true, review: false });
  const again = store.upsert({ id: '42', login: 'alice-renamed' });
  assert.deepEqual(again.notifyKinds, { claim: false, report: true, review: false });

  // Only an explicit `false` mutes a kind; malformed input defaults to on.
  assert.deepEqual(normalizeNotifyKinds(null), { claim: true, report: true, review: true });
  assert.deepEqual(normalizeNotifyKinds('yes'), { claim: true, report: true, review: true });
  assert.deepEqual(normalizeNotifyKinds(['claim']), { claim: true, report: true, review: true });
  assert.deepEqual(
    normalizeNotifyKinds({ claim: 0, report: 'on', review: [] }),
    { claim: true, report: true, review: true },
  );
});
