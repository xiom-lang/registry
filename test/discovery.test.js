// XIOM Package Registry -- A10 discovery facet tests (stage + pre-release).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A10: /packages and /search filter on the manifest stage
// (stable / incubating / deprecated, resolved exactly like the badges) and on
// whether the latest installable version is a semver pre-release. Counts on
// the chips honor the other active filters. /index.json is untouched.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const TOKEN = 'discovery-token';
const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const API = { Accept: '*/*' };

let server;
let baseUrl;
let sandbox;

async function makeTarball(dir, manifestText) {
  const pkgDir = path.join(dir, 'fixture');
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.xi'), manifestText);
  fs.writeFileSync(path.join(pkgDir, 'src', 'lib.xi'), 'pub fn x() {}');
  const tarball = path.join(dir, 'package.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: dir }, ['fixture']);
  return tarball;
}

async function publish({ name, version, manifestText }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-discovery-'));
  const tarball = await makeTarball(dir, manifestText);
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
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-discovery-sandbox-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'https://registry.discovery.test';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: TOKEN, label: 'discovery', scopes: ['*'], trusted: false, firstParty: true },
  ]));

  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const app = createApp(loadConfig());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Controlled fixture set, all category "tooling":
  //   stable / incubating / deprecated latest versions,
  //   a pre-release-only package (its latest IS the beta),
  //   and one with no declared stage (visible only under stage=all).
  const manifest = (name, version, stage = '') => [
    `name: "${name}";`,
    `version: "${version}";`,
    'categories: ["tooling"];',
    stage ? `stage: "${stage}";` : '',
    '',
  ].filter(Boolean).join('\n');

  for (const [name, version, stage] of [
    ['facet-stable', '1.0.0', 'stable'],
    ['facet-inc', '1.0.0', 'incubating'],
    ['facet-dep', '1.0.0', 'deprecated'],
    ['facet-beta', '1.1.0-beta.1', 'stable'],
    ['facet-plain', '1.0.0', ''],
  ]) {
    const result = await publish({ name, version, manifestText: manifest(name, version, stage) });
    assert.equal(result.status, 201, `${name}: ${JSON.stringify(result.body)}`);
  }
});

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('listing JSON exposes stage and prerelease and filters by them', async () => {
  const all = await (await fetch(`${baseUrl}/packages?sort=name`, { headers: API })).json();
  assert.equal(all.stage, 'all');
  assert.equal(all.prerelease, 'hide');
  assert.deepEqual(
    all.packages.map((entry) => entry.name),
    ['facet-dep', 'facet-inc', 'facet-plain', 'facet-stable'],
    'the pre-release-only package is hidden by default',
  );
  const stable = all.packages.find((entry) => entry.name === 'facet-stable');
  assert.equal(stable.stage, 'stable');
  assert.equal(stable.prerelease, false);

  const stableOnly = await (await fetch(`${baseUrl}/packages?stage=stable`, { headers: API })).json();
  assert.equal(stableOnly.stage, 'stable');
  assert.deepEqual(stableOnly.packages.map((entry) => entry.name), ['facet-stable']);

  const stableWithPre = await (
    await fetch(`${baseUrl}/packages?stage=stable&prerelease=include`, { headers: API })
  ).json();
  assert.deepEqual(
    stableWithPre.packages.map((entry) => entry.name).sort(),
    ['facet-beta', 'facet-stable'],
  );
  assert.equal(
    stableWithPre.packages.find((entry) => entry.name === 'facet-beta').prerelease,
    true,
  );

  const incubating = await (await fetch(`${baseUrl}/packages?stage=incubating`, { headers: API })).json();
  assert.deepEqual(incubating.packages.map((entry) => entry.name), ['facet-inc']);

  const deprecated = await (await fetch(`${baseUrl}/packages?stage=deprecated`, { headers: API })).json();
  assert.deepEqual(deprecated.packages.map((entry) => entry.name), ['facet-dep']);

  const only = await (await fetch(`${baseUrl}/packages?prerelease=only`, { headers: API })).json();
  assert.equal(only.prerelease, 'only');
  assert.deepEqual(only.packages.map((entry) => entry.name), ['facet-beta']);

  // A package with no declared stage appears under `all` only.
  assert.ok(all.packages.some((entry) => entry.name === 'facet-plain' && entry.stage === ''));
  for (const stage of ['stable', 'incubating', 'deprecated']) {
    const body = await (await fetch(`${baseUrl}/packages?stage=${stage}`, { headers: API })).json();
    assert.ok(!body.packages.some((entry) => entry.name === 'facet-plain'));
  }

  // Garbage falls back to the defaults instead of erroring.
  const garbage = await (
    await fetch(`${baseUrl}/packages?stage=nonsense&prerelease=maybe`, { headers: API })
  ).json();
  assert.equal(garbage.stage, 'all');
  assert.equal(garbage.prerelease, 'hide');
  assert.equal(garbage.total, 4);
});

