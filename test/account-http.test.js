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
  process.env.REGISTRY_REVIEWER_LOGINS = 'user-user';
  process.env.FULFILLER_SECRET = 'test-fulfiller-secret';

  fake = express();
  fake.use(express.urlencoded({ extended: false }));
  fake.get('/login/oauth/authorize', (req, res) => {
    const code = loginCodes.get(String(req.query.state)) || 'admin-code';
    res.redirect(302, `${baseUrl}/auth/github/callback?code=${code}&state=${encodeURIComponent(String(req.query.state))}`);
  });
  fake.post('/login/oauth/access_token', (req, res) => {
    if (req.body.code === 'admin-code') return res.json({ access_token: 'admin-token' });
    if (req.body.code === 'user-code') return res.json({ access_token: 'user-token' });
    if (req.body.code === 'plain-code') return res.json({ access_token: 'plain-token' });
    res.json({ error: 'bad_verification_code', error_description: 'incorrect or expired' });
  });
  fake.get('/user', (req, res) => {
    if (req.headers.authorization === 'Bearer admin-token') {
      return res.json({ id: 4242, login: 'admin-user', name: 'Admin', avatar_url: '' });
    }
    if (req.headers.authorization === 'Bearer user-token') {
      return res.json({ id: 777, login: 'user-user', name: 'User', avatar_url: '' });
    }
    if (req.headers.authorization === 'Bearer plain-token') {
      return res.json({ id: 888, login: 'plain-user', name: 'Plain', avatar_url: '' });
    }
    res.status(401).json({ message: 'Bad credentials' });
  });
  fakeServer = await listen(fake);
  fakeBase = originOf(fakeServer);

  // One package in the index so the package page (report form) renders; the
  // artifact itself is absent, which only hides the readme block.
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  // Fixtures for A2 notification coverage (SESSION.md 22.4): one package per
  // event stream, plus a maintainer (ghost-org) who has no registry account.
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'index.json'), JSON.stringify({
    version: '1.0.0',
    updated_at: new Date().toISOString(),
    packages: {
      'readme-pkg': {
        name: 'readme-pkg',
        description: 'fixture package',
        versions: {
          '1.0.0': { version: '1.0.0', sha256: 'aa'.repeat(32), size: 10, published: new Date().toISOString() },
        },
        latest: '1.0.0',
      },
      'notify-claim-pkg': {
        name: 'notify-claim-pkg',
        description: 'fixture package for claim notices',
        versions: {
          '1.0.0': { version: '1.0.0', sha256: 'bb'.repeat(32), size: 10, published: new Date().toISOString() },
        },
        latest: '1.0.0',
      },
      'notify-report-pkg': {
        name: 'notify-report-pkg',
        description: 'fixture package for report notices',
        versions: {
          '1.0.0': { version: '1.0.0', sha256: 'cc'.repeat(32), size: 10, published: new Date().toISOString() },
        },
        latest: '1.0.0',
      },
      'notify-decision-pkg': {
        name: 'notify-decision-pkg',
        description: 'fixture package for decision notices',
        versions: {
          '1.0.0': {
            version: '1.0.0', sha256: 'dd'.repeat(32), size: 10, published: new Date().toISOString(),
            publisher: { repository: 'user-user/notify-decision-pkg' },
          },
          '0.9.0': {
            version: '0.9.0', sha256: 'ee'.repeat(32), size: 10, published: new Date().toISOString(),
            publisher: { repository: 'ghost-org/notify-decision-pkg' },
          },
        },
        latest: '1.0.0',
      },
    },
  }));

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
  // Close the SQLite handle before deleting the sandbox (Windows locks).
  if (app && app.locals.registry && app.locals.registry.db) app.locals.registry.db.close();
  try {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file briefly; leftover temp dirs are fine.
  }
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
  assert.match(html, /href="\/admin"/, 'admins get the console link');
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
  assert.doesNotMatch(html, /href="\/admin"/);
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

test('signed-in accounts can report a package and reviewers act on it', async () => {
  const jar = cookieJar();
  await login(jar, 'user-code');

  let response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /Report this package/);
  assert.match(html, /href="\/review"/, 'reviewers get the queue link in the nav');
  const csrf = csrfFrom(html);

  // Validation first: a report without a note is refused with the reason shown.
  response = await requestAs(jar, '/packages/readme-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf, reason: 'license', note: '' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /describe the problem/);

  response = await requestAs(jar, '/packages/readme-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf, reason: 'license', note: 'no license file in the tarball' }),
  });
  assert.equal(response.status, 303);
  const reportId = new URL(response.headers.get('location'), baseUrl).searchParams.get('reported');
  assert.match(reportId, /^rep_[0-9a-f]{12}$/);

  response = await requestAs(jar, '/review', { headers: BROWSER });
  html = await response.text();
  assert.match(html, new RegExp(reportId));
  assert.match(html, /no license file in the tarball/);
  assert.match(html, /Resolve/);

  response = await requestAs(jar, `/review/reports/${reportId}/resolve`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, status: 'resolved', resolution: 'confirmed; license added in 1.0.1' }),
  });
  assert.equal(response.status, 303);

  response = await requestAs(jar, '/review', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /license added in 1\.0\.1/);
  assert.match(html, /@user-user/);

  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'reviews.json'), 'utf-8'));
  assert.equal(data.reports[reportId].status, 'resolved');
  assert.equal(data.reports[reportId].resolvedBy, 'user-user');
});

test('reporting needs sign-in and the queue is reviewer-only', async () => {
  const anonymous = cookieJar();
  let response = await requestAs(anonymous, '/packages/readme-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ reason: 'other', note: 'x' }),
  });
  assert.equal(response.status, 401);

  const plain = cookieJar();
  await login(plain, 'plain-code');
  response = await requestAs(plain, '/review', { headers: BROWSER });
  assert.equal(response.status, 403);

  response = await requestAs(plain, '/packages/readme-pkg', { headers: BROWSER });
  const html = await response.text();
  assert.match(html, /Report this package/, 'any signed-in account can report');
  assert.doesNotMatch(html, /href="\/review"/, 'plain accounts get no reviewer link');
});

