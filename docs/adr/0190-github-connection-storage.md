# 190. GitHub connection storage: own tables and schema steps

Date: 2026-09-28 · Status: accepted · Refines 0160, 0166

## Context
ADR 0166 gives E3 "granary.sqlite migrations for `github_app`,
`github_installations`, `github_repos`, `manifest_states`", while E1 appends
its own migrations (admins, login links, audit, secrets, settings) to the
WAL's ordered `user_version` list at the same time. Two forks appending to
one ordered list races for migration indexes.

## Decision
- The GitHub tables are created by `ensureGitHubSchema()`
  (`src/lib/server/github/schema.ts`) with `CREATE TABLE IF NOT EXISTS`,
  outside the WAL's `user_version` list. Later changes append steps to
  `GITHUB_SCHEMA_STEPS`; the applied count is stored under `schema.steps`.
- **Configuration** (`github.mode`, token-mode `github.token.oauthClientId`)
  lives in the platform `settings` kv (ADR 0157; same DDL repeated with
  `IF NOT EXISTS` so the module works before/without the platform migration),
  so `granary config set github.mode none` disconnects. The mode is read from
  the table on every use; a CLI change applies at once (the catch-up actor
  just fails its passes outside app mode). **Internal state** (catch-up
  checkpoint and pass status, schema step count) lives in `github_settings`.
- `GitHubStore` (`src/lib/server/github/store.ts`) validates every row it
  reads with the pinned row schemas.

## Consequences
No migration-order coupling with the platform fork. Anyone needing the mode
reads `settings['github.mode']` or asks `getRuntime().github.mode()`.