test('listing chips carry facet counts and combine with category', async () => {
  const html = await (await fetch(`${baseUrl}/packages`, { headers: BROWSER })).text();
  const stageGroup = html.split('aria-label="Stage"')[1].split('</div>')[0];
  assert.match(stageGroup, /All stages <span class="chip-count">4<\/span>/);
  assert.match(stageGroup, /Stable <span class="chip-count">1<\/span>/);
  assert.match(stageGroup, /Incubating <span class="chip-count">1<\/span>/);
  assert.match(stageGroup, /Deprecated <span class="chip-count">1<\/span>/);
  const releaseGroup = html.split('aria-label="Pre-releases"')[1].split('</div>')[0];
  assert.match(releaseGroup, /Hide pre-releases <span class="chip-count">4<\/span>/);
  assert.match(releaseGroup, /Only pre-releases <span class="chip-count">1<\/span>/);
  assert.match(releaseGroup, /Include pre-releases <span class="chip-count">5<\/span>/);
  assert.match(
    html,
    /class="chip chip-active" href="[^"]*">All stages <span class="chip-count">4<\/span><\/a>/,
  );
  assert.match(html, /href="\/packages\?page=1&amp;per_page=50&amp;stage=deprecated"/);
  assert.equal((html.match(/<li class="pkg-row">/g) || []).length, 4, 'one row per visible package');
  assert.doesNotMatch(html, /facet-beta/);

  // Deprecated stays visible but marked, and the summary names the facet.
  const deprecatedHtml = await (
    await fetch(`${baseUrl}/packages?stage=deprecated`, { headers: BROWSER })
  ).text();
  assert.match(deprecatedHtml, /1 package \u00b7 stage &quot;deprecated&quot;/);
  assert.match(deprecatedHtml, /alt="Deprecated package"/);
  assert.match(deprecatedHtml, /facet-dep/);
  // Counts cross-honor the other facet: the release counts describe the
  // deprecated pool (1 package), not the whole registry.
  const depReleases = deprecatedHtml.split('aria-label="Pre-releases"')[1].split('</div>')[0];
  assert.match(depReleases, /Hide pre-releases <span class="chip-count">1<\/span>/);
  assert.match(depReleases, /Only pre-releases <span class="chip-count">0<\/span>/);
  assert.match(depReleases, /Include pre-releases <span class="chip-count">1<\/span>/);

  // Category narrows the pool the facet counts describe.
  const categoryHtml = await (
    await fetch(`${baseUrl}/packages?category=data`, { headers: BROWSER })
  ).text();
  const catStage = categoryHtml.split('aria-label="Stage"')[1].split('</div>')[0];
  assert.match(catStage, /All stages <span class="chip-count">0<\/span>/);

  // Category + stage + prerelease combine.
  const combined = await (
    await fetch(`${baseUrl}/packages?category=tooling&stage=stable&prerelease=include`, { headers: API })
  ).json();
  assert.deepEqual(combined.packages.map((entry) => entry.name).sort(), ['facet-beta', 'facet-stable']);
});

test('search supports the same lifecycle facets and counts', async () => {
  const base = await (await fetch(`${baseUrl}/search?q=facet`, { headers: API })).json();
  assert.equal(base.stage, 'all');
  assert.equal(base.prerelease, 'hide');
  assert.deepEqual(
    base.results.map((entry) => entry.name).sort(),
    ['facet-dep', 'facet-inc', 'facet-plain', 'facet-stable'],
  );

  const only = await (await fetch(`${baseUrl}/search?q=facet&prerelease=only`, { headers: API })).json();
  assert.deepEqual(only.results.map((entry) => entry.name), ['facet-beta']);
  assert.equal(only.prerelease, 'only');

  const deprecated = await (await fetch(`${baseUrl}/search?q=facet&stage=deprecated`, { headers: API })).json();
  assert.deepEqual(deprecated.results.map((entry) => entry.name), ['facet-dep']);

  const stableHtml = await (
    await fetch(`${baseUrl}/search?q=facet&stage=stable&prerelease=include`, { headers: BROWSER })
  ).text();
  assert.match(
    stableHtml,
    /2 packages matching &quot;facet&quot; stage &quot;stable&quot; including pre-releases/,
  );
  // The banner search form keeps the facets for the next query.
  assert.match(stableHtml, /<input type="hidden" name="stage" value="stable">/);
  assert.match(stableHtml, /<input type="hidden" name="prerelease" value="include">/);
  // Counts describe the text-match pool with the other filter applied.
  const releaseGroup = stableHtml.split('aria-label="Pre-releases"')[1].split('</div>')[0];
  assert.match(releaseGroup, /Include pre-releases <span class="chip-count">2<\/span>/);
  assert.match(releaseGroup, /Only pre-releases <span class="chip-count">1<\/span>/);
  // Category chips keep the query and the lifecycle facets.
  assert.match(
    stableHtml,
    /href="\/search\?q=facet&amp;category=tooling&amp;stage=stable&amp;prerelease=include"/,
  );
});

test('the protocol index keeps every package and gains no listing fields', async () => {
  const index = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
  assert.deepEqual(Object.keys(index.packages).sort(), [
    'facet-beta', 'facet-dep', 'facet-inc', 'facet-plain', 'facet-stable',
  ]);
  assert.equal(index.packages['facet-beta'].latest, '1.1.0-beta.1');
  assert.ok(!('prerelease' in index.packages['facet-beta']), 'listing facets stay out of /index.json');
});
