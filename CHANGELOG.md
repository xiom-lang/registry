# Changelog

All notable changes to the XIOM Package Registry service. Versions are the
deployed service version shown by `/health` and `/`, and follow semver.
The rendered version of this file is at `/whats-new`.

## [Unreleased]

## [2.7.0] - 2026-09-29

### Interface

- **Footer social row**: added Instagram (`@xiom.language`) to match the
  xiom-lang.org footer -- same order, labels, and `rel` rules, guarded by the
  footer test.
- **Sponsors opt-in discoverability**: on your own profile, a badge that is
  still off now says so with a direct link to
  `/account/settings#sponsors` instead of leaving the opt-in a mystery.
- **Contributors is findable**: `/contributors` is now linked from the top
  navigation (and the mobile Menu), and the home page offers *Meet the top
  contributors* next to *Browse all packages*.
- **Sponsors badge in the account overview**: the `/account` hero shows the
  verified badge, and a direct settings link in every other state
  (off / no public listing / unverified).

### Provenance

- **Index digest sidecar (C5)**: `GET /index-digest.json` describes the exact
  bytes `GET /index.json` serves -- sha256, size, registry, timestamp -- and,
  when an operator-held `INDEX_SIGNING_KEY` (64-hex ed25519 seed or PKCS8
  PEM) is configured at boot, carries an ed25519 signature over a
  domain-separated payload (`xiom-index-digest:v1\n<sha256>`). Clients that
  pin the published public key can detect a swapped or stale index; the
  unsigned digest alone still gives stable change detection. `/index.json`
  gains no fields and is now served byte-for-byte from disk (the empty index
  is materialized at boot), so `sha256sum data/index.json` equals the
  published digest. A malformed key fails boot instead of downgrading.
  Generate keys with `node scripts/index-key.js`; DEPLOY.md/compose/env
  examples document the four-place wiring.

### Self-service

- **Grant changes without emailing the maintainers (B4/B5)**: `/account/requests`
  gains **Your grants** -- approved trusted publishers with *Request a
  change* (repository, workflow, refs, scopes) and *Request revocation*, and
  fulfilled tokens with *Request rotation*. Every action files a request
  (`publisher-edit`, `publisher-revoke`, `token-rotation`) that carries the
  grant it targets; an admin executes it from the queue in one click:
  approved edits update the live entry in place (original request id and
  approval kept, conflicts refused), approved revocations remove it
  immediately, and rotations end approved for host-side minting. Ownership
  is checked against the target record, a grant can only have one pending
  change at a time, and the whole chain is in the requester's history.

### Publishing

- **Validate before publishing (B3, registry side)**: `POST /validate` runs
  the exact `/publish` checks -- name, semver, scope, namespace, version
  conflicts, signature rules, manifest, and every publish warning -- with no
  artifact store and no index write; the upload is always discarded. Status
  codes and the response body mirror `/publish`, so a client dry-run can
  treat it exactly like the real thing. `PUBLISHING.md` documents the curl
  flow; useful as a preflight for republish batches.

### Provenance

- **Build attestation links (C2)**: a version published through a trusted
  publisher can carry its GitHub build-attestation URL next to the OIDC
  provenance (`publisher.attestation` in `/index.json`, optional and
  additive; artifacts, digests, and signatures are untouched). The publisher
  may supply it at publish time -- canonical
  `https://github.com/<owner>/<repo>/attestations/<id>` URLs only -- or the
  registry asks GitHub's public attestations API by subject digest right
  after a provenance publish, best-effort. Package pages render it as
  *build attestation*. Discovery never blocks or fails a publish, needs no
  token for public repositories, and reuses `GITHUB_ATTESTATIONS_TOKEN`
  (falling back to the Sponsors token) only to raise rate limits.

## [2.6.0] - 2026-09-29

### Fixed

- **Stale "Sign in" in the header after signing in**: session-aware HTML is no
  longer publicly cacheable. The registry now defaults responses to
  `Cache-Control: private, no-cache`, so a browser or shared cache can never
  serve the anonymous page (with its Sign in button) after a successful
  sign-in. `/index.json`, assets, and version READMEs keep their public
  caching.
- **One-click sign-in**: the header button now starts the GitHub round-trip
  directly and returns you to the page you were on, instead of routing
  through the sign-in page first. `/login` remains for explanations, error
  results, and account-page redirects.
- **Account menu identity**: the header shows the GitHub avatar and the
  account's display name (falling back to the first letter and @login) from
  the stored profile -- the session carries identity only, which is why the
  first-letter fallback used to appear. The Sign in button styling now also
  covers the header slot, so it reads as a button, not menu text.

