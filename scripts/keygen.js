#!/usr/bin/env node
// XIOM Package Registry -- publish token generator.
// Copyright 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Usage:
//   node scripts/keygen.js [--label name] [--scopes a,b,*] [--trusted]
//                          [--first-party] [--out tokens.json]
//
// Append (or create) a TOKENS_FILE entry. The token itself is 32 random
// bytes of hex; the registry compares tokens in constant time, so the
// format only matters for entropy.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    label: 'publisher',
    scopes: ['*'],
    trusted: false,
    firstParty: false,
    out: path.join(process.cwd(), 'tokens.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') args.label = argv[++i];
    else if (arg === '--scopes') args.scopes = String(argv[++i] || '*').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--trusted') args.trusted = true;
    else if (arg === '--first-party') args.firstParty = true;
    else if (arg === '--out') args.out = argv[++i];
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function loadExisting(outPath) {
  if (!fs.existsSync(outPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tokens)) return parsed.tokens;
    if (parsed && parsed.tokens && typeof parsed.tokens === 'object') {
      return Object.entries(parsed.tokens).map(([token, cfg]) => ({ token, ...(cfg || {}) }));
    }
    throw new Error('unrecognized structure');
  } catch (err) {
    console.error(`refusing to overwrite ${outPath}: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokens = loadExisting(args.out);
  const token = crypto.randomBytes(32).toString('hex');
  tokens.push({
    token,
    label: args.label,
    scopes: args.scopes,
    trusted: args.trusted,
    firstParty: args.firstParty,
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(tokens, null, 2)}\n`, 'utf-8');
  console.log(`Token written to ${args.out}`);
  console.log(`  label:      ${args.label}`);
  console.log(`  scopes:     ${args.scopes.join(', ')}`);
  console.log(`  trusted:    ${args.trusted}`);
  console.log(`  firstParty: ${args.firstParty}`);
  console.log(`  token:      ${token}`);
  console.log('');
  console.log('Set TOKENS_FILE=' + args.out + ' for the registry process.');
}

main();
