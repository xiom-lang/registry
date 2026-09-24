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
| `pgk_official.webp` | owner-supplied badge art | package status badge: first-party namespace |
| `pgk_community_trusted.webp` | owner-supplied badge art | package status badge: signed community package |
| `pgk_staging.webp` | owner-supplied badge art | package status badge: published from a branch ref (canary) |
| `pgk_unsigned.webp` | owner-supplied badge art | package status badge: unsigned community package |

Refresh all after any website brand change (the website's `9190bf8`
optimization pass shrank the icon from 370 KB to 6.6 KB and the logo from
107 KB to 15 KB; hash-compare the copies after refreshing). The banner is the
heaviest asset; re-encoding it at ~60-70% quality roughly halves it with no
visible loss if page weight ever matters. The wordmark in the banner is text,
not an image, so `logo.png` was retired with the old header brand.

**Badge art note (2026-09-24):** the four `pgk_*.webp` files arrived from the
owner at 130-157 KB each; they render at 28 px and are lazy-loaded, but that
size is heavy for icons -- a pass through the website's image optimizer
(target ~64x64, a few KB each) would cut roughly 95% of the badge weight.
`pgk_comnunity_trusted.webp` was renamed to `pgk_community_trusted.webp` (typo)
when it was wired in. All assets are XIOM project brand assets under the
repository's dual MIT OR Apache-2.0 license.
