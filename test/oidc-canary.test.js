// XIOM Package Registry -- OIDC canary script end-to-end test.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Runs scripts/oidc-canary.js as a child process against a local app
// instance whose JWKS is a local server, so the whole path (mint-shaped
// token -> publish -> read-back provenance) is exercised without network.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const AUDIENCE = 'xiom-registry';

function makeRsaKeypair(kid = 'canary-kid') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function makeToken(keypair, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: AUDIENCE,
    exp: nowSec + 300,
    nbf: nowSec - 10,
    sub: 'repo:xiom-lang/registry:ref:refs/heads/main',
    repository: 'xiom-lang/registry',
    workflow_ref: 'xiom-lang/registry/.github/workflows/oidc-canary.yml@refs/heads/main',
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    sha: 'c'.repeat(40),
    run_id: '424242',
    ...overrides,
  };
  const signingInput = `${b64urlJson({ alg: 'RS256', kid: keypair.jwk.kid })}.${b64urlJson(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf-8'), keypair.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

// Async on purpose: spawnSync would block this process's event loop, and the
// app under test runs inside this same process, so the canary's fetch could
// never be answered.
function runCanary(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'oidc-canary.js')],
      { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

test('canary script publishes and verifies provenance; unmapped tokens fail', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-canary-test-'));
  const keypair = makeRsaKeypair();
  const jwksServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [keypair.jwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));

  fs.writeFileSync(path.join(sandbox, 'tokens.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(sandbox, 'trusted-publishers.json'), JSON.stringify([
    {
      label: 'registry-canary',
      repository: 'xiom-lang/registry',
      workflow: 'oidc-canary.yml',
      refs: ['refs/heads/main'],
      scopes: ['xiom.canary-oidc'],
      firstParty: true,
    },
  ]));

  const env = {
    NODE_ENV: 'test',
    DATA_DIR: path.join(sandbox, 'data'),
    PACKAGES_DIR: path.join(sandbox, 'packages'),
    UPLOAD_TMP_DIR: path.join(sandbox, 'data', 'tmp'),
    REGISTRY_URL: 'https://registry.canary.test',
    RATE_LIMIT_DISABLED: '1',
    TOKENS_FILE: path.join(sandbox, 'tokens.json'),
    TRUSTED_PUBLISHERS_FILE: path.join(sandbox, 'trusted-publishers.json'),
    OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.address().port}/jwks`,
  };
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  let server;
  try {
    const app = createApp(loadConfig());
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const ok = await runCanary({
      XIOM_REGISTRY: baseUrl,
      XIOM_REGISTRY_TOKEN: makeToken(keypair),
      CANARY_PACKAGE: 'xiom.canary-oidc',
      CANARY_VERSION: '0.0.0-canary.1',
      CANARY_EXPECT_REPOSITORY: 'xiom-lang/registry',
    });
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.match(ok.stdout, /canary: OK/);
    assert.match(ok.stdout, /xiom-lang\/registry/);

    const stored = await (await fetch(`${baseUrl}/packages/xiom.canary-oidc`, {
      headers: { Accept: '*/*' },
    })).json();
    const publisher = stored.versions['0.0.0-canary.1'].publisher;
    assert.equal(publisher.repository, 'xiom-lang/registry');
    assert.equal(publisher.workflow, 'oidc-canary.yml');
    assert.equal(publisher.runUrl, 'https://github.com/xiom-lang/registry/actions/runs/424242');

    const unmapped = await runCanary({
      XIOM_REGISTRY: baseUrl,
      XIOM_REGISTRY_TOKEN: makeToken(keypair, { repository: 'evil/repo' }),
      CANARY_PACKAGE: 'xiom.canary-oidc',
      CANARY_VERSION: '0.0.0-canary.2',
      CANARY_EXPECT_REPOSITORY: 'xiom-lang/registry',
    });
    assert.equal(unmapped.status, 1);
    assert.match(unmapped.stderr, /publish returned 403/);
  } finally {
    if (server) server.close();
    jwksServer.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
