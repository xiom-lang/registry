// XIOM Package Registry -- HTTP API integration tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('node:http');
const os = require('os');
const path = require('path');

const OPEN_TOKEN = 'http-token-open';
const TRUSTED_TOKEN = 'http-token-trusted';
const FIRST_PARTY_TOKEN = 'http-token-first-party';

let app;
let server;
let baseUrl;
let sandbox;

function keypair() {
  const seed = crypto.randomBytes(32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { publicKeyHex: publicKeyDer.subarray(publicKeyDer.length - 32).toString('hex'), privateKey };
}

function tarballBytes(label = 'fixture') {
  const gz = require('zlib');
  return gz.gzipSync(Buffer.from(`fake-tarball-${label}-${crypto.randomBytes(4).toString('hex')}`));
}

async function publishForm({
  name,
  version,
  bytes,
  signature = '',
  publicKey = '',
  token = OPEN_TOKEN,
  url = baseUrl,
  compiler = '',
}) {
  const form = new FormData();
  form.set('name', name);
  form.set('version', version);
  if (signature) form.set('signature', signature);
  if (publicKey) form.set('publicKey', publicKey);
  if (compiler) form.set('compiler', compiler);
  form.set('package', new Blob([bytes], { type: 'application/gzip' }), 'package.tar.gz');
  const headers = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/publish`, { method: 'POST', body: form, headers });
}

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-http-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'https://registry.http.test';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: OPEN_TOKEN, label: 'open', scopes: ['*'], trusted: false, firstParty: false },
    { token: TRUSTED_TOKEN, label: 'trusted', scopes: ['*'], trusted: true, firstParty: true },
    { token: FIRST_PARTY_TOKEN, label: 'first-party', scopes: ['xiom.*', 'other'], trusted: false, firstParty: true },
  ]));

  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  app = createApp(loadConfig());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

/**
 * Start a registry in its own sandbox with its own env/token/limit settings.
 * Used by tests that must not share the main instance's state or config.
 */
async function startIsolatedRegistry({ tokens, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-http-iso-'));
  const tokensFile = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify(tokens));
  const saved = {};
  const overrides = {
    NODE_ENV: 'test',
    DATA_DIR: path.join(dir, 'data'),
    PACKAGES_DIR: path.join(dir, 'packages'),
    UPLOAD_TMP_DIR: path.join(dir, 'data', 'tmp'),
    REGISTRY_URL: 'https://registry.iso.test',
    RATE_LIMIT_DISABLED: '1',
    TOKENS_FILE: tokensFile,
    ...env,
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const { loadConfig } = require('../src/config');
    const { createApp } = require('../src/app');
    const isolatedApp = createApp(loadConfig());
    const isolatedServer = await new Promise((resolve) => {
      const s = isolatedApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
      url: `http://127.0.0.1:${isolatedServer.address().port}`,
      dir,
      app: isolatedApp,
      stop: () => {
        isolatedServer.close();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    throw err;
  }
}

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('health and index expose service state', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const index = await (await fetch(`${baseUrl}/index.json`)).json();
  assert.equal(index.registry, 'https://registry.http.test');
  assert.equal(index.version, '1.0.0');
  assert.deepEqual(index.packages, {});
});

