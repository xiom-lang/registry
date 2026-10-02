// XIOM Package Registry -- contributor reputation and the Sponsors badge.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A4, revised 2026-10-02 (scoring v2, owner-approved).
//
// Reputation = sustained craft + demonstrated impact, with diminishing
// marginal returns. There is no ceiling: every term is monotonic, so the
// longer someone contributes the higher they rank -- but the marginal value
// of volume collapses fast enough that farming never pays.
//
//   Craft (step-down tiers):
//     written reviews      first 10 x 3, next 40 x 1, beyond x 0.25
//     maintainer replies   first 10 x 2, beyond x 0.5
//     reviewer decisions   first 20 x 1, beyond x 0.25
//     helpful votes recv.  first 20 x 1, beyond x 0.25 (net, floored at 0)
//     bare ratings         0 -- they still show on the package page
//
//   Impact (per package maintained):
//     (avg stars / 5) * log2(1 + distinct raters) * 2
//     Ratings from the package's own maintainers are excluded (self-rings);
//     packages with no ratings contribute nothing, so publishing stubs or
//     spamming the registry earns no reputation.
//
// The registry handles no money and stores no payment data: the Sponsors
// badge links out, and affiliation is never implied.
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
 * Craft tiers: [size, points-per-item] from the newest item outward. The
 * final Infinity row is the tail rate, so points grow without bound.
 */
const CRAFT_TIERS = Object.freeze({
  reviews: Object.freeze([[10, 3], [40, 1], [Number.POSITIVE_INFINITY, 0.25]]),
  replies: Object.freeze([[10, 2], [Number.POSITIVE_INFINITY, 0.5]]),
  decisions: Object.freeze([[20, 1], [Number.POSITIVE_INFINITY, 0.25]]),
  votes: Object.freeze([[20, 1], [Number.POSITIVE_INFINITY, 0.25]]),
});

/** Impact weight for the per-package term (see the formula above). */
const IMPACT_WEIGHT = 2;
const CONTRIBUTORS_LIMIT = 20;

function tieredPoints(count, tiers) {
  let remaining = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  let points = 0;
  for (const [size, weight] of tiers) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, size);
    points += take * weight;
    remaining -= take;
  }
  return Math.round(points * 100) / 100;
}

/**
 * Reputation score (v2). Pure; fractional by design.
 *
 * @param {{ reviews?: number, replies?: number, decisions?: number,
 *           votes?: number, impacts?: number[] }} input
 *        `impacts` holds one `packageImpact()` value per maintained package.
 */
function contributionScore({
  reviews = 0,
  replies = 0,
  decisions = 0,
  votes = 0,
  impacts = [],
} = {}) {
  const impact = (Array.isArray(impacts) ? impacts : [])
    .reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
  return Math.round((
    tieredPoints(reviews, CRAFT_TIERS.reviews)
    + tieredPoints(replies, CRAFT_TIERS.replies)
    + tieredPoints(decisions, CRAFT_TIERS.decisions)
    + tieredPoints(votes, CRAFT_TIERS.votes)
    + impact
  ) * 100) / 100;
}

/**
 * One maintained package's impact: quality (average stars) scaled by how
 * many distinct people cared (log2), so a loved package compounds without a
 * cap while a ring of a few accounts stays cheap and a stub stays at zero.
 * Ratings from the package's own maintainers never count. Pure.
 *
 * @param {Array<{ githubId?: string, login?: string, stars?: number }>} ratings
 * @param {Iterable<string>} maintainerLogins logins of that package's maintainers
 * @returns {number} rounded to 2 decimals
 */
function packageImpact(ratings, maintainerLogins = []) {
  const excluded = new Set([...maintainerLogins].map((login) => String(login).toLowerCase()));
  const byRater = new Map();
  for (const rating of ratings || []) {
    const login = String(rating && rating.login ? rating.login : '').toLowerCase();
    if (!login || excluded.has(login)) continue;
    const key = rating.githubId ? `id:${rating.githubId}` : `login:${login}`;
    // One rating per account per package, so first-seen wins.
    if (!byRater.has(key)) byRater.set(key, Number(rating.stars) || 0);
  }
  if (byRater.size === 0) return 0;
  const total = [...byRater.values()].reduce((sum, stars) => sum + stars, 0);
  const average = total / byRater.size;
  return Math.round((average / 5) * Math.log2(1 + byRater.size) * IMPACT_WEIGHT * 100) / 100;
}

/**
 * Packages each login is publicly listed for, keyed by lowercased login:
 * provenance repository owners, approved trusted-publisher requesters, and
 * verified claims (pending/rejected claims do not count). Pure.
 *
 * @returns {Map<string, Set<string>>}
 */
function maintainerPackages(index, { requests = [], publishers = [], claims = [] } = {}) {
  const map = new Map();
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
    for (const login of logins) {
      if (!map.has(login)) map.set(login, new Set());
      map.get(login).add(name);
    }
  }
  return map;
}

/** Maintained-package counts per login (compat helper around the map). */
function maintainerCounts(index, overlays = {}) {
  return new Map([...maintainerPackages(index, overlays)].map(([login, names]) => [login, names.size]));
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

module.exports = {
  ContributorStore,
  checkSponsorListing,
  contributionScore,
  packageImpact,
  maintainerCounts,
  maintainerPackages,
  tieredPoints,
  CRAFT_TIERS,
  IMPACT_WEIGHT,
  CONTRIBUTORS_LIMIT,
  SPONSOR_CHECK_TIMEOUT_MS,
};
