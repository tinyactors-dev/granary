# 222. The manual is verified by walking through it

Date: 2026-09-28 · Status: accepted

## Context
ADR 0165 asks for a manual written against the implemented product. E6
installed the packed tarball (`release:pack`) into a scratch Bun prefix and
followed the manual step by step against the fake GitHub and fake-infra.

## Decision
- The manual recommends a **system-wide Bun under `/opt/bun`** (install
  script with `BUN_INSTALL=/opt/bun`, package installed with the same
  prefix, symlinks in `/usr/local/bin`), because the systemd unit hides home
  directories (`ProtectHome=true`) and the service user needs the binaries.
- `docs/manual/cli.md` is generated from the CLI catalogue by
  `mise run docs:cli` (`tools/docs/cli.ts`, `--check` for staleness).
- Fixes the walkthrough found in the product: `granary version` accepts
  `--data` like every command; the ops UI accepts S3 endpoints with a path
  (as the schema always did); restored database files are written with
  mode 0600; the systemd unit's `Documentation=` points at the
  tinyactors-dev/granary manual.
- Fixes in the manual: the login-link button is **Continue**; destinations
  and sinks are saved disabled and are enabled after a passing test; new
  destinations must be added to a plan (first start creates a local-copy
  destination and an *All databases* plan); the default prefix is `prod/`.
- The admin socket path limit (~100 bytes) is documented in
  troubleshooting.

## Consequences
Every step of install → first run → GitHub App → repo switches → backups
→ restore (both modes) → telemetry → disconnect was exercised on the
packed build. exe.dev-specific commands come from exe.dev's docs and were
not run.
