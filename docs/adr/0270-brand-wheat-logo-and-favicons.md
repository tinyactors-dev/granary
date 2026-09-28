# 270. Brand: a colored wheat logo, favicons and app icons, generated from one source

Date: 2026-09-28 · Status: accepted

## Context
The app shell showed Lucide's `wheat` icon (white on the theme's primary
color) and the favicon was an unrelated placeholder. The user wants that wheat
as the favicon and logo, colored to look like real wheat, in SVG and webp at
128, 512 and 1024 px.

## Decision
- **Geometry**: Lucide's `wheat` paths (24×24, ISC), unchanged. Added detail:
  a thin crease along each grain, drawn only at larger sizes.
- **Colors**: grains with a pale-gold → amber gradient (`#FBE08A` →
  `#F2B63F` → `#D98A1E`) and burnt-ochre outlines (`#8A4F12`); straw stalk
  (`#C89A45`) with a darker edge; tile background a warm near-black gradient
  (`#2E2419` → `#15100B`), which is also the manifest's theme color.
- **Variants** (`tools/brand/render.ts`, the single source):
  - `tile` — the wheat on the rounded dark square. It's the logo everywhere:
    app shell, sign-in page, `favicon.svg`, `static/brand/granary.svg` and
    `granary-{128,512,1024}.webp`. Its own background keeps it identical and
    legible on light and dark themes and on any browser tab bar (in dark mode
    the app adds a faint ring so the tile keeps its edge on the dark sidebar).
  - `mark` — transparent (`granary-mark.svg`, `granary-mark-{128,512,1024}.webp`)
    for places that bring their own background.
  - `small` — thicker stalk, no outlines or creases, larger in the tile: for
    16–48 px (`favicon.ico` with 16/32/48 PNGs, `favicon-32.png`), where
    outlines turn to mud.
  - `full` — full-bleed square with the wheat inside the maskable safe zone:
    `apple-touch-icon.png` (180) and the manifest's maskable 512 icon.
- **Web app manifest** `static/manifest.webmanifest` (192/512 PNG, maskable
  512, SVG); `src/app.html` links ico + svg favicons, the apple-touch-icon,
  the manifest and `theme-color`.
- **Rendering**: `sharp` (libvips + librsvg, prebuilt per platform) as a dev
  dependency. The mise-installable `resvg` (aqua) ships x86-64 macOS binaries
  only and doesn't run on arm64 without Rosetta, so it was not used. webp is
  lossless. `favicon.ico` is assembled by the script (PNG-in-ICO).
- **Regenerate**: `mise run brand:render` rewrites everything in `static/`;
  `mise run brand:preview -- <out.png>` renders a contact sheet (tile, mark on
  light and dark, favicon at 16/32 px) for review. The generated files are
  committed.

## Consequences
Changing colors or detail is one edit in `tools/brand/render.ts` plus a
re-render. The READMEs show the 128 px webp (the npm README via a raw GitHub
URL).
