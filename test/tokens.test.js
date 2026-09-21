// XIOM Package Registry -- auth and token scope tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractToken,
  authenticate,
  tokenMayPublish,
  assertPublishScope,
  safeEqual,
} = require('../src/tokens');
const { UnauthorizedError, ForbiddenError } = require('../src/errors');

function request({ headers = {}, method = 'GET', query = {} } = {}) {
  return { headers, method, query };
}

test('Bearer header is the preferred source', () => {
  const req = request({ headers: { authorization: 'Bearer abc123', 'x-api-key': 'legacy' } });
  assert.deepEqual(extractToken(req), { token: 'abc123', source: 'bearer' });
});

test('Bearer matching is case-insensitive and trims whitespace', () => {
  assert.equal(extractToken(request({ headers: { authorization: 'bearer  xyz ' } })).token, 'xyz');
  assert.equal(extractToken(request({ headers: { authorization: 'BEARER\txyz' } })).token, 'xyz');
});

test('x-api-key and query parameters are legacy fallbacks', () => {
  assert.deepEqual(
    extractToken(request({ headers: { 'x-api-key': 'legacy' } })),
    { token: 'legacy', source: 'x-api-key' },
  );
  assert.deepEqual(
    extractToken(request({ query: { api_key: 'q' } })),
    { token: 'q', source: 'query' },
  );
  // Query tokens are never accepted for mutating methods.
  assert.equal(extractToken(request({ method: 'POST', query: { api_key: 'q' } })), null);
});

test('no credentials yields null', () => {
  assert.equal(extractToken(request()), null);
});

test('authenticate accepts a known token and rejects unknown/missing', () => {
  const tokens = new Map([
    ['good', { label: 'good', scopes: ['*'], trusted: true, firstParty: true }],
  ]);
  const ok = authenticate(request({ headers: { authorization: 'Bearer good' } }), tokens);
  assert.equal(ok.label, 'good');
  assert.equal(ok.firstParty, true);

  assert.throws(
    () => authenticate(request({ headers: { authorization: 'Bearer bad' } }), tokens),
    UnauthorizedError,
  );
  assert.throws(() => authenticate(request(), tokens), UnauthorizedError);
  assert.throws(() => authenticate(request(), new Map()), UnauthorizedError);
});

test('scopes are exact names, namespace prefixes, or ns.* globs', () => {
  const token = { scopes: ['xiom.core', 'my-lib'] };
  assert.equal(tokenMayPublish(token, 'xiom.core'), true);
  assert.equal(tokenMayPublish(token, 'xiom.core.extra'), true);
  assert.equal(tokenMayPublish(token, 'xiom.corex'), false);
  assert.equal(tokenMayPublish(token, 'my-lib'), true);
  assert.equal(tokenMayPublish(token, 'other'), false);
  assert.equal(tokenMayPublish({ scopes: ['*'] }, 'anything'), true);

  const glob = { scopes: ['xiom.*', 'other'] };
  assert.equal(tokenMayPublish(glob, 'xiom.allowed'), true, 'xiom.* grants the namespace');
  assert.equal(tokenMayPublish(glob, 'xiom'), false, 'xiom.* does not grant the bare name');
  assert.equal(tokenMayPublish(glob, 'xiomcore'), false);
  assert.equal(tokenMayPublish(glob, 'other'), true);
});

test('assertPublishScope throws ForbiddenError on mismatch', () => {
  assert.doesNotThrow(() => assertPublishScope({ scopes: ['a'], label: 't' }, 'a'));
  assert.throws(
    () => assertPublishScope({ scopes: ['a'], label: 't' }, 'b'),
    ForbiddenError,
  );
});

test('safeEqual compares correctly', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcdef'), false);
});
