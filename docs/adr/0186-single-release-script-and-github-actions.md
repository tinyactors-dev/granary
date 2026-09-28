# 186. One release script, run from the laptop or a manual GitHub Action

Date: 2026-09-28 · Status: accepted · Supersedes 0183

## Context
Releases should be possible from the maintainer's machine (no provenance)
and from CI with npm provenance, without two diverging pipelines. `bun
publish` cannot produce provenance attestations.

## Decision
- **Single entry point:** `tools/release/release.ts [all|pack|verify|publish]
  --channel dev|latest [--yes] [--provenance] [--accept-unverified …]`
  (`mise run release -- …`). `all` = pack → verify → publish; publish is a
  dry run without `--yes`. The existing `release:pack|verify|publish` tasks
  remain and are what the steps call.
- **Upload with the npm CLI** in both modes (`npm publish <tgz> --tag
  <channel>`; `npm` from PATH, else `bunx npm@latest`), so laptop and CI
  publish the same way; only CI adds `--provenance`.
- **Credentials:** a throwaway `--userconfig` containing
  `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` — npm expands the variable,
  the token never touches disk. Locally the npm process runs under `fnox exec
  -P release` (only when `--yes`, so dry runs need no 1Password). In CI:
  **npm trusted publishing** (OIDC, no long-lived token) when configured on
  npmjs.com for `tinyactors-dev/granary` + `release.yml`; otherwise the
  repository secret `NPM_TOKEN`.
- `--provenance` is refused outside GitHub Actions with `id-token: write`.
- **Workflow** `.github/workflows/release.yml`, `workflow_dispatch` only,
  inputs `channel` (dev | latest, default dev) and `dry_run` (default true):
  - `pack` (ubuntu-latest): `release.ts pack` → artifact (tarball + meta).
  - `verify` (matrix: `ubuntu-latest` → linux/amd64, `ubuntu-24.04-arm` →
    linux/arm64): `release.ts verify --platform … --out
    release/verify-<arch>.json` — both architectures natively, so CI releases
    need no `--accept-unverified`.
  - `publish` (ubuntu-latest, Node 24 for npm ≥ 11.5, `id-token: write`):
    `release.ts publish --channel … --provenance [--yes]`.
  - Bun is pinned by `.bun-version` (setup-bun reads it; the release tooling
    derives the minimum engine and the verify image from it).
- **CI verify** runs containers as child processes of the script (`CI=true`)
  instead of pitchfork daemons: nothing else runs on a CI runner, and the
  script reaps them. Locally the pitchfork path (PROCESS RULES) is unchanged.
- release:publish merges `release/verify.json` and `release/verify-*.json`
  for the same tarball sha256 by platform.

## Consequences
Laptop releases: `mise run release -- --channel dev --yes --accept-unverified
linux/amd64` (amd64 cannot be verified on Apple silicon, ADR 0184). CI
releases get provenance and native verification on both architectures.
