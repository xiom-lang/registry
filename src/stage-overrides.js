// XIOM Package Registry -- audited display-stage overrides (registry 2.1).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// SESSION.md 21.4. Entries published before the publisher workflow stamped
// the manifest carry no stage, so their badge falls back to the trust art.
// This file fills that gap from the publisher repo's STATUS.json files, at a
// pinned commit, reviewed as a PR -- never hand-edited per entry.
//
// STRICTLY DISPLAY-ONLY. Nothing here may influence publish authorization,
// OIDC/publisher matching, token scopes, readiness gates, or the index
// protocol; the UI is the only reader. A stage from a real publish (package
// or version level) always wins; an override only fills entries that have
// none. Excluded fixtures are dropped even if a bad file lists them.

'use strict';

const fs = require('fs');

const { STAGES } = require('./categories');

/** Names that must never receive a display stage (fixtures / stdlib-owned). */
const EXCLUDED_PACKAGES = Object.freeze(['xiom.staging-e2e-probe', 'xiom.std']);
const MAX_OVERRIDES = 2000;
const MAX_OVERRIDES_BYTES = 512 * 1024;
const SAFE_PACKAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const STAGE_SET = new Set(STAGES);
const EXCLUDED_SET = new Set(EXCLUDED_PACKAGES);

/**
 * Load and validate the stage-override file. Never throws: a missing,
 * corrupt, or oversized file yields an empty map so the registry boots and
 * the badges simply keep the published stage.
 *
 * @param {{ path: string, maxBytes?: number }} options
 * @returns {{ overrides: Map<string, string>, source: object|null, warnings: string[] }}
 */
function loadStageOverrides({ path, maxBytes = MAX_OVERRIDES_BYTES }) {
  const result = { overrides: new Map(), source: null, warnings: [] };
  let raw = '';
  try {
    raw = fs.readFileSync(path, 'utf-8');
  } catch {
    result.warnings.push(`stage overrides not found at ${path}`);
    return result;
  }
  if (Buffer.byteLength(raw, 'utf-8') > maxBytes) {
    result.warnings.push(`stage overrides exceed ${maxBytes} bytes; ignoring the file`);
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.warnings.push(`stage overrides are corrupt JSON (${err.message}); ignoring the file`);
    return result;
  }
  const entries = parsed && typeof parsed === 'object' && parsed.overrides
    && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
    ? parsed.overrides
    : {};
  let dropped = 0;
  let count = 0;
  for (const [name, stage] of Object.entries(entries)) {
    if (count >= MAX_OVERRIDES) {
      dropped += 1;
      continue;
    }
    if (!SAFE_PACKAGE_NAME.test(name) || !STAGE_SET.has(stage) || EXCLUDED_SET.has(name)) {
      dropped += 1;
      continue;
    }
    result.overrides.set(name, stage);
    count += 1;
  }
  if (dropped > 0) result.warnings.push(`stage overrides: dropped ${dropped} invalid or excluded entries`);
  if (parsed && typeof parsed === 'object' && parsed.source && typeof parsed.source === 'object') {
    result.source = {
      repository: typeof parsed.source.repository === 'string' ? parsed.source.repository : '',
      commit: typeof parsed.source.commit === 'string' ? parsed.source.commit : '',
      generatedAt: typeof parsed.source.generated_at === 'string' ? parsed.source.generated_at : '',
      why: typeof parsed.source.why === 'string' ? parsed.source.why : '',
    };
  }
  return result;
}

module.exports = {
  loadStageOverrides,
  EXCLUDED_PACKAGES,
  MAX_OVERRIDES,
  MAX_OVERRIDES_BYTES,
};
