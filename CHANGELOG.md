# Changelog

All notable changes to the XIOM Package Registry service. Versions are the
deployed service version shown by `/health` and `/`, and follow semver.
The rendered version of this file is at `/whats-new`.

## [Unreleased]

### Notifications

- **Maintainer-claim outcomes notify the claimant**: verifying or rejecting a
  claim creates an in-app notice linking to the package's Maintainers section.
- **Report outcomes notify the reporter**: resolving or dismissing a report
  notifies the reporter with a link to the package page.
- **Package decisions notify maintainers who have accounts**: review/unreview,
  flag/unflag, and mute/unmute create a notice for every maintainer holding a
  registry account (verified claims included). Maintainers without an account
  are skipped, and the decision itself always succeeds.
- **Per-kind notification settings**: `/account/settings` gains checkboxes for
  claim, report, and review notices, stored on the account and on by default;
  muting a kind suppresses both its in-app notice and its email. Email keeps
  going only to accounts with a notification email.
- Notices show a human label and their package link on the notifications page;
  every enqueue stays best-effort, so a notification failure never fails the
  action that triggered it.

### Compatibility

- No `/index.json` change and no protocol change; sessions still never publish
  and every approval/decision remains audited. Stored accounts gain a
  `notifyKinds` object (schema 1.1.0); files written by 2.2 load with every
  kind on.

## [2.2.0] - 2026-09-27

### Maintainer identity and moderation

- **Package ownership claims**: package pages carry a Maintainers list derived
  from publish provenance and approved access requests. Any signed-in account
  can claim a package it maintains, and a reviewer verifies or rejects the
  claim with a reason. Claiming grants no publishing rights; only verified
  claims are public, and every decision stays in the claim history.
- **Claims in the admin console**: a new Claims tab (`/admin/claims`) shows
  the pending queue, Verify/Reject controls, and recent decisions; reviewers
  keep the same queue on `/review`.
- **Packages you maintain**: the account overview lists every package you are
  tied to -- provenance, approved publisher/token, or verified claim -- with a
  pending pill for claims awaiting verification.
- **Independent flag and mute toggles**: Flag/Unflag and Mute/Unmute work
  independently, so removing one never disturbs the other; both pills show
  when both apply, and Mark reviewed / Clear review is its own toggle.
- **State-aware icons**: flagging changes the icon; a muted package dims its
  art and carries a MUTED tag (even when flagged art outranks it); reviewed
  adds a ring. Admin console rows show the state icon next to the badges.

### Badges and publishing

- **Stage persistence**: a version's stage survives reloads, and badges fall
  back to it when the package-level stage is missing.
- **Audited stage overrides**: entries published before stage stamping get
  their badge from a generated, PR-reviewed `stage-overrides.json` built from
  the publisher repo's STATUS.json files at a pinned commit. Display-only: a
  published stage always wins, and fixture/stdlib names are excluded.
- The OIDC canary fixture stamps `stage: incubating`; the publishing guide
  documents the OIDC token lifetime failure mode.

### Hardening and operations

- **Rate limiting behind a proxy is fixed**: `TRUST_PROXY` now takes a hop
  count or allowlist (never a spoofable boolean), so IP-based limits are
  enforced again; verified with rotating `X-Forwarded-For`.
- **Container caps and declared env knobs**: per-service CPU, memory, and PID
  limits; rate-limit variables are declared in compose so `.env` values
  actually reach the container; CI boots the built image and validates both
  compose profiles.
- Refreshed banner artwork.

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
