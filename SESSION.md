<!-- Copyright (c) 2026 Eleftherios Notas and The XIOM Authors -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# XIOM Registry -- Session Handoff & Spec

**Read this first** if you are a human or agent working in
`github.com/xiom-lang/registry` (pre-split path: `registry/` in the AXIOM
monorepo). Strategy lives in `docs/RELEASE_INFRA_PLAN.md` sections R4/R5;
this file is the normative working spec for the service itself.

**Status:** the server speaks the full `xiom pkg` protocol and passes a
20-check end-to-end gate that drives the real client (`npm run test:e2e`),
plus 128 unit tests (`npm test`). **Deployed and verified:**
`https://registry.xiom-lang.org` (port 3100) and
`https://staging.registry.xiom-lang.org` (isolated instance on port 3200,
own volumes and tokens). Both advertise their own `registry` URL; the
scheduled live check (`.github/workflows/live-check.yml`,
`npm run live-check`) verifies health, artifact digests, the web UI, and the
`/categories` vocabulary, and asserts the two instances have distinct
identities. Content: `xiom.hello@0.1.0` (signed) on both instances and
`xiom.math@0.1.0` on staging with full metadata (categories/keywords/
license/repository) -- both independently verified by this session. **OIDC
trusted publishing is implemented** (`src/oidc.js`, `src/publishers.js`,
`authenticate()`, provenance in `/index.json`, `/packages/:name` and the
package page; 20 new tests). **Staging canary verified** (2026-09-21, ops):
the registry-owned workflow published through a real OIDC token and the
stored version carries provenance (run 35654475479). **First real first-party
publish verified** (2026-09-22): `xiom-std@0.61.3` from `xiom-lang/stdlib`
carried full provenance (run 35734153403, ref refs/heads/main) and a valid
ed25519 signature; the served tarball's sha256 and signature were re-verified
independently from the staging URL. **Production go-live verified**
(2026-09-23): the deployment gained the `stdlib-release` entry
(`refs/tags/stdlib-v*`) and run 35726136811 published `xiom-std@0.61.3` with
tag provenance; the production tarball's sha256 and signature were re-verified
independently. Both instances serve the banner/masthead UI. **Packages canary
campaign complete** (2026-09-23): all 35 stable packages published to staging
and independently re-verified by this session (35/35 provenance + signature
present; two tarballs re-hashed and signature-checked byte-for-byte).
Production enablement is blocked on two owner decisions: set the
`XIOM_SIGNING_KEY` secret (staging used 35 distinct ephemeral keys, confirmed)
and settle the packages repo protection question (its `registry-publish`
environment has no required reviewers because the repo is private on a Free
org, so there is no GitHub-side gate on the production publish path).
Remaining after that: ops installs `eco-release` next to `stdlib-release`.
Section 11 is the spec, section 12 the lane handoffs.
**Registry 2.0 phase 1-2 is implemented in `main`** (2026-09-25: GitHub
sign-in + self-service request queue with admin approval; publishing path
untouched) and the package status badge art is 36px; both ship with the same
pending staging/production recreate. See section 17.

**Remaining:**

0. **OIDC trusted publishing** -- see section 11. The registry-side work is
   fully specified there; nothing is implemented yet. This is the top item
   for the next registry session.

1. **Live publish/install against staging** -- DONE (2026-09-18):
   `scripts/staging-acceptance.js` published `xiom.staging-isolation-probe`
   to staging through the real client, verified the index metadata (digest,
   signature, advertised registry URL), installed it back with checksum
   verification, confirmed production's index never listed it, and yanked
   the probe. The staging token used for the run has been rotated by the
   owner. T9 and the beta gate are complete.
2. **Operational hygiene (R4) -- prepared, not live.** The ops repo has
   `scripts/restic-backup.sh` (registry volumes + both token files + both
   env files) and `scripts/xiom-uptime-check.sh` (six endpoints including
   staging `/health`), but neither is scheduled yet: restic needs the
   Backblaze B2 bucket + application key and `/etc/xiom-backup.env` (owner
   actions B1-B4), and the uptime check needs the cron with MAILTO plus an
   external monitor account for host-level outages (B6/B7). See
   `ops/docs/VPS_BACKUP_MONITORING.md`. Do not count backups as done until
   the first snapshot verifies. The release -> registry deploy hook is
   intentionally not built: deploys stay pull-based, and first-party
   publishing lands with C3 via GitHub OIDC (no HMAC webhook). Log rotation,
   pull-based cron deploys, and docroot permission hardening are done.
3. **Dependency maintenance** -- DONE: all three dependabot PRs are closed
   (multer and tar were already current; the qs/express PR was superseded by
   the tree-wide `qs 6.16.0` override on main, `npm audit` reports 0).
4. **Probe residue** -- DONE: `xiom.staging-e2e-probe`@0.0.2 was yanked on
   production (2026-09-18); both versions are now yanked and `latest` is
   empty, so nothing installable remains. Ops accepted the all-versions-
   yanked semantics as final, so no further residue action is required; the
   metadata entry stays as an audit trail (removing it would need a VPS
   index edit, not HTTP).
5. **Package channels** -- decided and recorded in `ops/docs/PACKAGE_CHANNELS.md`
   (commit 844d790): the registry protocol is the only install channel; the
   git-clone channel (`xiom install/update`, `/packages.json`) is to be
   retired by the compiler lane, not reimplemented here.
6. **Commit identity** -- DONE for this repo (owner-authorized rewrite,
   2026-09-18): all history rewritten to
   `Lefteris Notas <lefterisnotas@gmail.com>`, main now
   `d8eff222c0937c369b2378e9b8ca63f33a6396a1`, feature branch
   `b9118ff7a7ee7aff6067c5989127122d01ac22b9`, 28 tags rewritten and
   pushed; `noreply@github.com` and dependabot identities preserved; CI and
   CodeQL green on the new SHA. The rewrite spans 7 repos; the others are
   handled by their own sessions. **The VPS clone `/opt/xiom/registry` was
   re-cloned by the owner.** New commits are verified with
   `git log -1 --format='%an <%ae>'` before every push (see the identity
   section in `DEPLOY.md`).
7. **Compiler packaging** -- DONE (compiler session, CRB-3): release
   archives now build and stage both `xiom` and `xiom-pkg` with a
   `--version` assertion before archiving, and the installer wrapper
   dispatches `xiom pkg`; release users can publish/install from the next
   tag (v0.61.0). Verified in `release.yml` (xiom repo) on 2026-09-18.
8. **Website coordination** -- nothing is needed from registry for the
   website work; playground links are absolute and the
   ecosystem/registry doc pointers stay deferred until stdlib is at 100%
   (message from the website session, 2026-09-18).

---

## 1. What this service is

The XIOM package registry - the crates.io analogue for XIOM. It is a
server application, not static hosting:

- HTTP API for index discovery, artifact download, publish, yank, search.
- Persistence: JSON index + tarball storage (Docker volumes at beta).
- Authentication: Bearer tokens for publish (GitHub OIDC in phase 2), with
  per-token scopes and per-token signature policy.
- Integrity: every version carries sha256; optional detached ed25519
  signature + public key; trusted clients fail closed.
- Deployment: Docker container on the Contabo VPS (Portainer), reverse
  proxied by Hestia nginx, TLS via Let's Encrypt.

NOT a container registry. OCI images live on GHCR (`ghcr.io/xiom-lang/*`).
If an OCI registry is ever wanted, it is Harbor/distribution on a separate
hostname - do not mix the two.

Default endpoint baked into the client:
`https://registry.xiom-lang.org` (override with `XIOM_REGISTRY`).

---

## 2. Protocol contract (normative)

Client source of truth: `crates/xiom-pkg/src/registry.rs` and
`crates/xiom-pkg/src/main.rs` (they live in the xiom compiler repo). Read
them before changing server behavior.

### 2.1 Client requests

| Client action | Request | Notes |
|---|---|---|
| index | `GET {registry}/index.json` | cached in-process for 5 minutes; must be valid JSON matching the schema below |
| download | `GET {registry}/packages/{name}/{version}/package.tar.gz` | exact path the client builds; response body is the tarball |
| publish | `POST {registry}/publish` | `multipart/form-data`; file field name `package`; text fields `name`, `version`, and optional `signature`, `publicKey`; header `Authorization: Bearer <XIOM_REGISTRY_TOKEN>` |
| search | none (client-side) | `xiom pkg search` downloads the index and filters locally; the server's `/search` is optional sugar |
| install fallback | `packages/index.json` in a project or `<project>/ecosystem/<pkg>` | local/GitHub-Releases path, not this service |

Transport rules on the client: HTTPS enforced (plain http only when
`XIOM_PKG_ALLOW_HTTP=1`); 30s GET timeout; 120s download timeout; max
archive 256 MiB; multipart upload signed with the environment token.

**Known client defect (compiler repo, not this service) -- RESOLVED in
xiom 43fbbbcc (R32/R33):** `xiom pkg install` used to fall back to an
unverified download after any failure, silently installing tampered
artifacts, and the trust-store lookup silently skipped signature
enforcement when the pinned URL differed by a trailing slash or case. Both
are fixed; the registry e2e locks the behavior (tamper -> non-zero exit
with no fallback; non-canonical trust URL still enforces the pin).

### 2.2 Index schema the client accepts

```json
{
  "registry": "https://registry.xiom-lang.org",
  "version": "1.0.0",
  "packages": {
    "xiom.example": {
      "name": "xiom.example",
      "description": "...",
      "repository": "https://github.com/...",
      "license": "MIT OR Apache-2.0",
      "categories": ["graphics"],
      "keywords": ["vulkan", "gpu"],
      "latest": "0.1.0",
      "versions": {
        "0.1.0": {
          "version": "0.1.0",
          "sha256": "<hex>",
          "signature": "<hex ed25519 over the tarball bytes>",
          "publicKey": "<hex>",
          "size": 12345,
          "published": "2026-09-16T00:00:00Z",
          "dependencies": {}
        }
      }
    }
  }
}
```

- `registry` is **required** by the client (`RegistryIndex.registry` has no
  serde default); the server emits it from `REGISTRY_URL`. Without it the
  client refuses the whole index with "missing field `registry`".
- `versions` may also be a plain array of version strings (legacy), but the
  server MUST always emit the object form: `sha256` is mandatory for install
  (clients refuse unhashed versions unless `XIOM_PKG_ALLOW_UNHASHED=1`).
- `sha256` is lowercase hex of the exact tarball bytes.
- `signature`/`publicKey`: optional in the schema, but a client with a
  pinned key for this registry (see `xiom pkg trust`) REFUSES unsigned or
  mis-signed artifacts. When present, the signature is ed25519 over the
  exact tarball bytes.
- `latest` is the highest non-yanked version (stable preferred over
  prerelease); it is empty when every version is yanked.
