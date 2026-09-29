// XIOM Package Registry -- C1 download stats and sort tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 C1: artifact requests are counted per package/version/UTC
// day with a day-salted visitor marker (no per-user tracking, no raw logs),
// markers are pruned after a week, the package page shows the total and the
// 30-day window, `?stats=1` returns JSON, and the listing gains the
// most-downloaded and top-rated sorts. /index.json stays untouched.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { dayKey, MARKER_RETENTION_DAYS } = require('../src/stats');

const TOKEN = 'stats-token';
const BROWSER = { Accept: 'text/html,application/xhtml+xml' };
const API = { Accept: '*/*' };

let sandbox;
let app;
let server;
let baseUrl;

function listen(instance) {
  return new Promise((resolve) => {
    const httpServer = instance.listen(0, '127.0.0.1', () => resolve(httpServer));
  });
}

async function makeTarball(dir, manifestText) {
  const pkgDir = path.join(dir, 'fixture');
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.xi'), manifestText);
  fs.writeFileSync(path.join(pkgDir, 'src', 'lib.xi'), 'pub fn x() {}');
  const tarball = path.join(dir, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: dir }, ['fixture']);
  return tarball;
}

async function publish(name, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-stats-'));
  const tarball = await makeTarball(dir, `name: "${name}";\nversion: "${version}";\n`);
  const form = new FormData();
  form.set('name', name);
  form.set('version', version);
  form.set('package', new Blob([fs.readFileSync(tarball)], { type: 'application/gzip' }), 'package.tar.gz');
  const response = await fetch(`${baseUrl}/publish`, {
    method: 'POST',
    body: form,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(response.status, 201, `${name}@${version}: ${await response.text()}`);
}

/** One artifact request, optionally from a distinct proxied address. */
async function download(name, version, ip = '') {
  const headers = { ...API };
  if (ip) headers['X-Forwarded-For'] = ip;
  return fetch(`${baseUrl}/packages/${name}/${version}/package.tar.gz`, { headers, redirect: 'manual' });
}

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-stats-http-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'http://127.0.0.1:3999';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TRUST_PROXY = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: TOKEN, label: 'stats', scopes: ['*'], trusted: false, firstParty: true },
  ]));

  app = createApp(loadConfig());
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await publish('stats-a', '1.0.0');
  await publish('stats-a', '1.1.0');
  await publish('stats-b', '1.0.0');
});

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('downloads count once per visitor-day per version and never count failures', async () => {
  const { stats, db } = app.locals.registry;

  assert.equal((await download('stats-a', '1.0.0', '198.51.100.7')).status, 200);
  assert.equal((await download('stats-a', '1.0.0', '198.51.100.7')).status, 200);
  assert.equal((await download('stats-a', '1.0.0', '198.51.100.7')).status, 200);
  assert.equal(stats.forPackage('stats-a').total, 1, 'a refresh loop counts once');

  assert.equal((await download('stats-a', '1.0.0', '198.51.100.8')).status, 200);
  assert.equal(stats.forPackage('stats-a').total, 2, 'a different visitor counts');

  assert.equal((await download('stats-a', '1.1.0', '198.51.100.7')).status, 200);
  assert.equal(stats.forPackage('stats-a').total, 3, 'versions are counted separately');

  // Failed requests never count.
  assert.equal((await download('stats-a', '9.9.9', '198.51.100.7')).status, 404);
  assert.equal((await download('stats-nope', '1.0.0', '198.51.100.7')).status, 404);
  assert.equal(stats.forPackage('stats-a').total, 3);

  const report = stats.forPackage('stats-a');
  assert.equal(report.last7, 3);
  assert.equal(report.last30, 3);
  assert.deepEqual(report.days, [{ day: dayKey(), count: 3 }]);
  assert.equal(stats.forPackage('stats-b').total, 0);

  // The JSON surface is stable and the protocol index stays clean.
  const json = await (await fetch(`${baseUrl}/packages/stats-a?stats=1`, { headers: API })).json();
  assert.deepEqual(json, {
    package: 'stats-a',
    downloads: { total: 3, last7: 3, last30: 3, days: [{ day: dayKey(), count: 3 }] },
  });
  const index = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
  assert.ok(!('downloads' in index.packages['stats-a']));

  // The package page shows the total.
  const html = await (await fetch(`${baseUrl}/packages/stats-a`, { headers: BROWSER })).text();
  assert.match(html, /Downloads<\/dt><dd>3/);

  // Markers rotate daily and are pruned after the retention window while the
  // durable aggregate keeps the old day.
  const fresh = stats.markerFor('198.51.100.7', '2026-01-01');
  assert.equal(stats.markerFor('198.51.100.7', '2026-01-01'), fresh, 'deterministic within a day');
  assert.notEqual(stats.markerFor('198.51.100.7', '2026-01-02'), fresh, 'not linkable across days');

  const oldDay = dayKey(new Date(Date.now() - (MARKER_RETENTION_DAYS + 3) * 24 * 60 * 60 * 1000));
  stats.record({
    package: 'stats-a', version: '1.1.0', ip: '198.51.100.9',
    at: new Date(Date.parse(`${oldDay}T12:00:00Z`)),
  });
  assert.equal(stats.forPackage('stats-a').total, 4, 'the aggregate keeps the old day');
  assert.equal(
    Number(db.get('SELECT COUNT(*) AS count FROM download_markers WHERE day < ?', dayKey(new Date(Date.now() - MARKER_RETENTION_DAYS * 24 * 60 * 60 * 1000))).count),
    0,
    'stale dedupe markers were pruned',
  );

  // Unknown packages are a 404 JSON, never a fabricated report.
  const missing = await fetch(`${baseUrl}/packages/stats-nope?stats=1`, { headers: API });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'package_not_found');

  // Keep the rest of the suite deterministic: stats-a now has 4 downloads.
});

test('the listing gains most-downloaded and top-rated sorts', async () => {
  const { reviews } = app.locals.registry;
  assert.equal((await download('stats-b', '1.0.0', '198.51.100.20')).status, 200);

  // Downloads: stats-a (4) before stats-b (1).
  let body = await (await fetch(`${baseUrl}/packages?sort=downloads`, { headers: API })).json();
  assert.equal(body.sort, 'downloads');
  assert.deepEqual(body.packages.map((entry) => entry.name), ['stats-a', 'stats-b']);

  let html = await (await fetch(`${baseUrl}/packages?sort=downloads`, { headers: BROWSER })).text();
  assert.match(html, /class="chip chip-active" href="[^"]*sort=downloads"[^>]*>Most downloaded<\/a>/);

  // Ratings: stats-b (5.0 from one) beats stats-a (2.0 from one).
  reviews.rate('stats-a', { user: { githubId: '77', login: 'rater' }, stars: 2, review: 'meh' });
  reviews.rate('stats-b', { user: { githubId: '78', login: 'fan' }, stars: 5, review: 'great' });
  body = await (await fetch(`${baseUrl}/packages?sort=rating`, { headers: API })).json();
  assert.equal(body.sort, 'rating');
  assert.equal(body.packages[0].name, 'stats-b', 'higher average first');
  assert.equal(body.packages[1].name, 'stats-a');

  // Garbage sorts fall back to updated without error.
  body = await (await fetch(`${baseUrl}/packages?sort=wat`, { headers: API })).json();
  assert.equal(body.sort, 'updated');
});
