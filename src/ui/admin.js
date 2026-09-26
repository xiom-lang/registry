// XIOM Package Registry -- admin console pages (registry 2.1).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// One console for the things maintainers do: approve and fulfil requests,
// moderate packages (flag / mute / yank), work the report queue, manage user
// roles and restrictions, and read the audit trail. Every mutation posts to
// an admin-only route and lands an admin_audit row. Nothing here publishes or
// touches artifacts (SESSION.md section 20).

'use strict';

const { escapeHtml, formatWhen, shortId } = require('./format');
const { layout } = require('./layout');
const { packageTrustChips } = require('./pages');
const {
  noticeBox,
  statusPill,
  kindLabel,
  requestTarget,
  historyLine,
} = require('./account');
const { REASON_LABELS } = require('./review');

const ADMIN_SECTIONS = [
  ['/admin', 'Overview', 'overview'],
  ['/admin/requests', 'Requests', 'requests'],
  ['/admin/packages', 'Packages', 'packages'],
  ['/admin/reports', 'Reports', 'reports'],
  ['/admin/users', 'Users', 'users'],
  ['/admin/audit', 'Audit', 'audit'],
];

function adminTabs(active) {
  const links = ADMIN_SECTIONS.map(([href, label, key]) => {
    const current = active === key;
    return `<a class="account-tab${current ? ' active' : ''}" href="${href}"`
      + `${current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  }).join('\n  ');
  return `<nav class="account-tabs" aria-label="Admin console">\n  ${links}\n</nav>`;
}

function filterChips(base, filters, active) {
  const chips = filters.map(([value, label]) => {
    const href = value === '' ? base : `${base}?filter=${encodeURIComponent(value)}`;
    return `<a class="chip${active === value ? ' chip-active' : ''}" href="${href}"`
      + `${active === value ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  }).join('\n  ');
  return `<nav class="facet-row" aria-label="Filters">\n  ${chips}\n</nav>`;
}

function decisionLabel(status) {
  return { flagged: 'flagged', muted: 'muted', reviewed: 'reviewed' }[status] || 'no decision';
}

function decisionPill(status) {
  if (!status) return '<span class="status-pill">no decision</span>';
  const style = status === 'flagged' ? 'denied' : (status === 'muted' ? 'muted' : 'approved');
  return `<span class="status-pill status-${style}">${escapeHtml(decisionLabel(status))}</span>`;
}

/** Console dashboard: what needs attention, with links into each queue. */
function adminDashboardPage({ account, counts, recentAudit = [], nav = '' }) {
  const card = (href, label, value, hint) => `<a class="console-card" href="${href}">
  <span class="console-card-value">${escapeHtml(String(value))}</span>
  <span class="console-card-label">${escapeHtml(label)}</span>
  <span class="pkg-meta">${escapeHtml(hint)}</span>
</a>`;
  const body = `<section class="hero">
  <h1>Admin console</h1>
  <p>Signed in as <a href="https://github.com/${encodeURIComponent(account.login)}" rel="noopener">@${escapeHtml(account.login)}</a>.
     Every action here is audited and none of it can publish: approving a trusted publisher
     activates OIDC matching, approving a token queues the host mint, and moderation only
     changes what visitors see.</p>
</section>
${adminTabs('overview')}
<div class="console-grid">
  ${card('/admin/requests', 'Pending requests', counts.pendingRequests, 'waiting for a decision')}
  ${card('/admin/requests?filter=approved', 'Awaiting fulfilment', counts.awaitingFulfilment, 'approved tokens to mint')}
  ${card('/admin/reports', 'Open reports', counts.openReports, 'community reports to resolve')}
  ${card('/admin/packages?filter=flagged', 'Flagged packages', counts.flagged, 'visible warning on the page')}
  ${card('/admin/packages?filter=muted', 'Muted packages', counts.muted, 'hidden from listings and search')}
  ${card('/admin/users', 'Accounts', counts.users, 'roles and restrictions')}
  ${card('/review#ownership', 'Ownership claims', counts.ownershipClaims, 'awaiting verification')}
</div>
<section>
  <h2>Recent admin activity</h2>
  ${auditList(recentAudit, 'Nothing has been done from the console yet.')}
</section>`;
  return layout({ title: 'Admin console', body, nav });
}

function auditList(entries, empty) {
  if (entries.length === 0) return `<p class="pkg-meta">${escapeHtml(empty)}</p>`;
  return `<ul class="audit-list">
${entries.map((entry) => `  <li class="audit-row">
    <span class="pkg-meta">${formatWhen(entry.at)}</span>
    <span class="mono audit-action">${escapeHtml(entry.action)}</span>
    <span>@${escapeHtml(entry.actor_login)}</span>
    <span class="pkg-meta">&rarr; ${escapeHtml(entry.subject_type)} ${escapeHtml(entry.subject_login || entry.subject_id)}</span>
    ${entry.detail ? `<span class="pkg-meta audit-detail">${escapeHtml(entry.detail)}</span>` : ''}
  </li>`).join('\n')}
</ul>`;
}

// ─── Requests ───────────────────────────────────────────────────────────────

function pendingRow(record, csrf) {
  const hint = record.kind === 'publisher'
    ? 'Approving activates the trusted-publisher entry immediately; the publisher\u2019s workflow works right away \u2014 no host step, no restart.'
    : 'Approving queues the host mint (the app never mints); record the fulfilment reference here.';
  return `<li class="request-card">
  <div class="request-head">
    <span class="request-id">${shortId(record.id)}</span>
    ${statusPill(record.status)}
    <span class="pkg-meta">${escapeHtml(kindLabel(record))} by
      <a href="https://github.com/${encodeURIComponent(record.requester.login)}" rel="noopener">@${escapeHtml(record.requester.login)}</a>
      &middot; ${formatWhen(record.createdAt)}</span>
  </div>
  <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
  ${record.scopes ? `<p class="pkg-meta">Scopes: <span class="mono">${escapeHtml(record.scopes.join(', '))}</span></p>` : ''}
  <p class="pkg-meta">${hint}</p>
  ${record.note ? `<p class="pkg-desc">${escapeHtml(record.note)}</p>` : ''}
  ${historyLine(record)}
  <form class="decision-form" method="post" action="/admin/requests/${encodeURIComponent(record.id)}/decision">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="note" placeholder="Decision note (required to deny)" maxlength="500" aria-label="Decision note">
    <button class="button primary" type="submit" name="action" value="approve">Approve${record.kind === 'publisher' ? ' &amp; activate' : ''}</button>
    <button class="button danger" type="submit" name="action" value="deny">Deny</button>
  </form>
</li>`;
}

function approvedRow(record, csrf) {
  return `<li class="request-card">
  <div class="request-head">
    <span class="request-id">${shortId(record.id)}</span>
    ${statusPill(record.status)}
    <span class="pkg-meta">${escapeHtml(kindLabel(record))} by
      <a href="https://github.com/${encodeURIComponent(record.requester.login)}" rel="noopener">@${escapeHtml(record.requester.login)}</a>
      &middot; approved by @${escapeHtml(record.decidedBy || '?')} ${formatWhen(record.decidedAt)}</span>
  </div>
  <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
  <p class="pkg-meta">Scopes: <span class="mono">${escapeHtml(record.scopes.join(', '))}</span></p>
  <p class="pkg-meta"><strong>Preferred:</strong> let the fulfilment worker mint and mail the
     token (approve, then wait for the request to close itself). If the worker is off, use the
     operators&rsquo; <code>issue-token.sh</code> runbook; <code>scripts/tokens.js</code> is the
     last-resort manual fallback. Never paste a token into a browser form or an issue.</p>
  <details class="mint-details">
    <summary>Manual fallback command (operators only)</summary>
    <pre class="mint-command"># only if the worker is unavailable; see DEPLOY.md "Token fulfilment worker"
docker compose exec registry node scripts/tokens.js add \\
  --file tokens.json --label ${escapeHtml(record.requester.login)}-${escapeHtml(record.id.slice(-8))} \\
  --scopes "${escapeHtml(record.scopes.join(','))}"
# then deliver the token line privately and record the reference below</pre>
  </details>
  <form class="decision-form" method="post" action="/admin/requests/${encodeURIComponent(record.id)}/fulfil">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="reference" placeholder="Fulfilment reference (e.g. label, mail date)" maxlength="500" required aria-label="Fulfilment reference">
    <button class="button primary" type="submit">Mark fulfilled</button>
  </form>
</li>`;
}

function closedRow(record, csrf, publisherLive) {
  const when = record.fulfilledAt || record.decidedAt || record.createdAt;
  const detail = record.mintReference ? ` &middot; ${escapeHtml(record.mintReference)}` : '';
  const revoked = record.history.some((entry) => entry.action === 'revoked');
  let publisherState = '';
  if (record.kind === 'publisher' && record.status === 'fulfilled') {
    publisherState = publisherLive
      ? `<p class="pkg-meta">Trusted publisher is <strong>live</strong> \u2014 publishes from this repo/workflow/ref are accepted now.</p>
  <form class="decision-form" method="post" action="/admin/requests/${encodeURIComponent(record.id)}/revoke">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="note" placeholder="Revoke note (optional)" maxlength="500" aria-label="Revoke note">
    <button class="button danger" type="submit">Revoke trusted publisher</button>
  </form>`
      : `<p class="pkg-meta">${revoked ? 'Revoked \u2014 the publisher\u2019s workflow is refused again.' : 'No live entry.'}</p>`;
  }
  return `<li class="request-card closed">
  <div class="request-head">
    <span class="request-id">${shortId(record.id)}</span>
    ${statusPill(record.status)}
    <span class="pkg-meta">@${escapeHtml(record.requester.login)} &middot; ${formatWhen(when)}${detail}</span>
  </div>
  <p class="mono request-target">${escapeHtml(requestTarget(record))}</p>
  ${publisherState}
  ${historyLine(record)}
</li>`;
}

/** Approval queue with pending / awaiting-fulfilment / closed filters. */
function adminRequestsPage({
  account,
  requests,
  activePublishers = [],
  csrf,
  notice = '',
  error = '',
  filter = '',
  nav = '',
}) {
  const all = requests;
  const pending = all.filter((record) => record.status === 'pending');
  const approved = all.filter((record) => record.status === 'approved');
  const closed = all.filter((record) => record.status === 'denied' || record.status === 'fulfilled');
  const section = (title, items, empty, render) => `<section>
  <h2>${escapeHtml(title)} <span class="count">${items.length}</span></h2>
  ${items.length === 0 ? `<p class="pkg-meta">${escapeHtml(empty)}</p>` : `<ul class="request-list">\n${items.map(render).join('\n')}\n</ul>`}
</section>`;

  const groups = {
    pending: () => section('Pending', pending, 'Nothing waiting for a decision.', (record) => pendingRow(record, csrf)),
    approved: () => section('Approved, awaiting fulfilment', approved, 'Nothing approved but unfulfilled.', (record) => approvedRow(record, csrf)),
    closed: () => section('Closed', closed, 'No closed requests yet.', (record) => closedRow(record, csrf, activePublishers.includes(record.id))),
  };
  const rendered = filter && groups[filter]
    ? groups[filter]()
    : Object.values(groups).map((render) => render()).join('\n');

  const body = `<section class="hero">
  <h1>Requests</h1>
  <p>Approving a <strong>trusted publisher</strong> activates the entry immediately &mdash; the publisher&rsquo;s
     workflow is accepted as soon as you click, with no host step. Approving a <strong>token</strong> request
     queues the host mint; the app never sees the token and never holds mail credentials.
     Every action stays in the audit history.</p>
</section>
${adminTabs('requests')}
${noticeBox(notice, error)}
${filterChips('/admin/requests', [['', 'All'], ['pending', 'Pending'], ['approved', 'Awaiting fulfilment'], ['closed', 'Closed']], filter)}
${rendered}`;
  return layout({ title: 'Admin requests', body, nav });
}

// ─── Packages ───────────────────────────────────────────────────────────────

function packageModerationCard({ name, pkg, decision, csrf }) {
  const status = decision ? decision.status : '';
  const yanked = Object.entries(pkg.versions || {})
    .filter(([, entry]) => entry.yanked === true)
    .map(([version]) => version);
  const latest = pkg.latest ? escapeHtml(pkg.latest) : 'none';
  const versions = Object.keys(pkg.versions || {}).sort().reverse();
  const versionOptions = versions.map((version) => {
    const isYanked = pkg.versions[version].yanked === true;
    return `<option value="${escapeHtml(version)}"${isYanked ? ' disabled' : ''}>`
      + `${escapeHtml(version)}${isYanked ? ' (yanked)' : ''}</option>`;
  }).join('');
  const history = decision && decision.history
    ? `<p class="pkg-meta">${escapeHtml(decision.history.map((entry) => {
      const note = entry.note ? ` (${entry.note})` : '';
      return `${entry.action} by @${entry.actor || '?'}${note}`;
    }).join(' \u00b7 '))}</p>`
    : '';
  return `<li class="request-card">
  <div class="request-head">
    <a class="pkg-name" href="/packages/${encodeURIComponent(name)}">${escapeHtml(name)}</a>
    ${packageTrustChips(name, pkg)}
    ${decisionPill(status)}
    <span class="pkg-meta">latest ${latest}${yanked.length > 0 ? ` &middot; yanked: ${escapeHtml(yanked.join(', '))}` : ''}</span>
  </div>
  ${history}
  <form class="decision-form" method="post" action="/admin/packages/${encodeURIComponent(name)}/decision">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="note" placeholder="Reason (required to flag or mute)" maxlength="500" aria-label="Moderation reason">
    <button class="button" type="submit" name="action" value="review">Mark reviewed</button>
    <button class="button danger" type="submit" name="action" value="flag">Flag</button>
    <button class="button" type="submit" name="action" value="mute">Mute</button>
    ${status ? '<button class="button" type="submit" name="action" value="clear">Undo last decision</button>' : ''}
  </form>
  ${versions.length > 0 ? `<details class="mint-details">
    <summary>Yank a version</summary>
    <form class="decision-form" method="post" action="/admin/packages/${encodeURIComponent(name)}/yank">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <select name="version" aria-label="Version to yank">${versionOptions}</select>
      <input name="reason" placeholder="Yank reason (required)" maxlength="500" required aria-label="Yank reason">
      <button class="button danger" type="submit">Yank version</button>
    </form>
    <p class="pkg-meta">Yanking keeps the artifact and metadata (pinned lockfiles still resolve)
       and removes it from fresh resolution. It cannot be undone from the console.</p>
  </details>` : ''}
</li>`;
}

function adminPackagesPage({
  account,
  packages = [],
  csrf,
  notice = '',
  error = '',
  q = '',
  filter = '',
  nav = '',
}) {
  const body = `<section class="hero">
  <h1>Packages</h1>
  <p>Moderate published packages. <strong>Flag</strong> adds a public warning pill;
     <strong>mute</strong> hides the package from listings and search while keeping its page,
     artifacts, and <code>/index.json</code> entry intact; <strong>yank</strong> retires one
     version. Every action is audited.</p>
</section>
${adminTabs('packages')}
${noticeBox(notice, error)}
<form class="console-search" method="get" action="/admin/packages" role="search">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Filter by package name" aria-label="Filter packages by name">
  <button class="button" type="submit">Search</button>
</form>
${filterChips('/admin/packages', [['', 'All'], ['flagged', 'Flagged'], ['muted', 'Muted'], ['yanked', 'With yanked versions'], ['undecided', 'No decision']], filter)}
${packages.length === 0
    ? '<p class="pkg-meta">No packages match that filter.</p>'
    : `<ul class="request-list">\n${packages.map((entry) => packageModerationCard({ ...entry, csrf })).join('\n')}\n</ul>`}`;
  return layout({ title: 'Admin packages', body, nav });
}

// ─── Reports ────────────────────────────────────────────────────────────────

function adminReportRow(report, csrf) {
  const open = report.status === 'open';
  return `<li class="request-card${open ? '' : ' closed'}">
  <div class="request-head">
    <span class="request-id">${shortId(report.id)}</span>
    <span class="status-pill status-${open ? 'pending' : (report.status === 'dismissed' ? 'denied' : 'approved')}">${escapeHtml(report.status)}</span>
    <span class="pkg-meta"><a href="/packages/${encodeURIComponent(report.package)}">${escapeHtml(report.package)}</a>
      &middot; ${escapeHtml(REASON_LABELS[report.reason] || report.reason)}
      &middot; <a href="https://github.com/${encodeURIComponent(report.reporter.login)}" rel="noopener">@${escapeHtml(report.reporter.login)}</a>
      &middot; ${formatWhen(report.createdAt)}</span>
  </div>
  <p class="pkg-desc">${escapeHtml(report.note)}</p>
  ${report.resolution ? `<p class="pkg-meta">Resolution: ${escapeHtml(report.resolution)} (by @${escapeHtml(report.resolvedBy || '?')})</p>` : ''}
  ${open ? `<form class="decision-form" method="post" action="/admin/reports/${encodeURIComponent(report.id)}/resolve">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input name="resolution" placeholder="Resolution note (required)" maxlength="500" required aria-label="Resolution note">
    <button class="button primary" type="submit" name="status" value="resolved">Resolve</button>
    <button class="button danger" type="submit" name="status" value="dismissed">Dismiss</button>
  </form>` : ''}
</li>`;
}

function adminReportsPage({ account, reports = [], csrf, notice = '', error = '', filter = '', nav = '' }) {
  const body = `<section class="hero">
  <h1>Reports</h1>
  <p>Community reports about published packages. Resolving or dismissing records your note,
     keeps the history public on the package page, and never alters artifacts or the index
     by itself.</p>
</section>
${adminTabs('reports')}
${noticeBox(notice, error)}
${filterChips('/admin/reports', [['', 'All'], ['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']], filter)}
${reports.length === 0
    ? '<p class="pkg-meta">No reports match that filter.</p>'
    : `<ul class="request-list">\n${reports.map((report) => adminReportRow(report, csrf)).join('\n')}\n</ul>`}`;
  return layout({ title: 'Admin reports', body, nav });
}

// ─── Users ──────────────────────────────────────────────────────────────────

function rolePill(user) {
  if (user.role === 'admin') {
    return `<span class="status-pill status-approved">${user.configAdmin ? 'admin (config)' : 'admin'}</span>`;
  }
  if (user.role === 'reviewer') {
    return `<span class="status-pill status-pending">${user.configReviewer ? 'reviewer (config)' : 'reviewer'}</span>`;
  }
  return '<span class="status-pill">member</span>';
}

function statusPillFor(user) {
  if (user.status === 'suspended') return '<span class="status-pill status-denied">suspended</span>';
  if (user.status === 'banned') return '<span class="status-pill status-denied">banned</span>';
  return '';
}

function userActions(user, csrf) {
  const protectedAccount = user.configAdmin;
  const actions = [];
  if (!protectedAccount && user.role === 'admin') {
    actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/role">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="role" value="">
      <button class="button" type="submit">Demote to member</button>
    </form>`);
  } else if (!protectedAccount && user.role !== 'admin') {
    actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/role">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="role" value="admin">
      <button class="button" type="submit">Make admin</button>
    </form>`);
  }
  if (!protectedAccount) {
    if (user.role === 'reviewer' && !user.configReviewer) {
      actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/role">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="role" value="">
      <button class="button" type="submit">Remove reviewer</button>
    </form>`);
    } else if (user.role !== 'admin' && !user.configReviewer) {
      actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/role">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="role" value="reviewer">
      <button class="button" type="submit">Make reviewer</button>
    </form>`);
    }
  }
  if (!protectedAccount) {
    if (user.status === 'active') {
      actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/status">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="status" value="suspended">
      <input name="reason" placeholder="Reason (required)" maxlength="500" required aria-label="Suspension reason">
      <button class="button" type="submit">Suspend</button>
    </form>`);
      actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/status">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="status" value="banned">
      <input name="reason" placeholder="Reason (required)" maxlength="500" required aria-label="Ban reason">
      <button class="button danger" type="submit">Ban</button>
    </form>`);
    } else {
      actions.push(`<form method="post" action="/admin/users/${encodeURIComponent(user.githubId)}/status">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="status" value="active">
      <button class="button primary" type="submit">Restore access</button>
    </form>`);
    }
  }
  return actions.join('\n');
}

