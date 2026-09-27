// XIOM Package Registry -- report queue store tests (registry 2.0 phase 3).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ReviewStore } = require('../src/reviews');

const REPORTER = { githubId: '4242', login: 'alice' };

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-reviews-'));
  return new ReviewStore({ path: path.join(dir, 'reviews.json') });
}

test('files a report, persists it, and reloads it', () => {
  const reviews = store();
  const report = reviews.createReport({
    packageName: 'demo-pkg',
    reporter: REPORTER,
    reason: 'license',
    note: 'ships GPL code with no license file',
  });
  assert.match(report.id, /^rep_[0-9a-f]{12}$/);
  assert.equal(report.status, 'open');
  assert.equal(report.reporter.login, 'alice');

  const reloaded = new ReviewStore({ path: reviews.path });
  assert.deepEqual(reloaded.getReport(report.id), report);
  assert.equal(reloaded.openReportCount('demo-pkg'), 1);
  assert.equal(reloaded.openReportCount('other-pkg'), 0);
});

test('rejects invalid package names, reasons, and empty notes', () => {
  const reviews = store();
  const create = (overrides) => reviews.createReport({
    packageName: 'demo-pkg', reporter: REPORTER, reason: 'other', note: 'detail', ...overrides,
  });
  assert.throws(() => create({ packageName: 'Bad Name' }), /not a package name/);
  assert.throws(() => create({ reason: 'vibes' }), /reason must be one of/);
  assert.throws(() => create({ note: '   ' }), /describe the problem/);
  assert.throws(() => create({ reporter: { githubId: 'x', login: 'alice' } }), /signed-in GitHub account/);
});

test('caps open reports per reporter and package', () => {
  const reviews = store();
  for (let i = 0; i < 3; i++) {
    reviews.createReport({
      packageName: 'demo-pkg', reporter: REPORTER, reason: 'spam', note: `report ${i}`,
    });
  }
  assert.throws(
    () => reviews.createReport({
      packageName: 'demo-pkg', reporter: REPORTER, reason: 'spam', note: 'again',
    }),
    /already have open reports/,
  );
  // Another package or another reporter is unaffected.
  assert.ok(reviews.createReport({
    packageName: 'other-pkg', reporter: REPORTER, reason: 'spam', note: 'x',
  }));
  assert.ok(reviews.createReport({
    packageName: 'demo-pkg', reporter: { githubId: '7', login: 'bob' }, reason: 'spam', note: 'x',
  }));
});

