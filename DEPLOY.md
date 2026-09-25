# Registry -- Deployment Guide

Read this before touching deployment. The service code and protocol live in
`SESSION.md`; this file covers how the running instance is hosted.

## Where it runs

- Host: Contabo VPS (Ubuntu 24.04), HestiaCP 1.10.5, Docker 28.x.
- Clone: `/opt/xiom/registry` (public repo, anonymous clone).
- Container: `xiom-registry` from `docker-compose.yml`, bound to
  `127.0.0.1:${XIOM_REGISTRY_PORT}` -> container `3000`.
- Production URL: `https://registry.xiom-lang.org` (port 3100).
- Staging URL: `https://staging.registry.xiom-lang.org` -- **currently the
  same container and data as production**. A genuinely separate staging
  instance is prepared in `docker-compose.yml` under the `staging` profile
  (port 3200, own volumes, own tokens, own `REGISTRY_URL`); see "Staging
  isolation" below for the one-time host steps.
- Ports: Gitea already owns 3000 on this host, so production uses
  `XIOM_REGISTRY_PORT=3100`; the staging profile uses 3200.

## Host files

| Path | Purpose |
|---|---|
| `/opt/xiom/registry/.env` | `REGISTRY_URL`, `TRUST_PROXY=1`, `XIOM_REGISTRY_PORT=3100` |
| `/opt/xiom/registry/.env.staging` | staging port, tokens path, staging `REGISTRY_URL` (copy of `.env.staging.example`) |
| `/opt/xiom/registry/tokens.json` | production publish tokens (mounted read-only; never commit) |
| `/opt/xiom/registry/tokens.staging.json` | staging publish tokens (separate file) |
| `/etc/xiom-registry/trusted-publishers.json` | production OIDC publishers (mounted read-only at the same path; `TRUSTED_PUBLISHERS_FILE`) |
| `/etc/xiom-registry/staging/trusted-publishers.json` | staging OIDC publishers (own file; production entries are not visible inside the staging container) |
| volumes `registry_registry_data` / `registry_registry_packages` | production index + artifacts |
| volumes `registry_staging_data` / `registry_staging_packages` | staging index + artifacts |

## Staging isolation

The staging container (`xiom-registry-staging`, profile `staging`) runs on
`127.0.0.1:3200` with its own volumes. Production keeps running on 3100.

One-time host steps:

```
cd /opt/xiom/registry
git pull
cp .env.staging.example .env.staging          # then edit if needed
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/keygen.js --label staging --scopes "*" --trusted --first-party \
  --out tokens.staging.json
# The file is bind-mounted into the container and read by the unprivileged
# `node` user (UID 1000): root-owned 0600 crash-loops with EACCES. Fix both
# token files the same way.
chown 1000:1000 tokens.json tokens.staging.json
chmod 600 tokens.json tokens.staging.json

# Build ONLY the staging image and start ONLY the staging service, so the
# shared xiom-registry:latest rebuild never restarts production.
docker compose --env-file .env.staging --profile staging build staging
docker compose --env-file .env.staging --profile staging up -d --no-deps staging
docker compose ps                              # staging on 3200, production untouched
curl -s http://127.0.0.1:3200/health           # staging is up
curl -s http://127.0.0.1:3100/health           # production still up
```

Why `--env-file .env.staging`: compose only auto-reads `.env`; without the
flag every `XIOM_STAGING_*` edit in `.env.staging` is silently ignored (the
built-in defaults happen to match today, which makes the bug invisible).

Why `--no-deps` and a named service: `--build` rebuilds the shared
`xiom-registry:latest` image, and a plain `up -d` would recreate
production from it. Building and starting only `staging` leaves production
untouched.

**Then repoint the staging vhost** -- until this is done, both hostnames
still serve the production instance:

```
# /usr/local/hestia/data/templates/web/nginx/php-fpm/xiom-registry*.tpl|stpl
# proxy_pass http://127.0.0.1:3100 -> http://127.0.0.1:3200 for the STAGING
# domain only (keep the production domain on 3100; two template variants or
# a per-domain copy)
v-rebuild-web-domain lefteris staging.registry.xiom-lang.org
nginx -t && systemctl reload nginx
```

