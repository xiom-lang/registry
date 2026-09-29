// XIOM Package Registry -- artifact download statistics (C1, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Counts artifact requests per package, version, and UTC day. There is no
// per-user tracking anywhere: within a day, one visitor (identified only by a
// salted hash of the remote address) counts once per version, the salt
// rotates daily through the HMAC message so markers cannot be linked across
// days, and raw addresses are never written. The durable aggregate
// (`download_counts`) is kept forever while the dedupe markers are pruned
// after a week. Stats are display metadata: they never touch /index.json, a
// signature, or a digest.

'use strict';

const crypto = require('crypto');

/** Dedupe markers older than this many days are pruned on the next record. */
const MARKER_RETENTION_DAYS = 7;
/** Recent windows shown next to the all-time total. */
const STATS_WINDOWS = Object.freeze([7, 30]);
/** Days of history returned by `forPackage` (the page shows a short trend). */
const STATS_HISTORY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day key (`YYYY-MM-DD`) for a Date. */
function dayKey(at = new Date()) {
  return new Date(at).toISOString().slice(0, 10);
}

/** Whole days between two day keys (b - a), UTC. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

class DownloadStats {
  /**
   * @param {{ db: import('./db').Database, salt?: string }} options
   *   `salt` only needs to be stable for a process lifetime: it is mixed with
   *   the day key, so a restart costs at most one extra count per visitor
   *   per version, and it is never persisted.
   */
  constructor({ db, salt = crypto.randomBytes(32).toString('hex') }) {
    this.db = db;
    this.salt = salt;
    this.lastPrunedDay = '';
  }

  /** Day-salted, non-reversible visitor marker. */
  markerFor(ip, day) {
    return crypto.createHmac('sha256', `${this.salt}|${day}`)
      .update(String(ip || 'unknown'))
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Count one artifact request. A repeat from the same visitor for the same
   * version on the same day is ignored.
   *
   * @returns {boolean} true when the request incremented the aggregate.
   */
  record({ package: packageName, version, ip, at = new Date() }) {
    const day = dayKey(at);
    const inserted = this.db.run(
      'INSERT OR IGNORE INTO download_markers (package, version, day, marker) VALUES (?, ?, ?, ?)',
      String(packageName),
      String(version),
      day,
      this.markerFor(ip, day),
    );
    if (inserted.changes > 0) {
      this.db.run(
        `INSERT INTO download_counts (package, version, day, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(package, version, day) DO UPDATE SET count = count + 1`,
        String(packageName),
        String(version),
        day,
      );
    }
    // Prune at most once per day for live traffic; a backdated record (tests,
    // imports) must never leave a stale marker behind, so it always prunes.
    const today = dayKey();
    if (today !== this.lastPrunedDay || day !== today) {
      this.prune(today);
      this.lastPrunedDay = today;
    }
    return inserted.changes > 0;
  }

  /** Drop dedupe markers past the retention window. */
  prune(today = dayKey()) {
    const cutoff = dayKey(new Date(Date.parse(`${today}T00:00:00Z`) - MARKER_RETENTION_DAYS * DAY_MS));
    this.db.run('DELETE FROM download_markers WHERE day < ?', cutoff);
  }

  /**
   * One package's downloads: all-time total, the 7- and 30-day windows, and
   * the per-day history used for the small trend display.
   *
   * @returns {{ total: number, last7: number, last30: number,
   *             days: Array<{ day: string, count: number }> }}
   */
  forPackage(packageName) {
    const totalRow = this.db.get(
      'SELECT COALESCE(SUM(count), 0) AS count FROM download_counts WHERE package = ?',
      String(packageName),
    );
    const rows = this.db.all(
      `SELECT day, SUM(count) AS count FROM download_counts
       WHERE package = ? GROUP BY day ORDER BY day DESC LIMIT ?`,
      String(packageName),
      STATS_HISTORY_DAYS,
    );
    const today = dayKey();
    let last7 = 0;
    let last30 = 0;
    for (const row of rows) {
      const age = daysBetween(row.day, today);
      const count = Number(row.count) || 0;
      if (age < 7) last7 += count;
      if (age < 30) last30 += count;
    }
    return {
      total: totalRow ? Number(totalRow.count) || 0 : 0,
      last7,
      last30,
      days: rows.map((row) => ({ day: row.day, count: Number(row.count) || 0 })),
    };
  }

  /** All-time totals for every package, for the most-downloaded sort. */
  totalsFor() {
    const rows = this.db.all(
      'SELECT package, SUM(count) AS count FROM download_counts GROUP BY package',
    );
    return new Map(rows.map((row) => [row.package, Number(row.count) || 0]));
  }
}

module.exports = {
  DownloadStats,
  dayKey,
  daysBetween,
  MARKER_RETENTION_DAYS,
  STATS_WINDOWS,
  STATS_HISTORY_DAYS,
};
