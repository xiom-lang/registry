// XIOM Package Registry -- community reports about packages (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md section 15 phase 3, first slice: any signed-in account can report
// a package (abuse, malware, licensing); reviewers and admins resolve or
// dismiss the report with a note, and every transition stays in the record.
// Reports are display/audit data: they never alter an artifact or the index.
//
// A3 (SESSION.md 18.2): ratings, reports, and decisions live in the platform
// SQLite database when the store is constructed with `db`. reviews.json is the
// import source and a best-effort rollback mirror; once SQLite has rows it is
// primary. Requests/accounts/publishers move in a later phase.

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
const MAX_REPLY = 500;
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

/** One SQLite report row as the store's public shape. */
function reportFromRow(row) {
  const report = {
    id: row.id,
    package: row.package,
    reporter: { githubId: String(row.reporter_id), login: row.reporter_login },
    reason: row.reason,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.resolution) report.resolution = row.resolution;
  if (row.resolved_at) report.resolvedAt = row.resolved_at;
  if (row.resolved_by) report.resolvedBy = row.resolved_by;
  return report;
}

/** One decision row plus its history as the store's public shape. */
function decisionFromRows(row, history) {
  return {
    reviewed: row.reviewed === 1,
    flagged: row.flagged === 1,
    muted: row.muted === 1,
    history,
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
      const imported = this.#importLegacy();
      const total = imported.reports + imported.decisions + imported.ratings;
      if (total > 0) {
        console.log(
          `xiom-registry: imported reviews.json into SQLite (${imported.reports} reports, `
          + `${imported.decisions} decisions, ${imported.ratings} ratings)`,
        );
      }
    }
  }

  /**
   * One-time move of the JSON state into empty SQLite tables. Each table is
   * checked independently so a partial import can recover on the next boot.
   */
  #importLegacy() {
    const imported = { reports: 0, decisions: 0, ratings: 0 };
    const empty = (table) => {
      const row = this.db.get(`SELECT COUNT(*) AS count FROM ${table}`);
      return !row || Number(row.count) === 0;
    };
    if (empty('review_reports')) {
      this.db.exec('BEGIN');
      try {
        for (const report of Object.values(this.reports)) {
          this.#insertReport(report);
          imported.reports += 1;
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`report import failed: ${err.message}`);
      }
    }
    if (empty('review_decisions')) {
      this.db.exec('BEGIN');
      try {
        for (const [name, record] of Object.entries(this.packages)) {
          this.#insertDecision(name, record);
          imported.decisions += 1;
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`decision import failed: ${err.message}`);
      }
    }
    if (empty('review_ratings')) {
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
            imported.ratings += 1;
          }
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`rating import failed: ${err.message}`);
      }
    }
    return imported;
  }

  #insertReport(report) {
    this.db.run(
      `INSERT OR REPLACE INTO review_reports
         (id, package, reporter_id, reporter_login, reason, note, status, created_at,
          resolution, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      report.id,
      report.package,
      report.reporter.githubId,
      report.reporter.login,
      report.reason,
      report.note,
      report.status,
      report.createdAt,
      report.resolution || '',
      report.resolvedAt || '',
      report.resolvedBy || '',
    );
  }

  #insertDecision(name, record) {
    this.db.run(
      `INSERT OR REPLACE INTO review_decisions (package, reviewed, flagged, muted)
       VALUES (?, ?, ?, ?)`,
      name,
      record.reviewed ? 1 : 0,
      record.flagged ? 1 : 0,
      record.muted ? 1 : 0,
    );
    this.db.run('DELETE FROM review_decision_history WHERE package = ?', name);
    for (const item of record.history || []) {
      this.db.run(
        'INSERT INTO review_decision_history (package, at, actor, action, note) VALUES (?, ?, ?, ?, ?)',
        name,
        item.at || '',
        item.actor || '',
        item.action || '',
        item.note || '',
      );
    }
  }

  #history(name) {
    return this.db.all(
      'SELECT at, actor, action, note FROM review_decision_history WHERE package = ? ORDER BY id',
      name,
    ).map((row) => ({
      at: row.at,
      actor: row.actor,
      action: row.action,
      ...(row.note ? { note: row.note } : {}),
    }));
  }

  /** The complete JSON mirror built from the primary SQLite tables. */
  #mirror() {
    const packages = {};
    for (const row of this.db.all('SELECT * FROM review_decisions ORDER BY package')) {
      packages[row.package] = decisionFromRows(row, this.#history(row.package));
    }
    const reports = {};
    for (const row of this.db.all('SELECT * FROM review_reports ORDER BY created_at, id')) {
      reports[row.id] = reportFromRow(row);
    }
    const ratings = {};
    for (const row of this.db.all('SELECT * FROM review_ratings ORDER BY package, at')) {
      const name = row.package;
      if (!ratings[name]) ratings[name] = {};
      ratings[name][String(row.github_id)] = ratingFromRow(row);
    }
    return { packages, reports, ratings };
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
    if (!this.db) {
      const open = Object.values(this.reports).filter((report) => report.status === 'open'
        && report.package === name && report.reporter.githubId === author.githubId);
      if (open.length >= MAX_OPEN_REPORTS_PER_REPORTER) {
        throw new ConflictError(
          'you already have open reports for this package; wait for a review',
          'report_limit',
        );
      }
    } else {
      const open = this.db.get(
        `SELECT COUNT(*) AS count FROM review_reports
         WHERE status = 'open' AND package = ? AND reporter_id = ?`,
        name,
        author.githubId,
      );
      if (open && Number(open.count) >= MAX_OPEN_REPORTS_PER_REPORTER) {
        throw new ConflictError(
          'you already have open reports for this package; wait for a review',
          'report_limit',
        );
      }
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
    if (this.db) {
      this.#insertReport(report);
      this.#commit();
    } else {
      this.#commit(this.packages, { ...this.reports, [id]: report }, this.ratings);
    }
    return report;
  }

  getReport(id) {
    if (this.db) {
      const row = this.db.get('SELECT * FROM review_reports WHERE id = ?', String(id));
      if (!row) throw new NotFoundError(`report "${id}" not found`, 'report_not_found');
      return reportFromRow(row);
    }
    const report = this.reports[String(id)];
    if (!report) throw new NotFoundError(`report "${id}" not found`, 'report_not_found');
    return report;
  }

  /** Newest first; optionally filtered by status and/or package. */
  listReports({ status = '', packageName = '' } = {}) {
    if (this.db) {
      const clauses = [];
      const args = [];
      if (status) {
        clauses.push('status = ?');
        args.push(status);
      }
      if (packageName) {
        clauses.push('package = ?');
        args.push(packageName);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return this.db.all(
        `SELECT * FROM review_reports${where} ORDER BY created_at DESC, id DESC`,
        ...args,
      ).map(reportFromRow);
    }
    let all = Object.values(this.reports);
    if (status) all = all.filter((report) => report.status === status);
    if (packageName) all = all.filter((report) => report.package === packageName);
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  openReportCount(packageName) {
    const name = String(packageName);
    if (this.db) {
      const row = this.db.get(
        `SELECT COUNT(*) AS count FROM review_reports WHERE status = 'open' AND package = ?`,
        name,
      );
      return row ? Number(row.count) : 0;
    }
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

  /**
   * Rating summaries for every package with at least one rating, keyed by
   * package name (C1 top-rated sort; one aggregate query, no N+1).
   *
   * @returns {Map<string, { count: number, average: number }>}
   */
  ratingSummaries() {
    if (this.db) {
      const rows = this.db.all(
        `SELECT package, COUNT(*) AS count, AVG(stars) AS average
         FROM review_ratings GROUP BY package`,
      );
      return new Map(rows.map((row) => [row.package, {
        count: Number(row.count) || 0,
        average: Math.round((Number(row.average) || 0) * 10) / 10,
      }]));
    }
    const summaries = new Map();
    for (const name of Object.keys(this.ratings)) {
      const summary = this.ratingSummary(name);
      if (summary.count > 0) summaries.set(name, summary);
    }
    return summaries;
  }

  /**
   * Ratings this account wrote, newest first (A4 contributor profiles).
   *
   * @returns {Array<{ package: string, stars: number, review: string, at: string }>}
   */
  ratingsBy(githubId, { limit = 20 } = {}) {
    const id = String(githubId);
    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    if (this.db) {
      return this.db.all(
        'SELECT package, stars, review, at FROM review_ratings WHERE github_id = ? ORDER BY at DESC, package LIMIT ?',
        id,
        capped,
      ).map((row) => ({
        package: row.package,
        stars: Number(row.stars),
        review: row.review || '',
        at: row.at || '',
      }));
    }
    const rows = [];
    for (const [name, byUser] of Object.entries(this.ratings)) {
      const rating = byUser[id];
      if (rating) rows.push({ package: name, stars: rating.stars, review: rating.review, at: rating.at });
    }
    return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, capped);
  }

  /**
   * Maintainer replies this account wrote, newest first (A4). Replies exist
   * only in SQLite, so the JSON fallback is empty.
   *
   * @returns {Array<{ package: string, reviewGithubId: string, body: string, at: string, updatedAt: string }>}
   */
  repliesBy(githubId, { limit = 20 } = {}) {
    if (!this.db) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    return this.db.all(
      `SELECT package, review_github_id, body, at, updated_at FROM review_replies
       WHERE author_id = ? ORDER BY at DESC, package LIMIT ?`,
      String(githubId),
      capped,
    ).map((row) => ({
      package: row.package,
      reviewGithubId: String(row.review_github_id),
      body: row.body,
      at: row.at || '',
      updatedAt: row.updated_at || '',
    }));
  }

  /**
   * Maintainer replies on one package, newest first (A5 activity feed).
   * Replies live only in SQLite, so the JSON fallback is empty.
   *
   * @returns {Array<{ author: object, body: string, at: string, updatedAt: string }>}
   */
  repliesByPackage(packageName, { limit = 12 } = {}) {
    if (!this.db) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 12, 100));
    return this.db.all(
      `SELECT * FROM review_replies WHERE package = ? ORDER BY at DESC LIMIT ?`,
      String(packageName),
      capped,
    ).map((row) => ({
      author: { githubId: String(row.author_id), login: row.author_login },
      body: row.body,
      at: row.at || '',
      updatedAt: row.updated_at || '',
    }));
  }

  /**
   * Reviewer decisions this account took, newest first (A4). The actor is
   * stored as a login in the decision history (the audit trail the package
   * pages already show).
   *
   * @returns {Array<{ package: string, action: string, note: string, at: string }>}
   */
  decisionsBy(actor, { limit = 20 } = {}) {
    const login = clean(actor, 64);
    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    if (!login) return [];
    if (this.db) {
      return this.db.all(
        `SELECT package, action, note, at FROM review_decision_history
         WHERE actor = ? ORDER BY id DESC LIMIT ?`,
        login,
        capped,
      ).map((row) => ({
        package: row.package,
        action: row.action,
        note: row.note || '',
        at: row.at || '',
      }));
    }
    const needle = login.toLowerCase();
    const rows = [];
    for (const [name, record] of Object.entries(this.packages)) {
      for (const item of record.history || []) {
        if (String(item.actor || '').toLowerCase() !== needle) continue;
        rows.push({ package: name, action: item.action, note: item.note || '', at: item.at || '' });
      }
    }
    return rows.reverse().slice(0, capped);
  }

  /**
   * Per-account contribution counters for the A4 board and profiles:
   * ratings (all), reviews (ratings with text), maintainer replies, and
   * reviewer decisions. The board applies the caps; this is raw counting.
   *
   * @returns {Array<{ githubId: string, login: string, ratings: number,
   *                   reviews: number, replies: number, decisions: number }>}
   */
  contributionCounts() {
    const rows = new Map();
    const entry = (githubId, login) => {
      const normalized = String(login || '').trim();
      // Login is the merge key: a reviewer with ratings has one row, and the
      // stable githubId is carried along when the row has one.
      const key = normalized ? `login:${normalized.toLowerCase()}` : `id:${String(githubId || '')}`;
      if (!rows.has(key)) {
        rows.set(key, { githubId: String(githubId || ''), login: normalized, ratings: 0, reviews: 0, replies: 0, decisions: 0 });
      }
      const record = rows.get(key);
      if (!record.login && normalized) record.login = normalized;
      if (!record.githubId && githubId) record.githubId = String(githubId);
      return record;
    };
    if (this.db) {
      for (const row of this.db.all(
        `SELECT github_id, MAX(login) AS login, COUNT(*) AS count,
                SUM(CASE WHEN review <> '' THEN 1 ELSE 0 END) AS with_text
         FROM review_ratings GROUP BY github_id`,
      )) {
        const record = entry(row.github_id, row.login);
        record.ratings = Number(row.count) || 0;
        record.reviews = Number(row.with_text) || 0;
      }
      for (const row of this.db.all(
        'SELECT author_id, MAX(author_login) AS login, COUNT(*) AS count FROM review_replies GROUP BY author_id',
      )) {
        entry(row.author_id, row.login).replies = Number(row.count) || 0;
      }
      for (const row of this.db.all(
        `SELECT actor, COUNT(*) AS count FROM review_decision_history
         WHERE actor <> '' GROUP BY actor`,
      )) {
        entry('', row.actor).decisions = Number(row.count) || 0;
      }
      return [...rows.values()];
    }
    for (const byUser of Object.values(this.ratings)) {
      for (const rating of Object.values(byUser)) {
        const record = entry(rating.githubId, rating.login);
        record.ratings += 1;
        if (rating.review) record.reviews += 1;
      }
    }
    for (const record of Object.values(this.packages)) {
      for (const item of record.history || []) {
        if (item.actor) entry('', item.actor).decisions += 1;
      }
    }
    return [...rows.values()];
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
      // Refresh the JSON rollback mirror; SQLite stays primary.
      this.#commit();
      return entry;
    }
    const next = { ...(this.ratings[name] || {}), [author.githubId]: entry };
    this.#commit(this.packages, this.reports, { ...this.ratings, [name]: next });
    return entry;
  }

  /**
   * Toggle one vote on a review: casting the same value removes it, the
   * opposite flips it. One row per (package, review, voter) by primary key;
   * the review author cannot vote on their own review (A9).
   *
   * @returns {{ up: number, down: number, mine: -1|0|1 }}
   */
  vote(packageName, reviewGithubId, { voter, value }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    if (!this.db) throw new Error('review votes require the platform database');
    const viewer = normalizeReporter(voter);
    const targetId = String(reviewGithubId);
    const direction = Number(value);
    if (direction !== 1 && direction !== -1) {
      throw new BadRequestError('a vote is either up or down', 'invalid_vote');
    }
    const target = this.db.get(
      'SELECT github_id FROM review_ratings WHERE package = ? AND github_id = ?',
      name,
      targetId,
    );
    if (!target) {
      throw new NotFoundError(`review by ${targetId} on "${name}" not found`, 'review_not_found');
    }
    if (targetId === viewer.githubId) {
      throw new BadRequestError('you cannot vote on your own review', 'self_vote');
    }
    const existing = this.db.get(
      'SELECT value FROM review_votes WHERE package = ? AND review_github_id = ? AND voter_id = ?',
      name,
      targetId,
      viewer.githubId,
    );
    if (existing && Number(existing.value) === direction) {
      this.db.run(
        'DELETE FROM review_votes WHERE package = ? AND review_github_id = ? AND voter_id = ?',
        name,
        targetId,
        viewer.githubId,
      );
    } else {
      this.db.run(
        `INSERT INTO review_votes (package, review_github_id, voter_id, value, at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(package, review_github_id, voter_id) DO UPDATE SET
           value = excluded.value, at = excluded.at`,
        name,
        targetId,
        viewer.githubId,
        direction,
        new Date().toISOString(),
      );
    }
    return this.#tally(name, targetId, viewer.githubId);
  }

  #tally(name, targetId, viewerId = '') {
    let up = 0;
    let down = 0;
    let mine = 0;
    for (const row of this.db.all(
      'SELECT value, voter_id FROM review_votes WHERE package = ? AND review_github_id = ?',
      name,
      targetId,
    )) {
      const value = Number(row.value);
      if (value === 1) up += 1;
      else if (value === -1) down += 1;
      if (viewerId && String(row.voter_id) === String(viewerId)) mine = value;
    }
    return { up, down, mine };
  }

  /** Tallies for a set of reviews on one page, keyed by review github id. */
  votesForPage(packageName, reviewGithubIds = [], viewerId = '') {
    const result = new Map();
    if (!this.db || reviewGithubIds.length === 0) return result;
    const ids = new Set(reviewGithubIds.map(String));
    for (const row of this.db.all('SELECT * FROM review_votes WHERE package = ?', String(packageName))) {
      const id = String(row.review_github_id);
      if (!ids.has(id)) continue;
      const tally = result.get(id) || { up: 0, down: 0, mine: 0 };
      if (Number(row.value) === 1) tally.up += 1;
      else tally.down += 1;
      if (viewerId && String(row.voter_id) === String(viewerId)) tally.mine = Number(row.value);
      result.set(id, tally);
    }
    return result;
  }

  /**
   * One maintainer reply per review (upsert). Authorization is the caller's
   * job: the route checks the maintainer list first.
   */
  replyTo(packageName, reviewGithubId, { author, body }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    if (!this.db) throw new Error('review replies require the platform database');
    const responder = normalizeReporter(author);
    const targetId = String(reviewGithubId);
    const text = clean(body, MAX_REPLY);
    if (!text) throw new BadRequestError('write the reply before sending it', 'reply_required');
    const target = this.db.get(
      'SELECT github_id FROM review_ratings WHERE package = ? AND github_id = ?',
      name,
      targetId,
    );
    if (!target) {
      throw new NotFoundError(`review by ${targetId} on "${name}" not found`, 'review_not_found');
    }
    const existing = this.db.get(
      'SELECT at FROM review_replies WHERE package = ? AND review_github_id = ?',
      name,
      targetId,
    );
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO review_replies (package, review_github_id, author_id, author_login, body, at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(package, review_github_id) DO UPDATE SET
         author_id = excluded.author_id,
         author_login = excluded.author_login,
         body = excluded.body,
         updated_at = excluded.updated_at`,
      name,
      targetId,
      responder.githubId,
      responder.login,
      text,
      existing ? existing.at : now,
      existing ? now : '',
    );
    return {
      author: responder,
      body: text,
      at: existing ? existing.at : now,
      updatedAt: existing ? now : '',
    };
  }

  /** Replies for a set of reviews on one page, keyed by review github id. */
  repliesForPage(packageName, reviewGithubIds = []) {
    const result = new Map();
    if (!this.db || reviewGithubIds.length === 0) return result;
    const ids = new Set(reviewGithubIds.map(String));
    for (const row of this.db.all('SELECT * FROM review_replies WHERE package = ?', String(packageName))) {
      const id = String(row.review_github_id);
      if (!ids.has(id)) continue;
      result.set(id, {
        author: { githubId: String(row.author_id), login: row.author_login },
        body: row.body,
        at: row.at,
        updatedAt: row.updated_at || '',
      });
    }
    return result;
  }

  /**
   * One page of reviews. `sort` is 'newest' or 'helpful' (net upvotes, then
   * newest); `textOnly` keeps reviews that carry text. JSON mode has no vote
   * data, so 'helpful' falls back to stars there.
   */
  ratingsPage(packageName, { page = 1, perPage = 10, sort = 'newest', textOnly = false } = {}) {
    const name = String(packageName);
    const limit = Math.min(Math.max(1, Math.floor(Number(perPage) || 10)), 50);
    const sortValue = sort === 'helpful' ? 'helpful' : 'newest';
    if (!this.db) {
      let all = this.ratingsFor(name).filter((entry) => !textOnly || entry.review !== '');
      if (sortValue === 'helpful') {
        all = [...all].sort((a, b) => b.stars - a.stars || String(b.at).localeCompare(String(a.at)));
      }
      const pages = Math.max(1, Math.ceil(all.length / limit));
      const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
      return {
        items: all.slice((current - 1) * limit, current * limit),
        total: all.length,
        page: current,
        pages,
        perPage: limit,
        sort: sortValue,
        textOnly: Boolean(textOnly),
      };
    }
    const textFilter = textOnly ? " AND review <> ''" : '';
    const totalRow = this.db.get(
      `SELECT COUNT(*) AS count FROM review_ratings WHERE package = ?${textFilter}`,
      name,
    );
    const total = totalRow ? Number(totalRow.count) : 0;
    const pages = Math.max(1, Math.ceil(total / limit));
    const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
    const order = sortValue === 'helpful'
      ? `ORDER BY (SELECT COALESCE(SUM(v.value), 0) FROM review_votes v
           WHERE v.package = review_ratings.package AND v.review_github_id = review_ratings.github_id) DESC,
           at DESC, github_id`
      : 'ORDER BY at DESC, github_id';
    const items = this.db.all(
      `SELECT * FROM review_ratings WHERE package = ?${textFilter} ${order} LIMIT ? OFFSET ?`,
      name,
      limit,
      (current - 1) * limit,
    ).map(ratingFromRow);
    return {
      items,
      total,
      page: current,
      pages,
      perPage: limit,
      sort: sortValue,
      textOnly: Boolean(textOnly),
    };
  }

  /** Current reviewer decision for a package, or null. */
  decision(packageName) {
    const name = String(packageName);
    if (this.db) {
      const row = this.db.get('SELECT * FROM review_decisions WHERE package = ?', name);
      if (!row) return null;
      return decisionFromRows(row, this.#history(name));
    }
    return this.packages[name] || null;
  }

  listDecisions() {
    if (this.db) {
      return this.db.all('SELECT * FROM review_decisions ORDER BY package').map((row) => ({
        name: row.package,
        ...decisionFromRows(row, this.#history(row.package)),
      }));
    }
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
    const prior = this.decision(name)
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
    const entry = {
      at: new Date().toISOString(),
      actor: clean(actor, 64),
      action,
      ...(decisionNote ? { note: decisionNote } : {}),
    };
    const history = [...prior.history, entry];
    const record = { ...next, history };
    if (this.db) {
      this.db.run(
        `INSERT INTO review_decisions (package, reviewed, flagged, muted)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(package) DO UPDATE SET
           reviewed = excluded.reviewed,
           flagged = excluded.flagged,
           muted = excluded.muted`,
        name,
        next.reviewed ? 1 : 0,
        next.flagged ? 1 : 0,
        next.muted ? 1 : 0,
      );
      this.db.run(
        'INSERT INTO review_decision_history (package, at, actor, action, note) VALUES (?, ?, ?, ?, ?)',
        name,
        entry.at,
        entry.actor,
        entry.action,
        entry.note || '',
      );
      this.#commit();
    } else {
      this.#commit({ ...this.packages, [name]: record }, this.reports, this.ratings);
    }
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
    if (this.db) {
      this.db.run(
        'UPDATE review_reports SET status = ?, resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?',
        updated.status,
        updated.resolution,
        updated.resolvedAt,
        updated.resolvedBy,
        updated.id,
      );
      this.#commit();
    } else {
      this.#commit(this.packages, { ...this.reports, [report.id]: updated }, this.ratings);
    }
    return updated;
  }

  #newId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `rep_${crypto.randomBytes(6).toString('hex')}`;
      const exists = this.db
        ? this.db.get('SELECT id FROM review_reports WHERE id = ?', id)
        : this.reports[id];
      if (!exists) return id;
    }
    throw new Error('could not allocate a report id');
  }

  #commit(nextPackages, nextReports, nextRatings) {
    const state = this.db
      ? this.#mirror()
      : { packages: nextPackages, reports: nextReports, ratings: nextRatings };
    const serialized = JSON.stringify({
      version: REVIEWS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      packages: state.packages,
      reports: state.reports,
      ratings: state.ratings,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`reviews file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.packages = state.packages;
    this.reports = state.reports;
    this.ratings = state.ratings;
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