- `yanked: true` (plus `yankedAt`, optional `yankReason`) marks withdrawn
  versions; artifacts remain downloadable for pinned lockfiles.
- Known caveat: `/index.json` is serialized compact when served from a
  freshly built in-memory state and pretty-printed (2-space indent) after a
  restart reloads from disk. The client deserializes the index, so both are
  valid; standardize on one serializer when next touching `src/index.js`.
  No client should ever string-match the raw index bytes (the compiler's
  old fallback did; it was removed in xiom 43fbbbcc / R36).

### 2.3 Version metadata the server stores per publish

`version`, `sha256`, `signature`, `publicKey`, `size`, `published`,
`dependencies` (extracted from `package.xi` inside the tarball, since the
client does not send them), and optional `compiler` compatibility range.

Package-level metadata is likewise extracted from the manifest and refreshed
on each publish (only when the new manifest carries a value, so a later
version cannot wipe it): `description`, `repository`, `license`,
`categories` (controlled vocabulary, max 3, aliases mapped, unknown values
dropped and reported in the publish response as `warnings`), and `keywords`
(free-form, max 10, search-only). The vocabulary lives in
`src/categories.js`; `GET /categories` returns every entry with its package
count.

### 2.4 Reconciled mismatches (T1-T7, all done)

| Item | Client expects | Server behavior now |
|---|---|---|
| Download path | `/packages/{name}/{version}/package.tar.gz` | client path served; `/download` suffix kept as alias |
| Publish auth | `Authorization: Bearer <token>` | Bearer preferred; `x-api-key` and GET `api_key` accepted for legacy compatibility |
| Signature fields | `signature` + `publicKey` per version | parsed, format-validated, stored, emitted; verified on publish for `trusted` tokens |
| Immutability | locked installs depend on digests | duplicate version -> 409; `POST /packages/:name/:version/yank` |
| Reserved names | first-party `xiom.*` namespace | `firstParty` token flag required for `xiom.*` and `xiom-*`; strict name validation |
| `/index.json` fields | `size`, `published`, `dependencies` tolerated | all stored and emitted, plus the required root `registry` field |

### 2.5 Error semantics

- `400` malformed body / invalid name or semver / malformed signature hex.
- `401` missing or unknown token (publishing is always authenticated).
- `403` token not allowed to publish the requested namespace/scope.
- `404` unknown package/version/artifact.
- `409` version already exists (immutable; yank instead).
- `413` tarball over the size cap (50 MiB at beta).
- `422` signature missing for a trusted token, or signature mismatch.
- `429` rate limit exceeded (with `Retry-After`).
- `507` index growth bound reached (`MAX_INDEX_PACKAGES` / size / versions).

---

## 3. Work breakdown

- [x] T1. Client download route + `/download` alias.
- [x] T2. Bearer auth with per-token scopes; `x-api-key` kept for backward
      compatibility.
- [x] T3. Store `signature`, `publicKey`, `size`, `published`,
      `dependencies` (and `description`) in the index; emit on `/index.json`;
      extract metadata from `package.xi` inside the uploaded tarball.
- [x] T4. Server-side ed25519 verification on publish for tokens marked
      `trusted: true`; 422 on missing/mismatched signatures.
- [x] T5. Immutability (409 on republish) + `POST /packages/:name/:version/yank`
      (`yanked: true`; artifact stays; pinned installs keep working).
- [x] T6. Reserved namespace policy (`xiom.*` and `xiom-*` first-party only;
      the hyphen form guards against lookalikes while the packages monorepo
      still ships `xiom-*` folders) + name validation (lowercase DNS-ish
      grammar, Windows reserved segments). The UI marks first-party names
      with an `official` badge.
- [x] T7. Limits: 50 MiB cap, rate limiting, index growth bounds.
- [x] T8. End-to-end test (`npm run test:e2e`) wired into CI
      (`.github/workflows/e2e.yml`).
- [x] T9. Staging deploy at `staging.registry.xiom-lang.org`: isolated
      instance on port 3200 with its own volumes, tokens, and
      `REGISTRY_URL`, verified by the live check. Acceptance DONE
      (2026-09-18): the real client published a signed fixture to staging,
      installed it back with checksum verification, and production's index
      never listed it; the probe was yanked and the token rotated.
- [x] T10. Doc split: `README.md` covers quick start, `DEPLOY.md` covers
      the VPS runbook, this file stays the spec/handoff.

---

## 4. Architecture and operations

- Node.js >= 18, Express + multer + semver + express-rate-limit (see
  `package.json`).
- Source layout:
  - `src/server.js` -- process entry point (listen, shutdown).
  - `src/app.js` -- Express app and the publish pipeline.
  - `src/index.js` -- index store (normalize, immutability, yank, atomic writes).
  - `src/tokens.js` -- Bearer/x-api-key extraction, constant-time lookup, scopes.
  - `src/names.js` -- package-name grammar and namespace policy.
  - `src/signatures.js` -- ed25519 verify (Node crypto, RFC 8410 SPKI).
  - `src/manifest.js` -- bounded `package.xi` extraction from tarballs.
  - `src/storage.js` -- artifact placement with path containment.
  - `src/config.js`, `src/errors.js`, `src/categories.js` (category
    vocabulary, aliases, keyword limits, counts).
  - `src/ui/` -- read-only web UI: layouts, page builders, the shared brand
    stylesheet, and brand assets copied from the website (favicon/logo;
    provenance in `src/ui/assets/SOURCES.md`). HTML is served only when the
    browser's FIRST Accept entry is `text/html`; every other request keeps
    the JSON contract (`src/ui/negotiate.js`). No client-side framework, no
    build step.
  - `scripts/keygen.js` -- publish-token generator (`--replace` rotates).
  - `scripts/tokens.js` -- token admin CLI (list/add/remove/rotate) so
    operators never hand-edit JSON or paste heredocs; `list` prints no
    values and `rotate` is a single atomic write.
  - `scripts/live-check.js` -- read-only deployed-instance smoke check;
    scheduled in `.github/workflows/live-check.yml` (health, registry
    self-advertisement, artifact digest equality, staging/production
    isolation).
- Rate limiting: `express-rate-limit` on every route (general read budget,
  stricter publish and download budgets); configured via the `RATE_LIMIT_*`
  / `PUBLISH_RATE_*` / `DOWNLOAD_RATE_*` env knobs, disabled with
  `RATE_LIMIT_DISABLED=1` (tests).
- Storage at beta: `data/index.json` plus
  `packages/<name>/<version>/package.tar.gz`, both on Docker named volumes.
- Env: `PORT` (3000), `HOST`, `DATA_DIR`, `PACKAGES_DIR`, `UPLOAD_TMP_DIR`,
  `REGISTRY_URL`, `TOKENS_FILE`, `TRUST_PROXY`, `NODE_ENV`, size/index limits
  and rate-limit knobs (see `.env.example`). Legacy `API_KEY` maps to a
  first-party, trusted token.
- Container hardening: non-root `node` user, `no-new-privileges`, dropped
  capabilities, bind `127.0.0.1:3000` only (Hestia nginx terminates TLS).
- Reverse proxy: Hestia nginx vhost for `registry.xiom-lang.org` ->
  `http://127.0.0.1:3000`, Let's Encrypt TLS, force HTTPS.
- Backups: nightly restic of the two volumes off-site; documented restore
  drill. See `docs/RELEASE_INFRA_PLAN.md` R4 for the full VPS runbook.
- Not exposed: Portainer itself stays off the public internet (SSH tunnel
  or IP allowlist).

---

## 5. Test plan

`npm test` runs the unit suite (index, names, auth, signatures, manifest,
config, HTTP semantics). `npm run test:e2e` is the gate that matters -- 20
checks; it starts a sandboxed registry and drives the REAL `xiom-pkg`
client:

1. Build a fixture package directory with a `package.xi`.
2. `xiom pkg keygen` writes the test keyring; a trusted token is configured.
3. Server starts on a free port with isolated data/packages/tokens dirs.
4. `xiom pkg publish` the fixture; assert 201 and every index field,
   including metadata extracted from `package.xi`.
5. Install through the registry path (checksum verified), then `xiom pkg
   lock` and confirm the digest is pinned in `xiom.lock` (v2, `sha256-...`).
6. Negative cases: republish -> 409; bad token -> 401; reserved namespace ->
   403; unsigned artifact from a pinned registry -> refused; tampered
   artifact/ signature -> 422 or checksum mismatch; yanked version -> pinned
   install still works, `latest` skips it.
7. Pin the key (`xiom pkg trust --registry ... --key <hex>`) and repeat
   install; assert signature verification is enforced.

Client lookup for the e2e: `$XIOM_PKG_CLIENT`, then
`../xiom/target/{debug,release}/xiom-pkg[.exe]`, then PATH. Build it with
`cargo build -p xiom-pkg` in the xiom repo.

---

## 6. Roadmap (post-beta)

- Phase 2: GitHub OIDC trusted publishing (short-lived tokens; verify the
  OIDC token against GitHub JWKS and check repo/ref claims). No long-lived
  registry token in CI.
- Phase 2: store the GitHub attestation URL per version; show provenance
  on the website.
- Phase 3: download stats, mirror/offline mode, object-storage backend,
  index sharding if package count grows past a few thousand.

---

## 7. Non-goals

- Container images (GHCR handles those).
- User accounts/dashboards at beta (tokens issued manually).
- Rewriting the registry in XIOM before selfhost is stable - revisit later
  as a showcase project, not now.

---

## 8. Session prompt (paste-ready)

```
Work in the xiom-lang/registry repository. Read README.md and SESSION.md
(the spec and handoff) before touching code. The registry must speak the
protocol implemented by crates/xiom-pkg in the xiom repo: GET /index.json
(including the root "registry" field), GET
/packages/{name}/{version}/package.tar.gz, POST /publish with Bearer auth
and signature/publicKey multipart fields. The work queue is section 3 of
SESSION.md. T1-T8 are implemented and covered by tests. Follow the
repository rules: conventional commits, tests for every behavior change,
never weaken signature or checksum checks. Run `npm test` and
`npm run test:e2e` (real client) before claiming any task done. Deployment
is staging-first; production is behind a required-reviewer environment.
```

---

## 9. Related documents

- `README.md` -- quick start and repository rules.
- `PUBLISHING.md` -- package-author guide (token request, signing, publish,
  yank, troubleshooting); linked from the registry UI.
- `USING.md` -- consumer guide (install, lock, signatures and trust).
- `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE` -- dual MIT OR Apache-2.0;
  Copyright (c) 2026 Eleftherios Notas and The XIOM Authors.
- `docs/RELEASE_INFRA_PLAN.md` (monorepo until split): R3 release
  pipeline, R4 VPS runbook, R5 registry hardening.
- `docs/REPO_MIGRATION_RUNBOOK.md` (monorepo until split): how this repo
  was carved, CI wiring after the split.
