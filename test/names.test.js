// XIOM Package Registry -- package name and namespace policy tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePackageName,
  isFirstPartyNamespace,
  assertNamespaceAllowed,
} = require('../src/names');
const { BadRequestError, ForbiddenError } = require('../src/errors');

test('accepts DNS-ish names', () => {
  for (const name of ['xiom', 'xiom.core', 'my-lib', 'a', 'a1.b2-c3', 'some.deep.nested.name']) {
    assert.equal(validatePackageName(name), name);
  }
});

test('rejects uppercase, underscores, and empty segments', () => {
  for (const name of ['X', 'MyLib', 'my_lib', '.hidden', 'trailing.', 'a..b', '-lead', 'a-']) {
    assert.throws(() => validatePackageName(name), BadRequestError, `expected rejection: ${name}`);
  }
});

test('rejects double hyphens and hyphens adjacent to dots', () => {
  for (const name of ['a--b', 'a-.b', 'a.-b']) {
    assert.throws(() => validatePackageName(name), BadRequestError, `expected rejection: ${name}`);
  }
  assert.equal(validatePackageName('a-b.c-d'), 'a-b.c-d');
});

test('rejects empty, non-string, and overlong names', () => {
  assert.throws(() => validatePackageName(''), BadRequestError);
  assert.throws(() => validatePackageName(undefined), BadRequestError);
  assert.throws(() => validatePackageName('a'.repeat(200)), BadRequestError);
  assert.throws(() => validatePackageName(`${'a'.repeat(65)}.b`), BadRequestError);
});

test('rejects Windows reserved segments', () => {
  for (const name of ['con', 'com1', 'lpt9', 'a.nul', 'prn.b']) {
    assert.throws(() => validatePackageName(name), BadRequestError, name);
  }
  // Substrings are fine.
  assert.equal(validatePackageName('console'), 'console');
});

test('first-party namespace detection', () => {
  assert.equal(isFirstPartyNamespace('xiom'), true);
  assert.equal(isFirstPartyNamespace('xiom.core'), true);
  // The hyphen form is reserved too: the packages monorepo ships xiom-* names
  // and a community token publishing xiom-core would look official.
  assert.equal(isFirstPartyNamespace('xiom-core'), true);
  assert.equal(isFirstPartyNamespace('xiom-l10n-date'), true);
  assert.equal(isFirstPartyNamespace('xiomcore'), false);
  assert.equal(isFirstPartyNamespace('my.xiom.core'), false);
  assert.equal(isFirstPartyNamespace('my-xiom-lib'), false);
});

test('namespace policy allows first-party tokens only', () => {
  const firstParty = { firstParty: true, label: 'fp' };
  const community = { firstParty: false, label: 'community' };

  assert.doesNotThrow(() => assertNamespaceAllowed('xiom.core', firstParty));
  assert.doesNotThrow(() => assertNamespaceAllowed('xiom-core', firstParty));
  assert.doesNotThrow(() => assertNamespaceAllowed('my-lib', community));
  assert.throws(() => assertNamespaceAllowed('xiom.core', community), ForbiddenError);
  assert.throws(() => assertNamespaceAllowed('xiom-core', community), ForbiddenError);
  assert.throws(() => assertNamespaceAllowed('xiom', community), ForbiddenError);
});
