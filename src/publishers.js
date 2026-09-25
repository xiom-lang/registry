// XIOM Package Registry -- trusted GitHub publishers (OIDC claim mapping).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// A trusted publisher maps GitHub claims (repository + workflow + ref) to a
// token shape with fixed scopes. Claims only *select* an entry; they can
// never widen its scopes. Malformed configuration fails at startup, and
// ambiguous entries (same repository + workflow twice) are rejected so a
// request can never be matched against two different scope grants.

'use strict';

const fs = require('fs');

const MAX_CONFIG_BYTES = 1024 * 1024;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PREFIX = '.github/workflows/';

/**
 * `ns.*` is normalized to the `ns` prefix form, matching the static-token
 * semantics in tokens.js (`tokenMayPublish`): `xiom` grants `xiom.core`, and
 * a bare `xiom` scope never grants the unrelated hyphen namespace.
 */
function normalizeScope(scope) {
  const value = String(scope).trim();
  return value.endsWith('.*') ? value.slice(0, -2) : value;
}

function normalizeWorkflow(value) {
  const workflow = String(value).trim().replace(/^\.\//, '');
  return workflow.startsWith(WORKFLOW_PREFIX)
    ? workflow.slice(WORKFLOW_PREFIX.length)
    : workflow;
}

/** Workflow fields are file names (`publish-registry.yml`), never refs. */
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.(yml|yaml)$/;

function isWorkflowFile(value) {
  return WORKFLOW_FILE.test(normalizeWorkflow(String(value || '')));
}

/** Extract `sub/dir/file.yml` from `owner/repo/.github/workflows/file.yml@ref`. */
function workflowFileFromRef(workflowRef) {
  if (typeof workflowRef !== 'string') return null;
  const at = workflowRef.indexOf('@');
  const withoutRef = at === -1 ? workflowRef : workflowRef.slice(0, at);
  const idx = withoutRef.indexOf(`/${WORKFLOW_PREFIX}`);
  if (idx === -1) return null;
  return withoutRef.slice(idx + WORKFLOW_PREFIX.length + 1);
}

/** Refs globs: `*` and `?` match within one path segment, never across `/`. */
function globToRegExp(pattern) {
  let body = '^';
  for (const ch of pattern) {
    if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${body}$`);
}

function assertString(value, what, source) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${source}: ${what} must be a non-empty string`);
  }
  return value.trim();
}

function defaultEvents(refs) {
  const events = new Set();
  for (const ref of refs) {
    if (ref.startsWith('refs/tags/')) {
      events.add('push');
      events.add('release');
    }
    if (ref.startsWith('refs/heads/')) {
      events.add('workflow_dispatch');
      events.add('push');
    }
  }
  return [...events];
}

/**
 * Validate and normalize one trusted-publisher entry.
 * @returns {{ label: string, repository: string, workflow: string,
 *             refs: string[], refMatchers: RegExp[], scopes: string[],
 *             firstParty: boolean, events: string[] }}
 */