- Client: `crates/xiom-pkg/src/registry.rs`, `crates/xiom-pkg/src/main.rs`,
  `crates/xiom-pkg/src/signing.rs`, `crates/xiom-pkg/src/lockfile.rs`.

---

## 10. Cross-lane roadmap (2026-09-19)

The registry beta is complete and deployed; what follows is the remaining
work across lanes, with owners. Keep this list current when a lane closes an
item.

### Registry lane (this repo)

- [ ] **OIDC trusted publishing** (the next feature): trusted-publisher
      config (repo / workflow / ref -> scopes + firstParty), GitHub JWKS JWT
      verification (Node crypto, no new deps), claim validation, publisher
      provenance recorded per version, tests. Replaces long-lived CI tokens;
      enables C3 publish-from-Actions with no client change (the workflow
      sets `XIOM_REGISTRY_TOKEN` to the OIDC token and `xiom pkg publish`
      sends it as the bearer value).
- [ ] First real end-to-end publish/consume validation (owner publishes a
      community package; registry session installs it and runs the boundary
      checks).
- [ ] Phase 3 (post-beta, unplanned): download stats, mirror/offline mode,
      object storage, index sharding.
- [x] Footer social row (2026-09-21): the xiom-lang.org `.footer-social`
      block now renders in the registry UI footer -- same order (Discord, X,
      Mastodon, Bluesky, Reddit, Hacker News, LinkedIn, Facebook), same
      aria-labels, titles and rel/target rules, Discord wording identical,
      inline Simple Icons (CC0) paths sharing the website's `.footer-social`
      CSS. `registry@xiom-lang.org` (mailto) sits beside the row as the
      registry-specific contact; the legal line keeps support@xiom-lang.org.
      Covered by the UI test asserting the exact anchors and their order.
