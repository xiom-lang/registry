// XIOM Package Registry -- the index digest sidecar (C5, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// `GET /index-digest.json` describes the exact bytes `GET /index.json`
// serves: their sha256, size, and -- when an operator key is configured --
// an ed25519 signature over a domain-separated payload. The digest is
// derived at request time: /index.json itself is never touched, no field is
// added to it, and nothing is persisted. Clients that pin the registry index
// public key (out of band, like package keys) can detect a mirror or CDN
// swapping the document; without the key the endpoint still gives a stable
// change-detection digest.
//
// The signature commits to `xiom-index-digest:v1\n<sha256>`, never to the
// index bytes directly, so the same key can never be mistaken for a package
// signing key in another protocol.

'use strict';

const crypto = require('crypto');

const {
  sign,
  fingerprint,
  privateKeyFromSeed,
  publicKeyHexFromPrivate,
} = require('./signatures');

const INDEX_DIGEST_VERSION = 1;
const INDEX_DIGEST_CONTEXT = 'xiom-index-digest:v1';

/** The exact bytes the signature commits to (domain-separated). */
function digestPayload(sha256) {
  return Buffer.from(`${INDEX_DIGEST_CONTEXT}\n${String(sha256)}`, 'utf-8');
}

/**
 * Build the boot-time index signer. Empty configuration returns null (the
 * digest endpoint then serves the unsigned digest only); a malformed key
 * throws so a bad deploy fails fast rather than silently downgrading.
 *
 * @param {string} seed 64-hex ed25519 seed or PKCS8 PEM, from INDEX_SIGNING_KEY
 * @returns {{ publicKey: string, fingerprint: string, sign: Function }|null}
 */
function createIndexSigner(seed) {
  const value = String(seed || '').trim();
  if (!value) return null;
  const privateKey = privateKeyFromSeed(value);
  const publicKey = publicKeyHexFromPrivate(privateKey);
  return {
    publicKey,
    fingerprint: fingerprint(publicKey),
    sign: (data) => sign(privateKey, data),
  };
}

/**
 * Describe the exact index document bytes.
 *
 * @param {{ bytes: Buffer|string, registry?: string, signer?: object|null,
 *           at?: Date }} input
 */
function indexDigest({ bytes, registry = '', signer = null, at = new Date() }) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '', 'utf-8');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const digest = {
    version: INDEX_DIGEST_VERSION,
    algorithm: 'sha256',
    sha256,
    bytes: buffer.length,
    registry: String(registry),
    signedAt: new Date(at).toISOString(),
  };
  if (signer) {
    digest.signatureAlgorithm = 'ed25519';
    digest.publicKey = signer.publicKey;
    digest.publicKeyFingerprint = signer.fingerprint;
    digest.signature = signer.sign(digestPayload(sha256));
  }
  return digest;
}

module.exports = {
  indexDigest,
  digestPayload,
  createIndexSigner,
  INDEX_DIGEST_VERSION,
  INDEX_DIGEST_CONTEXT,
};
