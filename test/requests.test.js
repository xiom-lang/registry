// XIOM Package Registry -- request queue store tests (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RequestStore, MAX_PENDING_PER_REQUESTER } = require('../src/requests');

const REQUESTER = { githubId: '4242', login: 'alice' };

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-requests-'));
  return new RequestStore({ path: path.join(dir, 'requests.json') });
}

test('creates a token request, normalizes scopes, and persists it', () => {
  const requests = store();
  const created = requests.create({
    kind: 'token',
    requester: REQUESTER,
    scopes: 'my-lib, my-ns.* , my-lib',
    note: 'for the release job',
  });
  assert.match(created.id, /^req_[0-9a-f]{12}$/);
  assert.deepEqual(created.scopes, ['my-lib', 'my-ns']);
  assert.equal(created.status, 'pending');
  assert.equal(created.history[0].action, 'created');
  assert.equal(created.history[0].actor, 'alice');

  // A fresh store reads the same record back from disk.
  const reloaded = new RequestStore({ path: requests.path });
  assert.deepEqual(reloaded.get(created.id), created);
});

test('rejects wildcard, invalid, and empty scopes', () => {
  const requests = store();
  const create = (scopes) => requests.create({ kind: 'token', requester: REQUESTER, scopes });
  assert.throws(() => create('*'), /cannot be requested/);
  assert.throws(() => create('Bad_Name'), /invalid package name/);
  assert.throws(() => create(''), /at least one package name/);
  assert.throws(() => create('a,b,c,d,e,f,g,h,i'), /at most 8 scopes/);
});

test('creates a trusted-publisher request with loader validation', () => {
  const requests = store();
  const created = requests.create({
    kind: 'publisher',
    requester: REQUESTER,
    scopes: 'my-lib',
    repository: 'alice/my-lib',
    workflow: 'publish.yml',
    refs: 'refs/heads/main, refs/tags/v*',
  });
  assert.equal(created.kind, 'publisher');
  assert.equal(created.repository, 'alice/my-lib');
  assert.equal(created.workflow, 'publish.yml');
  assert.deepEqual(created.refs, ['refs/heads/main', 'refs/tags/v*']);

  assert.throws(() => requests.create({
    kind: 'publisher',
    requester: REQUESTER,
    scopes: 'my-lib',
    repository: 'not-a-repo',
    workflow: 'publish.yml',
    refs: 'refs/heads/main',
  }), /owner\/repo/);
  assert.throws(() => requests.create({
    kind: 'publisher',
    requester: REQUESTER,
    scopes: 'my-lib',
    repository: 'alice/my-lib',
    workflow: 'publish.yml',
    refs: '',
  }), /refs/);
});

test('decision and fulfilment transitions append to the audit history', () => {
  const requests = store();
  const created = requests.create({ kind: 'token', requester: REQUESTER, scopes: 'my-lib' });

  assert.throws(() => requests.fulfil(created.id, { actor: 'root' }), /only approved/);
  const approved = requests.decide(created.id, { action: 'approve', actor: 'root', note: 'looks fine' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedBy, 'root');
  assert.deepEqual(approved.history.map((entry) => entry.action), ['created', 'approved']);

  assert.throws(() => requests.decide(created.id, { action: 'deny', actor: 'root' }), /already approved/);
  const fulfilled = requests.fulfil(created.id, { actor: 'root', reference: 'emailed label alice' });
  assert.equal(fulfilled.status, 'fulfilled');
  assert.equal(fulfilled.mintReference, 'emailed label alice');
  assert.deepEqual(fulfilled.history.map((entry) => entry.action), ['created', 'approved', 'fulfilled']);
  assert.equal(fulfilled.history[1].note, 'looks fine');
});

test('denied requests cannot be fulfilled', () => {
  const requests = store();
  const created = requests.create({ kind: 'token', requester: REQUESTER, scopes: 'my-lib' });
  requests.decide(created.id, { action: 'deny', actor: 'root' });
  assert.throws(() => requests.fulfil(created.id, { actor: 'root' }), /only approved/);
});

test('pending requests are capped per requester', () => {
  const requests = store();
  for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
    requests.create({ kind: 'token', requester: REQUESTER, scopes: `pkg-${i}` });
  }
  assert.throws(
    () => requests.create({ kind: 'token', requester: REQUESTER, scopes: 'one-more' }),
    /already have .* pending/,
  );
  // Another requester is unaffected.
  assert.ok(requests.create({
    kind: 'token',
    requester: { githubId: '7', login: 'bob' },
    scopes: 'bob-lib',
  }));
});

test('list filters by status and requester, newest first', () => {
  const requests = store();
  const alice = requests.create({ kind: 'token', requester: REQUESTER, scopes: 'a' });
  const bob = requests.create({
    kind: 'token',
    requester: { githubId: '7', login: 'bob' },
    scopes: 'b',
  });
  requests.decide(bob.id, { action: 'approve', actor: 'root' });

  assert.equal(requests.list({ status: 'pending' }).length, 1);
  assert.equal(requests.list({ requesterId: '7' })[0].id, bob.id);
  assert.equal(requests.list({ status: 'pending' })[0].id, alice.id);
  assert.throws(() => requests.get('req_000000000000'), /not found/);
});

test('malformed persisted records are dropped on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-requests-'));
  const file = path.join(dir, 'requests.json');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.0.0',
    requests: {
      req_aaaaaaaaaaaa: {
        id: 'req_aaaaaaaaaaaa',
        kind: 'token',
        status: 'pending',
        requester: { githubId: '5', login: 'carol' },
        scopes: ['carol-lib'],
        createdAt: '2026-09-25T00:00:00.000Z',
        history: [{ at: '2026-09-25T00:00:00.000Z', actor: 'carol', action: 'created' }],
      },
      'not-an-id': { kind: 'token', status: 'pending' },
      req_bbbbbbbbbbbb: { kind: 'nope', status: 'pending' },
    },
  }));
  const requests = new RequestStore({ path: file });
  assert.deepEqual(requests.list().map((entry) => entry.id), ['req_aaaaaaaaaaaa']);
});
