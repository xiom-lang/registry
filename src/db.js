// XIOM Package Registry -- SQLite platform layer (registry 2.0 groundwork).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md section 18: SQLite is the primary store for the social layer
// (notifications first; index/accounts/requests/reviews/publishers migrate
// behind their store interfaces next). One file on the data volume, WAL for
// concurrent reads, and a tiny ordered migration list so every deploy is
// idempotent. The publish protocol (`/index.json`) never reads this database.

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  {
    id: '001-notifications',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          github_id TEXT NOT NULL,
          login TEXT NOT NULL,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          link TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          email_status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          read_at TEXT,
          emailed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS notifications_user ON notifications (github_id, id DESC);
        CREATE INDEX IF NOT EXISTS notifications_outbox ON notifications (email_status, id);
      `);
    },
  },
  {
    id: '002-user-administration',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_roles (
          github_id TEXT PRIMARY KEY,
          login TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('reviewer', 'admin')),
          granted_by TEXT NOT NULL,
          granted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_states (
          github_id TEXT PRIMARY KEY,
          login TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'banned')),
          reason TEXT NOT NULL DEFAULT '',
          changed_by TEXT NOT NULL,
          changed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_login TEXT NOT NULL,
          action TEXT NOT NULL,
          subject_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          subject_login TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS admin_audit_recent ON admin_audit (id DESC);
        CREATE INDEX IF NOT EXISTS admin_audit_subject ON admin_audit (subject_type, subject_id, id DESC);
      `);
    },
  },
  {
    id: '003-email-delivery',
    up(db) {
      // D7 (SESSION.md 21.9.1): retry bookkeeping for the outbox plus a
      // one-time backlog skip. Rows that were already queued when the
      // verified-address gate shipped were created without any verification,
      // so they are deliberately never sent; every new email is gated in the
      // account store.
      db.exec(`
        ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE notifications ADD COLUMN next_attempt_at TEXT;
        ALTER TABLE notifications ADD COLUMN email_error TEXT NOT NULL DEFAULT '';
        UPDATE notifications SET email_status = 'skipped' WHERE email_status = 'pending';
      `);
    },
  },
  {
    id: '004-notification-ref',
    up(db) {
      // A7: a notice can point back at its source object (the `sup_...`
      // support message for the `support` kind); the abuse flow needs it.
      db.exec("ALTER TABLE notifications ADD COLUMN ref TEXT NOT NULL DEFAULT ''");
    },
  },
];

class Database {
  /**
   * @param {{ path: string }} options
   */
  constructor({ path: filePath }) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.path = filePath;
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      this.db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.db.exec('BEGIN');
      try {
        migration.up(this.db);
        this.db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
          .run(migration.id, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`database migration ${migration.id} failed: ${err.message}`);
      }
    }
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Database, MIGRATIONS };
