// XIOM Package Registry -- GitHub Actions OIDC token verification.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const crypto = require('crypto');

const { UnauthorizedError } = require('./errors');

/**
 * GitHub's OIDC provider. The issuer and JWKS URL are constants: accepting a
 * configurable issuer would let a misconfiguration point verification at an
 * attacker-controlled provider, and GitHub never changes these values.
 */
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';

const SUPPORTED_ALG = 'RS256';
const MAX_SEGMENT_CHARS = 8192;
const MAX_JWKS_BYTES = 1024 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** @throws {UnauthorizedError} with a stable code, never echoing the token. */
function invalid(message, code = 'invalid_oidc_token') {
  return new UnauthorizedError(message, code);
}

/**
 * Split and decode a JWT without verifying it. Used only as the first step of
 * verification; callers must never trust the returned payload on its own.
 *
 * @param {string} token
 * @returns {{ header: object, payload: object, signingInput: string, signature: Buffer }}
 */
function splitJwt(token) {
  if (typeof token !== 'string') throw invalid('OIDC token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw invalid('OIDC token must have three dot-separated segments');
  }
  for (const part of parts) {
    if (part.length > MAX_SEGMENT_CHARS || !BASE64URL.test(part)) {
      throw invalid('OIDC token has a malformed segment');
    }
  }

  const decode = (segment, what) => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
    } catch {
      throw invalid(`OIDC token ${what} is not valid base64url JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalid(`OIDC token ${what} is not a JSON object`);
    }
    return parsed;
  };

  return {
    header: decode(parts[0], 'header'),
    payload: decode(parts[1], 'payload'),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

/**
 * The algorithm is pinned: a token that claims anything else (`none`, HS256,
 * ...) is rejected before any key is fetched or considered, which closes the
 * classic algorithm-confusion path and avoids network I/O for junk tokens.
 */
function assertSupportedAlg(header) {
  if (header.alg !== SUPPORTED_ALG) {
    throw invalid(
      `OIDC token alg "${String(header.alg)}" is not supported; expected ${SUPPORTED_ALG}`,
      'unsupported_oidc_alg',
    );
  }
}

/**
 * RS256 signature check with Node crypto only.
 *
 * @param {{ signingInput: string, signature: Buffer, header: object, jwk: object }} input
 * @returns {boolean} true when the signature verifies; false when it does not
 */
function verifySignature({ signingInput, signature, header, jwk }) {
  assertSupportedAlg(header);
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw invalid('JWKS entry is not a usable RSA public key', 'unknown_oidc_key');
  }
  try {
    return crypto.verify('sha256', Buffer.from(signingInput, 'utf-8'), key, signature);
  } catch {
    return false;
  }
}

/** JWT `aud` may be a single string or an array of strings. */
function audienceMatches(audience, expected) {
  if (Array.isArray(audience)) return audience.includes(expected);
  return audience === expected;
}

/**
 * Validate the standard time and identity claims. Repository/workflow/ref
 * matching lives in publishers.js: this function only decides whether the
 * token itself is well-formed, current, and issued for this registry.
 *
 * @param {object} payload decoded JWT payload
 * @param {{ audience: string, now?: number, skewSeconds?: number }} options
 * @throws {UnauthorizedError} on any mismatch or missing claim
 */
function validateClaims(payload, { audience, now = Date.now(), skewSeconds = 60 }) {
  if (payload.iss !== GITHUB_OIDC_ISSUER) {
    throw invalid('OIDC token was not issued by GitHub Actions', 'oidc_issuer_mismatch');
  }
  if (!audienceMatches(payload.aud, audience)) {
    throw invalid(
      `OIDC token audience does not match "${audience}"`,
      'oidc_audience_mismatch',
    );
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw invalid('OIDC token has no expiry', 'oidc_token_expired');
  }
  const nowMs = now;
  const skewMs = skewSeconds * 1000;
  if (nowMs > payload.exp * 1000 + skewMs) {
    throw invalid('OIDC token has expired', 'oidc_token_expired');
  }
  if (typeof payload.nbf === 'number' && Number.isFinite(payload.nbf)
    && nowMs < payload.nbf * 1000 - skewMs) {
    throw invalid('OIDC token is not valid yet', 'oidc_token_not_yet_valid');
  }
  return payload;
}

/**
 * In-memory JWKS cache keyed by `kid`, with a TTL and refetch-on-unknown-kid.
 *
 * Fail-closed rules:
 *   - a fetch/parse failure never makes a signature check pass;
 *   - when a refresh fails but the requested kid is already cached, the cached
 *     key is used (GitHub rotated the set, not the key);
 *   - when the kid is unknown and no refresh succeeds, the request fails 401.
 *
 * @param {{
 *   url?: string, fetchFn?: Function, now?: Function,
 *   ttlMs?: number, timeoutMs?: number, maxKeys?: number,
 * }} [options]
 */
function createJwksCache({
  url = GITHUB_OIDC_JWKS_URL,
  fetchFn = globalThis.fetch,
  now = Date.now,
  ttlMs = 60 * 60 * 1000,
  timeoutMs = 5000,
  maxKeys = 32,
} = {}) {
  if (typeof fetchFn !== 'function') {
    throw new Error('createJwksCache needs a fetch implementation');
  }

  /** @type {Map<string, object>} */
  const keys = new Map();
  let fetchedAt = 0;
  let refreshInFlight = null;

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body;
    try {
      const response = await fetchFn(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response || !response.ok) {
        throw new Error(`JWKS fetch failed with status ${response ? response.status : 'none'}`);
      }
      body = await response.json();
    } catch (err) {
      throw invalid(`GitHub JWKS is unavailable: ${err.message}`, 'jwks_unavailable');
    } finally {
      clearTimeout(timer);
    }
    const list = body && Array.isArray(body.keys) ? body.keys : null;
    if (!list) throw invalid('GitHub JWKS response has no keys array', 'jwks_unavailable');

    const next = new Map();
    for (const jwk of list) {
      if (!jwk || typeof jwk !== 'object') continue;
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
      if (next.size >= maxKeys) break;
      next.set(jwk.kid, jwk);
    }
    if (next.size === 0) throw invalid('GitHub JWKS has no RSA keys', 'jwks_unavailable');

    keys.clear();
    for (const [kid, jwk] of next) keys.set(kid, jwk);
    fetchedAt = now();
  }

  async function getKey(kid) {
    if (typeof kid !== 'string' || !kid) {
      throw invalid('OIDC token has no key id (kid)', 'unknown_oidc_key');
    }
    const fresh = keys.has(kid) && now() - fetchedAt < ttlMs;
    if (!fresh) {
      if (!refreshInFlight) {
        refreshInFlight = refresh().finally(() => { refreshInFlight = null; });
      }
      try {
        await refreshInFlight;
      } catch (err) {
        if (keys.has(kid)) return keys.get(kid);
        throw err;
      }
    }
    const jwk = keys.get(kid);
    if (!jwk) throw invalid(`OIDC key "${kid}" is not in GitHub JWKS`, 'unknown_oidc_key');
    return jwk;
  }

  return { getKey, _size: () => keys.size };
}

/**
 * Cheap shape sniff used to route a bearer value to the OIDC path. Static
 * tokens keep working even when they contain dots: a value only counts as a
 * JWT when its first segment decodes to a JSON object with a string `alg`.
 */
function looksLikeJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || part.length > MAX_SEGMENT_CHARS)) {
    return false;
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    return Boolean(header && typeof header === 'object' && !Array.isArray(header)
      && typeof header.alg === 'string');
  } catch {
    return false;
  }
}

/**
 * Verify a GitHub Actions OIDC token end to end: RS256 signature against the
 * JWKS cache, then standard claims (iss, aud, exp/nbf with skew).
 *
 * @returns {Promise<{ header: object, payload: object }>}
 */
async function verifyJwt(token, {
  jwks,
  audience,
  now = Date.now(),
  skewSeconds = 60,
} = {}) {
  if (!jwks || typeof jwks.getKey !== 'function') {
    throw new Error('verifyJwt needs a JWKS cache');
  }
  if (typeof audience !== 'string' || audience.length === 0) {
    throw new Error('verifyJwt needs a pinned audience');
  }
  const { header, payload, signingInput, signature } = splitJwt(token);
  assertSupportedAlg(header);
  const jwk = await jwks.getKey(header.kid);
  if (!verifySignature({ signingInput, signature, header, jwk })) {
    throw invalid('OIDC token signature does not verify', 'oidc_signature_invalid');
  }
  validateClaims(payload, { audience, now, skewSeconds });
  return { header, payload };
}

module.exports = {
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URL,
  SUPPORTED_ALG,
  splitJwt,
  looksLikeJwt,
  verifySignature,
  validateClaims,
  createJwksCache,
  verifyJwt,
};
