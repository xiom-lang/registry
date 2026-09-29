// XIOM Package Registry -- read-only /validate preflight tests (Track B3).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 Track B3: `POST /validate` runs the exact publish checks --
// name, semver, scope, namespace, conflicts, signature rules, manifest,
// warnings, attestation -- and writes nothing: no artifact on disk, no index
// entry, no staged upload left behind. Status codes mirror /publish.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const BROWSER = { Accept: 'text/html,application/xhtml+xml' };
const API = { Accept: '*/*' };

let app;
let server;
let baseUrl;
let sandbox;
let uploadDir;
let packagesDir;

function listen(instance) {
  return new Promise((resolve) => {
    const httpServer = instance.listen(0, '127.0.0.1', () => resolve(httpServer));
  });
}

function keypair() {
  const seed = crypto.randomBytes(32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { publicKeyHex: publicKeyDer.subarray(12).toString('hex'), privateKey };
}

const manifest = (name, version, { categories = '[ "tooling" ]', stage = 'stable', readme = true } = {}) => {
  const lines = [`name: "${name}";`, `version: "${version}";`];
  if (categories !== null) lines.push(`categories: ${categories};`);
  if (stage) lines.push(`stage: "${stage}";`);
  return { manifest: `${lines.join('\n')}\n`, readme };
};

async function tarballBytes(name, version, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-validate-'));
  const pkgDir = path.join(dir, 'fixture');
  const { manifest: manifestText, readme } = manifest(name, version, options);
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.xi'), manifestText);
  fs.writeFileSync(path.join(pkgDir, 'src', 'lib.xi'), 'pub fn x() {}');
  if (readme) fs.writeFileSync(path.join(pkgDir, 'README.md'), `# ${name}\n`);
  const tarball = path.join(dir, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: dir }, ['fixture']);
  const bytes = fs.readFileSync(tarball);
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

async function post(token, target, { name, version, bytes, signature, publicKey, attestation }) {
  const form = new FormData();
  if (name !== undefined) form.set('name', name);
  if (version !== undefined) form.set('version', version);
  if (signature) form.set('signature', signature);
  if (publicKey) form.set('publicKey', publicKey);
  if (attestation) form.set('attestation', attestation);
  if (bytes) form.set('package', new Blob([bytes], { type: 'application/gzip' }), 'package.tar.gz');
  const headers = { Accept: '*/*' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${target}`, { method: 'POST', body: form, headers });
}

const validate = (token, fields) => post(token, '/validate', fields);
const publish = (token, fields) => post(token, '/publish', fields);

const stagedCount = () => fs.readdirSync(uploadDir).length;

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-validate-http-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'http://127.0.0.1:3999';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: 'open-token', label: 'open', scopes: ['*'], trusted: false, firstParty: true },
    { token: 'trusted-token', label: 'trusted', scopes: ['*'], trusted: true, firstParty: true },
    { token: 'scoped-token', label: 'scoped', scopes: ['other-pkg'], trusted: false, firstParty: true },
  ]));

  app = createApp(loadConfig());
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  uploadDir = process.env.UPLOAD_TMP_DIR;
  packagesDir = process.env.PACKAGES_DIR;

  // A real version exists so the conflict path is exercised for real.
  const seeded = await tarballBytes('existing-pkg', '1.0.0');
  const created = await publish('open-token', { name: 'existing-pkg', version: '1.0.0', bytes: seeded });
  assert.equal(created.status, 201, await created.text());
});

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a valid preflight reports the digest and warnings, and writes nothing', async () => {
  const before = stagedCount();
  const bytes = await tarballBytes('validate-demo', '1.0.0');
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  const response = await validate('open-token', {
    name: 'validate-demo', version: '1.0.0', bytes,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.package, 'validate-demo');
  assert.equal(body.version, '1.0.0');
  assert.equal(body.sha256, expected);
  assert.equal(body.size, bytes.length);
  assert.equal('warnings' in body, false, 'a clean tarball has no warnings');
  assert.match(body.message, /nothing was written/);

  // No artifact, no index entry, no staged upload.
  assert.equal(fs.existsSync(path.join(packagesDir, 'validate-demo')), false);
  assert.equal((await fetch(`${baseUrl}/packages/validate-demo`, { headers: API })).status, 404);
  const index = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
  assert.ok(!('validate-demo' in index.packages));
  assert.equal(stagedCount(), before, 'the staged upload is removed');

  // The same payload really would publish afterwards.
  const created = await publish('open-token', { name: 'validate-demo', version: '1.0.0', bytes });
  assert.equal(created.status, 201, await created.text());
});

test('warnings surface exactly like publish would report them', async () => {
  const bytes = await tarballBytes('warn-demo', '1.0.0', { categories: null, stage: '', readme: false });
  const response = await validate('open-token', { name: 'warn-demo', version: '1.0.0', bytes });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.warnings.length, 3);
  assert.ok(body.warnings.some((line) => line.includes('no categories declared')));
  assert.ok(body.warnings.some((line) => line.includes('no stage declared')));
  assert.ok(body.warnings.some((line) => line.includes('no README.md')));
});

test('conflicts, signature rules, scope, and auth mirror /publish', async () => {
  // Existing version -> 409, same code as publish.
  const duplicate = await validate('open-token', {
    name: 'existing-pkg', version: '1.0.0', bytes: await tarballBytes('existing-pkg', '1.0.0'),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'version_exists');

  // Trusted token must sign; a valid signature passes the same check.
  const unsigned = await validate('trusted-token', {
    name: 'sig-demo', version: '1.0.0', bytes: await tarballBytes('sig-demo', '1.0.0'),
  });
  assert.equal(unsigned.status, 422);
  assert.equal((await unsigned.json()).code, 'signature_required');

  const bytes = await tarballBytes('sig-demo', '1.0.0');
  const { publicKeyHex, privateKey } = keypair();
  const signature = crypto.sign(null, bytes, privateKey).toString('hex');
  const signed = await validate('trusted-token', {
    name: 'sig-demo', version: '1.0.0', bytes, signature, publicKey: publicKeyHex,
  });
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).signature, signature);

  // Scope and authentication.
  const scoped = await validate('scoped-token', {
    name: 'validate-demo', version: '9.9.9', bytes: await tarballBytes('validate-demo', '9.9.9'),
  });
  assert.equal(scoped.status, 403);
  assert.equal((await scoped.json()).code, 'scope_denied');
  const anonymous = await validate('', {
    name: 'validate-demo', version: '9.9.9', bytes: await tarballBytes('validate-demo', '9.9.9'),
  });
  assert.equal(anonymous.status, 401);

  // C2 rule: an attestation needs OIDC provenance, in validate the same way.
  const attested = await validate('open-token', {
    name: 'att-demo',
    version: '1.0.0',
    bytes: await tarballBytes('att-demo', '1.0.0'),
    attestation: 'https://github.com/xiom-lang/demo/attestations/1',
  });
  assert.equal(attested.status, 400);
  assert.equal((await attested.json()).code, 'attestation_without_provenance');

  // Malformed name and version are 400s, like publish.
  const badName = await validate('open-token', {
    name: 'Bad Name', version: '1.0.0', bytes: await tarballBytes('bad-name', '1.0.0'),
  });
  assert.equal(badName.status, 400);
  const badVersion = await validate('open-token', {
    name: 'validate-demo', version: 'not-semver', bytes: await tarballBytes('validate-demo', '2.0.0'),
  });
  assert.equal(badVersion.status, 400);
  assert.equal((await badVersion.json()).code, 'invalid_version');

  // Every rejection also leaves no staged upload behind.
  assert.equal(stagedCount(), 0, 'uploads are cleaned on every path');
});
