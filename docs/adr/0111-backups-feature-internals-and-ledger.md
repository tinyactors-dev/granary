# 111. Backups feature internals: pure charts, a ledger processor, one runtime

Date: 2026-09-28 · Status: accepted · Amends 82, 101 (topology details), 110 (A's file list)

## Context
ADR 0082 wants all side effects in I/O processors and actors rebuilt from
ops.sqlite rows. Persisting run/upload/drill state and spawning per-item actors
are side effects too, and several charts need them.

## Decision
- **Charts stay pure.** Every persisted transition is an explicit, traced
  request to an I/O processor; charts never touch SQLite, files or the network.
  A third processor type `backup-ledger` (added to `OPS_IO`) owns the backups
  feature's writes and its effects on the ops System:
  `config.reconcile`, `plan.dispatch`, `plan.refresh-interval`, `run.uploads`,
  `run.finalize`, `upload.record-retry`, `upload.record-failed`.
  `snapshot` also answers `drill.check`; `object-store` also answers
  `store.verify`, `retention.pass`, `drill.fetch`.
- **Write-before-effect**: the ledger commits rows before it posts the mail that
  depends on them (a `backup_runs` row exists before `run.start`; `uploads`
  rows before `upload.start`), so the `backup-run` / `upload` loaders can
  always rebuild a virtual actor from its row.
- **Catalogue additions** (all additive, `schemas/events.ts`): the requests
  and replies above, `RunTrigger`, exported `RawSnapshot`, optional
  `artifactKey` on `upload.start`, optional `manifest` on `drill.fetched`,
  optional `floorExceedsCap`/`unknownObjects`/`error` on `retention.pass-done`.
  Internal raises `retention.next` / `drill.next` are not catalogued.
- **Long-lived actors follow the rows** (`ops-config/main` → ledger
  `config.reconcile`): `backup-plan/*`, `retention/*` (enabled destinations),
  `restore-drill/*` are spawned through `ctx.spawn`; a changed row replaces its
  actor in place with `prepareReplacement(...).activate()` (queued mail moves
  over; delayed sends are re-derived from the new binding); stale ones are
  destroyed. Schedules are derived from rows (last started run, last drill),
  never trusted to survive restarts (ADR 0089).
- **Layout**: `actors/` (one file per actor), `io/{snapshot,snapshot.worker,
  object-store,backup-ledger}.ts`, `secrets/`, and feature-private helpers in
  `backups/` (repo, runtime, seal, stores, retention-plan, restore, worker,
  disk, test-connection, remediations). `features/backups.ts` exports
  `createBackupsFeature(options)` and `backupsFeature(env)` for `index.ts`.
- **Test knobs** (env, additive to `OpsEnv`): `OPS_TEST_RETRY_BASE_MS`,
  `OPS_TEST_RETENTION_INTERVAL_MS` (production defaults 30 s / 24 h).
- On boot the feature re-posts `run.start` to every non-terminal run; the
  loader restores it where its row says (crash table, ADR 0082).

## Consequences
Traces show every persistence step as a send; the actor inspector sees plain
data. The ledger is the one place to look for "who wrote this row".
