// XIOM Package Registry -- A5 feeds + following HTTP tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 A5: watching a package is a signed-in, toggle action whose
// count is public; the account feed merges the same public activity the
// package page shows; new releases notify watchers through the `release`
// kind, which mutes like every structured kind. /index.json is untouched.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const tar = require('tar');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const TOKEN = 'feed-token';
const BROWSER = { Accept: 'text/html,application/xhtml+xml' };
const API = { Accept: '*/*' };

let sandbox;
let app;
let server;
let baseUrl;
let fake;
let fakeServer;
let fakeBase;
const loginCodes = new Map();

function listen(instance) {
  return new Promise((resolve) => {
    const httpServer = instance.listen(0, '127.0.0.1', () => resolve(httpServer));
  });
}

function originOf(httpServer) {
  return `http://127.0.0.1:${httpServer.address().port}`;
}

function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    store(response) {
      const values = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const value of values) {
        const [pair] = value.split(';');
        const separator = pair.indexOf('=');
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const cookieValue = pair.slice(separator + 1).trim();
        if (/max-age=0/i.test(value)) jar.delete(name);
        else jar.set(name, cookieValue);
      }
    },
  };
}

async function requestAs(jar, target, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookies = jar.header();
  if (cookies) headers.Cookie = cookies;
  const response = await fetch(`${baseUrl}${target}`, { redirect: 'manual', ...options, headers });
  jar.store(response);
  return response;
}

async function login(jar, code) {
  let response = await requestAs(jar, '/auth/github/start');
  assert.equal(response.status, 302);
  const authorize = new URL(response.headers.get('location'));
  assert.equal(authorize.origin, fakeBase);
  loginCodes.set(authorize.searchParams.get('state'), code);
  const provider = await fetch(authorize, { redirect: 'manual' });
  assert.equal(provider.status, 302);
  const callback = new URL(provider.headers.get('location'));
  response = await requestAs(jar, `${callback.pathname}${callback.search}`);
  assert.equal(response.status, 302);
  return response;
}

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/);
  assert.ok(match, 'expected a csrf token in the form');
  return match[1];
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

const manifest = (name, version) => `name: "${name}";\nversion: "${version}";\n`;

