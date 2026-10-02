// XIOM Package Registry -- A4 contributor store and scoring tests (v2).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A4 + scoring v2 (2026-10-02): the uncapped, value-weighted
// score, package impact with self-ring exclusion, maintainer maps from the
// index overlay, the public Sponsors check (with a fake fetch), and the
// opt-in cache on the platform database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Database } = require('../src/db');
const {
  ContributorStore,
  checkSponsorListing,
  contributionScore,
  packageImpact,
  maintainerCounts,
  maintainerPackages,
  tieredPoints,
  CRAFT_TIERS,
} = require('../src/contributors');

test('the score is strictly increasing but volume never scales linearly', () => {
  assert.equal(contributionScore({}), 0);

  // Tier boundaries: 10 reviews x3, then 40 x1, then 0.25.
  assert.equal(tieredPoints(10, CRAFT_TIERS.reviews), 30);
  assert.equal(tieredPoints(11, CRAFT_TIERS.reviews), 31);
  assert.equal(tieredPoints(50, CRAFT_TIERS.reviews), 70);
  assert.equal(tieredPoints(51, CRAFT_TIERS.reviews), 70.25);

  // Replies: 10 x2 then 0.5; decisions: 20 x1 then 0.25; votes: 20 x1 then 0.25.
  assert.equal(tieredPoints(12, CRAFT_TIERS.replies), 21);
  assert.equal(tieredPoints(21, CRAFT_TIERS.decisions), 20.25);
  assert.equal(tieredPoints(21, CRAFT_TIERS.votes), 20.25);

  // No ceiling: every extra unit keeps adding something.
  const dedicated = contributionScore({ reviews: 4000, replies: 500, decisions: 500, votes: 500 });
  const veteran = contributionScore({ reviews: 100, replies: 30, decisions: 60, votes: 60 });
  assert.ok(dedicated > veteran, 'a longer contribution history always ranks higher');
  assert.ok(veteran > contributionScore({ reviews: 10, replies: 10, decisions: 20, votes: 20 }));

  // Bare ratings are not a scoring input at all (they stay on package pages).
  assert.equal(contributionScore({ ratings: 999 }), 0);

  // Volume is sublinear: doubling output never doubles points.
  assert.ok(
    tieredPoints(200, CRAFT_TIERS.reviews) < 2 * tieredPoints(100, CRAFT_TIERS.reviews),
  );

  // Garbage is ignored; fractional impacts add exactly.
  assert.equal(contributionScore({ reviews: '2' }), 2 * 3, 'numeric strings count');
  assert.equal(contributionScore({ reviews: -5, votes: 0.9, replies: null }), 0);
  assert.equal(contributionScore({ impacts: [2.5, 3.25, 'x', null] }), 5.75);
});

test('packageImpact rewards quality and reach, and excludes self-rings', () => {
  assert.equal(packageImpact([]), 0, 'no ratings, no impact');
  assert.equal(packageImpact([{ githubId: '1', login: 'fan', stars: 5 }]), 2, 'one 5-star rater = 2 points');

  const ten = Array.from({ length: 10 }, (_, i) => ({ githubId: String(i), login: `fan${i}`, stars: i === 0 ? 3 : 5 }));
  const impact = packageImpact(ten);
  assert.ok(impact > 5.5 && impact < 7, `10 raters at 4.8 avg ~ 6.6 (got ${impact})`);

  // The same account rating twice counts once (one per package anyway).
  assert.equal(
    packageImpact([
      { githubId: '1', login: 'fan', stars: 5 },
      { githubId: '1', login: 'fan', stars: 1 },
    ]),
    packageImpact([{ githubId: '1', login: 'fan', stars: 5 }]),
  );

  // Maintainers' own ratings never count, even if a legacy row exists.
  assert.equal(
    packageImpact(
      [
        { githubId: '9', login: 'owner', stars: 5 },
        { githubId: '1', login: 'fan', stars: 5 },
      ],
      ['owner'],
    ),
    packageImpact([{ githubId: '1', login: 'fan', stars: 5 }]),
  );
  assert.equal(packageImpact([{ githubId: '9', login: 'owner', stars: 5 }], ['OWNER']), 0);

  // Reach is logarithmic: a ring of 20 is worth far less than sqrt-like growth.
  const ring = Array.from({ length: 20 }, (_, i) => ({ githubId: String(100 + i), login: `ring${i}`, stars: 5 }));
  assert.ok(packageImpact(ring) < 10, `20 bought raters stay cheap (got ${packageImpact(ring)})`);
});

test('maintainerPackages maps logins to their live packages', () => {
  const index = {
    packages: {
      'pkg-a': { versions: { '1.0.0': { publisher: { repository: 'Alice/pkg-a' } } } },
      'pkg-b': { versions: { '1.0.0': { publisher: { repository: 'alice/pkg-b' } } } },
      'pkg-c': { versions: {} },
    },
  };
  const map = maintainerPackages(index, {
    claims: [
      { package: 'pkg-c', login: 'Bob', status: 'verified' },
      { package: 'pkg-c', login: 'Eve', status: 'pending' },
    ],
  });
  assert.deepEqual([...map.get('alice')].sort(), ['pkg-a', 'pkg-b']);
  assert.deepEqual([...map.get('bob')], ['pkg-c']);
  assert.equal(map.has('eve'), false, 'pending claims stay private');
});

