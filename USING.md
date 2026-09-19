<!-- Copyright (c) 2026 Eleftherios Notas and XIOM Foundation -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# Using the XIOM Registry

The registry is the package source your `xiom pkg` commands already use:
**https://registry.xiom-lang.org**. This guide covers browsing, installing,
locking, and verifying packages. For publishing your own packages, see
[PUBLISHING.md](PUBLISHING.md).

---

## Browse the registry

Open **https://registry.xiom-lang.org** in a browser:

- the home page lists every package with its latest version
- search filters by name or description
- a package page shows all versions with published date, size, sha256 digest,
  signature fingerprint, and yank state
- every version links to its tarball and shows the exact install command

The JSON API behind the UI is public too: `https://registry.xiom-lang.org/index.json`.

## Install a package

```
xiom pkg install my-lib              # latest installable version
xiom pkg install my-lib@1.2.0        # exact version
```

The client downloads the tarball and verifies its **sha256 against the index**
before unpacking; a mismatch aborts the install (`CHECKSUM MISMATCH`). If the
registry key has been pinned (see below), the **ed25519 signature is verified
too**, and unsigned or mis-signed artifacts are refused.

Installs land in `XIOM_HOME/packages/<name>-<version>/` and the package
becomes importable by name.

## Pin your dependencies

`xiom pkg lock` reads `package.xi` and writes `xiom.lock`, recording the exact
version and `sha256-...` digest of every dependency. Commit the lockfile: it
makes builds reproducible and pins the bytes you reviewed. Updating is
deliberate - change the version in `package.xi` and re-run `xiom pkg lock`.

## Signatures and trust

Every first-party artifact is signed. Publishers can sign community packages
too; the package page shows a `signed` badge with the key fingerprint when
they do.

To enforce signatures for a registry, pin its key:

```
xiom pkg trust --registry https://registry.xiom-lang.org --key <public key hex>
xiom pkg trusted     # list pinned keys
```

**Read this before pinning:** a pinned key applies to **every package from
that registry**. At beta, community packages may be published unsigned, so
pinning the registry key means those installs will be refused. Pin it when you
consume first-party signed packages and want the strictest guarantee; expect
to unpin if you need an unsigned community package.

You can also verify a downloaded artifact manually:

```
xiom pkg verify <tarball> <signature-file> [--key <public key hex>]
```

Without `--key` it uses the pinned key for the configured registry.

## Search from the CLI

```
xiom pkg search http        # downloads the index and filters locally
```

The web UI at `/search` does the same server-side and is easier for browsing.

## Yanked versions

A yanked version is withdrawn: it disappears from `latest` and from fresh
resolution, but **existing lockfiles keep working** - the artifact stays
downloadable. The package page marks it with a `yanked` badge. If you depend
on one, move to the publisher's replacement version when convenient.

## Trust model, briefly

| Signal | What it means |
|---|---|
| sha256 in the index | the bytes you get are the bytes that were published |
| immutable versions | a published version can never change under you |
| ed25519 signature | the artifact was signed by the key with that fingerprint |
| pinned key (`xiom pkg trust`) | you refuse anything not signed by that key |
| yank | a version is withdrawn without breaking pinned installs |

The registry never modifies artifacts after publish; everything a client
verifies is derived from what the publisher uploaded.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `404` | unknown package or version - check the spelling and the package page |
| `CHECKSUM MISMATCH` | served bytes do not match the index; the install is aborted (do not retry through other paths) |
| `no signature` / `signature verification failed` | this registry key is pinned and the artifact is unsigned or signed by another key |
| install falls back to local resolution | the registry could not be reached; the client tries local sources only for availability errors, never for integrity failures |
| stale index | the client caches the index in-process for 5 minutes; retry later for brand-new releases |

## Getting help

- Package pages link to the publisher's repository.
- Registry issues: https://github.com/xiom-lang/registry/issues
- Site and docs: https://xiom-lang.org
- Terms of Use: https://xiom-lang.org/terms.html · Privacy:
  https://xiom-lang.org/privacy.html · support@xiom-lang.org
