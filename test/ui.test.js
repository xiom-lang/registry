// XIOM Package Registry -- web UI tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { wantsHtml } = require('../src/ui/negotiate');

const OPEN_TOKEN = 'ui-token-open';

let app;
let server;
let baseUrl;
let sandbox;

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const API = { Accept: '*/*' };

function keypair() {
  const seed = crypto.randomBytes(32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { publicKeyHex: publicKeyDer.subarray(publicKeyDer.length - 32).toString('hex'), privateKey };
}

function tarballBytes(label) {
  return require('zlib').gzipSync(Buffer.from(`ui-fixture-${label}-${crypto.randomBytes(4).toString('hex')}`));
}

async function publish({ name, version, bytes, signature = '', publicKey = '' }) {
  const form = new FormData();
  form.set('name', name);
  form.set('version', version);
  if (signature) form.set('signature', signature);
  if (publicKey) form.set('publicKey', publicKey);
  form.set('package', new Blob([bytes], { type: 'application/gzip' }), 'package.tar.gz');
  return fetch(`${baseUrl}/publish`, {
    method: 'POST',
    body: form,
    headers: { Authorization: `Bearer ${OPEN_TOKEN}` },
  });
}

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-ui-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'https://registry.ui.test';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: OPEN_TOKEN, label: 'open', scopes: ['*'], trusted: false, firstParty: true },
  ]));

  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  app = createApp(loadConfig());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Fixtures: one signed (then yanked) version, one current unsigned version,
  // and a hostile description to prove escaping.
  const { publicKeyHex, privateKey } = keypair();
  const oldBytes = tarballBytes('old');
  const oldSignature = crypto.sign(null, oldBytes, privateKey).toString('hex');
  assert.equal((await publish({
    name: 'demo-pkg', version: '0.9.0', bytes: oldBytes,
    signature: oldSignature, publicKey: publicKeyHex,
  })).status, 201);

  assert.equal((await publish({
    name: 'demo-pkg', version: '1.0.0', bytes: tarballBytes('current'),
  })).status, 201);

  assert.equal((await publish({
    name: 'hostile-pkg', version: '0.1.0', bytes: tarballBytes('hostile'),
  })).status, 201);

  // First-party namespace fixture: the token is firstParty, so xiom.* is allowed.
  assert.equal((await publish({
    name: 'xiom.official-fixture', version: '0.1.0', bytes: tarballBytes('official'),
  })).status, 201);

  const yank = await fetch(`${baseUrl}/packages/demo-pkg/0.9.0/yank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPEN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'ui test' }),
  });
  assert.equal(yank.status, 200);
});

test.after(() => {
  if (server) server.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('wantsHtml: only a leading text/html accept disables the API', () => {
  assert.equal(wantsHtml({ headers: { accept: 'text/html,application/xhtml+xml' } }), true);
  assert.equal(wantsHtml({ headers: { accept: 'text/html' } }), true);
  assert.equal(wantsHtml({ headers: { accept: '*/*' } }), false);
  assert.equal(wantsHtml({ headers: {} }), false);
  assert.equal(wantsHtml({ headers: { accept: 'application/json' } }), false);
  // A later text/html entry (browser fallback style) must not flip the API
  // contract; only the first entry decides.
  assert.equal(wantsHtml({ headers: { accept: 'application/json,text/html' } }), false);
});

test('GET / renders HTML for browsers and JSON for the API', async () => {
  const html = await fetch(`${baseUrl}/`, { headers: BROWSER });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const body = await html.text();
  assert.match(body, /<title>XIOM Registry<\/title>/);
  assert.match(body, /demo-pkg/);
  assert.match(body, /href="\/ui\/registry\.css"/);
  assert.match(body, /PUBLISHING\.md/);   // community guides are linked
  assert.match(body, /USING\.md/);
  assert.match(body, /rel="icon"/);       // brand marks
  assert.match(body, /\/ui\/registry\.webp/);
  assert.match(body, /https:\/\/xiom-lang\.org/);
  assert.match(body, /terms\.html/);      // legal links in the footer
  assert.match(body, /privacy\.html/);
  assert.match(body, /support@xiom-lang\.org/);

  const json = await fetch(`${baseUrl}/`, { headers: API });
  assert.match(json.headers.get('content-type'), /application\/json/);
  const data = await json.json();
  assert.equal(data.status, 'operational');
  assert.equal(data.packages, 3);
  assert.equal(data.web, 'https://registry.ui.test', 'raw readers get pointed at the UI');
});

test('footer carries the website social row and the registry contact', async () => {
  const body = await (await fetch(`${baseUrl}/`, { headers: BROWSER })).text();
  assert.match(body, /class="footer-social"/);

  // Same order, labels and rel/target rules as xiom-lang.org. The exact
  // attribute sequence is asserted so a drift in wording or rel is a failure.
  const social = [
    ['https://discord.gg/fsxQfDUg9', 'XIOM community Discord (open invite)', 'Discord', 'noopener'],
    ['https://x.com/XiomLang', 'XIOM on X', 'X', 'noopener'],
    ['https://mastodon.social/@xiom_lang', 'XIOM on Mastodon', 'Mastodon', 'me noopener'],
    ['https://bsky.app/profile/xiom-lang.bsky.social', 'XIOM on Bluesky', 'Bluesky', 'noopener'],
    ['https://www.reddit.com/r/xiom_lang/', 'XIOM on Reddit', 'Reddit', 'noopener'],
    ['https://news.ycombinator.com/user?id=xiom-lang', 'XIOM on Hacker News', 'Hacker News', 'noopener'],
    ['https://www.linkedin.com/company/145216062/', 'XIOM on LinkedIn', 'LinkedIn', 'noopener'],
    ['https://www.facebook.com/profile.php?id=61594524426045', 'XIOM on Facebook', 'Facebook', 'noopener'],
  ];
  const positions = social.map(([href, label, title, rel]) => {
    const anchor = `<a href="${href}" aria-label="${label}" title="${title}" target="_blank" rel="${rel}"`;
    const at = body.indexOf(anchor);
    assert.notEqual(at, -1, `${title} link keeps the website label and rel`);
    return at;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], 'social links keep the website order');
  }

  // Registry-specific contact sits beside the row, not in the generic legal line.
  assert.match(body, /footer-social-row[\s\S]*mailto:registry@xiom-lang\.org/);
});

test('GET /packages lists packages in both formats', async () => {
  const html = await fetch(`${baseUrl}/packages`, { headers: BROWSER });
  assert.match(await html.text(), /demo-pkg/);

  const json = await fetch(`${baseUrl}/packages`, { headers: API });
  const data = await json.json();
  assert.equal(data.packages.length, 3);
  const demo = data.packages.find((p) => p.name === 'demo-pkg');
  assert.equal(demo.latest, '1.0.0');
  assert.equal(demo.versions, 2);
});

test('first-party packages carry the official badge', async () => {
  const official = await fetch(`${baseUrl}/packages/xiom.official-fixture`, { headers: BROWSER });
  assert.match(await official.text(), /class="badge official"/);

  const community = await fetch(`${baseUrl}/packages/demo-pkg`, { headers: BROWSER });
  assert.doesNotMatch(await community.text(), /badge official/);

  const home = await fetch(`${baseUrl}/`, { headers: BROWSER });
  assert.match(await home.text(), /class="badge official"/);
});

test('community tokens cannot publish the reserved xiom-* hyphen namespace', async () => {
  const communityToken = 'ui-token-community';
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: OPEN_TOKEN, label: 'open', scopes: ['*'], trusted: false, firstParty: true },
    { token: communityToken, label: 'community', scopes: ['*'], trusted: false, firstParty: false },
  ]));
  // A fresh app instance loads the updated token file.
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const fresh = createApp(loadConfig());
  const freshServer = await new Promise((resolve) => {
    const s = fresh.listen(0, '127.0.0.1', () => resolve(s));
  });
  const freshUrl = `http://127.0.0.1:${freshServer.address().port}`;
  try {
    const form = new FormData();
    form.set('name', 'xiom-lookalike');
    form.set('version', '0.1.0');
    form.set('package', new Blob([tarballBytes('lookalike')]), 'package.tar.gz');
    const response = await fetch(`${freshUrl}/publish`, {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${communityToken}` },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'reserved_namespace');
  } finally {
    freshServer.close();
    // Restore the original single-token file for the remaining tests.
    fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
      { token: OPEN_TOKEN, label: 'open', scopes: ['*'], trusted: false, firstParty: true },
    ]));
  }
});

test('package page shows install command, versions, digest, and signature', async () => {
  const response = await fetch(`${baseUrl}/packages/demo-pkg`, { headers: BROWSER });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /xiom pkg install demo-pkg/);
  assert.match(body, /1\.0\.0/);
  assert.match(body, /0\.9\.0/);
  assert.match(body, /yanked/);
  assert.match(body, /badge signed/);            // 0.9.0 carries a signature
  assert.match(body, /[0-9a-f]{16}\.\.\./);      // truncated digest in the table
  // JSON stays the protocol contract.
  const json = await fetch(`${baseUrl}/packages/demo-pkg`, { headers: API });
  assert.match(json.headers.get('content-type'), /application\/json/);
  assert.equal((await json.json()).latest, '1.0.0');
});

test('signed version page offers the trust pin command', async () => {
  // The hint appears only for a signed version: pinning a key while the
  // latest install targets an unsigned artifact would make the client refuse
  // that install, so the UI must not suggest it in that case.
  const signed = await fetch(`${baseUrl}/packages/demo-pkg/0.9.0`, { headers: BROWSER });
  assert.match(await signed.text(), /xiom pkg trust --registry https:\/\/registry\.ui\.test --key/);

  const unsigned = await fetch(`${baseUrl}/packages/demo-pkg/1.0.0`, { headers: BROWSER });
  assert.doesNotMatch(await unsigned.text(), /xiom pkg trust/);
});

test('version page renders and unknown versions 404 in both formats', async () => {
  const html = await fetch(`${baseUrl}/packages/demo-pkg/0.9.0`, { headers: BROWSER });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /0\.9\.0/);

  const htmlMissing = await fetch(`${baseUrl}/packages/demo-pkg/9.9.9`, { headers: BROWSER });
  assert.equal(htmlMissing.status, 404);
  assert.match(await htmlMissing.text(), /Not found/);

  const jsonMissing = await fetch(`${baseUrl}/packages/demo-pkg/9.9.9`, { headers: API });
  assert.equal(jsonMissing.status, 404);
  assert.equal((await jsonMissing.json()).code, 'version_not_found');
});

test('search page filters and escapes the query', async () => {
  const html = await fetch(`${baseUrl}/search?q=demo`, { headers: BROWSER });
  const body = await html.text();
  assert.match(body, /1 package matching &quot;demo&quot;|1 package matching "demo"/);
  assert.match(body, /demo-pkg/);
  assert.doesNotMatch(body, /hostile-pkg/);

  const json = await fetch(`${baseUrl}/search?q=demo`, { headers: API });
  const data = await json.json();
  assert.equal(data.results.length, 1);

  const xss = await fetch(`${baseUrl}/search?q=${encodeURIComponent('<script>alert(1)</script>')}`, { headers: BROWSER });
  assert.doesNotMatch(await xss.text(), /<script>alert\(1\)<\/script>/);
});

test('hostile package descriptions are escaped in HTML', async () => {
  // Rewrite the index description directly (publish does not accept one from
  // the client; this simulates a hostile package.xi that the server parsed).
  const indexPath = path.join(process.env.DATA_DIR, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  index.packages['hostile-pkg'].description = '<script>alert("pwned")</script>';
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  // The running server holds the index in memory; publish a marker version to
  // force a re-read through the store (the publish path re-serializes it).
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const fresh = createApp(loadConfig());
  const freshServer = await new Promise((resolve) => {
    const s = fresh.listen(0, '127.0.0.1', () => resolve(s));
  });
  const freshUrl = `http://127.0.0.1:${freshServer.address().port}`;
  try {
    const response = await fetch(`${freshUrl}/packages`, { headers: BROWSER });
    const body = await response.text();
    assert.match(body, /hostile-pkg/);
    assert.doesNotMatch(body, /<script>alert\("pwned"\)<\/script>/);
    assert.match(body, /&lt;script&gt;/);
  } finally {
    freshServer.close();
  }
});

test('stylesheet is served as CSS', async () => {
  const response = await fetch(`${baseUrl}/ui/registry.css`, { headers: BROWSER });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
  assert.match(await response.text(), /:root/);
});

test('brand assets are served for the UI', async () => {
  const ico = await fetch(`${baseUrl}/favicon.ico`, { headers: BROWSER });
  assert.equal(ico.status, 200);
  assert.match(ico.headers.get('content-type'), /image\/x-icon/);
  assert.ok((await ico.arrayBuffer()).byteLength > 0);

  for (const path of ['/ui/favicon.png', '/ui/icon.png']) {
    const asset = await fetch(`${baseUrl}${path}`, { headers: BROWSER });
    assert.equal(asset.status, 200, path);
    assert.match(asset.headers.get('content-type'), /image\/png/, path);
    assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
  }
});

test('page banner is the masthead: wordmark link, global search, once per page', async () => {
  const banner = await fetch(`${baseUrl}/ui/registry.webp`, { headers: BROWSER });
  assert.equal(banner.status, 200);
  assert.match(banner.headers.get('content-type'), /image\/webp/);
  assert.ok((await banner.arrayBuffer()).byteLength > 100_000, 'ships the full-resolution artwork');

  for (const path of ['/', '/packages', '/search?q=demo']) {
    const html = await (await fetch(`${baseUrl}${path}`, { headers: BROWSER })).text();
    assert.equal((html.match(/class="page-banner"/g) || []).length, 1, path);
    assert.match(html, /src="\/ui\/registry\.webp"/, path);
    assert.match(html, /width="1539" height="510"/, path);
    assert.match(html, /class="xiom-brand" aria-hidden="true">XIOM</, path);
    assert.match(html, /class="xiom-section" aria-hidden="true">REGISTRY</, path);
    assert.match(html, /<a class="xiom-heading" href="\/" aria-label="XIOM Registry home">/, path);
    assert.equal((html.match(/role="search"/g) || []).length, 1, `exactly one search form on ${path}`);
    assert.doesNotMatch(html, /class="brand"/, `no duplicate header brand on ${path}`);
  }

  const home = await (await fetch(`${baseUrl}/`, { headers: BROWSER })).text();
  assert.match(home, /<h1>Packages<\/h1>/, 'home keeps exactly one visible page heading');

  const search = await (await fetch(`${baseUrl}/search?q=demo`, { headers: BROWSER })).text();
  assert.match(search, /name="q" type="search" value="demo"/, 'the banner keeps the query on the search page');
});

test('unknown routes render the HTML 404 for browsers only', async () => {
  const html = await fetch(`${baseUrl}/no/such/page`, { headers: BROWSER });
  assert.equal(html.status, 404);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /Not found/);

  const json = await fetch(`${baseUrl}/no/such/page`, { headers: API });
  assert.equal(json.status, 404);
  assert.equal((await json.json()).code, 'no_route');
});

test('download route ignores negotiation and always serves bytes', async () => {
  const response = await fetch(`${baseUrl}/packages/demo-pkg/1.0.0/package.tar.gz`, { headers: BROWSER });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
});
