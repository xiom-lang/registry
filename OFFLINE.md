# Offline registry bundle

`scripts/export-bundle.js` produces a vendored, mountable mirror of a XIOM
registry for consumers that cannot reach the network (the playground container
is the first one). The bundle is a directory of verified bytes plus one
manifest; it contains no server code, no database, and no publish path.

**Export from production** (`https://registry.xiom-lang.org`): it is the
source of truth. Staging is rehearsal only.

## Layout

```
registry-bundle/
  index.json                                   exact bytes of GET /index.json
  artifacts/
    <name>/
      <version>/
        package.tar.gz                         artifact bytes, sha256-verified
  bundle.json                                  manifest (see below)
```

`index.json` is written byte-for-byte as served, so it can be diffed against
the live registry and re-hashed against `bundle.json`'s `index.sha256` field.
The protocol shape of `index.json` is unchanged (SESSION.md 2.2): the bundle
adds nothing to it.

## Usage

```sh
# Full mirror of every digest-bearing version (production is the source).
node scripts/export-bundle.js --registry https://registry.xiom-lang.org \
                              --out ./registry-bundle

# Only each package's `latest` version (smaller; good for the playground).
node scripts/export-bundle.js --registry https://registry.xiom-lang.org \
                              --out ./registry-bundle --latest-only

# Re-verify an exported directory offline, without any network access.
node scripts/export-bundle.js --verify ./registry-bundle
```

Flags: `--latest-only`, `--force` (re-download even when the local bytes
already match), `--concurrency 1-16` (default 4), `--quiet`.

Re-running an export into the same directory is cheap and safe: a local file
whose sha256 matches the index is reused, and a file that does not match is
re-downloaded.

## Integrity

Every artifact is hashed **while downloading** and must match the index
entry's `sha256` (and `size`, when present). On any mismatch the export stops,
removes the partial file, and writes no `bundle.json` — a half-written bundle
can never be mistaken for a verified one. Legacy index entries without a
digest are listed in `bundle.json.skipped` and are not downloaded: an offline
mirror that cannot prove integrity is worse than a gap.

Consumers should pin by `sha256`, never by version string alone. To check a
bundle by hand:

```sh
cd registry-bundle
node ../scripts/export-bundle.js --verify .
# or:
sha256sum -c <(node -e "const m=require('./bundle.json');for(const [n,p] of Object.entries(m.packages))for(const [v,r] of Object.entries(p.versions))console.log(r.sha256+'  '+r.path)")
```

## bundle.json

```jsonc
{
  "bundleVersion": 1,
  "registry": "https://registry.xiom-lang.org",  // source of truth
  "generatedAt": "2026-09-29T12:00:00.000Z",
  "generator": "xiom-registry/2.5.0",
  "index": {
    "path": "index.json",
    "sha256": "…",                // digest of the exact index bytes
    "bytes": 123456,
    "registry": "https://registry.xiom-lang.org",  // as the index advertises
    "updatedAt": "…",
    "packages": 328
  },
  "packages": {
    "<name>": {
      "latest": "0.1.0",          // the index's `latest`, when exported
      "versions": {
        "<version>": {
          "path": "artifacts/<name>/<version>/package.tar.gz",
          "sha256": "…",
          "size": 1234,
          "signature": "…",       // publisher signature from the index
          "publicKey": "…",
          "published": "…",
          "yanked": false,
          "source": "https://registry.xiom-lang.org/packages/<name>/<version>/package.tar.gz"
        }
      }
    }
  },
  "skipped": [
    { "name": "…", "version": "…", "reason": "no digest in the index (legacy entry)" }
  ],
  "totals": { "artifacts": 400, "downloaded": 400, "reused": 0, "bytes": 1234567 }
}
```

## Scope

The registry owns the bytes and their provenance: fetch, hash, manifest.
The **client lane owns offline resolution semantics** — how `xiom pkg`
resolves names, versions, and signatures against this layout inside a
no-egress container. Questions or layout changes go through the registry
lane first so bundles stay verifiable and reproducible.