test('resolve and dismiss require a note and are one-way', () => {
  const reviews = store();
  const first = reviews.createReport({
    packageName: 'demo-pkg', reporter: REPORTER, reason: 'malware', note: 'runs curl | sh',
  });
  const second = reviews.createReport({
    packageName: 'demo-pkg', reporter: { githubId: '7', login: 'bob' }, reason: 'abandoned', note: 'old',
  });

  assert.throws(() => reviews.resolveReport(first.id, { actor: 'root' }), /resolution note is required/);
  const resolved = reviews.resolveReport(first.id, {
    actor: 'root', status: 'resolved', resolution: 'confirmed and yanked',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, 'root');
  assert.throws(() => reviews.resolveReport(first.id, { actor: 'root', resolution: 'again' }), /already resolved/);

  const dismissed = reviews.resolveReport(second.id, {
    actor: 'root', status: 'dismissed', resolution: 'intentional behavior',
  });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(reviews.openReportCount('demo-pkg'), 0);
  assert.equal(reviews.listReports({ status: 'open' }).length, 0);
  assert.equal(reviews.listReports({ packageName: 'demo-pkg' }).length, 2);
  assert.throws(() => reviews.resolveReport('rep_000000000000', { actor: 'root', resolution: 'x' }), /not found/);
});

test('reviewer decisions are independent toggles with a full history', () => {
  const reviews = store();
  assert.throws(
    () => reviews.setDecision('demo-pkg', { action: 'flag', actor: 'root' }),
    /reason is required/,
  );
  assert.throws(
    () => reviews.setDecision('demo-pkg', { action: 'mute', actor: 'root' }),
    /reason is required/,
  );
  assert.throws(
    () => reviews.setDecision('Bad Name', { action: 'review', actor: 'root' }),
    /not a package name/,
  );
  assert.throws(
    () => reviews.setDecision('demo-pkg', { action: 'nope', actor: 'root' }),
    /action must be one of/,
  );

  const reviewed = reviews.setDecision('demo-pkg', { action: 'review', actor: 'root', note: 'looks clean' });
  assert.deepEqual(
    { reviewed: reviewed.reviewed, flagged: reviewed.flagged, muted: reviewed.muted },
    { reviewed: true, flagged: false, muted: false },
  );

  // Flagging supersedes the clean verdict; muting is an independent overlay
  // and can coexist with a flag.
  const flagged = reviews.setDecision('demo-pkg', { action: 'flag', actor: 'root', note: 'malware report confirmed' });
  assert.deepEqual(
    { reviewed: flagged.reviewed, flagged: flagged.flagged, muted: flagged.muted },
    { reviewed: false, flagged: true, muted: false },
  );
  const both = reviews.setDecision('demo-pkg', { action: 'mute', actor: 'root', note: 'metadata spam' });
  assert.deepEqual(
    { reviewed: both.reviewed, flagged: both.flagged, muted: both.muted },
    { reviewed: false, flagged: true, muted: true },
  );
  assert.deepEqual(both.history.map((entry) => entry.action), ['review', 'flag', 'mute']);
  assert.deepEqual(reviews.listDecisions().map((entry) => entry.name), ['demo-pkg']);
  assert.equal(reviews.decision('other-pkg'), null);

  // Unflagging leaves the mute untouched, and vice versa: each property has
  // its own toggle, so nothing needs an undo.
  const unflagged = reviews.setDecision('demo-pkg', { action: 'unflag', actor: 'root' });
  assert.equal(unflagged.flagged, false);
  assert.equal(unflagged.muted, true);
  const unmuted = reviews.setDecision('demo-pkg', { action: 'unmute', actor: 'root' });
  assert.deepEqual(
    { reviewed: unmuted.reviewed, flagged: unmuted.flagged, muted: unmuted.muted },
    { reviewed: false, flagged: false, muted: false },
  );
  const reReviewed = reviews.setDecision('demo-pkg', { action: 'review', actor: 'root' });
  assert.equal(reReviewed.reviewed, true);
  const clearedReview = reviews.setDecision('demo-pkg', { action: 'unreview', actor: 'root' });
  assert.equal(clearedReview.reviewed, false);

  // The record round-trips through the file in the boolean model.
  const reloaded = new ReviewStore({ path: reviews.path });
  const persisted = reloaded.decision('demo-pkg');
  assert.equal(persisted.reviewed, false);
  assert.equal(persisted.flagged, false);
  assert.equal(persisted.muted, false);
  assert.deepEqual(
    persisted.history.map((entry) => entry.action),
    ['review', 'flag', 'mute', 'unflag', 'unmute', 'review', 'unreview'],
  );
});

test('legacy single-status decision records normalize on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-reviews-legacy-'));
  const file = path.join(dir, 'reviews.json');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.1.0',
    packages: {
      'demo-pkg': {
        status: 'flagged',
        history: [{ at: '2026-09-25T00:00:00.000Z', actor: 'root', action: 'flagged' }],
      },
      'muted-pkg': {
        status: 'muted',
        history: [{ at: '2026-09-25T00:00:00.000Z', actor: 'root', action: 'muted' }],
      },
      'reviewed-pkg': {
        status: 'reviewed',
        history: [{ at: '2026-09-25T00:00:00.000Z', actor: 'root', action: 'reviewed' }],
      },
    },
  }));
  const store = new ReviewStore({ path: file });
  assert.deepEqual(
    { reviewed: store.decision('demo-pkg').reviewed, flagged: store.decision('demo-pkg').flagged, muted: store.decision('demo-pkg').muted },
    { reviewed: false, flagged: true, muted: false },
  );
  assert.equal(store.decision('muted-pkg').muted, true);
  assert.equal(store.decision('reviewed-pkg').reviewed, true);
});

test('reports and decisions coexist in one file', () => {
  const reviews = store();
  const report = reviews.createReport({
    packageName: 'demo-pkg', reporter: REPORTER, reason: 'other', note: 'x',
  });
  reviews.setDecision('demo-pkg', { action: 'review', actor: 'root' });
  const reloaded = new ReviewStore({ path: reviews.path });
  assert.equal(reloaded.getReport(report.id).status, 'open');
  assert.equal(reloaded.decision('demo-pkg').reviewed, true);
  assert.equal(reloaded.openReportCount('demo-pkg'), 1);
});

