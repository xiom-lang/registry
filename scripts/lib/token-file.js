// XIOM Package Registry -- token-file IO shared by keygen and the admin CLI.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read a token file. Accepts the canonical array form and the legacy
 * {tokens: [...]} / {tokens: {...}} shapes; returns [] when absent.
 * Throws on unreadable/invalid content so callers can fail loudly before a
 * container recreate turns a bad edit into a crash loop.
 */
function loadTokens(file) {
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.tokens)) return parsed.tokens;
  if (parsed && parsed.tokens && typeof parsed.tokens === 'object') {
    return Object.entries(parsed.tokens).map(([token, cfg]) => ({ token, ...(cfg || {}) }));
  }
  throw new Error(`${file}: expected a token array or {"tokens": ...}`);
}

/** Atomically write the token file (tmp + rename, same directory). */
function saveTokens(file, tokens) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

/** The non-secret shape of an entry, for list output and logs. */
function summarize(entry) {
  return {
    label: typeof entry.label === 'string' ? entry.label : '',
    scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
    trusted: Boolean(entry.trusted),
    firstParty: Boolean(entry.firstParty),
  };
}

module.exports = { loadTokens, saveTokens, summarize };
