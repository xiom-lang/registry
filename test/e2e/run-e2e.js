// XIOM Package Registry -- end-to-end gate (SESSION.md section 5, T8).
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// This test drives the REAL `xiom-pkg` client binary against a locally
// started registry. It is the gate that proves protocol compliance: nothing
// here mocks the client, the multipart body, or the signature format.
//
// Prerequisite: build the client from the xiom compiler repo:
//     cargo build -p xiom-pkg
// Client lookup order:
//   1. $XIOM_PKG_CLIENT (full path to the binary)
//   2. <repo>/../xiom/target/debug/xiom-pkg[.exe]
//   3. `xiom-pkg` on PATH
//
// Run: npm run test:e2e

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-registry-e2e-'));
const XIOM_HOME = path.join(TMP_ROOT, 'xiom-home');
const DATA_DIR = path.join(TMP_ROOT, 'data');
const PACKAGES_DIR = path.join(TMP_ROOT, 'packages');
const TOKENS_FILE = path.join(TMP_ROOT, 'tokens.json');
const FIXTURE_DIR = path.join(TMP_ROOT, 'fixture');
const INSTALL_DIR = path.join(TMP_ROOT, 'install');

// The client's package cache honors XIOM_HOME first (compiler R38 fix), so
// the sandbox XIOM_HOME below isolates it. LOCALAPPDATA/HOME are still
// pointed at the sandbox so a binary predating that fix cannot touch the
// developer's real cache either.
const CLIENT_CACHE = path.join(XIOM_HOME, 'packages');
const CLIENT_CACHE_ENV = process.platform === 'win32'
  ? { LOCALAPPDATA: path.join(TMP_ROOT, 'client-cache') }
  : { HOME: path.join(TMP_ROOT, 'client-cache') };

const PACKAGE_NAME = 'registry-e2e-fixture';
const V1 = '0.1.0';
const V2 = '0.2.0';
// Transitive dependency of PACKAGE_NAME (its package.xi declares
// `xiom-core: 0.1.0`); published below so installs resolve the closure.
const CORE_NAME = 'xiom-core';
const CORE_V1 = '0.1.0';
const CORE_DIR = path.join(TMP_ROOT, 'core-fixture');
const OPEN_TOKEN = 'e2e-open-token';
const TRUSTED_TOKEN = 'e2e-trusted-token';
const FIRSTPARTY_TOKEN = 'e2e-firstparty-token';

const checks = [];
let serverProcess = null;
let port = 0;
let clientBin = '';

function log(message) {
  console.log(`[e2e] ${message}`);
}

function record(name, fn) {
  checks.push({ name, fn });
}

async function runChecks() {
  let failures = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
    }
  }
  return failures;
}

function findClient() {
  if (process.env.XIOM_PKG_CLIENT) {
    return process.env.XIOM_PKG_CLIENT;
  }
  const exe = process.platform === 'win32' ? 'xiom-pkg.exe' : 'xiom-pkg';
  const candidates = [
    path.resolve(REPO_ROOT, '..', 'xiom', 'target', 'debug', exe),
    path.resolve(REPO_ROOT, '..', 'xiom', 'target', 'release', exe),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = process.platform === 'win32'
    ? spawnSync('where', ['xiom-pkg'], { encoding: 'utf-8' })
    : spawnSync('which', ['xiom-pkg'], { encoding: 'utf-8' });
  if (which.status === 0) {
    return which.stdout.split(/\r?\n/).find(Boolean).trim();
  }
  throw new Error(
    'xiom-pkg client not found. Build it first: cargo build -p xiom-pkg '
    + '(in the xiom compiler repo) or set XIOM_PKG_CLIENT',
  );
}

/** Run the client with a controlled environment; returns {status, stdout, stderr}. */
function client(args, { cwd = TMP_ROOT, registry = `http://localhost:${port}`, token = '' } = {}) {
  const env = {
    ...process.env,
    XIOM_HOME,
    XIOM_REGISTRY: registry,
    XIOM_PKG_ALLOW_HTTP: '1',
    XIOM_REGISTRY_TOKEN: token,
    // Keep the user's real key and cache out of the test.
    HOME: XIOM_HOME,
    USERPROFILE: XIOM_HOME,
    ...CLIENT_CACHE_ENV,
  };
  const result = spawnSync(clientBin, args, { cwd, env, encoding: 'utf-8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function writeFixture(version, description) {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE_DIR, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'package.xi'),
    `package registry_e2e_fixture {\n`
    + `  name: "${PACKAGE_NAME}";\n`
    + `  version: "${version}";\n`
    + `  description: "${description}";\n`
    + `  deps: {\n`
    + `    "xiom-core": "0.1.0",\n`
    + `  };\n`
    + `}\n`,
  );
  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'src', 'lib.xi'),
    `pub fn hello() -> Str { return "hello ${version}"; }\n`,
  );
}

