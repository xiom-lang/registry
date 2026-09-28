// XIOM Package Registry -- reviewer queue pages (registry 2.0 phase 3).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Reviews and reports are moderation data: reviewers resolve or dismiss
// reports with a note, and the record keeps who did what and when. Nothing
// here touches artifacts, signatures, or the index (SESSION.md section 15).

'use strict';

const { escapeHtml, formatWhen, shortId } = require('./format');
const { layout } = require('./layout');
const { profileLink } = require('./profile');

const REASON_LABELS = {
  malware: 'malware or unsafe code',
  spam: 'spam or misleading metadata',
  impersonation: 'impersonation',
  license: 'license problem',
  abandoned: 'abandoned or unmaintained',
  other: 'other',
};

/** The report form shown to signed-in accounts on a package page. */
function reportForm({ name, csrf }) {
  const options = Object.entries(REASON_LABELS)
    .map(([value, label]) => `<option value="${value}"${value === 'other' ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  return `<form class="report-form" method="post" action="/packages/${encodeURIComponent(name)}/report" id="report">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <div class="form-grid">
    <label class="form-field">
      <span>Reason</span>
      <select name="reason">${options}</select>
    </label>
    <label class="form-field">
      <span>What is wrong?</span>
      <textarea name="note" rows="3" maxlength="500" required
        placeholder="Facts a reviewer can check (links, versions, license)"></textarea>
    </label>
  </div>
  <button class="button" type="submit">Submit report</button>
</form>`;
}

function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}

function openReportRow(report, csrf) {
  return `<li class="request-card">
  <div class="request-head">
    <span class="request-id">${shortId(report.id)}</span>
    <span class="status-pill status-pending">${escapeHtml(reasonLabel(report.reason))}</span>
    <span class="pkg-meta"><a href="/packages/${encodeURIComponent(report.package)}">${escapeHtml(report.package)}</a>
      by <a href="https://github.com/${encodeURIComponent(report.reporter.login)}" rel="noopener">@${escapeHtml(report.reporter.login)}</a>
      &middot; ${formatWhen(report.createdAt)}</span>
  </div>
  <p class="pkg-desc">${escapeHtml(report.note)}</p>
  <form class="decision-form" method="post" action="/review/reports/${encodeURIComponent(report.id)}/resolve">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="resolution" placeholder="Resolution note (required)" maxlength="500" required aria-label="Resolution note">
    <button class="button primary" type="submit" name="status" value="resolved">Resolve</button>
    <button class="button danger" type="submit" name="status" value="dismissed">Dismiss</button>
  </form>
</li>`;
}

function closedReportRow(report) {
  return `<li class="request-card closed">
  <div class="request-head">
    <span class="request-id">${shortId(report.id)}</span>
    <span class="status-pill status-${report.status === 'dismissed' ? 'denied' : 'approved'}">${escapeHtml(report.status)}</span>
    <span class="pkg-meta"><a href="/packages/${encodeURIComponent(report.package)}">${escapeHtml(report.package)}</a>
      &middot; ${escapeHtml(reasonLabel(report.reason))}
      &middot; @${escapeHtml(report.resolvedBy || '?')} ${formatWhen(report.resolvedAt || '')}</span>
  </div>
  <p class="pkg-desc">${escapeHtml(report.note)}</p>
  ${report.resolution ? `<p class="pkg-meta">Resolution: ${escapeHtml(report.resolution)}</p>` : ''}
</li>`;
}

/** Human-review state pills: flag and mute are independent properties. */
function decisionPill(decision) {
  if (!decision) return '';
  const pills = [];
  if (decision.flagged === true) {
    pills.push('<span class="status-pill status-denied">flagged by a reviewer</span>');
  }
  if (decision.muted === true) {
    pills.push('<span class="status-pill status-muted">muted by the maintainers</span>');
  }
  if (decision.reviewed === true && decision.flagged !== true) {
    pills.push('<span class="status-pill status-approved">reviewed by a reviewer</span>');
  }
  // Records are normalized to booleans on load; the legacy single-status form
  // is kept as a safety net for anything built by hand.
  if (pills.length === 0 && typeof decision.status === 'string' && decision.status) {
    const legacy = {
      flagged: ['denied', 'flagged by a reviewer'],
      muted: ['muted', 'muted by the maintainers'],
      reviewed: ['approved', 'reviewed by a reviewer'],
    }[decision.status];
    if (legacy) pills.push(`<span class="status-pill status-${legacy[0]}">${legacy[1]}</span>`);
  }
  return pills.join('');
}

/** Public review history for a package (audit trail of decisions). */
function reviewHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const items = history.map((entry) => {
    const note = entry.note ? ` \u2014 ${escapeHtml(entry.note)}` : '';
    return `<li><span class="mono">${escapeHtml(entry.action)}</span> by @${escapeHtml(entry.actor || '?')}`
      + ` &middot; ${formatWhen(entry.at)}${note}</li>`;
  }).join('\n');
  return `<details class="review-history">
  <summary>Review history <span class="count">${history.length}</span></summary>
  <ul class="review-history-list">
${items}
  </ul>
</details>`;
}

/**
 * Reviewer controls with explicit toggles: flag and mute are independent, so
 * each has its own on/off button; review is its own toggle. Every button
 * reflects the current state -- nothing needs an "undo" (owner UX,
 * 2026-09-26).
 */
function decisionControls({ name, csrf, decision = null }) {
  const record = decision || {};
  const reviewButton = record.reviewed === true
    ? '<button class="button" type="submit" name="action" value="unreview">Clear review</button>'
    : '<button class="button primary" type="submit" name="action" value="review">Mark reviewed</button>';
  const flagButton = record.flagged === true
    ? '<button class="button" type="submit" name="action" value="unflag">Unflag</button>'
    : '<button class="button danger" type="submit" name="action" value="flag">Flag</button>';
  const muteButton = record.muted === true
    ? '<button class="button" type="submit" name="action" value="unmute">Unmute</button>'
    : '<button class="button" type="submit" name="action" value="mute">Mute</button>';
  return `<form class="decision-form" method="post" action="/review/packages/${encodeURIComponent(name)}/decision">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input name="note" placeholder="Reason (required to flag or mute)" maxlength="500" aria-label="Decision note">
  ${reviewButton}
  ${flagButton}
  ${muteButton}
</form>`;
}

/** Build a review-list URL for the sort/filter/page controls (A9). */
function reviewListHref(name, { sort = 'newest', textOnly = false, page = 1 } = {}) {
  const params = new URLSearchParams();
  if (sort === 'helpful') params.set('reviews_sort', 'helpful');
  if (textOnly) params.set('reviews_filter', 'text');
  if (page > 1) params.set('reviews_page', String(page));
  const query = params.toString();
  return `/packages/${encodeURIComponent(name)}${query ? `?${query}` : ''}#reviews`;
}

/** Public ratings and short reviews with votes, replies, and list controls. */
function ratingsSection({
  name,
  ratings = [],
  summary = { count: 0, average: 0 },
  myRating = null,
  canRate = false,
  canVote = false,
  canReply = false,
  reviewList = null,
  csrf = '',
}) {
  const stars = (count) => '\u2605'.repeat(count);
  const summaryLine = summary.count > 0
    ? `<span class="rating-average">${summary.average.toFixed(1)}</span>`
      + ` <span class="rating-stars" aria-hidden="true">${stars(Math.round(summary.average))}</span>`
      + ` <span class="pkg-meta">${summary.count} rating${summary.count === 1 ? '' : 's'}</span>`
    : '<span class="pkg-meta">No ratings yet.</span>';
  const controls = reviewList
    ? `<nav class="review-controls" aria-label="Review list">
    <a href="${reviewListHref(name, { sort: 'newest' })}"${reviewList.sort === 'newest' ? ' aria-current="true"' : ''}>Newest</a>
    <a href="${reviewListHref(name, { sort: 'helpful' })}"${reviewList.sort === 'helpful' ? ' aria-current="true"' : ''}>Most helpful</a>
    <a href="${reviewListHref(name, { textOnly: true, sort: reviewList.sort })}"${reviewList.textOnly ? ' aria-current="true"' : ''}>With text</a>
    ${reviewList.textOnly ? `<a href="${reviewListHref(name, { sort: reviewList.sort })}">All</a>` : ''}
    <span class="pkg-meta">${reviewList.total} review${reviewList.total === 1 ? '' : 's'}</span>
  </nav>`
    : '';
  const list = ratings.length === 0
    ? '<p class="pkg-meta">No reviews here yet.</p>'
    : `<ul class="rating-list">
${ratings.map((entry) => {
    const votes = entry.votes || { up: 0, down: 0, mine: 0 };
    const voteForm = canVote
      ? `<form class="vote-form" method="post" action="/packages/${encodeURIComponent(name)}/reviews/${encodeURIComponent(entry.githubId)}/vote">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="button vote-button" type="submit" name="value" value="up"
        aria-label="Helpful" aria-pressed="${votes.mine === 1 ? 'true' : 'false'}">&#9650; ${votes.up}</button>
      <button class="button vote-button" type="submit" name="value" value="down"
        aria-label="Not helpful" aria-pressed="${votes.mine === -1 ? 'true' : 'false'}">&#9660; ${votes.down}</button>
    </form>`
      : `<span class="pkg-meta">&#9650; ${votes.up} &middot; &#9660; ${votes.down}</span>`;
    const reply = entry.reply
      ? `<div class="review-reply">
      <p class="pkg-meta"><span class="status-pill status-approved">maintainer</span>
        ${profileLink(entry.reply.author.login)} &middot; ${formatWhen(entry.reply.at)}${entry.reply.updatedAt ? ' &middot; edited' : ''}</p>
      <p class="pkg-desc">${escapeHtml(entry.reply.body)}</p>
    </div>`
      : '';
    const replyForm = canReply
      ? `<form class="reply-form" method="post" action="/packages/${encodeURIComponent(name)}/reviews/${encodeURIComponent(entry.githubId)}/reply">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <textarea name="message" rows="2" maxlength="500" placeholder="Reply as a maintainer"
        aria-label="Maintainer reply" required>${escapeHtml(entry.reply ? entry.reply.body : '')}</textarea>
      <button class="button" type="submit">${entry.reply ? 'Update reply' : 'Reply as maintainer'}</button>
    </form>`
      : '';
    return `  <li class="rating-item">
    <div class="request-head">
      <span class="mono">${profileLink(entry.login)}</span>
      <span class="rating-stars" title="${entry.stars} of 5">${stars(entry.stars)}</span>
      <span class="pkg-meta">${formatWhen(entry.at)}</span>
    </div>
    ${entry.review ? `<p class="pkg-desc">${escapeHtml(entry.review)}</p>` : ''}
    <div class="review-social">${voteForm}</div>
    ${reply}
    ${replyForm}
  </li>`;
  }).join('\n')}
