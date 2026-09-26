<!-- Copyright (c) 2026 Eleftherios Notas and The XIOM Authors -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# UI brand assets

Copied from the website repo (`xiom-lang/website`) so the registry UI uses the
same marks as xiom-lang.org. Re-copy from there when the brand assets change;
do not edit these binaries in this repo.

| File | Source | Used as |
|---|---|---|
| `favicon.ico` | `xiom-website/img/xiom-icon.ico` | `/favicon.ico` (browser default request) |
| `favicon.png` | `site/assets/images/favicon.png` | 48x48 PNG icon linked in the page head |
| `icon.png` | `xiom-website/img/xiom-icon.png` | apple-touch-icon |
| `registry.webp` | `xiom-website/img/registry.webp` | page banner artwork (1539x510, 188 KB) |
| `pgk_<state>_<track>.webp` | owner-supplied badge art (15 files) | package status badge matrix: states flagged, yanked, deprecated, incubator, prerelease, trusted (community only), verified, unsigned; tracks official, community |

Refresh all after any website brand change (the website's `9190bf8`
optimization pass shrank the icon from 370 KB to 6.6 KB and the logo from
107 KB to 15 KB; hash-compare the copies after refreshing). The banner is the
heaviest asset; re-encoding it at ~60-70% quality roughly halves it with no
visible loss if page weight ever matters. The wordmark in the banner is text,
not an image, so `logo.png` was retired with the old header brand.

**Badge art note (2026-09-24, v2):** the badge set is a state x track matrix
(~46-61 KB each; a website image-optimizer pass at ~64 px would still cut the
weight by an order of magnitude). `pgk_trusted_community` (star) marks a
community package whose latest version came through a GitHub OIDC trusted
publisher (publishing identity verified by the registry); there is
deliberately no `trusted_official` because first-party publishes are
org-controlled by definition. `pgk_verified_*` (shield) is the
publisher-signed state; a visible "signed" pill accompanies it (and a
"trusted" pill accompanies the trusted state) so the art is never the only
carrier of a trust claim. `pgk_flagged_*` is operator/reviewer-set only;
`pgk_incubator_*` and `pgk_deprecated_*` read the manifest `stage` field.
Filenames normalized on receipt: `pkg_*` -> `pgk_*` and
`pgk_flagged_comm_community` / `pkg_trusted_community` accordingly. All
assets are XIOM project brand assets under the repository's dual MIT OR
Apache-2.0 license.

**Decision art (optional, registry 2.1 audit 2026-09-26):** reviewer
decisions can have their own art. Drop `pgk_reviewed_<track>.webp` and/or
`pgk_muted_<track>.webp` here (tracks: `community`, `official`) and the UI
picks them up automatically -- no code change, no rebuild of the resolver
list. Until a file exists, the resolver falls back to the derived state art
(`trusted` -> `verified` -> `unsigned`), so an `<img>` never 404s and a cleared
decision always shows the package's real trust state. `flagged` art ships and
wins over every other state. The visible fallback chain is
flagged/muted/reviewed -> yanked -> deprecated -> incubator -> prerelease ->
trusted -> verified -> unsigned.