/** Depth-first search for a file by basename; null when absent. */
function findFileRecursive(root, basename) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, basename);
      if (found) return found;
    } else if (entry.name === basename) {
      return full;
    }
  }
  return null;
}

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf-8'));
}

function writeTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

async function startServer() {
  port = await freePort();
  writeTokens([
    { token: OPEN_TOKEN, label: 'e2e-open', scopes: ['*'], trusted: false, firstParty: false },
    { token: TRUSTED_TOKEN, label: 'e2e-trusted', scopes: ['*'], trusted: true, firstParty: true },
    { token: FIRSTPARTY_TOKEN, label: 'e2e-firstparty', scopes: ['*'], trusted: false, firstParty: true },
  ]);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR,
    PACKAGES_DIR,
    TOKENS_FILE,
    UPLOAD_TMP_DIR: path.join(DATA_DIR, 'tmp'),
    REGISTRY_URL: `http://localhost:${port}`,
    RATE_LIMIT_DISABLED: '1',
  };
  serverProcess = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) console.log(`[server] ${text.trim()}`);
  });
  serverProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) console.error(`[server] ${text.trim()}`);
  });
  serverProcess.on('exit', (code, signal) => {
    console.error(`[server] exited code=${code} signal=${signal}`);
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://localhost:${port}/health`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('registry server did not become ready');
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close(() => resolve(p));
    });
    server.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  // `connection: close`: client subprocess steps can idle long enough for the
  // server's keep-alive timeout to close pooled sockets; undici retries GETs
  // on the resulting ECONNRESET but surfaces it for POSTs (the second yank).
  const response = await fetch(url, {
    ...options,
    headers: { connection: 'close', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = new Error(`${options.method || 'GET'} ${url} -> ${response.status}: ${text}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { status: response.status, body };
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

async function scenarioPublish() {
  log('generating a signing key with the real client');
  const keygen = client(['keygen', '--out', path.join(XIOM_HOME, 'keys', 'default.key')]);
  assert.strictEqual(keygen.status, 0, `keygen failed: ${keygen.stderr}`);
  const publicKey = /Public key: ([0-9a-f]{64})/.exec(keygen.stdout)?.[1];
  assert.ok(publicKey, `cannot parse public key from keygen output: ${keygen.stdout}`);
  return publicKey;
}

let PUBLIC_KEY = '';

function registerScenarios() {
  record('client keygen (ed25519)', async () => {
    const keygen = client(['keygen', '--out', path.join(XIOM_HOME, 'keys', 'default.key')]);
    assert.strictEqual(keygen.status, 0, `keygen failed: ${keygen.stderr}`);
    PUBLIC_KEY = /Public key: ([0-9a-f]{64})/.exec(keygen.stdout)?.[1];
    assert.ok(PUBLIC_KEY, `cannot parse public key: ${keygen.stdout}`);
  });

  record('trusted but unsigned publish is refused with 422', async () => {
    writeFixture(V1, 'End-to-end fixture');
    // Remove the signing key so the client publishes unsigned.
    fs.rmSync(path.join(XIOM_HOME, 'keys', 'default.key'), { force: true });
    const result = client(['publish'], { cwd: FIXTURE_DIR, token: TRUSTED_TOKEN });
    assert.notStrictEqual(result.status, 0, 'unsigned publish must fail');
    assert.match(result.stderr, /422/, `expected 422, got: ${result.stderr}`);
    assert.match(result.stderr, /signature_required/, `registry error body missing: ${result.stderr}`);
  });

  record('unsigned publish with an open token succeeds and indexes metadata', async () => {
    const result = client(['publish'], { cwd: FIXTURE_DIR, token: OPEN_TOKEN });
    assert.strictEqual(result.status, 0, `publish failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully published/, result.stdout);
    const pkg = readIndex().packages[PACKAGE_NAME];
    assert.ok(pkg, 'package missing from index');
    const entry = pkg.versions[V1];
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, 'sha256 missing');
    assert.strictEqual(entry.size > 0, true, 'size missing');
    assert.ok(entry.published, 'published missing');
    assert.strictEqual(entry.dependencies['xiom-core'], '0.1.0', 'deps not extracted from package.xi');
    assert.match(pkg.description, /End-to-end fixture/, 'description not extracted');
    assert.strictEqual(entry.signature, '', 'unsigned entry must not carry a signature');
  });

  record('republishing the same version is refused with 409', async () => {
    const result = client(['publish'], { cwd: FIXTURE_DIR, token: OPEN_TOKEN });
    assert.notStrictEqual(result.status, 0, 'republish must fail');
    assert.match(result.stderr, /409/, `expected 409, got: ${result.stderr}`);
    assert.match(result.stderr, /version_exists/, `registry error body missing: ${result.stderr}`);
  });

  record('publish with a bad token is refused with 401', async () => {
    const result = client(['publish'], { cwd: FIXTURE_DIR, token: 'not-a-real-token' });
    assert.notStrictEqual(result.status, 0, 'bad token must fail');
    assert.match(result.stderr, /401/, `expected 401, got: ${result.stderr}`);
    assert.match(result.stderr, /invalid_token/, `registry error body missing: ${result.stderr}`);
  });

  record('non-first-party token cannot publish the reserved xiom.* namespace', async () => {
    const dir = path.join(TMP_ROOT, 'reserved-fixture');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.xi'),
      `package reserved {\n  name: "xiom.reserved-test";\n  version: "0.1.0";\n}\n`,
    );
    const result = client(['publish'], { cwd: dir, token: OPEN_TOKEN });
    assert.notStrictEqual(result.status, 0, 'reserved namespace publish must fail');
    assert.match(result.stderr, /403/, `expected 403, got: ${result.stderr}`);
    assert.match(result.stderr, /reserved_namespace/, `registry error body missing: ${result.stderr}`);
  });

  record('signed publish with a trusted token succeeds', async () => {
    const keygen = client(['keygen', '--out', path.join(XIOM_HOME, 'keys', 'default.key')]);
    assert.strictEqual(keygen.status, 0, `keygen failed: ${keygen.stderr}`);
    PUBLIC_KEY = /Public key: ([0-9a-f]{64})/.exec(keygen.stdout)?.[1];
    writeFixture(V2, 'Signed end-to-end fixture');
    const result = client(['publish'], { cwd: FIXTURE_DIR, token: TRUSTED_TOKEN });
    assert.strictEqual(result.status, 0, `signed publish failed: ${result.stderr}`);
    const entry = readIndex().packages[PACKAGE_NAME].versions[V2];
    assert.strictEqual(entry.publicKey, PUBLIC_KEY, 'public key not stored');
    assert.match(entry.signature, /^[0-9a-f]{128}$/, 'signature not stored');
  });

  record('publish the dependency package used by transitive installs', async () => {
    fs.rmSync(CORE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(CORE_DIR, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(CORE_DIR, 'package.xi'),
      `package xiom_core_e2e {\n`
      + `  name: "${CORE_NAME}";\n`
      + `  version: "${CORE_V1}";\n`
      + `  description: "transitive dependency fixture";\n`
      + `}\n`,
    );
    fs.writeFileSync(
      path.join(CORE_DIR, 'src', 'lib.xi'),
      `pub fn core_hello() -> Str { return "core"; }\n`,
    );
    const result = client(['publish'], { cwd: CORE_DIR, token: TRUSTED_TOKEN });
    assert.strictEqual(result.status, 0, `core publish failed: ${result.stderr}`);
    const entry = readIndex().packages[CORE_NAME].versions[CORE_V1];
    assert.match(entry.signature, /^[0-9a-f]{128}$/, 'core signature missing');
  });

  record('index emits the root registry field the client requires', async () => {
    const { body } = await fetchJson(`http://localhost:${port}/index.json`);
    assert.strictEqual(body.registry, `http://localhost:${port}`, 'registry url missing from index');
    assert.strictEqual(body.version, '1.0.0', 'index schema version missing');
  });

  record('install verifies sha256 through the registry path', async () => {
    fs.rmSync(path.join(CLIENT_CACHE, `${PACKAGE_NAME}-${V1}`), { recursive: true, force: true });
    const result = client(['install', `${PACKAGE_NAME}@${V1}`], { cwd: INSTALL_DIR });
    assert.match(result.stdout, /checksum verified/, `checksum not verified: ${result.stdout}`);
    assert.match(result.stdout, /Downloading registry-e2e-fixture v0.1.0 from/, result.stdout);
    // The tarball root is the package directory, so members land under a
    // subdirectory of the cache entry; find the manifest anywhere below it.
    const cacheDir = path.join(CLIENT_CACHE, `${PACKAGE_NAME}-${V1}`);
    const manifest = findFileRecursive(cacheDir, 'package.xi');
    assert.ok(manifest, `artifact not extracted under ${cacheDir}`);
  });

  record('install enforces the signature once the registry key is pinned', async () => {
    const trusted = path.join(XIOM_HOME, 'trusted_keys.json');
    fs.writeFileSync(trusted, JSON.stringify({ keys: { [`http://localhost:${port}`]: PUBLIC_KEY } }));
    const result = client(['install', `${PACKAGE_NAME}@${V2}`], { cwd: INSTALL_DIR });
    assert.match(result.stdout, /signature verified/, `signature not verified: ${result.stdout}`);
  });

  record('install refuses an unsigned artifact from a pinned registry', async () => {
    const trusted = path.join(XIOM_HOME, 'trusted_keys.json');
    fs.writeFileSync(trusted, JSON.stringify({ keys: { [`http://localhost:${port}`]: PUBLIC_KEY } }));
    const result = client(['install', `${PACKAGE_NAME}@${V1}`], { cwd: INSTALL_DIR });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /NO signature|carries NO signature/, `unsigned artifact not refused: ${combined}`);
  });

  record('pinned key enforcement survives a non-canonical trust-file URL', async () => {
    // Hand-written trust files (fixtures, legacy installs) may spell the
    // registry URL with a trailing slash and an uppercase host; the pin must
    // still match or the fail-closed signature gate silently disappears (R33).
    const trusted = path.join(XIOM_HOME, 'trusted_keys.json');
    fs.writeFileSync(trusted, JSON.stringify({ keys: { [`HTTP://LOCALHOST:${port}/`]: PUBLIC_KEY } }));
    const result = client(['install', `${PACKAGE_NAME}@${V2}`], { cwd: INSTALL_DIR });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(result.status, 0, `install failed: ${combined}`);
    assert.match(result.stdout, /signature verified/, `signature not enforced: ${combined}`);
  });

  record('install refuses a tampered artifact (checksum mismatch)', async () => {
    // Unpin so only the checksum gate is under test.
    fs.rmSync(path.join(XIOM_HOME, 'trusted_keys.json'), { force: true });
    fs.rmSync(path.join(CLIENT_CACHE, `${PACKAGE_NAME}-${V1}`), { recursive: true, force: true });
    const artifact = path.join(PACKAGES_DIR, PACKAGE_NAME, V1, 'package.tar.gz');
    const original = fs.readFileSync(artifact);
    fs.writeFileSync(artifact, Buffer.concat([original, Buffer.from([0xde, 0xad, 0xbe, 0xef])]));
    try {
      const result = client(['install', `${PACKAGE_NAME}@${V1}`], { cwd: INSTALL_DIR });
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.match(combined, /CHECKSUM MISMATCH/, `tamper not detected: ${combined}`);
      assert.notStrictEqual(result.status, 0, `tampered install must exit non-zero: ${combined}`);
      assert.ok(
        !/trying local resolution/.test(combined),
        `integrity failure must not trigger the local fallback: ${combined}`,
      );
      // R32: the unverified fallback download path is gone; additionally
      // assert no content from the tampered bytes was extracted.
      const source = findFileRecursive(
        path.join(CLIENT_CACHE, `${PACKAGE_NAME}-${V1}`),
        'lib.xi',
      );
      if (source) {
        const lib = fs.readFileSync(source, 'utf-8');
        assert.ok(!lib.includes('hello'), 'tampered artifact was extracted');
      }
    } finally {
      fs.writeFileSync(artifact, original);
    }
  });

  record('yank hides a version from latest but keeps pinned installs working', async () => {
    const yank = await fetchJson(
      `http://localhost:${port}/packages/${PACKAGE_NAME}/${V2}/yank`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TRUSTED_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'e2e yank' }),
      },
    );
    assert.strictEqual(yank.status, 200, 'yank failed');
    const index = readIndex();
    assert.strictEqual(index.packages[PACKAGE_NAME].versions[V2].yanked, true, 'yanked flag missing');
    assert.strictEqual(index.packages[PACKAGE_NAME].latest, V1, 'latest must skip the yanked version');

    const pinned = client(['install', `${PACKAGE_NAME}@${V2}`], { cwd: INSTALL_DIR });
    assert.strictEqual(pinned.status, 0, `pinned yanked install failed: ${pinned.stderr}`);
    assert.match(pinned.stdout, /checksum verified/, pinned.stdout);
  });

  record('download route serves the artifact and the legacy alias', async () => {
    const canonical = await fetch(
      `http://localhost:${port}/packages/${PACKAGE_NAME}/${V1}/package.tar.gz`,
    );
    assert.strictEqual(canonical.status, 200, 'canonical download failed');
    assert.strictEqual(canonical.headers.get('content-type'), 'application/gzip');
    const digest = crypto.createHash('sha256')
      .update(Buffer.from(await canonical.arrayBuffer()))
      .digest('hex');
    assert.strictEqual(digest, readIndex().packages[PACKAGE_NAME].versions[V1].sha256, 'served bytes differ from the index digest');

    const alias = await fetch(`http://localhost:${port}/packages/${PACKAGE_NAME}/${V1}/download`);
    assert.strictEqual(alias.status, 200, 'legacy alias download failed');
  });

  record('unknown versions are 404 on metadata and download', async () => {
    const metadata = await fetch(`http://localhost:${port}/packages/${PACKAGE_NAME}/9.9.9`);
    assert.strictEqual(metadata.status, 404, 'metadata should 404');
    const artifact = await fetch(`http://localhost:${port}/packages/${PACKAGE_NAME}/9.9.9/package.tar.gz`);
    assert.strictEqual(artifact.status, 404, 'artifact should 404');
  });

  record('lockfile pins the registry digest', async () => {
    const lockDir = path.join(TMP_ROOT, 'lock-fixture');
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'package.xi'),
      `package lock_fixture {\n  name: "lock-fixture";\n  version: "0.1.0";\n`
      + `  deps: {\n    "${PACKAGE_NAME}": "${V1}";\n  };\n}\n`,
    );
    const result = client(['lock'], { cwd: lockDir });
    assert.strictEqual(result.status, 0, `lock failed: ${result.stderr}`);
    const lockfile = JSON.parse(fs.readFileSync(path.join(lockDir, 'xiom.lock'), 'utf-8'));
    assert.strictEqual(lockfile.lockfileVersion, 2, 'lockfile v2 expected');
    const locked = lockfile.packages[PACKAGE_NAME];
    assert.ok(locked, `package missing from lockfile: ${JSON.stringify(lockfile)}`);
    const expected = `sha256-${readIndex().packages[PACKAGE_NAME].versions[V1].sha256}`;
    assert.strictEqual(locked.integrity, expected, 'lockfile integrity does not match the index');

    // Stage 5 transitive locking: the fixture's dependency is pinned too.
    const lockedCore = lockfile.packages[CORE_NAME];
    assert.ok(lockedCore, `transitive dependency missing from lockfile: ${JSON.stringify(lockfile)}`);
    assert.strictEqual(lockedCore.version, CORE_V1, 'transitive version not resolved');
    assert.match(lockedCore.integrity, /^sha256-[0-9a-f]{64}$/, 'transitive integrity missing');
  });

  record('install resolves the transitive dependency closure', async () => {
    fs.rmSync(path.join(CLIENT_CACHE, `${PACKAGE_NAME}-${V1}`), { recursive: true, force: true });
    fs.rmSync(path.join(CLIENT_CACHE, `${CORE_NAME}-${CORE_V1}`), { recursive: true, force: true });
    const result = client(['install', `${PACKAGE_NAME}@${V1}`], { cwd: INSTALL_DIR });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(result.status, 0, `transitive install failed: ${combined}`);
    assert.match(
      result.stdout,
      new RegExp(`Installing dependency ${CORE_NAME} v${CORE_V1}`),
      `dependency install not announced: ${combined}`,
    );
    assert.ok(
      findFileRecursive(path.join(CLIENT_CACHE, `${CORE_NAME}-${CORE_V1}`), 'package.xi'),
      'dependency artifact not extracted',
    );
  });

  record('all-yanked package fails with a clear message, not a bogus URL', async () => {
    // latest became V1 after the V2 yank; yank V1 too so `latest` turns empty.
    let yank;
    for (let attempt = 1; ; attempt++) {
      try {
        yank = await fetchJson(
          `http://localhost:${port}/packages/${PACKAGE_NAME}/${V1}/yank`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${TRUSTED_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'e2e all-yanked' }),
          },
        );
        break;
      } catch (e) {
        const cause = e.cause?.code || e.cause || 'none';
        if (attempt >= 2 || cause !== 'ECONNRESET') {
          throw new Error(`yank request failed (attempt ${attempt}): ${e.message}; cause=${cause}`);
        }
        console.error(`[e2e] yank ECONNRESET; retrying once (attempt ${attempt})`);
      }
    }
    assert.strictEqual(yank.status, 200, 'second yank failed');
    const result = client(['install', PACKAGE_NAME], { cwd: INSTALL_DIR });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.notStrictEqual(result.status, 0, `all-yanked install must fail: ${combined}`);
    assert.match(combined, /yanked/, `expected a yanked-package message: ${combined}`);
    assert.ok(
      !/\/\/package\.tar\.gz/.test(combined),
      `bogus empty-version download URL surfaced: ${combined}`,
    );
  });
}

async function main() {
  clientBin = findClient();
  log(`client:  ${clientBin}`);
  log(`workdir: ${TMP_ROOT}`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.mkdirSync(XIOM_HOME, { recursive: true });

  await startServer();
  log(`registry: http://localhost:${port}`);

  registerScenarios();
  const failures = await runChecks();

  console.log('');
  if (failures > 0) {
    console.error(`e2e: ${failures} of ${checks.length} checks FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`e2e: all ${checks.length} checks passed`);
  }
}

main()
  .catch((err) => {
    console.error(`e2e harness error: ${err.stack || err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
    // Leave TMP_ROOT on failure for evidence; remove it on success.
    if (process.exitCode === 0 || process.exitCode === undefined) {
      try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.error(`e2e artifacts left in ${TMP_ROOT}`);
    }
  });
