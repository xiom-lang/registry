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
const { sponsorBadge } = require('./profile');
const { activityList } = require('./activity');

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

// A2 (SESSION.md 22.4): the structured notification kinds get human labels;
// legacy kinds keep their raw id.
const NOTICE_KIND_LABELS = {
  claim: 'maintainer claim',
  report: 'report update',
  review: 'package decision',
  support: 'maintainer message',
  'review-reply': 'review reply',
  'verify-email': 'email confirmation',
};

/** Only registry-relative or https links become anchors (defense in depth). */
function noticeLink(value) {
  const link = typeof value === 'string' ? value : '';
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  if (link.startsWith('https://')) return link;
  return '';
}

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
  if (String(record.kind).startsWith('publisher')) {
    return `${record.repository} / ${record.workflow} @ ${record.refs.join(', ')}`;
  }
  return record.scopes.join(', ');
}

const REQUEST_KIND_LABELS = {
  token: 'token',
  publisher: 'trusted publisher',
  'publisher-edit': 'publisher change',
  'publisher-revoke': 'publisher revocation',
  'token-rotation': 'token rotation',
};

function kindLabel(record) {
  return REQUEST_KIND_LABELS[record.kind] || record.kind;
}

/** Shared tabs for the account pages; the Admin tab is admin-only. */
function accountTabs(active, { admin = false } = {}) {
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
  ${admin ? tab('/admin', 'Admin', 'admin') : ''}
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

function notificationCards(notifications, { compact = false, csrf = '' } = {}) {
  const list = compact ? notifications.slice(0, 3) : notifications;
  if (list.length === 0) {
    return '<p class="pkg-meta">Nothing yet. Approvals, review decisions, and '
      + 'fulfilment notices appear here.</p>';
  }
  return `<ul class="request-list">
${list.map((entry) => {
    const link = noticeLink(entry.link);
    const abuse = !compact && csrf && entry.kind === 'support' && entry.ref
      ? `<form method="post" action="/account/notifications/${entry.id}/abuse" class="inline-form">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="button" type="submit">Report abuse</button>
      <span class="pkg-meta">Flags this message to the moderators.</span>
    </form>`
      : '';
    return `  <li class="request-card${entry.readAt ? ' closed' : ''}">
    <div class="request-head">
      <span class="mono">${escapeHtml(NOTICE_KIND_LABELS[entry.kind] || entry.kind)}</span>
      ${entry.readAt ? '' : '<span class="status-pill status-pending">new</span>'}
      <span class="pkg-meta">${formatWhen(entry.createdAt)}</span>
    </div>
    <p class="pkg-desc">${escapeHtml(entry.subject)}</p>
    ${entry.body ? `<p class="pkg-meta">${escapeHtml(entry.body)}</p>` : ''}
    ${link ? `<p class="pkg-meta"><a href="${escapeHtml(link)}">View details &rarr;</a></p>` : ''}
    ${abuse}
  </li>`;
  }).join('\n')}
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
 * `sponsor` is the A4 opt-in state ({ optedIn, state, checkedAt }).
 */
function accountOverviewPage({
  account,
  role = 'member',
  status = 'active',
  requests = [],
  notifications = [],
  maintained = [],
  sponsor = { optedIn: false, state: '', checkedAt: '' },
  csrf,
  notice = '',
  error = '',
  nav = '',
}) {
  const unread = notifications.filter((entry) => !entry.readAt).length;
  const maintainedRow = (entry) => {
    const labels = [];
    if (entry.sources.includes('provenance')) labels.push('publish provenance');
    if (entry.sources.includes('trusted-publisher')) labels.push('approved trusted publisher');
    if (entry.sources.includes('token')) labels.push('approved token');
    if (entry.sources.includes('verified-claim')) labels.push('verified claim');
    const pending = entry.claimStatus === 'pending'
      ? '<span class="status-pill status-pending">claim awaiting verification</span>'
      : '';
    return `<li class="maintainer-row">
  <a class="pkg-name" href="/packages/${encodeURIComponent(entry.name)}">${escapeHtml(entry.name)}</a>
  ${pending}
  ${labels.length > 0 ? `<span class="pkg-meta">${labels.join(' &middot; ')}</span>` : ''}
</li>`;
  };
  const maintainedBlock = maintained.length === 0
    ? '<p class="pkg-meta">You are not listed as a maintainer of any package yet. Open a package '
      + 'you publish and use &ldquo;I maintain this package&rdquo; to claim it.</p>'
    : `<ul class="maintainer-list">\n${maintained.map(maintainedRow).join('\n')}\n</ul>`;
  // A4: the Sponsors badge state in the overview, mirroring the settings
  // language -- verified shows the badge, "not listed" and off link there.
  const sponsorVisual = !sponsor.optedIn
    ? '<span><a href="/account/settings#sponsors">Sponsors badge: off</a></span>'
    : (sponsor.state === 'sponsor'
      ? `<span>${sponsorBadge(account.login)}</span>`
      : (sponsor.state === 'not'
        ? '<span><a href="/account/settings#sponsors">Sponsors badge: no public listing</a></span>'
        : '<span><a href="/account/settings#sponsors">Sponsors badge: unverified</a></span>'));
  const body = `${accountHero(account, {
    subtitle: `<span>Joined ${formatWhen(account.createdAt)}</span>`
      + `<span>Last sign-in ${formatWhen(account.lastLoginAt)}</span>`
      + `<span class="status-pill status-approved">${escapeHtml(ROLE_LABELS[role] || role)}</span>`
      + sponsorVisual,
  })}
${accountTabs('overview', { admin: role === 'admin' })}
${accountBanner({ account, status, notice, error })}
<section>
  <h2>Packages you maintain <span class="count">${maintained.length}</span></h2>
  ${maintainedBlock}
</section>
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
${role === 'reviewer'
    ? '<p class="pkg-meta"><a href="/review">Open the review queue &rarr;</a></p>'
    : ''}
<form method="post" action="/logout" class="account-signout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button class="button" type="submit">Sign out</button>
</form>`;
  return layout({ title: `@${account.login}`, body, nav });
}

/**
 * "Your grants" (B4/B5): approved/fulfilled publisher entries and fulfilled
 * token requests, with owner-facing change, revocation, and rotation
 * requests. Nothing here executes anything: each form files a request an
 * admin confirms from the queue, and a pending change hides the forms for
 * its target until it is decided.
 */
function grantsBlock(requests, { csrf }) {
  const pendingTargets = new Set(requests
    .filter((record) => record.status === 'pending' && record.targetRequestId)
    .map((record) => record.targetRequestId));
  const grants = requests
    .filter((record) => (record.status === 'approved' || record.status === 'fulfilled')
      && (record.kind === 'publisher' || record.kind === 'token'))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (grants.length === 0) {
    return '<p class="pkg-meta">Nothing to manage yet: approved trusted publishers and '
      + 'fulfilled tokens appear here.</p>';
  }
  return `<ul class="request-list">
${grants.map((record) => {
    const pending = pendingTargets.has(record.id)
      ? '<span class="status-pill status-pending">change pending</span>'
      : '';
    if (record.kind === 'token') {
      return `  <li class="request-card">
    <div class="request-head">
      <span class="pkg-name">token grant</span>
      <span class="mono request-id">${shortId(record.id)}</span>
      ${statusPill(record.status)}
      ${pending}
    </div>
    <p class="mono request-target">${escapeHtml(record.scopes.join(', '))}</p>
    ${pending ? '' : `<form method="post" action="/account/tokens/${encodeURIComponent(record.id)}/rotate" class="inline-form">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input name="note" maxlength="500" placeholder="Why rotate? (optional)" autocomplete="off">
      <button class="button" type="submit">Request rotation</button>
    </form>`}
  </li>`;
    }
    return `  <li class="request-card">
    <div class="request-head">
      <span class="pkg-name">${escapeHtml(record.repository)}</span>
      <span class="pkg-meta">${escapeHtml(record.workflow)}</span>
      ${statusPill(record.status)}
      ${pending}
    </div>
    <p class="mono request-target">${escapeHtml(record.refs.join(', '))} &middot; scopes: ${escapeHtml(record.scopes.join(', '))}</p>
    ${pending ? '' : `<details class="grant-change">
      <summary>Request a change</summary>
      <form method="post" action="/account/publishers/${encodeURIComponent(record.id)}/edit">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <div class="form-grid">
          <label class="form-field"><span>Repository (owner/repo)</span>
            <input name="repository" value="${escapeHtml(record.repository)}" autocomplete="off" required></label>
          <label class="form-field"><span>Workflow file</span>
            <input name="workflow" value="${escapeHtml(record.workflow)}" autocomplete="off" required></label>
          <label class="form-field"><span>Refs</span>
            <input name="refs" value="${escapeHtml(record.refs.join(', '))}" autocomplete="off" required></label>
          <label class="form-field"><span>Package names or namespaces</span>
            <input name="scopes" value="${escapeHtml(record.scopes.join(', '))}" autocomplete="off" required></label>
          <label class="form-field"><span>Note (optional)</span>
            <input name="note" maxlength="500" autocomplete="off"></label>
        </div>
        <button class="button primary" type="submit">Request change</button>
      </form>
    </details>
    <form method="post" action="/account/publishers/${encodeURIComponent(record.id)}/revoke" class="inline-form">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input name="note" maxlength="500" placeholder="Why revoke? (optional)" autocomplete="off">
      <button class="button" type="submit">Request revocation</button>
    </form>`}
  </li>`;
  }).join('\n')}
</ul>`;
}

/** Request form + history. */
function accountRequestsPage({
  account,
  requests = [],
  csrf,
  notice = '',
  error = '',
  form = {},
  role = 'member',
  status = 'active',
  nav = '',
}) {
  const body = `${accountHero(account, { title: 'Requests' })}
${accountTabs('requests', { admin: role === 'admin' })}
${accountBanner({ account, status, notice, error })}
<h2>New request</h2>
${status === 'active'
    ? requestForm({ csrf, defaults: form })
    : '<p class="notice notice-muted">Requests are disabled while this account is suspended.</p>'}
<h2>My requests <span class="count">${requests.length}</span></h2>
${requestTable(requests)}
<h2>Your grants</h2>
${grantsBlock(requests, { csrf })}`;
  return layout({ title: 'Requests', body, nav });
}

/** In-app notifications, read state, and the mark-all-read action. */
function accountNotificationsPage({
  account,
  notifications = [],
  csrf,
  notice = '',
  error = '',
  role = 'member',
  status = 'active',
  nav = '',
}) {
  const unread = notifications.filter((entry) => !entry.readAt).length;
  const body = `${accountHero(account, { title: 'Notifications' })}
${accountTabs('notifications', { admin: role === 'admin' })}
${accountBanner({ account, status, notice, error })}
<section>
  <h2>In-app notices <span class="count">${unread > 0 ? `${unread} new` : notifications.length}</span></h2>
  ${unread > 0
    ? `<form method="post" action="/account/notifications/read" class="inline-form">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button class="button" type="submit">Mark all as read</button>
  </form>`
    : ''}
  ${notificationCards(notifications, { csrf })}
  <p class="pkg-meta">Email delivery is optional and configured in
     <a href="/account/settings">Settings</a>.</p>
</section>`;
  return layout({ title: 'Notifications', body, nav });
}

/** Account settings: notification email, session, and account facts. */
function accountSettingsPage({
  account,
  notifyEmail = '',
  notifyEmailVerified = false,
  notifyEmailPending = false,
  notifyKinds = null,
  sponsor = { optedIn: false, state: '', checkedAt: '' },
  sponsorCheckEnabled = false,
  csrf,
  notice = '',
  error = '',
  role = 'member',
  status = 'active',
  nav = '',
}) {
  const kindOn = (kind) => !notifyKinds || notifyKinds[kind] !== false;
  const kindRow = (kind, label) => `<label class="radio-row">
      <input type="checkbox" name="${kind}" ${kindOn(kind) ? 'checked' : ''}>
      <span>${escapeHtml(label)}</span></label>`;
  const emailState = !notifyEmail
    ? '<p class="pkg-meta">Email is off. In-app notices keep arriving on this page.</p>'
    : (notifyEmailVerified
      ? '<p class="pkg-meta"><span class="status-pill status-approved">verified</span> '
        + 'This address is verified. Emails start as soon as the registry\'s mail service is enabled.</p>'
      : `<p class="pkg-meta"><span class="status-pill status-pending">unverified</span> `
        + `${notifyEmailPending ? 'A confirmation link is queued for this address.' : 'Save the address to queue a confirmation link.'} `
        + 'It is delivered when the registry\'s mail service is enabled; in-app notices work either way.</p>');
  const body = `${accountHero(account, { title: 'Settings' })}
${accountTabs('settings', { admin: role === 'admin' })}
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
    ${emailState}
    <h3 id="notifications" class="account-subhead">Notification types</h3>
    <p class="pkg-meta">Turn a type off to stop both its in-app notices and its email.
       Everything is on by default.</p>
    <form method="post" action="/account/notify-kinds" id="notify-kinds">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${kindRow('claim', 'Maintainer claim decisions')}
      ${kindRow('report', 'Report updates')}
      ${kindRow('review', 'Package review decisions')}
      ${kindRow('support', 'Messages from the community')}
      ${kindRow('review-reply', 'Replies to your reviews')}
      ${kindRow('release', 'New releases of packages you watch')}
      <button class="button primary" type="submit">Save notification types</button>
    </form>
    <h3 id="sponsors" class="account-subhead">GitHub Sponsors badge</h3>
    <p class="pkg-meta">Optional and off by default. Opting in asks GitHub whether your
       account has a public sponsors listing (cached, refreshed only when you ask) and
       shows a badge on your public profile. The registry handles no money and stores
       no payment data.</p>
    <form method="post" action="/account/sponsors" class="email-form" id="sponsor-form">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label class="radio-row"><input type="checkbox" name="badge" value="1"
        ${sponsor.optedIn ? 'checked' : ''}>
        <span>Show a Sponsors badge on my profile</span></label>
      <button class="button primary" type="submit">Save badge</button>
      ${sponsor.optedIn ? '<button class="button" type="submit" name="refresh" value="1">Refresh check</button>' : ''}
    </form>
    ${!sponsor.optedIn
    ? '<p class="pkg-meta">The badge is off.</p>'
    : (sponsor.state === 'sponsor'
      ? `<p class="pkg-meta"><span class="status-pill status-approved">verified</span> `
        + `${sponsorBadge(account.login)} confirmed${sponsor.checkedAt ? ` ${formatWhen(sponsor.checkedAt)}` : ''}.</p>`
      : (sponsor.state === 'not'
        ? '<p class="pkg-meta"><span class="status-pill status-pending">not listed</span> '
          + `GitHub reports no public sponsors listing${sponsor.checkedAt ? ` (checked ${formatWhen(sponsor.checkedAt)})` : ''}. `
          + 'Create one at <a href="https://github.com/sponsors" rel="noopener">github.com/sponsors</a>, then refresh.</p>'
        : (!sponsorCheckEnabled
          ? '<p class="pkg-meta"><span class="status-pill status-muted">unverified</span> '
            + 'Sponsors checks are not configured on this registry, so the badge stays hidden.</p>'
          : '<p class="pkg-meta"><span class="status-pill status-muted">unverified</span> '
            + 'No check has landed yet; save or refresh to run one.</p>')))}
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

/**
 * Signed-in account feed (A5): the merged public activity trail of every
 * watched package, newest first, with the watch list and an empty state that
 * points at discovery. Rendering only; the data comes from
 * `watchedFeed()` in src/activity.js.
 */
function accountFeedPage({ account, entries = [], watches = [], nav = '', notice = '' }) {
  const list = entries.length === 0
    ? `<div class="empty">Nothing yet. <a href="/packages">Browse packages</a> and press
       <strong>Watch package</strong> to follow releases, reviews, and decisions here.</div>`
    : activityList(entries, { showPackage: true, empty: 'Nothing yet.' });
  const watchChips = watches.length === 0
    ? ''
    : `<p class="pkg-meta">Watching: ${watches
      .map((name) => `<a class="chip" href="/packages/${encodeURIComponent(name)}#watch">${escapeHtml(name)}</a>`)
      .join(' ')}</p>`;
  const body = `<section class="hero">
  <h1>Feed</h1>
  <p>Activity from the packages you watch: new releases, reviews, maintainer
     replies, and reviewer decisions. Watching never changes what you can
     publish, and the same trail is public on each package page.</p>
</section>
${accountBanner({ account, status: 'active', notice, error: '' })}
${watchChips}
${list}`;
  return layout({ title: 'Feed', body, nav });
}

module.exports = {
  loginPage,
  accountOverviewPage,
  accountRequestsPage,
  accountNotificationsPage,
  accountSettingsPage,
  accountFeedPage,
  requestForm,
  requestTarget,
  kindLabel,
  noticeBox,
  statusPill,
  historyLine,
};
