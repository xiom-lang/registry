// XIOM Package Registry -- ed25519 signature verification.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The client (`crates/xiom-pkg/src/signing.rs`) signs with ed25519-dalek and
// publishes the 64-byte signature and 32-byte public key as lowercase hex.
// Node's crypto.verify supports ed25519 natively; the raw public key only
// needs the fixed SubjectPublicKeyInfo DER prefix that RFC 8410 specifies.

'use strict';

const crypto = require('crypto');

const { BadRequestError } = require('./errors');

/** RFC 8410 DER prefix for an Ed25519 SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const HEX_RE = /^[0-9a-fA-F]+$/;
const PUBLIC_KEY_HEX_LENGTH = 64; // 32 bytes
const SIGNATURE_HEX_LENGTH = 128; // 64 bytes

/** True when `value` is a well-formed hex ed25519 public key. */
function isValidPublicKeyHex(value) {
  return typeof value === 'string'
    && value.length === PUBLIC_KEY_HEX_LENGTH
    && HEX_RE.test(value);
}

/** True when `value` is a well-formed hex ed25519 signature. */
function isValidSignatureHex(value) {
  return typeof value === 'string'
    && value.length === SIGNATURE_HEX_LENGTH
    && HEX_RE.test(value);
}

/** Wrap a raw 32-byte ed25519 public key into a KeyObject. */
function publicKeyFromHex(publicKeyHex) {
  if (!isValidPublicKeyHex(publicKeyHex)) {
    throw new BadRequestError(
      'publicKey must be 32 bytes of hex (64 characters)',
      'invalid_public_key',
    );
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
  try {
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (err) {
    throw new BadRequestError(`publicKey is not a valid ed25519 key: ${err.message}`, 'invalid_public_key');
  }
}

/**
 * Verify a detached ed25519 signature over `data`.
 * Returns true/false; throws only on malformed inputs.
 *
 * @param {string} publicKeyHex
 * @param {Buffer} data exact signed bytes (the tarball)
 * @param {string} signatureHex
 * @returns {boolean}
 */
function verify(publicKeyHex, data, signatureHex) {
  if (!isValidSignatureHex(signatureHex)) {
    throw new BadRequestError(
      'signature must be 64 bytes of hex (128 characters)',
      'invalid_signature',
    );
  }
  const key = publicKeyFromHex(publicKeyHex);
  try {
    return crypto.verify(null, data, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Short human-comparable fingerprint, mirroring the client's format. */
function fingerprint(publicKeyHex) {
  if (!isValidPublicKeyHex(publicKeyHex)) return '<invalid>';
  return Buffer.from(publicKeyHex, 'hex')
    .subarray(0, 8)
    .toString('hex')
    .match(/.{2}/g)
    .join(':');
}

/**
 * Validate the (signature, publicKey) pair as stored in a version entry:
 * both empty (unsigned) or both well-formed hex. Throws BadRequestError.
 * Called by the index write path so malformed data never lands on disk.
 *
 * @param {string} signatureHex
 * @param {string} publicKeyHex
 */
function validateTokenKey(signatureHex, publicKeyHex) {
  const hasSignature = Boolean(signatureHex);
  const hasPublicKey = Boolean(publicKeyHex);
  if (hasSignature !== hasPublicKey) {
    throw new BadRequestError(
      'signature and publicKey must be stored together',
      'incomplete_signature',
    );
  }
  if (hasSignature && !isValidSignatureHex(signatureHex)) {
    throw new BadRequestError(
      'signature must be 64 bytes of hex (128 characters)',
      'invalid_signature',
    );
  }
  if (hasPublicKey && !isValidPublicKeyHex(publicKeyHex)) {
    throw new BadRequestError(
      'publicKey must be 32 bytes of hex (64 characters)',
      'invalid_public_key',
    );
  }
}

module.exports = {
  verify,
  fingerprint,
  publicKeyFromHex,
  isValidPublicKeyHex,
  isValidSignatureHex,
  validateTokenKey,
};
