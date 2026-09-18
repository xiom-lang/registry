<!-- Copyright (c) 2026 Eleftherios Notas and XIOM Foundation -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# XIOM Registry -- Session Handoff & Spec

**Read this first** if you are a human or agent working in
`github.com/xiom-lang/registry` (pre-split path: `registry/` in the AXIOM
monorepo). Strategy lives in `docs/RELEASE_INFRA_PLAN.md` sections R4/R5;
this file is the normative working spec for the service itself.

**Status:** the server speaks the full `xiom pkg` protocol and passes a
20-check end-to-end gate that drives the real client (`npm run test:e2e`),
plus 71 unit tests (`npm test`). **Deployed and verified:**
`https://registry.xiom-lang.org` (port 3100) and
`https://staging.registry.xiom-lang.org` (isolated instance on port 3200,
own volumes and tokens). Both advertise their own `registry` URL; the
scheduled live check (`.github/workflows/live-check.yml`,
`npm run live-check`) verifies health and artifact digests and asserts the
two indexes stay separate.

**Remaining:**

1. **Live publish/install against staging** -- DONE (2026-09-18):
   `scripts/staging-acceptance.js` published `xiom.staging-isolation-probe`
   to staging through the real client, verified the index metadata (digest,
   signature, advertised registry URL), installed it back with checksum
   verification, confirmed production's index never listed it, and yanked
   the probe. The staging token used for the run has been rotated by the
   owner. T9 and the beta gate are complete.
2. **Operational hygiene** -- nightly restic backups of the volumes are not
   automated yet (R4 in `RELEASE_INFRA_PLAN.md`), as are the uptime monitor
   and the release -> registry deploy hook; log rotation is already handled
   by the compose logging config.
3. **Dependency maintenance** -- DONE: all three dependabot PRs are closed
   (multer and tar were already current; the qs/express PR was superseded by
   the tree-wide `qs 6.16.0` override on main, `npm audit` reports 0).
4. **Probe residue** -- DONE: `xiom.staging-e2e-probe`@0.0.2 was yanked on
   production (2026-09-18); both versions are now yanked and `latest` is
   empty, so nothing installable remains. The metadata entry is left as an
   audit trail; removing it entirely needs a VPS index edit, not HTTP.
5. **Commit identity** -- DONE for this repo (owner-authorized rewrite,
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
6. **Compiler packaging** -- DONE (compiler session, CRB-3): release
   archives now build and stage both `xiom` and `xiom-pkg` with a
   `--version` assertion before archiving, and the installer wrapper
   dispatches `xiom pkg`; release users can publish/install from the next
   tag (v0.61.0). Verified in `release.yml` (xiom repo) on 2026-09-18.
7. **Website coordination** -- nothing is needed from registry for the
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
`description` is likewise extracted from the manifest.

### 2.4 Reconciled mismatches (T1-T7, all done)

| Item | Client expects | Server behavior now |
|---|---|---|
| Download path | `/packages/{name}/{version}/package.tar.gz` | client path served; `/download` suffix kept as alias |
| Publish auth | `Authorization: Bearer <token>` | Bearer preferred; `x-api-key` and GET `api_key` accepted for legacy compatibility |
| Signature fields | `signature` + `publicKey` per version | parsed, format-validated, stored, emitted; verified on publish for `trusted` tokens |
| Immutability | locked installs depend on digests | duplicate version -> 409; `POST /packages/:name/:version/yank` |
| Reserved names | first-party `xiom.*` namespace | `firstParty` token flag required for `xiom.*`; strict name validation |
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
- [x] T6. Reserved namespace policy (`xiom.*` first-party only) + name
      validation (lowercase DNS-ish grammar, Windows reserved segments).
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
  - `src/config.js`, `src/errors.js`.
  - `scripts/keygen.js` -- publish-token generator (`--replace` rotates).
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
- `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE` -- dual MIT OR Apache-2.0;
  Copyright (c) 2026 Eleftherios Notas and XIOM Foundation.
- `docs/RELEASE_INFRA_PLAN.md` (monorepo until split): R3 release
  pipeline, R4 VPS runbook, R5 registry hardening.
- `docs/REPO_MIGRATION_RUNBOOK.md` (monorepo until split): how this repo
  was carved, CI wiring after the split.
- Client: `crates/xiom-pkg/src/registry.rs`, `crates/xiom-pkg/src/main.rs`,
  `crates/xiom-pkg/src/signing.rs`, `crates/xiom-pkg/src/lockfile.rs`.
