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
| `pgk_<state>_<track>.webp` | owner-supplied badge art (14 files) | package status badge matrix: states flagged, yanked, deprecated, incubator, prerelease, verified, unsigned; tracks official, community |

Refresh all after any website brand change (the website's `9190bf8`
optimization pass shrank the icon from 370 KB to 6.6 KB and the logo from
107 KB to 15 KB; hash-compare the copies after refreshing). The banner is the
heaviest asset; re-encoding it at ~60-70% quality roughly halves it with no
visible loss if page weight ever matters. The wordmark in the banner is text,
not an image, so `logo.png` was retired with the old header brand.

**Badge art note (2026-09-24, v2):** the badge set is now a 14-file state x
track matrix (~50-61 KB each; a website image-optimizer pass at ~64 px would
still cut the weight by an order of magnitude). `pgk_verified_*` is the
publisher-signed state and is labelled "Signed by the publisher" in the UI
until a distinct reviewer-verified mark exists; `pgk_flagged_*` is
operator/reviewer-set only; `pgk_incubator_*` and `pgk_deprecated_*` read the
manifest `stage` field. Three filenames were normalized on receipt:
`pkg_unsigned_*` -> `pgk_unsigned_*` and `pgk_flagged_comm_community` ->
`pgk_flagged_community`. All assets are XIOM project brand assets under the
repository's dual MIT OR Apache-2.0 license.