test('reviewers toggle flag, mute, and review independently with a public history', async () => {
  const jar = cookieJar();
  await login(jar, 'user-code');

  let response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /Mark reviewed/, 'reviewers get decision controls');
  const csrf = csrfFrom(html);

  // Marking reviewed gives the icon its fallback ring (no reviewed art ships
  // in the matrix) and the public decision pill.
  response = await requestAs(jar, '/review/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'review', note: 'looks fine' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /reviewed by a reviewer/);
  assert.match(html, /pkg-badge--reviewed/);
  assert.match(html, /Clear review/, 'the review toggle reflects the current state');

  // Flagging needs a reason; the error comes back on the package page.
  response = await requestAs(jar, '/review/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'flag' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /a reason is required when flagging/);
  assert.doesNotMatch(html, /flagged by a reviewer/);

  // Flagging supersedes the clean verdict; the flag art shows.
  response = await requestAs(jar, '/review/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'flag', note: 'confirmed unsafe' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /flagged by a reviewer/);
  assert.doesNotMatch(html, /reviewed by a reviewer/, 'a flag clears the reviewed mark');
  assert.match(html, /confirmed unsafe/);

  // The listing overlay shows the flagged community art.
  response = await requestAs(jar, '/packages', { headers: BROWSER });
  assert.match(await response.text(), /src="\/ui\/pgk_flagged_community\.webp"/);

  // Muting is independent: it coexists with the flag, and unflagging leaves
  // the mute in place. No undo required.
  response = await requestAs(jar, '/review/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'mute', note: 'metadata spam' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /flagged by a reviewer/);
  assert.match(html, /muted by the maintainers/);
  assert.match(html, /pkg-badge-group--muted/, 'the muted tag stays visible next to the flagged art');

  response = await requestAs(jar, '/review/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'unflag', note: 'appeal accepted' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.doesNotMatch(html, /flagged by a reviewer/);
  assert.match(html, /muted by the maintainers/, 'unflagging does not clear the mute');
  assert.match(html, /Unmute/);

  response = await requestAs(jar, '/review/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'unmute' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.doesNotMatch(html, /muted by the maintainers/);
  assert.doesNotMatch(html, /flagged by a reviewer/);
  assert.match(html, /Mark reviewed/, 'the toggles read back to their neutral state');

  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'reviews.json'), 'utf-8'));
  assert.deepEqual(
    data.packages['readme-pkg'].history.map((entry) => entry.action),
    ['review', 'flag', 'mute', 'unflag', 'unmute'],
  );

  // A plain account sees the history but no controls.
  const plain = cookieJar();
  await login(plain, 'plain-code');
  response = await requestAs(plain, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.doesNotMatch(html, /Mark reviewed/);
  assert.match(html, /Review history/);
});

test('approving a trusted publisher activates it and revoking removes it', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');

  let response = await requestAs(jar, '/account');
  let html = await response.text();
  const csrf = csrfFrom(html);
  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({
      csrf,
      kind: 'publisher',
      scopes: 'readme-pkg',
      repository: 'alice/readme-pkg',
      workflow: 'publish-registry.yml',
      refs: 'refs/heads/main',
    }),
  });
  assert.equal(response.status, 303);
  const id = new URL(response.headers.get('location'), baseUrl).searchParams.get('created');

  response = await requestAs(jar, '/admin/requests', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Approve &amp; activate/);

  response = await requestAs(jar, `/admin/requests/${id}/decision`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'approve' }),
  });
  assert.equal(response.status, 303);

  // The entry is live for OIDC matching, and the request auto-fulfilled.
  const { config } = app.locals.registry;
  const entry = config.publishers.find((candidate) => candidate.requestId === id);
  assert.ok(entry, 'approved entry is in the live publisher list');
  assert.equal(entry.repository, 'alice/readme-pkg');
  assert.equal(entry.workflow, 'publish-registry.yml');
  assert.equal(entry.firstParty, false);

  response = await requestAs(jar, '/admin/requests', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Trusted publisher is <strong>live<\/strong>/);
  assert.match(html, /Revoke trusted publisher/);

  response = await requestAs(jar, `/admin/requests/${id}/revoke`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, note: 'mistake' }),
  });
  assert.equal(response.status, 303);
  assert.equal(config.publishers.find((candidate) => candidate.requestId === id), undefined);

  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'requests.json'), 'utf-8'));
  assert.equal(data.requests[id].status, 'fulfilled');
  assert.equal(data.requests[id].history.at(-1).action, 'revoked');

  // The requester got in-app notices for the approval and the revoke.
  const notices = app.locals.registry.notifications.listFor('4242').map((entry) => entry.kind);
  assert.deepEqual(notices.slice(0, 2), ['publisher-revoked', 'publisher-approved']);
});

test('accounts set a notification email and see in-app notices', async () => {
  const jar = cookieJar();
  await login(jar, 'user-code');

  let response = await requestAs(jar, '/account/settings', { headers: BROWSER });
  let html = await response.text();
  const csrf = csrfFrom(html);
  assert.match(html, /Notification email/);

  response = await requestAs(jar, '/account/email', {
    method: 'POST',
    body: new URLSearchParams({ csrf, email: 'not-an-email' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/settings');
  response = await requestAs(jar, '/account/settings', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /does not look valid/);

  response = await requestAs(jar, '/account/email', {
    method: 'POST',
    body: new URLSearchParams({ csrf, email: 'dev@example.com' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/settings?email=1');
  const accountsData = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'accounts.json'), 'utf-8'));
  assert.equal(accountsData.accounts['777'].notifyEmail, 'dev@example.com');
});

test('notification email needs confirmation before any notice email is queued', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');

  // The health payload tells ops whether the mail service is on (D7).
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.email, 'disabled', 'no SMTP_URL in this sandbox');

  let response = await requestAs(jar, '/account/settings', { headers: BROWSER });
  let html = await response.text();
  const csrf = csrfFrom(html);

  // Save an address: it is stored unverified and only the confirmation notice
  // itself is queued for delivery.
  response = await requestAs(jar, '/account/email', {
    method: 'POST',
    body: new URLSearchParams({ csrf, email: 'admin@example.com' }),
  });
  assert.equal(response.status, 303);

  const { accounts, notifications } = app.locals.registry;
  assert.equal(accounts.get('4242').notifyEmail, 'admin@example.com');
  assert.equal(accounts.isEmailVerified('4242'), false);
  const confirmation = notifications.listFor('4242').find((entry) => entry.kind === 'verify-email');
  assert.ok(confirmation, 'confirmation notice queued');
  assert.equal(confirmation.emailStatus, 'pending', 'the confirmation itself may be emailed');
  const token = new URL(`http://x${confirmation.link}`).searchParams.get('token');
  assert.match(token, /^[0-9a-f]{48}$/);

  response = await requestAs(jar, '/account/settings', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /unverified/);

  // An event while unverified stays in-app only: the email column is skipped.
  response = await requestAs(jar, '/packages/notify-claim-pkg', { headers: BROWSER });
  const reportCsrf = csrfFrom(await response.text());
  response = await requestAs(jar, '/packages/notify-claim-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf: reportCsrf, reason: 'other', note: 'verification gate check' }),
  });
  assert.equal(response.status, 303);
  const reportId = new URL(response.headers.get('location'), baseUrl).searchParams.get('reported');

  const reviewer = cookieJar();
  await login(reviewer, 'user-code');
  response = await requestAs(reviewer, '/review', { headers: BROWSER });
  const reviewCsrf = csrfFrom(await response.text());
  response = await requestAs(reviewer, `/review/reports/${reportId}/resolve`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: reviewCsrf, status: 'resolved', resolution: 'gate check' }),
  });
  assert.equal(response.status, 303);
  const gated = notifications.listFor('4242')[0];
  assert.equal(gated.kind, 'report');
  assert.equal(gated.emailStatus, 'skipped', 'an unverified address receives no email');

  // Opening the single-use link verifies the address.
  response = await requestAs(jar, `/account/verify-email?token=${token}`, { headers: BROWSER });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/settings?verified=1');
  assert.equal(accounts.isEmailVerified('4242'), true);

  response = await requestAs(jar, '/account/settings', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /verified/);
  assert.match(html, /This address is verified/);

  // From now on the same event type queues email for the verified address.
  response = await requestAs(jar, '/packages/notify-report-pkg', { headers: BROWSER });
  const secondCsrf = csrfFrom(await response.text());
  response = await requestAs(jar, '/packages/notify-report-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf: secondCsrf, reason: 'other', note: 'verified address check' }),
  });
  assert.equal(response.status, 303);
  const secondId = new URL(response.headers.get('location'), baseUrl).searchParams.get('reported');
  response = await requestAs(reviewer, `/review/reports/${secondId}/resolve`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: reviewCsrf, status: 'resolved', resolution: 'verified check' }),
  });
  assert.equal(response.status, 303);
  const delivered = notifications.listFor('4242')[0];
  assert.equal(delivered.kind, 'report');
  assert.equal(delivered.emailStatus, 'pending', 'a verified address queues the email');
  assert.equal(delivered.email, 'admin@example.com');

  // Clear the address so later tests see the original state (and the gate
  // closes again).
  accounts.setNotifyEmail('4242', '');
  assert.equal(accounts.isEmailVerified('4242'), false);
});

