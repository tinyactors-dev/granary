# 110. M0 composition seam, shared DB opener, and M1–M4 ownership

Date: 2026-09-28 · Status: accepted · Partially supersedes 109 (db/open.ts owner; index importers), amends 102 (seed id format)

## Decision
- **`db/open.ts` is part of M0** (opens ops.sqlite with the pinned pragmas
  and applies `OPS_MIGRATIONS`), so the backups and health agents can both
  start immediately. Migrations are append-only; each agent appends its own
  migration *only* in its own milestone and only at the end of the list,
  coordinated through `db/ddl.ts` (small, targeted edits).
- **Feature seam** (`src/lib/ops/feature.ts`, ops-internal): each agent
  delivers an `OpsFeature` — I/O processors, loaders, `start/stop`, and its
  part of the OpsBackend (`OpsBackendBackups` / `OpsBackendHealth` from the
  contract). Cross-feature needs are interfaces: `SecretReader` (backups →
  health, for sink tokens) and `Redactor` (health → backups, registering
  revealed secret values). `index.ts` composes the features.
- **Who may import `$lib/ops/index`**: `src/lib/server/boot.ts` (real module)
  and `src/hooks.server.ts` (stub registration via `createStubOpsBackend()`,
  `GRANARY_STUB_OPS=1`). Enforced by `check:boundaries`.
- **Seed ids** are `seed-<name>` (`seed-r2`, `seed-s3`, `seed-all`,
  `seed-otlp`), not `seed:<name>`, because ids appear inside actor addresses
  and URIs (`OpsId` pattern `^[a-z0-9][a-z0-9-]{0,62}$`).
- **Ownership for M1–M4** (parallel; ADR number ranges in brackets):

| Agent | Owns | ADRs |
|---|---|---|
| A — backups (M1+M2) | `src/lib/ops/features/backups.ts`, `actors/{ops-config,backup-plan,backup-run,upload,retention,restore-drill}.ts`, `io/{snapshot,snapshot.worker,object-store}.ts`, `secrets/**`, `seeds.ts`, `backend/backups.ts`, `cli/restore.ts` + mise task `ops:restore`; tables destinations, backup_plans, budgets, secrets, ops_audit, backup_runs, uploads, restore_drills, egress | 0111–0119 |
| B — telemetry & self-healing (M3+M4) | `src/lib/ops/features/health.ts`, `actors/{telemetry-sink,watchdog,condition,remediator}.ts`, `io/{otlp,remediate}.ts`, `telemetry/**` (fan-out, redaction, sampling, metrics), `backend/health.ts`, `backend/index.ts` (composition), `index.ts` (assembly), `system.ts`; granary side: `src/lib/server/ops-health.ts` (HostHealth provider), wiring in `src/lib/server/boot.ts` and `src/lib/server/tracing.ts` (Tracer → `telemetrySink`, OTLP seed keeps today's behaviour); tables telemetry_sinks, conditions, ops_events, admin_visits | 0120–0129 |
| C — fake-infra | `fake-infra/**` (schemas.ts: additive only), pitchfork daemon `fake-infra` + mise task, `/__dev/infra` (`src/routes/__dev/infra/**`, `src/lib/components/dev/infra/**`, dev-portal nav entry, dev methods added to granary's dev Backend/remote/schemas — additive) | 0130–0139 |
| D — /ops UI | `src/routes/ops/**`, `src/lib/components/ops/**`, `src/lib/remote/ops.remote.ts`, the global "while you were away" banner in the root layout, the "Ops" nav entry, stub registration in `src/hooks.server.ts` (`GRANARY_STUB_OPS=1` → `setOpsBackend(await createStubOpsBackend())`) | 0140–0149 |

  Shared files (`mise.toml`, `pitchfork.toml`, `db/ddl.ts`, `contract.ts`,
  schemas): small targeted edits only, re-read before editing; contract
  changes are additive and reported. Integration + tests (ADR 0091/0103) are
  a fifth, final agent.
