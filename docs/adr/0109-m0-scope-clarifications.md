# 109. M0 scope clarifications

Date: 2026-09-28 · Status: accepted · Amends 105 (M0)

## Decision
- **ops.sqlite DDL is pinned in M0** (`src/lib/ops/db/ddl.ts`: table
  definitions + migration list, plus TypeBox row schemas), because the backups
  agent (runs, uploads, secrets) and the telemetry/remediation agent
  (conditions, ops_events, admin_visits) both write to it. The *code* that
  opens and migrates the DB (`db/open.ts`) belongs to the backups agent.
- **Ops env schema lives in ops** (`src/lib/ops/schemas/env.ts`, read from
  `OpsHost.env`), not in granary's `$lib/schemas/config.ts` — keeps the
  boundary one-way.
- **No granary wiring in M0**: `createOps` exists (no-op module) but
  `boot.ts`/`tracing.ts` are not touched yet; the telemetry agent wires the
  Tracer → `telemetrySink` and `boot.ts` → `createOps` in its milestone, with
  the OTLP seed preserving today's behaviour. Reason: M0 must be
  behaviour-neutral and must not collide with server files other agents are
  editing.
- The `OpsBackend` registry (`setOpsBackend`/`getOpsBackend`) lives in
  `contract.ts` so remote functions and pages import only the contract.