- [x] Page banner and masthead (2026-09-22): the website's `registry.webp`
      (1539x510) is served at `/ui/registry.webp`; the banner carries the
      wordmark (a home link) + REGISTRY section + accent, and the sticky bar
      is navigation only, so the brand never repeats. Per the owner's call the
      global search sits centred and wide inside the banner, anchored to the
      lower third so it never stacks into the left wordmark area (the website
      lane's crowding concern); the query is preserved on `/search`. The home
      hero keeps one visible `h1` (Packages). CSS lifted from
      `xiom-website/style.css`; `aria-hidden` sits on the decorative wordmark
      spans because the banner holds a focusable home link. `logo.png` was
      retired with the old header brand; `src/ui/assets/SOURCES.md` records
      the sources. The UI test pins the single search form, the wordmark link,
      the absent duplicate brand and the query prefill.
- [x] Token lifecycle and issuance (2026-09-21): static tokens can be pinned to
      a signing key (`tokens.js add/rotate --key`, `--key` implies `--trusted`;
      a different key gets `422 public_key_mismatch`) and now carry `issuedAt`;
      `list` marks `ROTATION-DUE` at 90 days and `list --json` feeds the ops
      rotation report. Ops runs `issue-token.sh` (e-mail delivery from
      registry@xiom-lang.org, key passthrough, issuance log) and a monthly
      rotation cron over both token files. Official CI stays on OIDC;
      community publishing uses these static tokens (PUBLISHING.md section 4,
      DEPLOY.md "Tokens").
- [x] Category vocabulary and package metadata (2026-09-21): `categories`
      (17 canonical + aliases, max 3), `keywords` (max 10), `license`,
      `repository` extracted from `package.xi` and emitted across the API;
      `GET /categories`; `?category=` on `/search`; UI chips, category strip,
      and `/categories` page; publish warnings for unknown categories. The
      72 first-party manifests are annotated (packages 2d2513b); the client
      (`xiom pkg search --category`, `xiom pkg info`, MCP `search_packages` /
      `package_info`) consumes the same fields. **Canary verified live**
      (2026-09-21): `xiom.math@0.1.0` published to staging shows
      `categories: ["core"]`, all six keywords, license, and repository;
      `/categories` counts it; `?category=core` finds it; the package page
      renders the chips; production never listed it.

### Compiler lane

- [x] Retire the git-clone channel (R50, commit `6241f367`): `xiom install`
      delegates to the verified `xiom pkg install`; `xiom update` is retired
      with guidance; the legacy `/packages.json` handlers were deleted, so no
      install path can skip checksum/signature/yank. Verified 2026-09-19.
- [x] Dotted package names: the resolver accepts canonical `xiom.std` with
      the legacy `xiom-std` alias (`main.rs` ~421/425, ~447-451). The pinned
      stdlib manifest still declares the hyphen form; the full switch is
      coordinated with the stdlib session (drop the alias once `xiom.std` is
      declared and published).
- [ ] Optional wins, queued as documented: `xiom pkg update|outdated`
      reading `/index.json`; `xiom self-update` from `dl./latest.json` with
      SHA256 verification.
- [ ] Deterministic archives (found during the first real publish): the
      client packs gzip/tar with current mtimes, so the same source produced
      different digests on staging and production. Prefer `gzip -n` plus a
      fixed `--mtime=@0` (or a content hash) in the packer so digests are
      reproducible and OIDC attestations compare meaningfully. Registry
      stores bytes as-is; no server change needed.
- [ ] `trust` hint wording: install prints "pin it with `xiom pkg trust
      --registry <url> --key <publisher key>`", but `trust` pins a registry
      key. Reword for accuracy (per-publisher pinning is a registry-side
      future feature).
- [ ] `xiom pkg --resolve` prints an empty tree outside a compiler workspace
      (it looks for a sibling `stdlib/`); misleading for package authors.
- [ ] C3 CI publish: GitHub Actions workflow issuing the OIDC token (after
      the registry feature lands; no client change needed).

### Ops lane

- [x] Token hygiene (2026-09-19): the tokens exposed during the first-publish
      run were rotated by the owner with `scripts/tokens.js`; the staging file
      was collapsed from four entries (three duplicate `staging` + one
      `xiom-hello`) to exactly one of each. Both instances verified with the
      no-publish probe -- a yank of a missing version returns 404
      `version_not_found` for a live token and 401 `invalid_token` for a
      revoked or unloaded one. Ops adopted the CLI for sections 1-6 of
      `REGISTRY_TOKENS.md` (ops 18058fe), including the safe probe; legacy
      `keygen` is noted as such.
- [ ] (in progress) The production `staging-admin` token (scope `*`) is
      undocumented: the owner is removing it (the default) or rotating it
      under an honest label with an issuance-log entry. Expect the token
      count in `docker logs` to drop on the next recreate; if anything
      unexpected starts returning 401, recreate and coordinate with ops.
- [ ] B1-B4: Backblaze B2 bucket + application key + `/etc/xiom-backup.env`,
      run `restic-backup.sh` once, verify the first snapshot -- only then is
      backup "done".
- [ ] B6/B7: alert mailbox + cron MAILTO for `xiom-uptime-check.sh`, plus an
      external monitor account for host-level outages.
- [ ] Deploy hook: intentionally none (pull-based deploys; no HMAC webhook).
- Done: log rotation, pull-based cron deploys, docroot permission hardening,
      SHA pinning compliance, restic/uptime scripts prepared and tested.

### Playground lane

- [ ] C1 registry search panel: unblocked (public JSON API + UI deep links).
- [x] C2 GitHub auth: live (host-side OAuth helper; the accepted pattern for
      any future registry identity surface).
- [ ] C3 package examples: wait on the first real packages being published.
- [ ] C4 design system: shared tokens in use; extraction to one canonical
      file is a later refactor.

### Content milestone (cross-lane)

- [x] First real package published manually: `xiom.hello@0.1.0` to **staging
      and production** on 2026-09-19 (signed, `xiom.*` official badge),
      published by the packages session with a scoped trusted+firstParty
      token; independently verified by the registry session (clean install,
      checksum, fingerprint, served-bytes hash equals the index digest).
- [ ] CI publishing automation for `xiom.*` packages via OIDC (C3), so the
      release flow stops depending on a hand-delivered token.

---

## 11. Next session: OIDC trusted publishing (handoff brief)

**Why.** Every CI publish currently needs a long-lived token hand-delivered
by the operator. OIDC replaces that: a GitHub Actions workflow exchanges its
identity for a short-lived JWT, the registry verifies it against GitHub's
JWKS and publishes only within the mapped scopes. It is the prerequisite for
C3 (publish from Actions) and for per-version provenance.

**Implementation status (2026-09-21):** increments 1-5 below are done in
`src/oidc.js`, `src/publishers.js`, `authenticate()` and the provenance
pipeline; the loader reads `TRUSTED_PUBLISHERS_FILE` (array or
`{"publishers": [...]}`; missing/empty = no publishers; malformed = startup
exit) and the audience is `OIDC_AUDIENCE` (default `xiom-registry`).
Remaining: increment 6 (staging canary with ops, then production entries on
the owner's OK), and the lane workflows noted in section 12.

**Decisions already made -- do not relitigate:**

- **No client change.** The workflow sets `XIOM_REGISTRY_TOKEN` to the OIDC
  token; `xiom pkg publish` sends it as the bearer value. The registry
  distinguishes JWTs (three dot-separated segments) from static tokens inside
  `authenticate()`; static tokens keep working for humans.
- **Issuer** `https://token.actions.githubusercontent.com`; **audience** is
  registry-defined and pinned (suggested value: `xiom-registry`); JWKS from
  `https://token.actions.githubusercontent.com/.well-known/jwks`.
- **RS256 verification with Node crypto only** (no new npm dependencies):
  `crypto.createPublicKey({ key: jwk, format: 'jwk' })` plus
  `crypto.verify('sha256', signingInput, key, signature)`.
- **Claims checked:** `iss`, `aud`, `exp` (allow ~60s skew), `repository`,
  `workflow`/`workflow_ref`, `ref`, `event_name`; `sub` kept for logs.
- **Mapping lives in a trusted-publishers config** (path from
  `TRUSTED_PUBLISHERS_FILE`, inline JSON fallback), each entry shaped like:
  `{ label, repository: "xiom-lang/xiom", workflow: "release.yml",
     refs: ["refs/tags/v*"], scopes: ["xiom.*"], firstParty: true }`.
  Claims only *select* an entry; they never widen its scopes.
- **Fail closed.** Invalid / expired / wrong-aud / unknown-kid -> 401. A valid
  token with no matching entry -> 403. A JWKS fetch failure must never make a
  signature check pass; serve the cached set and fail the request instead.
- **Provenance per version**: record `publisher: { repository, workflow, ref,
  commit (sha claim), runId, runUrl }` in the version entry and emit it in
  `/index.json`, `/packages/:name`, and on the package page. Additive field;
  deserializers tolerate it.
- **JWKS caching**: in-memory, keyed by `kid`, ~1h TTL, refetch on unknown
  kid, request timeout. GitHub rotates keys.

**Increments (each with tests, in order):**

1. `src/oidc.js` -- JWT parse, JWKS cache/fetch, RS256 verify, claim
   validation as pure functions (test with a locally generated RSA keypair;
   no network in unit tests).
2. `src/publishers.js` -- trusted-publisher config load/normalize/match
   (repository + workflow + ref glob + scopes), startup validation that
   fails loudly on malformed config.
3. `authenticate()` -- accept JWTs, map to the same token shape
   (`label`, `scopes`, `trusted`, `firstParty`, `publisher`), 401/403 per the
   rules above; the static-token path (constant-time) stays untouched.
4. Publish pipeline + index + UI: store and render the `publisher` object.
5. Docs: `PUBLISHING.md` "Publish from GitHub Actions" with a workflow
   example (`permissions: id-token: write`, request the token with the pinned
   audience, export `XIOM_REGISTRY_TOKEN`); SESSION schema update; ops gets a
   pointer for the VPS config file placement (ops lane owns that).
6. Live proof: dry-run publish from a real repo to **staging** first (canary
   package), then production after owner approval.

**Gotchas:**

- GitHub OIDC tokens are short-lived (~5 min) and audience-pinned; request
  the exact configured audience or verification fails.
- `workflow_ref` looks like
  `owner/repo/.github/workflows/x.yml@refs/tags/v1`; match `repository` +
  `ref` + `workflow` rather than string-matching the whole ref.
- Reusable/child workflows carry `job_workflow_ref`; decide explicitly
  whether to accept it (default: no).
- Never log the JWT; log `label`, `repository`, `run_id` only.
- Keep `npm audit` at 0 and the 107-test suite green; add tests for every
  claim rule and the cache behavior.

**Paste-ready prompt for the next session:**

```
Work in xiom-lang/registry. Read SESSION.md first, especially section 11
(OIDC trusted publishing handoff brief), section 2 (protocol contract) and
section 5 (test plan). Implement OIDC trusted publishing for GitHub Actions
exactly as specified in section 11, in the listed increments, with tests for
every claim rule, the JWKS cache, and the trusted-publisher matcher.

Rules: conventional commits with `git commit -s` (DCO); never weaken
signature, checksum, or namespace checks; static tokens must keep working
unchanged; no new npm dependencies if Node crypto can do it; run `npm test`
and `npm run test:e2e` before claiming anything done. Staging first --
publish a canary via OIDC to https://staging.registry.xiom-lang.org and prove
production isolation; do not touch production without the owner's OK.

Current state: main is green (128 unit tests, 20 e2e, live check passing,
categories/keywords and OIDC trusted publishing shipped). The lane workflows
are tracked in section 12; the compiler v0.61.0 release is the common
dependency for the stdlib and packages canaries, while the registry-owned
canary does not need it.
```

---

## 12. OIDC lane handoffs (2026-09-21)

The publisher configuration is locked. This section is the relay sheet for
the compiler/stdlib, packages, ops and website sessions (there are no
managed Agent Manager sessions to message directly; the owner relays).
Audience `xiom-registry`; production trusts tag refs only; scope lists are
enumerated, never a blanket `xiom`.

**Production entries (trusted-publishers config):**

| repository | workflow | refs | scopes | firstParty |
|---|---|---|---|---|
| `xiom-lang/stdlib` | `publish-registry.yml` | `["refs/tags/stdlib-v*"]` | `["xiom.std", "xiom-std"]` | true |
| `xiom-packages/packages` | `publish-registry.yml` (added, bbabfa1) | `["refs/tags/eco-v*"]` | 71 enumerated names (list below) | true |

Staging adds the same two repos with `["refs/heads/main"]` so the existing
dispatch path can canary; graduated repos get one entry each later with a
single `xiom.<name>` scope. `xiom-lang/xiom` (compiler) publishes toolchain
archives and the VSIX, not registry packages, so it needs no entry.

**Verified GitHub state (2026-09-21):**

- `xiom-lang/stdlib`: environment `registry-publish` exists with required
  reviewer Lefteris-Notas. Rulesets: `protect-release-tags` (active;
  `refs/tags/v*` + `stdlib-v*`; deletion + non-fast-forward only) and
  `release tags` (covers `stdlib-v*`; creation/update/deletion; admin
  bypass) -- **`release tags` is currently disabled and must be enabled**.
- `xiom-packages/packages`: private repo on a Free org -- GitHub refuses
  rulesets (API 403) and environment required-reviewers. Options: make the
  repo public (recommended: unlocks both plus unmetered Actions minutes for
  the batch publish), upgrade the org, or accept no GitHub-side gate and
  keep this repo's production entry disabled.
- Both orgs: no OIDC subject-claim customization (`null`) -- correct; tokens
  carry the default `sub`, which we never match on.
- Registry staging canary verified (2026-09-21, ops): `xiom.canary-oidc@
  0.0.0-canary.1790024378343` published through OIDC and the stored entry
  carries `publisher {repository xiom-lang/registry, workflow oidc-canary.yml,
  ref refs/heads/main, commit 5079f57, runUrl}`, signature included.
  Production stayed `[]` and was not recreated.
- First real package through OIDC (2026-09-22): `xiom-std@0.61.3` from
  `xiom-lang/stdlib` with `publisher {workflow publish-registry.yml, ref
  refs/heads/main, event workflow_dispatch, commit 3c1850ac, run
  35734153403}`, 1,064,002 bytes, sha256 e488e803... and an ephemeral
  ed25519 key (fp d5:e6:92:95:a4:52:75:67); both were re-verified
  independently against the served tarball. The ephemeral per-run key means
  consumers must not pin the publisher key -- `xiom pkg trust` pins the
  registry key (compiler lane has the hint-wording item). The
  `STDLIB_VERSION pin PR (xiom)` job failed in that release run and is not
  registry-related.
- Production go-live (2026-09-23): `stdlib-release` entry
  (`refs/tags/stdlib-v*`, scopes `["xiom.std","xiom-std"]`, firstParty) went
  live and run 35726136811 published `xiom-std@0.61.3` to production with
  `publisher.ref refs/tags/stdlib-v0.61.3`, `event push`, commit c7b4027f;
  sha256 `1ad1b33a...` and the signature were re-verified against the served
  tarball. Both instances now serve the banner/masthead UI.
- Staging trusted publishers (2026-09-23, ops 4bb8b77): 3 entries / 91 scopes
  -- stdlib-main-staging (`refs/heads/main`, 2 scopes), registry-canary
  (1 scope), eco-canary (`refs/heads/main`, 88 scopes); VPS clone at
  `3da13ca`. Production keeps `stdlib-release` only; `eco-release`
  (`["refs/tags/eco-v*","refs/tags/xiom-*/v*"]`) is prepared and installs
  after the ecosystem canaries pass plus the owner OK.
- Staging test artifacts (deliberate, not the deprecated packages):
  `xiom.hello@0.1.0` (signed fixture, also on production),
  `xiom.math@0.1.0` (2026-09-21 metadata canary),
  `xiom.canary-oidc@0.0.0-canary.*` (OIDC canary of record),
  `xiom.staging-isolation-probe@0.1.0` (yanked). Production also carries the
  yanked `xiom.staging-e2e-probe` pair. Publisher entries are permissions, not
  published packages; versions are immutable, so removing a name from the
  allowlist/scope only stops future publishing -- only yank withdraws a
  version, and pinned installs keep working.
- Packages canary campaign (2026-09-23): 35 stable packages published to
  staging (runs 35912452506 ... 35915440890), all independently re-verified
  here: 35/35 entries carry `publisher {repository xiom-packages/packages,
  workflow publish-registry.yml, ref refs/heads/main, runUrl}` plus a
  signature and public key; `xiom.flags` (sha256 17791aa1..., 9,284 B) and
  `xiom.msgpack` (c992d517..., 12,622 B) were additionally re-hashed and
  signature-verified byte-for-byte. Finding confirmed: 35 distinct keys --
  `XIOM_SIGNING_KEY` is unset, so every artifact used an ephemeral per-run
  key. Production blockers resolved (2026-09-23): `XIOM_SIGNING_KEY` is set,
  the repo is public, tag rulesets are active (`version` covers
  `refs/tags/xiom-*/v*` and `refs/tags/eco-v*`; `protect-main` blocks
  force-pushes on main only), and `registry-publish` requires the owner's
  review. Remaining: ops installs `eco-release` after the owner OK, then the
  first per-package tag (`xiom-flags/v0.1.0`) publishes behind the reviewer
  gate.
- First ecosystem production publish verified (2026-09-23): production now
  holds `eco-release`, and tag `xiom-flags/v0.1.0` (commit a6b71894) published
  through run 35920050801 with `publisher.ref refs/tags/xiom-flags/v0.1.0`,
  `event push`. SHA256/ed25519 of the served production tarball (9,280 B,
  b99f82e7...) were re-verified independently, and the install-back from
  production passed with `checksum verified` and `artifact is signed
  (fp 4f:3b:47:f3:ae:17:b1:3c)`. The stable `XIOM_SIGNING_KEY` is in use (run
  log: "using stable XIOM_SIGNING_KEY"; same fingerprint in both places).
  Remaining: the other 34 stable packages (one `eco-v0.1.0` batch tag would
  publish them all in a single approval), and `xiom.durable` when its port is
  green.
- Ecosystem batch live (2026-09-23): `eco-v0.1.0` published **34 ready
  packages** to production (run 35921278403, ref `refs/tags/eco-v0.1.0`,
  event push, one reviewer approval). Production now serves 38 packages
  (34 batch + `xiom.flags` + `xiom.hello` + `xiom-std` + the yanked
  `xiom.staging-e2e-probe`). The readiness filter skipped the 52 grandfathered
  names plus `xiom.hello`/`xiom.sensor` with `::warning`s -- `xiom.algo` is
  absent from production. Sample entries (`xiom.msgpack`, `xiom.csv`,
  `xiom.toml`) carry `publisher.ref refs/tags/eco-v0.1.0`; one tarball was
  re-hashed and signature-verified byte-for-byte; the stable fingerprint
  `4f:3b:47:...` covers the whole batch. Ports of the remaining 52 can ship
  later in waves (next batch or per-package tags).
- Batch-tag safety gap (found 2026-09-23, before use): the allowlist is 87
  names = 35 ready + 52 grandfathered in `.github/allowlist-baseline.txt`
  (incubating, tests unknown; the guard logs them as GRANDFATHERED). The
  workflow's publish loop filters only by allowlist membership, so
  `eco-v0.1.0` would publish all 87 -- including the 52 unverified -- with
  immutable versions. The registry lane did NOT push the batch tag. Fix
  (packages lane): apply the readiness check (STATUS.json stage stable +
  tests pass) inside the publish loop for the batch and per-package paths
  alike, skipping with a warning; then the batch publishes exactly the
  remaining ready set (34).
- Owner decision (2026-09-23): **port-first, then batch**. The packages lane
  drains the 52 grandfathered baseline entries (conformance on the pinned
  compiler + `status.ps1 -Action update -Stage stable` with run_by/commit),
  and keeps the readiness filter in the publish loop as the enforcement
  backstop. When `.github/allowlist-baseline.txt` is empty (or every allowed
  name is stable+pass), the registry lane pushes `eco-v0.1.0`; the batch then
  publishes exactly the verified set. The batch tag is on hold until then.
- Repack/canary policy (updated 2026-09-23, stdlib relay): `xiom pkg publish`
  still re-packs, but the stdlib release assets are now **deterministic**, so
  regenerating an asset is byte-stable and re-runs do not change it. Rule:
  re-canary after any asset regeneration or change to the release packing;
  the canary validates the auth/mapping/provenance path and the publish-time
  signature, not byte promotion from the asset. Published bytes remain a
  repack (before determinism: staging e488e803/1,064,002 B vs production
  1ad1b33a/1,063,776 B from the same 1,063,898 B input), so byte-identical
  staging-to-production promotion still needs deterministic client packing or
  a publish-existing-tarball mode (compiler lane, optional).
- Byte-identical promotion test (scheduled, pending release): the client half
  shipped in compiler m126 (`68b3be9f`: deterministic in-repo tar.gz writer +
  `publish --tarball <PATH>` promote mode, prints the promoted SHA256), but
  m126 is **not in v0.61.3** (`merge-base` check) and no newer release exists
  yet. Once a compiler release contains it: bump the packages
  `COMPILER_VERSION`, bump one package to a new version (versions are
  immutable, so a fresh version is required), publish it to staging, then
  publish it to production via its per-package tag,   and compare sha256 +
  signature across the two instances -- they should be identical now, or use
  the promote mode to ship the exact staging bytes.
- Promotion test plan (2026-09-24, per m126 detail): the deterministic writer
  (sorted entries, mtime=SOURCE_DATE_EPOCH default 0, uid/gid 0, fixed modes,
  gzip MTIME 0/OS 255) and `publish --tarball <PATH>` (no re-pack, prints the
  promoted SHA256) land with the **single combined compiler release** (no
  intermediate tag; the owner is batching releases). Optional rehearsal before
  then: build `xiom-pkg` from compiler main; it needs an authorization path for
  production (a packages-workflow promote input, or an ops promote with a
  static first-party token) -- the registry lane can verify but cannot
  authorize production publishes.
  Test A (no workflow change): bump one package to a fresh version, dispatch to
  staging, then tag to production, and compare sha256/signature -- they should
  be identical. Test B (exact promotion): needs a promote path in the packages
  workflow (`publish --tarball` on the staged artifact) or a manual ops promote
  with a static token; then production must serve byte-for-byte the staging
  tarball. Registry side needs no change for either.
- Stdlib release jobs should set `SOURCE_DATE_EPOCH` (fixed) when they build
  the release asset so regeneration is byte-stable; the packages publishes go
  through the now-deterministic client writer, so no job change is needed
  there. Registry side has nothing to set.
- Naming alignment (compiler finds `xiom-std` published vs canonical
  `xiom.std`): the registry has **no aliasing/rename** -- both names are valid
  reserves and would be separate packages. **Owner confirmed 2026-09-24:**
  `xiom.std` (dotted) is canonical -- stdlib publishes dotted from the rename
  onward, the `xiom-std` series stays frozen at its last published version,
  and the client maps `xiom-std` to `xiom.std` as a legacy alias (scope
  already allows both; no registry config change). `xiom.std` **remains a
  platform dependency** (excluded from the registry closure by the client);
  the registry still accepts its publications for provenance/docs, and making
  it installable later would be a client-only gating change.

**Open owner decisions (2026-09-21):**

- `xiom-packages/packages` stays private until the first batch is curated
  (real source, README/LICENSE per package). Public (or a paid org) is what
  unlocks tag rulesets and environment reviewers there; until then the repo
  is owner-only and its production entry stays disabled.
- The packages session owns a graduation runbook (criteria, repo template,
  workflow, ruleset, registry-config change, ops handoff).
- Community self-service trusted publishing is not open: community publishers
  keep using manually issued tokens; an approval/registration flow is a
  future feature (accounts are not needed for reading the registry).

**Config contract confirmed for ops (increment 2):**

- Top-level JSON: an array `[ ... ]` or `{ "publishers": [ ... ] }`.
- Entry: `{ label, repository, workflow, refs, scopes, firstParty, events? }`.
- `workflow`: bare file name or `.github/workflows/<file>`, matched against
  the file portion of the `workflow_ref` claim; `job_workflow_ref` ignored.
- `refs`: globs over the `ref` claim. Default events: tag refs allow
  `push`/`release`; branch refs allow `workflow_dispatch`/`push`.
- Missing or empty file: no publishers (JWTs 403, static tokens unaffected).
  Malformed JSON: the process exits at startup (fail closed).
- Ops staging entry: scope must be `["xiom.std", "xiom-std"]`, not
  `xiom.stdlib` -- the package is `xiom.std` (target name) / `xiom-std`
  (current manifest).

**Registry answers to the lane reports (2026-09-21):**

- Package name: scopes are exact package-name prefixes. The stdlib entry
  keeps `xiom.std` and `xiom-std`, so the current manifest name publishes
  unchanged; drop `xiom-std` after the rename.
- Signatures: OIDC tokens map to trusted first-party tokens, so the existing
  rule holds -- trusted tokens require a valid ed25519 signature (422
  otherwise). No exemption in this feature; the packages workflow's per-run
  key is acceptable for the canary, but a stable first-party signing key
  should be decided before the first production batch (a signing key is not a
  registry credential). The migrated stdlib workflow has no keygen step, so
  it must add one (`xiom pkg keygen`) or it will publish unsigned and be
  rejected 422.
- Stub packages: publishing a placeholder 0.1.0 makes that version immutable
  forever and forces real code to 0.1.1+. Gate the eco batch to packages with
  real source before pushing `eco-v0.1.0`.
- Stdlib tag race: re-run the publish workflow after the release job uploads
  `xiom-std-<ver>.tar.gz`, or add an asset-wait loop.
- Canary prerequisite: both lane canaries download v0.61.0 compiler archives
  that must contain `xiom-pkg`, so they wait on the compiler release. The
  registry owns an independent canary that does not: `.github/workflows/
  oidc-canary.yml` (dispatch, default staging URL) runs
  `scripts/oidc-canary.js`, which publishes `xiom.canary-oidc@0.0.0-canary.
  <epoch>` through a real OIDC token and asserts the stored provenance.
  Staging entry: `{ label: registry-canary, repository: xiom-lang/registry,
  workflow: oidc-canary.yml, refs: ["refs/heads/main"],
  scopes: ["xiom.canary-oidc"], firstParty: true }`.

**Packages scope list (71 names, bbabfa1):**

```json
["xiom.algo", "xiom.arrow", "xiom.assimp", "xiom.blas", "xiom.box2d",
 "xiom.bullet", "xiom.control", "xiom.core", "xiom.cuda", "xiom.directx11",
 "xiom.directx12", "xiom.dxc", "xiom.eigen", "xiom.ffi", "xiom.ffmpeg",
 "xiom.gazebo", "xiom.glfw", "xiom.graphql", "xiom.grpc", "xiom.hello",
 "xiom.http", "xiom.imgui", "xiom.jolt", "xiom.json", "xiom.kafka",
 "xiom.libpq", "xiom.libsodium", "xiom.libtorch", "xiom.libuv", "xiom.log",
 "xiom.lzfse", "xiom.math", "xiom.meshopt", "xiom.micro", "xiom.miniaudio",
 "xiom.moveit", "xiom.net", "xiom.numpy", "xiom.onnx", "xiom.openal",
 "xiom.openblas", "xiom.opencv", "xiom.opengl", "xiom.openssl", "xiom.ozz",
 "xiom.pandas", "xiom.phonon", "xiom.portaudio", "xiom.postgres",
 "xiom.protobuf", "xiom.raylib", "xiom.realtime", "xiom.redis", "xiom.rest",
 "xiom.ros2", "xiom.scipy", "xiom.sdl3", "xiom.sensor", "xiom.sql",
 "xiom.sqlite", "xiom.stb", "xiom.tensorflow", "xiom.test", "xiom.torch",
 "xiom.ui", "xiom.vma", "xiom.vulkan", "xiom.wasmtime", "xiom.websocket",
 "xiom.zeromq", "xiom.zstd"]
```

`xiom.ecosystem` is intentionally excluded (umbrella manifest). `xiom-hello`
at 0.1.0 is skipped by the workflow's version check until bumped.

**Packages scope list v3 (2026-09-23, follows the allowlist):** the packages
repo's `.github/publish-allowlist.txt` now carries 87 names (the earlier 52 +
the six stable packages + 29 newly allowlisted stable names). The registry
capability must cover all of them before any publish touching them, or a batch
`eco-v*` fails 403 on the unscoped names. The namespace audit is settled:
`xiom.durable` replaces `xiom.core` (durable is provisioned below; core stays
out), and `xiom.math`, `xiom.log`, `xiom.net`, `xiom.test` were removed from
the repo entirely, matching the exclusion. The 88 names (87 + xiom.durable):

