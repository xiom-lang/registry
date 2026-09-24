// XIOM Package Registry -- package.xi parser and tarball extraction tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const { parseManifest, extractManifest } = require('../src/manifest');
const { normalizePackageMetadata, STAGES } = require('../src/categories');

test('parses a plain manifest', () => {
  const parsed = parseManifest([
    'name: "my-pkg";',
    'version: "1.2.3";',
    'description: "A package";',
  ].join('\n'));
  assert.equal(parsed.name, 'my-pkg');
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.description, 'A package');
});

test('parses the package block wrapper and comments', () => {
  const parsed = parseManifest([
    'package registry_e2e_fixture {',
    '  // comment',
    '  name: "wrapped";',
    '  version: "0.1.0";',
    '  description: "Wrapped package";',
    '}',
  ].join('\n'));
  assert.equal(parsed.name, 'wrapped');
  assert.equal(parsed.version, '0.1.0');
  assert.equal(parsed.description, 'Wrapped package');
});

test('does not confuse name: with filename-like fields', () => {
  const parsed = parseManifest('filename: "not-the-name";\nname: "real";');
  assert.equal(parsed.name, 'real');
});

test('parses inline deps', () => {
  const parsed = parseManifest(
    'name: "d";\nversion: "1.0.0";\ndeps: { "xiom-core": "0.1.0", "other": "^2.0.0" };\n',
  );
  assert.deepEqual(parsed.dependencies, { 'xiom-core': '0.1.0', other: '^2.0.0' });
});

test('parses categories, keywords, license, and repository', () => {
  const parsed = parseManifest([
    'name: "d";',
    'version: "1.0.0";',
    'categories: ["graphics", "gpu"];',
    'keywords: ["vulkan", "swapchain"];',
    'license: "MIT OR Apache-2.0";',
    'repository: "https://github.com/xiom-packages/packages";',
  ].join('\n'));
  assert.deepEqual(parsed.categories, ['graphics', 'gpu']);
  assert.deepEqual(parsed.keywords, ['vulkan', 'swapchain']);
  assert.equal(parsed.license, 'MIT OR Apache-2.0');
  assert.equal(parsed.repository, 'https://github.com/xiom-packages/packages');
});

test('parses the optional stage and normalizes it', () => {
  const manifest = `package staged {
  name: "staged";
  version: "0.1.0";
  stage: "incubating";
}`;
  const parsed = parseManifest(manifest);
  assert.equal(parsed.stage, 'incubating');

  const good = normalizePackageMetadata(parsed);
  assert.equal(good.stage, 'incubating');
  assert.equal(good.unknownStage, '');

  const unknown = normalizePackageMetadata({ ...parsed, stage: 'beta' });
  assert.equal(unknown.stage, '', 'unknown stages are ignored');
  assert.equal(unknown.unknownStage, 'beta', 'and surfaced for a publish warning');

  const empty = normalizePackageMetadata({ name: 'x', stage: undefined });
  assert.equal(empty.stage, '');
  assert.deepEqual(STAGES, ['incubating', 'stable', 'deprecated']);
});

test('parses multiline categories and keywords arrays', () => {
  const parsed = parseManifest([
    'name: "d";',
    'version: "1.0.0";',
    'categories: [',
    '  "database",',
    '];',
    'keywords: [',
    '  "redis",',
    '  "cache",',
    '  "key-value",',
    '];',
    'license: "MIT";',
  ].join('\n'));
  assert.deepEqual(parsed.categories, ['database']);
  assert.deepEqual(parsed.keywords, ['redis', 'cache', 'key-value']);
  assert.equal(parsed.license, 'MIT');
});

test('metadata fields default to empty when absent', () => {
  const parsed = parseManifest('name: "d";\nversion: "1.0.0";\n');
  assert.deepEqual(parsed.categories, []);
  assert.deepEqual(parsed.keywords, []);
  assert.equal(parsed.license, '');
  assert.equal(parsed.repository, '');
});

test('parses multiline deps with comma-containing specs', () => {
  const parsed = parseManifest([
    'name: "d";',
    'version: "1.0.0";',
    'deps: {',
    '  "xiom-std": ">=0.5.0,<1.0.0",',
    '  "local": "path:../local",',
    '};',
  ].join('\r\n'));
  assert.deepEqual(parsed.dependencies, {
    'xiom-std': '>=0.5.0,<1.0.0',
    local: 'path:../local',
  });
});

test('handles an empty or fieldless manifest', () => {
  assert.deepEqual(parseManifest(''), {
    name: '', version: '', description: '', dependencies: {},
    categories: [], keywords: [], license: '', repository: '', stage: '',
  });
  assert.deepEqual(
    parseManifest('// only a comment').dependencies,
    {},
  );
});

test('extracts the manifest from a real gzipped tarball', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-manifest-'));
  const pkgDir = path.join(dir, 'fixture');
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.xi'),
    'package f {\n  name: "from-tarball";\n  version: "3.2.1";\n  description: "Extracted";\n  deps: { "a": "1.0.0" };\n}\n',
  );
  fs.writeFileSync(path.join(pkgDir, 'src', 'lib.xi'), 'pub fn x() {}');
  const tarball = path.join(dir, 'package.tar.gz');
  // tar.c is async: the archive is not complete when the call returns.
  await tar.c({ gzip: true, file: tarball, cwd: dir }, ['fixture']);

  const parsed = extractManifest(tarball, {
    maxManifestBytes: 1024 * 1024,
    maxDecompressedBytes: 16 * 1024 * 1024,
  });
  assert.equal(parsed.name, 'from-tarball');
  assert.equal(parsed.version, '3.2.1');
  assert.equal(parsed.description, 'Extracted');
  assert.deepEqual(parsed.dependencies, { a: '1.0.0' });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns empty metadata for a non-tarball upload instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-manifest-bad-'));
  const bogus = path.join(dir, 'package.tar.gz');
  fs.writeFileSync(bogus, Buffer.from('this is not gzip at all'));
  const parsed = extractManifest(bogus, {
    maxManifestBytes: 1024,
    maxDecompressedBytes: 4096,
  });
  assert.deepEqual(parsed, {
    name: '', version: '', description: '', dependencies: {},
    categories: [], keywords: [], license: '', repository: '',
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses to expand beyond the decompression cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-manifest-bomb-'));
  const pkgDir = path.join(dir, 'fixture');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.xi'), 'name: "bomb";');
  // Highly compressible padding: the uncompressed tar is much larger than
  // the configured cap, so extraction must refuse it outright.
  fs.writeFileSync(path.join(pkgDir, 'junk.bin'), Buffer.alloc(1024 * 1024, 0x41));
  const tarball = path.join(dir, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: dir }, ['fixture']);

  const parsed = extractManifest(tarball, {
    maxManifestBytes: 1024,
    maxDecompressedBytes: 64 * 1024,
  });
  assert.equal(parsed.name, '', 'oversized expansion must be refused, not parsed');
  fs.rmSync(dir, { recursive: true, force: true });
});
