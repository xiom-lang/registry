# UI/UX implementation checklist (registry 2.1)

Source plan: `SESSION.md` section 20. Audit evidence: staging v2.0.0 browsed
2026-09-26 with `Accept: text/html` at a 390x844 mobile viewport (CDP device
metrics, DPR 2) and 1280x900 desktop; authenticated surfaces rendered from the
real app against fixture data (same code paths as staging).

Status 2026-09-26: **implemented and verified locally** (229 unit tests, 20 e2e
checks, mobile/desktop screenshot pass with `scrollWidth <= innerWidth+1` on
every changed surface). Staging and production deployment of the same commit
is the remaining step; see the notes at the bottom.

## Phase 1 -- foundations (`feat(ui)`) -- done (5c432ee)

### Formatting helpers

- [x] `src/ui/format.js` with `formatWhen(iso)` (relative label + absolute
      `title`; `<time datetime>`), `formatBytes(n)` (one implementation, reused
      by pages), `shortDigest(hex, n)` and `shortId(id)` for display-only
      shortening.
- [x] All pages stop printing raw `2026-09-26 03:33 UTC` strings: home updated
      stamp, listing rows, package PUBLISHED, version table, account joined /
      signed-in / request dates, notifications, admin and review queues.
- [x] `formatWhen` unit tests: just now, minutes, hours, days, >30 days shows
      the date, future values read "from now", invalid input falls back safely,
      and output is HTML-escaped.

### Mobile shell and navigation

- [x] Header becomes mobile-first: brand + primary action visible; the rest
      behind a CSS-only `<details class="nav-more">` disclosure at <=640px
      (no JS). All links reachable, Sign in / @account never off-screen.
- [x] Desktop keeps the current single-row nav (no visual regression).
- [x] Touch targets: nav links, buttons, chips, tabs, and form controls are
      >=44px high on mobile.
- [x] Footer grouped and readable at 390px width; no horizontal page scroll
      (`document.scrollWidth <= innerWidth`) on any surface.

### Tables and dense data

- [x] Every wide table is wrapped in `.table-wrap` (`overflow-x:auto`), so a
      wide table can never widen the mobile layout viewport; verified
      `innerWidth == 390` on package pages (was 504-517px).
- [x] Package versions table at <=640px renders as labelled rows (version,
      published, size, signature, download) via `table.table-cards`.
- [x] Account requests, admin request cards, and review queues use the same
      labelled-row pattern; raw ids are shortened with the full value in
      `title` (`shortId`).
- [x] Digests/fingerprints: short form with the full value in an
      `Integrity details` disclosure and copy buttons; no 64-hex wall.

### Home, listing, package page

- [x] Banner search: placeholder no longer clipped on 390px; on phones the
      search sits below the artwork and never covers the wordmark.
- [x] Home rows: badge art steps down to 44-48px on mobile; trust pills sit
      with the package name; card height shrinks; "Recently updated" scans.
- [x] Listing rows: relative dates, no repeated full UTC strings; meta wraps
      without orphaned words.
- [x] Package page: one trust-pill block (decision pill suppresses the
      duplicate "reviewed" claim pill); install command has a
      progressive-enhancement copy button (hidden without JS); repository link
      shows `owner/repo`.
- [x] Empty states tell the user the next action (request a token, no reports,
      no requests yet).
- [x] Flash/notice banners render near the top of the affected page.

### Visual verification

- [x] Screenshots at 390x844 (mobile) and 1280x900 (desktop) for home,
      `/packages`, package page, `/login`, `/whats-new`, account pages, the
      console, and `/publish`.
- [x] Zero page-level horizontal overflow on all of the above
      (`scrollWidth <= innerWidth + 1`).

## Phase 2 -- account settings pages (`feat(account)`) -- done (c8dfc31)

- [x] `/account` is an overview: profile (login, joined, last sign-in, role,
      status), request preview, notification preview, quick links.
- [x] `/account/requests`: request form (token / trusted publisher) with
      beginner copy, guide link, and field help; history table with status
      badges and relative dates.
- [x] `/account/notifications`: in-app notices with unread pills, explicit
      mark-all-read POST, pointer to the email setting.
- [x] `/account/settings`: notification email form, account facts (joined,
      role, status), sign out.
- [x] Shared sub-nav (`Overview / Requests / Notifications / Settings`) works
      on mobile and marks the current page with `aria-current`.
- [x] Old anchors/redirects updated (`/account/requests?created=...`,
      `/account/settings`); the notification email POST lands on Settings.
- [x] Suspended accounts see a read-only banner and cannot submit request /
      report / rating forms (`403 account_suspended`); sessions never publish.
- [x] Tests: page routing, overview fields, request history, notifications
      read semantics, email save, suspended write refusal.

## Phase 3 -- admin console (`feat(admin)`) -- done (a39962c)

- [x] `/admin` dashboard: pending requests, awaiting fulfilment, open reports,
      flagged, muted, accounts, plus recent audit entries.
- [x] `/admin/requests`: pending / approved-awaiting-fulfilment / closed
      filters with the existing approve / deny / revoke / mark-fulfilled
      actions; mint guidance corrected (fulfiller first, `issue-token.sh`
      runbook, last-resort `scripts/tokens.js`, never a token in the browser).