```json
["xiom.algo", "xiom.arrow", "xiom.assimp", "xiom.blas", "xiom.box2d",
 "xiom.bson", "xiom.codec", "xiom.collation", "xiom.control", "xiom.csv",
 "xiom.cuda", "xiom.diff", "xiom.directx11", "xiom.directx12", "xiom.durable",
 "xiom.dxc", "xiom.eigen", "xiom.escape", "xiom.ffmpeg", "xiom.flags",
 "xiom.fuzz", "xiom.gazebo", "xiom.geo", "xiom.glfw", "xiom.graphql",
 "xiom.grpc", "xiom.hello", "xiom.http", "xiom.imgui", "xiom.jolt",
 "xiom.json", "xiom.kafka", "xiom.libpq", "xiom.lru", "xiom.lzfse",
 "xiom.markdown", "xiom.meshopt", "xiom.metrics", "xiom.micro",
 "xiom.miniaudio", "xiom.moveit", "xiom.msgpack", "xiom.onnx", "xiom.openblas",
 "xiom.opencv", "xiom.opengl", "xiom.openssl", "xiom.option", "xiom.ozz",
 "xiom.packet", "xiom.pandas", "xiom.patch", "xiom.phonon", "xiom.portaudio",
 "xiom.plural", "xiom.property", "xiom.protobuf", "xiom.raylib",
 "xiom.realtime", "xiom.rest", "xiom.retry", "xiom.sanitize", "xiom.scheduler",
 "xiom.scipy", "xiom.sdl3", "xiom.sensor", "xiom.sentiment", "xiom.spell",
 "xiom.stemming", "xiom.summary", "xiom.svg", "xiom.template",
 "xiom.tensorflow", "xiom.timeout", "xiom.timeseries", "xiom.tokenizer",
 "xiom.toml", "xiom.torch", "xiom.ttl", "xiom.typography", "xiom.ui",
 "xiom.vma", "xiom.vulkan", "xiom.wav", "xiom.websocket", "xiom.xml",
 "xiom.zeromq", "xiom.zstd"]
```