</ul>`;
  const pagination = reviewList && reviewList.pages > 1
    ? `<nav class="pagination review-pagination" aria-label="Review pages">
    ${reviewList.page > 1
      ? `<a href="${reviewListHref(name, { ...reviewList, page: reviewList.page - 1 })}">Previous</a>`
      : ''}
    <span class="pkg-meta">Page ${reviewList.page} of ${reviewList.pages}</span>
    ${reviewList.page < reviewList.pages
      ? `<a href="${reviewListHref(name, { ...reviewList, page: reviewList.page + 1 })}">Next</a>`
      : ''}
  </nav>`
    : '';
  const form = canRate
    ? `<form class="rating-form" method="post" action="/packages/${encodeURIComponent(name)}/rating">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <div class="form-grid">
    <label class="form-field">
      <span>Your rating</span>
      <select name="stars">
        ${[5, 4, 3, 2, 1].map((value) => `<option value="${value}"${myRating && myRating.stars === value ? ' selected' : ''}>${stars(value)}</option>`).join('')}
      </select>
    </label>
    <label class="form-field">
      <span>Short review (optional)</span>
      <textarea name="review" rows="2" maxlength="280"
        placeholder="What worked, what did not">${escapeHtml(myRating && myRating.review ? myRating.review : '')}</textarea>
    </label>
  </div>
  <button class="button primary" type="submit">${myRating ? 'Update rating' : 'Rate package'}</button>
