<!-- Copyright (c) 2026 Eleftherios Notas and The XIOM Authors -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# UI brand assets

Copied from the website repo (`xiom-lang/website`) so the registry UI uses the
same marks as xiom-lang.org. Re-copy from there when the brand assets change;
do not edit these binaries in this repo.

| File | Source | Used as |
|---|---|---|
| `logo.png` | `xiom-website/img/xiom-logo_bg.png` | header brand mark (24px) |
| `favicon.ico` | `xiom-website/img/xiom-icon.ico` | `/favicon.ico` (browser default request) |
| `favicon.png` | `site/assets/images/favicon.png` | 48x48 PNG icon linked in the page head |
| `icon.png` | `xiom-website/img/xiom-icon.png` | apple-touch-icon |
| `registry.webp` | `xiom-website/img/registry.webp` | page banner artwork (1539x510, 188 KB) |

Refresh all five after any website brand change (the website's `9190bf8`
optimization pass shrank the icon from 370 KB to 6.6 KB and the logo from
107 KB to 15 KB; hash-compare the copies after refreshing). The banner is the
heaviest asset; re-encoding it at ~60-70% quality roughly halves it with no
visible loss if page weight ever matters. All five are XIOM project brand
assets under the repository's dual MIT OR Apache-2.0 license.
