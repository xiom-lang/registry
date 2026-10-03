// XIOM Package Registry -- public contributor profile and board pages (A4).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Server-rendered, mobile-first pages for SESSION.md 21 A4: one public
// profile per account (packages maintained, reviews, maintainer replies,
// decision history, opt-in Sponsors badge) and the top-contributors board.
// The pages read only data that is already public elsewhere -- ratings and
// replies on package pages, decisions in the audit trail, maintainer lists.
// They never render an email, a session, or any stored secret.

'use strict';

const { escapeHtml, formatWhen } = require('./format');
const { layout } = require('./layout');

const STARS = (count) => '\u2605'.repeat(Math.max(0, Math.min(5, Number(count) || 0)));

// GitHub-style heart for the Sponsors badge (inline, no icon font).
const HEART = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">'
  + '<path d="M8 14.25l-.345-.315C4.42 11.065 2 8.88 2 6.18 2 4.06 3.68 2.5 5.7 2.5c1.18 0 2.3.59 3 1.5.7-.91 1.82-1.5 3-1.5 '
  + '2.02 0 3.7 1.56 3.7 3.68 0 2.7-2.42 4.885-5.655 7.755L8 14.25z"/></svg>';

/**
 * The Sponsors badge. Render it only for an opted-in account whose cached
 * check answered 'sponsor'; `profilePage`/`contributorsPage` already decide.
 */
function sponsorBadge(login, { compact = false } = {}) {
  const name = String(login || '');
  if (!name) return '';
  return `<a class="sponsor-badge" href="https://github.com/sponsors/${encodeURIComponent(name)}"`
    + ` rel="noopener" aria-label="Sponsors @${escapeHtml(name)} on GitHub">${HEART}`
    + ` <span>${compact ? 'Sponsor' : 'GitHub Sponsor'}</span></a>`;
}

/** Author link shared by profiles, reviews, and maintainer rows. */
function profileLink(login) {
  const name = String(login || '');
  return `<a class="profile-link" href="/account/${encodeURIComponent(name)}">@${escapeHtml(name)}</a>`;
}

const ROLE_PILLS = {
  admin: 'registry maintainer',
  supervisor: 'registry supervisor',
  reviewer: 'registry reviewer',
};

function profileHero({ account, role, sponsor, isSelf }) {
  const avatar = typeof account.avatarUrl === 'string' && account.avatarUrl.startsWith('https://')
    ? `<img class="account-avatar" src="${escapeHtml(account.avatarUrl)}" alt=""`
      + ' width="64" height="64" loading="lazy" referrerpolicy="no-referrer">'
    : '';
  const pieces = [
    `<span><a href="https://github.com/${encodeURIComponent(account.login)}" rel="noopener">github.com/${escapeHtml(account.login)}</a></span>`,
  ];
  if (account.name) pieces.push(`<span>${escapeHtml(account.name)}</span>`);
  if (account.createdAt) pieces.push(`<span>Joined ${formatWhen(account.createdAt)}</span>`);
  if (role && ROLE_PILLS[role]) {
    pieces.push(`<span class="status-pill status-approved">${escapeHtml(ROLE_PILLS[role])}</span>`);
  }
  if (sponsor) pieces.push(sponsorBadge(account.login));
  if (isSelf && !sponsor) {
    // The badge is opt-in: a signed-in owner who has not enabled it gets a
    // direct pointer instead of a mystery ("why is my badge missing?").
    pieces.push('<span><a href="/account/settings#sponsors">Sponsors badge: off &mdash; enable it in Settings</a></span>');
  }
  if (isSelf) pieces.push('<span><a href="/account/settings">Manage your profile</a></span>');
  return `<section class="hero account-hero">
  ${avatar}
  <div>
    <h1>@${escapeHtml(account.login)}</h1>
    <div class="meta-row">${pieces.join('\n      ')}</div>
  </div>
</section>`;
}