- [x] `/admin/packages`: search + filter (all / flagged / muted / yanked /
      undecided); actions flag, review, mute, clear, yank version with reason;
      yank lives behind a confirmation disclosure and is audited.
- [x] `/admin/reports`: all reports, filters (open / resolved / dismissed),
      resolve/dismiss with note; admin variant of the reviewer action.
- [x] `/admin/users`: search, role and status pills, promote/demote
      reviewer/admin, suspend, ban, restore; config admins are protected and
      the UI says so.
- [x] `/admin/users/:githubId`: account detail, actions, audit trail.
- [x] `/admin/audit`: chronological feed of console actions with actor,
      subject, note, and relative timestamps.
- [x] Muted packages: hidden from home strip, `/packages` (HTML and JSON),
      `/search`, and `/categories` counts; the package page still resolves
      with a "Hidden from listings and search" notice; `/index.json` untouched.
- [x] Every admin action appends an `admin_audit` row; tests assert rows for
      mute, yank, role, and status changes.
- [x] Admin nav tab (mobile menu + desktop), cross-linked from the account
      overview.

## Phase 4 -- roles, suspension, ban (`feat(admin)`) -- done (a39962c)

- [x] SQLite migration `002-user-administration` adds `user_roles`,
      `user_states`, `admin_audit`.
- [x] Effective role = config allowlist OR stored grant; resolved per request,
      so role changes apply to open sessions immediately.
- [x] Suspended: signed in, read-only (requests/reports/ratings return
      `403 account_suspended`); banned: sessions destroyed, sign-in refused
      with a clear message, requests treated as signed out.
- [x] Grants/status changes audit actor, target, before/after, note.
- [x] Tests: promote -> admin page reachable; demote -> 403; suspend -> write
      403 and read 200; ban -> existing cookie dead + callback refused;
      self-demotion refused; config admin protection.
- [x] 2.0 guarantees intact: no new publish path, sessions never publish,
      approvals remain audited, trusted-publisher one-click flow unchanged,
      `/index.json` untouched (e2e protocol checks pass).

## Phase 5 -- publishing guidance and `/publish` (`feat(publish-guide)`) -- done (5bc9f51)

- [x] `/publish` renders `PUBLISHING.md` with the README markdown renderer
      (tables, code fences, links, heading anchors): fetched from the
      repository raw URL with a 10-minute cache, bundled copy as fallback,
      "View the source on GitHub" link, and the workflow-template download.
- [x] `/help/publishing` redirects to `/publish`; nav "Publish" and footer
      "Publishing" point at `/publish` (GitHub stays as the source link).
- [x] PUBLISHING.md rewritten for hobbyists/juniors: quickstart, complete
      `package.xi`, README advice, keygen, token request via the registry UI,
      publish, verify, yank, troubleshooting table keyed to real error codes,
      glossary, Windows/macOS/Linux commands, tag CI as the recommended path.
- [x] No stale claims: command names/flags checked against the client (`xiom
      pkg publish|keygen|install|trust`, no `yank` subcommand), no "not open
      yet" contradictions, issue-template fallback removed.
- [x] `.github/ISSUE_TEMPLATE/token-request.yml` deleted and every reference
      (guide, login page, request form) points at the web flow; the ops-repo
      follow-up is recorded in `SESSION.md` section 20.7.
- [x] Workflow template is copy-paste ready: commented `push: tags: ["v*"]`
      trigger, tag/version guard, defaults that work for manual runs too,
      pinned toolchain download into `$RUNNER_TEMP`, signing-key guidance,
      yank mode; still served at `/ui/templates/community-publish.yml`.
- [x] Admin/fulfilment copy matches DEPLOY.md and the fulfiller worker path.
- [x] Tests: `/publish` content, bundled fallback on fetch failure, live
      remote fetch, anchor ids, template assertions, issue-template absence.

## Phase 6 -- verification and rollout

- [x] `npm test` green with the new count (229).
- [x] `npm run test:e2e` 20/20.
- [x] Local visual pass (mobile + desktop) on every changed surface.
- [x] Production-like boot smoke: `/health` reports 2.1.0, `/publish` 200,
      `/help/publishing` 301, `/admin` anonymous 302 to `/login`, `/whats-new`
      renders the 2.1.0 entry.
- [x] CHANGELOG "2.1.0" entry; `/whats-new` renders it.
- [x] DCO-signed conventional commits on `main`.
- [ ] Push to `main` (remote) and deploy staging, verify, then promote the
      same commit to production. This requires host access: the session has
      no SSH credentials for the VPS, so the deploy commands from DEPLOY.md
      (`git pull`, `docker compose build registry`,
      `docker compose up -d --no-deps registry`, `scripts/live-check.js`) must
      run where the containers live.
- [ ] Post-deploy: confirm `/index.json` shape and packages unchanged on both
      instances (review/mute/role state is not part of the protocol).

## Notes and deliberate deferrals

- `hasMore`-style pagination for `/admin/audit` is capped at 100 rows rather
  than paginated; revisit if the table grows past a few thousand rows.
- The "last-admin" guard is enforced in the route but the current test harness
  always has a config admin, so the guard is covered by inspection; a
  dedicated fixture will make it directly testable when stored admins become
  the norm.
- `user:email` for verified notification addresses remains a backlog item;
  addresses are self-declared today.
- The GitHub issue template in the ops repository still needs the same
  deprecation (noted in section 20.7; the ops repo is out of this session's
  scope).
