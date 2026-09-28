# 89. Ops keeps its own durable state in ops.sqlite

Date: 2026-09-28 · Status: proposed · Partially superseded by 101

## Decision
- A separate SQLite file `OPS_DATABASE_PATH` (default `<dataDir>/ops.sqlite`),
  same pragmas as granary (WAL, `synchronous=FULL`). Separate from granary's
  DB so the two domains can be migrated, restored and reasoned about
  independently, and so a granary restore never rolls back ops history.
- Tables: config (`destinations`, `backup_plans`, `retention_policies`,
  `telemetry_sinks`, `notify_channels`, `alert_rules`, `silences`,
  `heartbeats`), `secrets`, `ops_audit`, `backup_runs`, `uploads`,
  `restore_drills`, `alert_state`, `alert_events`, `notifications`
  (outbox: dedupe key, channel, payload, state, attempts, next_attempt_at),
  `kv` (e.g. unflushed telemetry gauge at shutdown). JSON columns validated
  with TypeBox, like granary's WAL (ADR 0003).
- Actors are rebuilt from these rows by loaders (`backup-run`, `upload`) or
  spawned at boot from config (the rest), exactly like granary's issue
  loader. Delayed sends (schedules, retries) are *derived* from rows
  (`next_attempt_at`, last run times), never trusted to survive restarts.
- The spool directory `<dataDir>/ops-spool/` holds snapshot files; anything
  there not referenced by a non-terminal run is deleted at boot and daily.
- Write-before-effect, as in ADR 0003: a run/upload/notification row is
  committed before the I/O processor acts on it.

## Consequences
Two SQLite files to back up; both are in the default plan (ADR 0083).
