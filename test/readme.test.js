// XIOM Package Registry -- README extraction tests (SESSION.md section 13).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const { extractReadme, README_MAX_BYTES } = require('../src/readme');

/** Build a gzipped tarball from a name -> contents map. */
async function makeTarball(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-readme-'));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  const tarball = path.join(dir, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: dir }, Object.keys(files));
  return { dir, tarball };
}

test('extracts README.md from the stored tarball', async () => {
  const { dir, tarball } = await makeTarball({
    'package.xi': 'name: "demo";\nversion: "1.0.0";',
    'README.md': '# Demo\n\nHello **world**.',
    'src/main.xi': 'fun main() {}',
  });
  try {
    assert.equal(extractReadme(tarball), '# Demo\n\nHello **world**.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matches readme.md at any depth and case-insensitively', async () => {
  const { dir, tarball } = await makeTarball({
    'docs/readme.md': 'lowercase nested',
    'package.xi': 'name: "demo";',
  });
  try {
    assert.equal(extractReadme(tarball), 'lowercase nested');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null when the readme is absent, unreadable, or a bomb', async () => {
  const { dir, tarball } = await makeTarball({ 'package.xi': 'name: "demo";' });
  try {
    assert.equal(extractReadme(tarball), null);
    assert.equal(extractReadme(path.join(dir, 'missing.tar.gz')), null);

    const corrupt = path.join(dir, 'corrupt.tar.gz');
    fs.writeFileSync(corrupt, Buffer.from('not a gzip'));
    assert.equal(extractReadme(corrupt), null);

    const bomb = path.join(dir, 'bomb.tar.gz');
    const source = await makeTarball({ 'junk.bin': Buffer.alloc(256 * 1024, 0x41) });
    fs.copyFileSync(source.tarball, bomb);
    assert.equal(
      extractReadme(bomb, { maxDecompressedBytes: 64 * 1024 }),
      null,
      'an archive that exceeds the decompression cap is refused',
    );
    fs.rmSync(source.dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds the extracted readme at the byte cap', async () => {
  const big = 'A'.repeat(128 * 1024);
  const { dir, tarball } = await makeTarball({ 'README.md': big });
  try {
    assert.equal(extractReadme(tarball).length, README_MAX_BYTES);
    assert.equal(extractReadme(tarball, { maxReadmeBytes: 1024 }).length, 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
