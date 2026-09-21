<!-- Copyright (c) 2026 Eleftherios Notas and The XIOM Authors -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# Publishing packages to the XIOM Registry

This guide is for package authors. It covers getting a publish token, signing
your package, publishing, and what happens next. For consuming packages, see
[USING.md](USING.md).

The registry lives at **https://registry.xiom-lang.org** and is the default
endpoint of `xiom pkg` - you do not need any configuration to publish or
install from it.

---

## How publishing works

- Publishing requires a **Bearer token** issued by the registry maintainers.
  Tokens are scoped to the package names you own; they cannot publish anything
  else.
- Every version is **immutable** once published. You never overwrite a
  version - you publish a new one. Mistakes are withdrawn with **yank**
  (pinned installs keep working; fresh resolution skips the version).
- Every artifact gets a **sha256** that clients verify. If you sign your
  package (recommended, and required for some tokens), the registry stores
  your **ed25519 signature and public key** alongside it, and the package page
  shows the fingerprint.
- The registry is a delivery channel, not a git host: it never needs access to
  your repository. Link your repo in the package metadata.

## 1. Prerequisites

Install the XIOM toolchain (release archives ship both binaries since
v0.61.0):

```
xiom --version          # the compiler
xiom pkg --help         # the package manager
```

If `xiom pkg` is missing, your release predates v0.61.0 - update from
https://xiom-lang.org/install.

## 2. Create the package

A package is a directory with a `package.xi` manifest:

```xi
package my_lib {
  name: "my-lib";
  version: "0.1.0";
  description: "What this package does, in one sentence";
  categories: ["graphics"];
  keywords: ["vulkan", "gpu", "rendering"];
  license: "MIT OR Apache-2.0";
  repository: "https://github.com/you/my-lib";
  deps: {
    "xiom.core": "0.1.0";
  };
}
```

**Metadata fields** (all optional except name/version, all shown in search,
on the package page, and to tooling/agents):

- `description` — one sentence; this is what users and AI agents see first.
- `categories` — up to 3 from the registry's fixed vocabulary, so browsing
  stays predictable:
  `core`, `data`, `database`, `web`, `network`, `graphics`, `media`,
  `ai-ml`, `science`, `crypto-security`, `cloud-infra`, `observability`,
  `concurrency`, `systems`, `tooling`, `testing`, `text-nlp`.
  Common aliases are mapped automatically (`gpu` → `graphics`, `db` →
  `database`, `ai`/`ml` → `ai-ml`, ...). Unknown values are ignored and the
  publish response lists them under `warnings`.
- `keywords` — up to 10 free-form lowercase terms (letters, digits,
  `. + # -`), e.g. `["redis", "cache", "key-value"]`. Keywords are
  search-only; niche topics belong here rather than in the vocabulary.
- `license` — SPDX expression; `repository` — canonical URL.

**Name rules** (enforced by the registry):

- lowercase letters, digits, and hyphens; dot-separated segments
- each segment starts with a letter and does not end with a hyphen
- no `..`, no leading or trailing dot, no reserved system names (`con`,
  `com1`, `lpt1`, ...)
- **`xiom.*` and `xiom-*` are reserved for first-party packages published by
  the XIOM Authors.** Both
  forms are enforced by the registry: community tokens receive
  `403 reserved_namespace`. Choose a name that describes your project
  (`my-http-client`), not a namespace.

**Version** must be valid semver (`0.1.0`, `1.2.3-rc.1`).

`description` and `deps` are read from the manifest and shown on the registry
website; keep them accurate.

## 3. Create a signing key (recommended)

```
xiom pkg keygen
```

This writes `~/.xiom/keys/default.key` and prints your public key. Keep the
private key safe (it lives outside your repo). `xiom pkg publish` signs
automatically whenever that key exists; without it, your package publishes
unsigned. The registry shows the signature fingerprint on the package page,
and first-party tokens require signatures. Do not lose the key: republishing
the same version with a different key is impossible (versions are immutable).

## 4. Request a publish token

