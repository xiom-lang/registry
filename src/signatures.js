// XIOM Package Registry -- ed25519 signature verification.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
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

/** RFC 8410 PKCS8 prefix for a raw Ed25519 private seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Build an ed25519 private KeyObject from a 32-byte seed in hex (the shape
 * `xiom pkg keygen` writes) or a PKCS8 PEM string. Server-side use only
 * (C5 index signing); throws a plain Error on anything else so a bad boot
 * configuration fails fast instead of silently downgrading.
 */
function privateKeyFromSeed(seed) {
  const value = String(seed || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(value, 'hex')]),
      format: 'der',
      type: 'pkcs8',
    });
  }
  if (value.includes('BEGIN PRIVATE KEY')) {
    return crypto.createPrivateKey({ key: value, format: 'pem', type: 'pkcs8' });
  }
  throw new Error('ed25519 key must be a 32-byte hex seed or a PKCS8 PEM block');
}

/** Raw 32-byte hex public key for a private KeyObject. */
function publicKeyHexFromPrivate(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(ED25519_SPKI_PREFIX.length).toString('hex');
}

/** Sign bytes with an ed25519 private KeyObject; returns lowercase hex. */
function sign(privateKey, data) {
  return crypto.sign(null, data, privateKey).toString('hex');
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
  sign,
  fingerprint,
  publicKeyFromHex,
  privateKeyFromSeed,
  publicKeyHexFromPrivate,
  isValidPublicKeyHex,
  isValidSignatureHex,
  validateTokenKey,
};
