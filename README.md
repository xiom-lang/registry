<!-- Copyright (c) 2026 Eleftherios Notas and XIOM Foundation -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# XIOM Package Registry

The package registry for XIOM - index discovery, artifact download, publish
with ed25519 signatures, version immutability, and yank.

Service endpoint: `https://registry.xiom-lang.org` (staging:
`https://staging.registry.xiom-lang.org`).

## Status

Beta-ready, deployed. The server speaks the full `xiom pkg` protocol and
passes a 20-check end-to-end gate that drives the real client, plus 82 unit
tests. `SESSION.md` is the normative spec and handoff - read it before
changing anything.

## Web UI

Browsers get a read-only UI at `https://registry.xiom-lang.org`: package
list, search, package/version pages with digests, signatures, yank state,
and copy-ready install/trust commands. The API is unchanged - HTML is
served only when the browser's first `Accept` entry is `text/html`; every
CLI and protocol request still receives JSON.

## Quick start (local)

```
npm install
npm start                # listens on :3000
```

Publishing requires a token file. Generate one and point the server at it:

```
node scripts/keygen.js --label dev --scopes "*" --trusted --first-party
# writes ./tokens.json

# PowerShell
$env:TOKENS_FILE = "./tokens.json"
$env:REGISTRY_URL = "http://localhost:3000"
npm start
```

Client against a local server:

```
# PowerShell
$env:XIOM_REGISTRY = "http://localhost:3000"
$env:XIOM_PKG_ALLOW_HTTP = "1"          # http allowed only for local dev
$env:XIOM_REGISTRY_TOKEN = "<token from keygen>"
xiom pkg publish
```

## Tests

```
npm test          # 71 unit tests: index, names, auth, signatures, manifest, HTTP
npm run test:e2e  # 16 checks driving the real xiom-pkg client
```

The e2e gate needs the client binary; build it in the xiom compiler repo
(`cargo build -p xiom-pkg`) or set `XIOM_PKG_CLIENT` to a prebuilt path.

## Deploy

Docker/Compose stack: `docker-compose.yml` (non-root, capabilities dropped,
loopback-only port). Copy `.env.example` to `.env`, provide the tokens file,
and run:

```
docker compose up -d
```

Bind the port to `127.0.0.1:3000` and reverse proxy with the Hestia nginx
vhost for the registry domain. Deployment runbook: `docs/RELEASE_INFRA_PLAN.md`
R4 (monorepo) and `SESSION.md` section 4.

## Repository rules

- Conventional commits.
- Every behavior change carries a test; the end-to-end gate drives the real
  `xiom pkg` client (SESSION.md section 5).
- Never weaken sha256 or signature verification to make a test pass.
- Staging first; production deploys go through a required-reviewer
  environment.

## License

Dual-licensed under your choice of:

- MIT License - see `LICENSE-MIT`
- Apache License, Version 2.0 - see `LICENSE-APACHE`

Copyright (c) 2026 Eleftherios Notas (Lefteris Notas) and XIOM Foundation.
See `NOTICE` for attributions.