Verify isolation and — this matters — that staging advertises itself:

```
curl -s https://staging.registry.xiom-lang.org/health     # uptime differs from prod
curl -s https://staging.registry.xiom-lang.org/index.json # "registry": staging URL
curl -s https://registry.xiom-lang.org/index.json         # production, unchanged
```

The staging index must say
`"registry": "https://staging.registry.xiom-lang.org"`. If it says the
production URL, the container started without `XIOM_STAGING_REGISTRY_URL`
(compose defaults to the right value; check `.env.staging` and
`docker inspect xiom-registry-staging`). A wrong value matters: clients pin
trust keys **per registry URL**, and the field is also what `xiom pkg
trust` records.

Once isolated, `npm run test:e2e` can be pointed at staging without
polluting production data. The harness starts its own local server; a live
publish/install check is:

```
$env:XIOM_REGISTRY = "https://staging.registry.xiom-lang.org"
$env:XIOM_REGISTRY_TOKEN = "<a staging token>"
xiom-pkg publish         # from a fixture package directory
xiom-pkg install <name>@<version>
```

Note: the e2e probe package (`xiom.staging-e2e-probe`) lives only in the
old shared volumes; the staging volumes are fresh, and production's copy is
harmless (signed, one version yanked).

## OIDC trusted publishers

GitHub Actions publishers are configured by a JSON file per instance, not by
registry tokens. `docker-compose.yml` mounts the directories read-only and
sets `TRUSTED_PUBLISHERS_FILE`:

- production: `/etc/xiom-registry/trusted-publishers.json`
- staging: `/etc/xiom-registry/staging/trusted-publishers.json`

The file is an array (or `{"publishers": [...]}`) of entries:

```json
[
  {
    "label": "stdlib-release",
    "repository": "xiom-lang/stdlib",
    "workflow": "publish-registry.yml",
    "refs": ["refs/tags/stdlib-v*"],
    "scopes": ["xiom.std", "xiom-std"],
    "firstParty": true
  }
]
```

Operational rules:

- Missing or empty file = no OIDC publishers: GitHub tokens get 403 while
  static tokens keep working. Production starts as `[]` and only gains
  entries after the staging canary and the owner's OK.
- Malformed JSON or an invalid entry makes the process exit at startup, so
  validate before restarting: `node -e "JSON.parse(require('fs').readFileSync('/etc/xiom-registry/trusted-publishers.json','utf8'))"`
- After editing: `docker compose up -d --no-deps registry` (or the staging
  equivalent); a recreate is enough, no image rebuild.
- The registry needs outbound HTTPS to
  `token.actions.githubusercontent.com` for JWKS, and a correct clock (JWT
  expiry is checked with 60 s skew).
- Audience is pinned to `xiom-registry` (`OIDC_AUDIENCE` overrides it, but
  every publisher workflow must be changed to match).

The full claim contract, staging/production entries and lane handoffs live in
`SESSION.md` sections 11-12.

## GitHub sign-in and request queue (registry 2.0)

Sign-in links a GitHub identity to self-service requests and the approval
queue; it is display/audit data only and can never publish. Configuration
lives in the env files (`docker-compose.yml` passes it through on both
services):

- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`: one OAuth App per
  environment, callback `<REGISTRY_URL>/auth/github/callback`, scope
  `read:user` (no repo access). Set both or neither: an id with an empty
  secret refuses to start, so a half-passed pair cannot silently break the
  login.
- `REGISTRY_ADMIN_LOGINS`: comma-separated GitHub logins (case-insensitive)
  that may decide and fulfil requests. Empty means nobody can approve.
- `REGISTRY_REVIEWER_LOGINS`: comma-separated GitHub logins that may action
  community reports (`/review`); admins are reviewers automatically.

Data: `accounts.json` (identities), `requests.json` (token/publisher queue),
`reviews.json` (community reports, resolution notes, reviewer decisions, and
star ratings with short reviews), and `publishers.json` (approved
trusted-publisher entries) live in the `registry_data` / `staging_data`
volume and are in the restic source list.
Sessions are in-memory: a restart signs everyone out. The first deploy must
exercise a real login round-trip (phase-2 prerequisite from the incident
review).

Approving requests in `/admin/requests`:

- **Trusted publisher:** one click. The app writes the entry to
  `publishers.json` on the data volume and activates it immediately — no host
  editing, no restart; the queue then shows it as live, with a **Revoke**
  button. The read-only `/etc/xiom-registry/trusted-publishers.json` stays
  the operator channel for first-party grants.
- **Token:** approving shows the exact host mint command in the UI. Run it,
  deliver the token privately from `registry@xiom-lang.org`, then click
  **Mark fulfilled** with a reference (label + mail date). The app never
  mints, never reads the token store, and holds no mail credentials.

Data files in the volume (restic source list): `index.json`,
`accounts.json`, `requests.json`, `reviews.json`, and `publishers.json`
(approved trusted-publisher entries with request provenance). Recreate the
service only after editing the operator file or the token store.

## Hestia reverse proxy

This host runs nginx-only (`PROXY_SYSTEM` is not enabled), so custom web
templates live in `/usr/local/hestia/data/templates/web/nginx/php-fpm/`.
The `xiom-registry` template pair (`.tpl` for HTTP redirect, `.stpl` for
TLS + proxy) forwards to `http://127.0.0.1:3100` and is applied to both the
staging and production domains:

```
v-change-web-domain-tpl lefteris <domain> xiom-registry
v-rebuild-web-domain lefteris <domain>
nginx -t
```

Do not use `v-add-web-domain-proxy` on this host; it fails with
`PROXY_SYSTEM is not enabled`.

## Deploy / update

```
cd /opt/xiom/registry
git pull
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:3100/health
```

## Tokens

Generate or append a publish token (never commit the file):

```
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/keygen.js --label <label> --scopes "*" --trusted --first-party --out tokens.json
# keygen appends: do not re-run it for the same label unless you revoked the
# old entry first, or use --replace for a single-token file.
chown 1000:1000 tokens.json && chmod 600 tokens.json
# The container reads the token file at startup only; force a recreate so the
# new entry is loaded (a plain `up -d` is a no-op for bind-mount changes).
docker compose up -d --force-recreate --no-deps registry
docker logs --tail 6 xiom-registry      # expect: tokens: N configured
```

For day-to-day token management prefer the admin CLI -- one line per
operation, no hand-edited JSON and no heredocs that garble in a terminal
paste. `rotate` replaces every entry for a label with one fresh token in a
single atomic write; `list` never prints values:

```
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js list --file tokens.json
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js rotate --file tokens.json --label <label> --scopes "<scopes>" [--trusted] [--first-party]
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js remove --file tokens.json --label <label>
```

Worked examples (label = who, scopes = what they may publish):

```
# user1 may publish my-lib and my-lib.* names
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js add --file tokens.json --label user1 --scopes "my-lib"

# user1 gave a signing public key: signatures mandatory and pinned to that key
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js add --file tokens.json --label user1 --scopes "my-lib" --trusted --key <64-hex>

# break-glass first-party token for org CI only -- prefer OIDC instead
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js add --file tokens.json --label xiom-release --scopes "xiom" --trusted --first-party

# rotate: one fresh token replaces every entry with that label (atomic write)
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js rotate --file tokens.json --label user1 --scopes "my-lib"

# revoke: remove every entry with that label (future publishes only)
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/tokens.js remove --file tokens.json --label user1
```

After add/rotate/remove: `chown 1000:1000 tokens.json`, `chmod 600`, recreate
the container (`up -d --force-recreate --no-deps registry`) and confirm
`tokens: N configured`. The printed value is the only time the token becomes
visible; deliver it by e-mail from `registry@xiom-lang.org` to the address in
the request (or a private channel if none was given), never in the issue.
When approving the request, post this note in the issue:

