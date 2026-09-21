// XIOM Package Registry -- category vocabulary and metadata extraction tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const {
  CATEGORIES,
  normalizeCategories,
  normalizeKeywords,
  normalizePackageMetadata,
  categoryCounts,
} = require('../src/categories');

const TOKEN = 'categories-token';

let server;
let baseUrl;
let sandbox;

test('normalizeCategories maps aliases, dedupes, caps, and reports unknown', () => {
  assert.deepEqual(normalizeCategories(['graphics']).categories, ['graphics']);
  assert.deepEqual(normalizeCategories(['GPU']).categories, ['graphics'], 'alias + case');
  assert.deepEqual(normalizeCategories(['graphics', 'gpu']).categories, ['graphics'], 'dedupe');
  assert.deepEqual(
    normalizeCategories(['web', 'graphics', 'data', 'media']).categories,
    ['web', 'graphics', 'data'],
    'capped at three',
  );
  const { categories, unknown } = normalizeCategories(['graphics', 'nonsense']);
  assert.deepEqual(categories, ['graphics']);
  assert.deepEqual(unknown, ['nonsense']);
  assert.deepEqual(normalizeCategories('graphics').categories, ['graphics'], 'bare string tolerated');
  assert.deepEqual(normalizeCategories(undefined).categories, []);
});

test('normalizeKeywords lowercases, filters invalid shapes, caps', () => {
  assert.deepEqual(
    normalizeKeywords(['Vulkan', ' gpu ', 'c++', 'spir-v']),
    ['vulkan', 'gpu', 'c++', 'spir-v'],
  );
  assert.deepEqual(normalizeKeywords(['x'.repeat(40)]), [], 'over the length cap');
  assert.deepEqual(normalizeKeywords(['---']), [], 'must start alphanumeric');
  assert.equal(normalizeKeywords(Array.from({ length: 20 }, (_, i) => `k${i}`)).length, 10);
});

test('normalizePackageMetadata trims license and repository', () => {
  const meta = normalizePackageMetadata({
    categories: ['database'],
    keywords: ['redis', 'cache'],
    license: ' MIT OR Apache-2.0 ',
    repository: ' https://github.com/xiom-packages/packages ',
  });
  assert.deepEqual(meta.categories, ['database']);
  assert.deepEqual(meta.keywords, ['redis', 'cache']);
  assert.equal(meta.license, 'MIT OR Apache-2.0');
  assert.equal(meta.repository, 'https://github.com/xiom-packages/packages');
});

test('categoryCounts lists the whole vocabulary, highest count first', () => {
  const counts = categoryCounts({
    packages: {
      a: { categories: ['graphics'] },
      b: { categories: ['graphics', 'web'] },
    },
  });
  assert.equal(counts.length, CATEGORIES.length);
  assert.deepEqual(counts[0], { name: 'graphics', count: 2 });
  const web = counts.find((entry) => entry.name === 'web');
  assert.equal(web.count, 1);
});

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-cat-'));
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
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-cat-sandbox-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'https://registry.categories.test';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: TOKEN, label: 'categories', scopes: ['*'], trusted: false, firstParty: true },
  ]));

  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const app = createApp(loadConfig());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('publish extracts and normalizes package metadata from the manifest', async () => {
  const result = await publish({
    name: 'graphics-demo',
    version: '0.1.0',
    manifestText: [
      'package graphics_demo {',
      '  name: "graphics-demo";',
      '  version: "0.1.0";',
      '  description: "Sample renderer helpers";',
      '  categories: ["graphics", "GPU"];',
      '  keywords: ["Vulkan", "swapchain", "spir-v"];',
      '  license: "MIT OR Apache-2.0";',
      '  repository: "https://example.test/graphics-demo";',
      '}',
      '',
    ].join('\n'),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));

  const pkg = await (await fetch(`${baseUrl}/packages/graphics-demo`)).json();
  assert.deepEqual(pkg.categories, ['graphics'], 'alias mapped, duplicates collapsed');
  assert.deepEqual(pkg.keywords, ['vulkan', 'swapchain', 'spir-v']);
  assert.equal(pkg.license, 'MIT OR Apache-2.0');
  assert.equal(pkg.repository, 'https://example.test/graphics-demo');
  assert.equal(pkg.description, 'Sample renderer helpers');
});