### Discovery

- **Download stats (C1)**: artifact requests are counted per package,
  version, and UTC day. Within a day one visitor counts once per version
  (day-salted, non-reversible marker), so there is no per-user tracking and
  no raw log; dedupe markers are pruned after a week while the aggregate
  stays. Package pages show the all-time total and the 30-day window,
  `GET /packages/<name>?stats=1` returns the JSON breakdown, and the listing
  gains **Most downloaded** (`sort=downloads`) and **Top rated**
  (`sort=rating`) sorts. `/index.json` is untouched.

### Community

- **Feeds and following (A5)**: package pages gain a watch toggle with a
  public watcher count, plus an **Activity** trail (releases, reviews,
  maintainer replies, reviewer decisions, verified claims) assembled from the
  same public data everyone can see. `/account/feed` merges the trail of
  every watched package, and new releases notify watchers through a new
  `release` notification kind. Watching is a feed subscription only: no
  publish powers, no `/index.json` change, per-account and per-package caps
  keep lists bounded.
- Notification settings now persist **every** structured kind: the
  `review-reply` checkbox (previously dropped on save) is stored, and the new
  `release` kind can be muted independently.

## [2.5.0] - 2026-09-29

### Discovery

- **Lifecycle facets**: `/packages` and search filter by the manifest stage
  (`stage=all|stable|incubating|deprecated`, resolved exactly like the badge
  art: published package, else latest version, else the audited display
  override) and by whether the latest installable version is a semver
  pre-release (`prerelease=hide|only|include`). Every chip carries a count
  computed against the other active filters, links stay shareable, and the
  banner search form keeps the facets for the next query. Deprecated packages
  stay visible and marked; pre-releases are hidden by default. The listing and
  search JSON gain per-package `stage`/`prerelease` fields; `/index.json` is
  untouched.

### Community

- **Contributor profiles**: `/account/<login>` is a public profile built from
  data that is already public — packages maintained (publish provenance,
  approved trusted publishers and tokens, verified claims), written reviews and
  ratings, maintainer replies, and the reviewer/claim decision history. Review
  authors, maintainers, and decision actors link to profiles everywhere.
- **GitHub Sponsors badge**: opt-in per account, verified against GitHub's
  public `hasSponsorsListing` field with a server-side token, cached in the
  platform database, cleared on opt-out. The registry handles no money and
  stores no payment data; without a token configured the badge stays
  unverified and the settings page says so.
- **Top contributors**: `/contributors` ranks accounts by a capped, weighted
  score (written reviews 3/cap 10, maintainer replies 2/cap 10, packages
  maintained 2/cap 5, ratings 1/cap 20, decisions 1/cap 20), explains the
  rules, and excludes suspended and banned accounts. Raw volume never wins.

### Publishing

- **Maturity backstop**: publishes warn when the manifest declares no `stage`
  ("set `incubating` or `stable`") or when `stage: "stable"` is combined with
  a pre-release version. Advisory only — nothing blocks a publish.
  (Previously under Unreleased.)

### Operations

- **Offline export bundle**: `npm run export-bundle` (or
  `scripts/export-bundle.js`) mirrors a registry into the layout documented in
  `OFFLINE.md` — `index.json` copied byte-for-byte,
  `artifacts/<name>/<version>/package.tar.gz` per digest-bearing version, and
  `bundle.json` with each artifact's sha256/signature/publicKey/source and the
  index digest. Every artifact is hashed while exporting; a mismatch stops the
  run and writes no manifest. `--verify` re-checks a bundle offline. Exported
  from production for the playground: 384 artifacts, 15.5 MB, all hashes
  verified.

## [2.4.2] - 2026-09-28

### Storage

- **The SQLite move is complete**: token and trusted-publisher requests
  (`stored_requests`, migration 009) and accounts (`stored_accounts`, migration
  010) now live in the platform database with the same import-once plus JSON
  rollback-mirror contract as ratings, reports, decisions, and publishers. The
  JSON files on the data volume are rollback mirrors only; no API, protocol, or
  UI change.

### Admin hierarchy

- **Founding administrators sit above granted admins**: only config-listed
  admins can change an admin account or grant the admin role, so a granted
  admin can never demote or ban a peer or the founder. Granted admins still
  manage members and reviewers, and self-changes keep their existing
  protections. The founding account remains untouchable from the console
  (demotion, suspension, and bans were already blocked at the route level).
- The users console hides controls a viewer cannot use and explains why.

## [2.4.1] - 2026-09-27

