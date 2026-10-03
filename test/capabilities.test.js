// Capability matrix unit tests (registry 2.12+).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { capabilitiesFor, hasCapability, ROLES } = require('../src/capabilities');

test('the capability matrix is cumulative and founding holds everything', () => {
  const reviewer = capabilitiesFor('reviewer');
  const supervisor = capabilitiesFor('supervisor');
  const admin = capabilitiesFor('admin');

  for (const cap of reviewer) {
    assert.ok(supervisor.has(cap), `supervisor inherits ${cap}`);
  }
  for (const cap of supervisor) {
    assert.ok(admin.has(cap), `admin inherits ${cap}`);
  }

  assert.equal(hasCapability('founding', 'work.assign'), true);
  assert.equal(hasCapability('founding', 'anything.at.all'), true);
  assert.equal(hasCapability('member', 'work.claim'), false);
  assert.equal(hasCapability('reviewer', 'request.decide'), false);
  assert.equal(hasCapability('reviewer', 'work.claim'), true);
  assert.equal(hasCapability('supervisor', 'work.assign'), true);
  assert.equal(hasCapability('supervisor', 'request.decide'), false);
  assert.equal(hasCapability('supervisor', 'package.moderate'), false);
  assert.equal(hasCapability('supervisor', 'user.manage'), false);
  assert.equal(hasCapability('supervisor', 'role.grant'), false);
  assert.equal(hasCapability('admin', 'request.decide'), true);
  assert.equal(hasCapability('admin', 'user.manage'), true);
  assert.deepEqual(ROLES, ['member', 'reviewer', 'supervisor', 'admin', 'founding']);
});