test('signed-in accounts rate a package, one rating each', async () => {
  const jar = cookieJar();
  await login(jar, 'user-code');
  let response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /Rate package/);
  const csrf = csrfFrom(html);

  response = await requestAs(jar, '/packages/readme-pkg/rating', {
    method: 'POST',
    body: new URLSearchParams({ csrf, stars: '9', review: 'bad input' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /1 to 5/);

  response = await requestAs(jar, '/packages/readme-pkg/rating', {
    method: 'POST',
    body: new URLSearchParams({ csrf, stars: '5', review: 'clean and small' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/packages/readme-pkg?rated=1', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Rating saved/);
  assert.match(html, /clean and small/);
  assert.match(html, /Update rating/);

  // The same account updates rather than duplicates.
  response = await requestAs(jar, '/packages/readme-pkg/rating', {
    method: 'POST',
    body: new URLSearchParams({ csrf, stars: '3', review: 'revised' }),
  });
  assert.equal(response.status, 303);
  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'reviews.json'), 'utf-8'));
  assert.equal(Object.keys(data.ratings['readme-pkg']).length, 1);
  assert.equal(data.ratings['readme-pkg']['777'].stars, 3);
});

test('the internal fulfilment API is secret-gated and fulfils token requests', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');
  let response = await requestAs(jar, '/account');
  const csrf = csrfFrom(await response.text());
  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ csrf, kind: 'token', scopes: 'internal-demo' }),
  });
  const id = new URL(response.headers.get('location'), baseUrl).searchParams.get('created');
  response = await requestAs(jar, `/admin/requests/${id}/decision`, {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'approve' }),
  });
  assert.equal(response.status, 303);

  // Missing or wrong secret: refused. Correct secret: the approved queue.
  let internal = await fetch(`${baseUrl}/internal/requests`);
  assert.equal(internal.status, 403);
  internal = await fetch(`${baseUrl}/internal/requests?status=approved`, {
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(internal.status, 403);

  internal = await fetch(`${baseUrl}/internal/requests?status=approved`, {
    headers: { Authorization: 'Bearer test-fulfiller-secret' },
  });
  assert.equal(internal.status, 200);
  const listed = await internal.json();
  const entry = listed.requests.find((candidate) => candidate.id === id);
  assert.ok(entry, 'approved token request is visible to the worker');
  assert.deepEqual(entry.scopes, ['internal-demo']);
  assert.equal(entry.notifyEmail, '', 'no notification email on file yet');

  internal = await fetch(`${baseUrl}/internal/requests/${id}/fulfilled`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-fulfiller-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: 'mailed test@example.com' }),
  });
  assert.equal(internal.status, 200);

  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'requests.json'), 'utf-8'));
  assert.equal(data.requests[id].status, 'fulfilled');
  assert.equal(data.requests[id].fulfilledBy, 'fulfiller');
  assert.equal(data.requests[id].mintReference, 'mailed test@example.com');
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

test('account pages split into overview, requests, notifications, and settings', async () => {
  const jar = cookieJar();
  await login(jar, 'user-code');

  // Overview: identity, role, and a pointer to the request form.
  let response = await requestAs(jar, '/account', { headers: BROWSER });
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /aria-label="Account pages"/);
  assert.match(html, /href="\/account\/requests"/);
  assert.match(html, /href="\/account\/notifications"/);
  assert.match(html, /href="\/account\/settings"/);
  assert.match(html, /reviewer/, 'the role is visible');
  assert.match(html, /Last sign-in/);

  // Requests page: the form plus the history table.
  response = await requestAs(jar, '/account/requests', { headers: BROWSER });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /New request/);
  assert.match(html, /Publish token/);
  assert.match(html, /Trusted publisher/);
  assert.match(html, /href="\/publish"/);
  assert.match(html, /My requests/);

  // Submitting lands on the requests page with a confirmation.
  const csrf = csrfFrom(html);
  response = await requestAs(jar, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ csrf, kind: 'token', scopes: 'pages-demo' }),
  });
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location'), baseUrl);
  assert.equal(location.pathname, '/account/requests');
  const created = location.searchParams.get('created');
  assert.match(created, /^req_[0-9a-f]{12}$/);
  response = await requestAs(jar, `${location.pathname}${location.search}`, { headers: BROWSER });
  html = await response.text();
  assert.match(html, new RegExp(created));
  assert.match(html, /submitted for review/);

  // Notifications page: opening it does not mark anything read; the explicit
  // action does. Earlier tests may have left this account notices (report
  // resolutions now notify the reporter), so start from a clean unread slate.
  const { notifications } = app.locals.registry;
  notifications.markAllRead('777');
  notifications.enqueue({
    account: { githubId: '777', login: 'user-user' },
    kind: 'request',
    subject: 'Your request needs more detail',
    body: 'Please list the exact package names.',
  });
  response = await requestAs(jar, '/account/notifications', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Your request needs more detail/);
  assert.match(html, /Mark all as read/);
  assert.equal(
    notifications.listFor('777', { limit: 5 }).filter((entry) => !entry.readAt).length,
    1,
    'viewing the page does not mark notices read',
  );

  const noticeCsrf = csrfFrom(html);
  response = await requestAs(jar, '/account/notifications/read', {
    method: 'POST',
    body: new URLSearchParams({ csrf: noticeCsrf }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/notifications?read=1');
  assert.equal(notifications.listFor('777', { limit: 5 }).filter((entry) => !entry.readAt).length, 0);

  // Settings page: email form, account facts, sign-out.
  response = await requestAs(jar, '/account/settings', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Notification email/);
  assert.match(html, /action="\/logout"/);
  assert.match(html, /Signed in as|\@user-user/);
});

test('the admin console renders every section for admins and refuses members', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');

  const sections = [
    ['/admin', /Admin console/],
    ['/admin/requests', /Requests/],
    ['/admin/packages', /Moderate published packages/],
    ['/admin/reports', /Community reports/],
    ['/admin/users', /Roles and restrictions/],
    ['/admin/audit', /Every console action/],
  ];
  for (const [target, pattern] of sections) {
    const response = await requestAs(jar, target, { headers: BROWSER });
    assert.equal(response.status, 200, `${target} renders`);
    assert.match(await response.text(), pattern, `${target} shows its content`);
  }

  // D7: the dashboard surfaces the mailer state and outbox counts.
  const dashboard = await requestAs(jar, '/admin', { headers: BROWSER });
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /Notification email/);
  assert.match(dashboardHtml, /Mail service disabled on this host/);
  assert.match(dashboardHtml, /sent \d+/);

  const member = cookieJar();
  await login(member, 'user-code');
  const refused = await requestAs(member, '/admin', { headers: BROWSER });
  assert.equal(refused.status, 403);

  const anonymous = cookieJar();
  const redirected = await requestAs(anonymous, '/admin/packages', { headers: BROWSER });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), '/login?returnTo=%2Fadmin%2Fpackages');
});

