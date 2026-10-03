// XIOM Package Registry -- naming guard (registry 2.9.x, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The door check for publish scopes: every token or trusted-publisher
// request validates its scopes before it is queued, and the admin approval
// re-runs the same checks (state may have changed) plus a hard scope-overlap
// check against live grants. Three severities:
//
//   errors   -- never allowed: invalid names, the reserved first-party
//               namespace, a scope that already covers a published package,
//               and names that differ from a published one only by dots vs
//               hyphens (search treats those as equivalent, so they are
//               impossible to tell apart in practice).
//   warnings -- lookalike names (edit distance), names mentioning "xiom":
//               allowed, but recorded on the request and acknowledged by the
//               admin at approval.
//   overlaps -- a scope that overlaps another live grant's scope. Advisory at
//               request time, a hard error at approval: no two grants may
//               hold the same name or namespace.
//
// Pure functions only; the caller supplies the index and the live grants.

'use strict';

const {
  validatePackageName,
  isFirstPartyNamespace,
  FIRST_PARTY_NAMESPACE,
} = require('./names');

/** Dots and hyphens are equivalent to a human reader (and to search). */
function separatorKey(name) {
  return String(name || '').toLowerCase().replace(/[-.]/g, '.');
}

/** True when `scope` grants publishing `name` (mirrors tokens.tokenMayPublish). */
function scopeCovers(scope, name) {
  if (scope === '*') return true;
  if (name === scope) return true;
  return name.startsWith(`${scope}.`);
}

function scopesOverlap(a, b) {
  if (a === '*' || b === '*') return true;
  return scopeCovers(a, b) || scopeCovers(b, a) || separatorKey(a) === separatorKey(b);
}

/** Bounded Levenshtein; names are short, so the O(n*m) table is fine. */
function editDistance(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 2) return 99;
  const previous = new Array(right.length + 1);
  const current = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j++) previous[j] = current[j];
  }
  return previous[right.length];
}

const unique = (list) => [...new Set(list)];

/**
 * Check a proposed scope list.
 *
 * @param {{ scopes: string[], index: object, grants?: Array<{label: string, scopes: string[]}>,
 *           ownScopes?: string[], maintainerNames?: Set<string>, firstParty?: boolean }} input
 *   `grants` are live scopes to check overlap against (publisher entries and
 *   non-first-party static tokens); first-party (`*`) grants are excluded by
 *   the caller because they cover everything by design. `ownScopes` are the
 *   scopes the requester already legitimately holds (publisher edits), so
 *   their own published packages are not reported as taken. `maintainerNames`
 *   are the published packages the requester is a listed maintainer of:
 *   only they may request publish rights over an existing package.
 * @returns {{ errors: string[], warnings: string[], overlaps: string[] }}
 */
function checkScopes({
  scopes = [],
  index = null,
  grants = [],
  ownScopes = [],
  maintainerNames = new Set(),
  firstParty = false,
} = {}) {
  const errors = [];
  const warnings = [];
  const overlaps = [];
  const published = Object.keys((index && index.packages) || {});
  const maintained = (name) => maintainerNames instanceof Set
    ? maintainerNames.has(name)
    : Array.isArray(maintainerNames) && maintainerNames.includes(name);
  const owned = (name) => ownScopes.some(
    (scope) => scopeCovers(scope, name) || separatorKey(scope) === separatorKey(name),
  );

  for (const scope of scopes) {
    try {
      validatePackageName(scope);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (isFirstPartyNamespace(scope) && !firstParty) {
      errors.push(
        `"${scope}" is in the reserved first-party namespace; only the XIOM Authors can publish there`,
      );
      continue;
    }
    const covered = published.filter((name) => scopeCovers(scope, name) && !owned(name));
    if (covered.length > 0) {
      const strangers = covered.filter((name) => !maintained(name));
      if (strangers.length > 0) {
        errors.push(
          `"${strangers[0]}" is already published; only its maintainers can request publish `
          + 'rights for it (claim maintainership first, then request)',
        );
        continue;
      }
      // Every covered package is the requester's own: a deliberate
      // co-publisher grant over a published package, surfaced for the admin.
      warnings.push(
        `"${scope}" covers your existing package${covered.length === 1 ? '' : 's'} `
        + `"${covered[0]}"; this grants publish rights over a published package`,
      );
      continue;
    }
    const key = separatorKey(scope);
    const twin = published.find((name) => separatorKey(name) === key && !owned(name));
    if (twin) {
      errors.push(
        `"${scope}" differs from published "${twin}" only by dots and hyphens; `
        + 'readers (and search) cannot tell them apart -- pick a distinct name',
      );
      continue;
    }

    // Warnings: lookalikes and mentions of the official namespace.
    const lookalike = published.find((name) => {
      const distance = editDistance(key, separatorKey(name));
      return distance === 1 || (distance === 2 && key.length >= 8);
    });
    if (lookalike) {
      warnings.push(`"${scope}" looks like published "${lookalike}"`);
    }
    if (String(scope).includes(FIRST_PARTY_NAMESPACE)) {
      warnings.push(`"${scope}" mentions "xiom"; readers may confuse it with official packages`);
    }

    // Overlap with live grants (advisory here, enforced at approval).
    for (const grant of grants) {
      const holder = String(grant.label || 'another grant');
      if ((grant.scopes || []).some((other) => scopesOverlap(scope, other))) {
        overlaps.push(`"${scope}" overlaps the scope of ${holder}`);
      }
    }
  }

  return { errors: unique(errors), warnings: unique(warnings), overlaps: unique(overlaps) };
}

module.exports = {
  checkScopes,
  scopeCovers,
  scopesOverlap,
  separatorKey,
  editDistance,
};
