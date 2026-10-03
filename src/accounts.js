// XIOM Package Registry -- GitHub identities (registry 2.0 accounts).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Display identity only: an account links a GitHub login to requests and
// review state, plus its optional notification email and per-kind prefs. It
// carries no publish credential and no role field -- the admin role is
// recomputed from REGISTRY_ADMIN_LOGINS on every request, so a config change
// takes effect without touching stored data (SESSION.md 15).

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { atomicWriteFile } = require('./index');
const { normalizeEmail } = require('./notifications');

const ACCOUNTS_SCHEMA_VERSION = '1.2.0';
const MAX_ACCOUNTS_BYTES = 2 * 1024 * 1024;
// D7 (SESSION.md 21.9.1): the gate before any notification email is sent.
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// Structured notification kinds (SESSION.md 22.4 A2 + 21.9.2 A7 + 21.9.3 A9
// + 21 A5). Only these can be muted from /account/settings; every other
// outbox kind is unconditional.
const NOTIFY_KINDS = Object.freeze([
  'claim', 'report', 'review', 'support', 'review-reply', 'release', 'admin-message',
]);
const DEFAULT_NOTIFY_KINDS = Object.freeze({
  claim: true,
  report: true,
  review: true,
  support: true,
  'review-reply': true,
  release: true,
  'admin-message': true,
});

function clean(value, maxLength) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Allowlist-normalize per-kind notification preferences. Missing or malformed
 * values default to on (the pre-A2 behavior for every row); only an explicit
 * `false` mutes a kind.
 */
function normalizeNotifyKinds(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const kind of NOTIFY_KINDS) out[kind] = source[kind] !== false;
  return out;
}

/** Keep verification state meaningful: no address means no verification. */
function normalizeVerification(entry, notifyEmail) {
  if (!notifyEmail) {
    return { notifyEmailVerifiedAt: '', notifyEmailTokenHash: '', notifyEmailTokenExpires: '' };
  }
  const hash = typeof entry.notifyEmailTokenHash === 'string' && /^[0-9a-f]{64}$/.test(entry.notifyEmailTokenHash)
    ? entry.notifyEmailTokenHash
    : '';
  return {
    notifyEmailVerifiedAt: clean(entry.notifyEmailVerifiedAt, 40),
    notifyEmailTokenHash: hash,
    notifyEmailTokenExpires: hash ? clean(entry.notifyEmailTokenExpires, 40) : '',
  };
}

/** Allowlist-normalize one stored account; malformed entries are dropped. */
function normalizeAccountEntry(githubId, entry) {
  if (!/^\d{1,32}$/.test(githubId) || !entry || typeof entry !== 'object') return null;
  const login = clean(entry.login, 64);
  if (!login) return null;
  const notifyEmail = clean(entry.notifyEmail, 254);
  return {
    githubId,
    login,
    name: clean(entry.name, 200),
    avatarUrl: clean(entry.avatarUrl, 512),
    notifyEmail,
    notifyKinds: normalizeNotifyKinds(entry.notifyKinds),
    ...normalizeVerification(entry, notifyEmail),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    lastLoginAt: typeof entry.lastLoginAt === 'string' ? entry.lastLoginAt : '',
  };
}

/**
 * In-memory account map with write-through persistence. With the shared
 * platform `db`, accounts live in `stored_accounts` and accounts.json is
 * imported once plus kept as a best-effort rollback mirror (A3 phase 3c).
 * Entries are keyed by the numeric GitHub id (stable across renames); the
 * login is refreshed on every sign-in.
 */
class AccountStore {
  /**
   * @param {{ path: string, maxBytes?: number, db?: import('./db').Database|null }} options
   */
  constructor({ path, maxBytes = MAX_ACCOUNTS_BYTES, db = null }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.db = db;
    this.accounts = this.#read();
    if (db) {
      const imported = this.#importAccounts();
      this.#loadFromDb();
      if (imported > 0) {
        console.log(`xiom-registry: imported ${imported} accounts into SQLite`);
      }
    }
  }

