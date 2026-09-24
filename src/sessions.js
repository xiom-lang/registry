// XIOM Package Registry -- browser sessions for registry 2.0 sign-in.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// In-memory session store with signed cookies. Sessions hold a GitHub
// identity and a per-session CSRF token -- never a publish credential. A
// restart logs everyone out, which is the safe default for a single-instance
// service (see SESSION.md section 15).

'use strict';

const crypto = require('crypto');

const { safeEqual } = require('./tokens');

const SESSION_COOKIE = 'xiom_registry_session';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 10_000;
const SWEEP_EVERY = 256;

/** Parse a Cookie header into a Map; malformed pairs are skipped. */
function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string' || header === '') return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    let value = part.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; the MAC check will reject it if it matters.
    }
    cookies.set(name, value);
  }
  return cookies;
}

/** Serialize one Set-Cookie header value. */
function serializeCookie(name, value, { maxAgeSeconds, secure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

class SessionStore {
  /**
   * @param {{ key: Buffer, ttlMs?: number, maxSessions?: number }} options
   *   `key` must be at least 32 bytes (derive it with oauth.deriveSessionKey).
   */
  constructor({ key, ttlMs = DEFAULT_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS }) {
    if (!Buffer.isBuffer(key) || key.length < 32) {
      throw new Error('session key must be a Buffer of at least 32 bytes');
    }
    this.key = key;
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.creates = 0;
  }

  /** Create a session and return its id. Extra fields must be JSON-safe. */
  create(data = {}) {
    if (++this.creates % SWEEP_EVERY === 0) this.#sweep();
    if (this.sessions.size >= this.maxSessions) {
      // Evict the oldest session rather than growing without bound.
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
    const id = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(id, {
      ...data,
      csrf: crypto.randomBytes(32).toString('base64url'),
      createdAt: Date.now(),
      touchedAt: Date.now(),
    });
    return id;
  }

  /** Live session for an id, refreshing its idle deadline; null when absent. */
  get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.touchedAt > this.ttlMs) {
      this.sessions.delete(id);
      return null;
    }
    session.touchedAt = Date.now();
    return session;
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  /** Cookie payload: `<id>.<hmac>`, so a forged id cannot select a session. */
  cookieValue(id) {
    const mac = crypto.createHmac('sha256', this.key).update(id).digest('hex');
    return `${id}.${mac}`;
  }

  /** @returns {{ id: string, session: object } | null} */
  fromCookie(value) {
    if (typeof value !== 'string') return null;
    const separator = value.lastIndexOf('.');
    if (separator <= 0) return null;
    const id = value.slice(0, separator);
    const mac = value.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || !/^[0-9a-f]{64}$/.test(mac)) return null;
    const expected = this.cookieValue(id);
    if (!safeEqual(mac, expected.slice(expected.lastIndexOf('.') + 1))) return null;
    const session = this.get(id);
    if (!session) return null;
    return { id, session };
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(id);
    }
  }
}

module.exports = {
  SESSION_COOKIE,
  DEFAULT_TTL_MS,
  parseCookies,
  serializeCookie,
  SessionStore,
};