</form>`
    : '<p class="pkg-meta"><a href="/login">Sign in</a> to rate this package.</p>';
  return `<section class="ratings-box" id="reviews">
  <h2>Reviews</h2>
  <p class="rating-summary">${summaryLine}</p>
  ${controls}
  ${list}
  ${pagination}
  ${form}
</section>`;
}

/** Pending maintainer claims with verify/reject controls (SESSION.md 21 A1).
 * `next` lets the admin console get the decision back on its own page. */
function claimRow(claim, csrf, next = '') {
  return `<li class="request-card">
  <div class="request-head">
    <a class="pkg-name" href="/packages/${encodeURIComponent(claim.package)}#maintainers">${escapeHtml(claim.package)}</a>
    <span class="status-pill status-pending">claim</span>
    <span class="pkg-meta">claimed by
      ${profileLink(claim.login)}
      &middot; ${formatWhen(claim.claimedAt)}</span>
  </div>
  <p class="pkg-meta">Verifying adds this account to the package&apos;s Maintainers list.
     It grants no publishing rights; scopes stay with tokens and OIDC entries.</p>
  <form class="decision-form" method="post"
    action="/review/claims/${encodeURIComponent(claim.package)}/${encodeURIComponent(claim.githubId)}/decision">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}
    <input name="note" placeholder="Reason (required to reject)" maxlength="500" aria-label="Claim decision note">
    <button class="button primary" type="submit" name="status" value="verified">Verify</button>
    <button class="button danger" type="submit" name="status" value="rejected">Reject</button>
  </form>
