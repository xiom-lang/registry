#!/usr/bin/env node
// XIOM Package Registry -- token fulfilment worker (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Runs on the host next to the token file. Every cycle it asks the registry
// (secret-gated internal API) for approved token requests, mints a token into
// the mounted file, mails it, and marks the request fulfilled. The registry
// hot-reloads the token file, so a mint is live on the next publish -- no
// recreate. The worker never touches the database or the web app directly.
//
// Usage:
//   node scripts/fulfiller.js            # poll forever
//   node scripts/fulfiller.js --once     # one cycle (systemd timer / cron)
//
// Required env:
//   FULFILLER_URL          registry base URL reachable from the host
//                          (e.g. http://127.0.0.1:3200 for staging)
//   FULFILLER_SECRET       same value as the app's FULFILLER_SECRET
//   FULFILLER_TOKENS_FILE  host path of the tokens file this instance mounts
//                          (production: tokens.json, staging: tokens.staging.json)
// Mail (one of):
//   SMTP_URL               nodemailer SMTP URL, or
//   SENDMAIL_PATH          sendmail binary (default /usr/sbin/sendmail)
//   SMTP_FROM / MAIL_FROM  from address (default registry@xiom-lang.org)
// Optional:
//   FULFILLER_REGISTRY_URL public URL shown in the mail (default FULFILLER_URL)
//   FULFILLER_INTERVAL_MS  poll interval, min 5000 (default 15000)
//   FULFILLER_TRUSTED=1    mint trusted tokens (signatures required)
//   FULFILLER_PUBLIC_KEY   pin a 64-hex ed25519 key (implies trusted)
//   FULFILLER_FIRST_PARTY=1 first-party tokens (operator use only)

'use strict';

const crypto = require('crypto');

const { createMailer } = require('../src/mailer');
const { loadTokens, saveTokens } = require('./lib/token-file');

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

async function apiRequest(baseUrl, secret, route, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (response.status === 409) return { conflict: true };
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${route}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return response.json();
}

/** Mint (or find) the token entry for one approved request. */
function mintForRequest({ tokensFile, request, trusted = false, firstParty = false, publicKey = '' }) {
  const label = `${request.requester.login}-${request.id}`;
  const tokens = loadTokens(tokensFile);
  const existing = tokens.find((entry) => entry.label === label);
  if (existing) return { label, token: '', existing: true };
  const entry = {
    token: crypto.randomBytes(32).toString('hex'),
    label,
    scopes: request.scopes,
    trusted,
    firstParty,
    issuedAt: new Date().toISOString(),
    ...(publicKey ? { publicKey } : {}),
  };
  saveTokens(tokensFile, [...tokens, entry]);
  return { label, token: entry.token, existing: false };
}

function tokenMail({ registryUrl, request, minted }) {
  return [
    'Your XIOM registry publish token is ready.',
    '',
    `Registry: ${registryUrl}`,
    `Package scope: ${request.scopes.join(', ')}`,
    `Token: ${minted.token}`,
    '',
    'Keep it secret; anyone with it can publish those names.',
    'It is active now. Publish with:',
    `  XIOM_REGISTRY=${registryUrl} XIOM_REGISTRY_TOKEN=<token> xiom pkg publish`,
  ].join('\n');
}

/** One poll cycle: fulfil every approved token request that can be mailed. */
async function runOnce({
  apiUrl,
  secret,
  tokensFile,
  mailer,
  registryUrl,
  log = console,
  trusted = false,
  firstParty = false,
  publicKey = '',
}) {
  if (!mailer.enabled) {
    log('fulfiller: no mail transport configured (SMTP_URL or SENDMAIL_PATH); nothing to do');
    return 0;
  }
  const listed = await apiRequest(apiUrl, secret, '/internal/requests?status=approved');
  let fulfilled = 0;
  for (const request of listed.requests || []) {
    if (!request.notifyEmail) {
      log(`fulfiller: skip ${request.id} -- the requester has no notification email`);
      continue;
    }
    const minted = mintForRequest({ tokensFile, request, trusted, firstParty, publicKey });
    if (minted.token) {
      try {
        await mailer.send({
          to: request.notifyEmail,
          subject: 'Your XIOM registry publish token',
          text: tokenMail({ registryUrl, request, minted }),
        });
      } catch (err) {
        // Leave the request approved so the admin can see and retry.
        log(`fulfiller: mail failed for ${request.id}: ${err.message}`);
        continue;
      }
    }
    const result = await apiRequest(apiUrl, secret, `/internal/requests/${request.id}/fulfilled`, {
      method: 'POST',
      body: JSON.stringify({
        reference: minted.existing ? 'existing token entry (not re-mailed)' : `mailed ${request.notifyEmail}`,
      }),
    });
    if (!result.conflict) fulfilled += 1;
    log(`fulfiller: ${request.id} ${minted.existing ? 'existing entry, marked fulfilled' : 'minted and mailed'}`);
  }
  return fulfilled;
}

async function main() {
  const once = process.argv.includes('--once') || env('FULFILLER_ONCE') === '1';
  const apiUrl = env('FULFILLER_URL');
  const secret = env('FULFILLER_SECRET');
  const tokensFile = env('FULFILLER_TOKENS_FILE');
  if (!apiUrl || !secret || !tokensFile) {
    console.error('FULFILLER_URL, FULFILLER_SECRET and FULFILLER_TOKENS_FILE are required');
    process.exit(2);
  }
  const mailer = createMailer({
    smtpUrl: env('SMTP_URL'),
    sendmailPath: env('SENDMAIL_PATH', '/usr/sbin/sendmail'),
    from: env('MAIL_FROM', env('SMTP_FROM', 'registry@xiom-lang.org')),
  });
  const options = {
    apiUrl,
    secret,
    tokensFile,
    mailer,
    registryUrl: env('FULFILLER_REGISTRY_URL', apiUrl),
    trusted: env('FULFILLER_TRUSTED') === '1',
    firstParty: env('FULFILLER_FIRST_PARTY') === '1',
    publicKey: env('FULFILLER_PUBLIC_KEY'),
  };
  const cycle = async () => {
    try {
      const count = await runOnce(options);
      if (count > 0) console.log(`fulfiller: ${count} request(s) fulfilled`);
    } catch (err) {
      console.error(`fulfiller cycle failed: ${err.message}`);
    }
  };
  await cycle();
  if (once) return;
  setInterval(cycle, Math.max(5000, Number(env('FULFILLER_INTERVAL_MS', '15000'))));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runOnce, mintForRequest, tokenMail };