function userCard(user, csrf) {
  const protectedAccount = user.configAdmin;
  return `<li class="request-card user-card">
  <div class="request-head">
    <a class="pkg-name" href="/admin/users/${encodeURIComponent(user.githubId)}">@${escapeHtml(user.login)}</a>
    ${rolePill(user)}
    ${statusPillFor(user)}
    <span class="pkg-meta">joined ${formatWhen(user.createdAt)} &middot; last sign-in ${formatWhen(user.lastLoginAt)}</span>
  </div>
  ${user.status === 'suspended' || user.status === 'banned'
    ? `<p class="pkg-meta">${escapeHtml(user.reason || '')} ${user.changedBy ? `&middot; by @${escapeHtml(user.changedBy)} ${formatWhen(user.changedAt)}` : ''}</p>`
    : ''}
  ${protectedAccount ? '<p class="pkg-meta">Admin comes from the deployment config; change it there.</p>' : ''}
  ${user.configReviewer && !protectedAccount
    ? '<p class="pkg-meta">Reviewer comes from the deployment config; grants here can only add admin.</p>'
    : ''}
  <div class="user-actions">${userActions(user, csrf)}</div>
</li>`;
}

function adminUsersPage({
  account,
  users = [],
  csrf,
  notice = '',
  error = '',
  q = '',
  nav = '',
}) {
  const filtered = q
    ? users.filter((user) => user.login.toLowerCase().includes(q.toLowerCase()))
    : users;
  const body = `<section class="hero">
  <h1>Users</h1>
  <p>Roles and restrictions for signed-in accounts. Config-listed admins are protected:
     store grants can only add capability, and every change is audited. Suspending an account
     makes it read-only; banning it closes every session and refuses the next sign-in.</p>
</section>
${adminTabs('users')}
${noticeBox(notice, error)}
<form class="console-search" method="get" action="/admin/users" role="search">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Filter by GitHub login" aria-label="Filter users by login">
  <button class="button" type="submit">Search</button>
</form>
${filtered.length === 0
    ? '<p class="pkg-meta">No accounts match.</p>'
    : `<ul class="request-list">\n${filtered.map((user) => userCard(user, csrf)).join('\n')}\n</ul>`}`;
  return layout({ title: 'Admin users', body, nav });
}

