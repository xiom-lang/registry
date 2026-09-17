#!/usr/bin/env node
// XIOM Package Registry -- live staging smoke check.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Read-only verification of a deployed registry, used by the scheduled
// staging workflow. Checks that the instance is healthy, advertises its own
// registry URL, and -- when the index has packages -- that the latest
// non-yanked version's artifact matches its indexed sha256. Publishing and
// install coverage runs in the local e2e gate (`npm run test:e2e`); this
// script only reads, so it is safe to run against production too.
//
// Usage:
//   node scripts/live-check.js --staging https://staging.registry.xiom-lang.org
//                              [--production https://registry.xiom-lang.org]

'use strict';

const crypto = require('crypto');

function parseArgs(argv) {
  const args = { staging: '', production: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--staging') args.staging = argv[++i];
    else if (argv[i] === '--production') args.production = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.staging) {
    console.error('Usage: node scripts/live-check.js --staging <url> [--production <url>]');
    process.exit(2);
  }
  return args;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function checkInstance(label, baseUrl, { expectRegistry } = {}) {
  console.log(`\n[${label}] ${baseUrl}`);
  const root = await getJson(`${baseUrl}/`);
  if (root.status !== 'operational') throw new Error(`${label}: status ${root.status}`);
  const health = await getJson(`${baseUrl}/health`);
  if (health.status !== 'ok') throw new Error(`${label}: health ${health.status}`);
  console.log(`  up, ${root.packages} package(s)`);

  const index = await getJson(`${baseUrl}/index.json`);
  if (!index.registry) throw new Error(`${label}: index has no root registry field`);
  if (expectRegistry && index.registry !== expectRegistry) {
    throw new Error(
      `${label}: index advertises ${index.registry}, expected ${expectRegistry}`,
    );
  }
  console.log(`  registry: ${index.registry}`);

  // Verify the newest non-yanked version of each package end to end:
  // metadata is present and the served bytes match the indexed digest.
  let verified = 0;
  for (const [name, pkg] of Object.entries(index.packages || {})) {
    const versions = Object.values(pkg.versions || {}).filter((v) => v && !v.yanked);
    if (versions.length === 0) continue;
    const latest = pkg.latest || versions[versions.length - 1].version;
    const entry = pkg.versions[latest];
    if (!entry) continue;
    if (!entry.sha256) {
      console.log(`  ${name}@${latest}: no digest (legacy entry, skipping artifact check)`);
      continue;
    }
    const artifactUrl = `${baseUrl}/packages/${name}/${latest}/package.tar.gz`;
    const response = await fetch(artifactUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`${name}@${latest}: artifact ${response.status} at ${artifactUrl}`);
    }
    const digest = crypto.createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex');
    if (digest !== entry.sha256) {
      throw new Error(`${name}@${latest}: served bytes ${digest} != indexed ${entry.sha256}`);
    }
    verified++;
    console.log(`  ${name}@${latest}: artifact matches indexed sha256`);
  }
  console.log(`  verified ${verified} artifact(s)`);
  return { index, health };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const staging = await checkInstance('staging', args.staging, {
    expectRegistry: args.staging,
  });

  if (args.production) {
    const production = await checkInstance('production', args.production, {
      expectRegistry: args.production,
    });

    // Isolation: the two instances must be distinct processes and must not
    // have restarted between the two probes.
    if (Math.abs(production.health.uptime - staging.health.uptime) < 1) {
      throw new Error(
        'staging and production report near-identical uptimes; they may be the same process',
      );
    }
    const stagingPackages = Object.keys(staging.index.packages || {});
    const productionPackages = new Set(Object.keys(production.index.packages || {}));
    const leaked = stagingPackages.filter((name) => productionPackages.has(name));
    if (leaked.length > 0) {
      fail(`packages present in BOTH indexes (isolation leak): ${leaked.join(', ')}`);
    } else {
      console.log(`\nisolation ok: ${stagingPackages.length} staging package(s) absent from production`);
    }
  }

  console.log('\nlive check complete');
}

main().catch((err) => {
  console.error(`live check error: ${err.message}`);
  process.exit(1);
});
