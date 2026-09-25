// XIOM Package Registry -- community reports about packages (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md section 15 phase 3, first slice: any signed-in account can report
// a package (abuse, malware, licensing); reviewers and admins resolve or
// dismiss the report with a note, and every transition stays in the record.
// Reports are display/audit data: they never alter an artifact or the index.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { validatePackageName } = require('./names');

const REVIEWS_SCHEMA_VERSION = '1.0.0';
const MAX_REVIEWS_BYTES = 4 * 1024 * 1024;
const MAX_NOTE = 500;
const REPORT_REASONS = Object.freeze(['malware', 'spam', 'impersonation', 'license', 'abandoned', 'other']);
const REPORT_STATUSES = new Set(['open', 'resolved', 'dismissed']);
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

/**
 * JSON-file report queue on the registry data volume.
 */
class ReviewStore {
  /**
   * @param {{ path: string, maxBytes?: number }} options
   */
  constructor({ path, maxBytes = MAX_REVIEWS_BYTES }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.reports = this.#read();
  }

  #read() {
    if (!fs.existsSync(this.path)) return {};
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read reviews ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`reviews ${this.path} is corrupt JSON: ${err.message}`);
    }
    const source = parsed && typeof parsed === 'object' && parsed.reports && typeof parsed.reports === 'object'
      ? parsed.reports
      : {};
    const reports = {};
    for (const [id, entry] of Object.entries(source)) {
      const report = normalizeReport(id, entry);
      if (report) reports[id] = report;
    }
    return reports;
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
    this.#commit({ ...this.reports, [id]: report });
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
    this.#commit({ ...this.reports, [report.id]: updated });
    return updated;
  }

  #newId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `rep_${crypto.randomBytes(6).toString('hex')}`;
      if (!this.reports[id]) return id;
    }
    throw new Error('could not allocate a report id');
  }

  #commit(next) {
    const serialized = JSON.stringify({
      version: REVIEWS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      reports: next,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`reviews file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.reports = next;
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

module.exports = {
  ReviewStore,
  REVIEWS_SCHEMA_VERSION,
  MAX_REVIEWS_BYTES,
  MAX_NOTE,
  REPORT_REASONS,
};
