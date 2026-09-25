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
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    link: row.link,
    email: row.email,
    emailStatus: row.email_status,
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
   * Record an event for one account. `email` (when set) queues delivery.
   *
   * @param {{ account: { githubId: string, login: string }, kind: string,
   *           subject: string, body?: string, link?: string, email?: string }} input
   */
  enqueue({ account, kind, subject, body = '', link = '', email = '' }) {
    const githubId = String(account && account.githubId ? account.githubId : '');
    const login = clean(account && account.login, 64);
    if (!/^\d{1,32}$/.test(githubId) || !login) {
      throw new Error('notification requires a signed-in GitHub account');
    }
    const result = this.db.run(
      `INSERT INTO notifications (github_id, login, kind, subject, body, link, email, email_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      githubId,
      login,
      clean(kind, 32) || 'notice',
      clean(subject, 200),
      clean(body, 1000),
      clean(link, 300),
      normalizeEmail(email),
      normalizeEmail(email) ? 'pending' : 'skipped',
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
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

  /** Rows with an email address that still need delivery. */
  pendingEmails(limit = 20) {
    return this.db.all(
      `SELECT * FROM notifications
       WHERE email <> '' AND email_status = 'pending' ORDER BY id LIMIT ?`,
      Math.min(Math.max(1, limit), 100),
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

module.exports = { NotificationStore, normalizeEmail, EMAIL };
