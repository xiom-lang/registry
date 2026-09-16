// XIOM Package Registry -- authentication (Bearer tokens + legacy x-api-key).
// Copyright 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('crypto');

const { UnauthorizedError, ForbiddenError } = require('./errors');

/**
 * Constant-time string comparison that tolerates length differences
 * (timingSafeEqual throws on unequal lengths; comparing fixed-size digests
 * keeps the timing independent of the secret's length).
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Extract the token from the request. Preference order (SESSION.md 2.4):
 *   1. `Authorization: Bearer <token>` -- what `xiom pkg publish` sends.
 *   2. `x-api-key: <token>` -- legacy compatibility only.
 *   3. `api_key` query parameter -- legacy compatibility only, and only for
 *      GET routes (never accepted for publish).
 */
function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    if (match) return { token: match[1].trim(), source: 'bearer' };
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) {
    return { token: apiKey.trim(), source: 'x-api-key' };
  }
  if (req.method === 'GET' && typeof req.query.api_key === 'string' && req.query.api_key) {
    return { token: req.query.api_key, source: 'query' };
  }
  return null;
}

/**
 * Look up the presented token in the configured token map.
 * @returns {{ label: string, scopes: string[], trusted: boolean, firstParty: boolean }}
 * @throws UnauthorizedError on unknown/missing tokens
 */
function authenticate(req, tokens) {
  const presented = extractToken(req);
  if (!presented) {
    throw new UnauthorizedError('no bearer token provided; set XIOM_REGISTRY_TOKEN');
  }
  if (tokens.size === 0) {
    throw new UnauthorizedError(
      'publishing is disabled on this registry (no tokens configured)',
      'no_tokens_configured',
    );
  }
  // Iterate all entries with constant-time comparison so the lookup does not
  // leak which prefix of a valid token was guessed.
  let found = null;
  for (const [known, meta] of tokens) {
    if (safeEqual(known, presented.token)) {
      found = { ...meta, source: presented.source };
    }
  }
  if (!found) {
    throw new UnauthorizedError('unknown registry token', 'invalid_token');
  }
  return found;
}

/**
 * Scope check: a token may publish `name` when it has the wildcard scope or
 * a scope that equals the package name or is a namespace prefix of it
 * (`xiom` grants `xiom.core`, `xiom-*` style prefixes do NOT match).
 */
function tokenMayPublish(token, name) {
  if (token.scopes.includes('*')) return true;
  return token.scopes.some((scope) => name === scope || name.startsWith(`${scope}.`));
}

/** @throws ForbiddenError */
function assertPublishScope(token, name) {
  if (!tokenMayPublish(token, name)) {
    throw new ForbiddenError(
      `token "${token.label}" is not scoped to publish "${name}"`,
      'scope_denied',
    );
  }
}

/**
 * Express middleware requiring authentication. Attaches `req.token` on
 * success, responds 401/403 via the error handler otherwise.
 */
function requireAuth(tokens) {
  return (req, _res, next) => {
    try {
      req.token = authenticate(req, tokens);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  extractToken,
  authenticate,
  tokenMayPublish,
  assertPublishScope,
  requireAuth,
  safeEqual,
};
