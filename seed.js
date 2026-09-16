#!/usr/bin/env node
// XIOM Package Registry -- batch seed/import tool.
// Copyright 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Imports package metadata into a running registry via POST /sync. This is
// for operators migrating legacy index data; normal publishing goes through
// `xiom pkg publish` (see test/e2e/run-e2e.js).
//
// Usage:
//   node seed.js [--registry URL] [--index PATH] [--token TOKEN]
//
// Defaults: --registry http://localhost:3000, --index ./seed-index.json,
// --token from XIOM_REGISTRY_TOKEN.

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    registry: process.env.XIOM_REGISTRY || 'http://localhost:3000',
    index: path.join(__dirname, 'seed-index.json'),
    token: process.env.XIOM_REGISTRY_TOKEN || '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--registry') args.registry = argv[++i];
    else if (argv[i] === '--index') args.index = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      console.error('Usage: node seed.js [--registry URL] [--index PATH] [--token TOKEN]');
      process.exit(2);
    }
  }
  return args;
}

/**
 * Normalize any of the seed shapes into a flat array of version entries:
 * - canonical index:   { packages: { name: { versions: { v: {...} } } } }
 * - version list:      { packages: { name: ["1.0.0", ...] } }
 * - array of entries:  [{ name, version, ... }, ...]
 * - bare map:          { name: { version, ... } }
 */
function flattenToEntries(parsed) {
  const entries = [];
  const push = (name, version, meta) => {
    if (!name || !version) return;
    entries.push({
      name,
      version,
      description: meta.description || '',
      repository: meta.repository || '',
      sha256: meta.sha256,
      signature: meta.signature,
      publicKey: meta.publicKey,
      size: meta.size,
      published: meta.published,
      dependencies: meta.dependencies && typeof meta.dependencies === 'object'
        ? meta.dependencies
        : {},
    });
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') push(entry.name, entry.version, entry);
    }
    return entries;
  }
  if (!parsed || typeof parsed !== 'object') return entries;

  // A single entry object (e.g. a one-package seed file).
  if (parsed.name && parsed.version && !parsed.packages) {
    push(parsed.name, parsed.version, parsed);
    return entries;
  }

  const packages = parsed.packages;
  if (Array.isArray(packages)) {
    for (const entry of packages) {
      if (entry && typeof entry === 'object') push(entry.name, entry.version, entry);
    }
    return entries;
  }
  const map = packages && typeof packages === 'object' ? packages : parsed;
  for (const [name, pkg] of Object.entries(map)) {
    if (!pkg || typeof pkg !== 'object') continue;
    if (Array.isArray(pkg.versions)) {
      for (const version of pkg.versions) push(name, version, { ...pkg });
    } else if (pkg.versions && typeof pkg.versions === 'object') {
      for (const [version, meta] of Object.entries(pkg.versions)) {
        push(name, version, { ...pkg, ...(meta && typeof meta === 'object' ? meta : {}) });
      }
    } else if (pkg.version) {
      push(name, pkg.version, pkg);
    }
  }
  return entries;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.index)) {
    console.error(`ERROR: seed index not found: ${args.index}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(args.index, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: ${args.index} is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const packages = flattenToEntries(parsed);
  if (packages.length === 0) {
    console.error('ERROR: no package versions found in the seed index');
    process.exit(1);
  }
  if (!args.token) {
    console.error('ERROR: no token supplied; set XIOM_REGISTRY_TOKEN or pass --token');
    process.exit(1);
  }

  console.log(`Seeding ${packages.length} package version(s) to ${args.registry}...`);
  const response = await fetch(`${args.registry.replace(/\/+$/, '')}/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ packages }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`ERROR: ${response.status} -- ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`OK: ${body.added} added, ${body.skipped} skipped, ${body.total} total`);
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  console.error('Make sure the registry is running: npm start');
  process.exit(1);
});