> The token is sent by e-mail from registry@xiom-lang.org. On first contact it
> may land in your spam folder -- check there and mark it as not spam.

Static tokens do not expire, so revocation is manual.

Community token flow (operator checklist, 2026-09-21):

1. Request arrives via the token-request issue template. Validate: exact
   package names -> scopes (no `*`, no first-party), repository/handle,
   whether artifacts are signed (this decides `--trusted`), and that the
   requester accepts yank-only immutability plus the 90-day rotation policy.
   No private e-mail address in the request -> create nothing; ask in the
   issue for one.
2. Mint and deliver in one step (installed on the VPS at
   `/opt/xiom/bin/issue-token.sh`; source lives in the private ops repo):

   ```
   /opt/xiom/bin/issue-token.sh --issue <issue-url> --label alice \
     --email <member-address> --scopes "alice-lib" [--trusted]
   ```

   The script refuses duplicate labels (use `--rotate`), refuses without an
   address, mails the value plain-text from registry@xiom-lang.org, prints
   only a summary (label, scopes, flags, sha256 prefix, issue URL), appends
   the issuance-log line, recreates the container and prints
   `tokens: N configured`.
3. Post the after-approval note in the issue, then close it.
4. Lifecycle: static tokens, no expiry. Rotate every 90 days with `--rotate`
   and tell the holder to replace `XIOM_REGISTRY_TOKEN`; revoke with
   `--revoke`; prove liveness with `--verify` (404 `version_not_found` means
   the token authenticates, 401 means revoked or not loaded).
5. CI publishing uses OIDC instead (see "OIDC trusted publishers"); the
   production entries wait for the stdlib/packages canaries after v0.61.0.
6. Spam placement is a reputation artifact, not a failure: MX, SPF, DKIM and
   PTR are live, but Gmail/Outlook may need one "not spam" mark on first
   contact -- which is why the request template and the delivery mail both
   carry the note.

Semantics worth knowing before answering a publisher:

- Token rotation (`tokens.js rotate`) and the publisher's signing-key
  rotation (`xiom pkg keygen`) are independent. The registry stores
  signature + public key per version and does not pin a publisher key to the
  token, so a publisher can use a fresh signing key for every version;
  rotating either one never invalidates already-published versions.
- `--trusted` decision: use it when the requester supplied a signing public
  key and their release process signs every publish. Without a key in the
  request, issue a plain token -- `--trusted` would reject their unsigned
  publishes (422), and there would be no key to pin.
- `--key <hex>` pins the trusted token to that signing key: publishes whose
  submitted key differs get `422 public_key_mismatch`, so a stolen token
  alone cannot publish under another key. When the requester rotates their
  signing key, they send the new public key and the operator runs
  `rotate --file tokens.json --label user1 --scopes "my-lib" --trusted
  --key <new-hex>`; the old key stops working immediately.
  64-hex strings can be pasted with or without colons or spaces -- `--key`
  normalizes both (the fingerprint display uses colons, and it is a short
  hash, not the key: paste the 64-hex value from `xiom pkg keygen`).
- Rotation report: `list` prints `issued=` and `age=` and marks
  `ROTATION-DUE` at 90 days; `list --json` emits `ageDays`/`rotationDue` for
  a monthly ops cron. Static tokens have no server-side expiry, so the policy
  is enforced by this report.
- Revoking a token stops future publishes (401). It does not unpublish:
  published versions stay downloadable and installable.
- Yanking (`POST /packages/<name>/<version>/yank`) is the only withdrawal:
  the version leaves `latest` and fresh resolution but stays downloadable, so
  lockfiles that pin it keep working.
- Versions are immutable and all are kept. `xiom pkg install <name>@<version>`
  installs an exact version; `xiom pkg install <name>` resolves the highest
  non-yanked version.

Verify a token without publishing anything: yank a version that does not
exist -- auth and scope run first, so a live token gets `404
version_not_found` while a revoked or unloaded one gets `401 invalid_token`:

