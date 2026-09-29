#!/usr/bin/env node
// XIOM Package Registry -- index signing key helper (C5).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Generates the operator key that signs /index-digest.json, or derives the
// public key for an existing seed. The seed goes into the host environment
// as INDEX_SIGNING_KEY; the public key is what clients pin out of band.
//
// Usage:
//   node scripts/index-key.js                 # generate a new keypair
//   node scripts/index-key.js --from <seed>   # derive from an existing seed
//
// The seed never leaves stdout: it is not written to the repository, and the
// script stores nothing.

'use strict';

const crypto = require('crypto');

const { privateKeyFromSeed, publicKeyHexFromPrivate, fingerprint } = require('../src/signatures');

function main(argv) {
  let seed = '';
  if (argv[0] === '--from') {
    seed = String(argv[1] || '').trim();
    if (!seed) throw new Error('--from needs the 64-hex seed');
  } else if (argv.length > 0) {
    throw new Error(`unknown argument: ${argv[0]}`);
  } else {
    seed = crypto.randomBytes(32).toString('hex');
  }
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = publicKeyHexFromPrivate(privateKey);
  console.log(`INDEX_SIGNING_KEY=${seed}`);
  console.log(`index public key: ${publicKey}`);
  console.log(`fingerprint: ${fingerprint(publicKey)}`);
  console.log('');
  console.log('Set INDEX_SIGNING_KEY on the registry host (compose, then recreate) and give');
  console.log('the public key to whoever pins the index digest; keep the seed secret.');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
}

module.exports = {};
