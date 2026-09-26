// XIOM Package Registry -- fulfiller worker tests (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mintForRequest, runOnce } = require('../scripts/fulfiller');
const { loadTokens } = require('../scripts/lib/token-file');

function tempTokens() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-fulfiller-'));
  return path.join(dir, 'tokens.json');
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

const REQUEST = {
  id: 'req_aaaaaaaaaaaa',
  scopes: ['demo-lib'],
  requester: { githubId: '7', login: 'alice' },
  notifyEmail: 'alice@example.com',
};

test('mintForRequest mints once and is idempotent per request label', () => {
  const tokensFile = tempTokens();
  const first = mintForRequest({ tokensFile, request: REQUEST });
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.equal(first.existing, false);

  const stored = loadTokens(tokensFile);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].label, 'alice-req_aaaaaaaaaaaa');
  assert.deepEqual(stored[0].scopes, ['demo-lib']);
  assert.equal(stored[0].firstParty, false);
  assert.equal(stored[0].trusted, false);

  const second = mintForRequest({ tokensFile, request: REQUEST });
  assert.equal(second.existing, true);
  assert.equal(second.token, '');
  assert.equal(loadTokens(tokensFile).length, 1, 'no duplicate entry');
});

test('runOnce mints, mails, and marks fulfilled; skips requesters without email', async () => {
  const tokensFile = tempTokens();
  const calls = [];
  const mailed = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (String(url).includes('/internal/requests?status=approved')) {
      return jsonResponse({
        requests: [
          REQUEST,
          { ...REQUEST, id: 'req_bbbbbbbbbbbb', requester: { githubId: '8', login: 'bob' }, notifyEmail: '' },
        ],
      });
    }
    return jsonResponse({ ok: true });
  };
  try {
    const mailer = {
      enabled: true,
      async send(message) { mailed.push(message); return { status: 'sent' }; },
    };
    const fulfilled = await runOnce({
      apiUrl: 'http://app.test',
      secret: 'sekret',
      tokensFile,
      mailer,
      registryUrl: 'https://registry.xiom-lang.org',
      log: () => {},
    });
    assert.equal(fulfilled, 1);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(mailed.length, 1);
  assert.equal(mailed[0].to, 'alice@example.com');
  assert.match(mailed[0].text, /Token: [0-9a-f]{64}/);
  assert.match(mailed[0].text, /registry\.xiom-lang\.org/);

  const fulfilCall = calls.find((call) => call.url.endsWith(`/internal/requests/${REQUEST.id}/fulfilled`));
  assert.ok(fulfilCall, 'fulfilment recorded');
  assert.equal(fulfilCall.method, 'POST');
  assert.match(fulfilCall.body.reference, /mailed alice@example\.com/);
  assert.equal(
    calls.some((call) => call.url.includes('req_bbbbbbbbbbbb/fulfilled')),
    false,
    'a request without a notification email stays approved',
  );
  assert.equal(loadTokens(tokensFile).length, 1);
});

test('runOnce does nothing without a mail transport', async () => {
  const tokensFile = tempTokens();
  const fulfilled = await runOnce({
    apiUrl: 'http://app.test',
    secret: 'x',
    tokensFile,
    mailer: { enabled: false, async send() { throw new Error('should not send'); } },
    registryUrl: 'x',
    log: () => {},
  });
  assert.equal(fulfilled, 0);
  assert.equal(loadTokens(tokensFile).length, 0);
});
