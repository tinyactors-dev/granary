# 189. Build the release outside the repository

Date: 2026-09-28 · Status: accepted

## Context
`release:pack` exported HEAD into `release/work/src` inside the checkout and
built there. The build's tsconfig resolution reached the *outer* checkout's
generated `.svelte-kit/`, so packing worked on a developer machine (which has
one from `vite dev`) and failed on a fresh clone and in CI with 77
`RESOLVE_ERROR … Tsconfig not found` errors from svelte-adapter-bun. The
first run of the release workflow failed this way.

## Decision
The work directory is `$TMPDIR/granary-release-work`, outside any checkout,
so the build sees only the exported tree. Artifacts (`release/*.tgz`,
`meta.json`, `verify.json`) stay in `release/`.

## Consequences
Packs are hermetic; a fresh clone packs exactly like CI. Verified by packing a
fresh clone with no `.svelte-kit` anywhere.
