// XIOM Package Registry -- OIDC authentication integration tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// A real app instance is driven over HTTP with a local JWKS server: publish
// with a GitHub-style token, prove the provenance lands in /index.json,
// /packages/:name and the package page, and that unmapped/invalid tokens are
// refused while static tokens (including dotted ones) keep working.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { authenticate } = require('../src/tokens');
const { normalizePublishers } = require('../src/publishers');
const { createJwksCache } = require('../src/oidc');

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const API = { Accept: '*/*' };
const AUDIENCE = 'xiom-registry';
const STATIC_TOKEN = 'static-token-1';
const DOTTED_TOKEN = 'a.b.c';

function makeRsaKeypair(kid = 'gh-kid-1') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

function makeEd25519Keypair() {
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
  return { privateKey, publicKeyHex: publicKeyDer.subarray(publicKeyDer.length - 32).toString('hex') };
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function makeGithubToken(keypair, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: AUDIENCE,
    exp: nowSec + 300,
    nbf: nowSec - 10,
    iat: nowSec,
    sub: 'repo:xiom-lang/stdlib:ref:refs/heads/main',
    repository: 'xiom-lang/stdlib',
    workflow_ref: 'xiom-lang/stdlib/.github/workflows/publish-registry.yml@refs/heads/main',
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    sha: 'd'.repeat(40),
    run_id: '987654321',
    run_attempt: '1',
    ...overrides,
  };
  const signingInput = `${b64urlJson({ alg: 'RS256', kid: keypair.jwk.kid, typ: 'JWT' })}.${b64urlJson(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf-8'), keypair.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function tarballBytes(label) {
  return require('zlib').gzipSync(Buffer.from(`oidc-fixture-${label}-${crypto.randomBytes(4).toString('hex')}`));
}

async function publish(baseUrl, { token, name, version, bytes, signature, publicKey }) {
  const form = new FormData();
  form.set('name', name);
  form.set('version', version);
  if (signature) form.set('signature', signature);
  if (publicKey) form.set('publicKey', publicKey);
  form.set('package', new Blob([bytes], { type: 'application/gzip' }), 'package.tar.gz');
  return fetch(`${baseUrl}/publish`, {
    method: 'POST',
    body: form,
    headers: { Authorization: `Bearer ${token}` },
  });
}

function jwtRequest(token) {
  return { method: 'POST', headers: { authorization: `Bearer ${token}` }, query: {} };
}

test('authenticate: JWT maps to a trusted publisher with provenance', async () => {
  const keypair = makeRsaKeypair();
  const jwks = createJwksCache({
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ keys: [keypair.jwk] }) }),
  });
  const publishers = normalizePublishers([
    {
      label: 'stdlib-release',
      repository: 'xiom-lang/stdlib',
      workflow: 'publish-registry.yml',
      refs: ['refs/heads/main', 'refs/tags/stdlib-v*'],
      scopes: ['xiom.std', 'xiom-std'],
      firstParty: true,
    },
  ], 'test');

  const token = await authenticate(jwtRequest(makeGithubToken(keypair)), new Map(), {
    publishers, audience: AUDIENCE, jwks,
  });
  assert.equal(token.label, 'stdlib-release');
  assert.deepEqual(token.scopes, ['xiom.std', 'xiom-std']);
  assert.equal(token.trusted, true);
  assert.equal(token.firstParty, true);
  assert.equal(token.publisher.repository, 'xiom-lang/stdlib');
  assert.equal(token.publisher.commit, 'd'.repeat(40));
  assert.equal(token.publisher.runUrl, 'https://github.com/xiom-lang/stdlib/actions/runs/987654321');

  // Valid token, wrong repository: 403, never a silent static fallback.
  const unmapped = makeGithubToken(keypair, { repository: 'evil/repo' });
  await assert.rejects(
    authenticate(jwtRequest(unmapped), new Map(), { publishers, audience: AUDIENCE, jwks }),
    (err) => err.status === 403 && err.code === 'publisher_not_mapped',
  );

  // Bad audience and expiry are 401, not 403.
  await assert.rejects(
    authenticate(jwtRequest(makeGithubToken(keypair, { aud: 'other' })), new Map(), {
      publishers, audience: AUDIENCE, jwks,
    }),
    (err) => err.status === 401 && err.code === 'oidc_audience_mismatch',
  );
  await assert.rejects(
    authenticate(jwtRequest(makeGithubToken(keypair, { exp: Math.floor(Date.now() / 1000) - 600 })), new Map(), {
      publishers, audience: AUDIENCE, jwks,
    }),
    (err) => err.status === 401 && err.code === 'oidc_token_expired',
  );

  // A dotted static token is never misrouted to the JWT path.
  const staticTokens = new Map([
    [DOTTED_TOKEN, { label: 'dotted', scopes: ['*'], trusted: false, firstParty: false }],
  ]);
  const dotted = await authenticate(jwtRequest(DOTTED_TOKEN), staticTokens, {
    publishers, audience: AUDIENCE, jwks,
  });
  assert.equal(dotted.label, 'dotted');
});

test('HTTP: OIDC publish records and serves provenance; static tokens are unchanged', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-oidc-'));
  const keypair = makeRsaKeypair();
  const jwksServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [keypair.jwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/jwks`;

  const tokensFile = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify([
    { token: STATIC_TOKEN, label: 'static', scopes: ['*'], trusted: false, firstParty: true },
    { token: DOTTED_TOKEN, label: 'dotted', scopes: ['*'], trusted: false, firstParty: true },
  ]));
  const publishersFile = path.join(sandbox, 'trusted-publishers.json');
  fs.writeFileSync(publishersFile, JSON.stringify([
    {
      label: 'stdlib-staging',
      repository: 'xiom-lang/stdlib',
      workflow: 'publish-registry.yml',
      refs: ['refs/heads/main'],
      scopes: ['xiom.std', 'xiom-std'],
      firstParty: true,
    },
  ]));

  const env = {
    NODE_ENV: 'test',
    DATA_DIR: path.join(sandbox, 'data'),
    PACKAGES_DIR: path.join(sandbox, 'packages'),
    UPLOAD_TMP_DIR: path.join(sandbox, 'data', 'tmp'),
    REGISTRY_URL: 'https://registry.oidc.test',
    RATE_LIMIT_DISABLED: '1',
    TOKENS_FILE: tokensFile,
    TRUSTED_PUBLISHERS_FILE: publishersFile,
    OIDC_JWKS_URL: jwksUrl,
  };
  const savedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  let server;
  let baseUrl;
  try {
    const app = createApp(loadConfig());
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const ed = makeEd25519Keypair();
    const bytes = tarballBytes('oidc');
    const signature = crypto.sign(null, bytes, ed.privateKey).toString('hex');
    const oidcToken = makeGithubToken(keypair);

    const published = await publish(baseUrl, {
      token: oidcToken, name: 'xiom.std', version: '0.1.0',
      bytes, signature, publicKey: ed.publicKeyHex,
    });
    assert.equal(published.status, 201, await published.clone().text());

    const index = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
    const entry = index.packages['xiom.std'].versions['0.1.0'];
    assert.equal(entry.publisher.repository, 'xiom-lang/stdlib');
    assert.equal(entry.publisher.workflow, 'publish-registry.yml');
    assert.equal(entry.publisher.ref, 'refs/heads/main');
    assert.equal(entry.publisher.runId, '987654321');
    assert.equal(entry.publisher.runUrl, 'https://github.com/xiom-lang/stdlib/actions/runs/987654321');

    const pkgJson = await (await fetch(`${baseUrl}/packages/xiom.std`, { headers: API })).json();
    assert.equal(pkgJson.versions['0.1.0'].publisher.workflowRef,
      'xiom-lang/stdlib/.github/workflows/publish-registry.yml@refs/heads/main');

    const page = await (await fetch(`${baseUrl}/packages/xiom.std`, { headers: BROWSER })).text();
    assert.match(page, /Published by/);
    assert.match(page, /xiom-lang\/stdlib/);
    assert.match(page, /actions\/runs\/987654321/);

    // Unmapped repository: valid token, 403, nothing stored.
    const unmapped = await publish(baseUrl, {
      token: makeGithubToken(keypair, { repository: 'evil/repo' }),
      name: 'jwt-evil', version: '0.1.0', bytes, signature, publicKey: ed.publicKeyHex,
    });
    assert.equal(unmapped.status, 403);
    assert.equal((await unmapped.json()).code, 'publisher_not_mapped');

    // Invalid token: 401.
    const expired = await publish(baseUrl, {
      token: makeGithubToken(keypair, { exp: Math.floor(Date.now() / 1000) - 600 }),
      name: 'jwt-expired', version: '0.1.0', bytes, signature, publicKey: ed.publicKeyHex,
    });
    assert.equal(expired.status, 401);

    // Static tokens still publish, with no publisher field, dots included.
    const staticPublish = await publish(baseUrl, {
      token: STATIC_TOKEN, name: 'static-pkg', version: '0.1.0', bytes,
    });
    assert.equal(staticPublish.status, 201);
    const dottedPublish = await publish(baseUrl, {
      token: DOTTED_TOKEN, name: 'dotted-pkg', version: '0.1.0', bytes,
    });
    assert.equal(dottedPublish.status, 201);
    const after = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
    assert.equal(after.packages['static-pkg'].versions['0.1.0'].publisher, undefined);
    assert.equal(after.packages['dotted-pkg'].versions['0.1.0'].publisher, undefined);

    // Provenance survives a reload from disk (normalizeVersionEntry keeps it).
    const freshApp = createApp(loadConfig());
    const freshServer = await new Promise((resolve) => {
      const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const reloaded = await (await fetch(
        `http://127.0.0.1:${freshServer.address().port}/packages/xiom.std`,
        { headers: API },
      )).json();
      assert.equal(reloaded.versions['0.1.0'].publisher.repository, 'xiom-lang/stdlib');
    } finally {
      freshServer.close();
    }
  } finally {
    if (server) server.close();
    jwksServer.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