function adminUserPage({ account, user, audit = [], csrf, notice = '', error = '', nav = '' }) {
  const body = `<section class="hero account-hero">
  <div>
    <h1>@${escapeHtml(user.login)}</h1>
    <div class="meta-row">
      <span><a href="https://github.com/${encodeURIComponent(user.login)}" rel="noopener">github.com/${escapeHtml(user.login)}</a></span>
      <span>Joined ${formatWhen(user.createdAt)}</span>
      <span>Last sign-in ${formatWhen(user.lastLoginAt)}</span>
      <span>${rolePill(user)}</span>
      ${statusPillFor(user)}
    </div>
  </div>
</section>
${adminTabs('users')}
${noticeBox(notice, error)}
<div class="account-grid">
  <section>
    <h2>Actions</h2>
    <div class="user-actions">${userActions(user, csrf)}</div>
  </section>
  <section>
    <h2>Audit trail</h2>
    ${auditList(audit, 'No console actions for this account yet.')}
  </section>
</div>`;
  return layout({ title: `Admin @${user.login}`, body, nav });
}

function adminAuditPage({ account, entries = [], nav = '' }) {
  const body = `<section class="hero">
  <h1>Audit</h1>
  <p>Every console action, newest first: who did it, what it touched, and the note they left.
     Request decisions additionally keep their own per-request history on the package pages.</p>
</section>
${adminTabs('audit')}
${auditList(entries, 'Nothing has been done from the console yet.')}`;
  return layout({ title: 'Admin audit', body, nav });
}

module.exports = {
  adminDashboardPage,
  adminRequestsPage,
  adminPackagesPage,
  adminReportsPage,
  adminUsersPage,
  adminUserPage,
  adminAuditPage,
};