**Packages scope list v4 (2026-09-24):** the allowlist is now 130 names
(waves 10-15); v3 (88) plus these 43 additions is v4 (131 with `xiom.durable`
kept pre-provisioned). Ops must apply the delta to both trusted-publishers
files before the new names can publish (403 `publisher_not_authorized`
otherwise): staging first for the canary, then production with the
`eco-v0.1.1` batch. Wave 16 (tar, id3, cookie, rate, jwt, midi, properties,
fixed, pagination, ppm) is still running and will need another delta when
allowlisted.

```json
["xiom.alerting", "xiom.astronomy", "xiom.audit", "xiom.bmp", "xiom.chemistry",
 "xiom.dotenv", "xiom.electronics", "xiom.finance", "xiom.html", "xiom.humanize",
 "xiom.ini", "xiom.l10n.number", "xiom.lexing", "xiom.ngram", "xiom.optimizer",
 "xiom.password", "xiom.physics", "xiom.preprocess", "xiom.profiling", "xiom.query",
 "xiom.rbac", "xiom.refactor", "xiom.relativity", "xiom.report", "xiom.robotics",
 "xiom.secret", "xiom.selection", "xiom.semver", "xiom.signal", "xiom.snapshot",
 "xiom.spectroscopy", "xiom.subtitle", "xiom.tftp", "xiom.thermo", "xiom.tracing",
 "xiom.transaction", "xiom.translation", "xiom.transliteration", "xiom.tsv",
 "xiom.uuid", "xiom.validation", "xiom.wasm", "xiom.yaml"]
```

**v4 deployed on staging (2026-09-24, ops 9fd32a3):** 43 names added with no
removals or duplicates (`xiom.durable` already provisioned), installed config
reports 3 entries / 134 scopes (`stdlib-main-staging` 2, `registry-canary` 1,
`eco-canary` 131), recreate shows `publishers: 3 OIDC entries`, `/health` ok.
Production stays at 2 entries / eco 88 until the staging canary passes plus
the owner's greenlight, then ops deploys the same delta together with the
`eco-v0.1.1` batch. Wave 16 still needs its own delta once allowlisted.

**v5 delta (waves 16-17, 2026-09-24):** the allowlist is now 150 names; v4
(131) plus these 20 is v5 (151). Ops adds them to staging (eco-canary 131 ->
151, entries stay 3, total 154 scopes) before the wave 16/17 canaries;
production stays at 2 entries / eco 88 and must receive **both deltas**
(v4 43 + v5 20) in one go with the `eco-v0.1.1` batch: 88 -> 151, after the
staging canaries plus the owner's greenlight. (Ops handoff d44caf6 records
the staging commit; the recreate was pending at the time of writing.)

```json
["xiom.avi", "xiom.cookie", "xiom.envsubst", "xiom.fixed", "xiom.id3",
 "xiom.jwt", "xiom.midi", "xiom.mime", "xiom.ogg", "xiom.pagination",
 "xiom.particle", "xiom.ppm", "xiom.properties", "xiom.quantum", "xiom.rate",
 "xiom.rpc", "xiom.tar", "xiom.telnet", "xiom.useragent", "xiom.weather"]
```

Tag scheme (confirmed 2026-09-23): the packages workflow already supports
`eco-v*` (full allowlisted batch) and `xiom-<folder>/v<ver>` (exactly one
package; the tag version must equal the manifest version), plus a `guard` job
(`scripts/allowlist-guard.ps1`) that stops the allowlist from drifting ahead
of `STATUS.json` readiness (stage stable + recorded green suite). The packages
production entry refs are therefore
`["refs/tags/eco-v*", "refs/tags/xiom-*/v*"]`; the staging entry stays
`refs/heads/main` for the dispatch canaries. Readiness per package is set with
`scripts/status.ps1 -Action update` (`-Stage stable`, `-Publish`) and the name
must also be added to `.github/publish-allowlist.txt`; publishing itself is
never automatic (dispatch for staging, tag for production).

**Compiler/stdlib session:**

```
OIDC for xiom-lang/stdlib is locked: production refs refs/tags/stdlib-v*;
staging adds refs/heads/main for dispatch canaries; scopes
["xiom.std","xiom-std"]; firstParty true; audience xiom-registry. Migrate
.github/workflows/publish-registry.yml:
1. Add push: tags: ["stdlib-v*"] beside workflow_dispatch; keep the registry
   input for staging.
2. Job permissions contents: read + id-token: write; add
   environment: registry-publish (exists with required reviewer).
3. Mint the JWT in-job (curl -H "Authorization: bearer
   $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=xiom-registry",
   then ::add-mask::) and feed it to XIOM_REGISTRY_TOKEN; never echo it.
4. Do not create REGISTRY_PUBLISH_TOKEN; no client change.
5. Enable the disabled "release tags" ruleset (Settings -> Rules -> Rulesets
   -> release tags -> Active); the active protect-release-tags only blocks
   deletion/force-push, not tag creation.
6. Report the final workflow path, trigger refs, and the published package
   name (xiom.std vs xiom-std).
```

**Packages session:**

```
OIDC for xiom-packages/packages: production refs refs/tags/eco-v*, batch
publish, scopes enumerated (no blanket xiom), firstParty true, audience
xiom-registry. Add .github/workflows/publish-registry.yml:
1. on: push: tags ["eco-v*"] plus workflow_dispatch with inputs version and
   registry (default https://registry.xiom-lang.org).
2. contents: read + id-token: write; mint the JWT the same way as stdlib ->
   XIOM_REGISTRY_TOKEN. Publish every implemented package in one run; skip
   versions already published.
3. Report the exact list of xiom.* names the workflow publishes (top-level
   prefixes are enough; include xiom.core; never xiom.std).
4. Protection caveat: the repo is private on a Free org, so tag rulesets and
   environment required-reviewers are unavailable (API 403). Either make the
   repo public (recommended) or accept no GitHub-side gate -- until then the
   registry keeps its production entry disabled.
5. Staging canary: one package (xiom.core) against
   https://staging.registry.xiom-lang.org once the registry session confirms
   the staging config is deployed.
```

**Ops session:**

```
Re: docs/REGISTRY_OIDC_PREP.md (576ef6e). The compose change landed in the
registry repo (xiom-lang/registry): read-only mounts /etc/xiom-registry
(production) and /etc/xiom-registry/staging (staging), with container env
TRUSTED_PUBLISHERS_FILE=/etc/xiom-registry/trusted-publishers.json (prod) and
/etc/xiom-registry/staging/trusted-publishers.json (staging); host overrides
XIOM_TRUSTED_PUBLISHERS_DIR and XIOM_STAGING_TRUSTED_PUBLISHERS_DIR.
Loader contract confirmed: top-level array or {"publishers":[...]}; entry
{label, repository, workflow, refs, scopes, firstParty, events?}; workflow
matched as file name or .github/workflows/<file> against the file portion of
workflow_ref (job_workflow_ref ignored); refs glob over the ref claim;
missing/empty file -> no publishers (JWTs 403, static tokens fine); malformed
JSON -> process exits at startup, so validate with JSON.parse before deploy.
Correct the staging entry scope to ["xiom.std","xiom-std"] (not xiom.stdlib);
keep refs/heads/main; production starts as [].
```

**Website session:** provenance display ("Published by ...", run URL) comes
after the registry ships the `publisher` field in `/index.json` and the
package pages; no action yet.

---

## 13. UI roadmap (discuss later, owner idea 2026-09-23)

**Readme on the package page -- phases 1-4 DONE (2026-09-25).**
`GET /packages/:name/:version/readme` extracts `README.md` from the stored
tarball (existing tar reader generalized to `readTarMember`, any depth,
case-insensitive basename, 64 KB cap, `text/markdown`, immutable cache
header); the package page renders it through the escape-first markdown
renderer (`src/ui/markdown.js`: headings, paragraphs, lists and task lists,
fenced code, blockquotes, rules, GFM tables, emphasis, links and https
images) inside `<details>` with a raw-markdown link; publish warns when the
tarball has no README.md. The renderer escapes the source before any rule
runs, emits only its own allowlisted tags, and scheme-checks URLs
(http/https/mailto for links, https only for images); hostile-input tests
cover raw HTML, attribute injection, and unsafe schemes. A small bounded
in-process cache keyed by `name@version` avoids re-inflating on every page
view (versions are immutable).

**Listing at thousands of packages -- phases 1-4 DONE (2026-09-25).**
`/packages` (and the home list) accept `?page=` / `?per_page=` (default
1/50, page size capped at 200, out-of-range values clamp); the JSON response
carries `page`/`per_page`/`total`/`total_pages`. The full listing renders
compact rows (badge art, name, one-line description, latest, updated, size)
with pagination; home keeps the card treatment for a six-package "Recently
updated" strip plus a "Browse all N packages" link. Sorting is `updated`
(newest latest-publish first, the default) or `name` (A-Z), and the facets
`category`, `first_party`, and `signed` are shareable query params rendered
as chip toggles; sort and facets survive pagination links. Search treats `-`
and `.` as equivalent (`xiom-tar` finds `xiom.tar`) and ranks exact name,
name prefix, name substring, then description/keyword/category hits; the
HTML and JSON search paths share one matcher. `/index.json` stays whole for
the client protocol. Phase remaining: (5) index growth: a compact/gzipped
form eventually, not urgent at 35 packages.

---

## 14. Registry release notes (website contract, if we tag releases)

The website owns schema v1 (`xiom-lang/website`
`docs/release-notes-schema.md`). If the registry ever starts tagged
user-facing releases, publish `release.json` at
`https://registry.xiom-lang.org/releases/<tag>/release.json` (stable URL) and
tell the website lane; they render it wherever registry releases are linked.
Not scheduled -- the registry has no tagged release process or notes today.
Serving options when it happens: static files via nginx or a registry route.
Website optional ask (correlation): keep the published `xiom.std` metadata
carrying the toolchain tag it is pinned to. The registry already accepts and
preserves a `compiler` field on version entries (`src/app.js` publish
metadata), but the **client does not send it yet**: `xiom pkg publish` uploads
only `name`, `version`, `signature`, `publicKey` (verified in
`crates/xiom-pkg/src/main.rs`), so the compiler lane must add the field (e.g.
a manifest `compiler:` value or a `--compiler` flag) before the stdlib lane
can set it. `xiom-std@0.61.3` has no `compiler` value today. Package-level
metadata (description, license, categories, keywords, repository) is intact
on both instances; the version endpoint intentionally keeps only
version-scoped fields.

---

## 15. Accounts, review and sponsorship (direction, discuss later)

