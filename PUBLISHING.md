# Publishing a package to the XIOM registry

This guide takes a package from "it exists in my repo" to "anyone can
`xiom pkg install` it" with no prior registry knowledge. It is written for
hobbyists and first-time release engineers: every command is copy-pasteable,
and the troubleshooting table at the end maps the exact errors you may see.

The same content is rendered at **https://registry.xiom-lang.org/publish**
(nav: Publish), which is also where the workflow template download lives.

- New here? Go straight to the [five-minute quickstart](#1-five-minute-quickstart-trusted-publisher-recommended).
- Already publish from CI with a token? See [the manual token lane](#4-the-manual-token-lane).
- Something failed? Jump to [troubleshooting](#8-troubleshooting).

---

## 0. What you need

| You need | Why |
|---|---|
| The XIOM toolchain (`xiom` on your PATH) | Builds, signs, and publishes packages |
| A GitHub account | Sign-in and (recommended) the publish workflow |
| A package directory with `package.xi` | The manifest the registry reads |
| A README.md and a LICENSE | Shown on the package page; license is required by convention |

Install the toolchain once:

```bash
# macOS / Linux
curl -fsSL https://xiom-lang.org/install.sh | sh

# Windows (PowerShell)
irm https://xiom-lang.org/install.ps1 | iex
```

Check it:

```bash
xiom pkg --help
```

### A minimal package

Your repository should look like this (the registry cares about the files in
the root, not any particular build system):

```
my-lib/
  package.xi          # the manifest (required)
  README.md           # what the package does (strongly recommended)
  LICENSE             # MIT OR Apache-2.0, for example
  src/...             # your code
```

A complete, minimal `package.xi`:

```toml
name: "my-lib"
version: "0.1.0"
description: "A small library that does one thing well"
license: "MIT OR Apache-2.0"
repository: "https://github.com/you/my-lib"
categories: ["tooling"]
keywords: ["example"]

[dependencies]
```

Rules the registry enforces:

- `name` is lowercase letters, digits, `.`, `-`, `_`; `.` separates namespaces
  (`my-ns.utils`). Names under `xiom.*`, `std.*`, `core.*` are reserved.
- `version` must be new for every publish. The registry answers `409` if it
  already exists; bump the version, never reuse one.
- `description` is one sentence and shows up in search results.
- `repository` should be the public URL of this repository.

> **Do not commit build output.** `xiom pkg publish` packages the whole
> directory. Put `target/`, `dist/`, downloaded toolchains, and editor junk in
> `.gitignore`, and publish from a clean checkout.

---

## 1. Five-minute quickstart (trusted publisher, recommended)

This is the path most people should take. There is **no token and no secret**
in your repository: GitHub proves the repo/workflow/ref to the registry using
OpenID Connect (OIDC), and a maintainer approves that exact combination once.

### Step 1 -- add the workflow

1. In your repo, create `.github/workflows/publish-registry.yml`.
2. Copy the template from
   <https://registry.xiom-lang.org/ui/templates/community-publish.yml>
   (or click **Download the workflow template** on the
   [publishing page](https://registry.xiom-lang.org/publish)).
3. Commit it.

### Step 2 -- request access on the registry

1. Open <https://registry.xiom-lang.org/login> and sign in with GitHub.
2. Go to **Requests** (`/account/requests`).
3. Choose **Trusted publisher** and fill in:
   - **Repository**: `you/my-lib` (exactly as on GitHub);
   - **Workflow file**: `publish-registry.yml` (the file name you committed);
   - **Refs**: `refs/tags/v*` if you release by tag (recommended), or
     `refs/heads/main` if you publish from a branch;
   - **Package names**: the `name` from `package.xi` (e.g. `my-lib`).
4. Submit. A maintainer reviews it, usually within a day; you get an in-app
   notice (and an email if you set one in Settings).

> While the request is pending you can already tag releases; publishing simply
> starts working once the request is approved.

### Step 3 -- tag a release

```bash
# make sure package.xi says version: "0.1.0"
git add package.xi
git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

### Step 4 -- let the workflow publish

Uncomment the `push: tags: ["v*"]` trigger at the top of the workflow file
(one time), or run **Actions -> Publish to XIOM registry -> Run workflow**
manually. The workflow:

1. checks the tag matches `version:` in `package.xi`;
2. mints a short-lived OIDC token for this repo/workflow/ref;
3. downloads the pinned toolchain, signs the package, and publishes;
4. fails loudly (with a readable error) if anything is off.

### Step 5 -- check your package page

Within a few seconds:

- <https://registry.xiom-lang.org/packages/my-lib>
- `xiom pkg info my-lib`
- `xiom pkg install my-lib`

The page shows the version, size, SHA-256, signature, and the trust badges
(see [section 5](#5-what-the-registry-checks-and-what-the-badges-mean)).

### Step 6 (optional) -- a stable signing key

Without a key secret, each CI run generates a fresh ephemeral key. The package
is still signed, but the fingerprint changes every release. For a stable
"verified" fingerprint:

```bash
xiom pkg keygen --out my-lib.key     # keep this file secret!
```

Add the 64-hex key as a repository secret named `XIOM_SIGNING_KEY`
(Settings -> Secrets and variables -> Actions -> New repository secret). The
template picks it up automatically. See
[section 6](#6-verify-your-release) for pinning the key in `xiom pkg trust`.

---

## 2. Versions, tags, and the workflow guard

- **Semantic versions**: `MAJOR.MINOR.PATCH`, optionally `-prerelease`
  (e.g. `1.0.0-rc.1`). The registry accepts any valid `X.Y.Z`-style version
  string; consumers use it for resolution.
- **Tags**: `v` + the exact manifest version: `v1.2.3`, `v1.0.0-rc.1`. The
  template's guard compares `github.ref_name` (without the leading `v`) with
  `version:` in `package.xi` and stops the job on a mismatch, so a wrong tag
  can never publish the wrong version.
- **One version, one publish**. Re-publishing an existing version returns
  `409 version_exists`. Delete the tag, bump `version:`, commit, and tag again.
- **Pre-releases** are published like any other version. Users opt in with
  `xiom pkg install my-lib@1.0.0-rc.1`.
- **Yanking** retires a version without deleting it
  ([section 7](#7-yanking-a-version)).

If you prefer branch-triggered releases, use `refs/heads/main` as the approved
ref and keep the version bump + tag in the same push. The OIDC claims include
the ref, so a workflow run from an unapproved ref is refused with
`publisher_not_mapped`.

---

## 3. The manual token lane

Use a publish token when you publish from your own machine, from a CI system
that is not GitHub Actions, or from a script. A token is scoped to specific
package names and can be revoked by the maintainers at any time.

> **Compared to a trusted publisher**, a token is a long-lived secret: it can
> publish only the package names it is scoped to, but you must store it
> safely. For GitHub Actions, prefer [section 1](#1-five-minute-quickstart-trusted-publisher-recommended).

### Step 1 -- request a token

1. Sign in at <https://registry.xiom-lang.org/login>.
2. Open **Requests** (`/account/requests`), choose **Publish token**, and list
   the package names or namespaces you need (e.g. `my-lib, my-ns`; a namespace
   like `my-ns` covers `my-ns.*`).
3. A maintainer approves it and the operator mints the token on the registry
   host; it reaches you privately (never through the registry web UI, issues,
   or chat). You get an in-app notice when it is fulfilled.

### Step 2 -- store it

Name the secret whatever your CI supports (GitHub: `XIOM_REGISTRY_TOKEN`).

```bash
# local shell: export it for the session only
export XIOM_REGISTRY_TOKEN="<the token you received>"
export XIOM_REGISTRY="https://registry.xiom-lang.org"   # optional; this is the default
```

Windows PowerShell:

```powershell
$env:XIOM_REGISTRY_TOKEN = "<the token you received>"
```

### Step 3 -- sign and publish

```bash
xiom pkg keygen              # once per machine; writes ~/.xiom/keys/default.key
xiom pkg publish             # packs, signs, uploads the current directory
```

`xiom pkg publish` reads `package.xi`, packs the directory, signs with your key
(or the ephemeral key), and sends the tarball with your token. On success it
prints `Successfully published <name>@<version>`.

Useful variations:

```bash
xiom pkg publish --tarball dist/my-lib-0.1.0.tar.gz   # upload exact bytes
xiom pkg publish --compiler v0.61.3                   # record the toolchain tag
```

### Token hygiene

- One token per purpose; ask for the smallest scope that works.
- Never commit it, never paste it into the registry UI, never put it in a
  workflow file.
- If it leaks, contact <support@xiom-lang.org> immediately and the
  maintainers revoke it; ask for a replacement scoped the same way.

---

## 4. What the registry checks, and what the badges mean

Every publish is validated before anything is stored:

1. **Manifest** -- `name`, `version`, `description`, and the tarball layout.
2. **Identity** -- a valid token scoped to this name, or an OIDC token whose
   repository + workflow + ref match an approved trusted publisher.
3. **Signature** -- a valid ed25519 signature over the artifact digest.
4. **Immutability** -- a version that exists is never overwritten.

Badges on the package page and in listings:

| Badge | Meaning |
|---|---|
| **verified** | The artifact is signed and verifies against the included public key |
| **signed** | A signature is present (older/unsigned-key metadata) |
| **trusted** | Published through an approved GitHub OIDC trusted publisher |
| **reviewed** | A registry reviewer looked at it and found nothing to flag |
| **official** | A first-party package maintained by the XIOM project |
| **flagged** | A reviewer marked a concern; read the review history |
| **yanked** | A specific version is retired; pinned installs still resolve |
| **muted** | Hidden from listings/search by the maintainers; the page, files, and `/index.json` entry still work |

You do not need a reviewer to install or use a package: badges are extra
signals. To request a review, use the **Report** form on the package page --
reports go to the reviewer queue and are never anonymous to maintainers.

---

## 5. Verify your release

After publishing, verify from a clean machine (a container or a CI job):

```bash
xiom pkg info my-lib                 # metadata + versions
xiom pkg install my-lib@0.1.0        # downloads and verifies the signature
xiom pkg verify artifact.tar.gz artifact.tar.gz.sig --key <public-key-hex>
```

If a package page shows the registry signing key, pin it so installs refuse
anything signed by a different key:

```bash
xiom pkg trust --registry https://registry.xiom-lang.org --key <ed25519-public-hex>
xiom pkg trusted                     # list pinned keys
```

The raw protocol is always available if you want to integrate:

- `GET /index.json` -- the whole registry index;
- `GET /packages/my-lib` -- one package (JSON);
- `GET /packages/my-lib/0.1.0/package.tar.gz` -- the artifact;
- `GET /packages/my-lib/0.1.0/package.tar.gz.sha256` -- the digest sidecar.

---

## 6. Yanking a version

Yanking marks a version retired: fresh installs skip it, but existing lockfiles
and already-resolved dependencies keep working (the artifact is never deleted).
Use it when you shipped a broken release; then publish a fixed version.

There is no `xiom pkg yank` subcommand yet -- use the API with a token scoped
to the package:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $XIOM_REGISTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"broken dependency in 0.1.0"}' \
  https://registry.xiom-lang.org/packages/my-lib/0.1.0/yank
```

With a trusted publisher you can also run the workflow template with
`mode=yank`. Ask a maintainer if you do not have publish access anymore.

---

## 7. What maintainers do (so you know what to expect)

- **Approve requests**: a maintainer reviews `/admin/requests`. A trusted
  publisher is activated the moment it is approved; a token request is queued
  for the operator to mint and deliver privately.
- **Review packages**: anyone can report a package; reviewers resolve or
  dismiss reports with a note, and the history stays public on the page.
- **Moderate**: flagging adds a public warning; muting hides a package from
  discovery without touching its files or the index protocol.
- **Everything is audited**: approvals, decisions, role changes, and
  moderation are recorded with actor and timestamp.

Response time is usually within a day. If nothing happens for a few days,
ping the community channels below.

---

## 8. Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| `401 invalid_token` | The token is unknown or was revoked | Re-check the value; request a new token if it was rotated |
| `401 no bearer token` | `XIOM_REGISTRY_TOKEN` is not set in this shell/job | Export it, or add the repo secret and reference it |
| `403 scope_denied` | The token is not scoped to this package name | Request a token that includes the name; namespaces cover `ns.*` |
| `403 publisher_not_mapped` | The OIDC claims do not match an approved entry | Check repo, workflow file name, and ref in your request |
| `403 oidc_not_configured` | The registry has no OIDC publishers configured | Use the token lane and contact the maintainers |
| `409 version_exists` | This `name@version` is already published | Bump `version:` in `package.xi`; versions are immutable |
| `409 publisher_exists` | The same repo/workflow is already approved | Check the existing entry; revoke it first if you are moving repos |
| `413 payload_too_large` | The tarball exceeds the registry limit | Remove build output and large fixtures from the repo |
| `422 signature_required` | The registry requires signed artifacts | Run `xiom pkg keygen` before publishing, or set the signing secret |
| `422 incomplete_signature` | A signature and public key must be sent together | Publish with the `xiom` client instead of hand-rolled requests |
| `422 invalid_name` / `reserved_namespace` | The package name is invalid or reserved | Pick a lowercase name that is not under `xiom.*`, `std.*`, `core.*` |
| `429 rate_limited` | Too many requests in a short window | Wait a minute and retry; do not loop the publish |
| Workflow fails at `Check tag matches` | Tag and manifest version differ | Bump `version:` in `package.xi`, commit, re-tag |
| Workflow fails at `Mint registry token` | `id-token: write` is missing | Add `permissions: id-token: write` to the job |
| `unknown field` in `package.xi` | Typo in the manifest | Compare with the minimal example in section 0 |
| Install says the package is `yanked` | The version was retired | Install the newest version, or pin an older, working one |

If the error is not here, open an issue at
<https://github.com/xiom-lang/registry/issues> with the command you ran, the
exact error text, and the package name.

---

## 9. Glossary

- **Artifact** -- the `.tar.gz` the registry stores and serves for a version.
- **Digest / SHA-256** -- the hash of that artifact; used to verify downloads.
- **Signature** -- an ed25519 signature over the digest, made with your key.
- **Index** -- `/index.json`, the complete, immutable-to-consumers list of
  packages and versions. Clients read it; the web UI never changes its shape.
- **Trusted publisher** -- an approved repo + workflow + ref combination that
  may publish via GitHub OIDC, with no stored secret.
- **Token** -- a scoped bearer credential for the manual lane.
- **Yank** -- retire a version without deleting it.
- **Mute** -- maintainer action that hides a package from discovery only.

---

## 10. Getting help and contributing

- Community chat: <https://discord.gg/fsxQfDUg9>
- Registry issues and guide fixes:
  <https://github.com/xiom-lang/registry/issues>
- Security reports: <support@xiom-lang.org> (please do not open a public issue)
- Registry operations and the deploy runbook live in `DEPLOY.md`
  (maintainers).

The registry's own request flow is the only front door for tokens and trusted
publishers. The old GitHub issue template for token requests is deprecated and
removed: signed-in requests are audited, notifiable, and revocable, and they
cannot leak a token into a public issue thread.
