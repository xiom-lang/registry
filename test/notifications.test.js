// XIOM Package Registry -- SQLite + notification/outbox tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Database } = require('../src/db');
const { NotificationStore, normalizeEmail } = require('../src/notifications');
const { createMailer, startOutbox } = require('../src/mailer');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-db-'));
  return path.join(dir, 'registry.db');
}

test('migrations are idempotent and notifications survive a reopen', () => {
  const file = tempDbPath();
  const db = new Database({ path: file });
  const notifications = new NotificationStore({ db });

  const id = notifications.enqueue({
    account: { githubId: '42', login: 'alice' },
    kind: 'request-approved',
    subject: 'Token request approved',
    body: 'The host will mint your token.',
    link: '/account',
    email: 'alice@example.com',
  });
  assert.ok(id > 0);
  const list = notifications.listFor('42');
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, 'Token request approved');
  assert.equal(list[0].emailStatus, 'pending');
  assert.equal(notifications.unreadCount('42'), 1);
  assert.equal(notifications.markAllRead('42'), 1);
  assert.equal(notifications.unreadCount('42'), 0);
  assert.equal(notifications.pendingEmails().length, 1);
  assert.equal(notifications.markEmail(id, 'sent'), 1);
  assert.equal(notifications.pendingEmails().length, 0);
  db.close();

  // Reopen: migrations do not re-run and rows are intact.
  const again = new Database({ path: file });
  const reopened = new NotificationStore({ db: again });
  const rows = reopened.listFor('42');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emailStatus, 'sent');
  again.close();
});

test('outbox drains pending emails and records failures', async () => {
  const db = new Database({ path: tempDbPath() });
  const notifications = new NotificationStore({ db });
  notifications.enqueue({
    account: { githubId: '1', login: 'a' }, kind: 'x', subject: 'ok', email: 'a@example.com',
  });
  notifications.enqueue({
    account: { githubId: '2', login: 'b' }, kind: 'x', subject: 'bad', email: 'b@example.com',
  });

  const sentTo = [];
  const mailer = {
    enabled: true,
    async send({ to }) {
      if (to.startsWith('b')) throw new Error('smtp down');
      sentTo.push(to);
      return { status: 'sent' };
    },
  };
  const outbox = startOutbox({ notifications, mailer, intervalMs: 10 * 60 * 1000 });
  try {
    assert.equal(await outbox.drain(), 1);
    assert.deepEqual(sentTo, ['a@example.com']);
    assert.equal(notifications.listFor('1')[0].emailStatus, 'sent');
    assert.equal(notifications.listFor('2')[0].emailStatus, 'failed');
  } finally {
    outbox.stop();
    db.close();
  }
});

test('a disabled mailer never sends and rows without email are skipped', async () => {
  const db = new Database({ path: tempDbPath() });
  const notifications = new NotificationStore({ db });
  notifications.enqueue({ account: { githubId: '1', login: 'a' }, kind: 'x', subject: 'in-app only' });
  assert.equal(notifications.listFor('1')[0].emailStatus, 'skipped');
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.equal(normalizeEmail(' dev@example.com '), 'dev@example.com');

  const mailer = createMailer({});
  assert.equal(mailer.enabled, false);
  const outbox = startOutbox({ notifications, mailer, intervalMs: 10 * 60 * 1000 });
  try {
    assert.equal(await outbox.drain(), 0);
    const result = await mailer.send({ to: 'x@example.com', subject: 'x', text: 'x' });
    assert.equal(result.status, 'skipped');
  } finally {
    outbox.stop();
    db.close();
  }
});
