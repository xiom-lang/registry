// XIOM Package Registry -- page builders for the read-only web UI.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
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
const { isFirstPartyNamespace } = require('../names');
const { categoryCounts } = require('../categories');
const { renderMarkdown } = require('./markdown');
const { reportForm, decisionPill, reviewHistory, decisionControls, ratingsSection } = require('./review');
const semver = require('semver');

/** Listing pagination defaults (SESSION.md section 13 phase 1). */
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;
/** Cards in the home "recently updated" strip (section 13 phase 2). */
const HOME_STRIP_SIZE = 6;

/** `xiom.*` / `xiom-*` names are publishable only by first-party tokens. */
function officialBadge(name) {
  return isFirstPartyNamespace(name)
    ? '<span class="badge official">official</span>'
    : '';
}

/**
 * One status badge per package, chosen from a state x track matrix:
 *   states (precedence, reorder here): flagged (operator/reviewer only),
 *     yanked (every version withdrawn), deprecated / incubator (manifest
 *     `stage` field), prerelease (latest is a semver pre-release), trusted
 *     (community only: the latest version came through a GitHub OIDC trusted
 *     publisher, so the registry verified the publishing identity), verified
 *     (latest version signed by the publisher), unsigned;
 *   tracks: official (first-party namespace) or community.
 * The art files are `pgk_<state>_<track>.webp`. Icons carry the state and
 * track; pills carry the claims in words ("trusted", "signed") so the check
 * or star art can never be read as something the registry did not prove.
 */
function packageBadgeState(name, pkg) {
  const track = isFirstPartyNamespace(name) ? 'official' : 'community';
  const latest = pkg && pkg.latest ? pkg.versions[pkg.latest] : null;
  const versionCount = pkg && pkg.versions ? Object.keys(pkg.versions).length : 0;
  const stage = pkg && typeof pkg.stage === 'string' ? pkg.stage : '';
  const official = track === 'official';
  const signed = Boolean(latest && latest.signature && latest.publicKey);
  const oidcTrusted = Boolean(latest && latest.publisher
    && typeof latest.publisher.repository === 'string');
  const badge = (state, communityLabel, officialLabel = communityLabel) => {
    const pills = state === 'trusted' ? (signed ? ['trusted', 'signed'] : ['trusted'])
      : (state === 'verified' ? ['signed'] : []);
    // Human review is a distinct claim alongside publisher claims; a flagged
    // package shows the flagged art and no claim pills.
    if (pkg && pkg.reviewed === true && state !== 'flagged') pills.push('reviewed');
    return {
      file: `pgk_${state}_${track}.webp`,
      label: official ? officialLabel : communityLabel,
      pills,
    };
  };

  if (pkg && pkg.flagged === true) {
    return badge('flagged', 'Flagged by a registry reviewer');
  }
  if (!latest && versionCount > 0) {
    return badge('yanked', 'Withdrawn: every version is yanked');
  }
  if (stage === 'deprecated') {
    return badge('deprecated', 'Deprecated package', 'Deprecated first-party package');
  }
  if (stage === 'incubating') {
    return badge('incubator', 'Incubating package', 'Incubating first-party package');
  }
  if (pkg && typeof pkg.latest === 'string' && semver.prerelease(pkg.latest) !== null) {
    return badge('prerelease', 'Pre-release');
  }
  if (track === 'community' && oidcTrusted) {
    return badge('trusted', 'Trusted publisher: publishing identity verified by the registry');
  }
  if (signed) {
    return badge('verified', 'Signed by the publisher', 'Official package, signed by the publisher');
  }
  return badge('unsigned', 'Community package, unsigned', 'Official package, unsigned');
}

function packageBadge(name, pkg) {
  const badge = packageBadgeState(name, pkg);
  const pills = badge.pills
    .map((pill) => `<span class="badge ${pill}">${pill}</span>`)
    .join('');
  return `<span class="pkg-badge-group"><img class="pkg-badge" src="/ui/${badge.file}"`
    + ` alt="${escapeHtml(badge.label)}" title="${escapeHtml(badge.label)}"`
    + ` width="80" height="80" loading="lazy" decoding="async">${pills}</span>`;
}

