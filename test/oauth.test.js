// XIOM Package Registry -- GitHub OAuth and session tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const oauth = require('../src/oauth');
const { SessionStore, parseCookies, serializeCookie } = require('../src/sessions');

const OAUTH = {
  clientId: 'client-id',
  clientSecret: 'client-secret-0123456789abcdef',
  scope: 'read:user',
  authorizeUrl: 'https://github.example/login/oauth/authorize',
  tokenUrl: 'https://github.example/login/oauth/access_token',
  apiUrl: 'https://api.github.example',
};

function fakeResponse({ status = 200, body = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test('authorizeUrl carries client id, scope, state, and callback', () => {
  const url = new URL(oauth.authorizeUrl(OAUTH, {
    redirectUri: 'https://registry.example/auth/github/callback',
    state: 'state-123',
  }));
  assert.equal(url.origin + url.pathname, 'https://github.example/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('scope'), 'read:user');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://registry.example/auth/github/callback');
});

test('randomState is unique and URL-safe', () => {
  const a = oauth.randomState();
  const b = oauth.randomState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{20,}$/);
});

test('exchangeCode posts the code and returns the access token', async () => {
  let seen;
  const token = await oauth.exchangeCode(OAUTH, {
    code: 'the-code',
    redirectUri: 'https://registry.example/auth/github/callback',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return fakeResponse({ body: JSON.stringify({ access_token: 'tok_123' }) });
    },
  });
  assert.equal(token, 'tok_123');
  assert.equal(seen.url, 'https://github.example/login/oauth/access_token');
  assert.equal(seen.options.method, 'POST');
  const form = new URLSearchParams(seen.options.body);
  assert.equal(form.get('client_id'), 'client-id');
  assert.equal(form.get('client_secret'), OAUTH.clientSecret);
  assert.equal(form.get('code'), 'the-code');
});

test('exchangeCode maps GitHub error bodies and network failures', async () => {
  await assert.rejects(
    oauth.exchangeCode(OAUTH, {
      code: 'stale',
      redirectUri: 'https://registry.example/auth/github/callback',
      fetchImpl: async () => fakeResponse({
        body: JSON.stringify({ error: 'bad_verification_code', error_description: 'incorrect or expired' }),
      }),
    }),
    (err) => err instanceof oauth.OAuthError && err.code === 'oauth_denied',
  );
  await assert.rejects(
    oauth.exchangeCode(OAUTH, {
      code: 'x',
      redirectUri: 'https://registry.example/auth/github/callback',
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    }),
    (err) => err instanceof oauth.OAuthError && err.code === 'oauth_unreachable',
  );
  await assert.rejects(
    oauth.exchangeCode(OAUTH, {
      code: 'x',
      redirectUri: 'https://registry.example/auth/github/callback',
      fetchImpl: async () => fakeResponse({ status: 500, body: 'oops' }),
    }),
    (err) => err instanceof oauth.OAuthError && err.code === 'oauth_bad_response',
  );
});

test('fetchUser keeps only the allowlisted profile fields', async () => {
  const profile = await oauth.fetchUser(OAUTH, 'tok_123', async (url, options) => {
    assert.equal(url, 'https://api.github.example/user');
    assert.equal(options.headers.Authorization, 'Bearer tok_123');
    return fakeResponse({
      body: JSON.stringify({
        id: 4242,
        login: 'octocat',
        name: 'Mona Lisa',
        avatar_url: 'https://avatars.example/mona.png',
        email: 'should-not-be-kept@example.com',
      }),
    });
  });
  assert.deepEqual(profile, {
    id: '4242',
    login: 'octocat',
    name: 'Mona Lisa',
    avatarUrl: 'https://avatars.example/mona.png',
  });
  assert.equal('email' in profile, false);
});

test('fetchUser rejects responses without a usable id/login', async () => {
  await assert.rejects(
    oauth.fetchUser(OAUTH, 'tok', async () => fakeResponse({ body: JSON.stringify({ login: 'x' }) })),
    (err) => err instanceof oauth.OAuthError && err.code === 'oauth_bad_user',
  );
});

test('deriveSessionKey is purpose-bound, deterministic, and 32 bytes', () => {
  const key = oauth.deriveSessionKey('secret-a');
  assert.equal(key.length, 32);
  assert.deepEqual(key, oauth.deriveSessionKey('secret-a'));
  assert.notDeepEqual(key, oauth.deriveSessionKey('secret-b'));
  assert.notDeepEqual(key, Buffer.from('secret-a'));
});

test('session store signs cookies, survives verification, and rejects tampering', () => {
  const store = new SessionStore({ key: oauth.deriveSessionKey('secret-a') });
  const id = store.create({ account: { githubId: '1', login: 'alice' } });
  const value = store.cookieValue(id);
  const found = store.fromCookie(value);
  assert.equal(found.id, id);
  assert.equal(found.session.account.login, 'alice');
  assert.match(found.session.csrf, /^[A-Za-z0-9_-]{32,}$/);

  assert.equal(store.fromCookie(`${id}.${'0'.repeat(64)}`), null, 'forged MAC rejected');
  const other = new SessionStore({ key: oauth.deriveSessionKey('secret-b') });
  assert.equal(other.fromCookie(value), null, 'cookie from another key rejected');
  assert.equal(store.fromCookie('not-a-cookie'), null);
});

test('session store expires idle sessions and caps the map', async () => {
  const store = new SessionStore({ key: oauth.deriveSessionKey('secret'), ttlMs: 10 });
  const id = store.create({});
  assert.ok(store.get(id));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(store.get(id), null);

  const capped = new SessionStore({ key: oauth.deriveSessionKey('secret'), maxSessions: 2 });
  const first = capped.create({ label: 'first' });
  capped.create({ label: 'second' });
  capped.create({ label: 'third' });
  assert.equal(capped.get(first), null, 'oldest session evicted at capacity');
});

test('cookie helpers round-trip and set the security flags', () => {
  assert.equal(parseCookies('a=1; b=two%20words').get('b'), 'two words');
  assert.equal(parseCookies('').size, 0);
  assert.equal(parseCookies('broken').size, 0);

  const header = serializeCookie('s', 'v alue', { maxAgeSeconds: 60, secure: true });
  assert.match(header, /^s=v%20alue; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60; Secure$/);
});
