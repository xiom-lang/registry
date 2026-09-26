// XIOM Package Registry -- account, request, and admin pages (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Server-rendered pages for GitHub sign-in, the self-service request form,
// and the admin approval queue. Every interpolated value passes through
// escapeHtml; the app never renders a token or a secret (SESSION.md 15).

'use strict';

const { escapeHtml, formatWhen, shortId } = require('./format');
const { layout } = require('./layout');

const STATUS_LABELS = {
  pending: 'pending review',
  approved: 'approved - awaiting fulfilment',
  denied: 'denied',
  fulfilled: 'fulfilled',
};

const ROLE_LABELS = {
  admin: 'maintainer (admin)',
  reviewer: 'reviewer',
  member: 'member',
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

/** Shared tabs for the four account pages. */
function accountTabs(active) {
  const tab = (href, label, key) => {
    const current = active === key;
    return `<a class="account-tab${current ? ' active' : ''}" href="${href}"`
      + `${current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  };
  return `<nav class="account-tabs" aria-label="Account pages">
  ${tab('/account', 'Overview', 'overview')}
  ${tab('/account/requests', 'Requests', 'requests')}
  ${tab('/account/notifications', 'Notifications', 'notifications')}
  ${tab('/account/settings', 'Settings', 'settings')}
</nav>`;
}

function historyLine(record) {
  if (!Array.isArray(record.history) || record.history.length === 0) return '';
  const parts = record.history.map((entry) => {
    const note = entry.note ? ` (${entry.note})` : '';
    return `${entry.action} by @${entry.actor || '?'}${note}`;
  });
  return `<p class="pkg-meta request-history">${escapeHtml(parts.join(' \u00b7 '))}</p>`;
}

/** Status + suspension banner shared by every account page. */
function accountBanner({ account, status, notice, error }) {
  const suspended = status === 'suspended'
    ? '<p class="notice notice-muted" role="status">This account is suspended: you can browse and '
      + 'read everything, but requests, reports, and ratings are disabled. Contact '
      + '<a href="mailto:registry@xiom-lang.org">registry@xiom-lang.org</a> to resolve it.</p>'
    : '';
  return `${suspended}\n${noticeBox(notice, error)}`;
}

/** Sign-in landing page (also the friendly result page for OAuth failures). */
function loginPage({ enabled, error = '', nav = '' }) {
  const errorMessage = error === 'banned'
    ? 'This account is banned from the registry. Contact registry@xiom-lang.org if you believe this is a mistake.'
    : (error ? 'Sign-in failed or was cancelled. Try again.' : '');
  const body = enabled
    ? `<section class="hero">
  <h1>Sign in</h1>
  <p>Sign in with GitHub to request a publish token or a trusted-publisher entry.
     You will be redirected to GitHub; the registry reads only your public
     profile (<code>read:user</code>), never your repositories, and a browser
     session can never publish.</p>
</section>
${noticeBox('', errorMessage)}
<div class="account-card">
  <a class="button primary" href="/auth/github/start">Sign in with GitHub</a>
  <p class="pkg-meta">By signing in you agree to the
     <a href="https://xiom-lang.org/terms.html">Terms of Use</a> and
     <a href="https://xiom-lang.org/privacy.html">Privacy Policy</a>.</p>
  <p class="pkg-meta">Publishing does not need sign-in:
     <a href="/packages">browse packages</a> or read the
     <a href="/publish">publishing guide</a>.</p>
</div>`
    : `<section class="hero">
  <h1>Sign in</h1>
  <p>GitHub sign-in is not configured on this registry. Publishing is unaffected:
     tokens and OIDC trusted publishing keep working exactly as documented in the
     <a href="/publish">publishing guide</a>.</p>
</section>`;
  return layout({ title: 'Sign in', body, nav });
}

/** Self-service request form, shared by the requests page (Signed in only). */
function requestForm({ csrf, defaults = {}, disabled = false }) {
  const values = {
    kind: 'token',
    scopes: '',
    repository: '',
    workflow: '',
    refs: '',
    note: '',
    ...defaults,
  };
  return `<form class="request-form" method="post" action="/requests" id="request">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <fieldset>
    <legend>What do you need?</legend>
    <label class="radio-row"><input type="radio" name="kind" value="token"
      ${values.kind === 'token' ? 'checked' : ''}${disabled ? ' disabled' : ''}>
      <span><strong>Publish token</strong> &mdash; for publishing from your own machine,
      or CI that is not GitHub Actions. A maintainer mints a token scoped to your
      package and sends it to you privately. You still sign with your own key.</span></label>
    <label class="radio-row"><input type="radio" name="kind" value="publisher"
      ${values.kind === 'publisher' ? 'checked' : ''}${disabled ? ' disabled' : ''}>
      <span><strong>Trusted publisher</strong> &mdash; for publishing from GitHub Actions.
      <strong>No secret exists:</strong> the registry verifies your repository, workflow,
      and ref through GitHub OIDC. One click for maintainers to approve.
      <strong>Recommended.</strong></span></label>
    <p class="pkg-meta">Not sure which one? Read the
       <a href="/publish">5-minute publishing guide</a>; it walks through both paths,
       tags, and the workflow template.</p>
  </fieldset>
  <div class="form-grid">
    <label class="form-field">
      <span>Package names or namespaces you publish</span>
      <input name="scopes" value="${escapeHtml(values.scopes)}"
        placeholder="my-lib, my-namespace" autocomplete="off" required${disabled ? ' disabled' : ''}>
      <small>Comma-separated. A namespace like <code>my-ns</code> covers
      <code>my-ns.*</code>; <code>*</code> is never granted from this form.</small>
    </label>
  </div>
  <fieldset class="publisher-fields">
    <legend>Trusted publisher details (only for a trusted-publisher request)</legend>
    <p class="pkg-meta">First time? <a href="/ui/templates/community-publish.yml">Download the workflow
       template</a>, save it as <code>.github/workflows/publish-registry.yml</code> in your repo
       (the <a href="/publish">guide</a> shows exactly where), then fill these fields.</p>
    <div class="form-grid">
      <label class="form-field">
        <span>Repository (owner/repo)</span>
        <input name="repository" value="${escapeHtml(values.repository)}"
          placeholder="alice/my-lib" autocomplete="off"${disabled ? ' disabled' : ''}>
      </label>
      <label class="form-field">
        <span>Workflow file</span>
        <input name="workflow" value="${escapeHtml(values.workflow)}"
          placeholder="publish-registry.yml" autocomplete="off"${disabled ? ' disabled' : ''}>
        <small>Path under <code>.github/workflows/</code>.</small>
      </label>
      <label class="form-field">
        <span>Refs</span>
        <input name="refs" value="${escapeHtml(values.refs)}"
          placeholder="refs/tags/v*, refs/heads/main" autocomplete="off"${disabled ? ' disabled' : ''}>
        <small>Comma-separated. For releases, <code>refs/tags/v*</code> is usually what you want.</small>
      </label>
    </div>
  </fieldset>
  <div class="form-grid">
    <label class="form-field">
      <span>Note (optional)</span>
      <textarea name="note" rows="3" maxlength="500"${disabled ? ' disabled' : ''}
        placeholder="Anything the reviewer should know">${escapeHtml(values.note)}</textarea>
    </label>
  </div>
  <button class="button primary" type="submit"${disabled ? ' disabled' : ''}>Submit request</button>
</form>`;
}

/** Full request history table for /account/requests. */
function requestTable(requests) {
  if (requests.length === 0) {
    return '<div class="empty">No requests yet. Fill in the form above and a maintainer '
      + 'will review it, usually within a day.</div>';
  }
  return `<table class="versions request-table table-cards">
  <thead><tr><th>Request</th><th>Kind</th><th>Scope / target</th><th>Status</th><th>Updated</th></tr></thead>
  <tbody>
${requests.map((record) => {
    const updated = record.fulfilledAt || record.decidedAt || record.createdAt;
    return `    <tr>
      <td class="mono" data-label="Request">${shortId(record.id)}</td>
      <td data-label="Kind">${escapeHtml(kindLabel(record))}</td>
      <td class="mono" data-label="Scope / target">${escapeHtml(requestTarget(record))}</td>
      <td data-label="Status">${statusPill(record.status)}${historyLine(record)}</td>
      <td data-label="Updated">${formatWhen(updated)}</td>
    </tr>`;
  }).join('\n')}
  </tbody>
</table>`;
}

/** Compact "latest requests" list for the overview page. */
function requestPreview(requests) {
  if (requests.length === 0) {
    return '<p class="pkg-meta">No requests yet. '
      + '<a href="/account/requests">Request a token or a trusted publisher</a> when you are ready to publish.</p>';
  }
  return `<ul class="request-list">
${requests.slice(0, 3).map((record) => `  <li class="request-card">
    <div class="request-head">
      <span class="request-id">${shortId(record.id)}</span>
      ${statusPill(record.status)}
      <span class="pkg-meta">${escapeHtml(kindLabel(record))} &middot; ${formatWhen(record.createdAt)}</span>
    </div>
    <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
  </li>`).join('\n')}
</ul>
<p class="pkg-meta"><a href="/account/requests">All requests and the request form &rarr;</a></p>`;
}

function notificationCards(notifications, { compact = false } = {}) {
  const list = compact ? notifications.slice(0, 3) : notifications;
  if (list.length === 0) {
    return '<p class="pkg-meta">Nothing yet. Approvals, review decisions, and '
      + 'fulfilment notices appear here.</p>';
  }
  return `<ul class="request-list">
${list.map((entry) => `  <li class="request-card${entry.readAt ? ' closed' : ''}">
    <div class="request-head">
      <span class="mono">${escapeHtml(entry.kind)}</span>
      ${entry.readAt ? '' : '<span class="status-pill status-pending">new</span>'}
      <span class="pkg-meta">${formatWhen(entry.createdAt)}</span>
    </div>
    <p class="pkg-desc">${escapeHtml(entry.subject)}</p>
    ${entry.body ? `<p class="pkg-meta">${escapeHtml(entry.body)}</p>` : ''}
  </li>`).join('\n')}
</ul>`;
}

function accountHero(account, { title, subtitle = '' }) {
  const avatar = typeof account.avatarUrl === 'string' && account.avatarUrl.startsWith('https://')
    ? `<img class="account-avatar" src="${escapeHtml(account.avatarUrl)}" alt=""`
      + ' width="48" height="48" loading="lazy" referrerpolicy="no-referrer">'
    : '';
  return `<section class="hero account-hero">
  ${avatar}
  <div>
    <h1>${escapeHtml(title || `@${account.login}`)}</h1>
    <div class="meta-row">
      <span><a href="https://github.com/${encodeURIComponent(account.login)}" rel="noopener">github.com/${escapeHtml(account.login)}</a></span>
      ${subtitle}
    </div>
  </div>
</section>`;
}

/**
 * Account overview: who you are, role/status, and the newest activity.
 * `role` is 'admin' | 'reviewer' | 'member'; `status` is 'active' | 'suspended'.
 */
function accountOverviewPage({
  account,
  role = 'member',
  status = 'active',
  requests = [],
  notifications = [],
  csrf,
  notice = '',
  error = '',
  nav = '',
}) {
  const unread = notifications.filter((entry) => !entry.readAt).length;
  const body = `${accountHero(account, {
    subtitle: `<span>Joined ${formatWhen(account.createdAt)}</span>`
      + `<span>Last sign-in ${formatWhen(account.lastLoginAt)}</span>`
      + `<span class="status-pill status-approved">${escapeHtml(ROLE_LABELS[role] || role)}</span>`,
  })}
${accountTabs('overview')}
${accountBanner({ account, status, notice, error })}
<div class="account-grid">
  <section>
    <h2>Requests</h2>
    ${requestPreview(requests)}
  </section>
  <section>
    <h2>Notifications <span class="count">${unread > 0 ? `${unread} new` : ''}</span></h2>
    ${notificationCards(notifications, { compact: true })}
    <p class="pkg-meta"><a href="/account/notifications">All notifications${unread > 0 ? ` (${unread} new)` : ''} &rarr;</a></p>
  </section>
</div>
${role === 'admin'
    ? '<p class="pkg-meta"><a href="/admin">Open the admin console &rarr;</a></p>'
    : ''}
${role === 'reviewer'
    ? '<p class="pkg-meta"><a href="/review">Open the review queue &rarr;</a></p>'
    : ''}
<form method="post" action="/logout" class="account-signout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button class="button" type="submit">Sign out</button>
</form>`;
  return layout({ title: `@${account.login}`, body, nav });
}

/** Request form + history. */
function accountRequestsPage({
  account,
  requests = [],
  csrf,
  notice = '',
  error = '',
  form = {},
  status = 'active',
  nav = '',
}) {
  const body = `${accountHero(account, { title: 'Requests' })}
${accountTabs('requests')}
${accountBanner({ account, status, notice, error })}
<h2>New request</h2>
${status === 'active'
    ? requestForm({ csrf, defaults: form })
    : '<p class="notice notice-muted">Requests are disabled while this account is suspended.</p>'}
<h2>My requests <span class="count">${requests.length}</span></h2>
${requestTable(requests)}`;
  return layout({ title: 'Requests', body, nav });
}

/** In-app notifications, read state, and the mark-all-read action. */
function accountNotificationsPage({
  account,
  notifications = [],
  csrf,
  notice = '',
  error = '',
  status = 'active',
  nav = '',
}) {
  const unread = notifications.filter((entry) => !entry.readAt).length;
  const body = `${accountHero(account, { title: 'Notifications' })}
${accountTabs('notifications')}
${accountBanner({ account, status, notice, error })}
<section>
  <h2>In-app notices <span class="count">${unread > 0 ? `${unread} new` : notifications.length}</span></h2>
  ${unread > 0
    ? `<form method="post" action="/account/notifications/read" class="inline-form">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button class="button" type="submit">Mark all as read</button>
  </form>`
    : ''}
  ${notificationCards(notifications)}
  <p class="pkg-meta">Email delivery is optional and configured in
     <a href="/account/settings">Settings</a>.</p>
</section>`;
  return layout({ title: 'Notifications', body, nav });
}

/** Account settings: notification email, session, and account facts. */
function accountSettingsPage({
  account,
  notifyEmail = '',
  csrf,
  notice = '',
  error = '',
  role = 'member',
  status = 'active',
  nav = '',
}) {
  const body = `${accountHero(account, { title: 'Settings' })}
${accountTabs('settings')}
${accountBanner({ account, status, notice, error })}
<div class="account-grid">
  <section>
    <h2>Notification email</h2>
    <p class="pkg-meta">Used only for approvals, review decisions, and fulfilment notices.</p>
    <form method="post" action="/account/email" class="email-form" id="email">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="form-grid">
        <label class="form-field">
          <span>Email address</span>
          <input name="email" type="email" value="${escapeHtml(notifyEmail)}"
            placeholder="you@example.com" autocomplete="email">
          <small>Clear the field and save to turn email off. In-app notices still appear here.</small>
        </label>
      </div>
      <button class="button primary" type="submit">Save email</button>
    </form>
  </section>
  <section>
    <h2>Account</h2>
    <dl class="detail-grid review-history-list">
      <div class="detail"><dt>GitHub account</dt><dd>@${escapeHtml(account.login)}</dd></div>
      <div class="detail"><dt>Joined</dt><dd>${formatWhen(account.createdAt)}</dd></div>
      <div class="detail"><dt>Role</dt><dd>${escapeHtml(ROLE_LABELS[role] || role)}</dd></div>
      <div class="detail"><dt>Status</dt><dd>${status === 'active' ? 'active' : escapeHtml(status)}</dd></div>
    </dl>
    <p class="pkg-meta">Roles are granted by maintainers in the admin console and every change is audited.</p>
    <form method="post" action="/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="button" type="submit">Sign out</button>
    </form>
  </section>
</div>`;
  return layout({ title: 'Settings', body, nav });
}

module.exports = {
  loginPage,
  accountOverviewPage,
  accountRequestsPage,
  accountNotificationsPage,
  accountSettingsPage,
  requestForm,
  requestTarget,
  kindLabel,
  noticeBox,
  statusPill,
  historyLine,
};
