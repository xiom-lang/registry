// XIOM Package Registry -- ownership claims store and derivation tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  OwnershipStore,
  deriveMaintainers,
  maintainerView,
} = require('../src/ownership');

function sandboxPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-ownership-')), 'ownership.json');
}

const PKG = {
  versions: {
    '1.0.0': {
      published: '2026-09-01T00:00:00.000Z',
      publisher: { repository: 'octocat/my-lib' },
    },
  },
};

const REQUESTS = [
  {
    id: 'req_bbbb33334444',
    kind: 'publisher',
    status: 'fulfilled',
    requester: { githubId: '777', login: 'carol' },
    repository: 'carol/other-lib',
    scopes: ['my-lib'],
    decidedAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'req_cccc55556666',
    kind: 'token',
    status: 'fulfilled',
    requester: { githubId: '888', login: 'dave' },
    scopes: ['my-lib'],
    decidedAt: '2026-09-03T00:00:00.000Z',
  },
  {
    id: 'req_dddd77778888',
    kind: 'token',
    status: 'denied',
    requester: { githubId: '999', login: 'erin' },
    scopes: ['my-lib'],
  },
  {
    id: 'req_eeee99990000',
    kind: 'token',
    status: 'approved',
    requester: { githubId: '111', login: 'frank' },
    scopes: ['other-lib'],
  },
];

test('deriveMaintainers combines provenance, approved publishers, and fulfilled tokens', () => {
  const publishers = [{
    requestId: 'req_bbbb33334444',
    repository: 'carol/other-lib',
    scopes: ['my-lib'],
    approvedAt: '2026-09-02T00:00:00.000Z',
  }];
  const derived = deriveMaintainers('my-lib', PKG, { requests: REQUESTS, publishers });
  const logins = derived.map((entry) => entry.login);
  assert.deepEqual(logins, ['octocat', 'carol', 'dave'], 'provenance first, then approved sources');

  const octocat = derived.find((entry) => entry.login === 'octocat');
  assert.deepEqual(octocat.sources, ['provenance']);
  assert.deepEqual(octocat.repositories, ['octocat/my-lib']);

  // The publisher entry contributes both the repository owner and the
  // requester joined through the request id.
  const carol = derived.find((entry) => entry.login === 'carol');
  assert.deepEqual(carol.sources, ['trusted-publisher']);

  // A denied request and an uncovered scope contribute nobody.
  assert.equal(derived.filter((entry) => entry.login === 'erin').length, 0);
  assert.equal(derived.filter((entry) => entry.login === 'frank').length, 0);
});

test('maintainerView publishes verified claims and scopes pending ones to viewer and reviewers', () => {
  const claims = {
    1: { githubId: '1', login: 'alice', status: 'verified', claimedAt: 'a', decidedBy: 'rev', decidedAt: 'b', history: [] },
    2: { githubId: '2', login: 'bob', status: 'pending', claimedAt: 'c', history: [] },
    3: { githubId: '3', login: 'mallory', status: 'rejected', claimedAt: 'd', note: 'no evidence', history: [] },
  };
  const base = { packageName: 'my-lib', pkg: { versions: {} }, claims };

  const anonymous = maintainerView({ ...base, viewer: null, reviewer: false });
  assert.deepEqual(anonymous.maintainers.map((entry) => entry.login), ['alice']);
  assert.deepEqual(anonymous.maintainers[0].sources, ['verified-claim']);
  assert.equal(anonymous.pending.length, 0);
  assert.equal(anonymous.rejected.length, 0);
  assert.equal(anonymous.signedIn, false);
  assert.equal(anonymous.canClaim, false);

  const bob = maintainerView({ ...base, viewer: { githubId: '2', login: 'bob' }, reviewer: false });
  assert.equal(bob.pending.length, 1);
  assert.equal(bob.pending[0].login, 'bob');
  assert.equal(bob.viewerClaim.status, 'pending');
  assert.equal(bob.canClaim, false, 'a live claim blocks a second one');

  const mallory = maintainerView({ ...base, viewer: { githubId: '3', login: 'mallory' }, reviewer: false });
  assert.equal(mallory.rejected.length, 1, 'claimants see their own rejection');
  assert.equal(mallory.canClaim, true, 'a rejected claim may be filed again');

  const reviewer = maintainerView({ ...base, viewer: { githubId: '9', login: 'rev' }, reviewer: true });
  assert.equal(reviewer.pending.length, 1);
  assert.equal(reviewer.rejected.length, 1);
  assert.equal(reviewer.canClaim, true);
});

test('claims store: lifecycle, persistence, and guards', () => {
  const file = sandboxPath();
  const store = new OwnershipStore({ path: file });
  const alice = { githubId: '1', login: 'alice' };
  const rev = { githubId: '9', login: 'rev' };

  const claim = store.claim('my-lib', { user: alice });
  assert.equal(claim.status, 'pending');
  assert.ok(fs.existsSync(file));

  // One live claim per account per package.
  assert.throws(() => store.claim('my-lib', { user: alice }), /already have a maintainer claim/);

  // Decisions require a pending claim and a rejection reason.
  assert.throws(() => store.decide('my-lib', '2', { actor: 'rev', status: 'verified' }), /not found/);
  assert.throws(() => store.decide('my-lib', '1', { actor: 'rev', status: 'rejected' }), /reason is required/);
  assert.throws(() => store.decide('my-lib', '1', { actor: 'rev', status: 'maybe' }), /verified.*rejected/);

  const verified = store.decide('my-lib', '1', { actor: 'rev', status: 'verified' });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.decidedBy, 'rev');
  assert.deepEqual(verified.history.map((entry) => entry.action), ['claimed', 'verified']);

  // A different account cannot re-decide it.
  assert.throws(() => store.decide('my-lib', '1', { actor: 'rev', status: 'rejected' }), /already verified/);

  // Reload from disk: same state, and the pending count works.
  const reloaded = new OwnershipStore({ path: file });
  assert.equal(reloaded.claimFor('my-lib', '1').status, 'verified');
  assert.equal(reloaded.pendingCount(), 0);

  // Reject then re-claim: the history keeps the full trail.
  const bob = { githubId: '2', login: 'bob' };
  store.claim('my-lib', { user: bob });
  store.decide('my-lib', '2', { actor: 'rev', status: 'rejected', note: 'not the owner' });
  assert.equal(store.pendingCount(), 0);
  const again = store.claim('my-lib', { user: bob });
  assert.equal(again.status, 'pending');
  assert.deepEqual(again.history.map((entry) => entry.action), ['claimed', 'rejected', 'claimed']);
  assert.equal(store.pendingCount(), 1);
});

test('claims store normalizes malformed on-disk entries and rejects bad names', () => {
  const file = sandboxPath();
  fs.writeFileSync(file, JSON.stringify({
    version: '1.0.0',
    claims: {
      'my-lib': {
        1: { githubId: '1', login: 'alice', status: 'pending', claimedAt: 'x', history: [] },
        2: { githubId: '2', login: '', status: 'pending' },
        3: { login: 'carl', status: 'sideways' },
      },
      'Not A Name': { 4: { githubId: '4', login: 'dave', status: 'pending' } },
    },
  }));
  const store = new OwnershipStore({ path: file });
  assert.equal(store.listClaims().length, 1);
  assert.equal(store.listClaims()[0].login, 'alice');
  assert.throws(() => store.claim('Bad Name', { user: { githubId: '1', login: 'alice' } }), /not a package name/);
  assert.throws(() => store.claim('my-lib', { user: { githubId: 'x', login: '' } }), /signed-in GitHub account/);
});
