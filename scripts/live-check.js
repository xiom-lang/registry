#!/usr/bin/env node
// XIOM Package Registry -- live staging smoke check.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
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

/**
 * Instance identity: the pieces that differ between genuinely separate
 * deployments. Uptime is deliberately NOT used -- it looked like the right
 * signal, but two containers started by the same host reboot legitimately
 * have near-identical uptimes. Identity fields catch the real failure mode
 * (a hostname silently routed to the other instance) without reboot flakes.
 */
function identityOf(root, index, health) {
  return [
    `registry=${index.registry}`,
    `started=${health.started_at || 'unknown'}`,
    `packages=${Object.keys(index.packages || {}).sort().join(',')}`,
    `root=${root.name}@${root.version}`,
  ].join('|');
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

  // The read-only UI must render for browsers (and only for browsers).
  const page = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
  if (!page.ok) throw new Error(`${label}: UI page HTTP ${page.status}`);
  const pageHtml = await page.text();
  if (!pageHtml.includes('<title>') || !pageHtml.includes('/ui/registry.css')) {
    throw new Error(`${label}: UI page did not render expected markup`);
  }
  const packages = Object.keys(index.packages || {});
  if (packages.length > 0) {
    const deep = await fetch(`${baseUrl}/packages/${encodeURIComponent(packages[0])}`, {
      headers: { Accept: 'text/html' },
    });
    if (!deep.ok || !(await deep.text()).includes(packages[0])) {
      throw new Error(`${label}: package page for ${packages[0]} did not render`);
    }
  }
  console.log(`  ui: html pages render`);

  // Category vocabulary (browse/facet surface for humans and agents).
  const categories = await getJson(`${baseUrl}/categories`);
  if (!Array.isArray(categories.categories)) {
    throw new Error(`${label}: /categories did not return a categories array`);
  }
  console.log(`  categories: ${categories.categories.length} vocabulary entries`);

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
  return { index, health, root };
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

    // Isolation: the two instances must be genuinely distinct deployments.
    // Compare identity (registry URL, start time, package set), not uptime --
    // containers restarted by the same host reboot share uptime legitimately.
    const stagingIdentity = identityOf(staging.root, staging.index, staging.health);
    const productionIdentity = identityOf(production.root, production.index, production.health);
    if (stagingIdentity === productionIdentity) {
      fail(
        'staging and production report identical identity; the staging hostname '
        + 'is probably routed to the production instance',
      );
    } else {
      console.log('\nisolation ok: distinct identity between staging and production');
    }

    const stagingPackages = Object.keys(staging.index.packages || {});
    const productionPackages = new Set(Object.keys(production.index.packages || {}));
    const shared = stagingPackages.filter((name) => productionPackages.has(name));
    // Package-name overlap is EXPECTED: staging rehearses production
    // publishes, so the same package legitimately exists in both. Isolation
    // is proven by the identity check above (and by the acceptance script,
    // which publishes a staging-only probe and asserts it never reaches
    // production).
    if (shared.length > 0) {
      console.log(`content overlap: ${shared.length} package(s) also in production (expected for rehearsals)`);
    } else {
      console.log(`content: ${stagingPackages.length} staging package(s), none in production`);
    }
  }

  console.log('\nlive check complete');
}

main().catch((err) => {
  console.error(`live check error: ${err.message}`);
  // Do not call process.exit() here: on Windows an abrupt exit while the
  // fetch keep-alive sockets are closing trips a libuv assertion
  // ("!(handle->flags & UV_HANDLE_CLOSING)") and buries the real error under
  // a crash. Setting the exit code lets Node close its handles and exit
  // cleanly with the same non-zero status.
  process.exitCode = 1;
});
