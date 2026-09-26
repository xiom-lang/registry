// XIOM Package Registry -- index store tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IndexStore, normalizeIndex, computeLatest } = require('../src/index');
const { ConflictError, IndexLimitError, NotFoundError } = require('../src/errors');

const REGISTRY_URL = 'https://registry.example.test';

function tmpStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-index-'));
  return new IndexStore({
    indexPath: path.join(dir, 'index.json'),
    registryUrl: REGISTRY_URL,
    maxIndexPackages: 100,
    maxIndexBytes: 1024 * 1024,
    maxVersionsPerPackage: 10,
    ...overrides,
  });
}

function versionEntry(version, extra = {}) {
  return {
    version,
    sha256: 'a'.repeat(64),
    signature: '',
    publicKey: '',
    size: 100,
    published: '2026-01-01T00:00:00.000Z',
    dependencies: {},
    ...extra,
  };
}

test('empty store emits registry + schema version', () => {
  const store = tmpStore();
  assert.equal(store.snapshot().registry, REGISTRY_URL);
  assert.equal(store.snapshot().version, '1.0.0');
  assert.deepEqual(store.snapshot().packages, {});
});

test('publish inserts, persists, and reloads', () => {
  const store = tmpStore();
  store.publishVersion('my-pkg', { ...versionEntry('0.1.0'), description: 'first' });
  assert.equal(store.getPackage('my-pkg').description, 'first');

  const reloaded = new IndexStore({
    indexPath: store.indexPath,
    registryUrl: REGISTRY_URL,
    maxIndexPackages: 100,
    maxIndexBytes: 1024 * 1024,
    maxVersionsPerPackage: 10,
  });
  assert.equal(reloaded.snapshot().registry, REGISTRY_URL);
  assert.equal(reloaded.requireVersion('my-pkg', '0.1.0').sha256, 'a'.repeat(64));
});

test('republishing an existing version throws ConflictError', () => {
  const store = tmpStore();
  store.publishVersion('my-pkg', versionEntry('0.1.0'));
  assert.throws(() => store.publishVersion('my-pkg', versionEntry('0.1.0')), ConflictError);
  // The failed publish must not corrupt state.
  assert.equal(Object.keys(store.getPackage('my-pkg').versions).length, 1);
});

test('latest prefers stable releases and skips yanked versions', () => {
  const store = tmpStore();
  store.publishVersion('my-pkg', versionEntry('1.0.0'));
  store.publishVersion('my-pkg', versionEntry('1.1.0-rc.1'));
  assert.equal(store.getPackage('my-pkg').latest, '1.0.0', 'prerelease must not become latest');
  store.publishVersion('my-pkg', versionEntry('1.1.0'));
  assert.equal(store.getPackage('my-pkg').latest, '1.1.0');
  store.yankVersion('my-pkg', '1.1.0');
  assert.equal(store.getPackage('my-pkg').latest, '1.0.0');
  store.yankVersion('my-pkg', '1.0.0');
  assert.equal(
    store.getPackage('my-pkg').latest,
    '1.1.0-rc.1',
    'the remaining installable prerelease becomes latest',
  );
  store.yankVersion('my-pkg', '1.1.0-rc.1');
  assert.equal(store.getPackage('my-pkg').latest, '', 'all-yanked package has no latest');
});

test('yank keeps the entry and marks it', () => {
  const store = tmpStore();
  store.publishVersion('my-pkg', versionEntry('0.1.0'));
  const yanked = store.yankVersion('my-pkg', '0.1.0', 'bad build');
  assert.equal(yanked.yanked, true);
  assert.equal(yanked.yankReason, 'bad build');
  assert.equal(store.requireVersion('my-pkg', '0.1.0').sha256, 'a'.repeat(64));
  assert.throws(() => store.yankVersion('my-pkg', '9.9.9'), NotFoundError);
});

test('version-per-package limit throws IndexLimitError', () => {
  const store = tmpStore({ maxVersionsPerPackage: 2 });
  store.publishVersion('my-pkg', versionEntry('0.1.0'));
  store.publishVersion('my-pkg', versionEntry('0.2.0'));
  assert.throws(() => store.publishVersion('my-pkg', versionEntry('0.3.0')), IndexLimitError);
});

test('package-count limit throws IndexLimitError', () => {
  const store = tmpStore({ maxIndexPackages: 1 });
  store.publishVersion('one', versionEntry('0.1.0'));
  assert.throws(() => store.publishVersion('two', versionEntry('0.1.0')), IndexLimitError);
});

test('index byte limit throws before writing', () => {
  const store = tmpStore({ maxIndexBytes: 400 });
  assert.throws(() => store.publishVersion('my-pkg', versionEntry('0.1.0')), IndexLimitError);
  assert.equal(fs.existsSync(store.indexPath), false, 'nothing may be written on limit');
});

test('normalizeIndex upgrades legacy shapes', () => {
  const index = normalizeIndex({
    packages: {
      legacy: { name: 'legacy', versions: ['1.0.0', '0.9.0'], latest: '9.9.9' },
      seeded: {
        name: 'seeded',
        stage: 'incubating',
        versions: {
          '0.1.0': { version: '0.1.0', publickey: 'AB'.repeat(32), dependencies: [] },
        },
      },
    },
  }, REGISTRY_URL);

  assert.equal(index.registry, REGISTRY_URL);
  assert.equal(index.packages.legacy.latest, '1.0.0', 'legacy list form normalized');
  assert.equal(index.packages.legacy.versions['1.0.0'].sha256, '');
  assert.equal(index.packages.seeded.versions['0.1.0'].publicKey, 'ab'.repeat(32));
  assert.deepEqual(index.packages.seeded.versions['0.1.0'].dependencies, {});
  assert.equal(index.packages.seeded.stage, 'incubating', 'package stage survives reload');
  assert.equal(index.packages.legacy.stage, '', 'missing stage normalizes to empty');
});

test('per-version stage survives a reload so badges can fall back to it', () => {
  const store = tmpStore();
  store.publishVersion('my-pkg', versionEntry('0.1.0', { stage: 'incubating' }));
  const reloaded = new IndexStore({
    indexPath: store.indexPath,
    registryUrl: REGISTRY_URL,
    maxIndexPackages: 100,
    maxIndexBytes: 1024 * 1024,
    maxVersionsPerPackage: 10,
  });
  assert.equal(
    reloaded.requireVersion('my-pkg', '0.1.0').stage,
    'incubating',
    'the publish-time stage is not stripped on load',
  );
});

test('computeLatest ignores invalid semver', () => {
  assert.equal(computeLatest({ bad: { version: 'not-semver' } }), '');
  assert.equal(computeLatest({ a: { version: '1.0.0' }, b: { version: '2.0.0' } }), '2.0.0');
});

test('metadata with malformed signature pair is rejected', () => {
  const store = tmpStore();
  assert.throws(
    () => store.publishVersion('my-pkg', versionEntry('0.1.0', { signature: 'zz', publicKey: '' })),
    /signature/i,
  );
  assert.equal(fs.existsSync(store.indexPath), false, 'invalid metadata must not persist');
});