test('ratings upsert per account and aggregate', () => {
  const reviews = store();
  assert.throws(() => reviews.rate('demo-pkg', { user: REPORTER, stars: 0 }), /1 to 5/);
  assert.throws(() => reviews.rate('demo-pkg', { user: REPORTER, stars: 4.5 }), /whole number/);

  reviews.rate('demo-pkg', { user: REPORTER, stars: 5, review: 'great' });
  reviews.rate('demo-pkg', { user: { githubId: '7', login: 'bob' }, stars: 3 });
  assert.deepEqual(reviews.ratingSummary('demo-pkg'), { count: 2, average: 4 });

  reviews.rate('demo-pkg', { user: REPORTER, stars: 1, review: 'changed my mind' });
  assert.deepEqual(reviews.ratingSummary('demo-pkg'), { count: 2, average: 2 });

  const reloaded = new ReviewStore({ path: reviews.path });
  assert.equal(reloaded.ratingSummary('demo-pkg').count, 2);
  assert.equal(reloaded.ratingSummary('other-pkg').count, 0);
  const mine = reloaded.ratingsFor('demo-pkg').find((entry) => entry.githubId === '4242');
  assert.equal(mine.stars, 1);
  assert.equal(mine.review, 'changed my mind');
});

test('malformed persisted reports are dropped on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-reviews-'));
  const file = path.join(dir, 'reviews.json');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.0.0',
    packages: {
      'demo-pkg': {
        status: 'reviewed',
        history: [{ at: '2026-09-25T00:00:00.000Z', actor: 'root', action: 'reviewed' }],
      },
      'Bad Name': { status: 'reviewed', history: [{ action: 'reviewed' }] },
      'other-pkg': { status: 'nope', history: [{ action: 'x' }] },
    },
    reports: {
      rep_aaaaaaaaaaaa: {
        id: 'rep_aaaaaaaaaaaa',
        package: 'demo-pkg',
        reporter: { githubId: '5', login: 'carol' },
        reason: 'other',
        note: 'valid',
        status: 'open',
        createdAt: '2026-09-25T00:00:00.000Z',
      },
      'not-an-id': { package: 'demo-pkg' },
      rep_bbbbbbbbbbbb: { package: 'demo-pkg', reporter: { githubId: '5', login: 'carol' }, reason: 'nope', note: 'x', status: 'open' },
      rep_cccccccccccc: { package: 'Bad Name', reporter: { githubId: '5', login: 'carol' }, reason: 'other', note: 'x', status: 'open' },
    },
  }));
  const reviews = new ReviewStore({ path: file });
  assert.deepEqual(reviews.listReports().map((report) => report.id), ['rep_aaaaaaaaaaaa']);
  assert.deepEqual(reviews.listDecisions().map((entry) => entry.name), ['demo-pkg']);
});

// ─── A3 phase 1: ratings in SQLite (SESSION.md 18.2) ──────────────────────

const { Database } = require('../src/db');

/** A store over both files: reviews.json (import/mirror) and registry.db. */
function sqliteStore(legacy = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-reviews-db-'));
  const dbPath = path.join(dir, 'registry.db');
  const jsonPath = path.join(dir, 'reviews.json');
  if (legacy) fs.writeFileSync(jsonPath, JSON.stringify(legacy));
  const db = new Database({ path: dbPath });
  return { store: new ReviewStore({ path: jsonPath, db }), db, dbPath, jsonPath };
}

const LEGACY_RATINGS = {
  version: '1.1.0',
  updated_at: '2026-09-01T00:00:00Z',
  packages: {},
  reports: {},
  ratings: {
    'demo-pkg': {
      42: { login: 'alice', stars: 5, review: 'clean and small', at: '2026-09-01T00:00:00Z' },
      7: { login: 'bob', stars: 3, review: '', at: '2026-09-01T01:00:00Z' },
    },
  },
};

test('ratings import from reviews.json into SQLite on first open', () => {
  const { store: reviews, db, dbPath, jsonPath } = sqliteStore(LEGACY_RATINGS);
  try {
    // Read from SQLite: newest first, aggregate over the imported rows.
    assert.deepEqual(reviews.ratingsFor('demo-pkg').map((entry) => entry.login), ['bob', 'alice']);
    assert.deepEqual(reviews.ratingSummary('demo-pkg'), { count: 2, average: 4 });

    // New ratings go to SQLite and refresh the JSON mirror.
    reviews.rate('demo-pkg', { user: { githubId: '9', login: 'carol' }, stars: 4, review: 'works' });
    assert.deepEqual(reviews.ratingSummary('demo-pkg'), { count: 3, average: 4 });
    const mirror = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.equal(mirror.ratings['demo-pkg']['9'].stars, 4);
    assert.equal(mirror.ratings['demo-pkg']['42'].stars, 5);

    // Reopen against the same database: SQLite is primary and persists.
    const again = new Database({ path: dbPath });
    try {
      const reopened = new ReviewStore({ path: jsonPath, db: again });
      assert.equal(reopened.ratingSummary('demo-pkg').count, 3);
      assert.equal(reopened.ratingsFor('demo-pkg').find((entry) => entry.login === 'carol').stars, 4);
    } finally {
      again.close();
    }
  } finally {
    db.close();
  }
});

