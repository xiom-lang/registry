// XIOM Package Registry -- A4 contributor store and scoring tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A4: the capped weighted score, maintainer counting from the
// index overlay, the public Sponsors check (with a fake fetch), and the
// opt-in cache on the platform database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Database } = require('../src/db');
const {
  ContributorStore,
  checkSponsorListing,
  contributorScore,
  maintainerCounts,
  CONTRIBUTOR_CAPS,
  CONTRIBUTOR_WEIGHTS,
} = require('../src/contributors');

test('contributorScore caps every category and ignores garbage', () => {
  assert.equal(contributorScore({}), 0);
  assert.equal(contributorScore({ reviews: 3 }), 3 * CONTRIBUTOR_WEIGHTS.reviews);
  assert.equal(
    contributorScore({ reviews: 4000 }),
    CONTRIBUTOR_CAPS.reviews * CONTRIBUTOR_WEIGHTS.reviews,
    'raw volume cannot beat the cap',
  );
  assert.equal(
    contributorScore({ ratings: 999 }),
    CONTRIBUTOR_CAPS.ratings * CONTRIBUTOR_WEIGHTS.ratings,
  );
  assert.equal(
    contributorScore({ decisions: 999, replies: 999, packages: 999 }),
    CONTRIBUTOR_CAPS.decisions * CONTRIBUTOR_WEIGHTS.decisions
      + CONTRIBUTOR_CAPS.replies * CONTRIBUTOR_WEIGHTS.replies
      + CONTRIBUTOR_CAPS.packages * CONTRIBUTOR_WEIGHTS.packages,
  );
  assert.equal(contributorScore({ reviews: '2' }), 2 * CONTRIBUTOR_WEIGHTS.reviews, 'numeric strings count');
  assert.equal(contributorScore({ reviews: -5, ratings: 0.9, replies: null }), 0);
  const capped = contributorScore({ reviews: 10, ratings: 20, replies: 10, decisions: 20, packages: 5 });
  assert.equal(capped, 30 + 20 + 20 + 20 + 10, 'the maximum is the sum of the capped weights');
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
