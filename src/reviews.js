// XIOM Package Registry -- community reports about packages (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md section 15 phase 3, first slice: any signed-in account can report
// a package (abuse, malware, licensing); reviewers and admins resolve or
// dismiss the report with a note, and every transition stays in the record.
// Reports are display/audit data: they never alter an artifact or the index.
//
// A3 phase 1 (SESSION.md 18.2): ratings live in the platform SQLite database
// when the store is constructed with `db`. reviews.json is the import source
// and a best-effort rollback mirror; once SQLite has rows it is primary.
// Reports and decisions still use the JSON file and move in a later phase.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { validatePackageName } = require('./names');

const REVIEWS_SCHEMA_VERSION = '1.1.0';
const MAX_REVIEWS_BYTES = 4 * 1024 * 1024;
const MAX_NOTE = 500;
const MAX_RATING_TEXT = 280;
const REPORT_REASONS = Object.freeze(['malware', 'spam', 'impersonation', 'license', 'abandoned', 'other']);
const REPORT_STATUSES = new Set(['open', 'resolved', 'dismissed']);
const DECISION_STATUSES = new Set(['', 'reviewed', 'flagged', 'muted']);
const DECISION_ACTIONS = new Set(['review', 'unreview', 'flag', 'unflag', 'mute', 'unmute', 'clear']);
const MAX_OPEN_REPORTS_PER_REPORTER = 3;
const SAFE_PACKAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

function clean(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : '';
}

function normalizeReporter(reporter) {
  const githubId = String(reporter && reporter.githubId ? reporter.githubId : '');
  const login = clean(reporter && reporter.login, 64);
  if (!/^\d{1,32}$/.test(githubId) || !login) {
    throw new BadRequestError('a signed-in GitHub account is required', 'invalid_reporter');
  }
  return { githubId, login };
}

/** One SQLite rating row as the store's public shape. */
function ratingFromRow(row) {
  return {
    githubId: String(row.github_id),
    login: row.login,
    stars: Number(row.stars),
    review: row.review || '',
    at: row.at || '',
  };
}

/**
 * Report queue, decisions, and ratings on the registry data volume. When a
 * platform `db` is provided, ratings are stored in SQLite (A3 phase 1);
 * otherwise the legacy JSON path is used (unit tests and embedded use).
 */
class ReviewStore {
  /**
   * @param {{ path: string, maxBytes?: number, db?: import('./db').Database|null }} options
   */
  constructor({ path, maxBytes = MAX_REVIEWS_BYTES, db = null }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.db = db;
    const state = this.#read();
    this.packages = state.packages;
    this.reports = state.reports;
    this.ratings = state.ratings;
    if (db) {
      const imported = this.#importRatings();
      this.#loadRatingsFromDb();
      if (imported > 0) {
        console.log(`xiom-registry: imported ${imported} ratings from reviews.json into SQLite`);
      }
    }
  }

