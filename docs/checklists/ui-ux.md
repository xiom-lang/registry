# UI/UX implementation checklist (registry 2.1)

Source plan: `SESSION.md` section 20. Audit evidence: staging v2.0.0 browsed
2026-09-26 with `Accept: text/html` at a 390x844 mobile viewport (CDP device
metrics, DPR 2) and 1280x900 desktop; authenticated surfaces rendered from the
real app against fixture data (`/tmp` harness, same code paths as staging).

Work top to bottom; each box is verifiable. Commit after each phase.

## Phase 1 -- foundations (`feat(ui)`)

### Formatting helpers

- [ ] `src/ui/format.js` with `formatWhen(iso)` (relative label + absolute
      `title`; `<time datetime>`), `formatBytes(n)` (one implementation, reused
      by pages), `shortHash(hex, n)` and `shortId(id)` for display-only
      shortening.
- [ ] All pages stop printing raw `2026-09-26 03:33 UTC` strings: home updated
      stamp, listing rows, package PUBLISHED, version table, account joined /
      signed-in / request dates, notifications, admin and review queues.
- [ ] `formatWhen` unit tests: just now, minutes, hours, days, >30 days shows
      the date, invalid input falls back safely, and output is HTML-escaped.

### Mobile shell and navigation

- [ ] Header becomes mobile-first: brand + primary action visible; the rest
      behind a CSS-only `<details class="nav-menu">` disclosure at <=640px
      (no JS). All links reachable, Sign in / @account never off-screen.
- [ ] Desktop keeps the current single-row nav (no visual regression).
- [ ] Touch targets: nav links, buttons, chips, and form controls are >=44px
      high on mobile.
- [ ] Footer grouped and readable at 320px width; no horizontal page scroll
      (`document.scrollWidth <= innerWidth`) on any surface.

### Tables and dense data

- [ ] Every data table is wrapped in a scroll container
      (`.table-wrap { overflow-x:auto }`) so a wide table can never widen the
      mobile layout viewport; verify `innerWidth == 390` on package pages
      (current bug: versions table forces 504-517px).
- [ ] Package versions table at <=640px renders as labelled rows (version,
      published, size, signature, download) instead of a squeezed table.
- [ ] Account requests, admin request cards, and review queues use the same
      labelled-row pattern; raw ids are shortened with full value in `title`.
- [ ] Digests/fingerprints: short form with full value available (title +
      `<details>` integrity block); no 64-hex wall in the primary view.

### Home, listing, package page

- [ ] Banner search: placeholder no longer clipped on 390px; search input no
      longer overlaps the XIOM wordmark; button keeps an accessible label.
- [ ] Home rows: badge art steps down to 48-56px on mobile; trust pills sit
      with the package name; row height shrinks; "Recently updated" scans.
- [ ] Listing rows: relative dates, no repeated full UTC strings; meta row
      wraps without orphaned words.
- [ ] Package page: one trust pill block (no duplicated SIGNED pill next to
      the art); install command is copyable (progressive-enhancement copy
      button, hidden without JS) and wraps cleanly; repository link shows
      `owner/repo`.
- [ ] Empty states tell the user the next action (sign in to rate, request a
      token to publish, no requests yet).
- [ ] Flash/notice banners (submitted, saved, decided) render above the fold
      on mobile and are dismissible by navigation only (no timers).

### Visual verification

- [ ] Screenshots at 390x844 (mobile) and 1280x900 (desktop) for home,
      `/packages`, package page, `/login`, `/whats-new`, 404.
- [ ] Zero page-level horizontal overflow on all of the above
      (`scrollWidth <= innerWidth + 1`).

## Phase 2 -- account settings pages (`feat(account)`)

- [ ] `/account` becomes an overview: profile (login, joined, last sign-in,
      role, status), notice preview, request summary, quick links.
- [ ] `/account/requests`: request form (token / trusted publisher) with
      beginner copy and field help; "My requests" history with status badges
      and relative dates, each linking to its package.
- [ ] `/account/notifications`: in-app notices (relative dates), mark-all-read
      POST, notification email form moved here.
- [ ] `/account/settings`: notification email, sign out, account status
      (suspended banner when applicable), terms/privacy links.
- [ ] Shared sub-nav (`Overview / Requests / Notifications / Settings`) works
      on mobile (scrollable tabs) and marks the current page with
      `aria-current`.
- [ ] `/account#request` and `/account#email` links still land correctly
      (redirect or anchor preserved); old POST redirects updated.
- [ ] Suspended accounts see a read-only banner and cannot submit request /
      report / rating forms (`403 account_suspended`), sessions never publish.
- [ ] Tests: page routing, overview fields, request history, notifications
      read, email save, suspended write refusal.

## Phase 3 -- admin console (`feat(admin)`)

- [ ] `/admin` dashboard: counts (pending requests, awaiting fulfilment, open
      reports, flagged, muted, users) with links; recent audit entries.
