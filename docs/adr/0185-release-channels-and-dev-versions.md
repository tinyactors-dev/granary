# 185. Release channels: `dev` for frequent builds, `latest` for stable releases

Date: 2026-09-28 · Status: accepted

## Context
The maintainer wants to publish often without hand-editing versions, while
installs of `@tinyactors/granary` (no tag) must only ever get deliberate,
stable releases.

## Decision
- Two channels, each an npm **dist-tag**: `dev` and `latest`.
- **dev** versions are computed, never committed:
  `<base>-dev.<unix epoch seconds>.g<short sha>`, e.g.
  `0.1.0-dev.1790600000.ga1b2c3d`.
  - `base` = package.json's version, or its **next patch** once that version
    is already published (e.g. after `0.1.0` is out, dev builds are
    `0.1.1-dev.…`), so a dev build always sorts above the newest stable one.
  - The epoch makes successive dev builds of one base sort in time order
    (SemVer compares numeric prerelease identifiers numerically).
  - The sha carries a `g` prefix (as in `git describe`) so the identifier is
    always alphanumeric: an all-digit sha with a leading zero would be an
    invalid SemVer numeric identifier.
  - Requirements: clean tree, packed from git at HEAD, verified, not already
    published. No git tag and no CHANGELOG entry needed.
- **latest** uses package.json's version unchanged and keeps ADR 0182's
  checks: clean tree, tag `v<version>` on HEAD, dated CHANGELOG entry, not
  already published, verified.
- The version is stamped into the **exported** package.json before the build
  (release:pack), so the server (`/healthz`) and the CLI (`granary version`),
  which bundle it via `src/lib/version.ts`, report exactly the published
  version. The repository's package.json is never modified.
- `release:pack --channel latest|dev` (default latest, so the existing
  `release:pack` behaves as before), `--version` overrides for experiments.
  release/meta.json records the channel; release:publish refuses a tarball
  packed for another channel.

## Consequences
Anyone can opt into the stream with `bun add -g @tinyactors/granary@dev`.
Dev versions pile up on the registry; that is fine for npm (and prunable with
`npm unpublish` within 72 h if ever needed).
