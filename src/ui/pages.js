// XIOM Package Registry -- page builders for the read-only web UI.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Server-rendered, no client-side framework and no build step. Every value
// that comes from the index passes through escapeHtml; the pages link to the
// JSON endpoints so the UI and the protocol never diverge.

'use strict';

const {
  escapeHtml,
  formatBytes,
  formatDate,
  shortHex,
  fingerprint,
  layout,
} = require('./layout');

/** Card used on the home and search pages. */
function packageCard(name, pkg) {
  const latest = pkg.latest ? `<span class="pkg-version">${escapeHtml(pkg.latest)}</span>` : '';
  const description = pkg.description
    ? `<p class="pkg-desc">${escapeHtml(pkg.description)}</p>`
    : '';
  const versions = Object.keys(pkg.versions).length;
  return `<li class="package-card">
  <div class="pkg-head">
    <a class="pkg-name" href="/packages/${encodeURIComponent(name)}">${escapeHtml(name)}</a>
    ${latest}
  </div>
  ${description}
  <p class="pkg-meta">${versions} version${versions === 1 ? '' : 's'}</p>
</li>`;
}

function packageList(index) {
  const names = Object.keys(index.packages).sort();
  if (names.length === 0) {
    return '<div class="empty">No packages yet. Publish with <code>xiom pkg publish</code>.</div>';
  }
  const cards = names
    .map((name) => packageCard(name, index.packages[name]))
    .join('\n');
  return `<ul class="package-list">\n${cards}\n</ul>`;
}

function searchForm(query = '') {
  return `<form class="search-form" action="/search" method="get" role="search">
  <input id="q" name="q" type="search" value="${escapeHtml(query)}"
         placeholder="Search packages by name or description" aria-label="Search packages">
  <button type="submit">Search</button>
</form>`;
}

/** Home: registry overview plus the full package list. */
function homePage(index) {
  const names = Object.keys(index.packages);
  const lastUpdated = index.updated_at ? `Updated ${formatDate(index.updated_at)}` : 'No publishes yet';
  return layout({
    title: '',
    body: `<section class="hero">
  <h1>XIOM Registry</h1>
  <p>The package registry for XIOM. Browse packages, versions, and ed25519 signatures,
     or install directly: <code>xiom pkg install &lt;package&gt;</code>.</p>
  ${searchForm()}
  <div class="meta-row">
    <span>${names.length} package${names.length === 1 ? '' : 's'}</span>
    <span>Protocol ${escapeHtml(index.version)}</span>
    <span>${escapeHtml(lastUpdated)}</span>
  </div>
</section>
<h2>Packages</h2>
${packageList(index)}`,
  });
}

/** Search results (or the full list when the query is empty). */
function searchPage(index, query = '') {
  const needle = query.trim().toLowerCase();
  const matches = Object.entries(index.packages)
    .filter(([name, pkg]) => {
      if (needle === '') return true;
      return name.toLowerCase().includes(needle)
        || (pkg.description || '').toLowerCase().includes(needle);
    })
    .sort(([a], [b]) => a.localeCompare(b));

  const summary = needle === ''
    ? `${matches.length} package${matches.length === 1 ? '' : 's'}`
    : `${matches.length} result${matches.length === 1 ? '' : 's'} for "${query}"`;

  const list = matches.length === 0
    ? '<div class="empty">No packages match this search.</div>'
    : `<ul class="package-list">
${matches.map(([name, pkg]) => packageCard(name, pkg)).join('\n')}
</ul>`;

  return layout({
    title: 'Search',
    body: `<section class="hero">
  <h1>Search</h1>
  ${searchForm(query)}
  <div class="meta-row"><span>${escapeHtml(summary)}</span></div>
</section>
${list}`,
  });
}

function signatureCell(entry) {
  if (!entry.publicKey || !entry.signature) return '<span class="mono">--</span>';
  return `<span class="badge signed">signed</span> <span class="mono">${escapeHtml(fingerprint(entry.publicKey))}</span>`;
}

