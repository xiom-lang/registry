#!/usr/bin/env node
// XIOM Package Registry -- offline export bundle (SESSION.md 21 C3).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Produces a vendored, mountable mirror of a registry for no-egress
// consumers (the playground container first):
//
//   <out>/index.json                                  exact bytes of GET /index.json
//   <out>/artifacts/<name>/<version>/package.tar.gz   verified artifact per version
//   <out>/bundle.json                                 sha256/signature/publicKey/source/generatedAt
//
// Every artifact is hashed while downloading and must match the index
// entry's sha256 (and size, when present); a mismatch fails the export and
// leaves no bundle.json behind. Export from production: it is the source of
// truth. Pin consumers by sha256, never by version string alone.
//
// Usage:
//   node scripts/export-bundle.js --registry https://registry.xiom-lang.org \
//                                --out ./registry-bundle [--latest-only] [--force]
//                                [--concurrency 4] [--quiet]
//   node scripts/export-bundle.js --verify ./registry-bundle
//
// The layout is documented in OFFLINE.md; the client lane owns the offline
// resolution semantics that consume it.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVICE = require('../package.json');
const { validatePackageName } = require('../src/names');

const BUNDLE_VERSION = 1;
const DEFAULT_CONCURRENCY = 4;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const USER_AGENT = `xiom-registry-export/${SERVICE.version}`;

/** A failed integrity check; the export stops and writes no bundle.json. */
class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

