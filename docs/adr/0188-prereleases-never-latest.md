# 188. A prerelease never becomes `latest`; `release:promote` moves `latest`

Date: 2026-09-28 · Status: accepted

## Context
npm's `latest` dist-tag is what `bun add @tinyactors/granary` installs. npm
points `latest` at a package's **first** published version whatever `--tag`
says, and nothing else stops a prerelease from being tagged `latest`.

## Decision
- release:pack refuses a prerelease version for the latest channel.
- release:publish refuses: a prerelease on `latest`; any `dev` publish while
  the package has no stable `latest` yet (so the first-ever publish must be a
  stable release); and after a real publish it re-reads the dist-tags and
  fails loudly if `latest` is a prerelease.
- `mise run release:promote -- <version> [--yes]` points `latest` at an
  existing stable version (rollback / repair); refuses prereleases and
  versions not on the registry.

## Consequences
The very first publish of `@tinyactors/granary` is `0.1.0` on `latest`; dev
builds are possible from then on.