- [ ] `/admin/requests`: pending / approved-awaiting-fulfilment / closed
      filters; existing approve / deny / revoke / mark-fulfilled actions;
      mint guidance corrected (fulfiller first, then `issue-token.sh`, then
      runbook link) and no stale commands.
- [ ] `/admin/packages`: search + filter (all / flagged / muted / yanked);
      actions flag, clear, mute, unmute, yank version with reason. Yank asks
      for confirmation (no JS: separate confirmation step or checkbox) and
      writes an audit entry.
- [ ] `/admin/reports`: all reports, filters (open / resolved / dismissed),
      resolve/dismiss with note; admin variant of the reviewer action.
- [ ] `/admin/users`: search, role and status columns, promote/demote
      reviewer/admin, suspend, ban, restore; self-demotion and last-admin
      guards; config-listed admins are protected from demotion.
- [ ] `/admin/users/:githubId`: account detail, role/status history, audit
      trail, action forms.
- [ ] `/admin/audit`: chronological feed of console actions (actor, action,
      subject, note, timestamp) with pagination.
- [ ] Muted packages: hidden from home strip, `/packages`, `/search`,
      `/categories` counts and JSON listing; package page still resolves with
      a visible "muted by the maintainers" notice; `/index.json` untouched.
- [ ] Every admin action appends an `admin_audit` row (actor id + login,
      action, subject, note); tests assert the row per action.
- [ ] Admin nav tab, and cross-links from `/review` for admins.

## Phase 4 -- roles, suspension, ban (`feat(roles)`)

- [ ] SQLite migration adds `user_roles`, `user_states`, `admin_audit`.
- [ ] Effective role = config allowlist OR stored grant; resolved per request
      (a demotion applies to an open session immediately).
- [ ] Suspended: signed in, read-only (all write endpoints refuse with
      `account_suspended`); banned: sessions destroyed, sign-in refused with a
      clear message, all requests treated as signed out.
- [ ] Grants/status changes audit actor, target, before/after, note.
- [ ] Tests: promote -> admin page reachable; demote -> 403; suspend -> write
      403 and read 200; ban -> existing cookie dead + callback refused;
      last-admin self-demotion refused; config admin protection.
- [ ] 2.0 guarantees intact: no new publish path, sessions never publish,
      approvals remain audited, trusted-publisher one-click flow unchanged,
      `/index.json` byte-for-byte compatible.

## Phase 5 -- publishing guidance and the `/publish` page (`feat(publish-guide)`)

- [ ] `/publish` renders `PUBLISHING.md` with the README markdown renderer
      (tables, code fences, links): fetched from the repository's raw URL with
      an in-memory TTL cache, bundled copy as fallback, "View source on
      GitHub" link, and the workflow-template download.
- [ ] `/help/publishing` redirects to `/publish`; nav "Publish" and footer
      "Publishing" point at `/publish` (GitHub stays as the source link).
- [ ] PUBLISHING.md rewrite for hobbyists/juniors: 10-minute quickstart,
      complete `package.xi`, README advice, keygen, token request via the
      registry UI, publish, verify, yank, troubleshooting table, glossary,
      Windows/macOS/Linux commands, and tag-based CI as the recommended path.
- [ ] No stale claims: command names/flags checked against the client
      (`xiom pkg publish|keygen|install`, no `yank` subcommand), no "not open
      yet" contradictions, issue-template fallback removed.
- [ ] `.github/ISSUE_TEMPLATE/token-request.yml` deleted and every reference
      (PUBLISHING.md, account pages, request form) points at the web flow;
      ops-repo template deprecation noted in the roadmap.
- [ ] Workflow template `.github/workflows/publish-registry.yml` copy-paste
      ready for a beginner: commented tag trigger (`v*`) with a manifest
      version/tag guard, dispatch mode, pinned toolchain download, signing key
      guidance, and yank mode. Template served at
      `/ui/templates/community-publish.yml` stays the single source.
- [ ] Admin/fulfilment copy on `/admin/requests` matches DEPLOY.md (worker
      first, `issue-token.sh` manual path, secret handling warnings).
- [ ] Tests: `/publish` 200 + content, fallback path when the fetch fails,
      template 200 and contains the tag guard, redirect works, no issue
      template file remains.

## Phase 6 -- verification and rollout

- [ ] `npm test` green with the new count (>= 212).
- [ ] `npm run test:e2e` 20/20.
- [ ] Local visual pass (mobile + desktop) on every changed surface,
      screenshots archived in the session notes.
- [ ] CHANGELOG "Unreleased/2.1.0" entry; `/whats-new` renders it.
- [ ] DCO-signed conventional commits on `main`; push.
- [ ] Deploy staging, verify `/health`, `/publish`, account+admin flows with
      the fake-provider-independent checks available, then promote the same
      commit to production and repeat the smoke checks.
- [ ] Confirm `/index.json` unchanged on both instances (protocol untouched).
