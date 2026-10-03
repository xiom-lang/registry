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
  {
    id: '005-review-ratings',
    up(db) {
      // A3 phase 1 (SESSION.md 18.2): star ratings move off reviews.json into
      // the platform database. The JSON file stays as the import source and a
      // best-effort rollback mirror; SQLite is primary whenever it has rows.
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_ratings (
          package TEXT NOT NULL,
          github_id TEXT NOT NULL,
          login TEXT NOT NULL,
          stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
          review TEXT NOT NULL DEFAULT '',
          at TEXT NOT NULL,
          PRIMARY KEY (package, github_id)
        );
        CREATE INDEX IF NOT EXISTS review_ratings_package ON review_ratings (package, at DESC, github_id);
      `);
    },
  },
  {
    id: '006-review-reports-decisions',
    up(db) {
      // A3 phase 2 (SESSION.md 18.2): the report queue and reviewer decisions
      // move to SQLite with the same import + JSON mirror contract as ratings.
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_reports (
          id TEXT PRIMARY KEY,
          package TEXT NOT NULL,
          reporter_id TEXT NOT NULL,
          reporter_login TEXT NOT NULL,
          reason TEXT NOT NULL,
          note TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
          created_at TEXT NOT NULL,
          resolution TEXT NOT NULL DEFAULT '',
          resolved_at TEXT NOT NULL DEFAULT '',
          resolved_by TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS review_reports_queue ON review_reports (status, created_at DESC, id);
        CREATE INDEX IF NOT EXISTS review_reports_package ON review_reports (package, status, reporter_id);
        CREATE TABLE IF NOT EXISTS review_decisions (
          package TEXT PRIMARY KEY,
          reviewed INTEGER NOT NULL DEFAULT 0,
          flagged INTEGER NOT NULL DEFAULT 0,
          muted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS review_decision_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          package TEXT NOT NULL,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS review_decision_history_package ON review_decision_history (package, id);
      `);
    },
  },
  {
    id: '007-review-social',
    up(db) {
      // A9 (SESSION.md 21.9.3): one vote per account per review (toggle) and
      // one flat maintainer reply per review. Voter identity stays private:
      // it is stored for abuse handling and never rendered.
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_votes (
          package TEXT NOT NULL,
          review_github_id TEXT NOT NULL,
          voter_id TEXT NOT NULL,
          value INTEGER NOT NULL CHECK (value IN (-1, 1)),
          at TEXT NOT NULL,
          PRIMARY KEY (package, review_github_id, voter_id)
        );
        CREATE INDEX IF NOT EXISTS review_votes_review ON review_votes (package, review_github_id);
        CREATE TABLE IF NOT EXISTS review_replies (
          package TEXT NOT NULL,
          review_github_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          author_login TEXT NOT NULL,
          body TEXT NOT NULL,
          at TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (package, review_github_id)
        );
      `);
    },
  },
  {
    id: '008-stored-publishers',
    up(db) {
      // A3 phase 3 (SESSION.md 18.2): app-managed trusted-publisher entries
      // move to SQLite with the import + JSON mirror contract. Everything is
      // re-validated through normalizePublishers on load, so an edited row is
      // dropped rather than trusted.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stored_publishers (
          request_id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          repository TEXT NOT NULL,
          workflow TEXT NOT NULL,
          refs TEXT NOT NULL DEFAULT '[]',
          scopes TEXT NOT NULL DEFAULT '[]',
          first_party INTEGER NOT NULL DEFAULT 0,
          events TEXT NOT NULL DEFAULT '[]',
          approved_by TEXT NOT NULL DEFAULT '',
          approved_at TEXT NOT NULL DEFAULT ''
        );
      `);
    },
  },
  {
    id: '009-stored-requests',
    up(db) {
      // A3 phase 3 (SESSION.md 18.2): the request queue moves to SQLite with
      // the same import + JSON mirror contract. The record itself (optional
      // fields plus its history) lives in `data` and is re-validated through
      // normalizeRecord on load; the extracted columns serve the queue
      // queries and indexes.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stored_requests (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          requester_id TEXT NOT NULL,
          requester_login TEXT NOT NULL,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stored_requests_queue ON stored_requests (status, created_at DESC, id);
        CREATE INDEX IF NOT EXISTS stored_requests_requester ON stored_requests (requester_id, status);
      `);
    },
  },
  {
    id: '010-stored-accounts',
    up(db) {
      // A3 phase 3c (SESSION.md 18.2): the last JSON store. Accounts are
      // re-validated through normalizeAccountEntry on load; the JSON file is
      // imported once and kept as a rollback mirror.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stored_accounts (
          github_id TEXT PRIMARY KEY,
          login TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          avatar_url TEXT NOT NULL DEFAULT '',
          notify_email TEXT NOT NULL DEFAULT '',
          notify_email_verified_at TEXT NOT NULL DEFAULT '',
          notify_email_token_hash TEXT NOT NULL DEFAULT '',
          notify_email_token_expires TEXT NOT NULL DEFAULT '',
          notify_kinds TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT '',
          last_login_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS stored_accounts_login ON stored_accounts (login);
      `);
    },
  },
  {
    id: '011-contributor-sponsors',
    up(db) {
      // A4 (SESSION.md 21): the opt-in GitHub Sponsors badge state. A row
      // exists only after an account opts in; `state` is the cached answer
      // from the public GitHub GraphQL `hasSponsorsListing` check ('sponsor'
      // or 'not'), '' until a check lands. Nothing here handles money: the
      // registry only renders a badge that links to the GitHub profile.
      db.exec(`
        CREATE TABLE IF NOT EXISTS contributor_sponsors (
          github_id TEXT PRIMARY KEY,
          login TEXT NOT NULL,
          opted_in INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT '',
          checked_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT ''
        );
      `);
    },
  },
  {
    id: '012-package-watches',
    up(db) {
      // A5 (SESSION.md 21): follow a package. Watches drive the signed-in
      // account feed and an in-app notification for new releases (kind
      // `release`, mutable per account); the count is public on the package
      // page. A row exists only after an account watches something.
      db.exec(`
        CREATE TABLE IF NOT EXISTS package_watches (
          github_id TEXT NOT NULL,
          login TEXT NOT NULL,
          package TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (github_id, package)
        );
        CREATE INDEX IF NOT EXISTS package_watches_package ON package_watches (package);
      `);
    },
  },
  {
    id: '013-download-stats',
    up(db) {
      // C1 (SESSION.md 21): per-version-per-day artifact download counts, no
      // per-user tracking. `download_counts` is the durable aggregate and
      // survives forever; `download_markers` holds one hashed, day-salted
      // visitor marker per (package, version, day) so a refresh loop cannot
      // inflate the numbers, and is pruned after a week. Raw addresses are
      // never stored, and markers cannot be linked across days.
      db.exec(`
        CREATE TABLE IF NOT EXISTS download_counts (
          package TEXT NOT NULL,
          version TEXT NOT NULL,
          day TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (package, version, day)
        );
        CREATE INDEX IF NOT EXISTS download_counts_package ON download_counts (package);
        CREATE TABLE IF NOT EXISTS download_markers (
          package TEXT NOT NULL,
          version TEXT NOT NULL,
          day TEXT NOT NULL,
          marker TEXT NOT NULL,
          PRIMARY KEY (package, version, day, marker)
        );
        CREATE INDEX IF NOT EXISTS download_markers_day ON download_markers (day);
      `);
    },
  },
  {
    id: '014-work-assignments',
    up(db) {
      // Admin work assignments (owner, 2026-10-03): one row per assigned
      // queue item. The item stores stay authoritative; this only answers
      // "who owns this right now" for the admin inbox. Claim item ids are
      // `${package}:${githubId}`; request ids are `req_*`, report ids `rep_*`.
      db.exec(`
        CREATE TABLE IF NOT EXISTS work_assignments (
          kind TEXT NOT NULL,
          item_id TEXT NOT NULL,
          assignee_id TEXT NOT NULL DEFAULT '',
          assignee_login TEXT NOT NULL DEFAULT '',
          assigned_by TEXT NOT NULL DEFAULT '',
          assigned_at TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (kind, item_id)
        );
        CREATE INDEX IF NOT EXISTS work_assignments_assignee ON work_assignments (assignee_id, kind);
      `);
    },
  },
  {
    id: '015-work-roles',
    up(db) {
      // Supervisor role (owner, 2026-10-03): the capability tier between
      // reviewer and admin -- decides requests/reports, yanks, and assigns
      // work, but never manages users or grants roles. SQLite cannot widen a
      // CHECK constraint, so rebuild the tiny table and copy the grants.
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_roles_v2 (
          github_id TEXT PRIMARY KEY,
          login TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('reviewer', 'supervisor', 'admin')),
          granted_by TEXT NOT NULL,
          granted_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO user_roles_v2 (github_id, login, role, granted_by, granted_at)
          SELECT github_id, login, role, granted_by, granted_at FROM user_roles;
        DROP TABLE user_roles;
        ALTER TABLE user_roles_v2 RENAME TO user_roles;
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
