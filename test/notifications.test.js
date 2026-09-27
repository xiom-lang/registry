// XIOM Package Registry -- SQLite + notification/outbox tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DatabaseSync } = require('node:sqlite');

const { Database, MIGRATIONS } = require('../src/db');
const { NotificationStore, normalizeEmail, MAX_EMAIL_ATTEMPTS } = require('../src/notifications');
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
    ref: 'sup_0123456789ab',
  });
  assert.ok(id > 0);
  const list = notifications.listFor('42');
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, 'Token request approved');
  assert.equal(list[0].ref, 'sup_0123456789ab');
  assert.equal(notifications.get(id).ref, 'sup_0123456789ab');
  assert.equal(notifications.get(id + 999), null);
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

test('outbox drains pending emails and schedules retries for failures', async () => {
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

    // D7: a failure stays pending with exponential backoff, not terminal.
    const retry = notifications.listFor('2')[0];
    assert.equal(retry.emailStatus, 'pending');
    assert.equal(retry.attempts, 1);
    assert.equal(retry.emailError, 'smtp down');
    const delta = new Date(retry.nextAttemptAt).getTime() - Date.now();
    assert.ok(delta > 50_000 && delta <= 70_000, `first backoff is ~1 minute, got ${delta}ms`);
    // Not eligible yet: a second drain does nothing.
    assert.equal(await outbox.drain(), 0);
  } finally {
    outbox.stop();
    db.close();
  }
});

test('a failing address retries with backoff and then goes terminal', async () => {
  const db = new Database({ path: tempDbPath() });
  const notifications = new NotificationStore({ db });
  notifications.enqueue({
    account: { githubId: '1', login: 'a' }, kind: 'x', subject: 'doomed', email: 'a@example.com',
  });
  let calls = 0;
  const mailer = {
    enabled: true,
    async send() {
      calls += 1;
      throw new Error(`down ${calls}`);
    },
  };
  const outbox = startOutbox({ notifications, mailer, intervalMs: 10 * 60 * 1000 });
  try {
    for (let i = 0; i < MAX_EMAIL_ATTEMPTS; i++) {
      await outbox.drain();
      // Simulate the backoff window elapsing between drains.
      db.run("UPDATE notifications SET next_attempt_at = NULL WHERE email_status = 'pending'");
    }
    const row = notifications.listFor('1')[0];
    assert.equal(row.emailStatus, 'failed');
    assert.equal(row.attempts, MAX_EMAIL_ATTEMPTS);
    assert.equal(row.emailError, `down ${MAX_EMAIL_ATTEMPTS}`);
    // Terminal: no further sends.
    assert.equal(await outbox.drain(), 0);
    assert.equal(calls, MAX_EMAIL_ATTEMPTS);
  } finally {
    outbox.stop();
    db.close();
  }
});

test('outbox counts group retrying and terminal states for the console', async () => {
  const db = new Database({ path: tempDbPath() });
  const notifications = new NotificationStore({ db });
  const mailer = {
    enabled: true,
    async send({ to }) {
      if (to === 'bad@example.com') throw new Error('nope');
      return { status: 'sent' };
    },
  };
  notifications.enqueue({ account: { githubId: '1', login: 'a' }, kind: 'x', subject: 'in-app' });
  notifications.enqueue({
    account: { githubId: '2', login: 'b' }, kind: 'x', subject: 'ok', email: 'ok@example.com',
  });
  notifications.enqueue({
    account: { githubId: '3', login: 'c' }, kind: 'x', subject: 'bad', email: 'bad@example.com',
  });
  const outbox = startOutbox({ notifications, mailer, intervalMs: 10 * 60 * 1000 });
  try {
    assert.equal(await outbox.drain(), 1);
    assert.deepEqual(
      notifications.outboxCounts(),
      { pending: 0, retrying: 1, sent: 1, failed: 0, skipped: 1 },
    );
    for (let i = 1; i < MAX_EMAIL_ATTEMPTS; i++) {
      db.run("UPDATE notifications SET next_attempt_at = NULL WHERE email_status = 'pending'");
      await outbox.drain();
    }
    assert.deepEqual(
      notifications.outboxCounts(),
      { pending: 0, retrying: 0, sent: 1, failed: 1, skipped: 1 },
    );
    const failures = notifications.recentEmailFailures(3);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].emailError, 'nope');
    assert.equal(failures[0].attempts, MAX_EMAIL_ATTEMPTS);
  } finally {
    outbox.stop();
    db.close();
  }
});

test('the email-delivery migration skips pre-gate pending rows once', () => {
  const file = tempDbPath();
  // Rebuild a database as it existed before migration 003.
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 2)) {
    migration.up(raw);
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run(migration.id, new Date().toISOString());
  }
  raw.prepare(
    `INSERT INTO notifications (github_id, login, kind, subject, email, email_status, created_at)
     VALUES ('1', 'a', 'claim', 'pre-gate', 'a@example.com', 'pending', ?)`,
  ).run(new Date().toISOString());
  raw.close();

  const db = new Database({ path: file }); // applies 003-email-delivery
  const row = db.get('SELECT email_status, attempts FROM notifications WHERE id = 1');
  assert.equal(row.email_status, 'skipped');
  assert.equal(Number(row.attempts), 0);
  db.close();
});

test('outbox emails absolute links for the email channel', async () => {
  const db = new Database({ path: tempDbPath() });
  const notifications = new NotificationStore({ db });
  notifications.enqueue({
    account: { githubId: '1', login: 'a' },
    kind: 'claim',
    subject: 'Maintainer claim verified',
    body: 'You are listed as a maintainer.',
    link: '/packages/demo-pkg#reviews',
    email: 'a@example.com',
  });
  notifications.enqueue({
    account: { githubId: '2', login: 'b' },
    kind: 'notice',
    subject: 'External link',
    body: 'Already absolute.',
    link: 'https://example.com/docs',
    email: 'b@example.com',
  });

  const sent = [];
  const mailer = {
    enabled: true,
    async send(message) {
      sent.push(message);
      return { status: 'sent' };
    },
  };
  const outbox = startOutbox({
    notifications,
    mailer,
    intervalMs: 10 * 60 * 1000,
    registryUrl: 'https://staging.registry.xiom-lang.org/',
  });
  try {
    assert.equal(await outbox.drain(), 2);
    assert.equal(
      sent[0].text,
      'You are listed as a maintainer.\n\nhttps://staging.registry.xiom-lang.org/packages/demo-pkg#reviews',
    );
    assert.equal(sent[1].text, 'Already absolute.\n\nhttps://example.com/docs');
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
