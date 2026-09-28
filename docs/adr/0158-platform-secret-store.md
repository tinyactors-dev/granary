# 158. The encrypted secret store becomes a platform service

Date: 2026-09-28 · Status: accepted · Amends 0086, 0117, 0110 (ownership)

## Context
GitHub App credentials (private key, webhook secret, client secret) must be
stored encrypted like ops secrets. The store lives in `src/lib/ops/secrets/`,
behind the ops boundary, and ops failing to start must never stop granary
(ADR 0121) — so granary cannot depend on the ops module for its own secrets.

## Decision
- New leaf layer **`src/lib/platform/`**: code both granary and ops may
  import, which itself imports neither (`$lib/server/**`, `$lib/ops/**`) —
  only `$lib/schemas/**` leaf schemas and npm packages. Enforced by a new
  ast-grep rule `platform-is-a-leaf.yml`; `ops-no-granary-internals` gains an
  allowance for `$lib/platform/**`.
- `src/lib/ops/secrets/{crypto,keys,store}.ts` move to
  `src/lib/platform/secrets/` unchanged in behaviour; the store is
  parameterised by a `Database` and table name. ops keeps its secrets in
  `ops.sqlite` (no data migration); granary gets its own `secrets` table in
  `granary.sqlite`. Both use the same master key(s) (ADR 0157).
- The pinned interface is `PlatformSecrets` in
  `src/lib/platform/secrets/contract.ts` (write-only from the UI's point of
  view: `set`, `delete`, `list` metadata, `has`; plaintext only via
  `reveal(ref)` inside server-side I/O code, never in a DTO).
- Secret refs for the GitHub connection are fixed ids:
  `github-app-private-key`, `github-app-webhook-secret`,
  `github-app-client-secret`, and for token mode `github-token`,
  `github-webhook-secret`, `github-oauth-client-secret`.

## Consequences
One implementation, two stores. The move is done by the platform fork (E1)
in a single commit that keeps ops' tests green.
