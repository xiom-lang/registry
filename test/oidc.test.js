// XIOM Package Registry -- OIDC verification tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// No network: every test uses a locally generated RSA keypair and a fake
// JWKS fetch, so claim rules, the signature check, and the cache behavior
// are deterministic.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  GITHUB_OIDC_ISSUER,
  splitJwt,
  verifyJwt,
  validateClaims,
  createJwksCache,
} = require('../src/oidc');

const AUDIENCE = 'xiom-registry';

function makeKeypair(kid = 'test-kid-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function makeToken({ header, payload, privateKey }) {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf-8'), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function makePayload(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUDIENCE,
    exp: nowSec + 300,
    nbf: nowSec - 10,
    iat: nowSec,
    sub: 'repo:xiom-lang/stdlib:ref:refs/tags/stdlib-v0.61.0',
    repository: 'xiom-lang/stdlib',
    workflow_ref: 'xiom-lang/stdlib/.github/workflows/publish-registry.yml@refs/tags/stdlib-v0.61.0',
    ref: 'refs/tags/stdlib-v0.61.0',
    event_name: 'push',
    run_id: '1234567890',
    ...overrides,
  };
}

function fakeJwks(keys, { fail = false } = {}) {
  const calls = { count: 0 };
  const fetchFn = async () => {
    calls.count++;
    if (fail) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ keys }) };
  };
  return { fetchFn, calls };
}

function cacheWith(keypair, options = {}) {
  const { fetchFn, calls } = fakeJwks([keypair.jwk], options);
  const jwks = createJwksCache({ fetchFn, ...(options.cache || {}) });
  return { jwks, calls };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, 401, `expected 401 for ${code}, got ${err.status}`);
    assert.equal(err.code, code);
    assert.ok(!String(err.message).includes('eyJ'), 'error message must not echo the token');
    return true;
  });
}

test('verifyJwt accepts a well-formed GitHub Actions token', async () => {
  const keypair = makeKeypair();
  const { jwks } = cacheWith(keypair);
  const payload = makePayload();
  const token = makeToken({ header: { alg: 'RS256', kid: keypair.jwk.kid, typ: 'JWT' }, payload, privateKey: keypair.privateKey });

  const result = await verifyJwt(token, { jwks, audience: AUDIENCE });
  assert.equal(result.payload.repository, 'xiom-lang/stdlib');
  assert.equal(result.payload.ref, 'refs/tags/stdlib-v0.61.0');
  assert.equal(result.header.kid, keypair.jwk.kid);
});

test('a token signed by another key fails', async () => {
  const keypair = makeKeypair();
  const attacker = makeKeypair('attacker-kid');
  const { jwks } = cacheWith(keypair);
  const token = makeToken({
    header: { alg: 'RS256', kid: keypair.jwk.kid },
    payload: makePayload(),
    privateKey: attacker.privateKey,
  });
  await rejectsWith(verifyJwt(token, { jwks, audience: AUDIENCE }), 'oidc_signature_invalid');
});

test('a tampered payload fails the signature check', async () => {
  const keypair = makeKeypair();
  const { jwks } = cacheWith(keypair);
  const token = makeToken({
    header: { alg: 'RS256', kid: keypair.jwk.kid },
    payload: makePayload(),
    privateKey: keypair.privateKey,
  });
  const [head, , signature] = token.split('.');
  const tampered = `${head}.${b64urlJson(makePayload({ repository: 'evil/repo' }))}.${signature}`;
  await rejectsWith(verifyJwt(tampered, { jwks, audience: AUDIENCE }), 'oidc_signature_invalid');
});

test('non-RS256 algorithms are rejected before any key is used', async () => {
  const keypair = makeKeypair();
  const { jwks, calls } = cacheWith(keypair);
  for (const alg of ['none', 'HS256', 'RS512', 'ES256']) {
    const token = makeToken({
      header: { alg, kid: keypair.jwk.kid },
      payload: makePayload(),
      privateKey: keypair.privateKey,
    });
    await rejectsWith(verifyJwt(token, { jwks, audience: AUDIENCE }), 'unsupported_oidc_alg');
  }
  assert.equal(calls.count, 0, 'no JWKS fetch happens for an unsupported alg');
});

