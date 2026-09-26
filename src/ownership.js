// XIOM Package Registry -- package ownership claims (registry 2.1, SESSION 21 A1).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Maintainer identity for display only. Nothing here grants publish power:
// scopes still come from tokens or OIDC entries and are enforced elsewhere.
// Two things are shown on a package page:
//   1. DERIVED maintainers -- repository owners from published-version
//      provenance, plus requesters/owners of approved trusted-publisher
//      entries and fulfilled token requests whose scopes cover the package.
//      These need no storage; the index and the request queue are the record.
//   2. CLAIMED maintainers -- a signed-in account can claim a package it
//      maintains; a reviewer verifies or rejects it. Claims are stored here
//      with a full history (the audit), and only verified claims are public.
// The index protocol is untouched: ownership is overlay data like reviews.

'use strict';

const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { tokenMayPublish } = require('./tokens');

const OWNERSHIP_SCHEMA_VERSION = '1.0.0';
const MAX_OWNERSHIP_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 500;
const CLAIM_STATUSES = new Set(['pending', 'verified', 'rejected']);
const SAFE_PACKAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** Display order strongest first: provenance outranks a claim, etc. */
const SOURCE_RANK = { provenance: 0, 'trusted-publisher': 1, token: 2, 'verified-claim': 3 };

function clean(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : '';
}

function normalizeUser(user) {
  const githubId = String(user && user.githubId ? user.githubId : '');
  const login = clean(user && user.login, 64);
  if (!/^\d{1,32}$/.test(githubId) || !login) {
    throw new BadRequestError('a signed-in GitHub account is required', 'invalid_claimant');
  }
  return { githubId, login };
}

/**
 * Maintainers derivable from data the registry already holds. Pure function.
 *
 * @param {string} packageName
 * @param {object} pkg index entry (versions with optional `publisher` provenance)
 * @param {{ requests?: object[], publishers?: object[] }} sources
 * @returns {Array<{ login: string, sources: string[], repositories: string[], since: string }>}
 */
function deriveMaintainers(packageName, pkg, { requests = [], publishers = [] } = {}) {
  const name = String(packageName).toLowerCase();
  const byLogin = new Map();
  const add = (login, source, { repository = '', at = '' } = {}) => {
    const value = clean(login, 64);
    if (!value) return;
    const key = value.toLowerCase();
    const entry = byLogin.get(key) || { login: value, sources: [], repositories: [], since: '' };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    if (repository && !entry.repositories.includes(repository)) entry.repositories.push(repository);
    if (at && (entry.since === '' || at < entry.since)) entry.since = at;
    byLogin.set(key, entry);
  };

  // 1. Published-version provenance: the repository that produced the build.
  for (const version of Object.values((pkg && pkg.versions) || {})) {
    const publisher = version && version.publisher;
    const repository = publisher && typeof publisher.repository === 'string' ? publisher.repository : '';
    const owner = repository.split('/')[0];
    if (owner) add(owner, 'provenance', { repository, at: version.published });
  }

  // 2. Approved trusted-publisher entries scoped to this package: the repo
  // owner and the requester an admin approved.
  for (const entry of publishers) {
    if (!entry || !tokenMayPublish({ scopes: entry.scopes || [] }, name)) continue;
    const repository = typeof entry.repository === 'string' ? entry.repository : '';
    const owner = repository.split('/')[0];
    const request = requests.find((record) => record && record.id === entry.requestId);
    const requester = request && request.requester ? request.requester.login : '';
    if (owner) add(owner, 'trusted-publisher', { repository, at: entry.approvedAt });
    if (requester && requester.toLowerCase() !== owner.toLowerCase()) {
      add(requester, 'trusted-publisher', { repository, at: entry.approvedAt });
    }
  }

  // 3. Fulfilled token requests scoped to this package. Self-asserted at
  // request time, but a maintainer approved and delivered the token.
  for (const record of requests) {
    if (!record || record.kind !== 'token') continue;
    if (record.status !== 'approved' && record.status !== 'fulfilled') continue;
    if (!tokenMayPublish({ scopes: record.scopes || [] }, name)) continue;
    add(record.requester && record.requester.login, 'token', {
      at: record.decidedAt || record.createdAt,
    });
  }

  return [...byLogin.values()].sort((a, b) => {
    const rank = Math.min(...a.sources.map((source) => SOURCE_RANK[source] ?? 9))
      - Math.min(...b.sources.map((source) => SOURCE_RANK[source] ?? 9));
    return rank !== 0 ? rank : a.login.localeCompare(b.login);
  });
}

