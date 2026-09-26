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
