// XIOM Package Registry -- GitHub OAuth sign-in (identity only).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Registry 2.0 phase 1/2: GitHub OAuth with the `read:user` scope links a
// human identity to requests and review state. A browser session is never a
// publish credential -- publishing stays on static tokens or GitHub OIDC
// (SESSION.md section 15). Upstream endpoints are overridable so tests (and a
// future mirror) can serve a local fake provider.

'use strict';

const crypto = require('crypto');

/** Fixed callback path; the OAuth app must register it for each instance. */
const CALLBACK_PATH = '/auth/github/callback';
const DEFAULT_SCOPE = 'read:user';

const GITHUB_DEFAULTS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  apiUrl: 'https://api.github.com',
};

/** Upstream GitHub failure; the app maps it to a friendly retry, never a 500. */
class OAuthError extends Error {
  constructor(message, code = 'oauth_error') {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

function endpoints(oauth) {
  return {
    authorizeUrl: oauth.authorizeUrl || GITHUB_DEFAULTS.authorizeUrl,
    tokenUrl: oauth.tokenUrl || GITHUB_DEFAULTS.tokenUrl,
    apiUrl: oauth.apiUrl || GITHUB_DEFAULTS.apiUrl,
  };
}

/** Random, single-use CSRF state for the authorization redirect. */
function randomState() {
  return crypto.randomBytes(24).toString('base64url');
}

/** The URL a browser is sent to for GitHub sign-in. */
function authorizeUrl(oauth, { redirectUri, state }) {
  const url = new URL(endpoints(oauth).authorizeUrl);
  url.searchParams.set('client_id', oauth.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', oauth.scope || DEFAULT_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

async function requestJson(url, options, fetchImpl, what) {
  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(url, options);
  } catch (err) {
    throw new OAuthError(`GitHub ${what} is unreachable: ${err.message}`, 'oauth_unreachable');
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new OAuthError(`GitHub ${what} response could not be read`, 'oauth_bad_response');
  }
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new OAuthError(`GitHub ${what} returned a non-JSON response`, 'oauth_bad_response');
  }
  if (!response.ok) {
    throw new OAuthError(`GitHub ${what} returned HTTP ${response.status}`, 'oauth_upstream');
  }
  return body;
}

/**
 * Exchange the authorization code for an access token. The token is returned
 * to the caller only; it is never stored, logged, or rendered.
 *
 * @returns {Promise<string>}
 * @throws {OAuthError}
 */
async function exchangeCode(oauth, { code, redirectUri, fetchImpl }) {
  const body = await requestJson(endpoints(oauth).tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'xiom-registry',
    },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  }, fetchImpl, 'token exchange');
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    // GitHub answers 200 with an `error` body for rejected codes.
    const detail = typeof body.error_description === 'string' && body.error_description
      ? body.error_description
      : (typeof body.error === 'string' && body.error ? body.error : 'no access_token');
    throw new OAuthError(`GitHub refused the sign-in code: ${detail}`, 'oauth_denied');
  }
  return body.access_token;
}

/**
 * Fetch the signed-in user's public profile (read:user). Only the fields the
 * registry displays are kept.
 *
 * @returns {Promise<{ id: string, login: string, name: string, avatarUrl: string }>}
 * @throws {OAuthError}
 */
async function fetchUser(oauth, accessToken, fetchImpl) {
  const body = await requestJson(`${endpoints(oauth).apiUrl}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'xiom-registry',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, fetchImpl, 'user lookup');
  const id = body && (typeof body.id === 'number' || typeof body.id === 'string')
    ? String(body.id)
    : '';
  if (!/^\d{1,32}$/.test(id) || typeof body.login !== 'string' || body.login === '') {
    throw new OAuthError('GitHub user lookup returned no usable id/login', 'oauth_bad_user');
  }
  return {
    id,
    login: body.login.slice(0, 64),
    name: typeof body.name === 'string' ? body.name.slice(0, 200) : '',
    avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url.slice(0, 512) : '',
  };
}

/**
 * Session signing key derived from the OAuth client secret. Deriving a
 * purpose-bound key (instead of reusing the secret) keeps the cookie MAC and
 * the upstream credential cryptographically separate; rotating the OAuth
 * secret invalidates every session, which is the desired behavior.
 */
function deriveSessionKey(clientSecret) {
  return crypto.createHmac('sha256', clientSecret)
    .update('xiom-registry/session-v1')
    .digest();
}

module.exports = {
  CALLBACK_PATH,
  DEFAULT_SCOPE,
  OAuthError,
  authorizeUrl,
  randomState,
  exchangeCode,
  fetchUser,
  deriveSessionKey,
};
