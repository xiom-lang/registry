// XIOM Package Registry -- offline export bundle tests (SESSION.md 21 C3).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The exporter is exercised against a local fixture registry: exact index
// bytes, per-artifact hashes, resume without re-fetching, latest-only
// selection, integrity failures, and the offline --verify pass.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  exportBundle,
  verifyBundle,
  selectArtifacts,
  parseArgs,
  sha256File,
  ExportError,
} = require('../scripts/export-bundle');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const BODIES = {
  'fixture.alpha@1.0.0': Buffer.from('alpha one bytes'),
  'fixture.alpha@1.1.0-rc.1': Buffer.from('alpha rc bytes'),
  'fixture.beta@2.0.0': Buffer.from('beta bytes'),
  'fixture.tampered@1.0.0': Buffer.from('tampered serves other bytes'),
};

function fixtureIndex() {
  return {
    registry: 'http://127.0.0.1:0',
    version: '1',
    updated_at: '2026-09-29T00:00:00Z',
    packages: {
      'fixture.alpha': {
        latest: '1.0.0',
        versions: {
          '1.0.0': {
            version: '1.0.0',
            sha256: sha256(BODIES['fixture.alpha@1.0.0']),
            size: BODIES['fixture.alpha@1.0.0'].length,
            signature: 'sig-alpha',
            publicKey: 'key-alpha',
            published: '2026-09-28T10:00:00Z',
            dependencies: {},
          },
          '1.1.0-rc.1': {
            version: '1.1.0-rc.1',
            sha256: sha256(BODIES['fixture.alpha@1.1.0-rc.1']),
            size: BODIES['fixture.alpha@1.1.0-rc.1'].length,
            signature: 'sig-alpha-rc',
            publicKey: 'key-alpha',
            published: '2026-09-29T09:00:00Z',
            dependencies: {},
          },
        },
      },
      'fixture.beta': {
        latest: '2.0.0',
        versions: {
          '2.0.0': {
            version: '2.0.0',
            sha256: sha256(BODIES['fixture.beta@2.0.0']),
            size: BODIES['fixture.beta@2.0.0'].length,
            signature: 'sig-beta',
            publicKey: 'key-beta',
            published: '2026-09-27T10:00:00Z',
            dependencies: {},
          },
        },
      },
      'fixture.legacy': {
        latest: '0.0.1',
        versions: {
          '0.0.1': { version: '0.0.1', published: '2026-01-01T00:00:00Z', dependencies: {} },
        },
      },
      'fixture.tampered': {
        latest: '1.0.0',
        versions: {
          '1.0.0': {
            version: '1.0.0',
            sha256: sha256(Buffer.from('never served')),
            size: 18,
            signature: 'sig-tampered',
            publicKey: 'key-tampered',
            published: '2026-09-26T10:00:00Z',
            dependencies: {},
          },
        },
      },
    },
  };
}

/** A fixture registry that counts artifact fetches per test. */
async function registryServer({ index = fixtureIndex() } = {}) {
  const state = { artifactFetches: 0, indexFetches: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/index.json') {
      state.indexFetches += 1;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(index));
    }
    const match = url.pathname.match(/^\/packages\/([^/]+)\/([^/]+)\/package\.tar\.gz$/);
    if (match) {
      state.artifactFetches += 1;
      const key = `${decodeURIComponent(match[1])}@${decodeURIComponent(match[2])}`;
      const body = BODIES[key];
      if (!body) {
        res.statusCode = 404;
        return res.end('not found');
      }
      return res.end(body);
    }
    res.statusCode = 404;
    return res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-export-'));
}

test('parseArgs reads the documented flags and rejects nonsense', () => {
  const args = parseArgs(['--registry', 'https://r.example', '--out', './bundle', '--latest-only', '--force', '--concurrency', '8']);
  assert.deepEqual(
    { registry: args.registry, out: args.out, latestOnly: args.latestOnly, force: args.force, concurrency: args.concurrency },
    { registry: 'https://r.example', out: './bundle', latestOnly: true, force: true, concurrency: 8 },
  );
  assert.equal(parseArgs(['--verify', './mirror']).verify, './mirror');
  assert.throws(() => parseArgs(['--registry', 'x']), /usage:/);
  assert.throws(() => parseArgs(['--wat']), /unknown argument/);
  assert.throws(() => parseArgs(['--registry', 'x', '--out', 'y', '--concurrency', '99']), /between 1 and 16/);
});

