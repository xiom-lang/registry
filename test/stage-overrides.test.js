// XIOM Package Registry -- display-stage override tests (SESSION.md 21.4).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadStageOverrides, EXCLUDED_PACKAGES } = require('../src/stage-overrides');
const { generateStageOverrides } = require('../scripts/generate-stage-overrides');
const { packageBadgeState, setStageOverrides, effectiveStage } = require('../src/ui/pages');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-stage-'));
}

function writeStatus(root, folder, contents) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STATUS.json'), JSON.stringify(contents, null, 2));
}

test('loader applies valid overrides and drops excluded or malformed entries', () => {
  const file = path.join(tempDir(), 'stage-overrides.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    source: { repository: 'xiom-packages/packages', commit: 'abc123', generated_at: 'now', why: 'backfill' },
    overrides: {
      'xiom.hello': 'incubating',
      'xiom.audit': 'stable',
      'xiom.std': 'incubating',                 // stdlib-owned: excluded
      'xiom.staging-e2e-probe': 'stable',      // fixture: excluded
      'xiom.bogus': 'sideways',                // unknown stage
      'Bad Name': 'stable',                    // unsafe name
    },
  }));
  const { overrides, source, warnings } = loadStageOverrides({ path: file });
  assert.deepEqual([...overrides.entries()].sort(), [['xiom.audit', 'stable'], ['xiom.hello', 'incubating']]);
  assert.equal(source.commit, 'abc123');
  assert.equal(source.why, 'backfill');
  assert.match(warnings.join(' '), /dropped 4 invalid or excluded entries/);
  for (const name of EXCLUDED_PACKAGES) {
    assert.equal(overrides.has(name), false, `${name} can never be overridden`);
  }
});

test('loader never throws: missing, corrupt, and oversized files yield no overrides', () => {
  const dir = tempDir();
  const missing = loadStageOverrides({ path: path.join(dir, 'nope.json') });
  assert.equal(missing.overrides.size, 0);
  assert.match(missing.warnings.join(' '), /not found/);

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ not json');
  assert.equal(loadStageOverrides({ path: corrupt }).overrides.size, 0);

  const big = path.join(dir, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ overrides: { 'xiom.hello': 'incubating' } }));
  assert.equal(loadStageOverrides({ path: big, maxBytes: 10 }).overrides.size, 0);
});

test('generator builds a minimal document from STATUS.json files', () => {
  const root = tempDir();
  writeStatus(root, 'xiom-hello', { package: 'xiom.hello', stage: 'incubating' });
  writeStatus(root, 'xiom-audit', { package: 'xiom.audit', stage: 'stable' });
  writeStatus(root, 'xiom-algo', { package: 'xiom.algo', stage: 'incubating' });
  writeStatus(root, 'xiom-std', { package: 'xiom.std', stage: 'stable' }); // excluded
  writeStatus(root, 'xiom-bogus', { package: 'xiom.bogus', stage: 'sideways' }); // skipped
  fs.mkdirSync(path.join(root, 'xiom-empty')); // no STATUS.json: ignored

  const unfiltered = generateStageOverrides({
    packagesDir: root,
    repository: 'xiom-packages/packages',
    commit: '471c5e3',
    why: 'badge backfill',
    now: '2026-09-26T23:00:00.000Z',
  });
  assert.deepEqual(unfiltered.document.overrides, {
    'xiom.algo': 'incubating',
    'xiom.audit': 'stable',
    'xiom.hello': 'incubating',
  });
  assert.equal(unfiltered.document.source.commit, '471c5e3');
  assert.equal(unfiltered.counts.incubating, 2);
  assert.match(unfiltered.errors.join(' '), /xiom.bogus/);
  assert.match(unfiltered.skipped.join(' '), /xiom.std/);

  // With an index, only published entries that still lack a stage are kept.
  const filtered = generateStageOverrides({
    packagesDir: root,
    index: {
      packages: {
        'xiom.hello': { stage: '' },            // needs the override
        'xiom.audit': { stage: 'stable' },      // already stamped: leave it
        'xiom.algo': {},                        // published, no stage key
      },
    },
  });
  assert.deepEqual(filtered.document.overrides, {
    'xiom.algo': 'incubating',
    'xiom.hello': 'incubating',
  });
});

