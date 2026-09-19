// XIOM Package Registry -- token generator behavior tests.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'keygen.js');

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function tempOut() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-keygen-'));
  return path.join(dir, 'tokens.json');
}

test('appends and warns when the label already exists', () => {
  const out = tempOut();
  assert.equal(run(['--label', 'alice', '--out', out]).status, 0);

  const second = run(['--label', 'alice', '--out', out]);
  assert.equal(second.status, 0, 'append is the documented rotation path, not an error');
  assert.match(second.stderr, /WARNING: label "alice" already exists \(1 entry\)/);
  assert.match(second.stderr, /Only the last entry for a label/);

  const entries = JSON.parse(fs.readFileSync(out, 'utf-8'));
  assert.equal(entries.length, 2, 'both tokens remain until the operator removes the old one');
  assert.equal(entries[1].label, 'alice');
});

test('does not warn for a fresh label or with --replace', () => {
  const out = tempOut();
  const fresh = run(['--label', 'bob', '--out', out]);
  assert.doesNotMatch(fresh.stderr, /WARNING/);

  run(['--label', 'bob', '--out', out]);
  const replaced = run(['--label', 'bob', '--out', out, '--replace']);
  assert.doesNotMatch(replaced.stderr, /WARNING/);

  const entries = JSON.parse(fs.readFileSync(out, 'utf-8'));
  assert.equal(entries.length, 1, '--replace empties the file first');
  assert.match(replaced.stdout, /Token written to .* \(replaced\)/);
});

test('writes the full token record with scope and policy flags', () => {
  const out = tempOut();
  const result = run([
    '--label', 'ci', '--scopes', 'xiom.hello,xiom.std', '--trusted', '--first-party',
    '--out', out,
  ]);
  assert.equal(result.status, 0);
  const [entry] = JSON.parse(fs.readFileSync(out, 'utf-8'));
  assert.equal(entry.label, 'ci');
  assert.deepEqual(entry.scopes, ['xiom.hello', 'xiom.std']);
  assert.equal(entry.trusted, true);
  assert.equal(entry.firstParty, true);
  assert.match(entry.token, /^[0-9a-f]{64}$/);
  assert.match(result.stdout, new RegExp(`token:      ${entry.token}`));
});
