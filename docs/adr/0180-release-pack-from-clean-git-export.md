# 180. release:pack builds from a clean git export with a generated manifest

Date: 2026-09-28 · Status: accepted (defaults confirmed in 0187) · Partially superseded by 230 (env names, GitHub token mode, migrations)

## Context
ADR 0156 decides to ship `@tinyactors/granary` on npm. The repository's own
`package.json` is a private development manifest full of devDependencies, and
the developer's `build/` is shared with the test suite and may contain
uncommitted work.

## Decision
- `mise run release:pack` (`tools/release/pack.ts`) exports a git ref
  (default `HEAD`) with `git archive` into `release/work/src`, runs
  `bun install --frozen-lockfile`, `bun --bun vite build` and the `cli` mise
  task (→ `dist/cli.js`), then stages `release/package/` and runs
  `bun pm pack` → `release/<scope>-granary-<version>.tgz`. Only committed code
  ships; the dev `build/` is never touched. `--working-tree` packs
  uncommitted files for experiments (marked dirty; publish refuses it).
- The published `package.json` is **generated**: name, version (from the root
  `package.json` `version`), description, license, repository, `type:
  module`, `bin: { granary: dist/cli.js }`, `files` (`build/`, `dist/`,
  `docs/manual/` when present, README, LICENSE, CHANGELOG), `engines.bun`,
  `publishConfig`, and `dependencies` = every bare specifier the server/CLI
  bundles import (found with `Bun.Transpiler.scanImports`, so JSDoc and strings
  don't count), **pinned to the exact versions the lockfile resolved**. Today
  that is `@tinyactors/node` and `@sinclair/typebox`. The package README is
  `tools/release/README.package.md`.
- Missing `dist/cli.js` fails the pack; `--allow-missing-cli` stages a
  placeholder that exits 70 (pipeline testing only; publish refuses it).
- `release/meta.json` records version, git sha, source, sha256, placeholder
  flag and pinned dependencies; `release/` is gitignored (anchored `/release/`
  so `tools/release/` is tracked).
- **Defaults awaiting confirmation** live in one place,
  `RELEASE_DEFAULTS` in `tools/release/common.ts`: package name
  `@tinyactors/granary`, MIT license (© Dario Hamidi), repository
  `https://github.com/tinyactors-dev/granary` (ADR 0187), public access on
  `registry.npmjs.org`, `bun >=1.4.1`.

## Consequences
A release is reproducible from a tag. Adding a runtime import of a new package
automatically adds it (pinned) to the published dependencies; it must be in
the root `dependencies` or pack fails loudly.
