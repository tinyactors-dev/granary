# 171. Platform secret store: one envelope core, two adapters

Date: 2026-09-28 · Status: accepted · Implements 0158

## Decision
- `src/lib/platform/secrets/store.ts` holds `EnvelopeSecretStore`, the former
  ops store generalised: parameterised by `Database`, table name, an error
  factory (so ops keeps `OpsBackendError`, granary gets `BackendError`), an
  optional audit callback and redactor. `secretsTableSql(table)` is the shared
  DDL. It implements the pinned `PlatformSecrets`.
- ops keeps `SecretStore` in `src/lib/ops/secrets/store.ts` as a thin adapter
  (usedBy scan of destinations/sinks, `ops_audit` rows) — its API and data are
  unchanged; `crypto.ts`/`keys.ts` moved to the platform layer.
- granary opens its store over `granary.sqlite`'s `secrets` table in
  `boot.ts` (`src/lib/server/secrets.ts`: `getGranarySecrets()`,
  `masterKeyStatus()`); previous-key rewrap runs at boot. Secret operations
  are not written to `audit_log` (the GitHub connection audits its own
  changes).
- Master key sources: `GRANARY_MASTER_KEY` > `<data>/master.key`
  (> dev-generated `ops-master.key` in dev mode only). `granary init`
  generates **64 hex characters**; base64 keys remain accepted. The
  `OPS_MASTER_KEY*` names are still read (ADR 0157) — the user has since
  ruled out compatibility aliases, so the planned cleanup pass removes them
  together with `config/dev.env`, `fnox.toml` and the test harness.
- ops' "master key missing" signal now uses `masterKeyConfigured(env,
  dataDir)`, so a key from the new name or the file counts.