test('publishing without a token is 401 and writes nothing', async () => {
  const before = fs.readdirSync(process.env.UPLOAD_TMP_DIR, { withFileTypes: true }).length;
  const response = await publishForm({
    name: 'authless-pkg', version: '0.1.0', bytes: tarballBytes(), token: null,
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, 'unauthorized');
  const after = fs.readdirSync(process.env.UPLOAD_TMP_DIR, { withFileTypes: true }).length;
  assert.equal(after, before, 'no upload may be staged before auth');
});

test('unknown token is 401', async () => {
  const response = await publishForm({
    name: 'unknown-token-pkg', version: '0.1.0', bytes: tarballBytes(), token: 'nope',
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'invalid_token');
});

test('trusted token without a signature is 422', async () => {
  const response = await publishForm({
    name: 'unsigned-trusted', version: '0.1.0', bytes: tarballBytes(), token: TRUSTED_TOKEN,
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'signature_required');
});

test('valid signed publish stores signature, key, digest, and metadata', async () => {
  const bytes = tarballBytes('signed');
  const { publicKeyHex, privateKey } = keypair();
  const signature = crypto.sign(null, bytes, privateKey).toString('hex');

  const response = await publishForm({
    name: 'signed-pkg',
    version: '1.2.3',
    bytes,
    signature,
    publicKey: publicKeyHex,
    token: TRUSTED_TOKEN,
  });
  assert.equal(response.status, 201, await response.text());

  const index = await (await fetch(`${baseUrl}/index.json`)).json();
  const entry = index.packages['signed-pkg'].versions['1.2.3'];
  assert.equal(entry.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(entry.signature, signature);
  assert.equal(entry.publicKey, publicKeyHex);
  assert.equal(entry.size, bytes.length);
  assert.ok(entry.published);
  assert.deepEqual(entry.dependencies, {});
  assert.equal(index.packages['signed-pkg'].latest, '1.2.3');
});

test('tampered signature is 422 and leaves no artifact', async () => {
  const bytes = tarballBytes('bad-sig');
  const { publicKeyHex, privateKey } = keypair();
  const signature = crypto.sign(null, bytes, privateKey).toString('hex');
  const tampered = `${signature.slice(0, 127)}${signature.endsWith('0') ? '1' : '0'}`;

  const response = await publishForm({
    name: 'tampered-sig', version: '0.1.0', bytes, signature: tampered,
    publicKey: publicKeyHex, token: TRUSTED_TOKEN,
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'signature_invalid');
  assert.equal(fs.existsSync(path.join(process.env.PACKAGES_DIR, 'tampered-sig')), false);
});

test('tampered artifact with a valid signature over other bytes is 422', async () => {
  const original = tarballBytes('original');
  const tampered = tarballBytes('tampered');
  const { publicKeyHex, privateKey } = keypair();
  const signature = crypto.sign(null, original, privateKey).toString('hex');

  const response = await publishForm({
    name: 'tampered-artifact', version: '0.1.0', bytes: tampered, signature,
    publicKey: publicKeyHex, token: TRUSTED_TOKEN,
  });
  assert.equal(response.status, 422);
});

test('malformed signature hex is 400', async () => {
  const response = await publishForm({
    name: 'bad-hex', version: '0.1.0', bytes: tarballBytes(),
    signature: 'zz', publicKey: 'ab'.repeat(32), token: OPEN_TOKEN,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_signature');
});

test('unsigned publish is accepted from an untrusted token', async () => {
  const response = await publishForm({
    name: 'open-pkg', version: '0.1.0', bytes: tarballBytes('open'), token: OPEN_TOKEN,
  });
  assert.equal(response.status, 201);
  const index = await (await fetch(`${baseUrl}/index.json`)).json();
  assert.equal(index.packages['open-pkg'].versions['0.1.0'].signature, '');
});

test('republish is 409 with immutable-version code', async () => {
  const bytes = tarballBytes('dup');
  const first = await publishForm({ name: 'dup-pkg', version: '1.0.0', bytes, token: OPEN_TOKEN });
  assert.equal(first.status, 201);
  const second = await publishForm({ name: 'dup-pkg', version: '1.0.0', bytes, token: OPEN_TOKEN });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'version_exists');
});

test('publishing without categories warns and still succeeds', async () => {
  const bare = await publishForm({
    name: 'no-categories-pkg', version: '0.1.0', bytes: tarballBytes('no-categories'),
  });
  assert.equal(bare.status, 201, await bare.clone().text());
  const body = await bare.json();
  assert.ok(Array.isArray(body.warnings), 'warnings are returned to the publisher');
  assert.ok(body.warnings.some((w) => w.includes('no categories declared')), 'the gap is surfaced at publish time');
  assert.ok(body.warnings.some((w) => w.includes('core, data, database')), 'the warning names the vocabulary');
});

test('compiler metadata is stored and served per version', async () => {
  const bytes = tarballBytes('compiler-meta');
  const published = await publishForm({
    name: 'compiler-meta-pkg', version: '0.1.0', bytes, compiler: 'v0.61.3',
  });
  assert.equal(published.status, 201, await published.clone().text());
  const entry = await (await fetch(`${baseUrl}/packages/compiler-meta-pkg/0.1.0`)).json();
  assert.equal(entry.compiler, 'v0.61.3', 'the toolchain pin is served for the version');

  const longBytes = tarballBytes('compiler-long');
  const long = await publishForm({
    name: 'compiler-long-pkg', version: '0.1.0', bytes: longBytes, compiler: 'v'.repeat(100),
  });
  assert.equal(long.status, 201, await long.clone().text());
  const longEntry = await (await fetch(`${baseUrl}/packages/compiler-long-pkg/0.1.0`)).json();
  assert.equal(longEntry.compiler.length, 64, 'oversized pins are capped at 64 chars');
});

test('a token pinned to a signing key rejects any other key', async () => {
  const pinned = keypair();
  const other = keypair();
  const registry = await startIsolatedRegistry({
    tokens: [{
      token: 'pinned-token',
      label: 'pinned',
      scopes: ['*'],
      trusted: true,
      firstParty: false,
      publicKey: pinned.publicKeyHex,
    }],
  });
  try {
    const bytes = tarballBytes('pinned');
    const signature = crypto.sign(null, bytes, pinned.privateKey).toString('hex');
    const ok = await publishForm({
      name: 'pinned-ok', version: '0.1.0', bytes, signature,
      publicKey: pinned.publicKeyHex, token: 'pinned-token', url: registry.url,
    });
    assert.equal(ok.status, 201, await ok.clone().text());

    const otherBytes = tarballBytes('pinned-other');
    const otherSignature = crypto.sign(null, otherBytes, other.privateKey).toString('hex');
    const mismatch = await publishForm({
      name: 'pinned-bad', version: '0.1.0', bytes: otherBytes, signature: otherSignature,
      publicKey: other.publicKeyHex, token: 'pinned-token', url: registry.url,
    });
    assert.equal(mismatch.status, 422);
    const body = await mismatch.json();
    assert.equal(body.code, 'public_key_mismatch');
    assert.doesNotMatch(body.error, new RegExp(other.publicKeyHex), 'never echoes the submitted key');
  } finally {
    registry.stop();
  }
});

test('invalid names and versions are 400', async () => {
  for (const [name, version] of [
    ['Bad_Name', '0.1.0'],
    ['.hidden', '0.1.0'],
    ['con', '0.1.0'],
    ['valid-name', 'not-semver'],
  ]) {
    const response = await publishForm({ name, version, bytes: tarballBytes(), token: OPEN_TOKEN });
    assert.equal(response.status, 400, `${name}@${version}`);
  }
});

test('reserved namespace requires a first-party token', async () => {
  const communityScoped = { token: 'iso-community', label: 'community', scopes: ['not-reserved'] };
  const firstPartyWildcard = { token: 'iso-first-party', label: 'fp', scopes: ['*'], firstParty: true };
  const registry = await startIsolatedRegistry({ tokens: [communityScoped, firstPartyWildcard] });
  try {
    // A community token with no xiom.* scope: 403.
    const denied = await publishForm({
      name: 'xiom.blocked', version: '0.1.0', bytes: tarballBytes(),
      token: communityScoped.token, url: registry.url,
    });
    assert.equal(denied.status, 403);

    // A first-party token: allowed.
    const allowed = await publishForm({
      name: 'xiom.allowed', version: '0.1.0', bytes: tarballBytes(),
      token: firstPartyWildcard.token, url: registry.url,
    });
    assert.equal(allowed.status, 201);
  } finally {
    registry.stop();
  }
});

test('xiom.* scope grants the namespace to a non-first-party token until the namespace is reserved', async () => {
  // `xiom.*` scope grants xiom.<name>, but the reserved-namespace policy
  // still requires firstParty for anything in xiom.*.
  const token = { token: 'iso-scoped', label: 'scoped', scopes: ['xiom.*'], firstParty: false };
  const registry = await startIsolatedRegistry({ tokens: [token] });
  try {
    const denied = await publishForm({
      name: 'xiom.scoped-pkg', version: '0.1.0', bytes: tarballBytes(),
      token: token.token, url: registry.url,
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'reserved_namespace');

    // Outside the reserved namespace the same scope grants nothing.
    const outside = await publishForm({
      name: 'scoped-pkg', version: '0.1.0', bytes: tarballBytes(),
      token: token.token, url: registry.url,
    });
    assert.equal(outside.status, 403);
    assert.equal((await outside.json()).code, 'scope_denied');
  } finally {
    registry.stop();
  }
});

test('scope-limited tokens are 403 outside their namespace', async () => {
  const denied = await publishForm({
    name: 'not-scoped', version: '0.1.0', bytes: tarballBytes(), token: FIRST_PARTY_TOKEN,
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'scope_denied');
});

test('download serves the exact bytes under both routes', async () => {
  const bytes = tarballBytes('download');
  const publish = await publishForm({
    name: 'download-pkg', version: '0.1.0', bytes, token: OPEN_TOKEN,
  });
  assert.equal(publish.status, 201);

  const canonical = await fetch(`${baseUrl}/packages/download-pkg/0.1.0/package.tar.gz`);
  assert.equal(canonical.status, 200);
  assert.equal(canonical.headers.get('content-type'), 'application/gzip');
  const body = Buffer.from(await canonical.arrayBuffer());
  assert.equal(
    crypto.createHash('sha256').update(body).digest('hex'),
    crypto.createHash('sha256').update(bytes).digest('hex'),
  );

  const alias = await fetch(`${baseUrl}/packages/download-pkg/0.1.0/download`);
  assert.equal(alias.status, 200);
});

test('download and metadata for unknown packages are 404', async () => {
  assert.equal((await fetch(`${baseUrl}/packages/nope/1.0.0/package.tar.gz`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/packages/nope`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/packages/open-pkg/9.9.9`)).status, 404);
});

test('yank marks the version, updates latest, and keeps the artifact', async () => {
  const v1 = tarballBytes('y1');
  const v2 = tarballBytes('y2');
  await publishForm({ name: 'yank-pkg', version: '1.0.0', bytes: v1, token: OPEN_TOKEN });
  await publishForm({ name: 'yank-pkg', version: '2.0.0', bytes: v2, token: OPEN_TOKEN });

  const response = await fetch(`${baseUrl}/packages/yank-pkg/2.0.0/yank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPEN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'broken' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.latest, '1.0.0');

  const index = await (await fetch(`${baseUrl}/index.json`)).json();
  const entry = index.packages['yank-pkg'].versions['2.0.0'];
  assert.equal(entry.yanked, true);
  assert.equal(entry.yankReason, 'broken');

  // Pinned installs keep working: the artifact is still served.
  const artifact = await fetch(`${baseUrl}/packages/yank-pkg/2.0.0/package.tar.gz`);
  assert.equal(artifact.status, 200);

  const missing = await fetch(`${baseUrl}/packages/yank-pkg/9.9.9/yank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPEN_TOKEN}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 404);
});

test('yank requires auth', async () => {
  const response = await fetch(`${baseUrl}/packages/yank-pkg/1.0.0/yank`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('oversized uploads are rejected with 413', async () => {
  const registry = await startIsolatedRegistry({
    tokens: [{ token: OPEN_TOKEN, label: 'open', scopes: ['*'] }],
    env: { MAX_TARBALL_BYTES: '1024' },
  });
  try {
    const form = new FormData();
    form.set('name', 'big-pkg');
    form.set('version', '0.1.0');
    form.set('package', new Blob([Buffer.alloc(4096)]), 'package.tar.gz');
    const response = await fetch(`${registry.url}/publish`, {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${OPEN_TOKEN}` },
    });
    assert.equal(response.status, 413);
  } finally {
    registry.stop();
  }
});

test('search filters locally over the index', async () => {
  const body = await (await fetch(`${baseUrl}/search?q=open`)).json();
  assert.ok(body.results.some((r) => r.name === 'open-pkg'));
  const all = await (await fetch(`${baseUrl}/search`)).json();
  assert.ok(all.results.length >= 1);
});

test('unknown routes return a typed 404', async () => {
  const response = await fetch(`${baseUrl}/no/such/route`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'no_route');
});

test('index growth limits are enforced', async () => {
  const registry = await startIsolatedRegistry({
    tokens: [{ token: OPEN_TOKEN, label: 'open', scopes: ['*'] }],
    env: { MAX_INDEX_PACKAGES: '1' },
  });
  try {
    const form = (name) => {
      const f = new FormData();
      f.set('name', name);
      f.set('version', '0.1.0');
      f.set('package', new Blob([tarballBytes(name)]), 'package.tar.gz');
      return f;
    };
    const first = await fetch(`${registry.url}/publish`, {
      method: 'POST', body: form('limit-one'), headers: { Authorization: `Bearer ${OPEN_TOKEN}` },
    });
    assert.equal(first.status, 201, await first.text());
    const second = await fetch(`${registry.url}/publish`, {
      method: 'POST', body: form('limit-two'), headers: { Authorization: `Bearer ${OPEN_TOKEN}` },
    });
    assert.equal(second.status, 507);
    assert.equal((await second.json()).code, 'index_full');
  } finally {
    registry.stop();
  }
});

test('rate limiting responds 429 with Retry-After', async () => {
  const registry = await startIsolatedRegistry({
    tokens: [{ token: OPEN_TOKEN, label: 'open', scopes: ['*'] }],
    env: { RATE_LIMIT_DISABLED: '0', RATE_LIMIT_MAX: '3' },
  });
  try {
    let last;
    for (let i = 0; i < 5; i++) {
      last = await fetch(`${registry.url}/health`);
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally {
    registry.stop();
  }
});

test('TRUST_PROXY=1 ignores spoofed X-Forwarded-For and never logs the permissive-proxy error', async () => {
  // Staging/production run behind one nginx hop. `trust proxy = true` would
  // key the limiter on the leftmost (client-controlled) XFF entry, so every
  // request could pick a fresh bucket, and express-rate-limit logs
  // ERR_ERL_PERMISSIVE_TRUST_PROXY on every request. This models nginx
  // appending the real client address and proves the hop count holds.
  const registry = await startIsolatedRegistry({
    tokens: [{ token: OPEN_TOKEN, label: 'open', scopes: ['*'] }],
    env: { RATE_LIMIT_DISABLED: '0', RATE_LIMIT_MAX: '2', TRUST_PROXY: '1' },
  });
  const proxy = http.createServer((req, res) => {
    const forwarded = req.headers['x-forwarded-for'];
    const headers = {
      ...req.headers,
      'x-forwarded-for': forwarded
        ? `${forwarded}, ${req.socket.remoteAddress}`
        : String(req.socket.remoteAddress),
    };
    const upstream = http.request({
      host: '127.0.0.1',
      port: Number(new URL(registry.url).port),
      path: req.url,
      method: req.method,
      headers,
    }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const logged = [];
  const originalError = console.error;
  let statuses = [];
  try {
    assert.equal(registry.app.get('trust proxy'), 1, 'a hop count, never a permissive boolean');
    console.error = (...args) => { logged.push(args.map((arg) => String(arg)).join(' ')); };
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${proxyUrl}/health`, {
        headers: { 'X-Forwarded-For': `203.0.113.${i}` },
      });
      statuses.push(response.status);
    }
  } finally {
    console.error = originalError;
    proxy.close();
    registry.stop();
  }
  assert.deepEqual(statuses.slice(0, 2), [200, 200]);
  assert.equal(statuses.at(-1), 429, 'spoofed XFF values must not rotate the bucket');
  assert.equal(
    logged.filter((line) => line.includes('ERR_ERL_PERMISSIVE_TRUST_PROXY')).length,
    0,
    'the limiter must not flag a permissive trust proxy',
  );
});
