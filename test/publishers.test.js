// XIOM Package Registry -- trusted publisher config and matcher tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadTrustedPublishers,
  normalizePublishers,
  normalizeScope,
  matchPublisher,
} = require('../src/publishers');
const { tokenMayPublish } = require('../src/tokens');
const { loadConfig } = require('../src/config');

const STDLIB_REF = 'refs/tags/stdlib-v0.61.0';
const STDLIB_CLAIMS = {
  repository: 'xiom-lang/stdlib',
  workflowRef: `xiom-lang/stdlib/.github/workflows/publish-registry.yml@${STDLIB_REF}`,
  ref: STDLIB_REF,
  event: 'push',
};

function stdlibEntry(overrides = {}) {
  return {
    label: 'stdlib-release',
    repository: 'xiom-lang/stdlib',
    workflow: 'publish-registry.yml',
    refs: ['refs/tags/stdlib-v*'],
    scopes: ['xiom.std', 'xiom-std'],
    firstParty: true,
    ...overrides,
  };
}

test('normalize: workflow paths, scope globs, labels and default events', () => {
  const [entry] = normalizePublishers([
    stdlibEntry({
      workflow: '.github/workflows/publish-registry.yml',
      scopes: ['xiom.std', 'xiom.*'],
    }),
  ], 'test');
  assert.equal(entry.workflow, 'publish-registry.yml');
  assert.deepEqual(entry.scopes, ['xiom.std', 'xiom']);
  assert.deepEqual(entry.events, ['push', 'release']);

  const [branch] = normalizePublishers([
    stdlibEntry({ refs: ['refs/heads/main'], events: undefined }),
  ], 'test');
  assert.deepEqual(branch.events, ['workflow_dispatch', 'push']);

  const [explicit] = normalizePublishers([
    stdlibEntry({ events: ['workflow_dispatch'] }),
  ], 'test');
  assert.deepEqual(explicit.events, ['workflow_dispatch']);

  const [unlabeled] = normalizePublishers([{ ...stdlibEntry(), label: undefined }], 'test');
  assert.equal(unlabeled.label, 'publisher-1');
});

test('normalize: malformed entries fail loudly', () => {
  const cases = [
    [null, /must be objects/],
    [stdlibEntry({ repository: 'stdlib' }), /owner\/repo/],
    [stdlibEntry({ repository: 'xiom-*/stdlib' }), /wildcards are not allowed/],
    [stdlibEntry({ workflow: '' }), /workflow must be a non-empty string/],
    [stdlibEntry({ refs: [] }), /refs must be a non-empty array/],
    [stdlibEntry({ refs: ['main'] }), /must start with "refs\/"/],
    [stdlibEntry({ scopes: [] }), /scopes must be a non-empty array/],
    [stdlibEntry({ scopes: ['*'] }), /scope "\*" is not allowed/],
    ['[]', /must be objects/],
  ];
  for (const [entry, pattern] of cases) {
    assert.throws(() => normalizePublishers([entry], 'test'), pattern);
  }
  assert.throws(() => normalizePublishers({ tokens: [] }, 'test'), /expected an array/);
});

test('normalize: duplicate repository + workflow entries are rejected', () => {
  assert.throws(
    () => normalizePublishers([
      stdlibEntry(),
      stdlibEntry({ label: 'stdlib-second', refs: ['refs/heads/main'] }),
    ], 'test'),
    /configured twice/,
  );
});