test('claim rules: issuer, audience (string and array), expiry and nbf skew', async () => {
  const keypair = makeKeypair();
  const { jwks } = cacheWith(keypair);
  const header = { alg: 'RS256', kid: keypair.jwk.kid };
  const sign = (payload) => makeToken({ header, payload, privateKey: keypair.privateKey });

  await rejectsWith(
    verifyJwt(sign(makePayload({ iss: 'https://evil.example' })), { jwks, audience: AUDIENCE }),
    'oidc_issuer_mismatch',
  );
  await rejectsWith(
    verifyJwt(sign(makePayload({ aud: 'someone-else' })), { jwks, audience: AUDIENCE }),
    'oidc_audience_mismatch',
  );
  await rejectsWith(
    verifyJwt(sign(makePayload({ aud: ['a', 'b'] })), { jwks, audience: AUDIENCE }),
    'oidc_audience_mismatch',
  );

  const arrayAud = makePayload({ aud: ['other', AUDIENCE] });
  const accepted = await verifyJwt(sign(arrayAud), { jwks, audience: AUDIENCE, now: Date.now() });
  assert.deepEqual(accepted.payload.aud, ['other', AUDIENCE]);

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  await rejectsWith(
    verifyJwt(sign(makePayload({ exp: nowSec - 120 })), { jwks, audience: AUDIENCE, now }),
    'oidc_token_expired',
  );
  const skewed = await verifyJwt(
    sign(makePayload({ exp: nowSec - 30 })),
    { jwks, audience: AUDIENCE, now, skewSeconds: 60 },
  );
  assert.ok(skewed.payload.exp < nowSec, 'token inside the 60s skew window still verifies');
  await rejectsWith(
    verifyJwt(sign(makePayload({ nbf: nowSec + 600 })), { jwks, audience: AUDIENCE, now }),
    'oidc_token_not_yet_valid',
  );
  await rejectsWith(
    verifyJwt(sign(makePayload({ exp: undefined })), { jwks, audience: AUDIENCE, now }),
    'oidc_token_expired',
  );
});

test('malformed tokens are 401 with a stable code', async () => {
  const keypair = makeKeypair();
  const { jwks } = cacheWith(keypair);
  for (const token of ['', 'x', 'a.b', 'a.b.c.d', 'not.a.jwt!']) {
    await rejectsWith(verifyJwt(token, { jwks, audience: AUDIENCE }), 'invalid_oidc_token');
  }
  assert.throws(() => splitJwt(null), (err) => err.code === 'invalid_oidc_token');
});

test('unknown kid fails closed; a successful refresh picks up a rotated key', async () => {
  const first = makeKeypair('kid-1');
  const second = makeKeypair('kid-2');
  const { jwks, calls } = cacheWith(first);

  // kid-2 is unknown: the cache refetches, and the JWKS still only has kid-1.
  const token2 = makeToken({
    header: { alg: 'RS256', kid: 'kid-2' },
    payload: makePayload(),
    privateKey: second.privateKey,
  });
  await rejectsWith(verifyJwt(token2, { jwks, audience: AUDIENCE }), 'unknown_oidc_key');
  assert.equal(calls.count, 1);

  // GitHub rotates: the next unknown kid triggers a refetch that includes it.
  const rotated = fakeJwks([first.jwk, second.jwk]);
  const rotatingCache = createJwksCache({ fetchFn: rotated.fetchFn });
  await verifyJwt(token2, { jwks: rotatingCache, audience: AUDIENCE });
  assert.equal(rotated.calls.count, 1);
});