function parseArgs(argv) {
  const args = {
    registry: '',
    out: '',
    verify: '',
    latestOnly: false,
    force: false,
    concurrency: DEFAULT_CONCURRENCY,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--registry') args.registry = argv[++i] || '';
    else if (arg === '--out') args.out = argv[++i] || '';
    else if (arg === '--verify') args.verify = argv[++i] || '';
    else if (arg === '--latest-only') args.latestOnly = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--concurrency') {
      const parsed = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 16) {
        throw new ExportError('--concurrency must be between 1 and 16');
      }
      args.concurrency = parsed;
    } else {
      throw new ExportError(`unknown argument: ${arg}`);
    }
  }
  if (!args.verify && (!args.registry || !args.out)) {
    throw new ExportError(
      'usage: node scripts/export-bundle.js --registry <url> --out <dir> '
      + '[--latest-only] [--force] [--concurrency 1-16]\n'
      + '       node scripts/export-bundle.js --verify <dir>',
    );
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let read = fs.readSync(fd, chunk, 0, chunk.length, null);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      read = fs.readSync(fd, chunk, 0, chunk.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * One artifact record per exportable version, stable-sorted by name then
 * version. Legacy entries without a digest are reported, never downloaded:
 * an offline mirror that cannot prove integrity is worse than a gap.
 *
 * @returns {{ artifacts: object[], skipped: object[] }}
 */
function selectArtifacts(index, { latestOnly = false } = {}) {
  const artifacts = [];
  const skipped = [];
  const packages = (index && index.packages) || {};
  for (const name of Object.keys(packages).sort()) {
    const pkg = packages[name] || {};
    const versions = Object.keys(pkg.versions || {}).sort();
    const wanted = latestOnly
      ? (pkg.latest && pkg.versions && pkg.versions[pkg.latest] ? [pkg.latest] : [])
      : versions;
    for (const version of wanted) {
      const entry = (pkg.versions || {})[version] || {};
      const record = {
        name,
        version,
        sha256: String(entry.sha256 || '').toLowerCase(),
        size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null,
        signature: String(entry.signature || ''),
        publicKey: String(entry.publicKey || ''),
        published: String(entry.published || ''),
        yanked: entry.yanked === true,
      };
      if (!record.sha256) {
        skipped.push({ name, version, reason: 'no digest in the index (legacy entry)' });
      } else {
        artifacts.push(record);
      }
    }
  }
  return { artifacts, skipped };
}

async function fetchIndex(registry, fetchImpl) {
  const url = `${stripTrailingSlash(registry)}/index.json`;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new ExportError(`GET ${url} -> ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf-8'));
  } catch (err) {
    throw new ExportError(`${url} is not JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.packages !== 'object') {
    throw new ExportError(`${url} does not look like a registry index`);
  }
  return { bytes, index: parsed, sha256: sha256(bytes), url };
}

function artifactUrl(registry, name, version) {
  return `${stripTrailingSlash(registry)}/packages/${encodeURIComponent(name)}`
    + `/${encodeURIComponent(version)}/package.tar.gz`;
}

function artifactPath(outDir, name, version) {
  return path.join(outDir, 'artifacts', name, version, 'package.tar.gz');
}

/**
 * Download one artifact to `<path>.part`, hashing while writing, then rename
 * only when the digest (and size) match the index. An existing file whose
 * digest matches is reused, so a re-run is cheap and a `--force` run is the
 * only way to re-fetch bytes.
 *
 * @returns {{ reused: boolean, bytes: number }}
 */
async function fetchArtifact(record, { registry, outDir, force, fetchImpl, log }) {
  let validName = false;
  try {
    validName = validatePackageName(record.name);
  } catch {
    validName = false;
  }
  if (!validName || !SAFE_VERSION.test(record.version)) {
    throw new ExportError(`refusing unsafe path for ${record.name}@${record.version}`);
  }
  const target = artifactPath(outDir, record.name, record.version);
  const label = `${record.name}@${record.version}`;

  if (!force && fs.existsSync(target)) {
    const existing = sha256File(target);
    if (existing === record.sha256) {
      log(`  reuse ${label} (${record.sha256.slice(0, 12)}\u2026)`);
      return { reused: true, bytes: fs.statSync(target).size };
    }
    log(`  re-download ${label} (local copy does not match the index)`);
  }

  const url = artifactUrl(registry, record.name, record.version);
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new ExportError(`GET ${url} -> ${response.status}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const handle = fs.openSync(part, 'w');
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      bytes += chunk.length;
      fs.writeSync(handle, chunk);
    }
  } catch (err) {
    fs.closeSync(handle);
    fs.rmSync(part, { force: true });
    throw new ExportError(`downloading ${label} failed: ${err.message}`);
  }
  fs.closeSync(handle);

  const digest = hash.digest('hex');
  if (digest !== record.sha256) {
    fs.rmSync(part, { force: true });
    throw new ExportError(
      `integrity failure for ${label}: index says ${record.sha256}, served bytes hash to ${digest}`,
    );
  }
  if (record.size !== null && bytes !== record.size) {
    fs.rmSync(part, { force: true });
    throw new ExportError(
      `integrity failure for ${label}: index says ${record.size} bytes, served ${bytes}`,
    );
  }
  fs.renameSync(part, target);
  log(`  fetched ${label} (${bytes} bytes)`);
  return { reused: false, bytes };
}

/** Run `worker` over `items` with a bounded pool; the first failure wins. */
async function pooled(items, concurrency, worker) {
  let next = 0;
  let failure = null;
  const run = async () => {
    for (;;) {
      if (failure) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (err) {
        failure = failure || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  if (failure) throw failure;
}

/**
 * Export one registry into `outDir`. Returns the bundle manifest.
 *
 * @param {{ registry: string, outDir: string, latestOnly?: boolean,
 *           force?: boolean, concurrency?: number, fetchImpl?: Function,
 *           log?: Function, now?: Function }} options
 */
async function exportBundle({
  registry,
  outDir,
  latestOnly = false,
  force = false,
  concurrency = DEFAULT_CONCURRENCY,
  fetchImpl = fetch,
  log = () => {},
  now = () => new Date(),
}) {
  const fetched = await fetchIndex(registry, fetchImpl);
  const { artifacts, skipped } = selectArtifacts(fetched.index, { latestOnly });

  fs.mkdirSync(outDir, { recursive: true });
  // index.json is written byte-for-byte: consumers can diff it against the
  // live registry and re-verify `index.sha256` in bundle.json.
  fs.writeFileSync(path.join(outDir, 'index.json'), fetched.bytes);
  log(`index.json: ${fetched.sha256.slice(0, 12)}\u2026 (${fetched.bytes.length} bytes, `
    + `${Object.keys(fetched.index.packages).length} packages)`);

  let downloaded = 0;
  let reused = 0;
  let totalBytes = 0;
  await pooled(artifacts, concurrency, async (record) => {
    const result = await fetchArtifact(record, { registry, outDir, force, fetchImpl, log });
    if (result.reused) reused += 1;
    else downloaded += 1;
    totalBytes += result.bytes;
  });

  const manifest = {
    bundleVersion: BUNDLE_VERSION,
    registry: stripTrailingSlash(registry),
    generatedAt: now().toISOString(),
    generator: `${SERVICE.name}/${SERVICE.version}`,
    index: {
      path: 'index.json',
      sha256: fetched.sha256,
      bytes: fetched.bytes.length,
      registry: fetched.index.registry || '',
      updatedAt: fetched.index.updated_at || '',
      packages: Object.keys(fetched.index.packages).length,
    },
    packages: {},
    skipped,
    totals: {
      artifacts: artifacts.length,
      downloaded,
      reused,
      bytes: totalBytes,
    },
  };
  for (const record of artifacts) {
    const bucket = manifest.packages[record.name]
      || (manifest.packages[record.name] = { latest: '', versions: {} });
    bucket.versions[record.version] = {
      path: path.relative(outDir, artifactPath(outDir, record.name, record.version)).split(path.sep).join('/'),
      sha256: record.sha256,
      size: record.size,
      signature: record.signature,
      publicKey: record.publicKey,
      published: record.published,
      yanked: record.yanked,
      source: artifactUrl(registry, record.name, record.version),
    };
  }
  // `latest` follows the index: the selected versions may be a subset.
  for (const [name, bucket] of Object.entries(manifest.packages)) {
    const pkg = fetched.index.packages[name] || {};
    bucket.latest = bucket.versions[pkg.latest] ? pkg.latest : '';
  }

  fs.writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(manifest, null, 2));
  log(`bundle.json: ${artifacts.length} artifact(s), ${totalBytes} bytes `
    + `(${downloaded} downloaded, ${reused} reused)${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  return manifest;
}

/**
 * Re-verify an exported directory without touching the network: every path
 * in bundle.json must exist and hash to its recorded sha256.
 *
 * @returns {{ artifacts: number, bytes: number }}
 */
function verifyBundle(dir, { log = () => {} } = {}) {
  const manifestPath = path.join(dir, 'bundle.json');
  if (!fs.existsSync(manifestPath)) throw new ExportError(`${manifestPath} not found`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const indexRecord = manifest.index || {};
  if (indexRecord.sha256) {
    const actual = sha256File(path.join(dir, indexRecord.path || 'index.json'));
    if (actual !== indexRecord.sha256) {
      throw new ExportError(`index.json hashes to ${actual}, bundle.json says ${indexRecord.sha256}`);
    }
  }
  let artifacts = 0;
  let bytes = 0;
  for (const [name, bucket] of Object.entries(manifest.packages || {})) {
    for (const [version, record] of Object.entries(bucket.versions || {})) {
      const relative = String(record.path || '');
      const segments = relative.split('/');
      if (!relative || segments.some((segment) => segment === '' || segment === '..' || segment === '.')
        || path.isAbsolute(relative)) {
        throw new ExportError(`unsafe artifact path in bundle.json: "${relative}"`);
      }
      const file = path.join(dir, ...segments);
      if (!fs.existsSync(file)) throw new ExportError(`missing ${record.path}`);
      const actual = sha256File(file);
      if (record.sha256 && actual !== record.sha256) {
        throw new ExportError(
          `integrity failure for ${name}@${version}: bundle.json says ${record.sha256}, file hashes to ${actual}`,
        );
      }
      artifacts += 1;
      bytes += fs.statSync(file).size;
    }
  }
  log(`verified ${artifacts} artifact(s), ${bytes} bytes; index + bundle.json consistent`);
  return { artifacts, bytes };
}

async function main(argv) {
  const args = parseArgs(argv);
  const log = args.quiet ? () => {} : (line) => console.log(line);
  if (args.verify) {
    console.log(`Verifying ${path.resolve(args.verify)}`);
    verifyBundle(args.verify, { log: console.log });
    return 0;
  }
  console.log(`Exporting ${args.registry} -> ${path.resolve(args.out)}`);
  await exportBundle({
    registry: args.registry,
    outDir: args.out,
    latestOnly: args.latestOnly,
    force: args.force,
    concurrency: args.concurrency,
    log,
  });
  console.log('Done. Serve the directory as-is; see OFFLINE.md for the layout.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  exportBundle,
  verifyBundle,
  selectArtifacts,
  parseArgs,
  sha256File,
  ExportError,
  BUNDLE_VERSION,
};
