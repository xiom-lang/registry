#!/usr/bin/env node
// XIOM Package Registry -- token file admin CLI.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Purpose-built so operators never hand-edit the JSON or paste multi-line
// heredocs (which garble in terminal pastes). Every subcommand is one line.
//
// Usage:
//   node scripts/tokens.js list   --file tokens.json
//   node scripts/tokens.js add    --file tokens.json --label alice --scopes "alice-lib"
//   node scripts/tokens.js remove --file tokens.json --label alice
//   node scripts/tokens.js rotate --file tokens.json --label alice --scopes "alice-lib"
//                [--trusted] [--first-party]
//
// `rotate` removes every entry with the label and writes exactly one fresh
// entry, in a single atomic file write. The new value is printed once; the
// container must be recreated afterwards to load the file.
//
// On the VPS run it through the node image so ownership is predictable:
//   docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
//     node scripts/tokens.js list --file tokens.json

'use strict';

const crypto = require('crypto');

const { loadTokens, saveTokens, summarize } = require('./lib/token-file');
const { fingerprint, isValidPublicKeyHex } = require('../src/signatures');

const ROTATION_DAYS = 90;

const USAGE = `Usage:
  node scripts/tokens.js list   --file <path> [--json]
  node scripts/tokens.js add    --file <path> --label <label> [--scopes a,b] [--trusted] [--first-party] [--key <64-hex>]
  node scripts/tokens.js remove --file <path> --label <label>
  node scripts/tokens.js rotate --file <path> --label <label> [--scopes a,b] [--trusted] [--first-party] [--key <64-hex>]`;

function parseArgs(argv) {
  const args = {
    command: '',
    file: '',
    label: '',
    scopes: ['*'],
    trusted: false,
    firstParty: false,
    key: '',
    json: false,
  };
  const [command, ...rest] = argv;
  args.command = command || '';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--file') args.file = rest[++i];
    else if (arg === '--label') args.label = rest[++i];
    else if (arg === '--scopes') {
      args.scopes = String(rest[++i] || '*').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--key') args.key = String(rest[++i] || '').trim().toLowerCase().replace(/[\s:]/g, '');
    else if (arg === '--trusted') args.trusted = true;
    else if (arg === '--first-party') args.firstParty = true;
    else if (arg === '--json') args.json = true;
    else {
      console.error(`unknown argument: ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return args;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function requireFileAndLabel(args) {
  if (!args.file) fail(`--file is required\n${USAGE}`);
  if (args.command !== 'list' && !args.label) fail(`--label is required\n${USAGE}`);
}

function readTokens(file) {
  try {
    return loadTokens(file);
  } catch (err) {
    fail(err.message);
    return [];
  }
}

function writeTokens(file, tokens) {
  try {
    saveTokens(file, tokens);
  } catch (err) {
    fail(`cannot write ${file}: ${err.message}`);
  }
}

function newEntry(args) {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    label: args.label,
    scopes: args.scopes,
    trusted: args.trusted,
    firstParty: args.firstParty,
    issuedAt: new Date().toISOString(),
    ...(args.key ? { publicKey: args.key } : {}),
  };
}

/** Whole days since issuance; null when the entry predates issuedAt. */
function ageDays(issuedAt, now = Date.now()) {
  const ms = Date.parse(issuedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / 86_400_000));
}

function describe(entry) {
  const s = summarize(entry);
  const days = ageDays(s.issuedAt);
  const issued = s.issuedAt ? s.issuedAt.slice(0, 10) : 'unknown';
  const age = days === null ? '' : ` age=${days}d`;
  const due = days !== null && days >= ROTATION_DAYS ? ' ROTATION-DUE' : '';
  const key = s.publicKey ? ` key=${fingerprint(s.publicKey)}` : '';
  return `label=${s.label || '(none)'} scopes=${s.scopes.join(',') || '(none)'} `
    + `trusted=${s.trusted} firstParty=${s.firstParty} issued=${issued}${age}${due}${key}`;
}

function postWriteHint(file) {
  console.log('');
  console.log(`Mount file content now has ${readTokens(file).length} token(s) in ${file}.`);
  console.log('Recreate the container so it reloads the file:');
  console.log('  docker compose up -d --force-recreate --no-deps registry');
  console.log('  # staging: docker compose --env-file .env.staging --profile staging \\');
  console.log('  #   up -d --force-recreate --no-deps staging');
  console.log(`Permissions (UID 1000 reads the mount): chown 1000:1000 ${file} && chmod 600 ${file}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['list', 'add', 'remove', 'rotate'].includes(args.command)) {
    console.error(USAGE);
    process.exit(2);
  }
  requireFileAndLabel(args);

  if (args.key) {
    if (!args.trusted) {
      fail('--key requires --trusted (a pinned key only has meaning when signatures are enforced)');
    }
    if (!isValidPublicKeyHex(args.key)) {
      fail('--key must be 64 hex characters (the ed25519 public key printed by `xiom pkg keygen`)');
    }
  }

  const tokens = readTokens(args.file);

  if (args.command === 'list') {
    if (args.json) {
      const now = Date.now();
      console.log(JSON.stringify(tokens.map((entry) => {
        const s = summarize(entry);
        const days = ageDays(s.issuedAt, now);
        return {
          ...s,
          ...(days === null ? {} : { ageDays: days, rotationDue: days >= ROTATION_DAYS }),
        };
      }), null, 2));
      return;
    }
    console.log(args.file);
    if (tokens.length === 0) {
      console.log('  (no tokens)');
      return;
    }
    tokens.forEach((entry, index) => {
      console.log(`  [${index}] ${describe(entry)}`);
    });
    return;
  }

  if (args.command === 'add') {
    const sameLabel = tokens.filter((entry) => entry.label === args.label).length;
    if (sameLabel > 0) {
      console.warn(
        `WARNING: label "${args.label}" already exists (${sameLabel} `
        + `entr${sameLabel === 1 ? 'y' : 'ies'}); the old token stays valid until `
        + 'removed. Prefer `rotate`, which replaces all entries for the label.',
      );
    }
    const entry = newEntry(args);
    writeTokens(args.file, [...tokens, entry]);
    console.log(`Token added to ${args.file}`);
    console.log(`  ${describe(entry)}`);
    console.log(`  token: ${entry.token}`);
    postWriteHint(args.file);
    return;
  }

  if (args.command === 'remove') {
    const kept = tokens.filter((entry) => entry.label !== args.label);
    const removed = tokens.length - kept.length;
    if (removed === 0) fail(`label not found: ${args.label}`);
    writeTokens(args.file, kept);
    console.log(`Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} for label `
      + `"${args.label}"; ${kept.length} token(s) remain in ${args.file}`);
    postWriteHint(args.file);
    return;
  }

  // rotate: replace every entry for the label with exactly one fresh entry,
  // in a single write (no window with zero valid tokens for that label).
  const kept = tokens.filter((entry) => entry.label !== args.label);
  const replaced = tokens.length - kept.length;
  const entry = newEntry(args);
  writeTokens(args.file, [...kept, entry]);
  console.log(`Rotated label "${args.label}" in ${args.file} `
    + `(${replaced} old entr${replaced === 1 ? 'y' : 'ies'} replaced)`);
  console.log(`  ${describe(entry)}`);
  console.log(`  token: ${entry.token}`);
  postWriteHint(args.file);
}

main();
