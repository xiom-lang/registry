// XIOM Package Registry -- configuration.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const path = require('path');
const fs = require('fs');

const { loadTrustedPublishers } = require('./publishers');
const { isValidPublicKeyHex } = require('./signatures');

const MIB = 1024 * 1024;

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid ${name}: "${raw}" is not a non-negative integer`);
  }
  return value;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * GitHub OAuth configuration for registry 2.0 sign-in (SESSION.md 15).
 *
 * Fail-fast rule: the client id and secret must be set together. A half-set
 * pair (e.g. compose passing an empty secret while the id is present) is a
 * misconfiguration that would silently break the login round-trip, so it must
 * stop startup instead. Both unset = sign-in disabled, which is valid. The
 * admin role is an operator allowlist of GitHub logins (case-insensitive);
 * there is no stored role and no publishing power attached to it.
 */
function loadOAuthConfig() {
  const clientId = typeof process.env.GITHUB_OAUTH_CLIENT_ID === 'string'
    ? process.env.GITHUB_OAUTH_CLIENT_ID.trim()
    : '';
  const clientSecret = typeof process.env.GITHUB_OAUTH_CLIENT_SECRET === 'string'
    ? process.env.GITHUB_OAUTH_CLIENT_SECRET.trim()
    : '';
  const adminLogins = (process.env.REGISTRY_ADMIN_LOGINS || '')
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  const reviewerLogins = (process.env.REGISTRY_REVIEWER_LOGINS || '')
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);

  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must be set together '
      + '(empty secret with a configured client id = broken sign-in); unset both to disable sign-in',
    );
  }
  if (clientId && clientSecret.length < 16) {
    throw new Error('GITHUB_OAUTH_CLIENT_SECRET is too short to be a GitHub client secret');
  }

  return {
    enabled: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    adminLogins,
    reviewerLogins,
    scope: 'read:user',
    // Upstream endpoints; tests point these at a local fake provider.
    authorizeUrl: process.env.GITHUB_OAUTH_AUTHORIZE_URL || '',
    tokenUrl: process.env.GITHUB_OAUTH_TOKEN_URL || '',
    apiUrl: process.env.GITHUB_OAUTH_API_URL || '',
  };
}

/**
 * Load publish tokens.
 *
 * Precedence:
 *   1. TOKENS_FILE -- JSON array of token objects, or
 *      {"tokens": [...]} / {"tokens": {"<token>": {...}}}.
 *   2. API_KEY -- legacy single key, mapped to a first-party, trusted token
 *      so the existing deployments keep working during the T2 migration.
 *   3. Nothing -- the registry is READ-ONLY for publishing (401 on publish).
 *      The old "no key configured = open registry" behavior is gone: a
 *      production registry must never accept anonymous publishes.
 *
 * Token fields: { token, label?, scopes? (array of prefixes; "*" = any),
 *                 trusted?, firstParty?, publicKey? (64 hex; pins trusted
 *                 publishes to that signing key), issuedAt? (informational) }
 */
function loadTokens() {
  const file = process.env.TOKENS_FILE;
  if (file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`TOKENS_FILE ${file} cannot be read: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`TOKENS_FILE ${file} is not valid JSON: ${err.message}`);
    }
    return normalizeTokens(parsed, `TOKENS_FILE ${file}`);
  }

  const apiKey = process.env.API_KEY;
  if (apiKey && apiKey.trim()) {
    return normalizeTokens(
      [{ token: apiKey.trim(), label: 'legacy API_KEY', scopes: ['*'], trusted: true, firstParty: true }],
      'API_KEY',
    );
  }

  return new Map();
}