test('selectArtifacts keeps digest-bearing versions, latest-only narrows', () => {
  const index = fixtureIndex();
  const all = selectArtifacts(index);
  assert.deepEqual(
    all.artifacts.map((record) => `${record.name}@${record.version}`),
    ['fixture.alpha@1.0.0', 'fixture.alpha@1.1.0-rc.1', 'fixture.beta@2.0.0', 'fixture.tampered@1.0.0'],
  );
  assert.deepEqual(all.skipped, [
    { name: 'fixture.legacy', version: '0.0.1', reason: 'no digest in the index (legacy entry)' },
  ]);
  const latest = selectArtifacts(index, { latestOnly: true });
  assert.deepEqual(
    latest.artifacts.map((record) => `${record.name}@${record.version}`),
    ['fixture.alpha@1.0.0', 'fixture.beta@2.0.0', 'fixture.tampered@1.0.0'],
  );
});

test('exportBundle writes the documented layout, verifies hashes, and resumes', async () => {
  const registry = await registryServer();
  const out = tempDir();
  try {
    const manifest = await exportBundle({
      registry: registry.baseUrl,
      outDir: out,
      fetchImpl: fetch,
      log: () => {},
      now: () => new Date('2026-09-29T12:00:00Z'),
      // The tampered fixture must not be in this index run.
    }).catch((err) => err);
    assert.ok(manifest instanceof ExportError, 'the tampered artifact fails the first run');
    assert.match(manifest.message, /integrity failure for fixture\.tampered@1\.0\.0/);
    assert.ok(!fs.existsSync(path.join(out, 'bundle.json')), 'no manifest is written on failure');
    assert.ok(!fs.existsSync(path.join(out, 'artifacts', 'fixture.tampered', '1.0.0', 'package.tar.gz.part')),
      'partial downloads are cleaned up');
    assert.ok(fs.existsSync(path.join(out, 'artifacts', 'fixture.alpha', '1.0.0', 'package.tar.gz')),
      'good artifacts fetched before the failure stay on disk for the retry');

    // Drop the poisoned package and export for real.
    const clean = fixtureIndex();
    delete clean.packages['fixture.tampered'];
    const good = await registryServer({ index: clean });
    try {
      const fetchesBefore = good.artifactFetches;
      const manifest2 = await exportBundle({
        registry: good.baseUrl,
        outDir: out,
        fetchImpl: fetch,
        log: () => {},
        now: () => new Date('2026-09-29T12:00:00Z'),
      });
      assert.equal(manifest2.generatedAt, '2026-09-29T12:00:00.000Z');
      assert.equal(manifest2.bundleVersion, 1);
      assert.equal(manifest2.registry, good.baseUrl);
      assert.equal(manifest2.index.packages, 3);
      assert.equal(manifest2.totals.artifacts, 3);
      assert.equal(
        manifest2.totals.downloaded + manifest2.totals.reused,
        3,
        'every selected artifact is either fetched or reused',
      );
      assert.deepEqual(manifest2.skipped.map((entry) => entry.name), ['fixture.legacy']);

      const alpha = manifest2.packages['fixture.alpha'].versions['1.0.0'];
      assert.equal(alpha.path, 'artifacts/fixture.alpha/1.0.0/package.tar.gz');
      assert.equal(alpha.sha256, sha256(BODIES['fixture.alpha@1.0.0']));
      assert.equal(alpha.size, BODIES['fixture.alpha@1.0.0'].length);
      assert.equal(alpha.signature, 'sig-alpha');
      assert.equal(alpha.publicKey, 'key-alpha');
      assert.equal(alpha.source, `${good.baseUrl}/packages/fixture.alpha/1.0.0/package.tar.gz`);
      assert.equal(manifest2.packages['fixture.alpha'].latest, '1.0.0');
      assert.equal(manifest2.packages['fixture.alpha'].versions['1.1.0-rc.1'].yanked, false);

      // index.json is byte-for-byte the served document.
      const onDisk = fs.readFileSync(path.join(out, 'index.json'));
      assert.equal(sha256(onDisk), manifest2.index.sha256);
      assert.deepEqual(JSON.parse(onDisk.toString('utf-8')), clean);

      // A second run re-uses every artifact without new fetches.
      const fetchesAfterFirst = good.artifactFetches;
      const manifest3 = await exportBundle({
        registry: good.baseUrl,
        outDir: out,
        fetchImpl: fetch,
        log: () => {},
      });
      assert.equal(good.artifactFetches, fetchesAfterFirst, 'resume makes no artifact requests');
      assert.equal(manifest3.totals.downloaded, 0);
      assert.equal(manifest3.totals.reused, 3);

      // --force re-fetches everything.
      const manifest4 = await exportBundle({
        registry: good.baseUrl, outDir: out, force: true, fetchImpl: fetch, log: () => {},
      });
      assert.equal(good.artifactFetches, fetchesAfterFirst + 3);
      assert.equal(manifest4.totals.downloaded, 3);

      // The offline verification pass accepts the bundle...
      const verified = verifyBundle(out, { log: () => {} });
      assert.equal(verified.artifacts, 3);

      // ...and catches corruption after the fact.
      const victim = path.join(out, 'artifacts', 'fixture.beta', '2.0.0', 'package.tar.gz');
      fs.writeFileSync(victim, 'corrupted');
      assert.throws(() => verifyBundle(out, { log: () => {} }), /integrity failure for fixture\.beta@2\.0\.0/);
    } finally {
      await good.close();
    }
  } finally {
    await registry.close();
  }
});

