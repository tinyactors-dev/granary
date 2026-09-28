# 92. Ops admin UI and its OpsBackend seam

Date: 2026-09-28 · Status: proposed

## Decision
- Pages under `/ops` (admins only; read-only for signed-in non-admins):
  - `/ops` — **"Can I sleep?"**: big yes/no from `status().sleepOk` with
    reasons, firing alerts, last verified backup per destination, last drill,
    heartbeat, telemetry health.
  - `/ops/backups` — plans, run timeline (states per run/upload), "back up
    now", manifest viewer (JsonView), presigned download link (admin, 5 min),
    restore instructions for that artifact.
  - `/ops/destinations` — CRUD, test connection (step-by-step checklist:
    PUT/stat/list/GET/DELETE, versioning/lifecycle advice), retention editor
    with dry-run preview.
  - `/ops/telemetry` — sinks, per-signal throughput, drop counters, circuit
    state, "send test event" and a deep link to the Grafana Explore query.
  - `/ops/alerts` — rules, thresholds, firing/pending, history, silences.
  - `/ops/notifications` — channels, routing, quiet hours, "send test".
  - `/ops/secrets` — refs with fingerprint/last used/last ok, replace, KEK
    rotation status. Never shows values.
  - `/ops/drills` — restore drill history, RPO/RTO trend.
- **Seam**: `OpsBackend` interface in `$lib/ops/contract.ts` (like ADR 0032's
  `Backend`), implemented by `src/lib/ops/backend.ts`, with
  `backend.stub.ts` for UI work. Remote functions live in
  `src/lib/remote/ops.remote.ts`, validate with TypeBox via `standard()`,
  authorize with `requireAdmin()`/`requireUser()` and delegate. Secret inputs
  are `form` fields posted once; responses never echo them.
- The ops module's actors appear in `/actors` and the inspector only if the
  inspector is taught about a second System — deferred; ops gets its own
  `/ops/actors` read-only list reusing the inspector components.
- The dev portal gains an **Infra** area (`/__dev/infra`) mirroring
  `/__dev/github` for fake-infra: buckets, objects, received telemetry,
  pings, fault injection.

## Consequences
Ops UI can be built against the stub in parallel with the actors.
