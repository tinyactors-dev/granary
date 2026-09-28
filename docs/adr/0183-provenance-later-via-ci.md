# 183. Publish from the laptop without provenance for now; CI + provenance later

Date: 2026-09-28 · Status: superseded by 0186, 0187

## Context
npm provenance attestations need an OIDC-capable CI (GitHub Actions or
GitLab) to sign the build; they cannot be produced from a laptop. The source
has no public repository yet.

## Decision
- Until the source lives at `github.com/tinyactors/granary`, releases are
  published from the maintainer's machine **without provenance**
  (`RELEASE_DEFAULTS.provenance = false`).
- Switching later: add a GitHub Actions workflow on tag push that runs
  `mise run release:pack`, `release:verify` (native amd64 + arm64 runners,
  no emulation needed) and publishes with `npm publish --provenance --access
  public` using a trusted-publisher configuration on npmjs.com (no long-lived
  token); set `provenance: true` and make `publish.ts` refuse local runs.

## Consequences
Early versions carry no provenance badge; installs are unaffected.
