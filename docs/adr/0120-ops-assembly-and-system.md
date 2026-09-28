# 120. Ops assembly: features, the ops System, failure isolation

Date: 2026-09-28 · Status: accepted · Implements 81, 109, 110

## Decision
- `createOps(host)` (`src/lib/ops/index.ts`) composes two features:
  **health** (this ADR range) and **backups** (`backupsFeature(host.env)`,
  ADR 0111–0118), through the `OpsFeature` seam. `optionalBackupsFeature()`
  is the one place to drop backups; without it, its OpsBackend methods
  reject `unavailable` (`backend/index.ts` `composeBackend`) and
  `SecretReader.reveal` rejects.
- **Feature isolation**: health must start (otherwise `start()` rejects);
  any other feature that throws while creating its secret reader or
  starting (e.g. a malformed `OPS_MASTER_KEY`) is logged, stopped, left out
  of the backend and of remediation dispatch, and reported by `status()`
  (`mode: 'degraded'`, reason "The backups feature failed to start: …"),
  while telemetry and conditions keep running.
- Start order: open `ops.sqlite` (`OPS_DATABASE_PATH`, default
  `<dataDir>/ops.sqlite`) → redactor (health) → secrets (backups) → ops
  System with every feature's I/O processors → loaders (wrapped to remember
  addresses) → `feature.start(ctx)` in order (health first) → backend and
  telemetry sink. `module.backend` and `module.telemetrySink` are stable
  delegates, usable before/after start (unavailable / dropped).
- `OpsContext` gains (additive, ops-internal) `spawn(definition, address,
  binding)` and `excludeFromTraces(definition)`; `OpsFeature` gains optional
  `remediations` (ADR 0123). `BackupsFeature.secrets(ctx)` no longer needs
  `spawn`.
- The ops System (`system.ts`) has its own trace sink:
  `service.name=granary-ops`, `detail: 'summary'`, `values: false`,
  `logs: false` (ops facts reach Loki as ops-event log lines instead, ADR
  0121). Spans of excluded definitions (the telemetry-sink family) are cut
  out on the wire before export (loop breaking, ADR 0093). The ops trace
  sink does no work unless an enabled sink takes ops telemetry.
- Faulted ops actors are destroyed so the next mail reloads them from
  ops.sqlite; dead letters for finished actors are expected and not logged.
- **Isolation**: `boot.ts` starts ops after granary's runtime; if
  `ops.start()` throws, granary logs it and continues, the OpsBackend stays
  unregistered (ops pages show "unavailable"), and the Tracer keeps POSTing
  to `OTEL_EXPORTER_OTLP_ENDPOINT` itself (today's behaviour).

## Consequences
Dropping or adding a feature is a one-line change in `index.ts`. Ops can never stop
granary from booting.