test('SQLite wins over a stale JSON mirror once it has rows', () => {
  const { store: reviews, db, dbPath, jsonPath } = sqliteStore(LEGACY_RATINGS);
  reviews.rate('demo-pkg', { user: { githubId: '42', login: 'alice' }, stars: 5, review: 'updated' });
  db.close();

  // A stale reviews.json (say, restored from a backup) must not win.
  fs.writeFileSync(jsonPath, JSON.stringify(LEGACY_RATINGS));
  const again = new Database({ path: dbPath });
  try {
    const reopened = new ReviewStore({ path: jsonPath, db: again });
    assert.deepEqual(
      { stars: reopened.ratingsFor('demo-pkg')[0].stars, review: reopened.ratingsFor('demo-pkg')[0].review },
      { stars: 5, review: 'updated' },
    );
    assert.deepEqual(reopened.ratingSummary('demo-pkg'), { count: 2, average: 4 });
  } finally {
    again.close();
  }
});

test('a rating update never duplicates the row and the mirror carries the truth', () => {
  const legacy = structuredClone(LEGACY_RATINGS);
  legacy.reports = {
    rep_aaaaaaaaaaaa: {
      id: 'rep_aaaaaaaaaaaa',
      package: 'demo-pkg',
      reporter: { githubId: '5', login: 'carol' },
      reason: 'other',
      note: 'valid',
      status: 'open',
      createdAt: '2026-09-01T02:00:00Z',
    },
  };
  const { store: reviews, db } = sqliteStore(legacy);
  try {
    reviews.rate('demo-pkg', { user: { githubId: '42', login: 'alice' }, stars: 1, review: 'regressed' });
    const rows = db.all('SELECT * FROM review_ratings WHERE package = ? AND github_id = ?', 'demo-pkg', '42');
    assert.equal(rows.length, 1, 'upsert keeps one row per package and account');
    assert.equal(Number(rows[0].stars), 1);
    assert.equal(reviews.ratingSummary('demo-pkg').count, 2, 'updated, not added');

    // Reports resolve through SQLite in db mode.
    assert.equal(reviews.openReportCount('demo-pkg'), 1);
    const resolved = reviews.resolveReport('rep_aaaaaaaaaaaa', { actor: 'root', resolution: 'handled' });
    assert.equal(resolved.status, 'resolved');
    const mirror = JSON.parse(fs.readFileSync(reviews.path, 'utf-8'));
    assert.equal(mirror.reports.rep_aaaaaaaaaaaa.status, 'resolved');
    assert.equal(mirror.ratings['demo-pkg']['42'].stars, 1, 'mirror carries the SQLite truth');
  } finally {
    db.close();
  }
});

// ─── A3 phase 2: reports and decisions in SQLite (SESSION.md 18.2) ────────

const LEGACY_QUEUE = {
  version: '1.1.0',
  updated_at: '2026-09-01T00:00:00Z',
  packages: {
    'demo-pkg': {
      reviewed: true,
      flagged: false,
      muted: false,
      history: [{ at: '2026-09-01T00:00:00Z', actor: 'root', action: 'review', note: 'clean' }],
    },
  },
  reports: {
    rep_aaaaaaaaaaaa: {
      id: 'rep_aaaaaaaaaaaa',
      package: 'demo-pkg',
      reporter: { githubId: '5', login: 'carol' },
      reason: 'other',
      note: 'valid',
      status: 'open',
      createdAt: '2026-09-01T02:00:00Z',
    },
  },
  ratings: {},
};

