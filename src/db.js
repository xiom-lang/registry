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
