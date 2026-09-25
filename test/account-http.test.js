// XIOM Package Registry -- registry 2.0 HTTP tests (sign-in, requests, admin).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Drives the real app against a local fake GitHub provider: sign-in round
// trip, CSRF, request lifecycle, admin approval/fulfilment, and the disabled
// path. Publishing routes are untouched by these tests on purpose.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

let sandbox;
let app;
let server;
let baseUrl;
let fake;
let fakeServer;
let fakeBase;
const loginCodes = new Map();

const BROWSER = { Accept: 'text/html,application/xhtml+xml' };

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

/** Full sign-in round trip through the fake provider; returns the redirect. */
async function login(jar, code) {
  let response = await requestAs(jar, '/auth/github/start');
  assert.equal(response.status, 302);
  const authorize = new URL(response.headers.get('location'));
  assert.equal(authorize.origin, fakeBase);
  loginCodes.set(authorize.searchParams.get('state'), code);

  const provider = await fetch(authorize, { redirect: 'manual' });
  assert.equal(provider.status, 302);
  const callback = new URL(provider.headers.get('location'));
  assert.equal(callback.pathname, '/auth/github/callback');
  assert.equal(callback.searchParams.get('code'), code);

  response = await requestAs(jar, `${callback.pathname}${callback.search}`);
  assert.equal(response.status, 302);
  return response;
}

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/);
  assert.ok(match, 'expected a csrf token in the form');
  return match[1];
}

test.before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-accounts-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.REGISTRY_URL = 'http://127.0.0.1:3999';
  process.env.RATE_LIMIT_DISABLED = '1';
  delete process.env.TOKENS_FILE;
  process.env.API_KEY = 'admin-test-key';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret-0123456789';
  process.env.REGISTRY_ADMIN_LOGINS = 'Admin-User';

  fake = express();
  fake.use(express.urlencoded({ extended: false }));
  fake.get('/login/oauth/authorize', (req, res) => {
    const code = loginCodes.get(String(req.query.state)) || 'admin-code';
    res.redirect(302, `${baseUrl}/auth/github/callback?code=${code}&state=${encodeURIComponent(String(req.query.state))}`);
  });
  fake.post('/login/oauth/access_token', (req, res) => {
    if (req.body.code === 'admin-code') return res.json({ access_token: 'admin-token' });
    if (req.body.code === 'user-code') return res.json({ access_token: 'user-token' });
    res.json({ error: 'bad_verification_code', error_description: 'incorrect or expired' });
  });
  fake.get('/user', (req, res) => {
    if (req.headers.authorization === 'Bearer admin-token') {
      return res.json({ id: 4242, login: 'admin-user', name: 'Admin', avatar_url: '' });
    }
    if (req.headers.authorization === 'Bearer user-token') {
      return res.json({ id: 777, login: 'user-user', name: 'User', avatar_url: '' });
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
});

test.after(() => {
  if (server) server.close();
  if (fakeServer) fakeServer.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('sign-in round trip, request lifecycle, and admin fulfilment', async () => {
  const jar = cookieJar();

  let response = await requestAs(jar, '/login');
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /Sign in with GitHub/);
  assert.match(html, /href="\/auth\/github\/start"/);
  assert.doesNotMatch(html, /href="\/login"/, 'no self-link on the sign-in page');

  await login(jar, 'admin-code');

  response = await requestAs(jar, '/account');
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /@admin-user/);
  assert.match(html, /href="\/admin\/requests"/, 'admins get the queue link');
  const csrf = csrfFrom(html);

  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ csrf, kind: 'token', scopes: 'my-lib, my-ns' }),
  });
  assert.equal(response.status, 303);
  const created = new URL(response.headers.get('location'), baseUrl).searchParams.get('created');
  assert.match(created, /^req_[0-9a-f]{12}$/);

  response = await requestAs(jar, '/account');
  html = await response.text();
  assert.match(html, new RegExp(created));
  assert.match(html, /pending review/);

  response = await requestAs(jar, '/admin/requests');
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, new RegExp(created));
  assert.match(html, /Approve/);

  response = await requestAs(jar, `/admin/requests/${created}/decision`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'approve', note: 'looks fine' }),
  });
  assert.equal(response.status, 303);

  response = await requestAs(jar, `/admin/requests/${created}/fulfil`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, reference: 'emailed alice' }),
  });
  assert.equal(response.status, 303);

  response = await requestAs(jar, '/admin/requests');
  html = await response.text();
  assert.match(html, /fulfilled/);
  assert.match(html, /emailed alice/);

  // Audit trail and identity landed on disk; no token anywhere.
  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'requests.json'), 'utf-8'));
  assert.deepEqual(
    data.requests[created].history.map((entry) => entry.action),
    ['created', 'approved', 'fulfilled'],
  );
  assert.equal(data.requests[created].decidedBy, 'admin-user');
  const accounts = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'accounts.json'), 'utf-8'));
  assert.equal(accounts.accounts['4242'].login, 'admin-user');
  assert.doesNotMatch(JSON.stringify(data), /admin-token|client-secret/);
});

