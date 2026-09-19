// XIOM Package Registry -- package name and namespace policy.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const { BadRequestError, ForbiddenError } = require('./errors');

/**
 * Package names are DNS-ish: lowercase, dot-separated segments, each starting
 * with a letter and ending with a letter or digit (no trailing hyphen, no
 * double hyphen). The first-party `xiom.*` namespace is reserved for XIOM
 * Foundation tokens (SESSION.md section 2.4, T6).
 *
 * Deliberately stricter than the legacy server regex: uppercase, `_`, and
 * leading/trailing separators are refused. Client-published packages are
 * already lowercase-kebab in practice; the legacy seed index is normalized
 * on read (index.js) rather than at publish time.
 */
const SEGMENT = '[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*';
const NAME_PATTERN = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`);
const MAX_NAME_LENGTH = 128;
const MAX_SEGMENT_LENGTH = 64;

/** Windows device names cannot be directory names on Windows hosts. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const FIRST_PARTY_NAMESPACE = 'xiom';

/**
 * Validate a package name. Throws BadRequestError on the first violation.
 * Returns the normalized name (already lowercase; no transformation applied).
 *
 * @param {string} name
 * @returns {string}
 */
function validatePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestError('package name is required', 'invalid_name');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError(
      `package name is too long (max ${MAX_NAME_LENGTH} characters)`,
      'invalid_name',
    );
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    throw new BadRequestError('package name must not start or end with a dot', 'invalid_name');
  }
  if (name.includes('..')) {
    throw new BadRequestError('package name must not contain empty segments ("..")', 'invalid_name');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new BadRequestError(
      'invalid package name: use lowercase dot-separated segments of '
      + 'letters, digits, and hyphens, each starting with a letter '
      + '(e.g. "xiom.core" or "my-lib")',
      'invalid_name',
    );
  }
  for (const segment of name.split('.')) {
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new BadRequestError(
        `package name segment "${segment}" is too long (max ${MAX_SEGMENT_LENGTH})`,
        'invalid_name',
      );
    }
    if (WINDOWS_RESERVED.has(segment)) {
      throw new BadRequestError(
        `package name segment "${segment}" is a reserved system name`,
        'invalid_name',
      );
    }
  }
  return name;
}

/**
 * True when the name belongs to the first-party namespace (including the
 * bare `xiom` package). Both separator forms are reserved:
 *   - `xiom.core`, `xiom.l10n.date` (the dotted official namespace)
 *   - `xiom-core` (the hyphen form shipped in the packages monorepo)
 * `xiomcore` is NOT first-party (no separator), and neither is a name that
 * merely contains `xiom`, e.g. `my.xiom.core`.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isFirstPartyNamespace(name) {
  return name === FIRST_PARTY_NAMESPACE
    || name.startsWith(`${FIRST_PARTY_NAMESPACE}.`)
    || name.startsWith(`${FIRST_PARTY_NAMESPACE}-`);
}

/**
 * Enforce namespace ownership. Tokens with `firstParty: true` may publish
 * anywhere; every other token is confined to non-reserved namespaces.
 *
 * @param {string} name validated package name
 * @param {{ firstParty?: boolean, label?: string }} token
 */
function assertNamespaceAllowed(name, token) {
  if (isFirstPartyNamespace(name) && !token.firstParty) {
    throw new ForbiddenError(
      `package "${name}" is in the reserved "${FIRST_PARTY_NAMESPACE}.*" / `
      + `"${FIRST_PARTY_NAMESPACE}-*" namespace; only first-party tokens may publish it`,
      'reserved_namespace',
    );
  }
}

module.exports = {
  validatePackageName,
  isFirstPartyNamespace,
  assertNamespaceAllowed,
  FIRST_PARTY_NAMESPACE,
  MAX_NAME_LENGTH,
};