/** Clickable category chips (registry-owned vocabulary, so always safe). */
function categoryChips(categories, limit = 3) {
  const list = Array.isArray(categories) ? categories.slice(0, limit) : [];
  if (list.length === 0) return '';
  return `<span class="chips">${list
    .map((category) => `<a class="chip" href="/search?category=${encodeURIComponent(category)}">${escapeHtml(category)}</a>`)
    .join('')}</span>`;
}

/** Strip of every category with a package count, for browsing. */
function categoryStrip(index, activeCategory = '') {
  const counts = categoryCounts(index);
  const chips = counts
    .map(({ name, count }) => {
      const active = name === activeCategory ? ' chip-active' : '';
      const zero = count === 0 ? ' chip-empty' : '';
      return `<a class="chip${active}${zero}" href="/search?category=${encodeURIComponent(name)}">`
        + `${escapeHtml(name)} <span class="chip-count">${count}</span></a>`;
    })
    .join('');
  return `<div class="category-strip" aria-label="Categories">${chips}</div>`;
}

/** Card used on the home and search pages. */
function packageCard(name, pkg) {
  const latest = pkg.latest ? `<span class="pkg-version">${escapeHtml(pkg.latest)}</span>` : '';
  const description = pkg.description
    ? `<p class="pkg-desc">${escapeHtml(pkg.description)}</p>`
    : '';
  const versions = Object.keys(pkg.versions).length;
  const chips = categoryChips(pkg.categories, 3);
  return `<li class="package-card">
  <div class="pkg-head">
    <a class="pkg-name" href="/packages/${encodeURIComponent(name)}">${escapeHtml(name)}</a>
    ${officialBadge(name)}
    ${latest}
    ${packageBadge(name, pkg)}
  </div>
  ${description}
  <p class="pkg-meta">${versions} version${versions === 1 ? '' : 's'} ${chips}</p>
</li>`;
}

/**
 * Filter + sort package names for the listing (SESSION.md section 13
 * phase 3): `sort` is 'updated' (newest latest-publish first, the default)
 * or 'name'; facets are category, firstParty, and signed (the latest
 * installable version carries a publisher signature).
 */
function listingNames(index, { sort = 'updated', category = '', firstParty = false, signed = false } = {}) {
  let names = Object.keys(index.packages);
  if (category) {
    const needle = category.toLowerCase();
    names = names.filter((name) => (index.packages[name].categories || []).includes(needle));
  }
  if (firstParty) names = names.filter((name) => isFirstPartyNamespace(name));
  if (signed) {
    names = names.filter((name) => {
      const entry = latestEntry(index.packages[name]);
      return Boolean(entry && entry.signature && entry.publicKey);
    });
  }
  const publishedAt = (name) => {
    const entry = latestEntry(index.packages[name]);
    const parsed = entry && entry.published ? Date.parse(entry.published) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  if (sort === 'name') names.sort((a, b) => a.localeCompare(b));
  else names.sort((a, b) => publishedAt(b) - publishedAt(a) || a.localeCompare(b));
  return names;
}

/** Slice the filtered + sorted package list for one page. */
function paginatePackages(index, {
  page = 1,
  perPage = DEFAULT_PER_PAGE,
  sort = 'updated',
  category = '',
  firstParty = false,
  signed = false,
} = {}) {
  const names = listingNames(index, { sort, category, firstParty, signed });
  const total = names.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * perPage;
  return {
    names: names.slice(start, start + perPage),
    total,
    totalPages,
    page: current,
    perPage,
    sort,
    category,
    firstParty: Boolean(firstParty),
    signed: Boolean(signed),
  };
}

/** Build a /packages query string for a link (HTML-escaped for attributes). */
function listingQuery({ sort, category, firstParty, signed }, page, perPage) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  if (sort && sort !== 'updated') params.set('sort', sort);
  if (category) params.set('category', category);
  if (firstParty) params.set('first_party', '1');
  if (signed) params.set('signed', '1');
  return `?${params.toString().replaceAll('&', '&amp;')}`;
}

