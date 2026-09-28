# 187. Package identity: MIT, `@tinyactors/granary`, repo `tinyactors-dev/granary`

Date: 2026-09-28 · Status: accepted · Supersedes the pending parts of 0180, 0183

## Decision
Confirmed by the maintainer:
- License **MIT**, © Dario Hamidi.
- Package **`@tinyactors/granary`**, public, on npmjs.com.
- Source repository **https://github.com/tinyactors-dev/granary** (package
  `repository`, `homepage`, `bugs`; npm provenance requires the published
  `repository.url` to match the repository the workflow runs in).
- Laptop publishes carry **no provenance**; the manual GitHub Action publishes
  **with provenance** (ADR 0186).

All live in `RELEASE_DEFAULTS` (tools/release/common.ts).
