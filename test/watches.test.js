// XIOM Package Registry -- A5 watch store and activity tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A5: watching is a feed subscription (no publish powers), the
// count is public, the per-account cap is enforced, and activity is assembled
// from public data only, newest first.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Database } = require('../src/db');
const { WatchStore, MAX_WATCHES_PER_ACCOUNT } = require('../src/watches');
const { packageActivity, watchedFeed } = require('../src/activity');
const { ReviewStore } = require('../src/reviews');

function watchStore() {
  const db = new Database({ path: ':memory:' });
  return { store: new WatchStore({ db }), db };
}

function reviewsStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-watch-reviews-'));
  const db = new Database({ path: path.join(dir, 'registry.db') });
  return { store: new ReviewStore({ path: path.join(dir, 'reviews.json'), db }), db };
}

test('watching is idempotent, countable, ordered, and capped', () => {
  const { store, db } = watchStore();
  try {
    assert.equal(store.isWatching('1', 'pkg-a'), false);
    assert.deepEqual(store.watch('1', 'alice', 'pkg-a', { at: '2026-01-01T00:00:00Z' }), {
      watching: true, watchers: 1,
    });
    // Idempotent: watching again does not double the row.
    store.watch('1', 'alice', 'pkg-a');
    assert.equal(store.countFor('pkg-a'), 1);

    store.watch('2', 'bob', 'pkg-a', { at: '2026-01-02T00:00:00Z' });
    store.watch('1', 'alice', 'pkg-b', { at: '2026-01-03T00:00:00Z' });
    assert.equal(store.countFor('pkg-a'), 2);
    assert.deepEqual(store.packagesFor('1'), ['pkg-b', 'pkg-a'], 'most recently added first');
    assert.deepEqual(store.watchersOf('pkg-a').map((entry) => entry.login), ['alice', 'bob']);

    assert.deepEqual(store.unwatch('2', 'pkg-a'), { watching: false, watchers: 1 });
    store.unwatch('2', 'pkg-a');
    assert.equal(store.countFor('pkg-a'), 1);

    // The cap keeps the feed bounded.
    for (let i = 0; i < MAX_WATCHES_PER_ACCOUNT - 1; i++) store.watch('9', 'carol', `fill-${i}`);
    assert.equal(store.packagesFor('9').length, MAX_WATCHES_PER_ACCOUNT - 1);
    store.watch('9', 'carol', 'fill-last');
    assert.equal(store.packagesFor('9').length, MAX_WATCHES_PER_ACCOUNT);
    assert.throws(() => store.watch('9', 'carol', 'one-too-many'), (err) => err.code === 'watch_limit');

    // The stable id keys the row; a rename refreshes the display login.
    store.rename('1', 'alice-renamed');
    assert.deepEqual(store.watchersOf('pkg-b'), [{ githubId: '1', login: 'alice-renamed' }]);
  } finally {
    db.close();
  }
});

test('packageActivity merges releases, reviews, replies, decisions, and claims', () => {
  const { store: reviews, db } = reviewsStore();
  try {
    reviews.rate('demo-pkg', {
      user: { githubId: '2', login: 'bob' }, stars: 4, review: 'works well',
    });
    reviews.replyTo('demo-pkg', '2', { author: { githubId: '9', login: 'maint' }, body: 'thanks' });
    reviews.setDecision('demo-pkg', { action: 'flag', actor: 'carol', note: 'check license' });

    const pkg = {
      name: 'demo-pkg',
      versions: {
        '1.0.0': { published: '2026-01-01T00:00:00Z', publisher: { repository: 'owner/demo' } },
        '0.9.0': { published: '2025-12-01T00:00:00Z', yanked: true },
      },
    };
    const ownership = {
      listClaims: () => [
        { package: 'demo-pkg', login: 'maint', status: 'verified', decidedAt: '2026-01-04T00:00:00Z' },
        { package: 'demo-pkg', login: 'eve', status: 'pending', claimedAt: '2026-01-05T00:00:00Z' },
        { package: 'other-pkg', login: 'ghost', status: 'verified', decidedAt: '2026-01-05T00:00:00Z' },
      ],
    };

    const events = packageActivity({ name: 'demo-pkg', pkg, reviews, ownership });
    // Pending claims and foreign packages stay out. The review, reply, and
    // decision happen "now": their relative order within one millisecond is
    // not a contract, so compare them as a set. Everything else is ordered by
    // its explicit date (the claim, then the two releases).
    const types = events.map((event) => event.type);
    assert.deepEqual([...types.slice(0, 3)].sort(), ['decision', 'reply', 'review']);
    assert.deepEqual(types.slice(3), ['claim', 'release', 'release']);
    const byType = Object.fromEntries(events.map((event) => [event.type, event]));
    assert.equal(byType.decision.action, 'flag');
    assert.equal(byType.decision.actor, 'carol');
    assert.equal(byType.reply.body, 'thanks');
    assert.equal(byType.review.stars, 4);
    assert.equal(byType.claim.login, 'maint');
    const releases = events.filter((event) => event.type === 'release');
    assert.deepEqual(releases.map((event) => event.version), ['1.0.0', '0.9.0']);
    assert.equal(releases[0].repository, 'owner/demo');
    assert.equal(releases[1].yanked, true);

    // The per-package cap keeps the newest events.
    assert.equal(packageActivity({ name: 'demo-pkg', pkg, reviews, ownership, limit: 2 }).length, 2);
  } finally {
    db.close();
  }
});

test('watchedFeed merges watched packages and skips unknown names', () => {
  const { store: reviews, db } = reviewsStore();
  try {
    reviews.rate('alpha-pkg', { user: { githubId: '2', login: 'bob' }, stars: 5, review: 'great' });
    reviews.rate('beta-pkg', { user: { githubId: '3', login: 'carol' }, stars: 3, review: 'ok' });
    const index = {
      packages: {
        'alpha-pkg': { name: 'alpha-pkg', versions: { '1.0.0': { published: '2026-01-01T00:00:00Z' } } },
        'beta-pkg': { name: 'beta-pkg', versions: { '2.0.0': { published: '2026-01-02T00:00:00Z' } } },
      },
    };
    const entries = watchedFeed({
      packages: ['alpha-pkg', 'beta-pkg', 'vanished-pkg'],
      index,
      reviews,
      ownership: { listClaims: () => [] },
    });
    // Both reviews happen "now" (order within a millisecond is not a
    // contract); the releases order by their explicit dates, newest first.
    assert.deepEqual(
      entries.map((entry) => `${entry.package}:${entry.type}`).sort(),
      ['alpha-pkg:release', 'alpha-pkg:review', 'beta-pkg:release', 'beta-pkg:review'],
    );
    assert.deepEqual(
      entries.filter((entry) => entry.type === 'release').map((entry) => entry.package),
      ['beta-pkg', 'alpha-pkg'],
    );
    assert.equal(watchedFeed({
      packages: ['alpha-pkg'], index, reviews, ownership: { listClaims: () => [] }, limit: 1,
    }).length, 1);
  } finally {
    db.close();
  }
});