test('exportBundle --latest-only mirrors only the index latest', async () => {
  const registry = await registryServer();
  const out = tempDir();
  try {
    const clean = fixtureIndex();
    delete clean.packages['fixture.tampered'];
    const good = await registryServer({ index: clean });
    try {
      const manifest = await exportBundle({
        registry: good.baseUrl,
        outDir: out,
        latestOnly: true,
        fetchImpl: fetch,
        log: () => {},
      });
      assert.deepEqual(Object.keys(manifest.packages).sort(), ['fixture.alpha', 'fixture.beta']);
      assert.deepEqual(Object.keys(manifest.packages['fixture.alpha'].versions), ['1.0.0']);
      assert.equal(manifest.totals.artifacts, 2);
      assert.ok(!fs.existsSync(path.join(out, 'artifacts', 'fixture.alpha', '1.1.0-rc.1')));
      assert.equal(verifyBundle(out, { log: () => {} }).artifacts, 2);
    } finally {
      await good.close();
    }
  } finally {
    await registry.close();
  }
});

test('exportBundle fails fast on a missing artifact and on an unsafe path', async () => {
  const registry = await registryServer();
  const out = tempDir();
  try {
    const index = fixtureIndex();
    delete index.packages['fixture.tampered'];
    index.packages['fixture.beta'].versions['2.0.0'].sha256 = sha256(Buffer.from('other bytes'));
    const mismatch = await registryServer({ index });
    try {
      await assert.rejects(
        exportBundle({ registry: mismatch.baseUrl, outDir: out, fetchImpl: fetch, log: () => {} }),
        /integrity failure for fixture\.beta@2\.0\.0/,
      );
      assert.ok(!fs.existsSync(path.join(out, 'bundle.json')));
    } finally {
      await mismatch.close();
    }

    // A hostile index cannot escape the output directory.
    const evil = {
      registry: 'x',
      version: '1',
      packages: { '../escape': { latest: '1.0.0', versions: { '1.0.0': { sha256: 'a'.repeat(64) } } } },
    };
    const evilServer = await registryServer({ index: evil });
    try {
      await assert.rejects(
        exportBundle({ registry: evilServer.baseUrl, outDir: tempDir(), fetchImpl: fetch, log: () => {} }),
        /refusing unsafe path/,
      );
    } finally {
      await evilServer.close();
    }
  } finally {
    await registry.close();
  }
});

test('sha256File hashes files like the exporter records them', () => {
  const file = path.join(tempDir(), 'blob.bin');
  fs.writeFileSync(file, 'hello');
  assert.equal(sha256File(file), sha256(Buffer.from('hello')));
});
