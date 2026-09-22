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
independently from the staging URL. Production remains `[]`. Remaining: the
packages canary, then production entries with the owner's OK. Section 11 is
the spec, section 12 the lane handoffs.

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
      (1539x510) is served at `/ui/registry.webp` and the banner is the
      registry masthead -- the wordmark is the home link and the global
      package search lives inside it (query preserved on `/search`), so the
      sticky bar is navigation only and "XIOM Registry" never repeats; the
      home hero keeps one visible `h1` (Packages). CSS lifted from
      `xiom-website/style.css` plus banner-search additions and a 640px
      cover-crop so the artwork keeps its negative space; `aria-hidden` moved
      from the banner to the decorative wordmark spans since the banner now
      contains the search form. Source/refresh notes in
      `src/ui/assets/SOURCES.md` (`logo.png` retired with the old header
      brand); the UI test pins the markup, the single search form and the
      served bytes.
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