test('maintainerCounts counts provenance owners and verified claims only', () => {
  const index = {
    packages: {
      'pkg-a': {
        versions: {
          '1.0.0': { published: '2026-01-01T00:00:00Z', publisher: { repository: 'Alice/pkg-a' } },
        },
      },
      'pkg-b': {
        versions: {
          '1.0.0': { published: '2026-02-01T00:00:00Z', publisher: { repository: 'alice/pkg-b' } },
        },
      },
      'pkg-c': { versions: {} },
    },
  };
  const counts = maintainerCounts(index, {
    claims: [
      { package: 'pkg-c', login: 'Bob', status: 'verified' },
      { package: 'pkg-c', login: 'Eve', status: 'pending' },
      { package: 'pkg-a', login: 'Carol', status: 'verified' },
      { package: 'pkg-b', login: 'Mallory', status: 'rejected' },
    ],
  });
  assert.equal(counts.get('alice'), 2, 'provenance owners are case-insensitive and count once per package');
  assert.equal(counts.get('bob'), 1);
  assert.equal(counts.get('carol'), 1);
  assert.equal(counts.get('eve'), undefined, 'pending claims stay private');
  assert.equal(counts.get('mallory'), undefined, 'rejected claims do not count');
});

test('maintainerCounts includes approved trusted publishers and token requesters', () => {
  const index = { packages: { 'pkg-x': { versions: {} } } };
  const counts = maintainerCounts(index, {
    publishers: [
      { scopes: ['pkg-x'], repository: 'Repo-Owner/pkg-x', requestId: 'req_1', approvedAt: '2026-01-01T00:00:00Z' },
    ],
    requests: [
      {
        id: 'req_1',
        kind: 'publisher',
        status: 'approved',
        scopes: ['pkg-x'],
        requester: { githubId: '9', login: 'Requester' },
      },
    ],
  });
  assert.equal(counts.get('repo-owner'), 1);
  assert.equal(counts.get('requester'), 1);
});

test('checkSponsorListing reads hasSponsorsListing and degrades to unknown', async () => {
  const respond = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });

  assert.equal(
    await checkSponsorListing({
      login: 'octo', token: 'tok',
      fetchImpl: respond({ data: { user: { hasSponsorsListing: true } } }),
    }),
    'sponsor',
  );
  assert.equal(
    await checkSponsorListing({
      login: 'octo', token: 'tok',
      fetchImpl: respond({ data: { user: { hasSponsorsListing: false } } }),
    }),
    'not',
  );
  assert.equal(
    await checkSponsorListing({ login: 'octo', token: 'tok', fetchImpl: respond({ data: { user: null } }) }),
    'unknown',
  );
  assert.equal(
    await checkSponsorListing({ login: '', token: 'tok', fetchImpl: respond({}) }),
    'unknown',
    'no login means no check',
  );
  assert.equal(
    await checkSponsorListing({ login: 'octo', token: '', fetchImpl: respond({}) }),
    'unknown',
    'no token means the feature is off, never an error',
  );
  assert.equal(
    await checkSponsorListing({
      login: 'octo', token: 'tok',
      fetchImpl: async () => { throw new Error('network down'); },
    }),
    'unknown',
  );
  assert.equal(
    await checkSponsorListing({
      login: 'octo', token: 'tok',
      fetchImpl: respond({ message: 'Bad credentials' }, { ok: false }),
    }),
    'unknown',
  );

  // A hung upstream is bounded by the timeout, not the request.
  const hang = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  assert.equal(
    await checkSponsorListing({ login: 'octo', token: 'tok', fetchImpl: hang, timeoutMs: 30 }),
    'unknown',
  );

  // The request itself: GraphQL POST with the login variable and bearer token.
  let captured = null;
  await checkSponsorListing({
    login: 'octo',
    token: 'tok',
    apiUrl: 'http://stub.invalid/graphql',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ data: { user: { hasSponsorsListing: true } } }) };
    },
  });
  assert.equal(captured.url, 'http://stub.invalid/graphql');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer tok');
  const payload = JSON.parse(captured.options.body);
  assert.equal(payload.variables.login, 'octo');
  assert.match(payload.query, /hasSponsorsListing/);
});

test('the sponsor opt-in cache stores, validates, and clears state', () => {
  const db = new Database({ path: ':memory:' });
  try {
    const store = new ContributorStore({ db });
    assert.deepEqual(store.sponsorOf('777'), { optedIn: false, state: '', checkedAt: '' });

    store.setSponsorOptIn('777', 'Alice', true);
    assert.equal(store.sponsorOf('777').optedIn, true);
    assert.equal(store.sponsorOf('777').state, '', 'opting in starts a fresh check');

    store.recordSponsorCheck('777', 'sponsor', { at: '2026-01-01T00:00:00Z' });
    assert.deepEqual(store.sponsorOf('777'), {
      optedIn: true, state: 'sponsor', checkedAt: '2026-01-01T00:00:00Z',
    });

    store.recordSponsorCheck('777', 'nonsense');
    assert.equal(store.sponsorOf('777').state, 'sponsor', 'unknown states are never cached');

    // Re-saving the opt-in resets the cache, forcing a re-check.
    store.setSponsorOptIn('777', 'Alice', true);
    assert.equal(store.sponsorOf('777').state, '');

    store.recordSponsorCheck('777', 'not', { at: '2026-01-02T00:00:00Z' });
    assert.equal(store.sponsorOf('777').state, 'not');

    store.setSponsorOptIn('777', 'Alice', false);
    assert.deepEqual(store.sponsorOf('777'), { optedIn: false, state: '', checkedAt: '' });

    // A renamed login keeps the row (keyed by the stable id).
    store.setSponsorOptIn('777', 'Alice-New', true);
    assert.equal(store.sponsorOf('777').optedIn, true);
    assert.equal(db.get('SELECT login FROM contributor_sponsors WHERE github_id = ?', '777').login, 'Alice-New');
  } finally {
    db.close();
  }
});