function maintainedSection(maintained) {
  if (maintained.length === 0) {
    return '<p class="pkg-meta">No packages listed yet. Maintainers appear here from publish '
      + 'provenance and verified claims.</p>';
  }
  const sourceLabel = (entry) => {
    if (entry.sources.includes('provenance')) return 'publish provenance';
    if (entry.sources.includes('verified-claim')) return 'verified maintainer';
    if (entry.sources.includes('trusted-publisher')) return 'approved trusted publisher';
    return 'approved publish token';
  };
  return `<ul class="maintainer-list">
${maintained.map((entry) => `  <li class="maintainer-row">
    <a class="pkg-name" href="/packages/${encodeURIComponent(entry.name)}">${escapeHtml(entry.name)}</a>
    <span class="pkg-meta">${escapeHtml(sourceLabel(entry))}</span>
  </li>`).join('\n')}
</ul>`;
}

function reviewsSection(reviews, ratingsTotal) {
  if (reviews.length === 0) {
    const extra = ratingsTotal > 0
      ? ` ${ratingsTotal} rating${ratingsTotal === 1 ? '' : 's'} without text.`
      : '';
    return `<p class="pkg-meta">No written reviews yet.${extra}</p>`;
  }
  const extra = ratingsTotal > reviews.length
    ? `<p class="pkg-meta">${ratingsTotal} ratings in total, ${reviews.length} with review text.</p>`
    : '';
  return `<ul class="request-list">
${reviews.map((entry) => `  <li class="request-card">
    <div class="request-head">
      <a class="pkg-name" href="/packages/${encodeURIComponent(entry.package)}#reviews">${escapeHtml(entry.package)}</a>
      <span class="rating-stars" title="${entry.stars} of 5">${STARS(entry.stars)}</span>
      <span class="pkg-meta">${formatWhen(entry.at)}</span>
    </div>
    ${entry.review ? `<p class="pkg-desc">${escapeHtml(entry.review)}</p>` : ''}
  </li>`).join('\n')}
</ul>
${extra}`;
}

function repliesSection(replies) {
  if (replies.length === 0) return '<p class="pkg-meta">No maintainer replies yet.</p>';
  return `<ul class="request-list">
${replies.map((entry) => `  <li class="request-card">
    <div class="request-head">
      <a class="pkg-name" href="/packages/${encodeURIComponent(entry.package)}#reviews">${escapeHtml(entry.package)}</a>
      <span class="status-pill status-approved">maintainer reply</span>
      <span class="pkg-meta">${formatWhen(entry.at)}${entry.updatedAt ? ' &middot; edited' : ''}</span>
    </div>
    <p class="pkg-desc">${escapeHtml(entry.body)}</p>
  </li>`).join('\n')}
</ul>`;
}

function decisionsSection(decisions) {
  if (decisions.length === 0) return '<p class="pkg-meta">No review decisions recorded yet.</p>';
  return `<ul class="request-list">
${decisions.map((entry) => `  <li class="request-card">
    <div class="request-head">
      <a class="pkg-name" href="/packages/${encodeURIComponent(entry.package)}">${escapeHtml(entry.package)}</a>
      <span class="status-pill status-pending">${escapeHtml(entry.action)}</span>
      <span class="pkg-meta">${formatWhen(entry.at)}</span>
    </div>
    ${entry.note ? `<p class="pkg-meta">${escapeHtml(entry.note)}</p>` : ''}
  </li>`).join('\n')}
</ul>`;
}

/**
 * Public contributor profile at /account/<login>.
 *
 * @param {{ account: object, role?: string, sponsor?: boolean,
 *           maintained?: object[], reviews?: object[], ratingsTotal?: number,
 *           replies?: object[], decisions?: object[], isSelf?: boolean,
 *           nav?: string }} input
 */
