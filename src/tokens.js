// XIOM Package Registry -- authentication (Bearer tokens + legacy x-api-key).
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const crypto = require('crypto');

const { UnauthorizedError, ForbiddenError } = require('./errors');

/**
 * Constant-time string comparison.
 *
 * The inputs are compared at their exact length: unequal lengths return
 * false immediately (which leaks nothing usable -- token length is not
 * secret; the entropy is). Equal-length comparisons use a zero-padded
 * buffer so every candidate token is compared in constant time and the
 * comparison never short-circuits on a matching prefix.
 *
 * Deliberately NOT a password hash: nothing is stored or derived here, the
 * tokens live in the operator's config file, and hashing comparison inputs
 * would only add a preimage step without changing the security argument.
 */
function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a), 'utf-8');
  const bufferB = Buffer.from(String(b), 'utf-8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
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
    // No regex: split on horizontal whitespace so there is no backtracking
    // surface, and compare the scheme case-insensitively.
    const trimmed = header.trim();
    const separator = trimmed.search(/[ \t]/);
    if (separator > 0) {
      const scheme = trimmed.slice(0, separator);
      const value = trimmed.slice(separator).trim();
      if (value && scheme.toLowerCase() === 'bearer') {
        return { token: value, source: 'bearer' };
      }
    }
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
 * Scope check: a token may publish `name` when it has the wildcard scope, a
 * scope equal to the name, or a namespace scope. `xiom` and `xiom.*` both
 * grant `xiom.core`; `xiom.corex` is never granted by the `xiom.core` scope
 * (the prefix must end on a dot boundary).
 */
function tokenMayPublish(token, name) {
  return token.scopes.some((scope) => {
    if (scope === '*') return true;
    if (name === scope) return true;
    // Normalize `ns.*` to the `ns` prefix form.
    const namespace = scope.endsWith('.*') ? scope.slice(0, -2) : scope;
    return name.startsWith(`${namespace}.`);
  });
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