Ownership today: the registry has no accounts. A package is keyed by name;
who may publish a version is decided by the scopes on static tokens, and
first-party repos publish through OIDC trusted-publisher entries. For OIDC
publishes the repository/workflow/ref are verified claims; for static tokens
the manifest `repository` field is self-asserted. Co-maintainers share a
package by sharing scope coverage (operator-issued tokens); the durable
"ownership" model is graduation to a repo plus a per-repo OIDC entry, where
GitHub repo permissions define the team. Takeover is an operator token action
today, a repo move later.

Accounts phase (after the section 13/14 work), if we build it:
1. GitHub OAuth login, read-only: link an identity to maintainership for
   display (maintainer lists, claimed packages) -- no publishing powers.
2. Self-service requests with admin approval: request a token (replacing the
   issue-template + e-mail flow) or a trusted-publisher entry for a repo; an
   admin approves; every action is recorded. The trusted-publishers file
   becomes a store with an audit log. **Architecture (recommended):** the app
   only stores and shows requests (GitHub OAuth identity + requested
   names/scopes); the **minting stays on the host** via `issue-token.sh`,
   invoked by the admin against an approved request id. The web app never
   reads or writes the token store, never holds SMTP credentials, and never
   displays a token after delivery -- it only records fulfilment. Prefer the
   trusted-publisher request when the requester has a repo: it ships no
   secret at all. Artifact signing remains the publisher's own key; the
   VPS/registry never signs user packages.
3. Reviewer role and community moderation: report/abuse flow, a `verified`
   flag set by reviewers (pairs with the four status badges), and a public
   review history per package.
   **DONE (2026-09-25).** Reports: any signed-in account can report a package
   from its page (reason + note, capped per reporter/package); reviewers and
   admins (`REGISTRY_REVIEWER_LOGINS`, admins automatically) action reports
   in `/review` with a required resolution note. Decisions: reviewers mark a
   package `reviewed` (a distinct "reviewed" pill alongside the publisher
   claims) or `flagged` (with a required reason; the flagged art wins over
   every other state), or clear a decision; every action is appended to a
   public per-package review history shown on the package page, and the
   listing/home/search overlays `flagged`/`reviewed` at render time while
   `/index.json` stays raw. Records live in `reviews.json` on the data
   volume; `flagged` is reviewer/admin-only and never publisher-declared.
   **Ratings (social base) DONE (2026-09-26):** signed-in accounts leave one
   star rating (1-5) plus an optional 280-char review per package (upsert);
   the package page shows the average, count, and recent reviews, and
   ratings live with reports/decisions in `reviews.json`. See section 18.
4. Sponsorship and contributors: GitHub Sponsors status and publish-history
   contributors on package pages, opt-in; leaderboards only over reviewed
   packages so volume is not rewarded blindly.

Guardrails if we build it:
- A browser session is never a publish credential. Publishing stays OIDC
  (CI) or a scoped token; the UI only requests/rotates/revokes.
- Avoid platform-held signing keys for community packages: "signed by the
  platform" is a different trust claim. Platform keys only for clearly
  labeled bots/canaries, if ever.
- Roles: admin (token/publisher approval, yank), reviewer (verify/report),
  maintainer (claimed packages); every action audited.
- This is a real subsystem (auth service, persistence, RBAC, UI) -- schedule
  after the listing/readme roadmap, not before.

**Additive guarantee (agreed 2026-09-24):** the proven path stays exactly as
it is -- publishers sign with their own keys, OIDC/static-token publishing,
immutability, yank, and the trusted-publishers loader contract are untouched.
Phase 2 only adds a request/approval front door: requests are GitHub-OAuth
identified, the host mints and mails tokens, and **approving a
trusted-publisher request activates the entry immediately** (the app writes
it to `publishers.json` on the data volume with request provenance; the
read-only operator file stays the first-party channel). Existing publishers
see zero difference, and the manual issue-template/ops flow remains
available as the fallback for both request types. The GitHub token-request
template stays as the parallel, dev-signed path; the platform front door is
the community (social-style) path. A ready-to-copy OIDC workflow template is
served at `/ui/templates/community-publish.yml` and linked from the request
form and PUBLISHING.md.

**Status icon set v2 (owner, 2026-09-24 evening).** The owner replaced the
first four with a state x track matrix: 14 files, `pgk_<state>_<track>.webp`
with states unsigned, verified, deprecated, yanked, prerelease, incubator,
flagged and tracks official, community. Three names were normalized on
receipt (`pkg_unsigned_*` -> `pgk_unsigned_*`, `pgk_flagged_comm_community`
-> `pgk_flagged_community`). Live files: see `src/ui/assets`. Each is ~50-61
KB; a website-optimizer pass should still shrink them.

Semantics decided here: `verified_*` is the current signature state (publisher
signed the artifact) and is labelled "Signed by the publisher" in alt/title
until a reviewer-verified state exists (then it gets its own distinct mark);
`unsigned_*` is the neutral no-signature state; `flagged_*` is
operator/reviewer-set only (phase 3, never publisher-declared); `yanked_*` is
every version yanked; `prerelease_*` is a semver prerelease as the latest
version; `incubator_*` and `deprecated_*` come from a new manifest field
`stage: incubating|stable|deprecated` (registry-extracted from package.xi
like categories, so no client change; the packages workflow can write it from
STATUS.json so it cannot drift). The `staging` badge concept is dropped with
this set (the staging instance is test data; `pgk_staging_*` can be added
later if wanted).

`incubator` is **project maturity** (API may change, still being ported),
declared once per package; `prerelease` is a **version fact** (the resolved
latest is a semver pre-release like `1.0.0-rc.1`). They are orthogonal: an
incubating package can ship plain `0.x` versions, and a stable package can
ship a beta. Precedence puts incubator above prerelease, so an incubating
package with an rc latest shows the incubator art; the version string still
shows the rc and the versions table carries the per-version signature state.

Precedence (one badge per package, reorderable in one function):
flagged > yanked > deprecated > incubator > prerelease > signed(verified art)
> unsigned; the track suffix is chosen by first-party namespace for now
(optionally by recorded publisher firstParty later). Adding `stage` to the
manifest needs the packages lane; the rest is registry-side. The old
`official` / `community_trusted` / `staging` / `unsigned` text mapping is
replaced when this is wired.

Who can set which state (as built today):

| State | Set by | Mechanism |
|---|---|---|
| unsigned | publisher | publishing without a signature (untrusted token only) |
| verified + signed pill | publisher | signing the artifact with their ed25519 key |
| trusted | operator + publisher CI | operator-approved OIDC trusted-publisher entry; the publish comes from that repo/workflow/ref |
| incubator / deprecated | publisher | self-declared `stage:` in the manifest (first-party writes it from STATUS.json) |
| prerelease | publisher | choosing a semver pre-release version |
| yanked | publisher or operator | yank API with a token scoped to the name; the badge shows when every version is yanked |
| flagged | operator/reviewer only | not implemented until phase 3; users will never set it themselves |

Registry 2.0 (accounts) changes the interface, not the ownership: yank,
deprecate and trusted-publisher requests get UI buttons with roles and an
audit log; `flagged` stays reviewer/admin-only (users can report, not flag);
human review adds its own distinct mark alongside publisher signatures.

**GitHub OAuth app (prep, not built).** Phase 2 needs one OAuth App per
environment for sign-in only: org-owned preferred (xiom-lang org settings ->
Developer settings -> OAuth Apps). Production: homepage
`https://registry.xiom-lang.org`, callback
`https://registry.xiom-lang.org/auth/github/callback`. Staging: the same with
`staging.registry.xiom-lang.org`. Scope `read:user` (no repo access); the
client secret goes into the VPS env stack as `GITHUB_OAUTH_CLIENT_ID` /
`GITHUB_OAUTH_CLIENT_SECRET` (never in git). Separate staging and production
apps so secrets do not cross. Owner created both apps (2026-09-24):
production client ID `Ov23liu5xt4IZ3F8xLCM`, staging
`Ov23lifXHt8X3IDgdeZR`; secrets stay on the host, not in GitHub org secrets
(the registry is not a workflow consumer; the VPS env stack is the home, and
the secret is unused until phase 2 ships). Ops stored one client ID + one
non-empty secret per environment in `/opt/xiom/registry/.env` and
`.env.staging` (0600, in the restic source list, values never printed; an
earlier empty production secret was replaced), no recreate. **Callback check
complete (2026-09-24, ops): both apps correct** -- production
`https://registry.xiom-lang.org/auth/github/callback`, staging
`https://staging.registry.xiom-lang.org/auth/github/callback`; no secret
regeneration and no recreate were needed. Ops prerequisites for phase 2 are
done; the remaining ops step is the force-recreate of both services once the
registry code and compose passthrough land. Phase-2 implementation note from
the incident: the app must fail fast (refuse to start or log loudly) when
OAuth is configured with an empty secret, and the first deploy must exercise
a real login round-trip.

Badge matrix status (2026-09-24): wired to the 15-file state x track set,
including `trusted_community` for OIDC-published community packages (star +
`trusted`/`signed` pills) and the mirrored shield for publisher-signed
packages; `pgk_trusted_official` deliberately absent. The server now accepts
and persists a manifest `stage: incubating|stable|deprecated` (1db298d,
extracted like categories, unknown values warned), so the incubator and
deprecated badges light up as soon as the packages lane publishes the field.

---

## 16. Session handoff (2026-09-24, registry lane)

**Where things stand**

- OIDC trusted publishing is live and verified end to end: stdlib (production
  `xiom-std@0.61.3`) and the 34-package ecosystem batch (`eco-v0.1.0`) are on
  production with provenance, stable signing key `4f:3b:47:...`, and
  independent sha256/signature checks.
- Badge matrix v2 is shipped in `main` (15 files, `trusted_community` star,
  shield = publisher-signed with a `signed` pill, incubator/deprecated from the
  manifest `stage` field, prerelease from semver) but **not deployed**: both
  instances still serve the pre-badge image (evidence: `/packages` HTML has
  `badge official`, no `pkg-badge-group`/`pgk_`).
- Manifest `stage` support (1db298d) and the missing-categories publish
  warning (79b2526) are in `main`.
- Packages: allowlist 150 names. Staging has scope v4 live (eco-canary 131,
  3 entries / 134 scopes) and v5 (waves 16-17, 20 names) committed at ops
  `d44caf6` with the recreate pending. Production is 2 entries / **eco 88**
  and must receive both deltas (v4 43 + v5 20 = 63) with the `eco-v0.1.1`
  batch.
- OAuth (phase-2 prep): both apps created, callbacks verified, secrets stored
  in the VPS env files; ops prerequisites done. Phase 2 code not started.

**Deploy needed for the UI**

```
# staging (badges + v5 in one recreate)
cd /opt/xiom/registry && git pull
docker compose --env-file .env.staging --profile staging build staging
docker compose --env-file .env.staging --profile staging up -d --no-deps staging
# production, with the combined delta + batch (rebuild once)
docker compose build registry && docker compose up -d --no-deps registry
```