/** Package detail: metadata, install command, trust instructions, versions. */
function packagePage(pkg, registryUrl, selectedVersion = '') {
  const name = pkg.name;
  const names = Object.keys(pkg.versions);
  const detailVersion = selectedVersion && pkg.versions[selectedVersion]
    ? selectedVersion
    : (pkg.latest || names[names.length - 1] || '');
  const detail = pkg.versions[detailVersion] || null;

  const latestBadge = pkg.latest
    ? `<span class="badge">latest ${escapeHtml(pkg.latest)}</span>`
    : '<span class="badge yanked">no installable version</span>';
  const signedBadge = detail && detail.publicKey
    ? '<span class="badge signed">signed</span>'
    : '';

  const installTarget = pkg.latest ? name : `${name}@${detailVersion}`;
  const installNode = pkg.latest
    ? `<code>xiom pkg install ${escapeHtml(name)}</code>`
    : `<code>xiom pkg install ${escapeHtml(installTarget)}</code>`;

  const detailGrid = detail ? `<dl class="detail-grid">
  <div class="detail"><dt>Version</dt><dd>${escapeHtml(detailVersion)}</dd></div>
  <div class="detail"><dt>Published</dt><dd>${escapeHtml(formatDate(detail.published))}</dd></div>
  <div class="detail"><dt>Size</dt><dd>${escapeHtml(formatBytes(detail.size))}</dd></div>
  <div class="detail"><dt>SHA-256</dt><dd title="${escapeHtml(detail.sha256)}">${escapeHtml(detail.sha256 || '--')}</dd></div>
  <div class="detail"><dt>Signature</dt><dd>${signatureCell(detail)}</dd></div>
  ${pkg.repository ? `<div class="detail"><dt>Repository</dt><dd><a href="${escapeHtml(pkg.repository)}" rel="noopener">${escapeHtml(pkg.repository)}</a></dd></div>` : ''}
</dl>` : '';

  const deps = detail && Object.keys(detail.dependencies || {}).length > 0
    ? `<h3>Dependencies</h3>
<ul class="mono">${Object.entries(detail.dependencies)
    .map(([dep, spec]) => `<li><a href="/packages/${encodeURIComponent(dep)}">${escapeHtml(dep)}</a> ${escapeHtml(spec)}</li>`)
    .join('')}</ul>`
    : '';

  const rows = names
    .sort((a, b) => {
      // newest first when both parse as semver-ish; fall back to string order
      const parsedA = Date.parse(pkg.versions[a].published || '');
      const parsedB = Date.parse(pkg.versions[b].published || '');
      if (Number.isFinite(parsedA) && Number.isFinite(parsedB) && parsedA !== parsedB) {
        return parsedB - parsedA;
      }
      return b.localeCompare(a);
    })
    .map((version) => {
      const entry = pkg.versions[version];
      const yanked = entry.yanked ? ' <span class="badge yanked">yanked</span>' : '';
      const selected = version === detailVersion ? ' style="outline: 1px solid var(--line)"' : '';
      return `<tr id="v-${escapeHtml(version)}"${selected}>
  <td class="mono"><a href="/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}">${escapeHtml(version)}</a>${yanked}</td>
  <td>${escapeHtml(formatDate(entry.published))}</td>
  <td>${escapeHtml(formatBytes(entry.size))}</td>
  <td class="mono" title="${escapeHtml(entry.sha256)}">${escapeHtml(shortHex(entry.sha256, 16))}</td>
  <td>${signatureCell(entry)}</td>
  <td><a href="/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/package.tar.gz">download</a></td>
</tr>`;
    })
    .join('\n');

  const trustNote = detail && detail.publicKey && registryUrl
    ? `<p class="note">This registry signs artifacts with a pinned key. Enforce it with
<code>xiom pkg trust --registry ${escapeHtml(registryUrl)} --key ${escapeHtml(detail.publicKey)}</code></p>`
    : '';

  return layout({
    title: name,
    description: pkg.description || `Versions of ${name}`,
    body: `<section>
  <div class="pkg-title">
    <h1>${escapeHtml(name)}</h1>
    ${latestBadge}
    ${signedBadge}
  </div>
  ${pkg.description ? `<p>${escapeHtml(pkg.description)}</p>` : ''}
  <div class="install">${installNode}</div>
  ${detailGrid}
  ${trustNote}
</section>
<h2>Versions</h2>
<table class="versions">
  <thead><tr><th>Version</th><th>Published</th><th>Size</th><th>SHA-256</th><th>Signature</th><th></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
${deps}`,
  });
}

function notFoundPage(message) {
  return layout({
    title: 'Not found',
    body: `<section class="hero">
  <h1>Not found</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/packages">Browse all packages</a></p>
</section>`,
  });
}

module.exports = {
  homePage,
  searchPage,
  packagePage,
  notFoundPage,
};