</li>`;
}

/** Reviewer queue: open reports first, then decisions and the closed record. */
function reviewPage({ account, reports, decisions = [], claims = [], csrf, notice = '', error = '', nav = '' }) {
  const open = reports.filter((report) => report.status === 'open');
  const closed = reports.filter((report) => report.status !== 'open');
  const noticeBlock = [
    notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : '',
    error ? `<p class="error-box" role="alert">${escapeHtml(error)}</p>` : '',
  ].filter(Boolean).join('\n');
  const section = (title, items, empty, render) => `<section>
  <h2>${escapeHtml(title)} <span class="count">${items.length}</span></h2>
  ${items.length === 0 ? `<p class="pkg-meta">${escapeHtml(empty)}</p>` : `<ul class="request-list">\n${items.map(render).join('\n')}\n</ul>`}
</section>`;
  const actioned = decisions.filter((entry) => entry.status);
  const decisionRow = (entry) => {
    const last = entry.history[entry.history.length - 1] || {};
    return `<li class="review-decision-row">
  <a class="pkg-name" href="/packages/${encodeURIComponent(entry.name)}">${escapeHtml(entry.name)}</a>
  ${decisionPill(entry)}
  <span class="pkg-meta">${last.actor ? profileLink(last.actor) : '@?'} &middot; ${formatWhen(last.at || '')}</span>
</li>`;
  };
  const body = `<section class="hero">
  <h1>Review queue</h1>
  <p>Community reports about published packages. Resolving or dismissing a report records
     your note and keeps the history public on the package page. Reports never alter
     artifacts or the index by themselves.</p>
  <div class="meta-row"><span>Signed in as @${escapeHtml(account.login)}</span></div>
</section>
${noticeBlock}
${section('Open reports', open, 'Nothing waiting for review.', (report) => openReportRow(report, csrf))}
<section id="ownership">
  <h2>Ownership claims <span class="count">${claims.length}</span></h2>
  ${claims.length === 0
    ? '<p class="pkg-meta">No maintainer claims are waiting.</p>'
    : `<ul class="request-list">\n${claims.map((claim) => claimRow(claim, csrf)).join('\n')}\n</ul>`}
</section>
${section('Package decisions', actioned, 'No package has a review decision yet.', decisionRow)}
${section('Closed', closed, 'No closed reports yet.', closedReportRow)}`;
  return layout({ title: 'Review queue', body, nav });
}

module.exports = {
  reviewPage,
  reportForm,
  decisionPill,
  reviewHistory,
  decisionControls,
  ratingsSection,
  claimRow,
  REASON_LABELS,
};