test('overrides fill only missing stages; published data always wins', () => {
  const signed = { signature: 'aa', publicKey: 'bb' };
  const entry = (extra = {}) => ({ version: '0.1.0', published: 'x', ...signed, ...extra });
  try {
    setStageOverrides(new Map([['xiom.hello', 'incubating'], ['xiom.audit', 'deprecated']]));

    // Nothing published: the override supplies the stage.
    const fromOverride = packageBadgeState('xiom.hello', {
      name: 'xiom.hello',
      latest: '0.1.0',
      versions: { '0.1.0': entry() },
    });
    assert.equal(fromOverride.file, 'pgk_incubator_official.webp');

    // A published package-level stage wins over the override.
    const fromPackage = packageBadgeState('xiom.audit', {
      name: 'xiom.audit',
      stage: 'stable',
      latest: '0.1.0',
      versions: { '0.1.0': entry() },
    });
    assert.equal(fromPackage.file, 'pgk_verified_official.webp');

    // A published version-level stage wins over the override too.
    const fromVersion = packageBadgeState('xiom.audit', {
      name: 'xiom.audit',
      latest: '0.1.0',
      versions: { '0.1.0': entry({ stage: 'incubating' }) },
    });
    assert.equal(fromVersion.file, 'pgk_incubator_official.webp');

    // effectiveStage mirrors the precedence.
    assert.equal(effectiveStage('xiom.hello', { versions: {} }, null), 'incubating');
    assert.equal(effectiveStage('xiom.audit', { stage: 'stable', versions: {} }, null), 'stable');
  } finally {
    setStageOverrides(new Map());
  }
});

test('boot applies the override file and audits once per source commit', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-stage-boot-'));
  const overridesFile = path.join(sandbox, 'stage-overrides.json');
  fs.writeFileSync(overridesFile, JSON.stringify({
    version: 1,
    source: { repository: 'xiom-packages/packages', commit: 'abc123', generated_at: 'now', why: 'backfill' },
    overrides: { 'xiom.hello': 'incubating', 'xiom.audit': 'stable' },
  }));
  const saved = {};
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test',
    DATA_DIR: path.join(sandbox, 'data'),
    PACKAGES_DIR: path.join(sandbox, 'packages'),
    UPLOAD_TMP_DIR: path.join(sandbox, 'data', 'tmp'),
    RATE_LIMIT_DISABLED: '1',
    DB_FILE: path.join(sandbox, 'registry.db'),
    REGISTRY_URL: 'http://127.0.0.1:3999',
    STAGE_OVERRIDES_FILE: overridesFile,
    GITHUB_OAUTH_CLIENT_ID: undefined,
    GITHUB_OAUTH_CLIENT_SECRET: undefined,
    TOKENS_FILE: undefined,
    API_KEY: undefined,
  })) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let first;
  try {
    const config = loadConfig();
    first = createApp(config);
    const applied = first.locals.registry.admin.recentAudit(10)
      .filter((row) => row.action === 'stage.override.applied');
    assert.equal(applied.length, 1, 'boot audits the applied overrides');
    assert.match(applied[0].detail, /^commit=abc123 entries=2/);
    assert.equal(applied[0].actor_login, 'system');

    // A second boot with the same source revision does not duplicate the row.
    const second = createApp(config);
    const rows = second.locals.registry.admin.recentAudit(10)
      .filter((row) => row.action === 'stage.override.applied');
    assert.equal(rows.length, 1, 'the same commit is not audited twice');
    second.locals.registry.db.close();
  } finally {
    try { first?.locals.registry.db.close(); } catch { /* already closed */ }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
});
