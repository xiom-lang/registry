// XIOM Package Registry -- GitHub identities (registry 2.0 accounts).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Display identity only: an account links a GitHub login to requests and
// review state. It carries no publish credential and no role field -- the
// admin role is recomputed from REGISTRY_ADMIN_LOGINS on every request, so a
// config change takes effect without touching stored data (SESSION.md 15).

'use strict';

const fs = require('fs');

const { atomicWriteFile } = require('./index');

const ACCOUNTS_SCHEMA_VERSION = '1.0.0';
const MAX_ACCOUNTS_BYTES = 2 * 1024 * 1024;

function clean(value, maxLength) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

/**
 * In-memory account map with write-through persistence to accounts.json.
 * Entries are keyed by the numeric GitHub id (stable across renames); the
 * login is refreshed on every sign-in.
 */
class AccountStore {
  /**
   * @param {{ path: string, maxBytes?: number }} options
   */
  constructor({ path, maxBytes = MAX_ACCOUNTS_BYTES }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.accounts = this.#read();
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
      if (!/^\d{1,32}$/.test(githubId) || !entry || typeof entry !== 'object') continue;
      const login = clean(entry.login, 64);
      if (!login) continue;
      accounts[githubId] = {
        githubId,
        login,
        name: clean(entry.name, 200),
        avatarUrl: clean(entry.avatarUrl, 512),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
        lastLoginAt: typeof entry.lastLoginAt === 'string' ? entry.lastLoginAt : '',
      };
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
      createdAt: existing ? existing.createdAt : now,
      lastLoginAt: now,
    };
    this.#commit({ ...this.accounts, [githubId]: entry });
    return entry;
  }

  #commit(next) {
    const serialized = JSON.stringify({
      version: ACCOUNTS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      accounts: next,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`accounts file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.accounts = next;
  }
}

module.exports = { AccountStore, ACCOUNTS_SCHEMA_VERSION, MAX_ACCOUNTS_BYTES };
