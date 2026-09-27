// XIOM Package Registry -- community -> maintainer support store tests (A7).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SupportStore, MAX_PER_ACCOUNT_PER_DAY } = require('../src/support');

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-support-')), 'support.json');
}

const SENDER = { githubId: '7', login: 'sender' };

test('support messages validate input and enforce the daily limits', () => {
  let now = new Date('2026-09-27T10:00:00Z');
  const store = new SupportStore({ path: tempPath(), now: () => now });

  assert.throws(
    () => store.create({ packageName: 'demo-pkg', requester: SENDER, reason: 'nope', body: 'long enough text' }),
    (err) => err.code === 'invalid_reason',
  );
  assert.throws(
    () => store.create({ packageName: 'demo-pkg', requester: SENDER, reason: 'bug', body: 'short' }),
    (err) => err.code === 'support_body_required',
  );
  assert.throws(
    () => store.create({ packageName: 'not a name', requester: SENDER, reason: 'bug', body: 'long enough text' }),
    (err) => err.code === 'invalid_package_name',
  );

  const created = store.create({
    packageName: 'demo-pkg', requester: SENDER, reason: 'bug', body: 'The parser fails on nested maps.',
  });
  assert.match(created.id, /^sup_[0-9a-f]{12}$/);
  assert.equal(created.abuseReportedAt, '');

  // One message per package per sender per day.
  assert.throws(
    () => store.create({ packageName: 'demo-pkg', requester: SENDER, reason: 'question', body: 'Another message.' }),
    (err) => err.code === 'support_rate_package',
  );

  // Other packages are allowed up to the account cap.
  for (let i = 0; i < MAX_PER_ACCOUNT_PER_DAY - 1; i++) {
    store.create({ packageName: `other-${i}`, requester: SENDER, reason: 'other', body: 'A fresh message.' });
  }
  assert.equal(store.recentFor(SENDER.githubId).length, MAX_PER_ACCOUNT_PER_DAY);
  assert.throws(
    () => store.create({ packageName: 'one-more-pkg', requester: SENDER, reason: 'other', body: 'A fresh message.' }),
    (err) => err.code === 'support_rate_account',
  );

  // The window is rolling: the next day the sender may write again.
  now = new Date('2026-09-28T10:00:01Z');
  const nextDay = store.create({
    packageName: 'demo-pkg', requester: SENDER, reason: 'question', body: 'Following up on this.',
  });
  assert.ok(nextDay.id);
});

test('support abuse marks are idempotent and survive a reload', () => {
  const file = tempPath();
  const store = new SupportStore({ path: file, now: () => new Date('2026-09-27T10:00:00Z') });
  const message = store.create({
    packageName: 'demo-pkg', requester: SENDER, reason: 'other', body: 'Ignore this, it is spam.',
  });

  assert.equal(store.markAbuse('missing', { actor: { login: 'maint' } }), null);
  const first = store.markAbuse(message.id, { actor: { login: 'maint' } });
  assert.equal(first.alreadyReported, false);
  const second = store.markAbuse(message.id, { actor: { login: 'other' } });
  assert.equal(second.alreadyReported, true);
  assert.equal(second.message.abuseReportedBy, 'maint');

  const reloaded = new SupportStore({ path: file });
  assert.equal(reloaded.get(message.id).abuseReportedAt, '2026-09-27T10:00:00.000Z');
  assert.equal(reloaded.get(message.id).abuseReportedBy, 'maint');
});

test('malformed support entries are dropped on load', () => {
  const file = tempPath();
  fs.writeFileSync(file, JSON.stringify({
    version: '1.0.0',
    updated_at: '2026-09-27T10:00:00Z',
    messages: {
      sup_0123456789ab: {
        package: 'demo-pkg',
        requester: SENDER,
        reason: 'bug',
        body: 'A valid message body.',
        createdAt: '2026-09-27T09:00:00Z',
      },
      bad: {
        package: 'demo-pkg', requester: SENDER, reason: 'bug', body: 'A valid message body.',
      },
      sup_ffffffffffff: {
        package: 'demo-pkg',
        requester: { githubId: 'x', login: 'sender' },
        reason: 'bug',
        body: 'A valid message body.',
      },
      sup_000000000000: {
        package: 'demo-pkg', requester: SENDER, reason: 'spam-ish', body: 'A valid message body.',
      },
    },
  }));
  const store = new SupportStore({ path: file });
  assert.deepEqual(Object.keys(store.messages), ['sup_0123456789ab']);
  assert.equal(store.get('sup_0123456789ab').reason, 'bug');
});
