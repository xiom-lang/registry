// XIOM Package Registry -- token admin CLI tests.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'tokens.js');

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function seed(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-tokens-'));
  const file = path.join(dir, 'tokens.json');
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  return file;
}

const ENTRY = (label, token, extra = {}) => ({
  token, label, scopes: [label], trusted: false, firstParty: false, ...extra,
});

test('list shows labels and policy but never token values', () => {
  const file = seed([
    ENTRY('alice', 'a'.repeat(64)),
    ENTRY('xiom-hello', 'b'.repeat(64), { scopes: ['xiom.hello'], trusted: true, firstParty: true }),
  ]);
  const result = run(['list', '--file', file]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[0\] label=alice scopes=alice trusted=false firstParty=false/);
  assert.match(result.stdout, /\[1\] label=xiom-hello scopes=xiom\.hello trusted=true firstParty=true/);
  assert.doesNotMatch(result.stdout, /a{16}/);
  assert.doesNotMatch(result.stdout, /b{16}/);
});

test('remove takes out every entry with the label and keeps the rest', () => {
  const file = seed([
    ENTRY('staging', 'a'.repeat(64)),
    ENTRY('staging', 'b'.repeat(64)),
    ENTRY('staging', 'c'.repeat(64)),
    ENTRY('xiom-hello', 'd'.repeat(64)),
  ]);
  const result = run(['remove', '--file', file, '--label', 'staging']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Removed 3 entries for label "staging"; 1 token\(s\) remain/);
  const entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'xiom-hello');
});

test('remove fails loudly when the label is absent and leaves the file alone', () => {
  const file = seed([ENTRY('alice', 'a'.repeat(64))]);
  const before = fs.readFileSync(file, 'utf-8');
  const result = run(['remove', '--file', file, '--label', 'bob']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /label not found: bob/);
  assert.equal(fs.readFileSync(file, 'utf-8'), before);
});

test('rotate replaces all entries for the label with exactly one fresh token', () => {
  const file = seed([
    ENTRY('staging', 'a'.repeat(64)),
    ENTRY('staging', 'b'.repeat(64)),
    ENTRY('other', 'c'.repeat(64)),
  ]);
  const result = run([
    'rotate', '--file', file, '--label', 'staging',
    '--scopes', '*', '--trusted', '--first-party',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Rotated label "staging".*\(2 old entries replaced\)/);

  const entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const staging = entries.filter((e) => e.label === 'staging');
  assert.equal(staging.length, 1, 'exactly one staging token remains');
  assert.notEqual(staging[0].token, 'a'.repeat(64));
  assert.notEqual(staging[0].token, 'b'.repeat(64));
  assert.deepEqual(staging[0].scopes, ['*']);
  assert.equal(staging[0].trusted, true);
  assert.equal(staging[0].firstParty, true);
  assert.equal(entries.filter((e) => e.label === 'other').length, 1, 'other labels untouched');

  const printed = new RegExp(`token: +${staging[0].token}`);
  assert.match(result.stdout, printed, 'the new value is printed exactly once');
  assert.equal(result.stdout.match(new RegExp(staging[0].token, 'g')).length, 1);
});

test('atomic write leaves no temp file behind', () => {
  const file = seed([ENTRY('alice', 'a'.repeat(64))]);
  run(['rotate', '--file', file, '--label', 'alice', '--scopes', 'alice']);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('invalid JSON is refused before any write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiom-tokens-bad-'));
  const file = path.join(dir, 'tokens.json');
  fs.writeFileSync(file, '{ not json');
  const result = run(['add', '--file', file, '--label', 'alice']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf-8'), '{ not json');
});