function normalizeTokens(parsed, source) {
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && Array.isArray(parsed.tokens)) {
    entries = parsed.tokens;
  } else if (parsed && parsed.tokens && typeof parsed.tokens === 'object') {
    entries = Object.entries(parsed.tokens).map(([token, cfg]) => ({ token, ...(cfg || {}) }));
  } else {
    throw new Error(`${source}: expected an array of tokens or {"tokens": ...}`);
  }

  const map = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${source}: token entries must be objects`);
    }
    const token = typeof entry.token === 'string' ? entry.token.trim() : '';
    if (!token) throw new Error(`${source}: a token entry has no "token" string`);
    if (map.has(token)) throw new Error(`${source}: duplicate token entry`);
    const scopes = Array.isArray(entry.scopes) && entry.scopes.length > 0
      ? entry.scopes.map(String)
      : ['*'];
    // A pinned signing key is a security control, so a malformed value must
    // fail startup rather than silently accept every key (or reject every
    // publish with a confusing 422).
    let publicKey = '';
    if (entry.publicKey !== undefined && entry.publicKey !== null && entry.publicKey !== '') {
      publicKey = String(entry.publicKey).trim().toLowerCase();
      if (!isValidPublicKeyHex(publicKey)) {
        throw new Error(`${source}: token entry ${map.size + 1} has an invalid publicKey (expected 64 hex characters)`);
      }
    }
    map.set(token, {
      label: typeof entry.label === 'string' && entry.label ? entry.label : `token-${map.size + 1}`,
      scopes,
      trusted: Boolean(entry.trusted),
      firstParty: Boolean(entry.firstParty),
      ...(publicKey ? { publicKey } : {}),
    });
  }
  return map;
}

function loadConfig() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const packagesDir = process.env.PACKAGES_DIR || path.join(__dirname, '..', 'packages');
  const uploadTmpDir = process.env.UPLOAD_TMP_DIR || path.join(dataDir, 'tmp');

  const maxTarballBytes = intFromEnv('MAX_TARBALL_BYTES', 50 * MIB);
  const maxIndexPackages = intFromEnv('MAX_INDEX_PACKAGES', 10000);
  const maxIndexBytes = intFromEnv('MAX_INDEX_BYTES', 64 * MIB);
  const maxVersionsPerPackage = intFromEnv('MAX_VERSIONS_PER_PACKAGE', 1000);
  const maxManifestBytes = intFromEnv('MAX_MANIFEST_BYTES', MIB);
  const maxDecompressedBytes = intFromEnv('MAX_DECOMPRESSED_BYTES', 512 * MIB);

  // Rate limits: `0` disables the limiter (useful for tests).
  const rateLimitDisabled = boolFromEnv('RATE_LIMIT_DISABLED', false)
    || intFromEnv('RATE_LIMIT_MAX', 300) === 0;

  const config = {
    env: process.env.NODE_ENV || 'development',
    port: intFromEnv('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    trustProxy: boolFromEnv('TRUST_PROXY', false),
    // Base URL advertised in /index.json. The client's RegistryIndex struct
    // requires a root-level `registry` string (no serde default), so this is
    // part of the protocol, not decoration.
    registryUrl: (process.env.REGISTRY_URL || 'https://registry.xiom-lang.org').replace(/\/+$/, ''),
    dataDir,
    packagesDir,
    uploadTmpDir,
    indexPath: path.join(dataDir, 'index.json'),
    // Registry 2.0 identity + request queue (display data only, no secrets).
    accountsPath: process.env.ACCOUNTS_FILE || path.join(dataDir, 'accounts.json'),
    requestsPath: process.env.REQUESTS_FILE || path.join(dataDir, 'requests.json'),
    reviewsPath: process.env.REVIEWS_FILE || path.join(dataDir, 'reviews.json'),
    oauth: loadOAuthConfig(),
    tokens: loadTokens(),
    // GitHub OIDC trusted publishers. Missing file = no publishers (JWTs get
    // 403); malformed config throws here so startup fails loudly.
    publishers: loadTrustedPublishers(),
    // Audience pinned when the registry verifies OIDC tokens. Changing this
    // is a breaking change for every publisher workflow's getIDToken() call.
    oidcAudience: process.env.OIDC_AUDIENCE || 'xiom-registry',
    // JWKS endpoint. Defaults to GitHub; overridable so tests (and a future
    // mirror) can serve a local set without touching the issuer constant.
    oidcJwksUrl: process.env.OIDC_JWKS_URL || undefined,
    maxTarballBytes,
    maxIndexPackages,
    maxIndexBytes,
    maxVersionsPerPackage,
    maxManifestBytes,
    maxDecompressedBytes,
    maxAccountsBytes: intFromEnv('MAX_ACCOUNTS_BYTES', 2 * MIB),
    maxRequestsBytes: intFromEnv('MAX_REQUESTS_BYTES', 4 * MIB),
    maxReviewsBytes: intFromEnv('MAX_REVIEWS_BYTES', 4 * MIB),
    rateLimit: {
      disabled: rateLimitDisabled,
      general: {
        windowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000),
        max: intFromEnv('RATE_LIMIT_MAX', 300),
      },
      publish: {
        windowMs: intFromEnv('PUBLISH_RATE_WINDOW_MS', 60_000),
        max: intFromEnv('PUBLISH_RATE_MAX', 20),
      },
      download: {
        windowMs: intFromEnv('DOWNLOAD_RATE_WINDOW_MS', 60_000),
        max: intFromEnv('DOWNLOAD_RATE_MAX', 600),
      },
    },
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (config.env === 'production' && config.tokens.size === 0) {
    // Not fatal: the registry may intentionally run read-only (e.g. staging
    // index mirror). But fail loudly if someone sets neither tokens nor
    // API_KEY and expects publishes to work.
    console.warn(
      'xiom-registry: no TOKENS_FILE and no API_KEY configured; '
      + 'publishing is disabled (all publish requests will get 401)',
    );
  }
  if ((config.oauth.adminLogins.length > 0 || config.oauth.reviewerLogins.length > 0)
      && !config.oauth.enabled) {
    console.warn(
      'xiom-registry: REGISTRY_ADMIN_LOGINS/REGISTRY_REVIEWER_LOGINS are set but GitHub OAuth '
      + 'is disabled; the approval and review queues will be unreachable (set '
      + 'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET, or unset the login lists)',
    );
  }
  if (config.oauth.enabled && config.oauth.adminLogins.length === 0) {
    console.warn(
      'xiom-registry: GitHub OAuth is enabled but REGISTRY_ADMIN_LOGINS is empty; '
      + 'nobody can approve requests (sign-in still works)',
    );
  }
  if (config.maxTarballBytes <= 0) {
    throw new Error('MAX_TARBALL_BYTES must be > 0');
  }
}

module.exports = { loadConfig };
