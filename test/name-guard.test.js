// XIOM Package Registry -- naming guard tests (registry 2.9.x).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The door check for publish scopes: hard errors, lookalike warnings, and
// scope-overlap detection (advisory at the door, enforced at approval).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkScopes,
  scopeCovers,
  scopesOverlap,
  separatorKey,
  editDistance,
} = require('../src/name-guard');

const INDEX = {
  packages: {
    'readme-pkg': { versions: {} },
    'acme.csv': { versions: {} },
    'acme.csv-tools': { versions: {} },
  },
};

test('scope matching is boundary-aware and separator-equivalent only for humans', () => {
  assert.equal(scopeCovers('*', 'anything.at.all'), true);
  assert.equal(scopeCovers('acme.csv', 'acme.csv'), true);
  assert.equal(scopeCovers('acme.csv', 'acme.csv.tools'), true);
  assert.equal(scopeCovers('acme.csv', 'acme.csv-tools'), false, 'hyphen is not a namespace boundary');
  assert.equal(scopesOverlap('acme.csv-tools', 'acme.csv.tools'), true, 'dots and hyphens are equivalent to readers');
  assert.equal(scopesOverlap('acme.csv', 'acme.csv-tools'), false, 'a suffix is not a twin');
  assert.equal(scopesOverlap('acme.csv', 'acme.other'), false);
  assert.equal(separatorKey('Readme-Pkg'), 'readme.pkg');
  assert.equal(editDistance('readme.pk', 'readme.pkg'), 1);
  assert.equal(editDistance('alpha', 'alphabetical'), 99, 'a large length gap short-circuits');
});

test('the door refuses invalid, reserved, taken, and separator-twin scopes', () => {
  const invalid = checkScopes({ scopes: ['Bad_Name'], index: INDEX });
  assert.match(invalid.errors[0], /invalid package name/);

  const reserved = checkScopes({ scopes: ['xiom.new-thing'], index: INDEX });
  assert.match(reserved.errors[0], /reserved first-party namespace/);

  const taken = checkScopes({ scopes: ['acme.csv'], index: INDEX });
  assert.match(taken.errors[0], /is already published; only its maintainers/);

  const namespaceTaken = checkScopes({ scopes: ['acme'], index: INDEX });
  assert.match(namespaceTaken.errors[0], /"acme\.csv" is already published/);

  const twin = checkScopes({ scopes: ['readme.pkg'], index: INDEX });
  assert.match(twin.errors[0], /differs from published "readme-pkg" only by dots and hyphens/);

  const clean = checkScopes({ scopes: ['fresh-tool'], index: INDEX });
  assert.deepEqual(clean, { errors: [], warnings: [], overlaps: [] });
});

test('own scopes keep a publisher edit from flagging its own packages', () => {
  const withoutOwn = checkScopes({ scopes: ['acme.csv'], index: INDEX });
  assert.equal(withoutOwn.errors.length, 1);
  const withOwn = checkScopes({ scopes: ['acme.csv'], index: INDEX, ownScopes: ['acme.csv'] });
  assert.deepEqual(withOwn.errors, [], 'editing an entry may keep its own scope');
  const twinOwned = checkScopes({ scopes: ['acme.csv-tools'], index: INDEX, ownScopes: ['acme.csv.tools'] });
  assert.deepEqual(twinOwned.errors, []);
});

test('only a package maintainer may request publish rights over it', () => {
  const mine = checkScopes({
    scopes: ['readme-pkg'],
    index: INDEX,
    maintainerNames: new Set(['readme-pkg']),
  });
  assert.deepEqual(mine.errors, [], 'a listed maintainer may request rights over their package');
  assert.match(mine.warnings[0], /covers your existing package "readme-pkg"/);

  const mixed = checkScopes({
    scopes: ['acme'],
    index: INDEX,
    maintainerNames: new Set(['acme.csv']),
  });
  assert.match(mixed.errors[0], /"acme\.csv-tools" is already published/, 'mixed namespaces still refuse');
});

test('lookalikes and xiom mentions become advisories, not blocks', () => {
  const lookalike = checkScopes({ scopes: ['readme-pk'], index: INDEX });
  assert.deepEqual(lookalike.errors, []);
  assert.match(lookalike.warnings[0], /looks like published "readme-pkg"/);

  const mentions = checkScopes({ scopes: ['my-xiom-tools'], index: INDEX });
  assert.match(mentions.warnings[0], /mentions "xiom"/);
});

test('scope overlap with live grants is reported for the approval gate', () => {
  const grants = [
    { label: 'trusted publisher alice/acme', scopes: ['acme.csv'] },
    { label: 'token "carol"', scopes: ['carol'] },
  ];
  const overlap = checkScopes({ scopes: ['acme.csv.extra'], index: INDEX, grants });
  assert.match(overlap.overlaps[0], /overlaps the scope of trusted publisher alice\/acme/);

  const namespaceOverlap = checkScopes({ scopes: ['carol.notes'], index: INDEX, grants });
  assert.match(namespaceOverlap.overlaps[0], /overlaps the scope of token "carol"/);

  const separatorOverlap = checkScopes({ scopes: ['acme.csv.tools'], index: {}, grants: [{ label: 'g', scopes: ['acme.csv-tools'] }] });
  assert.equal(separatorOverlap.overlaps.length, 1, 'hyphen twins overlap too');
});
