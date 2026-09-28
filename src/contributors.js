// XIOM Package Registry -- contributor profiles and the Sponsors badge.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A4: a public contributor profile per account, an opt-in
// GitHub Sponsors badge backed by the cached answer from GitHub's public
// `hasSponsorsListing` GraphQL field, and a top-contributors board whose
// ranking is bounded per category so raw volume never wins. The registry
// handles no money and stores no payment data: the badge links out, and
// affiliation is never implied.
//
// The Sponsors check needs a server-side GitHub token (`GITHUB_SPONSORS_TOKEN`)
// with plain public read access. Without it the feature degrades cleanly:
// opt-in is recorded, the badge simply stays unverified, and the UI says so.

'use strict';

const { deriveMaintainers } = require('./ownership');

const SPONSOR_STATE_VALUES = new Set(['', 'sponsor', 'not']);
const SPONSOR_GRAPHQL = 'query ($login: String!) { user(login: $login) { hasSponsorsListing } }';
const SPONSOR_CHECK_TIMEOUT_MS = 4000;

/**
 * Caps and weights for the top-contributors score. Caps make the ranking
 * resistant to volume farming: the 400th rating adds nothing, and reviewer
 * decisions cannot outrank a sustained mix of reviews, replies, and
 * maintainership. Weights state the registry's priorities: written reviews
 * and maintainer replies inform users most.
 */
const CONTRIBUTOR_CAPS = Object.freeze({
  reviews: 10,
  ratings: 20,
  replies: 10,
  decisions: 20,
  packages: 5,
});
const CONTRIBUTOR_WEIGHTS = Object.freeze({
  reviews: 3,
  ratings: 1,
  replies: 2,
  decisions: 1,
  packages: 2,
});
const CONTRIBUTORS_LIMIT = 20;

function cappedCount(value, cap) {
  const number = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0;
  return Math.min(Math.max(0, number), cap);
}

/**
 * Bounded, weighted contribution score (A4). Pure.
 *
 * @param {{ reviews?: number, ratings?: number, replies?: number,
 *           decisions?: number, packages?: number }} counts
 */
function contributorScore(counts = {}) {
  return cappedCount(counts.reviews, CONTRIBUTOR_CAPS.reviews) * CONTRIBUTOR_WEIGHTS.reviews
    + cappedCount(counts.ratings, CONTRIBUTOR_CAPS.ratings) * CONTRIBUTOR_WEIGHTS.ratings
    + cappedCount(counts.replies, CONTRIBUTOR_CAPS.replies) * CONTRIBUTOR_WEIGHTS.replies
    + cappedCount(counts.decisions, CONTRIBUTOR_CAPS.decisions) * CONTRIBUTOR_WEIGHTS.decisions
    + cappedCount(counts.packages, CONTRIBUTOR_CAPS.packages) * CONTRIBUTOR_WEIGHTS.packages;
}

/**
 * Packages each login is publicly listed for, keyed by lowercased login:
 * provenance repository owners, approved trusted-publisher requesters, and
 * verified claims. Pending and rejected claims do not count (the maintainer
 * rules on the package page say the same). Pure.
 *
 * @returns {Map<string, number>}
 */
function maintainerCounts(index, { requests = [], publishers = [], claims = [] } = {}) {
  const counts = new Map();
  const packages = (index && index.packages) || {};
  for (const [name, pkg] of Object.entries(packages)) {
    const logins = new Set(
      deriveMaintainers(name, pkg, { requests, publishers }).map((entry) => entry.login.toLowerCase()),
    );
    for (const claim of claims) {
      if (!claim || claim.package !== name || claim.status !== 'verified') continue;
      const login = String(claim.login || '').toLowerCase();
      if (login) logins.add(login);
    }
    for (const login of logins) counts.set(login, (counts.get(login) || 0) + 1);
  }
  return counts;
}

/**
 * Ask GitHub whether `login` has a public Sponsors listing. Any failure
 * (no token, timeout, HTTP error, GraphQL error) answers 'unknown' so a
 * flaky upstream never flips a cached badge or crashes a request.
 *
 * @returns {Promise<'sponsor'|'not'|'unknown'>}
 */
async function checkSponsorListing({
  login,
  token,
  apiUrl = 'https://api.github.com/graphql',
  fetchImpl = null,
  timeoutMs = SPONSOR_CHECK_TIMEOUT_MS,
}) {
  const name = String(login || '').trim();
  if (!name || !token) return 'unknown';
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(String(apiUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'xiom-registry',
      },
      body: JSON.stringify({ query: SPONSOR_GRAPHQL, variables: { login: name } }),
      signal: controller.signal,
    });
    if (!response.ok) return 'unknown';
    const body = await response.json();
    const value = body && body.data && body.data.user ? body.data.user.hasSponsorsListing : undefined;
    if (value === true) return 'sponsor';
    if (value === false) return 'not';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opt-in state of the Sponsors badge, on the platform database. One row per
 * account, created on first opt-in; the cached `state` is refreshed on
 * demand and never rendered for accounts that opted out.
 */
class ContributorStore {
  /** @param {{ db: import('./db').Database }} options */
  constructor({ db }) {
    this.db = db;
  }

  /** @returns {{ optedIn: boolean, state: string, checkedAt: string }} */
  sponsorOf(githubId) {
    const row = this.db.get(
      'SELECT opted_in, state, checked_at FROM contributor_sponsors WHERE github_id = ?',
      String(githubId),
    );
    if (!row) return { optedIn: false, state: '', checkedAt: '' };
    return {
      optedIn: Number(row.opted_in) === 1,
      state: SPONSOR_STATE_VALUES.has(row.state) ? row.state : '',
      checkedAt: row.checked_at || '',
    };
  }

  /**
   * Turn the badge on or off. Opting out clears the cached check (an account
   * that leaves should not keep an affiliation answer on disk); opting in
   * starts a fresh check.
   */
  setSponsorOptIn(githubId, login, optedIn) {
    const id = String(githubId);
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO contributor_sponsors (github_id, login, opted_in, state, checked_at, updated_at)
       VALUES (?, ?, ?, '', '', ?)
       ON CONFLICT(github_id) DO UPDATE SET
         login = excluded.login,
         opted_in = excluded.opted_in,
         state = '',
         checked_at = '',
         updated_at = excluded.updated_at`,
      id,
      String(login),
      optedIn ? 1 : 0,
      now,
    );
    return this.sponsorOf(id);
  }

  /** Cache one check answer; only known states ('sponsor'/'not') are stored. */
  recordSponsorCheck(githubId, state, { at = new Date().toISOString() } = {}) {
    if (state !== 'sponsor' && state !== 'not') return this.sponsorOf(githubId);
    const id = String(githubId);
    this.db.run(
      'UPDATE contributor_sponsors SET state = ?, checked_at = ?, updated_at = ? WHERE github_id = ?',
      state,
      at,
      at,
      id,
    );
    return this.sponsorOf(id);
  }
}

module.exports = {
  ContributorStore,
  checkSponsorListing,
  contributorScore,
  maintainerCounts,
  CONTRIBUTOR_CAPS,
  CONTRIBUTOR_WEIGHTS,
  CONTRIBUTORS_LIMIT,
  SPONSOR_CHECK_TIMEOUT_MS,
};
