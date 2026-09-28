# 156. Ship granary as a public npm package run by Bun

Date: 2026-09-28 · Status: accepted

## Context
granary must be installable on any Linux host that has Bun (exe.dev VM is one
example, not a dependency). The native tinyactors addon ships per-platform
npm packages, and svelte-adapter-bun output needs `node_modules` beside it
(ADR 0022). A Docker image would add a registry, an image build and a
container runtime without solving anything Bun + npm don't already solve.

## Decision
- **No Docker image.** Distribution is an npm package; the host needs Bun
  (`>= 1.4.1`, checked by `granary doctor` and at `serve` start).
- **Name/registry:** `@tinyactors/granary` on npmjs.com (public, scope already
  owned by the tinyactors org; GitHub Packages' npm registry requires auth even
  for public installs). Source lives in the tinyactors GitHub org.
- **Install:** `bun add -g @tinyactors/granary` (or `bun install` into
  `/opt/granary` with a pinned version for systemd). Bun installs the matching
  `@tinyactors/node-<platform>` optional dependency.
- **`bin`:** `granary` → `dist/cli.js` (one file, `bun build --target bun`,
  shebang `#!/usr/bin/env bun`). `granary serve` imports the server entry from
  `build/` (svelte-adapter-bun output) in-process.
- **Tarball contents** (`files` in the published package.json):
  `build/**`, `dist/cli.js`, `README.md`, `LICENSE`, `docs/manual/**`.
  Runtime `dependencies`: `@tinyactors/node`, `@sinclair/typebox` (plus
  anything the server bundle leaves external). Everything else is a
  devDependency. SQLite migrations are code inside the bundle (no files).
- **Not shipped:** `fake-github/`, `fake-infra/`, `loadgen/`, `tests/`, the
  `/__dev` tooling data sources (the routes exist but are 404 outside dev mode,
  ADR 0009). The fakes stay repository-only; a separate dev package can be
  cut later if someone needs them.
- **Publishing manifest:** the repo's `package.json` stays the dev manifest;
  `mise run release:pack` generates `release/package.json` (name, version,
  bin, files, engines `{ "bun": ">=1.4.1" }`, runtime deps pinned to the lock
  file's versions), builds, and runs `bun pm pack` into `release/*.tgz`.
- **Versioning:** SemVer, starting `0.1.0`; git tag `v<version>`;
  CHANGELOG entry required. `release:publish` = `release:verify` then
  `npm publish --access public --provenance` (provenance only from CI;
  locally `--provenance` is skipped) with `NPM_TOKEN` from fnox (`prod`
  profile, 1Password reference).
- **`release:verify`:** installs the packed tarball on a clean
  `oven/bun:<version>` Linux container (docker via colima, verification only,
  run under pitchfork per the PROCESS RULES), runs `granary init --yes` with a
  temp data dir, starts `granary serve`, waits for `/readyz`, runs
  `granary doctor`, then stops it. Must pass on linux-x64 and linux-arm64
  (`--platform`).

## Consequences
Upgrades are `bun add -g @tinyactors/granary@<v>` + restart. The dev repo
layout does not change; release artefacts live in `release/` (gitignored).
