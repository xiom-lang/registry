// XIOM Package Registry -- publishing guide page tests (registry 2.1).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The /publish page renders PUBLISHING.md from git with a bundled fallback,
// the nav points at it instead of GitHub, and the workflow template ships the
// tag trigger + tag/version guard a beginner needs.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const REPO = path.join(__dirname, '..');
const BROWSER = { Accept: 'text/html,application/xhtml+xml' };

function listen(instance) {
  return new Promise((resolve) => {
    const server = instance.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withApp(configure, run) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-guide-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(sandbox, 'data');
  process.env.PACKAGES_DIR = path.join(sandbox, 'packages');
  process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'data', 'tmp');
  process.env.RATE_LIMIT_DISABLED = '1';
  process.env.DB_FILE = path.join(sandbox, 'registry.db');
  process.env.REGISTRY_URL = 'http://127.0.0.1:3999';
  delete process.env.TOKENS_FILE;
  process.env.GITHUB_OAUTH_CLIENT_ID = 'guide-client-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'guide-client-secret-0123456789';
  process.env.REGISTRY_ADMIN_LOGINS = 'guide-admin';
  const config = loadConfig();
  if (configure) configure(config);
  const app = createApp(config);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ app, baseUrl });
  } finally {
    server.close();
    try { app.locals.registry.db.close(); } catch { /* already closed */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
}

test('the bundled guide renders when the GitHub fetch fails', async () => {
  await withApp((config) => {
    config.publishingDocUrl = 'http://127.0.0.1:9/unreachable/PUBLISHING.md';
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/publish`, { headers: BROWSER });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Bundled copy shipped with this registry/);
    assert.match(html, /Five-minute quickstart/);
    // Heading anchors work for the in-page table of contents.
    assert.match(html, /<h2 id="1-five-minute-quickstart-trusted-publisher-recommended">/);
    // The old backlog path stays a valid link.
    const redirect = await fetch(`${baseUrl}/help/publishing`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/publish');
    // Nav and footer are registry-hosted.
    assert.match(html, /<a href="\/publish">Publish<\/a>/);
    assert.doesNotMatch(html, /github\.com\/xiom-lang\/registry\/blob\/main\/PUBLISHING\.md">Publish/);
  });
});

test('the live guide replaces the bundled copy when GitHub serves it', async () => {
  const remote = http.createServer((req, res) => {
    if (req.url !== '/PUBLISHING.md') {
      res.writeHead(404).end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('# Live guide\n\nThis copy came from the remote source.\n\n## Section one\n\nBody.\n');
  });
  const remoteServer = await listen(remote);
  const remoteBase = `http://127.0.0.1:${remoteServer.address().port}`;
  try {
    await withApp((config) => {
      config.publishingDocUrl = `${remoteBase}/PUBLISHING.md`;
    }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/publish`, { headers: BROWSER });
      const html = await response.text();
      assert.match(html, /Live copy from GitHub/);
      assert.match(html, /This copy came from the remote source/);
      assert.match(html, /<h2 id="section-one">/);
    });
  } finally {
    remoteServer.close();
  }
});

test('the workflow template is copy-paste ready for beginners', () => {
  const template = fs.readFileSync(
    path.join(REPO, 'src', 'ui', 'templates', 'community-publish.yml'),
    'utf-8',
  );
  // Ready tag trigger (commented until the user opts in) plus the guard that
  // makes a wrong tag fail before anything is published.
  assert.match(template, /#\s*push:\n\s*#\s+tags: \["v\*"\]/);
  assert.match(template, /Check tag matches the package version/);
  assert.match(template, /does not match package\.xi version/);
  // Works for manual runs too: defaults cover an empty event payload.
  assert.match(template, /github\.event\.inputs\.registry \|\| 'https:\/\/registry\.xiom-lang\.org'/);
  assert.match(template, /id-token: write/);
  // The toolchain stays out of the packaged directory.
  assert.match(template, /RUNNER_TEMP\/compiler/);
});

test('a missing bundled guide degrades to a signpost instead of failing', async () => {
  // This is the staging 2.1 crash-loop in miniature: the image lacked
  // PUBLISHING.md and the fallback was read at module load, so the container
  // exited before startup. The read is lazy now and the page stays 200.
  await withApp((config) => {
    config.publishingDocUrl = 'http://127.0.0.1:9/unreachable/PUBLISHING.md';
    config.publishingBundledPath = path.join(os.tmpdir(), 'xiom-no-guide-here', 'PUBLISHING.md');
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/publish`, { headers: BROWSER });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /bundled guide is missing from this deployment/);
    assert.match(html, /github\.com\/xiom-lang\/registry\/blob\/main\/PUBLISHING\.md/);
  });
});

test('the Dockerfile copies every root file the service reads at runtime', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf-8');
  const copyLine = dockerfile.split('\n').find((line) => line.startsWith('COPY seed.js'));
  assert.ok(copyLine, 'the root-level COPY line exists');
  for (const file of ['CHANGELOG.md', 'PUBLISHING.md']) {
    assert.match(copyLine, new RegExp(`(^|\\s)${file.replace('.', '\\.')}(\\s|$)`),
      `${file} is copied into the image`);
  }
});

test('the GitHub token-request issue template is gone', () => {
  assert.equal(
    fs.existsSync(path.join(REPO, '.github', 'ISSUE_TEMPLATE', 'token-request.yml')),
    false,
    'the web request flow is the only front door',
  );
});
