// XIOM Package Registry -- notification outbox (registry 2.0 groundwork).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// One row per event aimed at one account. The in-app notice is the row
// itself; email delivery is a second, optional step (see mailer.js). Rows
// are never deleted: the outbox is the engagement/audit trail that the
// contributor and profile views will read from later.

'use strict';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL = 254;
// D7 (SESSION.md 21.9.1): failed sends are retried with exponential backoff
// (1m, 2m, 4m, ... capped at 1h) and become terminal `failed` after 5 tries.
const MAX_EMAIL_ATTEMPTS = 5;
const EMAIL_RETRY_BASE_MS = 60 * 1000;
const EMAIL_RETRY_MAX_MS = 60 * 60 * 1000;

function clean(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : '';
}

function normalizeEmail(value) {
  const email = clean(value, MAX_EMAIL);
  return email && EMAIL.test(email) ? email : '';
}

function toNotification(row) {
  return {
    id: row.id,
    githubId: row.github_id,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    link: row.link,
    ref: row.ref || '',
    email: row.email,
    emailStatus: row.email_status,
    emailError: row.email_error || '',
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.next_attempt_at || '',
    createdAt: row.created_at,
    readAt: row.read_at || '',
  };
}

class NotificationStore {
  /**
   * @param {{ db: import('./db').Database }} options
   */
  constructor({ db }) {
    this.db = db;
  }

  /**
   * Record an event for one account. `email` (when set) queues delivery;
   * `ref` optionally points back at the source object (e.g. a support id).
   *
   * @param {{ account: { githubId: string, login: string }, kind: string,
   *           subject: string, body?: string, link?: string, ref?: string,
   *           email?: string }} input
   */
  enqueue({ account, kind, subject, body = '', link = '', ref = '', email = '' }) {
    const githubId = String(account && account.githubId ? account.githubId : '');
    const login = clean(account && account.login, 64);
    if (!/^\d{1,32}$/.test(githubId) || !login) {
      throw new Error('notification requires a signed-in GitHub account');
    }
    const result = this.db.run(
      `INSERT INTO notifications
         (github_id, login, kind, subject, body, link, ref, email, email_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      githubId,
      login,
      clean(kind, 32) || 'notice',
      clean(subject, 200),
      clean(body, 1000),
      clean(link, 300),
      clean(ref, 64),
      normalizeEmail(email),
      normalizeEmail(email) ? 'pending' : 'skipped',
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  get(id) {
    const row = this.db.get('SELECT * FROM notifications WHERE id = ?', Number(id));
    return row ? toNotification(row) : null;
  }

  listFor(githubId, { limit = 50 } = {}) {
    return this.db.all(
      'SELECT * FROM notifications WHERE github_id = ? ORDER BY id DESC LIMIT ?',
      String(githubId),
      Math.min(Math.max(1, limit), 200),
    ).map(toNotification);
  }

  unreadCount(githubId) {
    const row = this.db.get(
      'SELECT COUNT(*) AS count FROM notifications WHERE github_id = ? AND read_at IS NULL',
      String(githubId),
    );
    return row ? Number(row.count) : 0;
  }

  markAllRead(githubId) {
    return this.db.run(
      'UPDATE notifications SET read_at = ? WHERE github_id = ? AND read_at IS NULL',
      new Date().toISOString(),
      String(githubId),
    ).changes;
  }

  /**
   * Rows ready for delivery. A row with failed attempts stays `pending` with a
   * `next_attempt_at` backoff until MAX_EMAIL_ATTEMPTS, then it is terminal.
   */
  pendingEmails(limit = 20, now = new Date()) {
    return this.db.all(
      `SELECT * FROM notifications
       WHERE email <> '' AND email_status = 'pending' AND attempts < ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id LIMIT ?`,
      MAX_EMAIL_ATTEMPTS,
      now.toISOString(),
      Math.min(Math.max(1, limit), 100),
    ).map(toNotification);
  }

  /**
   * Record one failed delivery attempt: exponential backoff up to
   * MAX_EMAIL_ATTEMPTS, then terminal `failed` with the last error kept for
   * the admin console.
   */
  markEmailFailure(id, error = '', now = new Date()) {
    const row = this.db.get('SELECT * FROM notifications WHERE id = ?', Number(id));
    if (!row || row.email_status !== 'pending') return 0;
    const attempts = Number(row.attempts) + 1;
    if (attempts >= MAX_EMAIL_ATTEMPTS) {
      return this.db.run(
        `UPDATE notifications SET attempts = ?, email_status = 'failed', email_error = ?
         WHERE id = ?`,
        attempts,
        clean(error, 300),
        Number(id),
      ).changes;
    }
    const delay = Math.min(EMAIL_RETRY_BASE_MS * 2 ** (attempts - 1), EMAIL_RETRY_MAX_MS);
    return this.db.run(
      'UPDATE notifications SET attempts = ?, email_error = ?, next_attempt_at = ? WHERE id = ?',
      attempts,
      clean(error, 300),
      new Date(now.getTime() + delay).toISOString(),
      Number(id),
    ).changes;
  }

  /** Aggregate delivery state for the admin console (D7). */
  outboxCounts() {
    const counts = { pending: 0, retrying: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of this.db.all(
      `SELECT email_status AS status, attempts, COUNT(*) AS count
       FROM notifications GROUP BY email_status, attempts`,
    )) {
      if (row.status === 'pending' && Number(row.attempts) > 0) counts.retrying += Number(row.count);
      else if (counts[row.status] !== undefined) counts[row.status] += Number(row.count);
    }
    return counts;
  }

  /** Most recent terminal email failures, newest first (admin console). */
  recentEmailFailures(limit = 3) {
    return this.db.all(
      `SELECT * FROM notifications WHERE email_status = 'failed' ORDER BY id DESC LIMIT ?`,
      Math.min(Math.max(1, limit), 20),
    ).map(toNotification);
  }

  markEmail(id, status) {
    const allowed = new Set(['pending', 'sent', 'failed', 'skipped']);
    if (!allowed.has(status)) throw new Error(`invalid email status: ${status}`);
    return this.db.run(
      'UPDATE notifications SET email_status = ?, emailed_at = ? WHERE id = ?',
      status,
      status === 'sent' ? new Date().toISOString() : null,
      Number(id),
    ).changes;
  }
}

module.exports = {
  NotificationStore,
  normalizeEmail,
  EMAIL,
  MAX_EMAIL_ATTEMPTS,
  EMAIL_RETRY_BASE_MS,
  EMAIL_RETRY_MAX_MS,
};
