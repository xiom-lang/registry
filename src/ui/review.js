// XIOM Package Registry -- reviewer queue pages (registry 2.0 phase 3).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Reviews and reports are moderation data: reviewers resolve or dismiss
// reports with a note, and the record keeps who did what and when. Nothing
// here touches artifacts, signatures, or the index (SESSION.md section 15).

'use strict';

const { escapeHtml, formatDate, layout } = require('./layout');

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
    <span class="mono">${escapeHtml(report.id)}</span>
    <span class="status-pill status-pending">${escapeHtml(reasonLabel(report.reason))}</span>
    <span class="pkg-meta"><a href="/packages/${encodeURIComponent(report.package)}">${escapeHtml(report.package)}</a>
      by <a href="https://github.com/${encodeURIComponent(report.reporter.login)}" rel="noopener">@${escapeHtml(report.reporter.login)}</a>
      &middot; ${escapeHtml(formatDate(report.createdAt))}</span>
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
    <span class="mono">${escapeHtml(report.id)}</span>
    <span class="status-pill status-${report.status === 'dismissed' ? 'denied' : 'approved'}">${escapeHtml(report.status)}</span>
    <span class="pkg-meta"><a href="/packages/${encodeURIComponent(report.package)}">${escapeHtml(report.package)}</a>
      &middot; ${escapeHtml(reasonLabel(report.reason))}
      &middot; @${escapeHtml(report.resolvedBy || '?')} ${escapeHtml(formatDate(report.resolvedAt || ''))}</span>
  </div>
  <p class="pkg-desc">${escapeHtml(report.note)}</p>
  ${report.resolution ? `<p class="pkg-meta">Resolution: ${escapeHtml(report.resolution)}</p>` : ''}
</li>`;
}

/** Human-review claims shown next to the publisher claims. */
function decisionPill(decision) {
  if (!decision || !decision.status) return '';
  const flagged = decision.status === 'flagged';
  const label = flagged ? 'flagged by a reviewer' : 'reviewed by a reviewer';
  return `<span class="status-pill status-${flagged ? 'denied' : 'approved'}">${escapeHtml(label)}</span>`;
}

/** Public review history for a package (audit trail of decisions). */
function reviewHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const items = history.map((entry) => {
    const note = entry.note ? ` \u2014 ${escapeHtml(entry.note)}` : '';
    return `<li><span class="mono">${escapeHtml(entry.action)}</span> by @${escapeHtml(entry.actor || '?')}`
      + ` &middot; ${escapeHtml(formatDate(entry.at))}${note}</li>`;
  }).join('\n');
  return `<details class="review-history">
  <summary>Review history <span class="count">${history.length}</span></summary>
  <ul class="review-history-list">
${items}
  </ul>
</details>`;
}

/** Reviewer controls for the current package. */
function decisionControls({ name, csrf }) {
  return `<form class="decision-form" method="post" action="/review/packages/${encodeURIComponent(name)}/decision">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input name="note" placeholder="Decision note (required to flag)" maxlength="500" aria-label="Decision note">
  <button class="button primary" type="submit" name="action" value="review">Mark reviewed</button>
  <button class="button danger" type="submit" name="action" value="flag">Flag</button>
  <button class="button" type="submit" name="action" value="clear">Clear</button>
</form>`;
}

/** Reviewer queue: open reports first, then decisions and the closed record. */
function reviewPage({ account, reports, decisions = [], csrf, notice = '', error = '', nav = '' }) {
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
  <span class="pkg-meta">@${escapeHtml(last.actor || '?')} &middot; ${escapeHtml(formatDate(last.at || ''))}</span>
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
${section('Package decisions', actioned, 'No package has a review decision yet.', decisionRow)}
${section('Closed', closed, 'No closed reports yet.', closedReportRow)}`;
  return layout({ title: 'Review queue', body, nav });
}

module.exports = { reviewPage, reportForm, decisionPill, reviewHistory, decisionControls, REASON_LABELS };