test('unknown categories are dropped and reported as publish warnings', async () => {
  const result = await publish({
    name: 'warn-demo',
    version: '0.1.0',
    manifestText: 'name: "warn-demo";\nversion: "0.1.0";\ncategories: ["graphics", "nonsense"];\n',
  });
  assert.equal(result.status, 201);
  assert.ok(Array.isArray(result.body.warnings), 'warnings present');
  assert.match(result.body.warnings[0], /unknown category "nonsense" ignored/);
  assert.match(result.body.warnings[0], /valid categories:/);

  const pkg = await (await fetch(`${baseUrl}/packages/warn-demo`)).json();
  assert.deepEqual(pkg.categories, ['graphics']);
});

test('metadata refreshes on later versions but is not wiped when omitted', async () => {
  const base = (version, extra = '') => [
    'name: "refresh-demo";',
    `version: "${version}";`,
    'description: "Refresh demo";',
    extra,
  ].join('\n');

  await publish({
    name: 'refresh-demo', version: '0.1.0',
    manifestText: base('0.1.0', 'categories: ["data"];\nkeywords: ["json"];'),
  });
  await publish({ name: 'refresh-demo', version: '0.2.0', manifestText: base('0.2.0') });

  let pkg = await (await fetch(`${baseUrl}/packages/refresh-demo`)).json();
  assert.deepEqual(pkg.categories, ['data'], 'omitted metadata is preserved');
  assert.deepEqual(pkg.keywords, ['json']);

  await publish({
    name: 'refresh-demo', version: '0.3.0',
    manifestText: base('0.3.0', 'categories: ["web"];'),
  });
  pkg = await (await fetch(`${baseUrl}/packages/refresh-demo`)).json();
  assert.deepEqual(pkg.categories, ['web'], 'new metadata replaces the old');
});

test('GET /categories returns the full vocabulary with counts', async () => {
  const body = await (await fetch(`${baseUrl}/categories`)).json();
  assert.equal(body.categories.length, CATEGORIES.length);
  const graphics = body.categories.find((entry) => entry.name === 'graphics');
  assert.ok(graphics.count >= 2, 'graphics-demo + warn-demo');
});

test('search filters by category and matches keywords', async () => {
  const byCategory = await (await fetch(`${baseUrl}/search?category=graphics`)).json();
  assert.deepEqual(byCategory.category, 'graphics');
  assert.ok(byCategory.results.some((entry) => entry.name === 'graphics-demo'));
  assert.ok(!byCategory.results.some((entry) => entry.name === 'refresh-demo'));

  const byKeyword = await (await fetch(`${baseUrl}/search?q=swapchain`)).json();
  assert.equal(byKeyword.results.length, 1);
  assert.equal(byKeyword.results[0].name, 'graphics-demo');

  const combined = await (await fetch(`${baseUrl}/search?q=renderer&category=graphics`)).json();
  assert.equal(combined.results.length, 1);
});

test('category pages render chips, keywords, and the vocabulary', async () => {
  const browser = { Accept: 'text/html,application/xhtml+xml' };

  const pkgPage = await fetch(`${baseUrl}/packages/graphics-demo`, { headers: browser });
  const pkgHtml = await pkgPage.text();
  assert.match(pkgHtml, /href="\/search\?category=graphics"/);
  assert.match(pkgHtml, /vulkan, swapchain, spir-v/);
  assert.match(pkgHtml, /MIT OR Apache-2\.0/);

  const searchHtml = await (await fetch(`${baseUrl}/search?category=graphics`, { headers: browser })).text();
  assert.match(searchHtml, /Category: graphics/);
  assert.match(searchHtml, /graphics-demo/);

  const categoriesHtml = await (await fetch(`${baseUrl}/categories`, { headers: browser })).text();
  assert.match(categoriesHtml, /Categories/);
  assert.match(categoriesHtml, /chip-active|<a class="chip"/);
});
