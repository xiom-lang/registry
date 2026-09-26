# Changelog

All notable changes to the XIOM Package Registry service. Versions are the
deployed service version shown by `/health` and `/`, and follow semver.
The rendered version of this file is at `/whats-new`.

## [2.1.0] - 2026-09-26

### Mobile-first UI, the admin console, roles, and beginner publishing docs

- **Mobile-first shell**: a no-JS menu keeps every link reachable, wide data
  tables scroll or become labelled rows, package rows are denser, banner
  search no longer covers the wordmark, and touch targets are 44px.
- **Friendly data presentation**: relative timestamps with the exact value on
  hover, shortened ids/digests, one trust-pill block per package, copy buttons
  (progressive enhancement), and an integrity disclosure instead of raw hex.
- **Account area split** into Overview, Requests, Notifications, and Settings,
  with unread counts and an explicit mark-all-read.
- **Admin console** at `/admin`: dashboard counts, request filters, package
  moderation (flag, mute, clear, yank a version), the full report queue, user
  management, and an audit trail.
- **Roles and restrictions**: stored reviewer/admin grants on top of the
  config allowlists, promote/demote, suspend (read-only) and ban (sessions
  closed, sign-in refused), with config admins protected and every change
  audited.
- **Muting** hides a package from home, listing, search, and category counts
  while its page, artifacts, downloads, and `/index.json` entry stay intact.
- **Registry-hosted publishing guide** at `/publish` (nav: Publish), rendered
  from PUBLISHING.md with a live GitHub fetch and a bundled fallback.
- **Beginner-first PUBLISHING.md**: five-minute quickstart, tag-based releases
  with a tag/version guard, manual token lane, troubleshooting table, glossary.
- **Workflow template upgrade** with a ready tag trigger and the same guard;
  the GitHub token-request issue template is deprecated and removed.
- Markdown headings now get GitHub-style anchor ids, so guide links work.

## [2.0.0] - 2026-09-26

### Registry 2.0: identities, requests, reviews, and the social base

- **GitHub sign-in** (`read:user`) with signed, in-memory sessions and CSRF;
  a browser session is identity only and can never publish.
- **Self-service requests** for publish tokens and trusted publishers, with
  an admin queue, audit history per request, and in-app notifications.
- **One-click trusted publishers**: approving a request activates the entry
  immediately (no host editing, no restart); revoke removes it.
- **A copy-paste OIDC workflow template** at
  `/ui/templates/community-publish.yml`, linked from the request form and
  PUBLISHING.md.
- **Community reports and reviewer decisions**: resolve/dismiss with a note,
  mark reviewed or flagged with a public per-package history; `flagged` wins
  over every badge state.
- **Star ratings and short reviews** on package pages (one per account,
  upsert), the social layer's first slice.
- **Notification outbox with optional email** (`SMTP_URL`, `SMTP_FROM`); an
  account can set a notification email; with no SMTP the registry runs
  in-app notices only.
- **SQLite platform layer** (`registry.db` on the data volume) with ordered,
  idempotent migrations for the social tables to come.
- **What's new** page (`/whats-new`) rendering this changelog.

## [1.2.0] - 2026-09-25

### Listing, readme, and badge roadmap (SESSION.md section 13)

- Server-side pagination on `/packages` (`?page=`, `?per_page=`), totals in
  JSON, previous/next in HTML, while `/index.json` stays whole.
- Compact listing rows and a "Recently updated" strip on home.
- Sorting (`updated` default, `name`) and shareable facets (`category`,
  `first_party`, `signed`).
- Search tolerates `-`/`.` in names and ranks name matches first.
- Readmes are extracted from the stored tarball and rendered with an
  escape-first markdown renderer (headings, lists, code, tables, links).
- Status icon set v2 (state x track matrix) rendered at 80px, with claim
  pills (`signed`, `trusted`, `reviewed`).

## [1.1.0] - 2026-09-23

### OIDC trusted publishing

- GitHub OIDC trusted-publisher entries (repository + workflow + ref), with
  claims only selecting an entry and never widening its scopes.
- Per-version provenance (repository, workflow, ref, commit, run URL) and
  the community **trusted** badge.
- Staging and production instances with separate publisher configurations.

## [1.0.0] - 2026-09-20

### Protocol floor

- The client protocol: `GET /index.json`, `POST /publish` (Bearer auth +
  ed25519 signature/publicKey), `GET /packages/:name/:version/package.tar.gz`,
  yank, and health.
- Immutable versions, sha256 verification, signature enforcement for trusted
  tokens, and first-party namespace protection.