### Fixed

- **Header account menu styling**: the avatar/name control is now a compact
  button (GitHub avatar or an initial fallback, the login, and a caret) that
  opens a stacked overlay panel with Overview, Requests, Notifications,
  Settings, the role links, and Sign out. The panel previously inherited the
  generic `.site-header nav` flex rule and rendered as a clipped row; it is now
  scoped and lays out as a menu, and the name ellipsizes on narrow screens.

## [2.4.0] - 2026-09-27

### Interface

- **Admin console joins the account tabs**: admins get an Admin tab beside
  Settings on every account page; the overview text link is gone.
- **Header account menu**: signed in, the top bar shows the GitHub avatar and
  login in a dropdown with Overview, Requests, Notifications, Settings, the
  role links (Review queue / Admin console), and Sign out.
- **Mobile pass**: package cards on the home page keep the stage badge on its
  own line instead of clipping at the right edge on phones.

## [2.3.1] - 2026-09-27

### Fixed

- **Notification email links are clickable**: the email channel now
  absolutizes app-relative notice links against `REGISTRY_URL`, so a link such
  as `/account/verify-email?token=...` or `/packages/<name>#reviews` opens from
  a mail client. In-app notices keep the relative link, stored rows are
  unchanged, and absolute links are left untouched. Notices created before an
  address was verified still never email and are not backfilled (by design).

### Operations

- Notification email is live on staging and production (authenticated SMTP as
  `registry@xiom-lang.org`, DKIM clean); `/health` reports `email: enabled`.

## [2.3.0] - 2026-09-27

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

### Notification email

- **Verified addresses only**: saving a notification email queues a single-use
  24-hour confirmation link; ordinary notices stay in-app until the link is
  opened, and changing the address invalidates the verification. This closes
  the gap where any account could redirect registry email at any address
  before the mail service is enabled.
- **Delivery failures retry**: the outbox retries with exponential backoff
  (1m, 2m, 4m, ... capped at 1h), records the last SMTP error, and gives up
  after five attempts. Rows queued before the verified-address gate shipped
  are skipped once by a migration and are never delivered.
- **Delivery visibility**: `/health` reports `email: enabled|disabled`, the
  boot log states why email is off, the admin dashboard shows outbox counts
  (pending/retrying/sent/failed/skipped) and recent failures with their error,
  and `/account/settings` shows whether the saved address is verified.

### Community contact

- **Message maintainers directly**: package pages now carry a "Contact
  maintainers" form for signed-in accounts, separate from the admin-only
  report flow. The topic and message are stored (audit and abuse handling) and
  delivered as a `support` notice to every maintainer with a registry account;
  email follows the verified-address rule.
- **Limits and controls**: one message per package per sender per day and five
  per account per day; `support` has its own mute checkbox, and a maintainer
  never gets notified about their own message.
- **Abuse reporting**: a maintainer can flag a message to the moderators from
  the notifications page; the first flag files one report into the existing
  queue and later flags are idempotent.
- **Repository and issue links**: when the published-version provenance names
  a GitHub repository, the package page offers Repository and "Open an issue"
  links as an alternative to the message form; no link is shown when
  provenance carries no repository.

### Reviews

- **Vote on a review**: signed-in accounts get up/down buttons on every
  review; one vote per account per review, clicking the same vote again removes
  it and the other flips it. Counts are public, voter identity stays private
  for abuse handling, the review author cannot vote on their own review, and
  the write limiter applies.
- **One maintainer reply per review**: a package maintainer (or an admin) can
  post one flat reply, labelled "maintainer" and editable later; it notifies
  the review author and has its own mute checkbox (kind `review-reply`).
- **Review list controls**: newest or most-helpful sorting, a text-only
  filter, and 10-per-page pagination on the package's Reviews section.

### Storage

- **Reviews, ratings, and decisions move into the platform database**: star
  ratings (`review_ratings`), the report queue (`review_reports`), the reviewer
  toggles with their history (`review_decisions` / `review_decision_history`),
  and app-managed trusted-publisher entries (`stored_publishers`) now live in
  the SQLite store instead of their JSON files. Each file is imported once on
  first start and kept afterwards as a best-effort rollback mirror; no API,
  protocol, or UI change. Requests and accounts keep their JSON stores until
  the next phase.

### Compatibility

- No `/index.json` change and no protocol change; sessions still never publish
  and every approval/decision remains audited. Stored accounts gain a
  `notifyKinds` object and email verification state (schema 1.2.0); files
  written by 2.2 load with every kind on and addresses unverified.

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
