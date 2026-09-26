// XIOM Package Registry -- the registry-hosted publishing guide page.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Nav "Publish" lands here instead of jumping to GitHub: the same
// PUBLISHING.md is rendered with the registry's markdown pipeline (so it can
// gain registry-specific context), and the git source stays one click away.
// The markdown itself is fetched live with a bundled fallback, so the guide
// cannot 404 when GitHub is unreachable (SESSION.md section 20).

'use strict';

const { escapeHtml, formatWhen } = require('./format');
const { layout } = require('./layout');
const { renderMarkdown } = require('./markdown');

const GITHUB_SOURCE = 'https://github.com/xiom-lang/registry/blob/main/PUBLISHING.md';
const TEMPLATE_URL = '/ui/templates/community-publish.yml';

function publishGuidePage({ markdown, source = 'bundled', fetchedAt = '', nav = '' }) {
  // The page hero carries the document title; drop the markdown's own first
  // H1 so the article starts at the first real section.
  const guideBody = String(markdown || '').replace(/^#\s+[^\n]*\n+/, '');
  const fetchedLine = source === 'github' && fetchedAt
    ? `Live copy from GitHub, refreshed ${formatWhen(fetchedAt)}.`
    : (source === 'fallback'
      ? 'The bundled guide is missing from this deployment and the live copy could not be fetched; the GitHub link has the full guide.'
      : 'Bundled copy shipped with this registry (GitHub was unreachable for a refresh).');
  const body = `<section class="hero">
  <h1>Publishing to XIOM</h1>
  <p>Everything a package needs to reach this registry: a five-minute quickstart,
     the trusted-publisher GitHub Action (recommended, no secrets), the manual
     token path, tags, and the troubleshooting table. No compiler internals
     required.</p>
  <div class="quick-links">
    <a class="button primary" href="#quickstart">Start the 5-minute quickstart</a>
    <a class="button" href="${TEMPLATE_URL}">Download the workflow template</a>
    <a class="button" href="/account/requests">Request publishing access</a>
  </div>
</section>
<p class="pkg-meta guide-source">${escapeHtml(fetchedLine)}
  <a href="${GITHUB_SOURCE}" rel="noopener">View the source on GitHub</a>
  &middot; <a href="${TEMPLATE_URL}">community-publish.yml</a>
</p>
<article class="markdown guide">
${renderMarkdown(guideBody)}
</article>
<p class="pkg-meta guide-source">Something unclear or out of date?
  <a href="${GITHUB_SOURCE}" rel="noopener">Open an issue or a pull request</a> &mdash;
  contributions to this guide are welcome.</p>`;
  return layout({ title: 'Publishing guide', description: 'How to publish a package to the XIOM registry: quickstart, trusted publishers, tokens, tags, and troubleshooting.', body, nav });
}

module.exports = { publishGuidePage, GITHUB_SOURCE, TEMPLATE_URL };
