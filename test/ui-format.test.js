// Display-format helper tests for the registry web UI.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatWhen,
  shortId,
  shortDigest,
  repoLabel,
} = require('../src/ui/format');

const NOW = Date.parse('2026-09-26T12:00:00Z');

test('formatWhen renders relative labels inside a time element', () => {
  const minutes = formatWhen('2026-09-26T11:55:00Z', NOW);
  assert.match(minutes, /^<time datetime="2026-09-26T11:55:00Z" title="2026-09-26 11:55 UTC">5 min ago<\/time>$/);

  assert.match(formatWhen('2026-09-26T11:59:30Z', NOW), />just now</);
  assert.match(formatWhen('2026-09-26T11:58:00Z', NOW), />2 min ago</);
  assert.match(formatWhen('2026-09-26T09:00:00Z', NOW), />3 h ago</);
  assert.match(formatWhen('2026-09-23T12:00:00Z', NOW), />3 d ago</);
});

test('formatWhen falls back to the exact date for old and invalid input', () => {
  const old = formatWhen('2026-06-01T08:30:00Z', NOW);
  assert.match(old, />2026-06-01 08:30 UTC</);
  assert.ok(old.includes('title="2026-06-01 08:30 UTC"'));

  // Future timestamps read correctly rather than as a negative "ago".
  assert.match(formatWhen('2026-09-26T13:00:00Z', NOW), />1 h from now</);

  assert.equal(formatWhen(''), '--');
  assert.equal(formatWhen('not-a-date'), 'not-a-date');
  assert.equal(formatWhen(undefined), '--');
});

test('shortId shortens opaque ids and keeps the full value in title', () => {
  assert.equal(shortId('req_aaaa11112222'), '<code class="mono" title="req_aaaa11112222">req_aaaa111&hellip;</code>');
  assert.equal(shortId('short'), '<code class="mono">short</code>');
  assert.equal(shortId(''), '--');
});

test('shortDigest shortens digests and escapes title attributes', () => {
  const digest = 'a'.repeat(64);
  const label = shortDigest(digest);
  assert.match(label, /^<code class="mono" title="a{64}">a{12}&hellip;<\/code>$/);
  assert.equal(shortDigest('abcd'), '<code class="mono">abcd</code>');
  assert.equal(shortDigest('ab"cd'), '<code class="mono">ab&quot;cd</code>');
});

test('repoLabel shows owner/repo for GitHub URLs and leaves others whole', () => {
  assert.equal(repoLabel('https://github.com/octocat/my-lib'), 'octocat/my-lib');
  assert.equal(repoLabel('https://github.com/octocat/my-lib.git'), 'octocat/my-lib');
  assert.equal(repoLabel('https://github.com/octocat/my-lib/'), 'octocat/my-lib');
  assert.equal(repoLabel('https://gitlab.com/team/project'), 'https://gitlab.com/team/project');
  assert.equal(repoLabel(''), '');
});