**Next actions, in order**

1. Owner: staging rebuild+recreate (badges + v5); then approve the wave 16/17
   canaries the packages lane dispatches.
2. Registry lane: verify the canary entries (provenance `refs/heads/main`,
   signature, incubator badge for an incubating package).
3. After canaries + owner greenlight: ops deploys the combined production
   delta (88 -> 151); owner cuts `eco-v0.1.1`; verify the production batch.
4. Then pick the next feature: **registry 2.0 phase 1-2** (OAuth login,
   request queue + admin approval, host-side minting stays in
   `issue-token.sh`, compose passthrough + fail-fast empty-OAuth check) or the
   **section 13 listing/readme roadmap** (pagination, compact rows, facets,
   readme from the tarball) -- the owner decides.

**Paste-ready prompt for the next session**

```
Registry lane continuation. Read SESSION.md sections 11-16 first; this is the
xiom-lang/registry repo on main with the OIDC work live and verified.

State in one line: first-party OIDC publishing works (stdlib + 34-package eco batch on
production); badge matrix + manifest stage support are shipped in main but NOT deployed
(both instances still serve the pre-badge image); staging has scope v4 live and v5 committed
at ops d44caf6 pending recreate; production is 2 entries / eco 88 and needs both deltas
(43+20=63) with the eco-v0.1.1 batch; allowlist is 150 names; OAuth phase-2 prep is done
(apps + secrets + callbacks) with no phase-2 code yet.

First actions:
1. Ask the owner to rebuild+recreate staging (gets the badges and v5 in one go) and confirm
   /packages HTML contains pkg-badge-group and pgk_ art.
2. When the packages session sends wave 16/17 canary run IDs, verify each staging entry:
   publisher repository xiom-packages/packages, workflow publish-registry.yml, ref
   refs/heads/main, run URL; signature/publicKey; and the badge state (incubator art for a
   stage: incubating package, verified+signed otherwise).
3. After the canaries and the owner's greenlight: ops deploys the combined production scope
   delta (eco 88 -> 151), the owner cuts eco-v0.1.1, and you verify the production batch the
   same way as eco-v0.1.0.
4. Then start registry 2.0 phase 1-2 (section 15): GitHub OAuth login (read:user), request
   queue + admin approval UI, host-side minting/mailing stays via issue-token.sh, compose
   passthrough for GITHUB_OAUTH_CLIENT_ID/SECRET with a fail-fast check on an empty secret.
   Do not touch the publishing path; it is proven.

Constraints: DCO-signed conventional commits, push to main; run npm test (139) and
npm run test:e2e (20) before claiming anything done; verify live instances with
Accept: text/html (JSON is the default negotiation).
```

---

## 17. Registry 2.0 phase 1-2 implemented (2026-09-25, registry lane)

**What shipped in `main`** (verified with `npm test` = 166 unit tests and
`npm run test:e2e` = 20 checks; publishing path untouched):

- **GitHub OAuth sign-in** (`src/oauth.js`, `src/sessions.js`,
  `src/accounts.js`): `read:user`, identity only. Single-use state,
  HMAC-signed HttpOnly session cookie whose key is derived from the OAuth
  client secret, per-session CSRF token, idle expiry. A browser session can
  never publish; sites/routes for publish are unchanged.
- **Self-service request queue** (`src/requests.js`): publish-token and
  trusted-publisher requests, GitHub-OAuth identified, validated with the
  same rules the loader uses (`*` never granted, at most 8 scopes, per-
  requester pending cap). Admin approval/denial/fulfilment in
  `/admin/requests`; every transition is appended to the request's audit
  history. The app never mints, never reads the token store, and holds no
  mail credentials: minting stays host-side (`issue-token.sh` wrapping
  `scripts/tokens.js`), and the admin records a fulfilment reference.
- **Fail-fast OAuth config** (the phase-2 incident guard): client id and
  secret must be set together; an id with an empty secret refuses to start.
  Admin role = `REGISTRY_ADMIN_LOGINS` (comma-separated logins,
  case-insensitive), recomputed per request; no role is persisted.
- **UI**: nav sign-in/account links, `/login`, `/account`, `/admin/requests`,
  CSRF on every POST, rate-limited; `accounts.json` and `requests.json` live
  in the registry data volume (restic scope); sessions are in-memory, so a
  restart signs everyone out.
- **Compose/env**: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
  `REGISTRY_ADMIN_LOGINS` pass through on both services; endpoint overrides
  (`GITHUB_OAUTH_*_URL`) exist for tests/mirrors only.
- **Badge art**: package status icons render at 64px (owner feedback;
  28 -> 36 -> 48 -> 64, test updated).

**Deploy**: the pending staging/production recreate now also activates
sign-in. No new secrets are needed if the env files still carry the stored
client id/secret pairs; after `git pull`, force-recreate both services and
exercise a real login round-trip (phase-2 prerequisite).

**Packages lane state (relay from packages/ops, 2026-09-25)**:

- Waves 10-15 canaries are complete: all 43 names verified on staging (a
  superset of the small-sample request); nothing left for v4.
- Wave 16/17 sample dispatches as soon as v5 is live: `xiom.tar`,
  `xiom.id3`, `xiom.jwt` (stable) plus `xiom.algo` as the incubating badge
  canary (`stage: incubating` written from STATUS.json; workflow support
  `bb7d18b`: dispatch-only, `allow_unready=true` + explicit target + staging
  URL, environment approval, tags/batches refused).
- Wave 18 (base58, cidr, crc, macaddr, obj, querystring, roman, stl, uri,
  varint) landed after v5: allowlist is now **160 names**; v6 will be
  prepared separately after wave 16/17 (expected 151 -> 161).
- `eco-v0.1.1` = the combined 63-name delta (v4 43 + v5 20), one tag, one
  approval; production 88 -> 151.

**Live status (2026-09-25, after the ops report and an external check)**:
staging is v5 live (3 OIDC entries, 154 scopes, eco-canary 151) and the
recreate carries the badge matrix with 36px art at check time (83
`pkg-badge-group`; the art is now 48px in `main`, pending the next
recreate). **Wave 16/17 canaries verified (2026-09-25)**: `xiom.tar`,
`xiom.id3`, `xiom.jwt`, `xiom.algo` are on staging with publisher
`xiom-packages/packages`, workflow `publish-registry.yml`, ref
`refs/heads/main`, `workflow_dispatch` events and run URLs; independently
re-hashed tarballs match their index sha256 and the ed25519 signatures
verify over the exact bytes; `xiom.algo` carries `stage: incubating` and
serves `pgk_incubator_official.webp`, the others `pgk_verified_official`
with the signed pill. Server-side sign-in is verified from outside:
`/login` renders the button, `/auth/github/start` 302s to GitHub with the
staging client id and callback (GitHub accepts the app and shows its normal
sign-in), and the callback refuses a bad state with 403. **The owner
completed a real login round trip on staging (2026-09-25)**; the earlier
"sign-in does nothing" report was the nav self-link on the login page
(clicking it re-rendered `/login`), fixed in the UI/UX pass: no account
self-link on `/login`, `aria-current` on the active account/admin page,
GitHub avatar on the account page, publisher fields grouped in their own
fieldset, per-request audit history visible to both the requester and the
admin, denials require a reason and fulfilment a reference (server-side,
with the admin kept on the queue), one `:focus-visible` treatment for
links/buttons/inputs, and the account nav stays in flow on mobile.
Production `/login` is still 404 until the production recreate is
greenlit (test staging only). The wave 16/17 dispatch is not blocked by
sign-in: OIDC publishing never uses browser sessions.

**Ordered next actions**:

1. ~~Owner: staging rebuild + recreate (badges + v5 + OAuth)~~ DONE
   2026-09-25 (badges verified; owner logged in on staging).
2. ~~Packages: dispatch the wave 16/17 sample~~ DONE; all four canary
   entries verified 2026-09-25 (see live status). Readme phases 1/2/4 also
   shipped (`ea8cd85`); the badge art is 48px in `main` pending the next
   recreate.
3. Production delta waits only on the owner greenlight: ops deploys the
   combined delta (88 -> 151) + `eco-v0.1.1`, then the batch is verified as
   `eco-v0.1.0`.
4. Next registry work: the community smoke-test repo
   (`LefterisNotas/test_registry_smoke`, package `test-registry-smoke`)
   exercises both trust paths once staging is recreated: trusted-publisher
   request from the website (now active on one admin click, no host editing)
   -> OIDC publish (trusted art + signed pill), then a token request ->
   host-minted token -> dev-signed publish (verified art + signed pill), then
   yank. Section 18 is the social-layer base to expand from.

---

## 18. Social layer foundations (owner direction, 2026-09-26)

**Vision:** the registry as a community surface -- developer profiles and
activity, reviews and ratings, notifications that reach people, top
contributors with their GitHub Sponsors badges, and engagement loops --
without weakening the publishing guarantees.

**Built now (first slice):** star ratings and short reviews.
- One rating per GitHub account per package (upsert), 1-5 stars, optional
  280-char review; stored in `reviews.json` under `ratings`, allowlist-
  normalized on load.
- The package page shows the average, the count, and recent reviews with
  @logins; signed-in accounts get the form, anonymous readers see it
  read-only.
- The same moderation surfaces apply: reports feed the reviewer queue and
  reviewer decisions override display.

**Recorded decisions for the expansion (implement in this order):**

1. **Notification outbox + email.** Accounts gain an optional `notifyEmail`
   (profile/request field) and later the `user:email` scope for a verified
   address. A `notifications` outbox records events (request approved /
   fulfilled, review decision, ratings, token rotation); the app renders
   in-app notices immediately and a pluggable sender (`SMTP_URL`,
   `SMTP_FROM`) delivers email. Token *credentials* still never flow through
   the app: delivery stays host-side.
2. **SQLite as the primary store** when profiles/feeds land. Introduce a
   `src/data/` repository layer behind the existing store interfaces and
   migrate one store at a time (ratings/reviews first, they grow fastest);
   `/index.json` and the publish protocol stay untouched. Node base moves to
   24 LTS for `node:sqlite` (Dockerfile + CI in the same change), unless the
   image stays on 22 and `better-sqlite3` is chosen.
3. **Profiles and contributors.** Package pages gain a contributors list
   (publishers from provenance, reviewers, raters) and a GitHub Sponsors
   badge from the public API (cached, opt-in). A "top contributors" board
   ranks over audit events (publishes, reviews, ratings) with anti-abuse
   caps -- never raw volume.
4. **Feeds and following** (activity per developer/repo, follow packages)
   once 1-3 are stable.

**Guardrails:** every UGC surface feeds the report -> reviewer flow;
`flagged` overrides display; no platform signing keys for community
packages; browser sessions stay identity-only and never publish.