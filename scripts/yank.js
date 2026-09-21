#!/usr/bin/env node
// XIOM Package Registry -- yank helper.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Marks a published version yanked through the registry HTTP API (the same
// endpoint `xiom pkg` will use). The index entry and artifact stay for
// pinned lockfiles; `latest` skips it.
//
// Usage:
//   node scripts/yank.js --registry <url> --name <pkg> --version <ver> \
//     --token <token> [--reason "why"]

'use strict';

function parseArgs(argv) {
  const args = {
    registry: process.env.XIOM_REGISTRY || 'https://registry.xiom-lang.org',
    name: '',
    version: '',
    token: process.env.XIOM_REGISTRY_TOKEN || '',
    reason: '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--registry') args.registry = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--reason') args.reason = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.name || !args.version) {
    console.error('Usage: node scripts/yank.js --registry <url> --name <pkg> --version <ver> --token <token>');
    process.exit(2);
  }
  if (!args.token) {
    console.error('ERROR: no token. Pass --token or set XIOM_REGISTRY_TOKEN.');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = `${args.registry.replace(/\/+$/, '')}/packages/${args.name}/${args.version}/yank`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args.reason ? { reason: args.reason } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`ERROR: ${response.status} -- ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`Yanked ${args.name}@${args.version} on ${args.registry}`);
  console.log(`  latest is now: ${body.latest === '' ? '(none installable)' : body.latest}`);
  console.log('  pinned installs of the yanked version still work.');
}

main().catch((err) => {
  console.error(`yank failed: ${err.message}`);
  process.exit(1);
});