function profilePage({
  account,
  role = 'member',
  sponsor = false,
  maintained = [],
  reviews = [],
  ratingsTotal = 0,
  replies = [],
  decisions = [],
  isSelf = false,
  nav = '',
}) {
  const body = `<div class="profile-page">
${profileHero({ account, role, sponsor, isSelf })}
<section>
  <h2>Packages maintained <span class="count">${maintained.length}</span></h2>
  ${maintainedSection(maintained)}
</section>
<div class="account-grid">
  <section>
    <h2>Reviews <span class="count">${reviews.length}</span></h2>
    ${reviewsSection(reviews, ratingsTotal)}
  </section>
  <section>
    <h2>Maintainer replies <span class="count">${replies.length}</span></h2>
    ${repliesSection(replies)}
  </section>
</div>
<section>
  <h2>Decision history <span class="count">${decisions.length}</span></h2>
  ${decisionsSection(decisions)}
</section>
<p class="pkg-meta profile-note">This profile is built from public registry data only:
   packages from publish provenance and verified claims, reviews and replies from
   package pages, and reviewer decisions from the audit trail.</p>
</div>`;
  return layout({ title: `@${account.login}`, body, nav });
}

/** Fractional scores read as 12 or 12.25, never 12.00. */
function formatScore(value) {
  const score = Number(value) || 0;
  return Number.isInteger(score) ? String(score) : String(Math.round(score * 100) / 100);
}

/**
 * Top-contributors board at /contributors. Ranking is the uncapped,
 * value-weighted score from src/contributors.js (scoring v2); the page
 * states the rules so the order is explainable.
 */
function contributorsPage({ entries = [], nav = '' } = {}) {
  const list = entries.length === 0
    ? '<div class="empty">No contributions recorded yet.</div>'
    : `<ol class="contributor-list">
${entries.map((entry, index) => {
    const counts = entry.counts || {};
    const parts = [];
    if (counts.reviews) parts.push(`${counts.reviews} review${counts.reviews === 1 ? '' : 's'}`);
    if (counts.replies) parts.push(`${counts.replies} repl${counts.replies === 1 ? 'y' : 'ies'}`);
    if (counts.decisions) parts.push(`${counts.decisions} decision${counts.decisions === 1 ? '' : 's'}`);
    if (counts.packages) parts.push(`${counts.packages} package${counts.packages === 1 ? '' : 's'}`);
    if (counts.votes) parts.push(`${counts.votes} helpful`);
    if (counts.ratings) parts.push(`${counts.ratings} rating${counts.ratings === 1 ? '' : 's'}`);
    return `  <li class="contributor-row">
    <span class="contributor-rank" aria-hidden="true">${index + 1}</span>
    ${profileLink(entry.login)}
    ${entry.sponsor ? sponsorBadge(entry.login, { compact: true }) : ''}
    <span class="pkg-meta contributor-breakdown">${escapeHtml(parts.join(' \u00b7 '))}</span>
    <span class="contributor-score">${formatScore(entry.score)} pt${entry.score === 1 ? '' : 's'}</span>
  </li>`;
  }).join('\n')}
</ol>`;
  const body = `<div class="contributors-page">
<section class="hero">
  <h1>Top contributors</h1>
  <p>Reputation here rewards sustained craft and demonstrated impact: written
     reviews, maintainer replies, reviewer decisions, helpful votes received,
     and the quality of the packages you maintain. There is no ceiling -- every
     term keeps counting -- but the rate declines with volume, so no one can
     farm their way up.</p>
</section>
${list}
<p class="pkg-meta contributors-note">Written reviews score 3 each for the
   first 10, then 1, then 0.25; maintainer replies 2 then 0.5; reviewer
   decisions 1 then 0.25; helpful votes received 1 then 0.25 -- all uncapped.
   Each maintained package adds (average stars / 5) &times; log<sub>2</sub>(1 +
   raters) &times; 2: a package nobody rated adds nothing, and a package's own
   maintainers' ratings never count. Ratings without text earn no reputation
   (they still show on package pages).
   <a href="/login">Sign in</a> to add your own contributions.</p>
</div>`;
  return layout({ title: 'Top contributors', body, nav });
}

module.exports = {
  sponsorBadge,
  profileLink,
  profilePage,
  contributorsPage,
};
