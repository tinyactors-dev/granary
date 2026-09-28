# 182. release:publish never publishes implicitly

Date: 2026-09-28 · Status: accepted

## Decision
- `mise run release:publish` runs `fnox exec -P release -- bun
  tools/release/publish.ts`. Without `-- --yes` it is a **dry run**
  (`bun publish --dry-run`). With `--yes` it publishes the packed tarball with
  `bun publish <tgz> --access public`.
- It refuses unless all hold: clean git tree; HEAD tagged `v<version>`;
  `CHANGELOG.md` has `## [<version>] - <date>` not marked unreleased; the
  tarball was packed from git (not the working tree) at HEAD, without the CLI
  placeholder, and its sha256 still matches; `release/verify.json` passed for
  that exact tarball on every platform; the version is not on the registry;
  `NPM_TOKEN` is set (for `--yes`).
- **Token:** `NPM_TOKEN` lives in a separate fnox profile **`release`**
  (1Password `granary/npm-token`, an npm granular token limited to publishing
  `@tinyactors/granary`), not in `prod` as ADR 0156 suggested — the running
  server must never receive a publish token. It is passed to Bun as
  `NPM_CONFIG_TOKEN` for the publish process only.

## Consequences
Releasing is: bump `version`, date the CHANGELOG entry, commit, tag,
`release:pack`, `release:verify`, `release:publish`, then `-- --yes`.
