// XIOM Package Registry -- community -> maintainer contact (A7, SESSION 21.9.2).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Deliberately separate from the admin-only report flow: a report is an
// unverified allegation that moderators handle, while this channel carries a
// signed-in account's question straight to the package's maintainers. Messages
// are stored (audit + abuse handling), rate-limited per account and per
// package, and notified as the `support` kind; maintainers can flag a message
// to the moderators. Maintainer replies are A9 and are not built here.
// Nothing in this file can publish; the index protocol is untouched.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { BadRequestError, ConflictError } = require('./errors');
const { atomicWriteFile } = require('./index');

const SUPPORT_SCHEMA_VERSION = '1.0.0';
const MAX_SUPPORT_BYTES = 2 * 1024 * 1024;
const MAX_BODY = 1000;
const MIN_BODY = 10;
const SUPPORT_REASONS = Object.freeze(['question', 'bug', 'security', 'other']);
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_ACCOUNT_PER_DAY = 5;
// One message per account per package per day keeps the channel usable for
// maintainers without opening a spam vector (10k-user scale, A7).
const MAX_PER_PACKAGE_PER_ACCOUNT_PER_DAY = 1;
const SAFE_PACKAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

function clean(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : '';
}

function normalizeUser(user) {
  const githubId = String(user && user.githubId ? user.githubId : '');
  const login = clean(user && user.login, 64);
  if (!/^\d{1,32}$/.test(githubId) || !login) {
    throw new BadRequestError('a signed-in GitHub account is required', 'invalid_sender');
  }
  return { githubId, login };
}

/** Allowlist-normalize one on-disk message; malformed entries are dropped. */
function normalizeMessage(id, entry) {
  if (!/^sup_[0-9a-f]{12}$/.test(id) || !entry || typeof entry !== 'object') return null;
  const packageName = clean(entry.package, 128).toLowerCase();
  if (!SAFE_PACKAGE_NAME.test(packageName)) return null;
  let requester;
  try {
    requester = normalizeUser(entry.requester);
  } catch {
    return null;
  }
  if (!SUPPORT_REASONS.includes(entry.reason)) return null;
  const body = clean(entry.body, MAX_BODY);
  if (body.length < MIN_BODY) return null;
  return {
    id,
    package: packageName,
    requester,
    reason: entry.reason,
    body,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    abuseReportedAt: typeof entry.abuseReportedAt === 'string' ? entry.abuseReportedAt : '',
    abuseReportedBy: clean(entry.abuseReportedBy, 64),
  };
}

/** In-memory message map with write-through persistence to support.json. */
class SupportStore {
  /**
   * @param {{ path: string, maxBytes?: number, now?: () => Date }} options
   */
  constructor({ path, maxBytes = MAX_SUPPORT_BYTES, now = () => new Date() }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.now = now;
    this.messages = this.#read();
  }

  #read() {
    if (!fs.existsSync(this.path)) return {};
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read support messages ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`support messages ${this.path} are corrupt JSON: ${err.message}`);
    }
    const source = parsed && typeof parsed === 'object' && parsed.messages && typeof parsed.messages === 'object'
      ? parsed.messages
      : {};
    const messages = {};
    for (const [id, entry] of Object.entries(source)) {
      const message = normalizeMessage(id, entry);
      if (message) messages[id] = message;
    }
    return messages;
  }

  /**
   * Record one support message for a package. Throws BadRequestError for bad
   * input and ConflictError when the sender hit a rate limit.
   */
  create({ packageName, requester, reason, body }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    const sender = normalizeUser(requester);
    if (!SUPPORT_REASONS.includes(reason)) {
      throw new BadRequestError(`topic must be one of: ${SUPPORT_REASONS.join(', ')}`, 'invalid_reason');
    }
    const text = clean(body, MAX_BODY);
    if (text.length < MIN_BODY) {
      throw new BadRequestError(
        `describe your question or issue in at least ${MIN_BODY} characters`,
        'support_body_required',
      );
    }
    const now = this.now();
    const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
    const recent = Object.values(this.messages)
      .filter((message) => message.requester.githubId === sender.githubId && message.createdAt >= since);
    if (recent.some((message) => message.package === name)) {
      throw new ConflictError(
        'you already messaged the maintainers of this package today; wait for their reply',
        'support_rate_package',
      );
    }
    if (recent.length >= MAX_PER_ACCOUNT_PER_DAY) {
      throw new ConflictError(
        'you reached the daily limit for maintainer messages; try again tomorrow',
        'support_rate_account',
      );
    }
    const id = `sup_${crypto.randomBytes(6).toString('hex')}`;
    const message = {
      id,
      package: name,
      requester: sender,
      reason,
      body: text,
      createdAt: now.toISOString(),
      abuseReportedAt: '',
      abuseReportedBy: '',
    };
    this.#commit({ ...this.messages, [id]: message });
    return message;
  }

  get(id) {
    return this.messages[String(id)] || null;
  }

  list() {
    return Object.values(this.messages).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Daily window count for one sender (form copy + tests). */
  recentFor(githubId, { packageName = '', now = this.now() } = {}) {
    const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
    return Object.values(this.messages).filter((message) => message.requester.githubId === String(githubId)
      && message.createdAt >= since
      && (!packageName || message.package === packageName));
  }

  /**
   * Flag a message to the moderators. Idempotent: the first report wins and
   * later ones only report `alreadyReported: true`.
   *
   * @returns {{ message: object, alreadyReported: boolean }|null}
   */
  markAbuse(id, { actor } = {}) {
    const existing = this.messages[String(id)];
    if (!existing) return null;
    if (existing.abuseReportedAt) return { message: existing, alreadyReported: true };
    const message = {
      ...existing,
      abuseReportedAt: this.now().toISOString(),
      abuseReportedBy: clean(actor && actor.login, 64),
    };
    this.#commit({ ...this.messages, [message.id]: message });
    return { message, alreadyReported: false };
  }

  #commit(next) {
    const serialized = JSON.stringify({
      version: SUPPORT_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      messages: next,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`support messages file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.messages = next;
  }
}

module.exports = {
  SupportStore,
  SUPPORT_SCHEMA_VERSION,
  MAX_SUPPORT_BYTES,
  MAX_BODY,
  MIN_BODY,
  SUPPORT_REASONS,
  MAX_PER_ACCOUNT_PER_DAY,
  MAX_PER_PACKAGE_PER_ACCOUNT_PER_DAY,
};