test('package moderation flags, mutes, hides from discovery, and stays audited', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');
  let response = await requestAs(jar, '/admin/packages', { headers: BROWSER });
  let html = await response.text();
  const csrf = csrfFrom(html);
  assert.match(html, /readme-pkg/);

  // A mute requires a reason.
  response = await requestAs(jar, '/admin/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'mute' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/admin/packages?updated=readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /reason is required when muting/);

  // Mute for real: the listing hides it, the page still resolves, and the raw
  // index is untouched.
  response = await requestAs(jar, '/admin/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'mute', note: 'metadata spam' }),
  });
  assert.equal(response.status, 303);
  const listing = await requestAs(jar, '/packages', { headers: BROWSER });
  assert.doesNotMatch(await listing.text(), /readme-pkg/);
  const listingJson = await requestAs(jar, '/packages', { headers: { Accept: 'application/json' } });
  assert.doesNotMatch(JSON.stringify(await listingJson.json()), /readme-pkg/);
  const page = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hidden from listings and search/);
  const rawIndex = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'index.json'), 'utf-8'));
  assert.ok(rawIndex.packages['readme-pkg'], '/index.json keeps the muted package');

  const audits = app.locals.registry.admin.recentAudit(10);
  assert.equal(audits[0].action, 'package.mute');
  assert.equal(audits[0].subject_id, 'readme-pkg');
  assert.equal(audits[0].detail, 'metadata spam');

  // Muted packages disappear from every discovery surface, not just the
  // listing: search (HTML and JSON) and the home strip too, while the raw
  // index keeps them (this is the owner's "muted = cannot search it?" check).
  // The page echoes the query itself, so assert on the result links/JSON rows.
  const search = await requestAs(jar, '/search?q=readme-pkg', { headers: BROWSER });
  assert.doesNotMatch(await search.text(), /href="\/packages\/readme-pkg"/);
  const searchJson = await requestAs(jar, '/search?q=readme-pkg', { headers: { Accept: 'application/json' } });
  assert.deepEqual((await searchJson.json()).results, []);
  const home = await requestAs(jar, '/', { headers: BROWSER });
  assert.doesNotMatch(await home.text(), /readme-pkg/);

  // Flag on top of the mute: both properties are independent, so both pills
  // show and the muted tag stays next to the flagged art.
  response = await requestAs(jar, '/admin/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'flag', note: 'unsafe install script' }),
  });
  assert.equal(response.status, 303);
  const flaggedPage = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  const flaggedHtml = await flaggedPage.text();
  assert.match(flaggedHtml, /flagged by a reviewer/);
  assert.match(flaggedHtml, /muted by the maintainers/);
  assert.match(flaggedHtml, /src="\/ui\/pgk_flagged_community\.webp"/);
  assert.match(flaggedHtml, /pkg-badge-group--muted/);
  assert.equal(app.locals.registry.admin.recentAudit(5)[0].action, 'package.flag');

  // Unflag removes only the flag; the mute (and its discovery masking) stays.
  response = await requestAs(jar, '/admin/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'unflag', note: 'appeal accepted' }),
  });
  assert.equal(response.status, 303);
  assert.equal(app.locals.registry.admin.recentAudit(5)[0].action, 'package.unflag');
  assert.equal(app.locals.registry.reviews.decision('readme-pkg').flagged, false);
  assert.equal(app.locals.registry.reviews.decision('readme-pkg').muted, true);
  const restoredPage = await requestAs(jar, '/packages/readme-pkg', { headers: BROWSER });
  const restoredHtml = await restoredPage.text();
  assert.doesNotMatch(restoredHtml, /flagged by a reviewer/);
  assert.match(restoredHtml, /Hidden from listings and search/);

  // Unmute returns the package to discovery.
  response = await requestAs(jar, '/admin/packages/readme-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'unmute' }),
  });
  assert.equal(response.status, 303);
  const clean = app.locals.registry.reviews.decision('readme-pkg');
  assert.equal(clean.muted, false);
  assert.equal(clean.flagged, false);
  const cleanListing = await requestAs(jar, '/packages', { headers: BROWSER });
  assert.match(await cleanListing.text(), /readme-pkg/);
});

