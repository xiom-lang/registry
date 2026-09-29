// XIOM Package Registry -- package watching (A5, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// One row per (account, package). Watches are a personal feed subscription:
// they never grant publish powers, they do not change /index.json, and the
// only public surface is the watcher count on the package page. New releases
// of watched packages enqueue an in-app notice (kind `release`, mutable from
// account settings); the feed itself is assembled at render time from the
// same public data everyone can see.

'use strict';

/** How many packages one account may watch (a feed cap, not a wall). */
const MAX_WATCHES_PER_ACCOUNT = 100;

class WatchStore {
  /** @param {{ db: import('./db').Database }} options */
  constructor({ db }) {
    this.db = db;
  }

  isWatching(githubId, packageName) {
    const row = this.db.get(
      'SELECT 1 AS watched FROM package_watches WHERE github_id = ? AND package = ?',
      String(githubId),
      String(packageName),
    );
    return Boolean(row);
  }

  /** Public count for the package page. */
  countFor(packageName) {
    const row = this.db.get(
      'SELECT COUNT(*) AS count FROM package_watches WHERE package = ?',
      String(packageName),
    );
    return row ? Number(row.count) : 0;
  }

  /** Packages this account watches, most recently added first. */
  packagesFor(githubId, { limit = MAX_WATCHES_PER_ACCOUNT } = {}) {
    const capped = Math.max(1, Math.min(Number(limit) || MAX_WATCHES_PER_ACCOUNT, MAX_WATCHES_PER_ACCOUNT));
    return this.db.all(
      'SELECT package FROM package_watches WHERE github_id = ? ORDER BY created_at DESC, package LIMIT ?',
      String(githubId),
      capped,
    ).map((row) => row.package);
  }

  /** Watchers of a package, for release notices. */
  watchersOf(packageName, { limit = 10_000 } = {}) {
    const capped = Math.max(1, Math.min(Number(limit) || 10_000, 10_000));
    return this.db.all(
      'SELECT github_id, login FROM package_watches WHERE package = ? ORDER BY created_at LIMIT ?',
      String(packageName),
      capped,
    ).map((row) => ({ githubId: String(row.github_id), login: row.login }));
  }

  /**
   * Start watching. Idempotent; enforces the per-account cap so a script
   * cannot turn the feed into an unbounded scan.
   *
   * @returns {{ watching: boolean, watchers: number }}
   */
  watch(githubId, login, packageName, { at = new Date().toISOString() } = {}) {
    const id = String(githubId);
    const name = String(packageName);
    if (!this.isWatching(id, name)) {
      const current = this.packagesFor(id).length;
      if (current >= MAX_WATCHES_PER_ACCOUNT) {
        const error = new Error(`you can watch at most ${MAX_WATCHES_PER_ACCOUNT} packages`);
        error.code = 'watch_limit';
        throw error;
      }
      this.db.run(
        'INSERT INTO package_watches (github_id, login, package, created_at) VALUES (?, ?, ?, ?)',
        id,
        String(login),
        name,
        at,
      );
    }
    return { watching: true, watchers: this.countFor(name) };
  }

  /** Stop watching. Idempotent. */
  unwatch(githubId, packageName) {
    this.db.run(
      'DELETE FROM package_watches WHERE github_id = ? AND package = ?',
      String(githubId),
      String(packageName),
    );
    return { watching: false, watchers: this.countFor(packageName) };
  }

  /**
   * Refresh the display login after a rename (the stable githubId keys the
   * row; the login is only shown in notifications).
   */
  rename(githubId, login) {
    this.db.run(
      'UPDATE package_watches SET login = ? WHERE github_id = ?',
      String(login),
      String(githubId),
    );
  }
}

module.exports = { WatchStore, MAX_WATCHES_PER_ACCOUNT };
