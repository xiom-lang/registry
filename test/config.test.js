// XIOM Package Registry -- configuration and token file tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/config');

/** Run `fn` with a patched environment, restoring it afterwards. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempFile(contents, name = 'tokens.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-config-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

test('tokens file: array form', () => {
  const file = tempFile(JSON.stringify([
    { token: 'a', label: 'A', scopes: ['x'], trusted: true, firstParty: false },
    { token: 'b' },
  ]));
  withEnv({ TOKENS_FILE: file, API_KEY: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.tokens.size, 2);
    assert.deepEqual(config.tokens.get('a'), {
      label: 'A', scopes: ['x'], trusted: true, firstParty: false,
    });
    assert.deepEqual(config.tokens.get('b').scopes, ['*'], 'default scope is wildcard');
    assert.equal(config.tokens.get('b').trusted, false);
  });
});

test('tokens file: object map form', () => {
  const file = tempFile(JSON.stringify({
    tokens: { key1: { label: 'one', firstParty: true }, key2: {} },
  }));
  withEnv({ TOKENS_FILE: file, API_KEY: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.tokens.size, 2);
    assert.equal(config.tokens.get('key1').firstParty, true);
  });
});

test('legacy API_KEY maps to a first-party trusted token', () => {
  withEnv({ TOKENS_FILE: undefined, API_KEY: 'legacy-secret' }, () => {
    const config = loadConfig();
    assert.equal(config.tokens.size, 1);
    const token = config.tokens.get('legacy-secret');
    assert.equal(token.trusted, true);
    assert.equal(token.firstParty, true);
  });
});

test('no tokens configured disables publishing', () => {
  withEnv({ TOKENS_FILE: undefined, API_KEY: undefined }, () => {
    assert.equal(loadConfig().tokens.size, 0);
  });
});

test('malformed tokens files are rejected at startup', () => {
  withEnv({ TOKENS_FILE: tempFile('{ not json'), API_KEY: undefined }, () => {
    assert.throws(() => loadConfig(), /not valid JSON/);
  });
  withEnv({ TOKENS_FILE: tempFile(JSON.stringify({ nope: true })), API_KEY: undefined }, () => {
    assert.throws(() => loadConfig(), /expected an array/);
  });
  withEnv({ TOKENS_FILE: tempFile(JSON.stringify([{ token: 'a' }, { token: 'a' }])), API_KEY: undefined }, () => {
    assert.throws(() => loadConfig(), /duplicate/);
  });
  withEnv({ TOKENS_FILE: path.join(os.tmpdir(), 'xiom-definitely-missing-tokens.json'), API_KEY: undefined }, () => {
    assert.throws(() => loadConfig(), /cannot be read/);
  });
});

test('limits and registry URL come from the environment', () => {
  withEnv({
    TOKENS_FILE: undefined,
    API_KEY: 'k',
    MAX_TARBALL_BYTES: '1234',
    MAX_INDEX_PACKAGES: '5',
    REGISTRY_URL: 'https://staging.registry.example/',
    RATE_LIMIT_DISABLED: '1',
  }, () => {
    const config = loadConfig();
    assert.equal(config.maxTarballBytes, 1234);
    assert.equal(config.maxIndexPackages, 5);
    assert.equal(config.registryUrl, 'https://staging.registry.example', 'trailing slash trimmed');
    assert.equal(config.rateLimit.disabled, true);
  });
});

test('invalid numeric limits fail fast', () => {
  withEnv({ API_KEY: 'k', MAX_TARBALL_BYTES: 'nope' }, () => {
    assert.throws(() => loadConfig(), /MAX_TARBALL_BYTES/);
  });
});

test('oauth: both unset disables sign-in', () => {
  withEnv({
    TOKENS_FILE: undefined,
    API_KEY: 'k',
    GITHUB_OAUTH_CLIENT_ID: undefined,
    GITHUB_OAUTH_CLIENT_SECRET: undefined,
    REGISTRY_ADMIN_LOGINS: undefined,
  }, () => {
    const config = loadConfig();
    assert.equal(config.oauth.enabled, false);
    assert.deepEqual(config.oauth.adminLogins, []);
    assert.equal(config.oauth.scope, 'read:user');
  });
});

test('oauth: a half-set pair fails startup (empty secret included)', () => {
  withEnv({
    TOKENS_FILE: undefined,
    API_KEY: 'k',
    GITHUB_OAUTH_CLIENT_ID: 'Ov23liTEST',
    GITHUB_OAUTH_CLIENT_SECRET: '',
  }, () => {
    assert.throws(() => loadConfig(), /must be set together/);
  });
  withEnv({
    TOKENS_FILE: undefined,
    API_KEY: 'k',
    GITHUB_OAUTH_CLIENT_ID: '',
    GITHUB_OAUTH_CLIENT_SECRET: 'a-valid-looking-secret',
  }, () => {
    assert.throws(() => loadConfig(), /must be set together/);
  });
});

test('oauth: a full pair enables sign-in and normalizes admins', () => {
  withEnv({
    TOKENS_FILE: undefined,
    API_KEY: 'k',
    GITHUB_OAUTH_CLIENT_ID: 'Ov23liTEST',
    GITHUB_OAUTH_CLIENT_SECRET: '0123456789abcdef0123456789abcdef01234567',
    REGISTRY_ADMIN_LOGINS: 'LefterisNotas, alice ',
    REGISTRY_REVIEWER_LOGINS: 'ReviewerOne',
  }, () => {
    const config = loadConfig();
    assert.equal(config.oauth.enabled, true);
    assert.deepEqual(config.oauth.adminLogins, ['lefterisnotas', 'alice']);
    assert.deepEqual(config.oauth.reviewerLogins, ['reviewerone']);
    assert.equal(config.accountsPath.endsWith('accounts.json'), true);
    assert.equal(config.requestsPath.endsWith('requests.json'), true);
    assert.equal(config.reviewsPath.endsWith('reviews.json'), true);
  });
});

test('oauth: a too-short secret fails fast', () => {
  withEnv({
    TOKENS_FILE: undefined,
    API_KEY: 'k',
    GITHUB_OAUTH_CLIENT_ID: 'Ov23liTEST',
    GITHUB_OAUTH_CLIENT_SECRET: 'short',
  }, () => {
    assert.throws(() => loadConfig(), /too short/);
  });
});
