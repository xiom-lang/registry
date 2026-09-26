// XIOM Package Registry -- display formatting for the web UI.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Human-friendly presentation helpers. Everything here is server-rendered;
// relative timestamps carry the exact value in `title`/`datetime` so nothing
// is lost to a friendly label, and no client-side date library is needed.

'use strict';

const { escapeHtml, formatBytes, formatDate } = require('./layout');

/** Seconds in the units used by `formatWhen`. */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative label for an ISO timestamp: `just now`, `5 min ago`, `3 h ago`,
 * `2 d ago`; older than 30 days falls back to the exact UTC date. Always
 * returns a `<time>` element with `datetime` and a `title` holding the exact
 * value. Empty/invalid input renders as `--`.
 *
 * @param {string} iso ISO-8601 timestamp
 * @param {number} [nowMs] injectable clock for tests
 */
function formatWhen(iso, nowMs = Date.now()) {
  if (typeof iso !== 'string' || iso === '') return '--';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return escapeHtml(iso);
  const exact = escapeHtml(formatDate(iso));
  const seconds = Math.round(Math.abs(nowMs - parsed) / 1000);
  const future = parsed > nowMs;
  const suffix = future ? 'from now' : 'ago';
  let label;
  if (seconds < 45) label = 'just now';
  else if (seconds < 90) label = `1 min ${suffix}`;
  else if (seconds < HOUR) label = `${Math.round(seconds / MINUTE)} min ${suffix}`;
  else if (seconds < DAY) label = `${Math.round(seconds / HOUR)} h ${suffix}`;
  else if (seconds < 30 * DAY) label = `${Math.round(seconds / DAY)} d ${suffix}`;
  else label = exact;
  return `<time datetime="${escapeHtml(iso)}" title="${exact}">${label}</time>`;
}

/**
 * Display-only shortening for opaque identifiers (`req_...`, `rep_...`).
 * Keeps the type prefix readable and puts the full value in `title`.
 */
function shortId(id, head = 11) {
  const value = String(id ?? '');
  if (value === '') return '--';
  if (value.length <= head + 3) return `<code class="mono">${escapeHtml(value)}</code>`;
  return `<code class="mono" title="${escapeHtml(value)}">`
    + `${escapeHtml(value.slice(0, head))}&hellip;</code>`;
}

/**
 * Display-only shortening for hex digests. The full digest stays one hover
 * (or one `<details>` block) away; never render a 64-hex wall as the value.
 */
function shortDigest(hex, head = 12) {
  const value = String(hex ?? '');
  if (value === '') return '--';
  if (value.length <= head + 3) return `<code class="mono">${escapeHtml(value)}</code>`;
  return `<code class="mono" title="${escapeHtml(value)}">`
    + `${escapeHtml(value.slice(0, head))}&hellip;</code>`;
}

/** `https://github.com/you/repo` -> `you/repo`; other URLs stay whole. */
function repoLabel(url) {
  const value = String(url ?? '').trim();
  if (value === '') return '';
  const match = value.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return match ? match[1] : value;
}

module.exports = {
  formatWhen,
  formatBytes,
  formatDate,
  escapeHtml,
  shortId,
  shortDigest,
  repoLabel,
};
