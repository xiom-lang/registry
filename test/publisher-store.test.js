// XIOM Package Registry -- app-managed publisher entry tests (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PublisherStore } = require('../src/publisher-store');
const { Database } = require('../src/db');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-publishers-'));
  return new PublisherStore({ path: path.join(dir, 'publishers.json') });
}

const APPROVAL = {
  requestId: 'req_aaaaaaaaaaaa',
  repository: 'alice/demo',
  workflow: 'publish-registry.yml',
  refs: ['refs/heads/main'],
  scopes: ['demo'],
  approvedBy: 'root',
};

test('activates, persists, and revokes an entry with provenance', () => {
  const publishers = store();
  const entry = publishers.add(APPROVAL);
  assert.equal(entry.repository, 'alice/demo');
  assert.equal(entry.workflow, 'publish-registry.yml');
  assert.equal(entry.firstParty, false, 'request approvals are never first-party');
  assert.equal(entry.requestId, APPROVAL.requestId);
  assert.equal(entry.approvedBy, 'root');
  assert.equal(typeof entry.refMatchers[0].test, 'function', 'matchers are ready for live matching');

  const reloaded = new PublisherStore({ path: publishers.path });
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].requestId, APPROVAL.requestId);
  assert.equal(reloaded.list()[0].refMatchers[0].test('refs/heads/main'), true);
});

test('rejects duplicate requests and clashing repository+workflow grants', () => {
  const publishers = store();
  publishers.add(APPROVAL);
  assert.throws(
    () => publishers.add(APPROVAL),
    /already has a live publisher entry/,
  );
  assert.throws(
    () => publishers.add({ ...APPROVAL, requestId: 'req_bbbbbbbbbbbb' }),
    /already configured/,
  );
});

test('removes the entry for a request and drops malformed stored entries', () => {
  const publishers = store();
  publishers.add(APPROVAL);
  publishers.remove(APPROVAL.requestId);
  assert.equal(publishers.list().length, 0);
  assert.throws(() => publishers.remove(APPROVAL.requestId), /no live publisher entry/);

  fs.writeFileSync(publishers.path, JSON.stringify({
    version: '1.0.0',
    entries: [
      {
        label: 'request-req_cccccccccccc',
        repository: 'bob/good',
        workflow: 'publish.yml',
        refs: ['refs/tags/v*'],
        scopes: ['bob-lib'],
        firstParty: false,
        requestId: 'req_cccccccccccc',
        approvedBy: 'root',
        approvedAt: '2026-09-26T00:00:00.000Z',
      },
      { repository: 'broken', workflow: '', refs: [], scopes: [] },
    ],
  }));
  const loaded = new PublisherStore({ path: publishers.path });
  assert.deepEqual(loaded.list().map((entry) => entry.repository), ['bob/good']);
});

// ─── A3 phase 3: entries in SQLite (SESSION.md 18.2) ──────────────────────

test('entries import from publishers.json into SQLite and then live there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-publishers-db-'));
  const file = path.join(dir, 'publishers.json');
  fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', entries: [] }));
  const db = new Database({ path: path.join(dir, 'registry.db') });
  try {
    const publishers = new PublisherStore({ path: file, db });

    // Add and remove write SQLite and refresh the JSON mirror.
    const added = publishers.add(APPROVAL);
    assert.equal(added.requestId, APPROVAL.requestId);
    assert.equal(Number(db.get('SELECT COUNT(*) AS count FROM stored_publishers').count), 1);
    const mirrored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(mirrored.entries.length, 1);
    assert.equal(mirrored.entries[0].requestId, APPROVAL.requestId);

    // Reloading reads the live matchers back from SQLite.
    const reopened = new PublisherStore({ path: file, db });
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0].refMatchers[0].test('refs/heads/main'), true);

    publishers.remove(APPROVAL.requestId);
    assert.equal(Number(db.get('SELECT COUNT(*) AS count FROM stored_publishers').count), 0);

    // A stale JSON file can never win once SQLite has rows.
    publishers.add({
      requestId: 'req_eeeeeeeeeeee',
      repository: 'carol/live',
      workflow: 'publish-registry.yml',
      refs: ['refs/heads/main'],
      scopes: ['live-lib'],
      approvedBy: 'root',
    });
    fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', entries: [APPROVAL] }));
    const reloaded = new PublisherStore({ path: file, db });
    assert.deepEqual(reloaded.list().map((entry) => entry.requestId), ['req_eeeeeeeeeeee']);
  } finally {
    db.close();
  }
});

// ─── B4: approved edits (SESSION.md 21) ───────────────────────────────────

test('update applies an approved edit and keeps the approval provenance', () => {
  const publishers = store();
  publishers.add(APPROVAL);
  const updated = publishers.update(APPROVAL.requestId, {
    repository: 'alice/demo',
    workflow: 'release.yml',
    refs: ['refs/tags/v*'],
    scopes: ['demo'],
  });
  assert.equal(updated.workflow, 'release.yml');
  assert.deepEqual(updated.refs, ['refs/tags/v*']);
  assert.equal(updated.requestId, APPROVAL.requestId);
  assert.equal(updated.approvedBy, 'root', 'the original approval stays on the record');
  assert.equal(updated.refMatchers[0].test('refs/tags/v1.2.3'), true);
  assert.equal(updated.refMatchers[0].test('refs/heads/main'), false, 'the old ref no longer matches');
  assert.equal(updated.firstParty, false);

  const reloaded = new PublisherStore({ path: publishers.path });
  assert.equal(reloaded.list()[0].workflow, 'release.yml');
  assert.equal(reloaded.list()[0].refMatchers[0].test('refs/tags/v9.9.9'), true);
});

test('update refuses unknown requests, clashes, and malformed input', () => {
  const publishers = store();
  publishers.add(APPROVAL);
  publishers.add({
    requestId: 'req_bbbbbbbbbbbb',
    repository: 'bob/demo',
    workflow: 'release.yml',
    refs: ['refs/heads/main'],
    scopes: ['demo'],
    approvedBy: 'root',
  });
  assert.throws(
    () => publishers.update(APPROVAL.requestId, {
      repository: 'bob/demo', workflow: 'release.yml', refs: ['refs/heads/main'], scopes: ['demo'],
    }),
    (err) => err.code === 'publisher_conflict',
  );
  assert.throws(
    () => publishers.update('req_cccccccccccc', {
      repository: 'alice/demo', workflow: 'x.yml', refs: ['refs/heads/main'], scopes: ['demo'],
    }),
    (err) => err.code === 'publisher_not_found',
  );
  assert.throws(
    () => publishers.update(APPROVAL.requestId, {
      repository: 'not a repo', workflow: 'x.yml', refs: ['refs/heads/main'], scopes: ['demo'],
    }),
  );
  assert.equal(publishers.list().length, 2, 'a refused edit changes nothing');
});
