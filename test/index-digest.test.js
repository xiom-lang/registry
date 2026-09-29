// XIOM Package Registry -- C5 index digest tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 C5: /index-digest.json describes the exact bytes /index.json
// serves (sha256, size, registry) and, when INDEX_SIGNING_KEY is configured,
// carries an ed25519 signature over the domain-separated payload. The
// protocol document itself gains no fields; a malformed key fails boot.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const {
  indexDigest,
  digestPayload,
  createIndexSigner,
  INDEX_DIGEST_CONTEXT,
} = require('../src/index-digest');
const {
  verify,
  fingerprint,
  privateKeyFromSeed,
  publicKeyHexFromPrivate,
} = require('../src/signatures');

const SEED = 'a'.repeat(64);

let sandbox;
let app;
let server;
let baseUrl;

function listen(instance) {
  return new Promise((resolve) => {
    const httpServer = instance.listen(0, '127.0.0.1', () => resolve(httpServer));
  });
}

const originOf = (httpServer) => `http://127.0.0.1:${httpServer.address().port}`;

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-digest-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'https://registry.digest.test';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([]));
  delete process.env.INDEX_SIGNING_KEY;

  app = createApp(loadConfig());
  // A non-trivial index so the digest covers a real document.
  app.locals.registry.indexStore.publishVersion('digest-demo', {
    version: '1.0.0',
    sha256: 'b'.repeat(64),
    signature: '',
    publicKey: '',
    size: 128,
    published: '2026-09-29T00:00:00.000Z',
    dependencies: {},
  });
  server = await listen(app);
  baseUrl = originOf(server);
});

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('the signer factory is explicit about empty and malformed keys', () => {
  assert.equal(createIndexSigner(''), null);
  assert.equal(createIndexSigner(null), null);
  assert.throws(() => createIndexSigner('not-a-key'), /32-byte hex seed/);
  const signer = createIndexSigner(SEED);
  const expected = publicKeyHexFromPrivate(privateKeyFromSeed(SEED));
  assert.equal(signer.publicKey, expected);
  assert.equal(signer.fingerprint, fingerprint(expected));
});

test('indexDigest commits to the exact bytes with a domain-separated payload', () => {
  const bytes = Buffer.from('{"registry":"https://example.test","packages":{}}');
  const at = new Date('2026-09-29T12:00:00Z');
  const digest = indexDigest({ bytes, registry: 'https://example.test', at });
  assert.deepEqual(digest, {
    version: 1,
    algorithm: 'sha256',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    registry: 'https://example.test',
    signedAt: '2026-09-29T12:00:00.000Z',
  });

  const signer = createIndexSigner(SEED);
  const signed = indexDigest({ bytes, registry: 'https://example.test', signer, at });
  assert.equal(signed.signatureAlgorithm, 'ed25519');
  assert.equal(signed.publicKey, signer.publicKey);
  assert.equal(signed.publicKeyFingerprint, signer.fingerprint);
  // The signature covers the context payload, never the index bytes directly.
  assert.equal(
    verify(signed.publicKey, digestPayload(signed.sha256), signed.signature),
    true,
  );
  assert.equal(
    verify(signed.publicKey, bytes, signed.signature),
    false,
    'the raw document is not the signed payload',
  );
  assert.ok(digestPayload(signed.sha256).toString('utf-8').startsWith(`${INDEX_DIGEST_CONTEXT}\n`));
});

test('the endpoint describes the served index bytes, unsigned by default', async () => {
  const indexResponse = await fetch(`${baseUrl}/index.json`);
  const served = Buffer.from(await indexResponse.arrayBuffer());
  assert.match(indexResponse.headers.get('content-type') || '', /application\/json/);

  const response = await fetch(`${baseUrl}/index-digest.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /public/);
  const digest = await response.json();
  assert.equal(digest.sha256, crypto.createHash('sha256').update(served).digest('hex'));
  assert.equal(digest.bytes, served.length);
  assert.equal(digest.registry, 'https://registry.digest.test');
  assert.equal(digest.algorithm, 'sha256');
  assert.ok(digest.signedAt);
  assert.equal('signature' in digest, false, 'no key configured, no signature');
  assert.equal('publicKey' in digest, false);

  // The protocol document itself is untouched.
  const parsed = JSON.parse(served.toString('utf-8'));
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['packages', 'registry', 'updated_at', 'version'],
  );
  assert.ok(parsed.packages['digest-demo']);
});

test('a configured key signs the digest and a malformed key fails boot', async () => {
  const config = loadConfig();
  config.indexSigningKey = SEED;
  const signedApp = createApp(config);
  const signedServer = await listen(signedApp);
  try {
    const signedBase = originOf(signedServer);
    const index = Buffer.from(await (await fetch(`${signedBase}/index.json`)).arrayBuffer());
    const digest = await (await fetch(`${signedBase}/index-digest.json`)).json();
    assert.equal(digest.publicKey, publicKeyHexFromPrivate(privateKeyFromSeed(SEED)));
    assert.equal(digest.signature.length, 128);
    assert.equal(verify(digest.publicKey, digestPayload(digest.sha256), digest.signature), true);
    assert.equal(digest.sha256, crypto.createHash('sha256').update(index).digest('hex'));
  } finally {
    signedServer.close();
  }

  // Fail closed: a typo in INDEX_SIGNING_KEY must never boot quietly.
  const bad = loadConfig();
  bad.indexSigningKey = 'definitely-not-a-key';
  assert.throws(() => createApp(bad), /32-byte hex seed/);
});