test('load: file, nested shape, inline JSON, missing file, malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-publishers-'));
  try {
    const arrayPath = path.join(dir, 'array.json');
    fs.writeFileSync(arrayPath, JSON.stringify([stdlibEntry()]));
    assert.equal(loadTrustedPublishers({ TRUSTED_PUBLISHERS_FILE: arrayPath }).length, 1);

    const nestedPath = path.join(dir, 'nested.json');
    fs.writeFileSync(nestedPath, JSON.stringify({ publishers: [stdlibEntry()] }));
    assert.equal(loadTrustedPublishers({ TRUSTED_PUBLISHERS_FILE: nestedPath }).length, 1);

    const emptyPath = path.join(dir, 'empty.json');
    fs.writeFileSync(emptyPath, '');
    assert.deepEqual(loadTrustedPublishers({ TRUSTED_PUBLISHERS_FILE: emptyPath }), []);

    assert.deepEqual(
      loadTrustedPublishers({ TRUSTED_PUBLISHERS_FILE: path.join(dir, 'absent.json') }),
      [],
    );

    const inline = loadTrustedPublishers({
      TRUSTED_PUBLISHERS_FILE: JSON.stringify({ publishers: [stdlibEntry()] }),
    });
    assert.equal(inline[0].repository, 'xiom-lang/stdlib');

    const badPath = path.join(dir, 'bad.json');
    fs.writeFileSync(badPath, '{ not json');
    assert.throws(
      () => loadTrustedPublishers({ TRUSTED_PUBLISHERS_FILE: badPath }),
      /is not valid JSON/,
    );
    assert.throws(
      () => loadTrustedPublishers({ TRUSTED_PUBLISHERS_FILE: '{ also bad' }),
      /inline JSON is invalid/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('match: repository, workflow file, ref glob and event must all agree', () => {
  // Production and staging live in separate instance configs, so the same
  // repository + workflow may appear once per file; the matcher below sees
  // the union of both files.
  const entries = [
    ...normalizePublishers([stdlibEntry()], 'prod'),
    ...normalizePublishers([
      { label: 'stdlib-staging', repository: 'xiom-lang/stdlib', workflow: 'publish-registry.yml', refs: ['refs/heads/main'], scopes: ['xiom.std', 'xiom-std'], firstParty: true },
    ], 'staging'),
  ];

  assert.equal(matchPublisher(entries, STDLIB_CLAIMS).label, 'stdlib-release');
  assert.equal(matchPublisher(entries, {
    ...STDLIB_CLAIMS,
    workflowRef: `xiom-lang/stdlib/.github/workflows/release.yml@${STDLIB_REF}`,
  }), null);
  assert.equal(matchPublisher(entries, { ...STDLIB_CLAIMS, repository: 'evil/stdlib' }), null);
  assert.equal(matchPublisher(entries, { ...STDLIB_CLAIMS, ref: 'refs/tags/v0.61.0' }), null);
  assert.equal(matchPublisher(entries, { ...STDLIB_CLAIMS, event: 'workflow_dispatch' }), null);
  assert.equal(matchPublisher(entries, { ...STDLIB_CLAIMS, workflowRef: undefined }), null);

  const dispatch = matchPublisher(entries, {
    repository: 'xiom-lang/stdlib',
    workflowRef: 'xiom-lang/stdlib/.github/workflows/publish-registry.yml@refs/heads/main',
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
  });
  assert.equal(dispatch.label, 'stdlib-staging');
});

test('match: the configured production entries (stdlib + packages) behave', () => {
  const packagesScopes = ['xiom.core', 'xiom.algo', 'xiom.math', 'xiom.http', 'xiom.ecosystem'];
  const entries = normalizePublishers([
    stdlibEntry(),
    {
      label: 'eco-batch',
      repository: 'xiom-packages/packages',
      workflow: '.github/workflows/publish-registry.yml',
      refs: ['refs/tags/eco-v*'],
      scopes: packagesScopes,
      firstParty: true,
    },
  ], 'test');

  const ecoRef = 'refs/tags/eco-v0.1.0';
  const eco = matchPublisher(entries, {
    repository: 'xiom-packages/packages',
    workflowRef: `xiom-packages/packages/.github/workflows/publish-registry.yml@${ecoRef}`,
    ref: ecoRef,
    event: 'push',
  });
  assert.equal(eco.label, 'eco-batch');
  assert.ok(tokenMayPublish({ scopes: eco.scopes }, 'xiom.core'));
  assert.ok(!tokenMayPublish({ scopes: eco.scopes }, 'xiom.std'), 'packages cannot publish xiom.std');
  assert.ok(!tokenMayPublish({ scopes: eco.scopes }, 'xiom-std'), 'nor the hyphen name');
  assert.ok(!tokenMayPublish({ scopes: eco.scopes }, 'xiom.opencv'), 'unlisted names stay out');
  assert.ok(tokenMayPublish({ scopes: eco.scopes }, 'xiom.http.client'), 'dot-prefixes cover submodules');

  assert.equal(matchPublisher(entries, {
    repository: 'xiom-packages/packages',
    workflowRef: 'xiom-packages/packages/.github/workflows/publish-registry.yml@refs/heads/main',
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
  }), null, 'the packages repo has no staging branch entry in production');

  const stdlib = matchPublisher(entries, STDLIB_CLAIMS);
  assert.ok(tokenMayPublish({ scopes: stdlib.scopes }, 'xiom-std'));
  assert.ok(tokenMayPublish({ scopes: stdlib.scopes }, 'xiom.std'));
});

test('registry namespaces: scope prefixes are exact on dot boundaries', () => {
  assert.equal(normalizeScope('xiom.*'), 'xiom');
  assert.equal(normalizeScope('xiom.std'), 'xiom.std');
  assert.ok(tokenMayPublish({ scopes: ['xiom'] }, 'xiom.core'));
  assert.ok(!tokenMayPublish({ scopes: ['xiom'] }, 'xiom-std'));
  assert.ok(!tokenMayPublish({ scopes: ['xiom.core'] }, 'xiom.corex'));
});

test('config integration: loadConfig surfaces publishers and the pinned audience', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-config-'));
  const saved = {
    TRUSTED_PUBLISHERS_FILE: process.env.TRUSTED_PUBLISHERS_FILE,
    OIDC_AUDIENCE: process.env.OIDC_AUDIENCE,
  };
  try {
    const file = path.join(dir, 'trusted-publishers.json');
    fs.writeFileSync(file, JSON.stringify([stdlibEntry()]));
    process.env.TRUSTED_PUBLISHERS_FILE = file;
    process.env.OIDC_AUDIENCE = 'xiom-registry';
    const config = loadConfig();
    assert.equal(config.publishers.length, 1);
    assert.equal(config.oidcAudience, 'xiom-registry');

    delete process.env.OIDC_AUDIENCE;
    assert.equal(loadConfig().oidcAudience, 'xiom-registry', 'audience has a safe default');
  } finally {
    if (saved.TRUSTED_PUBLISHERS_FILE === undefined) delete process.env.TRUSTED_PUBLISHERS_FILE;
    else process.env.TRUSTED_PUBLISHERS_FILE = saved.TRUSTED_PUBLISHERS_FILE;
    if (saved.OIDC_AUDIENCE === undefined) delete process.env.OIDC_AUDIENCE;
    else process.env.OIDC_AUDIENCE = saved.OIDC_AUDIENCE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
