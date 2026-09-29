// XIOM Package Registry -- activity feed rendering (A5, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Renders the merged event trail assembled by src/activity.js: releases from
// the index, reviews, maintainer replies, reviewer decisions, and verified
// claims. Every value comes from public data and is escaped here; excerpts
// are truncated so a long review cannot dominate the feed.

'use strict';

const { escapeHtml, formatWhen } = require('./format');
const { profileLink } = require('./profile');

const STARS = (count) => {
  const stars = Math.max(0, Math.min(5, Number(count) || 0));
  return '\u2605'.repeat(stars) + '\u2606'.repeat(5 - stars);
};

function excerpt(text, max = 160) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}

const TYPE_LABELS = Object.freeze({
  release: 'release',
  review: 'review',
  reply: 'reply',
  decision: 'decision',
  claim: 'maintainer',
});

function activityRow(event, { showPackage = false } = {}) {
  const pkgLink = showPackage
    ? `<a class="pkg-name" href="/packages/${encodeURIComponent(event.package)}">${escapeHtml(event.package)}</a> `
    : '';
  const when = `<span class="pkg-meta activity-when">${formatWhen(event.at)}</span>`;
  let detail = '';
  switch (event.type) {
    case 'release': {
      const yanked = event.yanked ? ' <span class="status-pill status-pending">yanked</span>' : '';
      const source = event.repository
        ? ` <span class="pkg-meta">from ${escapeHtml(event.repository)}</span>`
        : '';
      detail = `${pkgLink}<strong>${escapeHtml(event.version)}</strong>${yanked}${source}`;
      break;
    }
    case 'review':
      detail = `${pkgLink}${profileLink(event.login)} rated `
        + `<span class="rating-stars" title="${escapeHtml(String(event.stars))} of 5">${STARS(event.stars)}</span>`
        + (event.review ? `<span class="activity-excerpt">${escapeHtml(excerpt(event.review))}</span>` : '');
      break;
    case 'reply':
      detail = `${pkgLink}${profileLink(event.login)} replied`
        + `<span class="activity-excerpt">${escapeHtml(excerpt(event.body))}</span>`;
      break;
    case 'decision':
      detail = `${pkgLink}marked <strong>${escapeHtml(String(event.action))}</strong>`
        + (event.actor ? ` by ${profileLink(event.actor)}` : '')
        + (event.note ? `<span class="activity-excerpt">${escapeHtml(excerpt(event.note))}</span>` : '');
      break;
    case 'claim':
      detail = `${pkgLink}${profileLink(event.login)} verified as maintainer`;
      break;
    default:
      return '';
  }
  return `  <li class="activity-row">
    <span class="status-pill activity-type">${escapeHtml(TYPE_LABELS[event.type] || event.type)}</span>
    <span class="activity-detail">${detail}</span>
    ${when}
  </li>`;
}

/**
 * @param {object[]} events from src/activity.js
 * @param {{ showPackage?: boolean, empty?: string }} options
 */
function activityList(events, { showPackage = false, empty = 'No activity yet.' } = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    return `<p class="pkg-meta">${escapeHtml(empty)}</p>`;
  }
  return `<ul class="activity-list">
${events.map((event) => activityRow(event, { showPackage })).filter(Boolean).join('\n')}
</ul>`;
}

module.exports = { activityList, activityRow, STARS };