test('reports and decisions import from reviews.json and then live in SQLite', () => {
  const { store: reviews, db, jsonPath } = sqliteStore(structuredClone(LEGACY_QUEUE));
  try {
    // Imported state is served from SQLite.
    assert.equal(reviews.openReportCount('demo-pkg'), 1);
    assert.equal(reviews.decision('demo-pkg').reviewed, true);
    assert.deepEqual(reviews.decision('demo-pkg').history.map((entry) => entry.action), ['review']);

    // Report lifecycle goes through SQL.
    const created = reviews.createReport({
      packageName: 'demo-pkg',
      reporter: { githubId: '7', login: 'bob' },
      reason: 'spam',
      note: 'looks like spam',
    });
    const resolved = reviews.resolveReport(created.id, {
      actor: 'root', status: 'dismissed', resolution: 'not spam',
    });
    assert.equal(resolved.status, 'dismissed');
    assert.equal(reviews.listReports({ status: 'open' }).length, 1, 'only the legacy report stays open');
    assert.equal(reviews.listReports({ packageName: 'demo-pkg' }).length, 2);

    // Decision history appends in SQLite.
    const flipped = reviews.setDecision('demo-pkg', { action: 'flag', actor: 'root', note: 'malware' });
    assert.equal(flipped.flagged, true);
    assert.equal(flipped.reviewed, false);
    assert.deepEqual(flipped.history.map((entry) => entry.action), ['review', 'flag']);
    assert.deepEqual(
      reviews.listDecisions().map((entry) => entry.name),
      ['demo-pkg'],
    );

    // The JSON mirror is refreshed from the primary store.
    const mirror = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.equal(mirror.reports[created.id].status, 'dismissed');
    assert.equal(mirror.packages['demo-pkg'].flagged, true);
    assert.deepEqual(mirror.packages['demo-pkg'].history.map((entry) => entry.action), ['review', 'flag']);
  } finally {
    db.close();
  }
});

test('SQLite wins over stale JSON for reports and decisions too', () => {
  const { store: first, db, dbPath, jsonPath } = sqliteStore(structuredClone(LEGACY_QUEUE));
  first.resolveReport('rep_aaaaaaaaaaaa', { actor: 'root', resolution: 'done' });
  first.setDecision('demo-pkg', { action: 'unflag', actor: 'root' });
  db.close();

  // A stale reviews.json must not win over the primary database.
  fs.writeFileSync(jsonPath, JSON.stringify(LEGACY_QUEUE));
  const again = new Database({ path: dbPath });
  try {
    const reopened = new ReviewStore({ path: jsonPath, db: again });
    assert.equal(reopened.listReports({ status: 'open' }).length, 0);
    assert.equal(reopened.listReports({ status: 'resolved' }).length, 1);
    assert.equal(reopened.decision('demo-pkg').flagged, false);
    assert.deepEqual(reopened.decision('demo-pkg').history.map((entry) => entry.action), ['review', 'unflag']);
  } finally {
    again.close();
  }
});

test('the open-report cap still holds in SQLite mode', () => {
  const { store: reviews, db } = sqliteStore();
  try {
    const reporter = { githubId: '7', login: 'bob' };
    for (let i = 0; i < 3; i++) {
      reviews.createReport({ packageName: 'demo-pkg', reporter, reason: 'spam', note: `report ${i}` });
    }
    assert.throws(
      () => reviews.createReport({ packageName: 'demo-pkg', reporter, reason: 'spam', note: 'again' }),
      /already have open reports/,
    );
    // Another reporter or another package is unaffected.
    assert.ok(reviews.createReport({
      packageName: 'demo-pkg', reporter: { githubId: '8', login: 'cara' }, reason: 'spam', note: 'x',
    }));
    assert.ok(reviews.createReport({
      packageName: 'other-pkg', reporter, reason: 'spam', note: 'x',
    }));
  } finally {
    db.close();
  }
});

// ─── A9: review votes, maintainer reply, list UX (SESSION.md 21.9.3) ──────