test('JWKS fetch failure never makes a signature check pass', async () => {
  const keypair = makeKeypair();
  const failing = fakeJwks([], { fail: true });
  const noCache = createJwksCache({ fetchFn: failing.fetchFn });
  const token = makeToken({
    header: { alg: 'RS256', kid: keypair.jwk.kid },
    payload: makePayload(),
    privateKey: keypair.privateKey,
  });
  await rejectsWith(verifyJwt(token, { jwks: noCache, audience: AUDIENCE }), 'jwks_unavailable');

  // With a cached key, a later fetch failure serves the cached set: the
  // signature check still decides, it is never skipped or bypassed.
  let failNext = false;
  const flaky = async () => {
    if (failNext) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ keys: [keypair.jwk] }) };
  };
  const cache = createJwksCache({ fetchFn: flaky, ttlMs: 0 });
  await verifyJwt(token, { jwks: cache, audience: AUDIENCE });
  failNext = true;
  const verified = await verifyJwt(token, { jwks: cache, audience: AUDIENCE });
  assert.equal(verified.payload.repository, 'xiom-lang/stdlib');

  const attacker = makeKeypair('attacker-kid');
  const badToken = makeToken({
    header: { alg: 'RS256', kid: keypair.jwk.kid },
    payload: makePayload(),
    privateKey: attacker.privateKey,
  });
  await rejectsWith(verifyJwt(badToken, { jwks: cache, audience: AUDIENCE }), 'oidc_signature_invalid');
});

test('JWKS cache: TTL refetch, single-flight, and no unbounded growth', async () => {
  const keypair = makeKeypair();
  const { fetchFn, calls } = fakeJwks([keypair.jwk]);
  let clock = 1_000_000;
  const jwks = createJwksCache({ fetchFn, now: () => clock, ttlMs: 1000 });
  const token = makeToken({
    header: { alg: 'RS256', kid: keypair.jwk.kid },
    payload: makePayload(),
    privateKey: keypair.privateKey,
  });

  await verifyJwt(token, { jwks, audience: AUDIENCE });
  await verifyJwt(token, { jwks, audience: AUDIENCE });
  assert.equal(calls.count, 1, 'a fresh cache serves the second verification');

  clock += 5000;
  await verifyJwt(token, { jwks, audience: AUDIENCE });
  assert.equal(calls.count, 2, 'a stale cache refetches');

  const cold = fakeJwks([keypair.jwk]);
  const coldCache = createJwksCache({ fetchFn: cold.fetchFn });
  await Promise.all([
    verifyJwt(token, { jwks: coldCache, audience: AUDIENCE }),
    verifyJwt(token, { jwks: coldCache, audience: AUDIENCE }),
    verifyJwt(token, { jwks: coldCache, audience: AUDIENCE }),
  ]);
  assert.equal(cold.calls.count, 1, 'concurrent misses share one refresh');

  const manyKeys = Array.from({ length: 50 }, (_, i) => ({ ...keypair.jwk, kid: `kid-${i}` }));
  const capped = createJwksCache({ fetchFn: fakeJwks(manyKeys).fetchFn, maxKeys: 8 });
  await capped.getKey('kid-0');
  assert.equal(capped._size(), 8, 'the cache is capped');
});

test('validateClaims is usable on its own and rejects missing claims', () => {
  const now = Date.now();
  assert.throws(
    () => validateClaims({ aud: AUDIENCE, exp: now / 1000 + 10 }, { audience: AUDIENCE, now }),
    (err) => err.code === 'oidc_issuer_mismatch',
  );
  assert.throws(
    () => validateClaims({ iss: GITHUB_OIDC_ISSUER, exp: now / 1000 + 10 }, { audience: AUDIENCE, now }),
    (err) => err.code === 'oidc_audience_mismatch',
  );
  const ok = validateClaims(
    { iss: GITHUB_OIDC_ISSUER, aud: AUDIENCE, exp: now / 1000 + 10 },
    { audience: AUDIENCE, now },
  );
  assert.equal(ok.aud, AUDIENCE);
});