Open a token request in the registry repository:
**https://github.com/xiom-lang/registry/issues/new/choose** ("Token request").

Include:

- your GitHub handle
- the exact package name(s) you need (one token is scoped to those names)
- the repository URL for the project
- your signing public key fingerprint, if you have one (`xiom pkg keygen`
  output)

A maintainer verifies the request and sends the token to you **privately**
(never in the issue). Treat the token like a password: anyone who has it can
publish your package names. If it leaks, report it and it will be revoked -
publishes already made stay immutable, and abusive versions can be yanked.

## 5. Publish

From the package directory:

```
# Linux / macOS
export XIOM_REGISTRY_TOKEN="<your token>"
xiom pkg publish

# Windows PowerShell
$env:XIOM_REGISTRY_TOKEN = "<your token>"
xiom pkg publish
```

Expected output: `Successfully published my-lib@0.1.0`. The registry replies
`201` and the version is live. Exit codes are meaningful: a non-zero exit
means nothing was published.

Useful environment variables:

| Variable | Purpose |
|---|---|
| `XIOM_REGISTRY` | target registry (default `https://registry.xiom-lang.org`) |
| `XIOM_REGISTRY_TOKEN` | your publish token |
| `XIOM_PKG_ALLOW_HTTP` | allow plain http - local development only |

## 6. Verify your release

1. Open `https://registry.xiom-lang.org/packages/<your-name>` - check the
   version, digest, signature fingerprint, and dependency list.
2. In a clean directory, install it back:

   ```
   xiom pkg install my-lib@0.1.0
   ```

   The client prints `checksum verified`; if you signed it, the artifact line
   shows the fingerprint.
3. Share the package URL - it is the canonical link to your release.

## 7. New versions

Bump `version` in `package.xi` and publish again. Republishing an existing
version is refused with `409 version_exists` - versions are immutable, and
that is what makes lockfiles trustworthy.

## 8. Withdrawing a version (yank)

Yanking keeps the artifact downloadable for existing lockfiles but removes the
version from fresh resolution and from `latest`. Use your own token:

```
curl -X POST \
  -H "Authorization: Bearer $XIOM_REGISTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "why this version is withdrawn"}' \
  https://registry.xiom-lang.org/packages/my-lib/0.1.0/yank
```

A dedicated `xiom pkg yank` command is planned; until then the API call above
is the supported path. Yanked versions show a badge on the package page.

## 9. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `401` | missing or unknown token | set `XIOM_REGISTRY_TOKEN`; if revoked, request a new token |
| `403 scope_denied` | token not scoped to that package name | request a token covering the name |
| `403 reserved_namespace` | tried to publish `xiom.*` or `xiom-*` | choose a non-reserved name |
| `409 version_exists` | that version is already published | bump the version |
| `413` | tarball over the 50 MiB beta limit | shrink the package |
| `422 signature_required` | your token requires signatures | run `xiom pkg keygen` and publish again |
| `422 signature_invalid` | signature does not match the tarball | regenerate the signature (`xiom pkg publish` signs automatically) |
| `429` | rate limit (20 publishes/minute) | wait for `Retry-After` seconds |

Manifest problems (name/version/dependencies) are usually reported by the
client before it uploads anything - read its message first.

## 10. Ground rules

The legal framework for the registry is the XIOM Terms of Use
(https://xiom-lang.org/terms.html) -- **section 4 covers publishing:
ownership, immutability, and takedown**. Privacy practices are described at
https://xiom-lang.org/privacy.html. This guide stays the operational
how-to; the Terms are the contract.

- Publish only code you have the right to distribute, with a license file.
- No squatting on names you do not use; maintainers may yank and reassign.
- Keep version numbers honest: never reuse a version for different contents
  (the registry will not let you, but do not try to work around it).
- Security issues in a published package: yank the affected version and
  publish a fixed release.
- Questions or takedown requests: support@xiom-lang.org.

## Roadmap

GitHub OIDC **trusted publishing** is planned: repositories will publish from
CI without a long-lived token, tied to their GitHub identity, with provenance
recorded per version. Until then, tokens are issued manually as described
above.
