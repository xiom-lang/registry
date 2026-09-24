// XIOM Package Registry -- account, request, and admin pages (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Server-rendered pages for GitHub sign-in, the self-service request form,
// and the admin approval queue. Every interpolated value passes through
// escapeHtml; the app never renders a token or a secret (SESSION.md 15).

'use strict';

const { escapeHtml, formatDate, layout } = require('./layout');

const STATUS_LABELS = {
  pending: 'pending review',
  approved: 'approved - awaiting fulfilment',
  denied: 'denied',
  fulfilled: 'fulfilled',
};

function noticeBox(notice, error) {
  const parts = [];
  if (notice) parts.push(`<p class="notice" role="status">${escapeHtml(notice)}</p>`);
  if (error) parts.push(`<p class="error-box" role="alert">${escapeHtml(error)}</p>`);
  return parts.join('\n');
}

function statusPill(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

/** Human summary of what a request asks for (never a secret). */
function requestTarget(record) {
  if (record.kind === 'publisher') {
    return `${record.repository} / ${record.workflow} @ ${record.refs.join(', ')}`;
  }
  return record.scopes.join(', ');
}

function kindLabel(record) {
  return record.kind === 'publisher' ? 'trusted publisher' : 'token';
}

/** Sign-in landing page (also the friendly result page for OAuth failures). */
function loginPage({ enabled, error = '', nav = '' }) {
  const body = enabled
    ? `<section class="hero">
  <h1>Sign in</h1>
  <p>Sign in with GitHub to request a publish token or a trusted-publisher entry.
     The registry reads your public profile (<code>read:user</code>) and links it to
     your requests; it never gains access to your repositories, and a browser
     session can never publish.</p>
</section>
${noticeBox('', error ? 'Sign-in failed or was cancelled. Try again.' : '')}
<div class="account-card">
  <a class="button primary" href="/auth/github/start">Sign in with GitHub</a>
  <p class="pkg-meta">By signing in you agree to the
     <a href="https://xiom-lang.org/terms.html">Terms of Use</a> and
     <a href="https://xiom-lang.org/privacy.html">Privacy Policy</a>.</p>
</div>`
    : `<section class="hero">
  <h1>Sign in</h1>
  <p>GitHub sign-in is not configured on this registry. Publishing is unaffected:
     tokens and OIDC trusted publishing keep working exactly as documented in
     <a href="https://github.com/xiom-lang/registry/blob/main/PUBLISHING.md">PUBLISHING.md</a>.</p>
</section>`;
  return layout({ title: 'Sign in', body, nav });
}

/** Self-service request form + the requester's own request list. */
function accountPage({ account, requests, csrf, notice = '', error = '', form = {}, nav = '', admin = false }) {
  const defaults = {
    kind: 'token',
    scopes: '',
    repository: '',
    workflow: '',
    refs: '',
    note: '',
    ...form,
  };
  const formHtml = `<form class="request-form" method="post" action="/requests" id="request">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <fieldset>
    <legend>What do you need?</legend>
    <label class="radio-row"><input type="radio" name="kind" value="token"
      ${defaults.kind === 'token' ? 'checked' : ''}>
      <span><strong>Publish token</strong> -- for publishing from your machine with
      <code>xiom pkg publish</code>.</span></label>
    <label class="radio-row"><input type="radio" name="kind" value="publisher"
      ${defaults.kind === 'publisher' ? 'checked' : ''}>
      <span><strong>Trusted publisher</strong> -- for publishing from a GitHub
      Actions workflow via OIDC. Preferred: no secret ever leaves GitHub.</span></label>
  </fieldset>
  <div class="form-grid">
    <label class="form-field">
      <span>Package names or namespaces</span>
      <input name="scopes" value="${escapeHtml(defaults.scopes)}"
        placeholder="my-lib, my-namespace" autocomplete="off" required>
      <small>Comma-separated. A namespace like <code>my-ns</code> covers
      <code>my-ns.*</code>; <code>*</code> is never granted from this form.</small>
    </label>
    <label class="form-field publisher-field">
      <span>Repository (owner/repo)</span>
      <input name="repository" value="${escapeHtml(defaults.repository)}"
        placeholder="alice/my-lib" autocomplete="off">
      <small>Trusted-publisher requests only.</small>
    </label>
    <label class="form-field publisher-field">
      <span>Workflow file</span>
      <input name="workflow" value="${escapeHtml(defaults.workflow)}"
        placeholder="publish.yml" autocomplete="off">
      <small>Path under <code>.github/workflows/</code>; trusted-publisher requests only.</small>
    </label>
    <label class="form-field publisher-field">
      <span>Refs</span>
      <input name="refs" value="${escapeHtml(defaults.refs)}"
        placeholder="refs/heads/main" autocomplete="off">
      <small>Comma-separated refs that may publish; trusted-publisher requests only.</small>
    </label>
    <label class="form-field">
      <span>Note (optional)</span>
      <textarea name="note" rows="3" maxlength="500"
        placeholder="Anything the reviewer should know">${escapeHtml(defaults.note)}</textarea>
    </label>
  </div>
  <button class="button primary" type="submit">Submit request</button>
</form>`;

  const rows = requests.length === 0
    ? '<p class="pkg-meta">No requests yet.</p>'
    : `<table class="versions request-table">
  <thead><tr><th>Request</th><th>Kind</th><th>Scope / target</th><th>Status</th><th>Updated</th></tr></thead>
  <tbody>
${requests.map((record) => {
    const updated = record.fulfilledAt || record.decidedAt || record.createdAt;
    return `    <tr>
      <td class="mono">${escapeHtml(record.id)}</td>
      <td>${escapeHtml(kindLabel(record))}</td>
      <td class="mono">${escapeHtml(requestTarget(record))}</td>
      <td>${statusPill(record.status)}</td>
      <td>${escapeHtml(formatDate(updated))}</td>
    </tr>`;
  }).join('\n')}
  </tbody>
</table>`;

  const body = `<section class="hero">
  <h1>@${escapeHtml(account.login)}</h1>
  <div class="meta-row">
    <span><a href="https://github.com/${encodeURIComponent(account.login)}" rel="noopener">github.com/${escapeHtml(account.login)}</a></span>
    <span>Signed in ${escapeHtml(formatDate(account.lastLoginAt))}</span>
  </div>
</section>
${noticeBox(notice, error)}
<div class="account-grid">
  <section>
    <h2>New request</h2>
    ${formHtml}
  </section>
  <section>
    <h2>My requests</h2>
    ${rows}
    ${admin ? '<p class="pkg-meta"><a href="/admin/requests">Open the admin approval queue</a></p>' : ''}
    <form method="post" action="/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="button" type="submit">Sign out</button>
    </form>
  </section>
</div>`;
  return layout({ title: `@${account.login}`, body, nav });
}

function pendingRow(record, csrf) {
  return `<li class="request-card">
  <div class="request-head">
    <span class="mono">${escapeHtml(record.id)}</span>
    ${statusPill(record.status)}
    <span class="pkg-meta">${escapeHtml(kindLabel(record))} by
      <a href="https://github.com/${encodeURIComponent(record.requester.login)}" rel="noopener">@${escapeHtml(record.requester.login)}</a>
      &middot; ${escapeHtml(formatDate(record.createdAt))}</span>
  </div>
  <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
  ${record.note ? `<p class="pkg-desc">${escapeHtml(record.note)}</p>` : ''}
  <form class="decision-form" method="post" action="/admin/requests/${encodeURIComponent(record.id)}/decision">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="note" placeholder="Decision note (optional)" maxlength="500">
    <button class="button primary" type="submit" name="action" value="approve">Approve</button>
    <button class="button danger" type="submit" name="action" value="deny">Deny</button>
  </form>
</li>`;
}

function approvedRow(record, csrf) {
  return `<li class="request-card">
  <div class="request-head">
    <span class="mono">${escapeHtml(record.id)}</span>
    ${statusPill(record.status)}
    <span class="pkg-meta">${escapeHtml(kindLabel(record))} by
      <a href="https://github.com/${encodeURIComponent(record.requester.login)}" rel="noopener">@${escapeHtml(record.requester.login)}</a>
      &middot; approved by @${escapeHtml(record.decidedBy || '?')} ${escapeHtml(formatDate(record.decidedAt))}</span>
  </div>
  <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
  <form class="decision-form" method="post" action="/admin/requests/${encodeURIComponent(record.id)}/fulfil">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="reference" placeholder="Fulfilment reference (e.g. label, mail date)" maxlength="500" required>
    <button class="button primary" type="submit">Mark fulfilled</button>
  </form>
</li>`;
}

function closedRow(record) {
  const when = record.fulfilledAt || record.decidedAt || record.createdAt;
  const detail = record.mintReference ? ` &middot; ${escapeHtml(record.mintReference)}` : '';
  return `<li class="request-card closed">
  <div class="request-head">
    <span class="mono">${escapeHtml(record.id)}</span>
    ${statusPill(record.status)}
    <span class="pkg-meta">@${escapeHtml(record.requester.login)} &middot; ${escapeHtml(formatDate(when))}${detail}</span>
  </div>
  <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
</li>`;
}

/** Admin approval queue: decisions and fulfilment records. */
function adminPage({ account, requests, csrf, notice = '', error = '', nav = '' }) {
  const pending = requests.filter((record) => record.status === 'pending');
  const approved = requests.filter((record) => record.status === 'approved');
  const closed = requests.filter((record) => record.status === 'denied' || record.status === 'fulfilled');
  const section = (title, items, empty, render) => `<section>
  <h2>${escapeHtml(title)} <span class="count">${items.length}</span></h2>
  ${items.length === 0 ? `<p class="pkg-meta">${escapeHtml(empty)}</p>` : `<ul class="request-list">\n${items.map(render).join('\n')}\n</ul>`}
</section>`;

  const body = `<section class="hero">
  <h1>Approval queue</h1>
  <p>Signed in as <a href="https://github.com/${encodeURIComponent(account.login)}" rel="noopener">@${escapeHtml(account.login)}</a>.
     Minting and mailing stay on the host: run the token/publisher flow there against an
     approved request, then record a fulfilment reference here. The app never sees the
     token and never holds mail credentials.</p>
</section>
${noticeBox(notice, error)}
${section('Pending', pending, 'Nothing waiting for a decision.', (record) => pendingRow(record, csrf))}
${section('Approved, awaiting fulfilment', approved, 'Nothing approved but unfulfilled.', (record) => approvedRow(record, csrf))}
${section('Closed', closed, 'No closed requests yet.', closedRow)}`;
  return layout({ title: 'Approval queue', body, nav });
}

module.exports = { loginPage, accountPage, adminPage, requestTarget, kindLabel };