  /** Import accounts.json into an empty table (one-time move). */
  #importAccounts() {
    const row = this.db.get('SELECT COUNT(*) AS count FROM stored_accounts');
    if (row && Number(row.count) > 0) return 0;
    this.db.exec('BEGIN');
    try {
      for (const entry of Object.values(this.accounts)) this.#insertAccount(entry);
      this.db.exec('COMMIT');
      return Object.keys(this.accounts).length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`account import failed: ${err.message}`);
    }
  }

  #insertAccount(entry) {
    this.db.run(
      `INSERT OR REPLACE INTO stored_accounts
         (github_id, login, name, avatar_url, notify_email, notify_email_verified_at,
          notify_email_token_hash, notify_email_token_expires, notify_kinds, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.githubId,
      entry.login,
      entry.name,
      entry.avatarUrl,
      entry.notifyEmail,
      entry.notifyEmailVerifiedAt,
      entry.notifyEmailTokenHash,
      entry.notifyEmailTokenExpires,
      JSON.stringify(entry.notifyKinds),
      entry.createdAt,
      entry.lastLoginAt,
    );
  }

  /** SQLite is primary: rebuild the map, re-validating every row. */
  #loadFromDb() {
    this.accounts = {};
    for (const row of this.db.all('SELECT * FROM stored_accounts ORDER BY github_id')) {
      const entry = normalizeAccountEntry(row.github_id, {
        githubId: row.github_id,
        login: row.login,
        name: row.name,
        avatarUrl: row.avatar_url,
        notifyEmail: row.notify_email,
        notifyEmailVerifiedAt: row.notify_email_verified_at,
        notifyEmailTokenHash: row.notify_email_token_hash,
        notifyEmailTokenExpires: row.notify_email_token_expires,
        notifyKinds: JSON.parse(row.notify_kinds || '{}'),
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
      });
      if (entry) this.accounts[row.github_id] = entry;
    }
  }

  /** Persist the current set: SQLite when present, then the JSON mirror. */
  #persist() {
    if (this.db) {
      this.db.exec('BEGIN');
      try {
        this.db.run('DELETE FROM stored_accounts');
        for (const entry of Object.values(this.accounts)) this.#insertAccount(entry);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`account write failed: ${err.message}`);
      }
    }
    this.#write(this.accounts);
  }

  #read() {
    if (!fs.existsSync(this.path)) return {};
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read accounts ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`accounts ${this.path} is corrupt JSON: ${err.message}`);
    }
    const source = parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object'
      ? parsed.accounts
      : {};
    const accounts = {};
    for (const [githubId, entry] of Object.entries(source)) {
      const normalized = normalizeAccountEntry(githubId, entry);
      if (normalized) accounts[githubId] = normalized;
    }
    return accounts;
  }

  get(githubId) {
    return this.accounts[String(githubId)] || null;
  }

  getByLogin(login) {
    const needle = String(login || '').toLowerCase();
    if (!needle) return null;
    return Object.values(this.accounts).find((entry) => entry.login.toLowerCase() === needle) || null;
  }

  list() {
    return Object.values(this.accounts);
  }

  /**
   * Record a sign-in: refresh the displayed profile, keep `createdAt`.
   *
   * @param {{ id: string, login: string, name?: string, avatarUrl?: string }} profile
   * @returns {object} the stored account
   */
  upsert(profile) {
    const githubId = String(profile && profile.id ? profile.id : '');
    if (!/^\d{1,32}$/.test(githubId)) {
      throw new Error('account profile has no numeric GitHub id');
    }
    const login = clean(profile.login, 64);
    if (!login) throw new Error('account profile has no login');
    const now = new Date().toISOString();
    const existing = this.accounts[githubId];
    const entry = {
      githubId,
      login,
      name: clean(profile.name, 200),
      avatarUrl: clean(profile.avatarUrl, 512),
      notifyEmail: existing ? existing.notifyEmail : '',
      notifyKinds: existing ? existing.notifyKinds : { ...DEFAULT_NOTIFY_KINDS },
      notifyEmailVerifiedAt: existing ? existing.notifyEmailVerifiedAt : '',
      notifyEmailTokenHash: existing ? existing.notifyEmailTokenHash : '',
      notifyEmailTokenExpires: existing ? existing.notifyEmailTokenExpires : '',
      createdAt: existing ? existing.createdAt : now,
      lastLoginAt: now,
    };
    this.accounts = { ...this.accounts, [githubId]: entry };
    this.#persist();
    return entry;
  }

  /**
   * Store (or clear) the notification email; '' disables emails. Changing the
   * address invalidates any earlier verification; re-saving the same address
   * keeps it.
   */
  setNotifyEmail(githubId, email) {
    const id = String(githubId);
    const existing = this.accounts[id];
    if (!existing) throw new Error('account not found');
    const value = normalizeEmail(email);
    const keepVerification = value !== '' && value === existing.notifyEmail;
    const entry = {
      ...existing,
      notifyEmail: value,
      notifyEmailVerifiedAt: keepVerification ? existing.notifyEmailVerifiedAt : '',
      notifyEmailTokenHash: keepVerification ? existing.notifyEmailTokenHash : '',
      notifyEmailTokenExpires: keepVerification ? existing.notifyEmailTokenExpires : '',
    };
    this.accounts = { ...this.accounts, [id]: entry };
    this.#persist();
    return value;
  }

  /**
   * Ensure a confirmation token exists for the stored address. The raw token
   * is returned only when this call created it (only its SHA-256 is stored),
   * so callers enqueue a confirmation email exactly once per token.
   *
   * @returns {{ token: string, expiresAt: string, created: boolean,
   *             reason: 'created'|'pending'|'verified'|'no-email' }}
   */
  ensureEmailVerification(githubId, { now = new Date(), ttlMs = EMAIL_VERIFICATION_TTL_MS } = {}) {
    const id = String(githubId);
    const existing = this.accounts[id];
    if (!existing) throw new Error('account not found');
    if (!existing.notifyEmail) return { token: '', expiresAt: '', created: false, reason: 'no-email' };
    if (existing.notifyEmailVerifiedAt) {
      return { token: '', expiresAt: existing.notifyEmailVerifiedAt, created: false, reason: 'verified' };
    }
    if (
      existing.notifyEmailTokenHash
      && existing.notifyEmailTokenExpires
      && existing.notifyEmailTokenExpires > now.toISOString()
    ) {
      return { token: '', expiresAt: existing.notifyEmailTokenExpires, created: false, reason: 'pending' };
    }
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const entry = { ...existing, notifyEmailTokenHash: hashToken(token), notifyEmailTokenExpires: expiresAt };
    this.accounts = { ...this.accounts, [id]: entry };
    this.#persist();
    return { token, expiresAt, created: true, reason: 'created' };
  }

  /**
   * Complete verification with the raw token from the confirmation link.
   *
   * @returns {'verified'|'invalid'|'expired'}
   */
  verifyEmail(githubId, token, { now = new Date() } = {}) {
    const id = String(githubId);
    const existing = this.accounts[id];
    if (!existing) throw new Error('account not found');
    if (!existing.notifyEmailTokenHash) return 'invalid';
    const expected = Buffer.from(existing.notifyEmailTokenHash, 'hex');
    const actual = Buffer.from(hashToken(token || ''), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return 'invalid';
    if (!existing.notifyEmailTokenExpires || existing.notifyEmailTokenExpires <= now.toISOString()) {
      const entry = { ...existing, notifyEmailTokenHash: '', notifyEmailTokenExpires: '' };
      this.accounts = { ...this.accounts, [id]: entry };
    this.#persist();
      return 'expired';
    }
    const entry = {
      ...existing,
      notifyEmailVerifiedAt: now.toISOString(),
      notifyEmailTokenHash: '',
      notifyEmailTokenExpires: '',
    };
    this.accounts = { ...this.accounts, [id]: entry };
    this.#persist();
    return 'verified';
  }

  /** True when the stored address may receive notification email (D7 gate). */
  isEmailVerified(githubId) {
    const existing = this.accounts[String(githubId)];
    return Boolean(existing && existing.notifyEmail && existing.notifyEmailVerifiedAt);
  }

  /**
   * Store per-kind notification preferences. Only the structured kinds are
   * read (allowlist); everything else the account posts is ignored.
   *
   * @param {string} githubId
   * @param {{ claim?: boolean, report?: boolean, review?: boolean }} kinds
   */
  setNotifyKinds(githubId, kinds) {
    const id = String(githubId);
    const existing = this.accounts[id];
    if (!existing) throw new Error('account not found');
    const value = normalizeNotifyKinds(kinds);
    const entry = { ...existing, notifyKinds: value };
    this.accounts = { ...this.accounts, [id]: entry };
    this.#persist();
    return value;
  }

  #write(next) {
    const serialized = JSON.stringify({
      version: ACCOUNTS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      accounts: next,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`accounts file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
  }
}

module.exports = {
  AccountStore,
  ACCOUNTS_SCHEMA_VERSION,
  MAX_ACCOUNTS_BYTES,
  EMAIL_VERIFICATION_TTL_MS,
  NOTIFY_KINDS,
  DEFAULT_NOTIFY_KINDS,
  normalizeNotifyKinds,
};