/** Previous/next controls, preserving the active sort and facets. */
function paginationNav(paged) {
  const { page, totalPages, perPage, total } = paged;
  if (totalPages <= 1) return '';
  const link = (target, label) => `<a class="page-link" href="/packages${listingQuery(paged, target, perPage)}">${label}</a>`;
  const previous = page > 1
    ? link(page - 1, '&larr; Previous')
    : '<span class="page-link disabled">&larr; Previous</span>';
  const next = page < totalPages
    ? link(page + 1, 'Next &rarr;')
    : '<span class="page-link disabled">Next &rarr;</span>';
  return `<nav class="pagination" aria-label="Package pages">
  ${previous}
  <span class="page-status">Page ${page} of ${totalPages} &middot; ${total} package${total === 1 ? '' : 's'}</span>
  ${next}
</nav>`;
}

/** Shareable sort + facet controls for the listing. */
function facetBar(index, paged) {
  const href = (overrides) => `/packages${listingQuery({ ...paged, ...overrides }, 1, paged.perPage)}`;
  const chip = (label, overrides, active) => `<a class="chip${active ? ' chip-active' : ''}" href="${href(overrides)}">${label}</a>`;
  const filters = [
    chip('All packages', { category: '', firstParty: false, signed: false },
      !paged.category && !paged.firstParty && !paged.signed),
    chip('First-party', { firstParty: !paged.firstParty }, paged.firstParty),
    chip('Signed', { signed: !paged.signed }, paged.signed),
  ].join('');
  const categories = categoryCounts(index)
    .map(({ name, count }) => chip(
      `${escapeHtml(name)} <span class="chip-count">${count}</span>`,
      { category: paged.category === name ? '' : name },
      paged.category === name,
    ))
    .join('');
  const sorts = [['updated', 'Updated'], ['name', 'A-Z']]
    .map(([value, label]) => chip(label, { sort: value }, paged.sort === value))
    .join('');
  return `<div class="facet-bar">
  <div class="facet-group" role="group" aria-label="Filters">${filters}</div>
  <div class="facet-group" role="group" aria-label="Categories">${categories}</div>
  <div class="facet-group facet-sort" role="group" aria-label="Sort">${sorts}</div>
</div>`;
}

function packageList(index, options = {}) {
  const paged = paginatePackages(index, options);
  if (paged.total === 0) {
    return '<div class="empty">No packages yet. Publish with <code>xiom pkg publish</code>.</div>';
  }
  const cards = paged.names
    .map((name) => packageCard(name, index.packages[name]))
    .join('\n');
  return `<ul class="package-list">\n${cards}\n</ul>\n${paginationNav(paged)}`;
}

/** Latest installable version entry, or null when everything is yanked. */
function latestEntry(pkg) {
  return pkg && pkg.latest && pkg.versions[pkg.latest] ? pkg.versions[pkg.latest] : null;
}

