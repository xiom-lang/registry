// XIOM Package Registry -- ed25519 signature verification tests.
// Copyright 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  verify,
  fingerprint,
  isValidPublicKeyHex,
  isValidSignatureHex,
  validateTokenKey,
} = require('../src/signatures');
const { BadRequestError } = require('../src/errors');

/** Build a raw ed25519 keypair the same way the client's keygen does. */
function keypair() {
  const seed = crypto.randomBytes(32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      // RFC 8410 PKCS#8 prefix for Ed25519.
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    publicKeyHex: publicKeyDer.subarray(publicKeyDer.length - 32).toString('hex'),
    privateKey,
  };
}

function sign(privateKey, data) {
  return crypto.sign(null, data, privateKey).toString('hex');
}

test('valid signature verifies; tampered bytes and wrong keys fail', () => {
  const { publicKeyHex, privateKey } = keypair();
  const data = Buffer.from('exact tarball bytes');
  const signature = sign(privateKey, data);

  assert.equal(verify(publicKeyHex, data, signature), true);
  assert.equal(verify(publicKeyHex, Buffer.from('exact tarball bytez'), signature), false);

  const other = keypair();
  assert.equal(verify(other.publicKeyHex, data, signature), false);
});

test('uppercase hex inputs are accepted', () => {
  const { publicKeyHex, privateKey } = keypair();
  const data = Buffer.from('payload');
  const signature = sign(privateKey, data);
  assert.equal(verify(publicKeyHex.toUpperCase(), data, signature.toUpperCase()), true);
});

test('malformed inputs are rejected with typed errors', () => {
  const data = Buffer.from('payload');
  assert.throws(() => verify('not-hex', data, '00'.repeat(64)), BadRequestError);
  assert.throws(() => verify('ab'.repeat(32), data, '00'), BadRequestError);
  assert.throws(() => verify('ab'.repeat(31), data, '00'.repeat(64)), BadRequestError);
});

test('hex format validators', () => {
  assert.equal(isValidPublicKeyHex('a1'.repeat(32)), true);
  assert.equal(isValidPublicKeyHex('a1'.repeat(31)), false);
  assert.equal(isValidPublicKeyHex('zz'.repeat(32)), false);
  assert.equal(isValidSignatureHex('a1'.repeat(64)), true);
  assert.equal(isValidSignatureHex('a1'.repeat(63)), false);
});

test('fingerprint matches the client format', () => {
  assert.equal(fingerprint('ab'.repeat(32)), 'ab:ab:ab:ab:ab:ab:ab:ab');
  assert.equal(fingerprint('nope'), '<invalid>');
});

test('validateTokenKey enforces the pair invariant', () => {
  assert.doesNotThrow(() => validateTokenKey('', ''));
  assert.doesNotThrow(() => validateTokenKey('ab'.repeat(64), 'cd'.repeat(32)));
  assert.throws(() => validateTokenKey('ab'.repeat(64), ''), BadRequestError);
  assert.throws(() => validateTokenKey('', 'cd'.repeat(32)), BadRequestError);
  assert.throws(() => validateTokenKey('xyz', 'cd'.repeat(32)), BadRequestError);
});
