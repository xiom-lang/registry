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
docker compose --profile staging up -d --build
docker compose ps                              # both containers up, staging on 3200
curl -s http://127.0.0.1:3200/health           # staging is up
curl -s http://127.0.0.1:3100/health           # production still up
```

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
docker compose up -d
```

Tokens are compared in constant time; `trusted` tokens require signed
publishes, `first-party` allows the reserved `xiom.*` namespace.

## Verification after any change

```
curl -s https://registry.xiom-lang.org/health
curl -s https://registry.xiom-lang.org/
curl -s https://registry.xiom-lang.org/index.json | head -c 300
```

End-to-end client check (build `xiom-pkg` from the compiler repo):

```
XIOM_REGISTRY=https://registry.xiom-lang.org \
XIOM_REGISTRY_TOKEN=<token> xiom-pkg publish        # from a package directory
XIOM_HOME=/tmp/e2e xiom-pkg install <name>@<ver>
```

## Gotchas

- `container_name: xiom-registry` is fixed in the compose file; a second
  instance needs its own compose file with a renamed container and volumes.
- `REGISTRY_URL` is advertised in `/index.json`; set it per instance.
- Rate limiting trusts `X-Forwarded-For` because `TRUST_PROXY=1`; keep that
  set when behind Hestia.
- Backups (restic) for the two volumes are not automated yet - see the
  release/infra queue in `xiom-lang/.github`.
