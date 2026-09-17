#!/usr/bin/env node
// XIOM Package Registry -- live staging acceptance check.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Proves staging is a real, isolated registry using the REAL xiom-pkg
// client: publish a signed fixture, install it back (checksum verified),
// and assert production never lists it. This is the T9 acceptance run; it
// writes to staging, so it needs a staging publish token.
//
// Usage:
//   node scripts/staging-acceptance.js --token <staging-token> \
//     [--registry https://staging.registry.xiom-lang.org] \
//     [--production https://registry.xiom-lang.org] \
//     [--client <path to xiom-pkg>] [--keep]
//
// Without --keep the fixture version is yanked afterwards (like the e2e
// does) so the staging index stays tidy; the artifact remains for audit.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_NAME = 'xiom.staging-isolation-probe';
const VERSION = '0.1.0';

function parseArgs(argv) {
  const args = {
    token: process.env.XIOM_STAGING_TOKEN || '',
    registry: 'https://staging.registry.xiom-lang.org',
    production: 'https://registry.xiom-lang.org',
    client: process.env.XIOM_PKG_CLIENT || '',
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--registry') args.registry = argv[++i];
    else if (argv[i] === '--production') args.production = argv[++i];
    else if (argv[i] === '--client') args.client = argv[++i];
    else if (argv[i] === '--keep') args.keep = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.token) {
    console.error('ERROR: no token. Pass --token <staging token> or set XIOM_STAGING_TOKEN.');
    process.exit(2);
  }
  return args;
}

function findClient(explicit) {
  if (explicit) return explicit;
  const exe = process.platform === 'win32' ? 'xiom-pkg.exe' : 'xiom-pkg';
  const candidates = [
    path.resolve(__dirname, '..', '..', 'xiom', 'target', 'debug', exe),
    path.resolve(__dirname, '..', '..', 'xiom', 'target', 'release', exe),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = process.platform === 'win32'
    ? spawnSync('where', ['xiom-pkg'], { encoding: 'utf-8' })
    : spawnSync('which', ['xiom-pkg'], { encoding: 'utf-8' });
  if (which.status === 0) return which.stdout.split(/\r?\n/).find(Boolean).trim();
  throw new Error('xiom-pkg client not found; build it or pass --client <path>');
}

function run(bin, args, env, cwd) {
  const result = spawnSync(bin, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = findClient(args.client);
  console.log(`client:   ${client}`);
  console.log(`staging:  ${args.registry}`);
  console.log(`fixture:  ${PACKAGE_NAME}@${VERSION}`);

  // 1. Production must not know the fixture before we start.
  const prodBefore = await getJson(`${args.production}/index.json`);
  assert.ok(
    !prodBefore.packages[PACKAGE_NAME],
    `production already lists ${PACKAGE_NAME}; pick another fixture name`,
  );

  // 2. Build the fixture package directory.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-staging-accept-'));
  const home = path.join(work, 'home');
  const fixtureDir = path.join(work, 'fixture');
  fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, 'package.xi'),
    `package staging_isolation_probe {\n`
    + `  name: "${PACKAGE_NAME}";\n`
    + `  version: "${VERSION}";\n`
    + `  description: "staging isolation acceptance probe";\n`
    + `}\n`,
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'src', 'lib.xi'),
    'pub fn probe() -> Str { return "staging-isolation"; }\n',
  );

  const env = {
    XIOM_HOME: home,
    XIOM_REGISTRY: args.registry,
    XIOM_REGISTRY_TOKEN: args.token,
  };

  // 3. Sign and publish.
  const keygen = run(client, ['keygen'], env, work);
  assert.strictEqual(keygen.status, 0, `keygen failed: ${keygen.stderr}`);
  const key = /Public key: ([0-9a-f]{64})/.exec(keygen.stdout)?.[1];
  assert.ok(key, `cannot parse public key: ${keygen.stdout}`);

  const publish = run(client, ['publish'], env, fixtureDir);
  assert.strictEqual(publish.status, 0, `publish failed: ${publish.stderr}`);
  assert.match(publish.stdout, /Published/, publish.stdout);
  console.log('publish:  ok');

  // 4. Staging index lists it with the full metadata.
  const stagingIndex = await getJson(`${args.registry}/index.json`);
  const entry = stagingIndex.packages[PACKAGE_NAME]?.versions?.[VERSION];
  assert.ok(entry, 'staging index missing the fixture');
  assert.match(entry.sha256, /^[0-9a-f]{64}$/, 'sha256 missing');
  assert.strictEqual(entry.publicKey, key, 'public key mismatch');
  assert.strictEqual(stagingIndex.registry, args.registry, 'staging advertises the wrong registry URL');
  console.log('index:    ok (digest + signature + registry URL)');

  // 5. Install back through the registry path with the real client.
  const install = run(client, ['install', `${PACKAGE_NAME}@${VERSION}`], env, work);
  assert.strictEqual(install.status, 0, `install failed: ${install.stderr}`);
  assert.match(install.stdout, /checksum verified/, install.stdout);
  console.log('install:  ok (checksum verified)');

  // 6. Production never learns about it.
  const prodAfter = await getJson(`${args.production}/index.json`);
  assert.ok(
    !prodAfter.packages[PACKAGE_NAME],
    `ISOLATION LEAK: production lists ${PACKAGE_NAME}`,
  );
  console.log('isolation: ok (absent from production)');

  // 7. Optionally clean up: yank on staging so the index stays tidy.
  if (!args.keep) {
    const yank = await fetch(
      `${args.registry}/packages/${PACKAGE_NAME}/${VERSION}/yank`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'staging acceptance probe' }),
      },
    );
    assert.ok(yank.ok, `yank failed: HTTP ${yank.status}`);
    console.log('yank:     ok (probe marked yanked on staging)');
  }

  console.log(`\nstaging acceptance PASSED (artifacts kept in ${work})`);
}

main().catch((err) => {
  console.error(`staging acceptance FAILED: ${err.message}`);
  process.exit(1);
});
