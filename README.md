# XIOM Package Registry

The package registry for XIOM - index discovery, artifact download, publish
with ed25519 signatures, and version immutability.

Service endpoint: `https://registry.xiom-lang.org` (staging first:
`https://staging.registry.xiom-lang.org`).

## Status

Pre-beta. The server skeleton is deployable, but protocol compliance with
the `xiom pkg` client is in progress. See `SESSION.md` - read it before
changing anything; it contains the normative protocol contract, the ordered
work queue (T1-T10), the test plan, and the session prompt.

## Quick start (local)

```
npm install
npm start                # listens on :3000
```

Client against a local server:

```
$env:XIOM_REGISTRY = "http://localhost:3000"
$env:XIOM_PKG_ALLOW_HTTP = "1"          # http allowed only for local dev
$env:XIOM_REGISTRY_TOKEN = "test-token"
xiom pkg publish
```

## Deploy

Docker/Portainer stack: `docker-compose.yml`. Bind the port to
`127.0.0.1:3000` and reverse proxy with the Hestia nginx vhost for the
registry domain. Deployment runbook: `docs/RELEASE_INFRA_PLAN.md` R4
(monorepo) and `SESSION.md` section 4.

## Repository rules

- Conventional commits.
- Every behavior change carries a test; the end-to-end gate drives the real
  `xiom pkg` client (SESSION.md section 5).
- Never weaken sha256 or signature verification to make a test pass.
- Staging first; production deploys go through a required-reviewer
  environment.