/** Newest packages first (by latest publish time), for the home strip. */
function recentlyUpdated(index, limit = HOME_STRIP_SIZE) {
  return Object.keys(index.packages)
    .map((name) => {
      const entry = latestEntry(index.packages[name]);
      const published = entry && entry.published ? Date.parse(entry.published) : 0;
      return { name, published: Number.isFinite(published) ? published : 0 };
    })
    .sort((a, b) => b.published - a.published || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((item) => item.name);
}

function truncate(text, max = 110) {
  const value = String(text || '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

/** One compact listing row: badge, name/description, version/updated/size. */
function packageRow(name, pkg) {
  const latest = latestEntry(pkg);
  const version = pkg.latest
    ? `<span class="pkg-version mono">${escapeHtml(pkg.latest)}</span>`
    : '<span class="badge yanked">none</span>';
  const updated = latest && latest.published ? formatDate(latest.published) : '--';
  const size = latest && latest.size ? formatBytes(latest.size) : '--';
  const description = pkg.description ? truncate(pkg.description) : '';
  return `<li class="pkg-row">
  ${packageBadge(name, pkg)}
  <div class="pkg-row-main">
    <a class="pkg-name" href="/packages/${encodeURIComponent(name)}">${escapeHtml(name)}</a>
    ${officialBadge(name)}
    ${description ? `<p class="pkg-desc">${escapeHtml(description)}</p>` : ''}
  </div>
  <div class="pkg-row-meta">
    ${version}
    <span>${escapeHtml(updated)}</span>
    <span>${escapeHtml(size)}</span>
  </div>
</li>`;
}

/** Compact paginated listing (the full list lives on /packages). */
function packageRows(index, options = {}) {
  const paged = paginatePackages(index, options);
  if (paged.total === 0) {
    return '<div class="empty">No packages yet. Publish with <code>xiom pkg publish</code>.</div>';
  }
  const rows = paged.names
    .map((name) => packageRow(name, index.packages[name]))
    .join('\n');
  return `<ul class="pkg-rows">\n${rows}\n</ul>\n${paginationNav(paged)}`;
}

/** Home: registry overview, recently updated cards, and a link to the list. */
function homePage(index, options = {}) {
  const names = recentlyUpdated(index);
  const total = Object.keys(index.packages).length;
  const lastUpdated = index.updated_at ? `Updated ${formatDate(index.updated_at)}` : 'No publishes yet';
  const strip = total === 0
    ? '<div class="empty">No packages yet. Publish with <code>xiom pkg publish</code>.</div>'
    : `<ul class="package-list featured">\n${names
      .map((name) => packageCard(name, index.packages[name]))
      .join('\n')}\n</ul>`;
  return layout({
    title: '',
    nav: options.nav,
    body: `<section class="hero">
  <p>The package registry for XIOM. Browse packages, versions, and ed25519 signatures,
     or install directly: <code>xiom pkg install &lt;package&gt;</code>.</p>
  <div class="meta-row">
    <span>${total} package${total === 1 ? '' : 's'}</span>
    <span>Protocol ${escapeHtml(index.version)}</span>
    <span>${escapeHtml(lastUpdated)}</span>
  </div>
  ${categoryStrip(index)}
</section>
<h1>Packages</h1>
<h2>Recently updated</h2>
${strip}
<p class="browse-all"><a class="button" href="/packages">Browse all ${total} package${total === 1 ? '' : 's'}</a></p>`,
  });
}

/** Full listing: facets, compact rows, paginated (section 13 phases 2-3). */
function packagesPage(index, options = {}) {
  const paged = paginatePackages(index, options);
  const filters = [];
  if (paged.category) filters.push(`category "${paged.category}"`);
  if (paged.firstParty) filters.push('first-party');
  if (paged.signed) filters.push('signed');
  const summary = `${paged.total} package${paged.total === 1 ? '' : 's'}`
    + (filters.length > 0 ? ` \u00b7 ${filters.join(' \u00b7 ')}` : '');
  return layout({
    title: 'Packages',
    description: 'Browse all XIOM registry packages',
    nav: options.nav,
    body: `<section class="hero">
  <h1>Packages</h1>
  <div class="meta-row"><span>${escapeHtml(summary)}</span></div>
</section>
${facetBar(index, paged)}
${packageRows(index, options)}`,
  });
}

/**
 * Search matcher (SESSION.md section 13 phase 4). Matching treats `-` and
 * `.` as equivalent, so `xiom-tar` finds `xiom.tar`; results rank exact
 * name, then name prefix, then name substring, then description / keyword /
 * category hits (alphabetical inside a rank).
 *
 * @returns {{ name: string, pkg: object, score: number }[]}
 */
function searchPackages(index, query = '', category = '') {
  const needle = String(query).trim().toLowerCase();
  const active = String(category).trim().toLowerCase();
  const tolerant = (value) => value.toLowerCase().replace(/[-.]/g, '.');
  const needleTolerant = tolerant(needle);

  const matches = [];
  for (const [name, pkg] of Object.entries(index.packages)) {
    const categories = pkg.categories || [];
    const keywords = pkg.keywords || [];
    if (active !== '' && !categories.includes(active)) continue;
    if (needle === '') {
      matches.push({ name, pkg, score: 0 });
      continue;
    }
    const nameTolerant = tolerant(name);
    let score = -1;
    if (nameTolerant === needleTolerant) score = 0;
    else if (nameTolerant.startsWith(needleTolerant)) score = 1;
    else if (nameTolerant.includes(needleTolerant)) score = 2;
    else if ((pkg.description || '').toLowerCase().includes(needle)) score = 3;
    else if (keywords.some((keyword) => keyword.includes(needle))
      || categories.some((entry) => entry.includes(needle))) score = 4;
    if (score >= 0) matches.push({ name, pkg, score });
  }
  matches.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return matches;
}

/** Search results (or the full list when the query is empty). */
function searchPage(index, query = '', category = '', options = {}) {
  const active = category.trim().toLowerCase();
  const needle = query.trim();
  const matches = searchPackages(index, query, category);

  const parts = [];
  parts.push(`${matches.length} package${matches.length === 1 ? '' : 's'}`);
  if (active) parts.push(`in category "${active}"`);
  if (needle) parts.push(`matching "${query}"`);
  const summary = parts.join(' ');

  const list = matches.length === 0
    ? '<div class="empty">No packages match this search.</div>'
    : `<ul class="package-list">
${matches.map(({ name, pkg }) => packageCard(name, pkg)).join('\n')}
</ul>`;

  return layout({
    title: active ? `Category: ${active}` : 'Search',
    searchQuery: query,
    nav: options.nav,
    body: `<section class="hero">
  <h1>${active ? `Category: ${escapeHtml(active)}` : 'Search'}</h1>
  <div class="meta-row"><span>${escapeHtml(summary)}</span></div>
  ${categoryStrip(index, active)}
</section>
${list}`,
  });
}

/** Category index: every vocabulary entry with its package count. */
function categoriesPage(index, options = {}) {
  const counts = categoryCounts(index);
  const items = counts
    .map(({ name, count }) => `<li class="category-item">
  <a class="chip" href="/search?category=${encodeURIComponent(name)}">${escapeHtml(name)}</a>
  <span class="pkg-meta">${count} package${count === 1 ? '' : 's'}</span>
</li>`)
    .join('\n');
  return layout({
    title: 'Categories',
    description: 'Browse XIOM registry packages by category',
    nav: options.nav,
    body: `<section class="hero">
  <h1>Categories</h1>
  <p>The registry vocabulary is fixed so browsing and tooling stay predictable;
     niche topics live in per-package keywords.</p>
</section>
<ul class="category-list">
${items}
</ul>`,
  });
}

function signatureCell(entry) {
  if (!entry.publicKey || !entry.signature) return '<span class="mono">--</span>';
  return `<span class="badge signed">signed</span> <span class="mono">${escapeHtml(fingerprint(entry.publicKey))}</span>`;
}

/** OIDC provenance recorded on a version (empty for static-token publishes). */
function publisherCell(publisher) {
  if (!publisher || !publisher.repository) return '';
  const workflow = publisher.workflow
    ? ` <span class="mono">${escapeHtml(publisher.workflow)}</span>`
    : '';
  const ref = publisher.ref
    ? ` @ <span class="mono">${escapeHtml(publisher.ref)}</span>`
    : '';
  const run = publisher.runUrl
    ? ` <a href="${escapeHtml(publisher.runUrl)}" rel="noopener">run</a>`
    : '';
  return `<div class="detail"><dt>Published by</dt><dd>${escapeHtml(publisher.repository)}`
    + `${workflow}${ref}${run}</dd></div>`;
}

/** Package detail: metadata, install command, trust instructions, versions. */
function packagePage(pkg, registryUrl, selectedVersion = '', options = {}) {
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
  ${publisherCell(detail.publisher)}
  ${pkg.categories && pkg.categories.length > 0 ? `<div class="detail"><dt>Categories</dt><dd>${categoryChips(pkg.categories)}</dd></div>` : ''}
  ${pkg.keywords && pkg.keywords.length > 0 ? `<div class="detail"><dt>Keywords</dt><dd>${escapeHtml(pkg.keywords.join(', '))}</dd></div>` : ''}
  ${pkg.license ? `<div class="detail"><dt>License</dt><dd>${escapeHtml(pkg.license)}</dd></div>` : ''}
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

  // README from the stored tarball (SESSION.md section 13): rendered through
  // the escape-first markdown subset, with the raw markdown one link away.
  const readmeText = typeof options.readme === 'function'
    ? options.readme(detailVersion)
    : options.readme;
  const readmeBlock = typeof readmeText === 'string' && readmeText.trim() !== ''
    ? `<details class="readme">
  <summary>README</summary>
  <div class="markdown">${renderMarkdown(readmeText)}</div>
  <p class="pkg-meta"><a href="/packages/${encodeURIComponent(name)}/${encodeURIComponent(detailVersion)}/readme">raw markdown</a></p>
</details>`
    : '';

  // Reports and reviewer decisions (section 15 phase 3): signed-in accounts
  // can file a report; reviewers also see the queue link, the decision
  // controls, and everyone sees the public review history.
  const review = options.review || null;
  const ratingsBlock = review
    ? ratingsSection({
      name,
      ratings: review.ratings,
      summary: review.summary,
      myRating: review.myRating,
      canRate: review.canReport,
      csrf: review.csrf,
    })
    : '';
  const reviewBlock = review
    ? `<div class="review-box" id="review">
  ${review.notice ? `<p class="notice" role="status">${escapeHtml(review.notice)}</p>` : ''}
  ${review.error ? `<p class="error-box" role="alert">${escapeHtml(review.error)}</p>` : ''}
  ${review.canReview
    ? `<p class="pkg-meta">${review.openReports > 0
      ? `${review.openReports} open report${review.openReports === 1 ? '' : 's'} on this package \u00b7 `
      : ''}<a href="/review">Open the review queue</a></p>`
    : ''}
  ${review.canReview ? decisionControls({ name, csrf: review.csrf }) : ''}
  ${reviewHistory(review.history)}
  ${review.canReport
    ? `<details class="report-form-box"><summary>Report this package</summary>${reportForm({ name, csrf: review.csrf })}</details>`
    : ''}
</div>`
    : '';

  return layout({
    title: name,
    description: pkg.description || `Versions of ${name}`,
    nav: options.nav,
    body: `<section>
  <div class="pkg-title">
    <h1>${escapeHtml(name)}</h1>
    ${officialBadge(name)}
    ${latestBadge}
    ${signedBadge}
    ${review ? decisionPill(review.decision) : ''}
    ${packageBadge(name, pkg)}
  </div>
  ${pkg.description ? `<p>${escapeHtml(pkg.description)}</p>` : ''}
  <div class="install">${installNode}</div>
  ${detailGrid}
  ${trustNote}
  ${readmeBlock}
  ${ratingsBlock}
  ${reviewBlock}
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

function notFoundPage(message, options = {}) {
  return layout({
    title: 'Not found',
    nav: options.nav,
    body: `<section class="hero">
  <h1>Not found</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/packages">Browse all packages</a></p>
</section>`,
  });
}

module.exports = {
  homePage,
  packagesPage,
  searchPage,
  categoriesPage,
  packagePage,
  notFoundPage,
  packageBadgeState,
  paginatePackages,
  searchPackages,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
};