async function publish({ name, version }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-feed-'));
  const tarball = await makeTarball(dir, manifest(name, version));
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
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-feed-http-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'http://127.0.0.1:3999';
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.TOKENS_FILE = path.join(sandbox, 'tokens.json');
  process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret-0123456789';
  delete process.env.REGISTRY_ADMIN_LOGINS;
  delete process.env.REGISTRY_REVIEWER_LOGINS;
  fs.writeFileSync(process.env.TOKENS_FILE, JSON.stringify([
    { token: TOKEN, label: 'feed', scopes: ['*'], trusted: false, firstParty: true },
  ]));

  fake = express();
  fake.use(express.urlencoded({ extended: false }));
  fake.get('/login/oauth/authorize', (req, res) => {
    const code = loginCodes.get(String(req.query.state)) || 'bob-code';
    res.redirect(302, `${baseUrl}/auth/github/callback?code=${code}&state=${encodeURIComponent(String(req.query.state))}`);
  });
  fake.post('/login/oauth/access_token', (req, res) => {
    if (req.body.code === 'bob-code') return res.json({ access_token: 'bob-token' });
    if (req.body.code === 'carol-code') return res.json({ access_token: 'carol-token' });
    res.json({ error: 'bad_verification_code', error_description: 'incorrect or expired' });
  });
  fake.get('/user', (req, res) => {
    if (req.headers.authorization === 'Bearer bob-token') {
      return res.json({ id: 2001, login: 'bob', name: 'Bob', avatar_url: '' });
    }
    if (req.headers.authorization === 'Bearer carol-token') {
      return res.json({ id: 2002, login: 'carol', name: 'Carol', avatar_url: '' });
    }
    res.status(401).json({ message: 'Bad credentials' });
  });
  fakeServer = await listen(fake);
  fakeBase = originOf(fakeServer);

  const config = loadConfig();
  config.oauth.authorizeUrl = `${fakeBase}/login/oauth/authorize`;
  config.oauth.tokenUrl = `${fakeBase}/login/oauth/access_token`;
  config.oauth.apiUrl = fakeBase;
  app = createApp(config);
  server = await listen(app);
  baseUrl = originOf(server);

  const first = await publish({ name: 'feed-pkg', version: '1.0.0' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
});

test.after(() => {
  if (server) server.close();
  if (fakeServer) fakeServer.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('watching toggles on the package page and stays out of the protocol', async () => {
  let response = await fetch(`${baseUrl}/packages/feed-pkg`, { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /0 watching/);
  assert.match(html, /Sign in<\/a> to follow new releases/);

  const bob = cookieJar();
  await login(bob, 'bob-code');
  response = await requestAs(bob, '/packages/feed-pkg', { headers: BROWSER });
  html = await response.text();
  const csrf = csrfFrom(html);
  response = await requestAs(bob, '/packages/feed-pkg/watch', {
    method: 'POST',
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/packages/feed-pkg?watched=1#watch');

  response = await requestAs(bob, '/packages/feed-pkg?watched=1', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /You are watching this package/);
  assert.match(html, />Unwatch<\/button>/);
  assert.match(html, /1 watching/);

  // Toggle off with the same action.
  response = await requestAs(bob, '/packages/feed-pkg/watch', {
    method: 'POST',
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(response.headers.get('location'), '/packages/feed-pkg?watched=0#watch');
  response = await requestAs(bob, '/packages/feed-pkg', { headers: BROWSER });
  assert.match(await response.text(), /0 watching/);

  // CSRF and sign-in gate the route.
  response = await requestAs(bob, '/packages/feed-pkg/watch', {
    method: 'POST',
    body: new URLSearchParams({}),
  });
  assert.equal(response.status, 403);
  response = await fetch(`${baseUrl}/packages/feed-pkg/watch`, { method: 'POST', redirect: 'manual' });
  assert.equal(response.status, 401);

  // The protocol index carries no watch state.
  const index = await (await fetch(`${baseUrl}/index.json`, { headers: API })).json();
  assert.ok(!('watchers' in index.packages['feed-pkg']));
  assert.ok(!index.packages['feed-pkg'].versions['1.0.0'].watchers);

  // Watch again for the feed test.
  response = await requestAs(bob, '/packages/feed-pkg', { headers: BROWSER });
  const again = csrfFrom(await response.text());
  response = await requestAs(bob, '/packages/feed-pkg/watch', {
    method: 'POST',
    body: new URLSearchParams({ csrf: again }),
  });
  assert.equal(response.status, 303);
});

test('the feed merges watched activity and release notices honour mutes', async () => {
  const { notifications } = app.locals.registry;
  const bob = cookieJar();
  await login(bob, 'bob-code');
  const before = notifications.listFor('2001', { limit: 200 }).length;

  // A new release reaches the watcher exactly once.
  const result = await publish({ name: 'feed-pkg', version: '1.1.0' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const rows = notifications.listFor('2001', { limit: 200 });
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].kind, 'release');
  assert.equal(rows[0].subject, 'New release: feed-pkg 1.1.0');
  assert.equal(rows[0].link, '/packages/feed-pkg');
  assert.equal(rows[0].ref, 'feed-pkg@1.1.0');

  // Carol does not watch it and hears nothing.
  const carol = cookieJar();
  await login(carol, 'carol-code');
  assert.equal(notifications.listFor('2002', { limit: 200 }).length, 0);

  // Bob's feed lists the release and his watch chip.
  let response = await requestAs(bob, '/account/feed', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /1\.1\.0/);
  assert.match(html, /Watching:/);
  assert.match(html, /href="\/packages\/feed-pkg#watch"/);

  // Carol's public review reaches the feed too.
  response = await requestAs(carol, '/packages/feed-pkg', { headers: BROWSER });
  const carolCsrf = csrfFrom(await response.text());
  response = await requestAs(carol, '/packages/feed-pkg/rating', {
    method: 'POST',
    body: new URLSearchParams({ csrf: carolCsrf, stars: '4', review: 'solid release' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(bob, '/account/feed', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /carol/);
  assert.match(html, /solid release/);

  // Muting the release kind stops the notice but not the feed.
  response = await requestAs(bob, '/account/settings', { headers: BROWSER });
  const settingsCsrf = csrfFrom(await response.text());
  response = await requestAs(bob, '/account/notify-kinds', {
    method: 'POST',
    body: new URLSearchParams({
      csrf: settingsCsrf, claim: 'on', report: 'on', review: 'on', support: 'on', 'review-reply': 'on',
    }),
  });
  assert.equal(response.status, 303);
  const afterMute = notifications.listFor('2001', { limit: 200 }).length;
  const second = await publish({ name: 'feed-pkg', version: '1.2.0' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(
    notifications.listFor('2001', { limit: 200 }).length,
    afterMute,
    'the muted release kind wrote no row',
  );
  response = await requestAs(bob, '/account/feed', { headers: BROWSER });
  assert.match(await response.text(), /1\.2\.0/, 'the feed still shows the release');

  // Anonymous feed access redirects to sign-in.
  response = await fetch(`${baseUrl}/account/feed`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /\/login/);
});

test('the package page shows the public activity trail', async () => {
  const response = await fetch(`${baseUrl}/packages/feed-pkg`, { headers: BROWSER });
  const html = await response.text();
  assert.match(html, /id="activity"/);
  const activity = html.split('id="activity"')[1].split('</section>')[0];
  assert.match(activity, /release/);
  assert.match(activity, /1\.2\.0/);
  assert.match(activity, /1\.0\.0/);
  assert.match(activity, /carol/);
  assert.match(activity, /solid release/);
  // The empty state exists for a package with no events beyond its release? --
  // feed-pkg always has releases, so instead assert the section cap: newest
  // first and a bounded list.
  const rows = activity.match(/class="activity-row"/g) || [];
  assert.ok(rows.length >= 4 && rows.length <= 12, `bounded activity list (${rows.length})`);
});
