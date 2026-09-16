# XIOM Registry -- Session Handoff & Spec

**Read this first** if you are a human or agent working in
`github.com/xiom-lang/registry` (pre-split path: `registry/` in the AXIOM
monorepo). Strategy lives in `docs/RELEASE_INFRA_PLAN.md` sections R4/R5;
this file is the normative working spec for the service itself.

**Status:** server skeleton exists and is deployable, but it does NOT yet
speak the protocol the `xiom pkg` client implements. Nothing is deployed to
production yet. The beta scope is: protocol compliance + token auth +
signature storage + version immutability + an end-to-end test that drives
the real client. Everything else is post-beta.

---

## 1. What this service is

The XIOM package registry - the crates.io analogue for XIOM. It is a
server application, not static hosting:

- HTTP API for index discovery, artifact download, publish, yank, search.
- Persistence: JSON index + tarball storage (Docker volumes at beta).
- Authentication: Bearer tokens for publish (GitHub OIDC in phase 2).
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
`crates/xiom-pkg/src/main.rs` (they were NOT moved; the compiler repo owns
them after the split). Read them before changing server behavior.

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

### 2.2 Index schema the client accepts

```json
{
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

- `versions` may also be a plain array of version strings (legacy), but the
  server MUST always emit the object form: `sha256` is mandatory for install
  (clients refuse unhashed versions unless `XIOM_PKG_ALLOW_UNHASHED=1`).
- `sha256` is lowercase hex of the exact tarball bytes.
- `signature`/`publicKey`: optional in the schema, but a client with a
  pinned key for this registry (see `xiom pkg trust`) REFUSES unsigned or
  mis-signed artifacts. When present, the signature is ed25519 over the
  exact tarball bytes.

### 2.3 Version metadata the server must store per publish

`version`, `sha256`, `signature`, `publicKey`, `size`, `published`,
`dependencies`, and (recommended) `compiler` compatibility range.

### 2.4 Current mismatches (the work to close)

| Item | Client expects | Server today | Fix |
|---|---|---|---|
| Download path | `/packages/{name}/{version}/package.tar.gz` | `/packages/:name/:version/download` | add the client path (keep the old as alias) |
| Publish auth | `Authorization: Bearer <token>` | `x-api-key` header only | accept both; prefer Bearer; per-publisher tokens |
| Signature fields | `signature` + `publicKey` stored per version | ignored | parse multipart fields, verify when policy says so, store them |
| Immutability | locked installs depend on digests | republish overwrites version | reject duplicate version with 409; add yank |
| Reserved names | first-party `xiom.*` namespace | none | token scopes: `xiom.*` publishable only by first-party tokens |
| `/index.json` fields | `size`, `published`, `dependencies` tolerated | sha256/size only | store and emit all fields |

### 2.5 Error semantics

- `400` malformed body / invalid name or semver.
- `401` missing or unknown token.
- `403` token not allowed to publish the requested namespace.
- `404` unknown package/version/artifact.
- `409` version already exists (immutable; yank instead).
- `413` tarball over the size cap (50 MiB at beta).
- `422` signature invalid when verification is required.

---

## 3. Work breakdown (in order)

- [ ] T1. Add the client download route + keep `/download` alias.
- [ ] T2. Bearer auth with per-token scopes; keep `x-api-key` for backward
      compatibility only if it costs nothing.
- [ ] T3. Store `signature`, `publicKey`, `size`, `published`,
      `dependencies` in the index; emit them on `/index.json`.
- [ ] T4. Server-side signature verification on publish for tokens marked
      `trusted: true` (config file or env); reject mismatches with 422.
- [ ] T5. Immutability (409 on republish) + `POST /packages/:name/:version/yank`
      (marks `yanked: true`; artifact stays for lockfile integrity;
      installs of a pinned yanked version still work).
- [ ] T6. Reserved namespace policy (`xiom.*` first-party only) + name
      validation (reject reserved Windows names, leading dots).
- [ ] T7. Limits: 50 MiB cap, rate limiting, bounds on index growth.
- [ ] T8. End-to-end test (section 5) wired into CI.
- [ ] T9. Staging deploy at `staging.registry.xiom-lang.org`; run the e2e
      against it; then promote to `registry.xiom-lang.org`.
- [ ] T10. Convert this file into `README.md` + `SPEC.md` + `DEPLOY.md`
      once the service is stable (keep this file as SESSION handoff).

---

## 4. Architecture and operations

- Node.js >= 18, Express + multer + semver (see package.json).
- Storage at beta: `data/index.json` plus
  `packages/<name>/<version>/package.tar.gz`, both on Docker named volumes.
- Env: `PORT` (3000), `DATA_DIR`, `PACKAGES_DIR`, `NODE_ENV`.
  Legacy `API_KEY` exists; the real model is a tokens file with scopes
  (introduce `TOKENS_FILE` when T2 lands).
- Container hardening: non-root user, `no-new-privileges`, read-only root
  filesystem with writable volumes, bind `127.0.0.1:3000` only.
- Reverse proxy: Hestia nginx vhost for `registry.xiom-lang.org` ->
  `http://127.0.0.1:3000`, Let's Encrypt TLS, force HTTPS.
- Backups: nightly restic of the two volumes off-site; documented restore
  drill. See `docs/RELEASE_INFRA_PLAN.md` R4 for the full VPS runbook.
- Not exposed: Portainer itself stays off the public internet (SSH tunnel
  or IP allowlist).

---

## 5. Test plan

Unit tests for index read/write, name validation, auth. The gate that
matters is end-to-end against the REAL client:

1. Build a fixture package directory with a `package.xi`.
2. Generate a test keypair: `xiom pkg keygen` (writes
   `~/.xiom/keys/default.key`); publish the public key into the server's
   trusted-token config.
3. Run the server locally (`npm start`, `XIOM_REGISTRY=http://localhost:3000`
   plus `XIOM_PKG_ALLOW_HTTP=1` and `XIOM_REGISTRY_TOKEN=<test-token>`).
4. `xiom pkg publish` the fixture; assert 201 and index fields.
5. In a clean directory: `xiom pkg install <fixture>` (checksum verified),
   then `xiom pkg lock` and confirm the digest is pinned.
6. Negative cases: republish -> 409; bad token -> 401; tampered tarball ->
   checksum mismatch; unsigned artifact against a trusted registry ->
   refused; yanked version -> pinned install still works, fresh resolve
   reports yanked.
7. Pin the key (`xiom pkg trust --registry ... --key <hex>`) and repeat
   install; assert signature verification is enforced.

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
protocol implemented by crates/xiom-pkg in the xiom repo: GET /index.json,
GET /packages/{name}/{version}/package.tar.gz, POST /publish with Bearer
auth and signature/publicKey multipart fields. The work queue is section 3
of SESSION.md (T1-T10), in order. Follow the repository rules: conventional
commits, tests for every behavior change, never weaken signature or
checksum checks. Verify with the end-to-end test described in section 5
against the real client before claiming any task done. Deployment is
staging-first; production is behind a required-reviewer environment.
```

---

## 9. Related documents

- `docs/RELEASE_INFRA_PLAN.md` (monorepo until split): R3 release
  pipeline, R4 VPS runbook, R5 registry hardening.
- `docs/REPO_MIGRATION_RUNBOOK.md` (monorepo until split): how this repo
  was carved, CI wiring after the split.
- Client: `crates/xiom-pkg/src/registry.rs`, `crates/xiom-pkg/src/main.rs`,
  `crates/xiom-pkg/src/signing.rs`, `crates/xiom-pkg/src/lockfile.rs`.
