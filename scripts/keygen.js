#!/usr/bin/env node
// XIOM Package Registry -- publish token generator.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Usage:
//   node scripts/keygen.js [--label name] [--scopes a,b,*] [--trusted]
//                          [--first-party] [--out tokens.json] [--replace]
//
// Append a TOKENS_FILE entry (creating the file if needed). `--replace`
// overwrites an existing file instead of appending, which is what token
// rotation wants for a single-token file. For multi-token files prefer the
// admin CLI (`scripts/tokens.js rotate`), which replaces one label in a
// single atomic write and refuses to leave duplicates behind.
// The token is 32 random bytes of hex; the registry compares tokens in
// constant time, so the format only matters for entropy.

'use strict';

const crypto = require('crypto');
const path = require('path');

const { loadTokens, saveTokens } = require('./lib/token-file');

function parseArgs(argv) {
  const args = {
    label: 'publisher',
    scopes: ['*'],
    trusted: false,
    firstParty: false,
    out: path.join(process.cwd(), 'tokens.json'),
    replace: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') args.label = argv[++i];
    else if (arg === '--scopes') args.scopes = String(argv[++i] || '*').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--trusted') args.trusted = true;
    else if (arg === '--first-party') args.firstParty = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--replace') args.replace = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let existing;
  try {
    existing = loadTokens(args.out);
  } catch (err) {
    console.error(`refusing to overwrite ${args.out}: ${err.message}`);
    process.exit(1);
  }

  const tokens = args.replace ? [] : existing;
  if (!args.replace && existing.length > 0) {
    console.log(
      `appending to ${args.out} (${existing.length} existing token(s)); `
      + 'use --replace to rotate the file instead',
    );
  }
  if (!args.replace) {
    const sameLabel = existing.filter((entry) => entry.label === args.label).length;
    if (sameLabel > 0) {
      // The documented rotation recipe is append-then-remove-old on a
      // multi-token file, so this must not be a hard error -- but two live
      // tokens under one label is how a "rotated" secret quietly stays
      // valid. Make it loud and say what to do.
      console.warn(
        `WARNING: label "${args.label}" already exists (${sameLabel} `
        + `entr${sameLabel === 1 ? 'y' : 'ies'}). Both tokens stay valid until the old `
        + 'entry is removed: delete the older one, then recreate the container '
        + '(ops REGISTRY_TOKENS.md section 6). Only the last entry for a label '
        + 'is the one you just minted.',
      );
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  tokens.push({
    token,
    label: args.label,
    scopes: args.scopes,
    trusted: args.trusted,
    firstParty: args.firstParty,
  });
  saveTokens(args.out, tokens);

  console.log(`Token written to ${args.out}${args.replace ? ' (replaced)' : ''}`);
  console.log(`  label:      ${args.label}`);
  console.log(`  scopes:     ${args.scopes.join(', ')}`);
  console.log(`  trusted:    ${args.trusted}`);
  console.log(`  firstParty: ${args.firstParty}`);
  console.log(`  token:      ${token}`);
  console.log('');
  console.log(`Mount file content now has ${tokens.length} token(s).`);
  console.log(`Set TOKENS_FILE=${args.out} for the registry process.`);
  console.log('On the VPS the container reads it as UID 1000: '
    + 'chown 1000:1000 ' + args.out + ' && chmod 600 ' + args.out);
}

main();