test('denials require a reason and are recorded in the audit history', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');

  let response = await requestAs(jar, '/account');
  let html = await response.text();
  const csrf = csrfFrom(html);
  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ csrf, kind: 'token', scopes: 'deny-me' }),
  });
  assert.equal(response.status, 303);
  const created = new URL(response.headers.get('location'), baseUrl).searchParams.get('created');

  // A denial without a reason is refused and stays pending.
  response = await requestAs(jar, `/admin/requests/${created}/decision`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'deny' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/admin/requests');
  html = await response.text();
  assert.match(html, /a reason is required when denying a request/);
  assert.match(html, /pending review/);

  // With a reason the denial records the note in the history.
  response = await requestAs(jar, `/admin/requests/${created}/decision`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'deny', note: 'name conflicts with an existing project' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/admin/requests');
  html = await response.text();
  assert.match(html, /denied by @admin-user \(name conflicts with an existing project\)/);
});

test('CSRF is enforced and non-admins cannot reach the queue', async () => {
  const jar = cookieJar();
  await login(jar, 'user-code');

  let response = await requestAs(jar, '/account');
  let html = await response.text();
  assert.match(html, /@user-user/);
  assert.doesNotMatch(html, /href="\/admin\/requests"/);
  const csrf = csrfFrom(html);

  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ kind: 'token', scopes: 'user-lib' }),
  });
  assert.equal(response.status, 403, 'missing csrf token is refused');

  response = await requestAs(jar, '/admin/requests');
  assert.equal(response.status, 403, 'non-admin queue access is refused');

  response = await requestAs(jar, '/admin/requests/req_aaaaaaaaaaaa/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'approve' }),
  });
  assert.equal(response.status, 403);
});

test('anonymous users are redirected to sign-in, not served account pages', async () => {
  const jar = cookieJar();
  let response = await requestAs(jar, '/account');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login?returnTo=%2Faccount');

  // The nav shows Sign in as a button next to the text menu.
  response = await requestAs(jar, '/packages', { headers: BROWSER });
  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /class="nav-account nav-button nav-button-primary" href="\/login"/,
  );

  response = await requestAs(jar, '/admin/requests');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login?returnTo=%2Fadmin%2Frequests');

  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ kind: 'token', scopes: 'x' }),
  });
  assert.equal(response.status, 401);
});

test('OAuth state is verified and single-use', async () => {
  const jar = cookieJar();
  let response = await requestAs(jar, '/auth/github/start');
  assert.equal(response.status, 302);
  const state = new URL(response.headers.get('location')).searchParams.get('state');

  response = await requestAs(jar, '/auth/github/callback?code=admin-code&state=wrong-state');
  assert.equal(response.status, 403);

  response = await requestAs(jar, `/auth/github/callback?code=admin-code&state=${state}`);
  assert.equal(response.status, 302);

  response = await requestAs(jar, `/auth/github/callback?code=admin-code&state=${state}`);
  assert.equal(response.status, 403, 'the callback cannot be replayed');
});

test('a registry without OAuth hides sign-in and refuses account routes', async () => {
  const config = loadConfig();
  config.oauth = {
    ...config.oauth,
    enabled: false,
    clientId: '',
    clientSecret: '',
    adminLogins: [],
  };
  const disabled = createApp(config);
  const disabledServer = await listen(disabled);
  const disabledBase = originOf(disabledServer);
  try {
    const login = await fetch(`${disabledBase}/login`, { headers: BROWSER });
    assert.equal(login.status, 200);
    const html = await login.text();
    assert.match(html, /not configured/);
    assert.doesNotMatch(html, /Sign in with GitHub/);

    const account = await fetch(`${disabledBase}/account`, { redirect: 'manual' });
    assert.equal(account.status, 302);
    assert.equal(account.headers.get('location'), '/login');

    const post = await fetch(`${disabledBase}/requests`, { method: 'POST', redirect: 'manual' });
    assert.equal(post.status, 401);
  } finally {
    disabledServer.close();
  }
});
