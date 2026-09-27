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
