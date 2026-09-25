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