/**
 * Merge derived maintainers with stored claims for one package page.
 * Only verified claims are public; pending claims are visible to the claimant
 * and to reviewers.
 *
 * @param {{ packageName: string, pkg: object, requests?: object[], publishers?: object[],
 *           claims?: object, viewer?: object|null, reviewer?: boolean }} input
 */
function maintainerView({ packageName, pkg, requests = [], publishers = [], claims = {}, viewer = null, reviewer = false }) {
  const derived = deriveMaintainers(packageName, pkg, { requests, publishers });
  const byLogin = new Map(derived.map((entry) => [entry.login.toLowerCase(), { ...entry, claim: null }]));
  const pending = [];
  const rejected = [];
  let viewerClaim = null;

  for (const claim of Object.values(claims)) {
    if (!claim || !CLAIM_STATUSES.has(claim.status)) continue;
    if (viewer && claim.githubId === viewer.githubId) viewerClaim = claim;
    if (claim.status === 'verified') {
      const key = claim.login.toLowerCase();
      const entry = byLogin.get(key) || { login: claim.login, sources: [], repositories: [], since: '' };
      if (!entry.sources.includes('verified-claim')) entry.sources.push('verified-claim');
      entry.claim = claim;
      byLogin.set(key, entry);
    } else if (claim.status === 'pending') {
      pending.push(claim);
    } else if (claim.status === 'rejected') {
      rejected.push(claim);
    }
  }

  const maintainers = [...byLogin.values()].sort((a, b) => {
    // Provenance and approved publishers lead; verified claims follow.
    const rank = (entry) => Math.min(...entry.sources.map((source) => SOURCE_RANK[source] ?? 9));
    return rank(a) - rank(b) || a.login.localeCompare(b.login);
  });

  const liveClaim = Boolean(viewerClaim) && viewerClaim.status !== 'rejected';
  return {
    maintainers,
    // Reviewers see every pending claim; others only their own.
    pending: reviewer ? pending : pending.filter((claim) => viewer && claim.githubId === viewer.githubId),
    // Rejected claims are private to the claimant and reviewers (the note is
    // usually for them, not for the public page).
    rejected: rejected.filter((claim) => reviewer || (viewer && claim.githubId === viewer.githubId)),
    viewerClaim,
    signedIn: Boolean(viewer),
    // A live (pending/verified) claim blocks another; a rejection may be
    // appealed by filing again, and derived maintainers have no form.
    canClaim: Boolean(viewer) && !liveClaim && !maintainers
      .some((entry) => entry.login.toLowerCase() === String(viewer.login).toLowerCase()),
  };
}

/**
 * JSON-file ownership claim store on the registry data volume.
 */
class OwnershipStore {
  /**
   * @param {{ path: string, maxBytes?: number }} options
   */
  constructor({ path, maxBytes = MAX_OWNERSHIP_BYTES }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.claims = this.#read();
  }

