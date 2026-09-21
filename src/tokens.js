// XIOM Package Registry -- authentication (Bearer tokens + legacy x-api-key).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const crypto = require('crypto');

const { UnauthorizedError, ForbiddenError } = require('./errors');
const { verifyJwt, looksLikeJwt } = require('./oidc');
const { matchPublisher } = require('./publishers');

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
 * Provenance recorded per version for an OIDC publish. Only fields that are
 * safe to serve publicly; the JWT itself is never stored or logged.
 */
function publisherProvenance(payload, publisher) {
  const provenance = {
    repository: String(payload.repository),
    workflow: publisher.workflow,
    ref: String(payload.ref),
    event: String(payload.event_name),
  };
  if (typeof payload.workflow_ref === 'string' && payload.workflow_ref) {
    provenance.workflowRef = payload.workflow_ref;
  }
  if (typeof payload.sha === 'string' && payload.sha) provenance.commit = payload.sha;
  if (payload.run_id !== undefined && payload.run_id !== null) {
    provenance.runId = String(payload.run_id);
    provenance.runUrl = `https://github.com/${payload.repository}/actions/runs/${provenance.runId}`;
  }
  return provenance;
}

/**
 * Authenticate a request into the token shape used by the publish pipeline.
 *
 * A three-segment bearer value whose header looks like a JWT takes the
 * GitHub OIDC path: verify signature and standard claims (401 on any
 * failure), then map repository/workflow/ref claims to a trusted publisher
 * (403 when no entry matches -- a valid token without a mapping must never
 * publish). Everything else is a static token compared in constant time,
 * exactly as before.
 *
 * @returns {Promise<{ label: string, scopes: string[], trusted: boolean,
 *                     firstParty: boolean, source: string, publisher?: object }>}
 */
async function authenticate(req, tokens, { publishers = [], audience, jwks } = {}) {
  const presented = extractToken(req);
  if (!presented) {
    throw new UnauthorizedError('no bearer token provided; set XIOM_REGISTRY_TOKEN');
  }

  if (looksLikeJwt(presented.token)) {
    if (!jwks || typeof jwks.getKey !== 'function'
      || typeof audience !== 'string' || audience === '') {
      throw new UnauthorizedError(
        'OIDC publishing is not configured on this registry',
        'oidc_not_configured',
      );
    }
    const { payload } = await verifyJwt(presented.token, { jwks, audience });
    const publisher = matchPublisher(publishers, {
      repository: payload.repository,
      workflowRef: payload.workflow_ref,
      ref: payload.ref,
      event: payload.event_name,
    });
    if (!publisher) {
      const repository = typeof payload.repository === 'string' ? payload.repository : 'unknown repository';
      throw new ForbiddenError(
        `OIDC token from "${repository}" is not a configured trusted publisher`,
        'publisher_not_mapped',
      );
    }
    return {
      label: publisher.label,
      scopes: [...publisher.scopes],
      trusted: true,
      firstParty: publisher.firstParty,
      source: presented.source,
      publisher: publisherProvenance(payload, publisher),
    };
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
function requireAuth(tokens, options) {
  return async (req, _res, next) => {
    try {
      req.token = await authenticate(req, tokens, options);
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