```
TOKEN="$(python3 -c 'import json;print(next(t["token"] for t in json.load(open("tokens.json")) if t["label"]=="<label>"))')"
curl -s -w '\nHTTP %{http_code}\n' -X POST \
  https://registry.xiom-lang.org/packages/<name>/9.9.9/yank \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
unset TOKEN
```

Tokens are compared in constant time; `trusted` tokens require signed
publishes, `first-party` allows the reserved `xiom.*` namespace.

Operator runbook -- issue a scoped token, prove least privilege with canary
publishes, list tokens without printing secrets, revoke, rotate, incident
response and backups: `xiom-lang/ops` `docs/REGISTRY_TOKENS.md` (private
repository) --
https://github.com/xiom-lang/ops/blob/main/docs/REGISTRY_TOKENS.md

## Verification after any change

```
curl -s https://registry.xiom-lang.org/health
curl -s https://registry.xiom-lang.org/
curl -s https://registry.xiom-lang.org/index.json | head -c 300
# read-only web UI (browsers only; the API stays JSON for these paths)
curl -s -H 'Accept: text/html' https://registry.xiom-lang.org/ | head -c 120
```

End-to-end client check (build `xiom-pkg` from the compiler repo):

```
XIOM_REGISTRY=https://registry.xiom-lang.org \
XIOM_REGISTRY_TOKEN=<token> xiom-pkg publish        # from a package directory
XIOM_HOME=/tmp/e2e xiom-pkg install <name>@<ver>
```

## Helper scripts on the VPS (Node is container-only)

The host has **no Node binary** -- the registry runs Node inside its
container and nothing else. Run repo scripts through the node image:

```
cd /opt/xiom/registry
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node scripts/live-check.js \
  --staging https://staging.registry.xiom-lang.org \
  --production https://registry.xiom-lang.org
```

For the production probe yank (reads the token inside the container; it
never appears on the host command line):

```
docker run --rm -v "$PWD:/w" -w /w node:22-alpine sh -c '
TOKEN=$(node -p "require(\"/w/tokens.json\")[0].token")
XIOM_REGISTRY_TOKEN="$TOKEN" node scripts/yank.js \
  --registry https://registry.xiom-lang.org \
  --name xiom.staging-e2e-probe --version 0.0.2 \
  --reason "staging validation probe; superseded by isolated staging"
'
```

The staging acceptance run (`scripts/staging-acceptance.js`) needs the
native `xiom-pkg` client, which the VPS does not have; run it from a machine
with the compiler checkout (it finds `target/debug|release/xiom-pkg`
automatically) and pass the staging token privately:

```
node scripts/staging-acceptance.js --token <staging-token>
```

## Commit identity (required in every clone)

The machine-wide git config carries a work address and must not be used in
this repository. Before the first commit in a fresh clone:

```
git config user.name "Lefteris Notas"
git config user.email "lefterisnotas@gmail.com"
```

Verify before every push -- it must print
`Lefteris Notas <lefterisnotas@gmail.com>`:

```
git log -1 --format='%an <%ae>'
```

An unpushed commit made with another identity:
`git commit --amend --reset-author`. Several unpushed commits:
`git rebase --exec "git commit --amend --no-edit --reset-author" --root`.
Never change the global config and never push commits authored with another
address. Rewriting already-pushed history is owner-gated: it needs
`git filter-repo` and forces every deployment clone (and any open PR) to be
re-cloned; a `.mailmap` does not fix GitHub attribution.

## Gotchas

- `container_name: xiom-registry` is fixed in the compose file; a second
  instance needs its own compose file with a renamed container and volumes.
- `REGISTRY_URL` is advertised in `/index.json`; set it per instance.
- Rate limiting trusts `X-Forwarded-For` because `TRUST_PROXY=1`; keep that
  set when behind Hestia.
- Backups (restic) for the two volumes are not automated yet - see the
  release/infra queue in `xiom-lang/.github`.