  #read() {
    if (!fs.existsSync(this.path)) return {};
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read ownership ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`ownership ${this.path} is corrupt JSON: ${err.message}`);
    }
    const source = parsed && typeof parsed === 'object' && parsed.claims && typeof parsed.claims === 'object'
      ? parsed.claims
      : {};
    const claims = {};
    for (const [name, entries] of Object.entries(source)) {
      if (!SAFE_PACKAGE_NAME.test(name) || !entries || typeof entries !== 'object') continue;
      const byUser = {};
      for (const [githubId, entry] of Object.entries(entries)) {
        const claim = normalizeClaim(githubId, entry);
        if (claim) byUser[githubId] = claim;
      }
      if (Object.keys(byUser).length > 0) claims[name] = byUser;
    }
    return claims;
  }

  /** Every claim for one package, keyed by githubId. */
  claimsFor(packageName) {
    return this.claims[String(packageName).toLowerCase()] || {};
  }

  claimFor(packageName, githubId) {
    return this.claimsFor(packageName)[String(githubId)] || null;
  }

  /** All claims, newest first; optionally filtered. */
  listClaims({ status = '', packageName = '' } = {}) {
    const all = [];
    for (const [name, entries] of Object.entries(this.claims)) {
      for (const claim of Object.values(entries)) {
        if (status && claim.status !== status) continue;
        if (packageName && name !== String(packageName).toLowerCase()) continue;
        all.push({ package: name, ...claim });
      }
    }
    return all.sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));
  }

  pendingCount() {
    return this.listClaims({ status: 'pending' }).length;
  }

  /**
   * File a maintainer claim for the signed-in account. One live claim per
   * account per package; a rejected claim may be filed again (history keeps
   * the trail). Never grants publish power.
   *
   * @param {string} packageName
   * @param {{ user: { githubId: string, login: string } }} input
   */
  claim(packageName, { user }) {
    const name = clean(packageName, 128).toLowerCase();
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new BadRequestError(`"${packageName}" is not a package name`, 'invalid_package_name');
    }
    const author = normalizeUser(user);
    const claims = this.claimsFor(name);
    const existing = claims[author.githubId];
    if (existing && existing.status !== 'rejected') {
      throw new ConflictError(
        'you already have a maintainer claim for this package',
        'claim_exists',
      );
    }
    const now = new Date().toISOString();
    const history = [
      ...(existing ? existing.history : []),
      { at: now, actor: author.login, action: 'claimed' },
    ];
    const record = {
      githubId: author.githubId,
      login: author.login,
      status: 'pending',
      claimedAt: now,
      history,
    };
    this.#commit({
      ...this.claims,
      [name]: { ...claims, [author.githubId]: record },
    });
    return record;
  }

  /**
   * Reviewer decision on a pending claim. Rejection requires a reason.
   *
   * @param {string} packageName
   * @param {string} githubId
   * @param {{ actor: string, status: 'verified'|'rejected', note?: string }} input
   */
  decide(packageName, githubId, { actor, status, note = '' }) {
    const name = clean(packageName, 128).toLowerCase();
    const claims = this.claimsFor(name);
    const target = claims[String(githubId)];
    if (!target) {
      throw new NotFoundError('maintainer claim not found', 'claim_not_found');
    }
    if (target.status !== 'pending') {
      throw new ConflictError(`claim is already ${target.status}`, 'claim_not_pending');
    }
    if (status !== 'verified' && status !== 'rejected') {
      throw new BadRequestError('status must be "verified" or "rejected"', 'invalid_claim_status');
    }
    const decisionNote = clean(note, MAX_NOTE);
    if (status === 'rejected' && !decisionNote) {
      throw new BadRequestError('a reason is required when rejecting a claim', 'claim_reason_required');
    }
    const now = new Date().toISOString();
    const updated = {
      ...target,
      status,
      decidedBy: clean(actor, 64),
      decidedAt: now,
      ...(decisionNote ? { note: decisionNote } : {}),
      history: [
        ...target.history,
        { at: now, actor: clean(actor, 64), action: status, ...(decisionNote ? { note: decisionNote } : {}) },
      ],
    };
    this.#commit({
      ...this.claims,
      [name]: { ...claims, [String(githubId)]: updated },
    });
    return updated;
  }

  #commit(nextClaims) {
    const serialized = JSON.stringify({
      version: OWNERSHIP_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      claims: nextClaims,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`ownership file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.claims = nextClaims;
  }
}

/** Allowlist-normalize one on-disk claim; malformed entries are dropped. */
function normalizeClaim(githubId, entry) {
  if (!/^\d{1,32}$/.test(githubId) || !entry || typeof entry !== 'object') return null;
  const login = clean(entry.login, 64);
  if (!login || !CLAIM_STATUSES.has(entry.status)) return null;
  const history = Array.isArray(entry.history)
    ? entry.history
      .filter((item) => item && typeof item === 'object' && typeof item.action === 'string')
      .map((item) => ({
        at: clean(item.at, 40),
        actor: clean(item.actor, 64),
        action: clean(item.action, 32),
        ...(clean(item.note, MAX_NOTE) ? { note: clean(item.note, MAX_NOTE) } : {}),
      }))
    : [];
  const claim = {
    githubId,
    login,
    status: entry.status,
    claimedAt: clean(entry.claimedAt, 40),
    history,
  };
  for (const field of ['decidedBy', 'decidedAt', 'note']) {
    const value = clean(entry[field], field === 'note' ? MAX_NOTE : 64);
    if (value) claim[field] = value;
  }
  return claim;
}

module.exports = {
  OwnershipStore,
  OWNERSHIP_SCHEMA_VERSION,
  MAX_OWNERSHIP_BYTES,
  MAX_NOTE,
  CLAIM_STATUSES,
  SOURCE_RANK,
  deriveMaintainers,
  maintainerView,
  normalizeClaim,
};
