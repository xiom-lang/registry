// XIOM Package Registry -- C2 attestation storage tests (supplied + setter).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The discovery path (registry asks GitHub) is covered end-to-end in
// oidc-canary.test.js; this file pins the publisher-supplied field rules:
// canonical URLs only, provenance required, and the additive
// IndexStore.setAttestation helper.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const { loadConfig } = require('../src/config');
const { IndexStore } = require('../src/index');
const { ArtifactStore } = require('../src/storage');
const { publish } = require('../src/app');

const ATT = 'https://github.com/xiom-lang/demo/attestations/987654';

let sandbox;
let config;
let indexStore;
let artifacts;

async function stage(name, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-att-pub-'));
  const pkgDir = path.join(dir, 'fixture');
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.xi'), `name: "${name}";\nversion: "${version}";\n`);
  fs.writeFileSync(path.join(pkgDir, 'src', 'lib.xi'), 'pub fn x() {}');
  const tarball = path.join(dir, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: dir }, ['fixture']);
  const staged = path.join(config.uploadTmpDir, `${name}-${version}-${Math.random().toString(36).slice(2)}.tar.gz`);
  fs.copyFileSync(tarball, staged);
  fs.rmSync(dir, { recursive: true, force: true });
  return staged;
}

function token(overrides = {}) {
  return {
    label: 'att-test',
    trusted: false,
    scopes: ['*'],
    firstParty: true,
    publisher: {
      repository: 'xiom-lang/demo',
      workflow: 'publish.yml',
      ref: 'refs/tags/demo-v1',
      runId: '123',
      runUrl: 'https://github.com/xiom-lang/demo/actions/runs/123',
    },
    ...overrides,
  };
}

test.before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-att-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'http://127.0.0.1:3999';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([]));
  fs.mkdirSync(process.env.UPLOAD_TMP_DIR, { recursive: true });
  config = loadConfig();
  indexStore = new IndexStore(config);
  artifacts = new ArtifactStore(config);
});

test.after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a publisher-supplied attestation is validated, stored, and returned', async () => {
  const staged = await stage('att-demo', '1.0.0');
  const result = publish(
    { file: { path: staged }, body: { name: 'att-demo', version: '1.0.0', attestation: ATT } },
    { config, indexStore, artifacts, token: token() },
  );
  assert.equal(result.attestation, ATT);
  const entry = indexStore.getPackage('att-demo').versions['1.0.0'];
  assert.equal(entry.publisher.attestation, ATT);
  // The protocol document stays otherwise untouched: digest/signature fields
  // are unchanged by the additive URL.
  assert.equal(entry.publisher.repository, 'xiom-lang/demo');
  assert.equal(entry.version, '1.0.0');
});

test('a publish without an attestation stays unchanged', async () => {
  const staged = await stage('att-demo', '1.1.0');
  const result = publish(
    { file: { path: staged }, body: { name: 'att-demo', version: '1.1.0' } },
    { config, indexStore, artifacts, token: token() },
  );
  assert.equal(result.attestation, '');
  const entry = indexStore.getPackage('att-demo').versions['1.1.0'];
  assert.equal('attestation' in entry.publisher, false);
});

test('non-canonical attestation URLs and missing provenance are refused', async () => {
  const staged = await stage('att-demo', '1.2.0');
  assert.throws(
    () => publish(
      {
        file: { path: staged },
        body: { name: 'att-demo', version: '1.2.0', attestation: 'https://evil.example/a' },
      },
      { config, indexStore, artifacts, token: token() },
    ),
    (err) => err.code === 'bad_attestation',
  );
  assert.ok(!indexStore.getPackage('att-demo').versions['1.2.0'], 'nothing was indexed');

  const staged2 = await stage('att-demo', '1.3.0');
  assert.throws(
    () => publish(
      { file: { path: staged2 }, body: { name: 'att-demo', version: '1.3.0', attestation: ATT } },
      { config, indexStore, artifacts, token: token({ publisher: undefined }) },
    ),
    (err) => err.code === 'attestation_without_provenance',
  );
});

test('setAttestation is provenance-only and rejects unknown versions', async () => {
  // A static-token publish (no publisher object) cannot take an attestation.
  const name = 'att-plain';
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-att-plain-'));
  fs.mkdirSync(path.join(fixture, 'fixture', 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'fixture', 'package.xi'), `name: "${name}";\nversion: "1.0.0";\n`);
  fs.writeFileSync(path.join(fixture, 'fixture', 'src', 'lib.xi'), 'pub fn x() {}');
  const tarball = path.join(fixture, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: fixture }, ['fixture']);
  const staged = path.join(config.uploadTmpDir, 'plain-staged.tar.gz');
  fs.copyFileSync(tarball, staged);
  fs.rmSync(fixture, { recursive: true, force: true });
  publish(
    { file: { path: staged }, body: { name, version: '1.0.0' } },
    { config, indexStore, artifacts, token: token({ publisher: undefined }) },
  );
  assert.equal(indexStore.setAttestation(name, '1.0.0', ATT), null, 'no provenance, no attach');
  assert.equal(
    'attestation' in (indexStore.getPackage(name).versions['1.0.0'].publisher || {}),
    false,
  );
  assert.throws(
    () => indexStore.setAttestation(name, '9.9.9', ATT),
    (err) => err.code === 'version_not_found',
  );
});
