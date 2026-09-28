# 118. Backups seeds and OpsBackend semantics

Date: 2026-09-28 · Status: accepted · Amends 102, 110

## Decision
- Seeds (create-if-absent, `origin:'seed'`): `seed-r2` (kind `r2`, EU
  jurisdiction by default), `seed-s3` (generic), always `seed-local`
  (`local-dir` at `<dataDir>/backups`, one copy) and plan `seed-all` over all
  databases (granary + `ops` itself) → every seeded destination. Seeded
  destinations are enabled without a UI test connection (env-provided config
  is trusted); UI-created destinations start disabled and can only be enabled
  when the last test passed for the current version with unchanged settings.
  Budgets are seeded from `OPS_SEED_EGRESS_BUDGET_GIB`.
- Changing only name/enabled/retention/caps keeps a passed test valid for the
  new version; changing settings invalidates it (an already enabled
  destination stays enabled).
- `runBackupNow` / `runDrillNow` post to the actor and wait (≤ 5 s) for the
  rows the ledger / object-store insert; a refused dispatch surfaces as
  `unavailable` with the recorded reason.
- `getDownloadLink` presigns a 15-minute GET of the (encrypted) artifact;
  local copies have none. `importConfig` creates missing destinations
  (disabled) and plans, skips existing ones and telemetry sinks, and lists
  secret refs that must be set.
- Projections: steady state = GFS count for the effective interval (capped) ×
  databases × average sealed size of the last 20 uploads; growth from a
  linear fit of the last 14 days; egress = average sealed × databases × runs
  per month for the effective interval.
