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
const tar = require('tar');

const { wantsHtml } = require('../src/ui/negotiate');

const OPEN_TOKEN = 'ui-token-open';

let app;
let server;
let baseUrl;
let sandbox;
let noReadmeWarnings = [];

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

  // Community package whose latest version is signed: community-trusted badge.
  const signedBytes = tarballBytes('signed');
  const signedSignature = crypto.sign(null, signedBytes, privateKey).toString('hex');
  assert.equal((await publish({
    name: 'signed-pkg', version: '1.0.0', bytes: signedBytes,
    signature: signedSignature, publicKey: publicKeyHex,
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

  // Readme fixtures: real (tiny) tarballs so extraction actually runs.
  const readmeDir = path.join(sandbox, 'readme-fixture');
  fs.mkdirSync(readmeDir, { recursive: true });
  fs.writeFileSync(path.join(readmeDir, 'package.xi'),
    'name: "readme-pkg";\nversion: "1.0.0";\ndescription: "Has a readme";');
  fs.writeFileSync(path.join(readmeDir, 'README.md'), [
    '# Readme fixture',
    '',
    'Install with `xiom pkg install readme-pkg`.',
    '',
    '- first',
    '- second',
    '',
    '[Guide](https://xiom-lang.org/docs)',
    '',
    '<script>alert(1)</script>',
    '',
  ].join('\n'));
  const readmeTarball = path.join(sandbox, 'readme-pkg.tar.gz');
  await tar.c({ gzip: true, file: readmeTarball, cwd: readmeDir }, ['package.xi', 'README.md']);
  assert.equal((await publish({
    name: 'readme-pkg', version: '1.0.0', bytes: fs.readFileSync(readmeTarball),
  })).status, 201);

  const noReadmeDir = path.join(sandbox, 'no-readme-fixture');
  fs.mkdirSync(noReadmeDir, { recursive: true });
  fs.writeFileSync(path.join(noReadmeDir, 'package.xi'),
    'name: "no-readme-pkg";\nversion: "1.0.0";\ndescription: "No readme";');
  const noReadmeTarball = path.join(sandbox, 'no-readme-pkg.tar.gz');
  await tar.c({ gzip: true, file: noReadmeTarball, cwd: noReadmeDir }, ['package.xi']);
  const noReadmePublish = await publish({
    name: 'no-readme-pkg', version: '1.0.0', bytes: fs.readFileSync(noReadmeTarball),
  });
  assert.equal(noReadmePublish.status, 201);
  noReadmeWarnings = (await noReadmePublish.json()).warnings || [];
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
  assert.equal(data.packages, 6);
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
  assert.equal(data.packages.length, 6);
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

test('banner is the masthead with the centred search inside it', async () => {
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
    assert.match(html, /<form class="banner-search"/, path);
    assert.doesNotMatch(html, /class="search-form site-search"/, `no duplicate page-level search on ${path}`);
    assert.doesNotMatch(html, /class="brand"/, `no duplicate header brand on ${path}`);
  }

  const home = await (await fetch(`${baseUrl}/`, { headers: BROWSER })).text();
  assert.match(home, /<h1>Packages<\/h1>/, 'home keeps exactly one visible page heading');

  const search = await (await fetch(`${baseUrl}/search?q=demo`, { headers: BROWSER })).text();
  assert.match(search, /name="q" type="search" value="demo"/, 'the banner keeps the query on the search page');
});

test('package status badges pick one art file per package and serve the matrix', async () => {
  const html = await (await fetch(`${baseUrl}/packages`, { headers: BROWSER })).text();

  // First-party fixture is unsigned: official track, unsigned state.
  assert.match(html, /\/packages\/xiom\.official-fixture[\s\S]{0,400}src="\/ui\/pgk_unsigned_official\.webp"/);
  assert.match(html, /src="\/ui\/pgk_unsigned_official\.webp"[^>]*alt="Official package, unsigned"/);
  // Signed latest version: community track, verified (publisher-signed) state,
  // with the explicit "signed" pill beside the icon.
  assert.match(html, /\/packages\/signed-pkg[\s\S]{0,400}src="\/ui\/pgk_verified_community\.webp"/);
  assert.match(html, /title="Signed by the publisher"/);
  assert.match(html, /src="\/ui\/pgk_verified_community\.webp"[\s\S]{0,200}class="badge signed">signed</);
  // Unsigned community packages.
  assert.match(html, /\/packages\/demo-pkg[\s\S]{0,400}src="\/ui\/pgk_unsigned_community\.webp"/);
  assert.match(html, /\/packages\/hostile-pkg[\s\S]{0,400}src="\/ui\/pgk_unsigned_community\.webp"/);
  assert.match(html, /width="64" height="64" loading="lazy"/);

  const matrix = {
    official: ['flagged', 'yanked', 'deprecated', 'incubator', 'prerelease', 'verified', 'unsigned'],
    community: ['flagged', 'yanked', 'deprecated', 'incubator', 'prerelease', 'trusted', 'verified', 'unsigned'],
  };
  for (const [track, states] of Object.entries(matrix)) {
    for (const state of states) {
      const file = `pgk_${state}_${track}.webp`;
      const res = await fetch(`${baseUrl}/ui/${file}`, { headers: BROWSER });
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type'), /image\/webp/, file);
      assert.ok((await res.arrayBuffer()).byteLength > 1000, file);
    }
  }
  // `trusted` is community-only: official publishes are org-controlled by
  // definition, so there is deliberately no trusted_official art.
  const noTrustedOfficial = await fetch(`${baseUrl}/ui/pgk_trusted_official.webp`, { headers: BROWSER });
  assert.equal(noTrustedOfficial.status, 404);
});

test('packageBadgeState precedence and track selection', () => {
  const { packageBadgeState } = require('../src/ui/pages');
  const signed = { signature: 'aa', publicKey: 'bb' };
  const make = (name, latest, entry, extra = {}) => ({
    name,
    latest,
    versions: latest ? { [latest]: { ...entry } } : {},
    ...extra,
  });
  const stateOf = (badge) => badge.file.replace(/^pgk_/, '').replace(/_(official|community)\.webp$/, '');
  const trackOf = (badge) => (badge.file.includes('_official') ? 'official' : 'community');

  // Flagged (operator-set) beats everything, including a signed official package.
  const flagged = packageBadgeState('xiom.core', make('xiom.core', '1.0.0', signed, { flagged: true }));
  assert.equal(stateOf(flagged), 'flagged');
  assert.equal(trackOf(flagged), 'official');

  // Every version yanked (no latest) beats the stage and signature states.
  const yanked = packageBadgeState('demo-pkg', { name: 'demo-pkg', latest: '', versions: { '0.1.0': { yanked: true, ...signed } } });
  assert.equal(stateOf(yanked), 'yanked');

  // Manifest stage drives deprecated/incubator and beats signed.
  const deprecated = packageBadgeState('demo-pkg', make('demo-pkg', '1.0.0', signed, { stage: 'deprecated' }));
  assert.equal(stateOf(deprecated), 'deprecated');
  const incubator = packageBadgeState('xiom.core', make('xiom.core', '1.0.0', signed, { stage: 'incubating' }));
  assert.equal(stateOf(incubator), 'incubator');
  assert.equal(trackOf(incubator), 'official');

  // A pre-release latest beats the trust states.
  const prerelease = packageBadgeState('demo-pkg', make('demo-pkg', '0.2.0-rc.1', signed));
  assert.equal(stateOf(prerelease), 'prerelease');

  // Trusted publisher (community only): OIDC provenance on the latest version.
  const trusted = packageBadgeState('demo-pkg', make('demo-pkg', '1.0.0', {
    ...signed, publisher: { repository: 'some-org/some-repo' },
  }));
  assert.equal(stateOf(trusted), 'trusted');
  assert.deepEqual(trusted.pills, ['trusted', 'signed'], 'a trusted publisher that also signed shows both pills');
  const trustedUnsigned = packageBadgeState('demo-pkg', make('demo-pkg', '1.0.0', {
    publisher: { repository: 'some-org/some-repo' },
  }));
  assert.deepEqual(trustedUnsigned.pills, ['trusted']);
  // Official publishes never get the community trusted state.
  const officialOidc = packageBadgeState('xiom.core', make('xiom.core', '1.0.0', {
    ...signed, publisher: { repository: 'xiom-lang/xiom' },
  }));
  assert.equal(stateOf(officialOidc), 'verified');
  assert.equal(trackOf(officialOidc), 'official');

  // Signed and unsigned on both tracks.
  const verifiedCommunity = packageBadgeState('demo-pkg', make('demo-pkg', '1.0.0', signed));
  assert.equal(stateOf(verifiedCommunity), 'verified');
  assert.deepEqual(verifiedCommunity.pills, ['signed']);
  assert.equal(stateOf(packageBadgeState('xiom.core', make('xiom.core', '1.0.0', signed))), 'verified');
  assert.equal(stateOf(packageBadgeState('demo-pkg', make('demo-pkg', '1.0.0', {}))), 'unsigned');
  assert.equal(stateOf(packageBadgeState('xiom.core', make('xiom.core', '1.0.0', {}))), 'unsigned');

  // A package with no versions at all still gets an unsigned badge.
  assert.equal(stateOf(packageBadgeState('demo-pkg', { name: 'demo-pkg', versions: {} })), 'unsigned');
});

test('readme is served from the stored tarball and rendered safely', async () => {
  const raw = await fetch(`${baseUrl}/packages/readme-pkg/1.0.0/readme`, { headers: API });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /text\/markdown/);
  assert.match(raw.headers.get('cache-control'), /immutable/);
  const body = await raw.text();
  assert.match(body, /# Readme fixture/);
  assert.match(body, /<script>alert\(1\)<\/script>/, 'raw markdown keeps its source text');

  // Both package-page forms embed the rendered readme inside <details>.
  for (const target of ['/packages/readme-pkg', '/packages/readme-pkg/1.0.0']) {
    const page = await (await fetch(`${baseUrl}${target}`, { headers: BROWSER })).text();
    assert.match(page, /<details class="readme">/, target);
    assert.match(page, /<div class="markdown"><h1>Readme fixture<\/h1>/, target);
    assert.match(page, /<code>xiom pkg install readme-pkg<\/code>/, target);
    assert.match(page, /<ul>\n<li>first<\/li>\n<li>second<\/li>\n<\/ul>/, target);
    assert.match(page, /<a href="https:\/\/xiom-lang\.org\/docs" rel="noopener nofollow" target="_blank">Guide<\/a>/, target);
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, `readme markup escaped on ${target}`);
    assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/, `no live script from a readme on ${target}`);
    assert.match(page, /href="\/packages\/readme-pkg\/1\.0\.0\/readme"/, target);
  }

  // A package without a readme hides the block and 404s the endpoint.
  const missing = await fetch(`${baseUrl}/packages/no-readme-pkg/1.0.0/readme`, { headers: API });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'readme_not_found');
  const noReadmePage = await (await fetch(`${baseUrl}/packages/no-readme-pkg`, { headers: BROWSER })).text();
  assert.doesNotMatch(noReadmePage, /<details class="readme">/);

  // Publish warns at the source when the tarball has no README.md.
  assert.ok(
    noReadmeWarnings.some((warning) => /no README\.md/.test(warning)),
    `expected a missing-readme warning, got: ${JSON.stringify(noReadmeWarnings)}`,
  );
});