function normalizeEntry(entry, source, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${source}: publisher entries must be objects`);
  }
  const label = typeof entry.label === 'string' && entry.label.trim()
    ? entry.label.trim()
    : `publisher-${index + 1}`;

  const repository = assertString(entry.repository, `${label}: repository`, source);
  if (repository.includes('*')) {
    throw new Error(`${source}: ${label}: repository wildcards are not allowed (got "${repository}")`);
  }
  if (!REPOSITORY.test(repository)) {
    throw new Error(`${source}: ${label}: repository must be "owner/repo" (got "${repository}")`);
  }

  const workflow = normalizeWorkflow(assertString(entry.workflow, `${label}: workflow`, source));
  if (workflow.includes('..')) {
    throw new Error(`${source}: ${label}: workflow path must not contain ".."`);
  }

  if (!Array.isArray(entry.refs) || entry.refs.length === 0) {
    throw new Error(`${source}: ${label}: refs must be a non-empty array`);
  }
  const refs = entry.refs.map((ref) => assertString(ref, `${label}: ref`, source));
  for (const ref of refs) {
    if (!ref.startsWith('refs/') || /\s/.test(ref)) {
      throw new Error(`${source}: ${label}: ref "${ref}" must start with "refs/" and contain no whitespace`);
    }
  }

  if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
    throw new Error(`${source}: ${label}: scopes must be a non-empty array`);
  }
  const scopes = entry.scopes.map(normalizeScope);
  for (const scope of scopes) {
    if (scope === '' || scope === '*') {
      throw new Error(`${source}: ${label}: scope "*" is not allowed for a trusted publisher`);
    }
  }

  const events = Array.isArray(entry.events) && entry.events.length > 0
    ? entry.events.map((event) => assertString(event, `${label}: event`, source))
    : defaultEvents(refs);

  return {
    label,
    repository,
    workflow,
    refs,
    refMatchers: refs.map(globToRegExp),
    scopes,
    firstParty: Boolean(entry.firstParty),
    events,
  };
}

/**
 * Normalize a whole publisher list. Accepts an array or `{ publishers: [] }`.
 */
function normalizePublishers(parsed, source) {
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.publishers) ? parsed.publishers : null);
  if (!entries) {
    throw new Error(`${source}: expected an array of publishers or {"publishers": [...]}`);
  }

  const normalized = entries.map((entry, index) => normalizeEntry(entry, source, index));
  const seen = new Map();
  for (const entry of normalized) {
    const key = `${entry.repository}\u0000${entry.workflow}`;
    if (seen.has(key)) {
      throw new Error(
        `${source}: "${entry.repository}" + "${entry.workflow}" is configured twice `
        + `(${seen.get(key)} and ${entry.label}); ambiguous publisher entries are not allowed`,
      );
    }
    seen.set(key, entry.label);
  }
  return normalized;
}

/**
 * Load the trusted-publishers config. `TRUSTED_PUBLISHERS_FILE` may be a path
 * or inline JSON (starting with `[` or `{`). A missing file means no trusted
 * publishers: OIDC tokens then get 403 while static tokens keep working.
 * Unreadable or malformed configuration throws so startup fails loudly.
 */
function loadTrustedPublishers(env = process.env) {
  const value = typeof env.TRUSTED_PUBLISHERS_FILE === 'string'
    ? env.TRUSTED_PUBLISHERS_FILE.trim()
    : '';
  if (!value) return [];

  if (value.startsWith('[') || value.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new Error(`TRUSTED_PUBLISHERS_FILE inline JSON is invalid: ${err.message}`);
    }
    return normalizePublishers(parsed, 'TRUSTED_PUBLISHERS_FILE (inline)');
  }

  let raw;
  try {
    const stat = fs.statSync(value);
    if (stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`file is larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    raw = fs.readFileSync(value, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`TRUSTED_PUBLISHERS_FILE ${value} cannot be read: ${err.message}`);
  }
  if (raw.trim() === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TRUSTED_PUBLISHERS_FILE ${value} is not valid JSON: ${err.message}`);
  }
  return normalizePublishers(parsed, `TRUSTED_PUBLISHERS_FILE ${value}`);
}

/**
 * Select the first entry that matches the token claims. Returns null when
 * nothing matches (the caller turns that into 403); claims select, never
 * widen.
 *
 * @param {{ repository: string, workflowRef: string, ref: string, event: string }} claims
 */
function matchPublisher(entries, claims) {
  const repository = typeof claims.repository === 'string' ? claims.repository : '';
  const ref = typeof claims.ref === 'string' ? claims.ref : '';
  const event = typeof claims.event === 'string' ? claims.event : '';
  const workflowFile = workflowFileFromRef(claims.workflowRef);

  for (const entry of entries) {
    if (entry.repository !== repository) continue;
    if (workflowFile === null || normalizeWorkflow(workflowFile) !== entry.workflow) continue;
    if (!entry.events.includes(event)) continue;
    if (!entry.refMatchers.some((matcher) => matcher.test(ref))) continue;
    return entry;
  }
  return null;
}

module.exports = {
  loadTrustedPublishers,
  normalizePublishers,
  normalizeScope,
  normalizeWorkflow,
  isWorkflowFile,
  workflowFileFromRef,
  matchPublisher,
};