  /** One-time move of the JSON ratings into an empty SQLite table. */
  #importRatings() {
    const row = this.db.get('SELECT COUNT(*) AS count FROM review_ratings');
    if (row && Number(row.count) > 0) return 0;
    let imported = 0;
    this.db.exec('BEGIN');
    try {
      for (const [name, byUser] of Object.entries(this.ratings)) {
        for (const rating of Object.values(byUser)) {
          this.db.run(
            `INSERT OR REPLACE INTO review_ratings (package, github_id, login, stars, review, at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            name,
            rating.githubId,
            rating.login,
            rating.stars,
            rating.review,
            rating.at,
          );
          imported += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`rating import failed: ${err.message}`);
    }
    return imported;
  }

  /** SQLite is primary: the in-memory mirror feeds the JSON rollback file. */
  #loadRatingsFromDb() {
    const ratings = {};
    for (const row of this.db.all('SELECT * FROM review_ratings ORDER BY package, at')) {
      const name = row.package;
      if (!ratings[name]) ratings[name] = {};
      ratings[name][String(row.github_id)] = ratingFromRow(row);
    }
    this.ratings = ratings;
  }

  #read() {
    if (!fs.existsSync(this.path)) return { packages: {}, reports: {}, ratings: {} };
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read reviews ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return { packages: {}, reports: {}, ratings: {} };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`reviews ${this.path} is corrupt JSON: ${err.message}`);
    }
    const packageSource = parsed && typeof parsed === 'object' && parsed.packages && typeof parsed.packages === 'object'
      ? parsed.packages
      : {};
    const reportSource = parsed && typeof parsed === 'object' && parsed.reports && typeof parsed.reports === 'object'
      ? parsed.reports
      : {};
    const ratingSource = parsed && typeof parsed === 'object' && parsed.ratings && typeof parsed.ratings === 'object'
      ? parsed.ratings
      : {};
    const packages = {};
    for (const [name, entry] of Object.entries(packageSource)) {
      const record = normalizeDecision(name, entry);
      if (record) packages[name] = record;
    }
    const reports = {};
    for (const [id, entry] of Object.entries(reportSource)) {
      const report = normalizeReport(id, entry);
      if (report) reports[id] = report;
    }
    const ratings = {};
    for (const [name, entries] of Object.entries(ratingSource)) {
      if (!SAFE_PACKAGE_NAME.test(name) || !entries || typeof entries !== 'object') continue;
      const byUser = {};
      for (const [githubId, entry] of Object.entries(entries)) {
        const rating = normalizeRating(githubId, entry);
        if (rating) byUser[githubId] = rating;
      }
      if (Object.keys(byUser).length > 0) ratings[name] = byUser;
    }
    return { packages, reports, ratings };
  }

  /**
   * File a report against a package.
   *
   * @param {{ packageName: string, reporter: { githubId: string, login: string },
   *           reason: string, note: string }} input
   */
  createReport({ packageName, reporter, reason, note }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    const author = normalizeReporter(reporter);
    if (!REPORT_REASONS.includes(reason)) {
      throw new BadRequestError(
        `reason must be one of: ${REPORT_REASONS.join(', ')}`,
        'invalid_reason',
      );
    }
    const reportNote = clean(note, MAX_NOTE);
    if (!reportNote) {
      throw new BadRequestError('describe the problem so reviewers can act on it', 'report_note_required');
    }
    const open = Object.values(this.reports).filter((report) => report.status === 'open'
      && report.package === name && report.reporter.githubId === author.githubId);
    if (open.length >= MAX_OPEN_REPORTS_PER_REPORTER) {
      throw new ConflictError(
        'you already have open reports for this package; wait for a review',
        'report_limit',
      );
    }
    const now = new Date().toISOString();
    const id = this.#newId();
    const report = {
      id,
      package: name,
      reporter: author,
      reason,
      note: reportNote,
      status: 'open',
      createdAt: now,
    };
    this.#commit(this.packages, { ...this.reports, [id]: report }, this.ratings);
    return report;
  }

  getReport(id) {
    const report = this.reports[String(id)];
    if (!report) throw new NotFoundError(`report "${id}" not found`, 'report_not_found');
    return report;
  }

  /** Newest first; optionally filtered by status and/or package. */
  listReports({ status = '', packageName = '' } = {}) {
    let all = Object.values(this.reports);
    if (status) all = all.filter((report) => report.status === status);
    if (packageName) all = all.filter((report) => report.package === packageName);
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  openReportCount(packageName) {
    const name = String(packageName);
    return Object.values(this.reports)
      .filter((report) => report.status === 'open' && report.package === name).length;
  }

  /** Star ratings (1-5) with an optional short review, one per account. */
  ratingsFor(packageName) {
    if (this.db) {
      return this.db.all(
        'SELECT * FROM review_ratings WHERE package = ? ORDER BY at DESC, github_id',
        String(packageName),
      ).map(ratingFromRow);
    }
    return Object.values(this.ratings[String(packageName)] || {})
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  ratingSummary(packageName) {
    if (this.db) {
      const row = this.db.get(
        'SELECT COUNT(*) AS count, AVG(stars) AS average FROM review_ratings WHERE package = ?',
        String(packageName),
      );
      const count = row ? Number(row.count) : 0;
      if (count === 0) return { count: 0, average: 0 };
      return { count, average: Math.round((Number(row.average) || 0) * 10) / 10 };
    }
    const list = this.ratingsFor(packageName);
    if (list.length === 0) return { count: 0, average: 0 };
    const total = list.reduce((sum, entry) => sum + entry.stars, 0);
    return { count: list.length, average: Math.round((total / list.length) * 10) / 10 };
  }

  /** Create or replace this account's rating for a package. */
  rate(packageName, { user, stars, review = '' }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    const author = normalizeReporter(user);
    const value = Number(stars);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new BadRequestError('rating must be a whole number of stars from 1 to 5', 'invalid_rating');
    }
    const entry = {
      githubId: author.githubId,
      login: author.login,
      stars: value,
      review: clean(review, MAX_RATING_TEXT),
      at: new Date().toISOString(),
    };
    if (this.db) {
      this.db.run(
        `INSERT INTO review_ratings (package, github_id, login, stars, review, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(package, github_id) DO UPDATE SET
           login = excluded.login,
           stars = excluded.stars,
           review = excluded.review,
           at = excluded.at`,
        name,
        entry.githubId,
        entry.login,
        entry.stars,
        entry.review,
        entry.at,
      );
      // Keep the JSON mirror current for rollback; SQLite stays primary.
      const next = { ...(this.ratings[name] || {}), [author.githubId]: entry };
      this.#commit(this.packages, this.reports, { ...this.ratings, [name]: next });
      return entry;
    }
    const next = { ...(this.ratings[name] || {}), [author.githubId]: entry };
    this.#commit(this.packages, this.reports, { ...this.ratings, [name]: next });
    return entry;
  }

  /** Current reviewer decision for a package, or null. */
  decision(packageName) {
    return this.packages[String(packageName)] || null;
  }

  listDecisions() {
    return Object.entries(this.packages).map(([name, record]) => ({ name, ...record }));
  }

  /**
   * Apply a moderation action. `flagged` (public warning) and `muted`
   * (hidden from discovery) are independent properties: a package can be
   * either, both, or neither, and each has its own toggle so removing one
   * never disturbs the other (owner UX report, 2026-09-26). Marking reviewed
   * clears a flag (a clean verdict and a warning cannot coexist) and flagging
   * clears the reviewed mark. History keeps every transition (the audit).
   *
   * @param {string} packageName
   * @param {{ action: 'review'|'unreview'|'flag'|'unflag'|'mute'|'unmute'|'clear',
   *           actor: string, note?: string }} input
   */
  setDecision(packageName, { action, actor, note = '' }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    if (!DECISION_ACTIONS.has(action)) {
      throw new BadRequestError(
        `action must be one of: ${[...DECISION_ACTIONS].join(', ')}`,
        'invalid_action',
      );
    }
    const decisionNote = clean(note, MAX_NOTE);
    if ((action === 'flag' || action === 'mute') && !decisionNote) {
      throw new BadRequestError(
        `a reason is required when ${action === 'mute' ? 'muting' : 'flagging'} a package`,
        action === 'mute' ? 'mute_reason_required' : 'flag_reason_required',
      );
    }
    const prior = this.packages[name]
      || { reviewed: false, flagged: false, muted: false, history: [] };
    const next = { reviewed: prior.reviewed, flagged: prior.flagged, muted: prior.muted };
    if (action === 'review') {
      next.reviewed = true;
      next.flagged = false;
    } else if (action === 'unreview') {
      next.reviewed = false;
    } else if (action === 'flag') {
      next.flagged = true;
      next.reviewed = false;
    } else if (action === 'unflag') {
      next.flagged = false;
    } else if (action === 'mute') {
      next.muted = true;
    } else if (action === 'unmute') {
      next.muted = false;
    } else if (action === 'clear') {
      next.reviewed = false;
      next.flagged = false;
      next.muted = false;
    }
    const history = [...prior.history, {
      at: new Date().toISOString(),
      actor: clean(actor, 64),
      action,
      ...(decisionNote ? { note: decisionNote } : {}),
    }];
    const record = { ...next, history };
    this.#commit({ ...this.packages, [name]: record }, this.reports, this.ratings);
    return record;
  }

  /** Resolve or dismiss an open report with the reviewer's note. */
  resolveReport(id, { actor, status = 'resolved', resolution = '' }) {
    const report = this.getReport(id);
    if (report.status !== 'open') {
      throw new ConflictError(`report ${id} is already ${report.status}`, 'report_not_open');
    }
    if (status !== 'resolved' && status !== 'dismissed') {
      throw new BadRequestError('status must be "resolved" or "dismissed"', 'invalid_resolution');
    }
    const text = clean(resolution, MAX_NOTE);
    if (!text) {
      throw new BadRequestError('a resolution note is required', 'resolution_required');
    }
    const updated = {
      ...report,
      status,
      resolution: text,
      resolvedAt: new Date().toISOString(),
      resolvedBy: clean(actor, 64),
    };
    this.#commit(this.packages, { ...this.reports, [report.id]: updated }, this.ratings);
    return updated;
  }

  #newId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `rep_${crypto.randomBytes(6).toString('hex')}`;
      if (!this.reports[id]) return id;
    }
    throw new Error('could not allocate a report id');
  }

  #commit(nextPackages, nextReports, nextRatings) {
    const serialized = JSON.stringify({
      version: REVIEWS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      packages: nextPackages,
      reports: nextReports,
      ratings: nextRatings,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`reviews file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.packages = nextPackages;
    this.reports = nextReports;
    this.ratings = nextRatings;
  }
}

/** Allowlist-normalize one on-disk report; malformed entries are dropped. */
function normalizeReport(id, entry) {
  if (!/^rep_[0-9a-f]{12}$/.test(id) || !entry || typeof entry !== 'object') return null;
  const packageName = clean(entry.package, 128).toLowerCase();
  if (!SAFE_PACKAGE_NAME.test(packageName)) return null;
  const reporter = entry.reporter;
  const githubId = String(reporter && reporter.githubId ? reporter.githubId : '');
  const login = clean(reporter && reporter.login, 64);
  if (!/^\d{1,32}$/.test(githubId) || !login) return null;
  if (!REPORT_STATUSES.has(entry.status) || !REPORT_REASONS.includes(entry.reason)) return null;
  const report = {
    id,
    package: packageName,
    reporter: { githubId, login },
    reason: entry.reason,
    note: clean(entry.note, MAX_NOTE),
    status: entry.status,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
  };
  if (report.note === '') return null;
  for (const field of ['resolution', 'resolvedAt', 'resolvedBy']) {
    const value = clean(entry[field], field === 'resolution' ? MAX_NOTE : 64);
    if (value) report[field] = value;
  }
  return report;
}

/**
 * Normalize one on-disk decision record. New records keep independent
 * `reviewed`/`flagged`/`muted` booleans; records written before that model
 * carry a single `status` and are mapped over on load (history is kept).
 */
function normalizeDecision(name, entry) {
  if (!SAFE_PACKAGE_NAME.test(name) || !entry || typeof entry !== 'object') return null;
  const legacy = typeof entry.status === 'string' && DECISION_STATUSES.has(entry.status)
    ? entry.status
    : '';
  const flagged = entry.flagged === true || legacy === 'flagged';
  const muted = entry.muted === true || legacy === 'muted';
  const reviewed = (entry.reviewed === true || legacy === 'reviewed') && !flagged;
  const history = Array.isArray(entry.history)
    ? entry.history
      .filter((item) => item && typeof item === 'object' && typeof item.action === 'string')
      .map((item) => ({
        at: clean(item.at, 40),
        actor: clean(item.actor, 64),
        action: clean(item.action, 32),
        ...(clean(item.note, MAX_NOTE) ? { note: clean(item.note, MAX_NOTE) } : {}),
      }))
    : [];
  if (history.length === 0) return null;
  // A record with no active property and no recognizable decision action is
  // noise (e.g. a hand-edited file); drop it.
  const knownHistory = new Set([
    'review', 'unreview', 'flag', 'unflag', 'mute', 'unmute', 'clear',
    'reviewed', 'flagged', 'muted', 'cleared',
  ]);
  if (!reviewed && !flagged && !muted && !history.some((item) => knownHistory.has(item.action))) {
    return null;
  }
  return { reviewed, flagged, muted, history };
}

/** Allowlist-normalize one on-disk rating; malformed entries are dropped. */
function normalizeRating(githubId, entry) {
  if (!/^\d{1,32}$/.test(githubId) || !entry || typeof entry !== 'object') return null;
  const login = clean(entry.login, 64);
  const stars = Number(entry.stars);
  if (!login || !Number.isInteger(stars) || stars < 1 || stars > 5) return null;
  return {
    githubId,
    login,
    stars,
    review: clean(entry.review, MAX_RATING_TEXT),
    at: typeof entry.at === 'string' ? entry.at : '',
  };
}

module.exports = {
  ReviewStore,
  REVIEWS_SCHEMA_VERSION,
  MAX_REVIEWS_BYTES,
  MAX_NOTE,
  MAX_RATING_TEXT,
  REPORT_REASONS,
  DECISION_STATUSES,
  DECISION_ACTIONS,
};