test('review votes toggle, flip, and refuse the review author', () => {
  const { store: reviews, db } = sqliteStore();
  try {
    reviews.rate('demo-pkg', { user: { githubId: '1', login: 'alice' }, stars: 5, review: 'great' });
    reviews.rate('demo-pkg', { user: { githubId: '2', login: 'bob' }, stars: 4, review: 'good' });

    assert.deepEqual(
      reviews.vote('demo-pkg', '1', { voter: { githubId: '2', login: 'bob' }, value: 1 }),
      { up: 1, down: 0, mine: 1 },
    );
    assert.deepEqual(
      reviews.vote('demo-pkg', '1', { voter: { githubId: '3', login: 'carol' }, value: -1 }),
      { up: 1, down: 1, mine: -1 },
    );
    // Flipping replaces the vote; casting the same value again removes it.
    assert.deepEqual(
      reviews.vote('demo-pkg', '1', { voter: { githubId: '3', login: 'carol' }, value: 1 }),
      { up: 2, down: 0, mine: 1 },
    );
    assert.deepEqual(
      reviews.vote('demo-pkg', '1', { voter: { githubId: '3', login: 'carol' }, value: 1 }),
      { up: 1, down: 0, mine: 0 },
    );
    assert.throws(
      () => reviews.vote('demo-pkg', '1', { voter: { githubId: '1', login: 'alice' }, value: 1 }),
      /your own review/,
    );
    assert.throws(
      () => reviews.vote('demo-pkg', '99', { voter: { githubId: '2', login: 'bob' }, value: 1 }),
      /not found/,
    );
    assert.throws(
      () => reviews.vote('demo-pkg', '1', { voter: { githubId: '2', login: 'bob' }, value: 5 }),
      /either up or down/,
    );

    // Page tallies expose counts and the viewer's own vote only.
    const page = reviews.ratingsPage('demo-pkg', {});
    const tallies = reviews.votesForPage('demo-pkg', page.items.map((entry) => entry.githubId), '3');
    assert.deepEqual(tallies.get('1'), { up: 1, down: 0, mine: 0 });
  } finally {
    db.close();
  }
});

test('one maintainer reply per review upserts; pages sort and paginate', () => {
  const { store: reviews, db } = sqliteStore();
  try {
    reviews.rate('demo-pkg', { user: { githubId: '1', login: 'alice' }, stars: 5, review: 'great docs' });
    reviews.rate('demo-pkg', { user: { githubId: '2', login: 'bob' }, stars: 2, review: 'breaks on node 20' });
    reviews.rate('demo-pkg', { user: { githubId: '3', login: 'carol' }, stars: 4, review: '' });

    const reply = reviews.replyTo('demo-pkg', '2', {
      author: { githubId: '9', login: 'maint' }, body: 'Fixed in 1.0.1.',
    });
    assert.equal(reply.body, 'Fixed in 1.0.1.');
    assert.equal(reply.updatedAt, '');
    const edited = reviews.replyTo('demo-pkg', '2', {
      author: { githubId: '9', login: 'maint' }, body: 'Fixed in 1.0.2.',
    });
    assert.equal(edited.body, 'Fixed in 1.0.2.');
    assert.ok(edited.updatedAt, 'editing stamps updatedAt');
    assert.equal(reviews.repliesForPage('demo-pkg', ['2']).get('2').body, 'Fixed in 1.0.2.');
    assert.throws(
      () => reviews.replyTo('demo-pkg', '7', { author: { githubId: '9', login: 'maint' }, body: 'x' }),
      /not found/,
    );

    // The text-only filter keeps reviews that carry text.
    const textOnly = reviews.ratingsPage('demo-pkg', { textOnly: true });
    assert.deepEqual(textOnly.items.map((entry) => entry.login).sort(), ['alice', 'bob']);

    // Helpful = net upvotes first.
    reviews.vote('demo-pkg', '1', { voter: { githubId: '2', login: 'bob' }, value: 1 });
    reviews.vote('demo-pkg', '1', { voter: { githubId: '3', login: 'carol' }, value: 1 });
    reviews.vote('demo-pkg', '2', { voter: { githubId: '3', login: 'carol' }, value: -1 });
    const helpful = reviews.ratingsPage('demo-pkg', { sort: 'helpful' });
    assert.equal(helpful.items[0].login, 'alice');

    // Pagination over the full list.
    for (let i = 0; i < 12; i++) {
      reviews.rate('demo-pkg', { user: { githubId: String(100 + i), login: `user${i}` }, stars: 3 });
    }
    const first = reviews.ratingsPage('demo-pkg', { perPage: 10, page: 1 });
    assert.deepEqual(
      { total: first.total, pages: first.pages, items: first.items.length, page: first.page },
      { total: 15, pages: 2, items: 10, page: 1 },
    );
    const second = reviews.ratingsPage('demo-pkg', { perPage: 10, page: 2 });
    assert.deepEqual({ items: second.items.length, page: second.page }, { items: 5, page: 2 });
    // A page past the end clamps to the last page.
    assert.equal(reviews.ratingsPage('demo-pkg', { perPage: 10, page: 99 }).page, 2);
  } finally {
    db.close();
  }
});