test('admins yank a version from the console and the decision is recorded', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');
  let response = await requestAs(jar, '/admin/packages', { headers: BROWSER });
  const csrf = csrfFrom(await response.text());

  response = await requestAs(jar, '/admin/packages/readme-pkg/yank', {
    method: 'POST',
    body: new URLSearchParams({ csrf, version: '1.0.0' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(jar, '/admin/packages?updated=readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /reason is required when yanking/);

  response = await requestAs(jar, '/admin/packages/readme-pkg/yank', {
    method: 'POST',
    body: new URLSearchParams({ csrf, version: '1.0.0', reason: 'leaked credentials' }),
  });
  assert.equal(response.status, 303);
  const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'index.json'), 'utf-8'));
  assert.equal(data.packages['readme-pkg'].versions['1.0.0'].yanked, true);
  assert.equal(data.packages['readme-pkg'].versions['1.0.0'].yankReason, 'leaked credentials');
  const audits = app.locals.registry.admin.recentAudit(5);
  assert.equal(audits[0].action, 'package.yank');
  assert.match(audits[0].detail, /leaked credentials/);
});

test('role grants apply to open sessions; demotion and self-demotion are guarded', async () => {
  const member = cookieJar();
  await login(member, 'plain-code');
  let response = await requestAs(member, '/review', { headers: BROWSER });
  assert.equal(response.status, 403, 'a member cannot review');

  const adminJar = cookieJar();
  await login(adminJar, 'admin-code');
  response = await requestAs(adminJar, '/admin/users', { headers: BROWSER });
  const csrf = csrfFrom(await response.text());
  response = await requestAs(adminJar, '/admin/users/888/role', {
    method: 'POST',
    body: new URLSearchParams({ csrf, role: 'reviewer' }),
  });
  assert.equal(response.status, 303);

  // The existing member session sees the new role on its next request.
  response = await requestAs(member, '/review', { headers: BROWSER });
  assert.equal(response.status, 200);

  // Demote again: the queue closes on the next request.
  response = await requestAs(adminJar, '/admin/users/888/role', {
    method: 'POST',
    body: new URLSearchParams({ csrf, role: '' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(member, '/review', { headers: BROWSER });
  assert.equal(response.status, 403);

  // Self-demotion is refused with a clear message. (The config admin is
  // protected even earlier; use a stored admin for the store-level guard.)
  response = await requestAs(adminJar, '/admin/users/888/role', {
    method: 'POST',
    body: new URLSearchParams({ csrf, role: 'admin' }),
  });
  assert.equal(response.status, 303);
  const plainAdmin = cookieJar();
  await login(plainAdmin, 'plain-code');
  response = await requestAs(plainAdmin, '/admin', { headers: BROWSER });
  assert.equal(response.status, 200, 'a stored admin reaches the console');
  response = await requestAs(plainAdmin, '/admin/users/888', { headers: BROWSER });
  const plainCsrf = csrfFrom(await response.text());
  response = await requestAs(plainAdmin, '/admin/users/888/role', {
    method: 'POST',
    body: new URLSearchParams({ csrf: plainCsrf, role: '' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(plainAdmin, '/admin/users/888', { headers: BROWSER });
  assert.match(await response.text(), /cannot demote yourself/);

  // Config admins cannot be demoted from the console at all.
  response = await requestAs(adminJar, '/admin/users/4242/role', {
    method: 'POST',
    body: new URLSearchParams({ csrf, role: '' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(adminJar, '/admin/users/4242', { headers: BROWSER });
  assert.match(await response.text(), /deployment config/);

  // Clean up the stored grant; the table is empty again.
  response = await requestAs(adminJar, '/admin/users/888/role', {
    method: 'POST',
    body: new URLSearchParams({ csrf, role: '' }),
  });
  assert.equal(response.status, 303);
  assert.equal(app.locals.registry.admin.roleOf('888'), '');
  assert.equal(app.locals.registry.admin.listRoles().length, 0);
});

test('suspension is read-only and a ban closes sessions and sign-in', async () => {
  const member = cookieJar();
  await login(member, 'plain-code');
  const adminJar = cookieJar();
  await login(adminJar, 'admin-code');

  let response = await requestAs(member, '/account', { headers: BROWSER });
  let html = await response.text();
  const memberCsrf = csrfFrom(html);
  response = await requestAs(adminJar, '/admin/users/888', { headers: BROWSER });
  const adminCsrf = csrfFrom(await response.text());

  // Suspend: browsing continues, writes are refused with a typed error.
  response = await requestAs(adminJar, '/admin/users/888/status', {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, status: 'suspended', reason: 'spam requests' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(member, '/account', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /account is suspended/);
  response = await requestAs(member, '/requests', {
    method: 'POST',
    body: new URLSearchParams({ csrf: memberCsrf, kind: 'token', scopes: 'nope' }),
  });
  assert.equal(response.status, 403);
  response = await requestAs(member, '/account/notifications', { headers: BROWSER });
  assert.equal(response.status, 200, 'reading stays available');

  // Ban: the next request drops the session and sign-in is refused.
  response = await requestAs(adminJar, '/admin/users/888/status', {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, status: 'banned', reason: 'abuse' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(member, '/account', { headers: BROWSER });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login\?returnTo=/);
  response = await login(member, 'plain-code');
  assert.equal(response.headers.get('location'), '/login?error=banned');
  response = await requestAs(member, '/login?error=banned', { headers: BROWSER });
  assert.match(await response.text(), /banned from the registry/);

  // Restore: sign-in works again and the states table is clean.
  response = await requestAs(adminJar, '/admin/users/888/status', {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, status: 'active' }),
  });
  assert.equal(response.status, 303);
  response = await login(member, 'plain-code');
  assert.equal(response.headers.get('location'), '/account');
  assert.equal(app.locals.registry.admin.statusOf('888'), 'active');

  // Config admins are protected from status changes.
  response = await requestAs(adminJar, '/admin/users/4242/status', {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, status: 'suspended', reason: 'test' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(adminJar, '/admin/users/4242', { headers: BROWSER });
  assert.match(await response.text(), /deployment config/);
  assert.equal(app.locals.registry.admin.statusOf('4242'), 'active');
});

test('the admin audit feed records role and status changes newest first', async () => {
  const jar = cookieJar();
  await login(jar, 'admin-code');
  const response = await requestAs(jar, '/admin/audit', { headers: BROWSER });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /user\.suspended|user\.restore|role\.grant|role\.revoke/);
  const entries = app.locals.registry.admin.recentAudit(200);
  const actions = entries.map((entry) => entry.action);
  assert.ok(actions.includes('role.grant'));
  assert.ok(actions.includes('role.revoke'));
  assert.ok(actions.includes('user.suspended'));
  assert.ok(actions.includes('user.banned'));
  assert.ok(actions.includes('user.restore'));
});

test('maintainer claims are filed, verified by reviewers, and shown publicly', async () => {
  // A member claims a package: the section renders, the claim is queued, and
  // the claimant sees its state without it becoming public yet.
  const plain = cookieJar();
  await login(plain, 'plain-code');
  let response = await requestAs(plain, '/packages/readme-pkg', { headers: BROWSER });
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /<section class="maintainers" id="maintainers">/);
  assert.match(html, /I maintain this package/);
  const csrf = csrfFrom(html);

  response = await requestAs(plain, '/packages/readme-pkg/claim', {
    method: 'POST',
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^\/packages\/readme-pkg\?claimed=1#maintainers$/);
  response = await requestAs(plain, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /awaiting verification/);
  assert.doesNotMatch(html, /verified maintainer/, 'pending claims are not public');

  // The reverse view: the claimant sees the package on the account overview.
  response = await requestAs(plain, '/account', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Packages you maintain/);
  assert.match(html, /href="\/packages\/readme-pkg"/);
  assert.match(html, /claim awaiting verification/);

  // Duplicate claims are refused with a readable error.
  response = await requestAs(plain, '/packages/readme-pkg/claim', {
    method: 'POST',
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(plain, '/packages/readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /already have a maintainer claim/);

  // Signed-out browsers cannot claim at all.
  const anonymous = cookieJar();
  response = await requestAs(anonymous, '/packages/readme-pkg/claim', {
    method: 'POST',
    body: new URLSearchParams({}),
  });
  assert.equal(response.status, 401);

  // The reviewer sees the claim in the queue, must give a reason to reject,
  // and verifies. The admin console surfaces the same queue on /admin/claims
  // and the decision returns there when the form asks for it.
  const reviewer = cookieJar();
  await login(reviewer, 'user-code');
  response = await requestAs(reviewer, '/review', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Ownership claims/);
  assert.match(html, /@plain-user/);
  const reviewCsrf = csrfFrom(html);

  const admin = cookieJar();
  await login(admin, 'admin-code');
  response = await requestAs(admin, '/admin/claims', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Awaiting verification/);
  assert.match(html, /readme-pkg/);
  assert.match(html, /@plain-user/);
  const adminCsrf = csrfFrom(html);

  response = await requestAs(admin, '/review/claims/readme-pkg/888/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, status: 'rejected' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(admin, '/admin/claims', { headers: BROWSER });
  assert.match(await response.text(), /reason is required/);

  response = await requestAs(admin, '/review/claims/readme-pkg/888/decision', {
    method: 'POST',
    body: new URLSearchParams({
      csrf: adminCsrf, status: 'verified', note: 'owns the repo', next: '/admin/claims',
    }),
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^\/admin\/claims\?claim=888$/);
  response = await requestAs(admin, '/admin/claims', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /No claims are waiting/, 'the pending queue is empty after the decision');
  assert.match(html, /Recent decisions/);
  assert.match(html, /readme-pkg/);
  assert.match(html, /status-approved">verified/);

  // The verified maintainer is public and attributed to the decision.
  response = await requestAs(anonymous, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /@plain-user/);
  assert.match(html, /verified maintainer/);
  assert.match(html, /verified by @admin-user/);

  // The claimant sees that the claim is settled.
  response = await requestAs(plain, '/packages/readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /You are listed as a verified maintainer/);
  response = await requestAs(plain, '/account', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Packages you maintain/);
  assert.doesNotMatch(html, /claim awaiting verification/, 'the settled claim drops the pending pill');

  const claims = app.locals.registry.ownership.listClaims({ packageName: 'readme-pkg' });
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].history.map((entry) => entry.action), ['claimed', 'verified']);
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
    try {
      disabled.locals.registry.db.close();
    } catch {
      // best effort; the sandbox close in after() covers the rest
    }
    disabledServer.close();
  }
});

// ─── A2 notification coverage (SESSION.md 22.4) ────────────────────────────
// One focused test per event: a row is created for the right recipient with
// the right link. Notification failures never fail the action, so a wrong
// recipient shows up as a missing row, not a 500.

test('a verified maintainer claim notifies the claimant with a maintainers link', async () => {
  const claimant = cookieJar();
  await login(claimant, 'plain-code');
  let response = await requestAs(claimant, '/packages/notify-claim-pkg', { headers: BROWSER });
  const claimCsrf = csrfFrom(await response.text());
  response = await requestAs(claimant, '/packages/notify-claim-pkg/claim', {
    method: 'POST',
    body: new URLSearchParams({ csrf: claimCsrf }),
  });
  assert.equal(response.status, 303);

  const reviewer = cookieJar();
  await login(reviewer, 'user-code');
  response = await requestAs(reviewer, '/review', { headers: BROWSER });
  const reviewCsrf = csrfFrom(await response.text());
  response = await requestAs(reviewer, '/review/claims/notify-claim-pkg/888/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf: reviewCsrf, status: 'verified', note: 'owns the repo' }),
  });
  assert.equal(response.status, 303);

  const { notifications } = app.locals.registry;
  const row = notifications.listFor('888')[0];
  assert.equal(row.kind, 'claim');
  assert.match(row.subject, /claim verified/i);
  assert.equal(row.link, '/packages/notify-claim-pkg#maintainers');
  assert.equal(row.emailStatus, 'skipped', 'no notification email is set');

  // The notifications page renders the link as an anchor.
  response = await requestAs(claimant, '/account/notifications', { headers: BROWSER });
  const html = await response.text();
  assert.match(html, /Maintainer claim verified/);
  assert.match(html, /href="\/packages\/notify-claim-pkg#maintainers"/);
});

test('a rejected maintainer claim notifies the claimant with the reason', async () => {
  const claimant = cookieJar();
  await login(claimant, 'admin-code');
  let response = await requestAs(claimant, '/packages/notify-claim-pkg', { headers: BROWSER });
  const claimCsrf = csrfFrom(await response.text());
  response = await requestAs(claimant, '/packages/notify-claim-pkg/claim', {
    method: 'POST',
    body: new URLSearchParams({ csrf: claimCsrf }),
  });
  assert.equal(response.status, 303);

  const reviewer = cookieJar();
  await login(reviewer, 'user-code');
  response = await requestAs(reviewer, '/review', { headers: BROWSER });
  const reviewCsrf = csrfFrom(await response.text());
  response = await requestAs(reviewer, '/review/claims/notify-claim-pkg/4242/decision', {
    method: 'POST',
    body: new URLSearchParams({
      csrf: reviewCsrf,
      status: 'rejected',
      note: 'repository owner is someone else',
    }),
  });
  assert.equal(response.status, 303);

  const row = app.locals.registry.notifications.listFor('4242')[0];
  assert.equal(row.kind, 'claim');
  assert.match(row.subject, /claim rejected/i);
  assert.equal(
    row.body,
    'Your maintainer claim for notify-claim-pkg was rejected. Reason: repository owner is someone else',
  );
  assert.equal(row.link, '/packages/notify-claim-pkg#maintainers');
});

test('a resolved report notifies the reporter with a package link', async () => {
  const reporter = cookieJar();
  await login(reporter, 'plain-code');
  let response = await requestAs(reporter, '/packages/notify-report-pkg', { headers: BROWSER });
  const csrf = csrfFrom(await response.text());
  response = await requestAs(reporter, '/packages/notify-report-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf, reason: 'license', note: 'missing LICENSE file' }),
  });
  assert.equal(response.status, 303);
  const reportId = new URL(response.headers.get('location'), baseUrl).searchParams.get('reported');

  const reviewer = cookieJar();
  await login(reviewer, 'user-code');
  response = await requestAs(reviewer, '/review', { headers: BROWSER });
  const reviewCsrf = csrfFrom(await response.text());
  response = await requestAs(reviewer, `/review/reports/${reportId}/resolve`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: reviewCsrf, status: 'resolved', resolution: 'license added in 1.0.1' }),
  });
  assert.equal(response.status, 303);

  const row = app.locals.registry.notifications.listFor('888')[0];
  assert.equal(row.kind, 'report');
  assert.match(row.subject, /report was resolved/i);
  assert.equal(row.body, 'Your report on notify-report-pkg was resolved: license added in 1.0.1');
  assert.equal(row.link, '/packages/notify-report-pkg');
});

test('a dismissed report notifies the reporter through the admin console route', async () => {
  const reporter = cookieJar();
  await login(reporter, 'plain-code');
  let response = await requestAs(reporter, '/packages/notify-report-pkg', { headers: BROWSER });
  const csrf = csrfFrom(await response.text());
  response = await requestAs(reporter, '/packages/notify-report-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf, reason: 'other', note: 'wrong package page links' }),
  });
  assert.equal(response.status, 303);
  const reportId = new URL(response.headers.get('location'), baseUrl).searchParams.get('reported');

  const admin = cookieJar();
  await login(admin, 'admin-code');
  response = await requestAs(admin, '/admin/reports', { headers: BROWSER });
  const adminCsrf = csrfFrom(await response.text());
  response = await requestAs(admin, `/admin/reports/${reportId}/resolve`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, status: 'dismissed', resolution: 'not actionable' }),
  });
  assert.equal(response.status, 303);

  const row = app.locals.registry.notifications.listFor('888')[0];
  assert.equal(row.kind, 'report');
  assert.match(row.subject, /report was dismissed/i);
  assert.equal(row.body, 'Your report on notify-report-pkg was dismissed: not actionable');
  assert.equal(row.link, '/packages/notify-report-pkg');
});

test('package decisions reach maintainers with accounts and skip the rest', async () => {
  const { notifications, accounts } = app.locals.registry;
  assert.equal(accounts.getByLogin('ghost-org'), null, 'fixture maintainer has no registry account');
  const before = notifications.listFor('777', { limit: 200 }).length;

  const admin = cookieJar();
  await login(admin, 'admin-code');
  let response = await requestAs(admin, '/admin/packages', { headers: BROWSER });
  const csrf = csrfFrom(await response.text());
  response = await requestAs(admin, '/admin/packages/notify-decision-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf, action: 'mute', note: 'metadata spam' }),
  });
  assert.equal(response.status, 303);

  const rows = notifications.listFor('777', { limit: 200 });
  assert.equal(rows.length, before + 1, 'exactly the account-holding maintainer got a row');
  assert.equal(rows[0].kind, 'review');
  assert.equal(rows[0].subject, 'Package muted: notify-decision-pkg');
  assert.equal(rows[0].body, 'metadata spam');
  assert.equal(rows[0].link, '/packages/notify-decision-pkg');
});

test('per-kind muting suppresses that kind only and defaults to on', async () => {
  const member = cookieJar();
  await login(member, 'user-code');
  let response = await requestAs(member, '/account/settings', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /name="claim" checked/);
  assert.match(html, /name="review" checked/);
  assert.match(html, /name="support" checked/);
  assert.match(html, /name="review-reply" checked/);
  const csrf = csrfFrom(html);

  // Turn review notices off; claim, report, and support stay on.
  response = await requestAs(member, '/account/notify-kinds', {
    method: 'POST',
    body: new URLSearchParams({ csrf, claim: 'on', report: 'on', support: 'on', 'review-reply': 'on' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/settings?prefs=1');

  const stored = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'accounts.json'), 'utf-8'));
  assert.deepEqual(
    stored.accounts['777'].notifyKinds,
    { claim: true, report: true, review: false, support: true, 'review-reply': true },
  );

  response = await requestAs(member, '/account/settings', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Notification types/);
  assert.match(html, /name="claim" checked/);
  assert.doesNotMatch(html, /name="review" checked/);

  // A package decision writes nothing for the muted account...
  const { notifications } = app.locals.registry;
  const before = notifications.listFor('777', { limit: 200 }).length;
  const admin = cookieJar();
  await login(admin, 'admin-code');
  response = await requestAs(admin, '/admin/packages', { headers: BROWSER });
  const adminCsrf = csrfFrom(await response.text());
  response = await requestAs(admin, '/admin/packages/notify-decision-pkg/decision', {
    method: 'POST',
    body: new URLSearchParams({ csrf: adminCsrf, action: 'unmute', note: 'appeal accepted' }),
  });
  assert.equal(response.status, 303);
  assert.equal(
    notifications.listFor('777', { limit: 200 }).length,
    before,
    'the muted review kind wrote no row',
  );

  // ...while the report kind is untouched: a resolution still notifies.
  response = await requestAs(member, '/packages/notify-report-pkg', { headers: BROWSER });
  const memberCsrf = csrfFrom(await response.text());
  response = await requestAs(member, '/packages/notify-report-pkg/report', {
    method: 'POST',
    body: new URLSearchParams({ csrf: memberCsrf, reason: 'spam', note: 'repeated posting' }),
  });
  assert.equal(response.status, 303);
  const reportId = new URL(response.headers.get('location'), baseUrl).searchParams.get('reported');
  response = await requestAs(admin, '/admin/reports', { headers: BROWSER });
  const reportCsrf = csrfFrom(await response.text());
  response = await requestAs(admin, `/admin/reports/${reportId}/resolve`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: reportCsrf, status: 'resolved', resolution: 'handled' }),
  });
  assert.equal(response.status, 303);
  assert.equal(notifications.listFor('777')[0].kind, 'report');

  // Restore all kinds on so the preference does not leak past this test.
  response = await requestAs(member, '/account/settings', { headers: BROWSER });
  const restoreCsrf = csrfFrom(await response.text());
  response = await requestAs(member, '/account/notify-kinds', {
    method: 'POST',
    body: new URLSearchParams({ csrf: restoreCsrf, claim: 'on', report: 'on', review: 'on', support: 'on', 'review-reply': 'on' }),
  });
  assert.equal(response.status, 303);
  const restored = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'accounts.json'), 'utf-8'));
  assert.deepEqual(
    restored.accounts['777'].notifyKinds,
    { claim: true, report: true, review: true, support: true, 'review-reply': true },
  );
});

// --- A7 community -> maintainer contact (SESSION.md 21.9.2) ----------------
// One flow: a member messages the maintainers, limits and mutes hold, and a
// maintainer can flag the message to the moderators.

test('community members message maintainers, with limits, mutes, and abuse reporting', async () => {
  const { notifications, reviews, support } = app.locals.registry;
  const before = notifications.listFor('777', { limit: 200 }).length;

  const member = cookieJar();
  await login(member, 'plain-code');
  let response = await requestAs(member, '/packages/notify-decision-pkg', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /Contact maintainers/);
  // A8: provenance offers the repository and the issue-tracker escape hatch.
  assert.match(html, /href="https:\/\/github.com\/user-user\/notify-decision-pkg"/);
  assert.match(html, /href="https:\/\/github.com\/user-user\/notify-decision-pkg\/issues\/new"/);
  const plain = await requestAs(member, '/packages/readme-pkg', { headers: BROWSER });
  assert.doesNotMatch(await plain.text(), /issues\/new/, 'no provenance means no issue link');
  const csrf = csrfFrom(html);
  response = await requestAs(member, '/packages/notify-decision-pkg/contact', {
    method: 'POST',
    body: new URLSearchParams({ csrf, reason: 'bug', message: 'The install step fails behind a proxy.' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/packages/notify-decision-pkg?contacted=1#contact');

  const stored = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'support.json'), 'utf-8'));
  const message = Object.values(stored.messages)[0];
  assert.equal(message.package, 'notify-decision-pkg');
  assert.equal(message.requester.login, 'plain-user');
  assert.equal(message.reason, 'bug');

  // Only the maintainer with an account is notified; the row references the
  // message so abuse handling can find it.
  const rows = notifications.listFor('777', { limit: 200 });
  assert.equal(rows.length, before + 1, 'the account-holding maintainer got one row');
  const row = rows[0];
  assert.equal(row.kind, 'support');
  assert.equal(row.subject, 'Support request: notify-decision-pkg');
  assert.equal(row.body, 'Bug report: The install step fails behind a proxy.');
  assert.equal(row.link, '/packages/notify-decision-pkg#contact');
  assert.equal(row.ref, message.id);

  // One message per package per sender per day.
  response = await requestAs(member, '/packages/notify-decision-pkg/contact', {
    method: 'POST',
    body: new URLSearchParams({ csrf, reason: 'question', message: 'One more question about it.' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/packages/notify-decision-pkg?contact_error=support_rate_package#contact');
  assert.equal(Object.keys(support.list()).length, 1, 'the rate limit wrote nothing');
  response = await requestAs(member, '/packages/notify-decision-pkg?contact_error=support_rate_package', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /wait for their reply/);

  // The maintainer reads the notice and flags it to the moderators.
  const maintainer = cookieJar();
  await login(maintainer, 'user-code');
  response = await requestAs(maintainer, '/account/notifications', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /maintainer message/);
  assert.match(html, /Report abuse/);
  const notifyCsrf = csrfFrom(html);
  response = await requestAs(maintainer, `/account/notifications/${row.id}/abuse`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: notifyCsrf }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/notifications?abuse=1');
  assert.equal(support.get(message.id).abuseReportedBy, 'user-user');
  const spamReports = () => reviews.listReports({ status: 'open' })
    .filter((report) => report.reason === 'spam' && report.package === 'notify-decision-pkg');
  assert.equal(spamReports().length, 1, 'the first flag files one report');

  // Flagging again is idempotent, and a foreign account cannot flag the row.
  response = await requestAs(maintainer, `/account/notifications/${row.id}/abuse`, {
    method: 'POST',
    body: new URLSearchParams({ csrf: notifyCsrf }),
  });
  assert.equal(response.status, 303);
  assert.equal(spamReports().length, 1, 'the second flag files nothing');
  response = await requestAs(member, `/account/notifications/${row.id}/abuse`, {
    method: 'POST',
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(response.status, 303);
  assert.equal(spamReports().length, 1, 'a foreign row cannot be flagged');

  // Muting the support kind stops the in-app notice for new messages.
  response = await requestAs(maintainer, '/account/settings', { headers: BROWSER });
  const settingsCsrf = csrfFrom(await response.text());
  response = await requestAs(maintainer, '/account/notify-kinds', {
    method: 'POST',
    body: new URLSearchParams({ csrf: settingsCsrf, claim: 'on', report: 'on', review: 'on', 'review-reply': 'on' }),
  });
  assert.equal(response.status, 303);

  const sender = cookieJar();
  await login(sender, 'admin-code');
  response = await requestAs(sender, '/packages/notify-decision-pkg', { headers: BROWSER });
  const senderCsrf = csrfFrom(await response.text());
  response = await requestAs(sender, '/packages/notify-decision-pkg/contact', {
    method: 'POST',
    body: new URLSearchParams({ csrf: senderCsrf, reason: 'question', message: 'Is there a roadmap for this?' }),
  });
  assert.equal(response.status, 303);
  assert.equal(
    notifications.listFor('777', { limit: 200 }).length,
    before + 1,
    'the muted support kind wrote no row',
  );

  // Restore all kinds on for later tests.
  response = await requestAs(maintainer, '/account/settings', { headers: BROWSER });
  const restoreCsrf = csrfFrom(await response.text());
  response = await requestAs(maintainer, '/account/notify-kinds', {
    method: 'POST',
    body: new URLSearchParams({ csrf: restoreCsrf, claim: 'on', report: 'on', review: 'on', support: 'on', 'review-reply': 'on' }),
  });
  assert.equal(response.status, 303);
});
// --- A9 review votes, maintainer reply, list UX (SESSION.md 21.9.3) -------

test('reviews gain votes, a maintainer reply, and list controls', async () => {
  const { notifications, reviews } = app.locals.registry;

  // 888 votes up the review 777 left on readme-pkg in the rating test.
  const voter = cookieJar();
  await login(voter, 'plain-code'); // 888
  let response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /Most helpful/);
  assert.match(html, /With text/);
  const csrf = csrfFrom(html);

  response = await requestAs(voter, '/packages/readme-pkg/reviews/777/vote', {
    method: 'POST',
    body: new URLSearchParams({ csrf, value: 'up' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/packages/readme-pkg?voted=1#reviews');
  response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /aria-pressed="true"/, 'the active vote is marked');
  assert.match(html, /&#9650; 1/);

  // Casting the same value again removes the vote (toggle).
  response = await requestAs(voter, '/packages/readme-pkg/reviews/777/vote', {
    method: 'POST',
    body: new URLSearchParams({ csrf, value: 'up' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /&#9650; 0/);

  // A review of one's own cannot be voted on: 888 rates, then self-votes.
  response = await requestAs(voter, '/packages/readme-pkg/rating', {
    method: 'POST',
    body: new URLSearchParams({ csrf, stars: '4', review: '' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(voter, '/packages/readme-pkg/reviews/888/vote', {
    method: 'POST',
    body: new URLSearchParams({ csrf, value: 'up' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /cannot vote on your own review/);

  // 888 maintains readme-pkg (verified claim), so 888 can reply to 777.
  response = await requestAs(voter, '/packages/readme-pkg/reviews/777/reply', {
    method: 'POST',
    body: new URLSearchParams({ csrf, message: 'Thanks, fixed in 1.0.1.' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/packages/readme-pkg?replied=1#reviews');
  response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /status-approved">maintainer/);
  assert.match(html, /Thanks, fixed in 1.0.1\./);

  const notice = notifications.listFor('777')[0];
  assert.equal(notice.kind, 'review-reply');
  assert.equal(notice.subject, 'Maintainer replied to your review of readme-pkg');
  assert.equal(notice.body, 'Thanks, fixed in 1.0.1.');
  assert.equal(notice.link, '/packages/readme-pkg#reviews');

  // Editing updates the same reply instead of adding another.
  response = await requestAs(voter, '/packages/readme-pkg/reviews/777/reply', {
    method: 'POST',
    body: new URLSearchParams({ csrf, message: 'Thanks, fixed in 1.0.2.' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /fixed in 1\.0\.2/);
  assert.match(html, /edited/);
  assert.equal((html.match(/class="review-reply"/g) || []).length, 1);

  // A non-maintainer cannot reply: 777 is a reviewer, not a maintainer here.
  const outsider = cookieJar();
  await login(outsider, 'user-code'); // 777
  response = await requestAs(outsider, '/packages/readme-pkg', { headers: BROWSER });
  const outsiderCsrf = csrfFrom(await response.text());
  response = await requestAs(outsider, '/packages/readme-pkg/reviews/888/reply', {
    method: 'POST',
    body: new URLSearchParams({ csrf: outsiderCsrf, message: 'Me too.' }),
  });
  assert.equal(response.status, 303);
  response = await requestAs(outsider, '/packages/readme-pkg', { headers: BROWSER });
  assert.match(await response.text(), /only the package maintainers can reply/);

  // Filters and pagination: 11 extra textless ratings make 13 rows over 2 pages.
  for (let i = 0; i < 11; i++) {
    reviews.rate('readme-pkg', { user: { githubId: String(200 + i), login: `ext${i}` }, stars: 3 });
  }
  response = await requestAs(voter, '/packages/readme-pkg', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /13 reviews/);
  response = await requestAs(voter, '/packages/readme-pkg?reviews_page=2', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /Page 2 of 2/);
  assert.equal((html.match(/class="rating-item"/g) || []).length, 3);

  response = await requestAs(voter, '/packages/readme-pkg?reviews_filter=text', { headers: BROWSER });
  html = await response.text();
  assert.match(html, /1 review</, 'only the text review counts in the filter');
  assert.equal((html.match(/class="rating-item"/g) || []).length, 1,
    'only 777 wrote review text on this package');
});
test('the admin console is an account tab and the header carries an account menu', async () => {
  const admin = cookieJar();
  await login(admin, 'admin-code');
  let response = await requestAs(admin, '/account/settings', { headers: BROWSER });
  let html = await response.text();
  assert.match(html, /account-tab[^"]*" href="\/admin"/, 'admins get the Admin tab');
  assert.match(html, /class="nav-account"/, 'the header renders the account menu');
  assert.match(html, /action="\/logout"/, 'the menu can sign out');
  assert.match(html, /Admin console/);

  const member = cookieJar();
  await login(member, 'plain-code');
  response = await requestAs(member, '/account/settings', { headers: BROWSER });
  html = await response.text();
  assert.doesNotMatch(html, /account-tab[^"]*" href="\/admin"/, 'members get no Admin tab');
  assert.match(html, /action="\/logout"/);
});