test('listing paginates with totals while index.json stays whole', async () => {
  const page = await (await fetch(`${baseUrl}/packages?per_page=2&page=3`, { headers: API })).json();
  assert.equal(page.page, 3);
  assert.equal(page.per_page, 2);
  assert.equal(page.total, 6);
  assert.equal(page.total_pages, 3);
  assert.deepEqual(page.packages.map((pkg) => pkg.name), ['signed-pkg', 'xiom.official-fixture']);

  // Out-of-range values clamp instead of erroring.
  const clamped = await (await fetch(`${baseUrl}/packages?page=0&per_page=10000`, { headers: API })).json();
  assert.equal(clamped.page, 1);
  assert.equal(clamped.per_page, 200);
  const beyond = await (await fetch(`${baseUrl}/packages?page=99&per_page=2`, { headers: API })).json();
  assert.equal(beyond.page, 3, 'a page past the end snaps to the last page');

  const html = await (await fetch(`${baseUrl}/packages?per_page=2`, { headers: BROWSER })).text();
  assert.match(html, /Page 1 of 3 &middot; 6 packages/);
  assert.match(html, /href="\/packages\?page=2&amp;per_page=2"/);
  assert.match(html, /class="page-link disabled">&larr; Previous/);

  // The protocol index keeps every package regardless of listing params.
  const whole = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
  assert.equal(Object.keys(whole.packages).length, 6);
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
