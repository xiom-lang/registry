// XIOM Package Registry -- HTML layout and formatting helpers for the web UI.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const SITE_NAME = 'XIOM Registry';
const SITE_DESCRIPTION = 'The package registry for XIOM -- browse packages, versions, and signatures.';

/** Escape untrusted text for interpolation into HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Human-readable byte size. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** ISO timestamp -> '2026-09-16 00:00 UTC' (empty input renders as '--'). */
function formatDate(iso) {
  if (typeof iso !== 'string' || iso === '') return '--';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`
    + ` ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`;
}

/** First 12 hex chars of a digest, for table cells. */
function shortHex(hex, length = 12) {
  if (typeof hex !== 'string' || hex === '') return '--';
  return hex.length <= length ? hex : `${hex.slice(0, length)}...`;
}

/** Short ed25519 key fingerprint, mirroring the client's format. */
function fingerprint(publicKeyHex) {
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length < 16) return '';
  const bytes = publicKeyHex.slice(0, 16).match(/.{2}/g) || [];
  return bytes.join(':');
}

/**
 * Full HTML document. `body` is trusted markup built by the page builders;
 * every value interpolated into it must pass through escapeHtml first.
 */
function layout({ title, description = SITE_DESCRIPTION, body }) {
  const pageTitle = title ? `${escapeHtml(title)} -- ${SITE_NAME}` : SITE_NAME;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="48x48" href="/ui/favicon.png">
<link rel="apple-touch-icon" href="/ui/icon.png">
<link rel="stylesheet" href="/ui/registry.css">
</head>
<body>
<header class="site-header">
  <div class="container">
    <a class="brand" href="/">
      <img class="brand-logo" src="/ui/logo.png" alt="" width="24" height="24">
      XIOM <span>Registry</span>
    </a>
    <nav>
      <a href="/packages">Packages</a>
      <a href="/search">Search</a>
      <a href="https://github.com/xiom-lang/registry/blob/main/PUBLISHING.md">Publish</a>
      <a href="https://xiom-lang.org/docs/">Docs</a>
      <a href="https://xiom-lang.org">xiom-lang.org</a>
      <a href="https://github.com/xiom-lang/registry">GitHub</a>
    </nav>
  </div>
</header>
<main>
  <div class="container">
${body}
  </div>
</main>
<footer class="site-footer">
  <div class="container">
    <span>${SITE_NAME} -- MIT OR Apache-2.0 -- XIOM Foundation</span>
    <span class="spacer"></span>
    <a href="https://github.com/xiom-lang/registry/blob/main/USING.md">Using the registry</a>
    <a href="https://github.com/xiom-lang/registry/blob/main/PUBLISHING.md">Publishing</a>
    <a href="/index.json">index.json</a>
    <a href="/health">health</a>
    <a href="https://xiom-lang.org">xiom-lang.org</a>
  </div>
  <div class="container legal">
    <span>Terms of Use: <a href="https://xiom-lang.org/terms.html">xiom-lang.org/terms.html</a></span>
    <span>&middot;</span>
    <span>Privacy: <a href="https://xiom-lang.org/privacy.html">xiom-lang.org/privacy.html</a></span>
    <span>&middot;</span>
    <span><a href="mailto:support@xiom-lang.org">support@xiom-lang.org</a></span>
  </div>
</footer>
</body>
</html>
`;
}

module.exports = {
  SITE_NAME,
  escapeHtml,
  formatBytes,
  formatDate,
  shortHex,
  fingerprint,
  layout,
};
