# 91. Ops tests: running systems, fakes, traces, restore drills

Date: 2026-09-28 · Status: proposed · Partially superseded by 103

## Decision
Consistent with ADR 0007: no unit tests; the harness (`tests/harness.ts`,
extended additively) starts the app, fake-github, **fake-infra** and the OTLP
collector; tests drive only external surfaces (fake-infra control API, the
ops admin HTTP surface via the same remote-function-free JSON endpoints the
dev portal uses, and signals over time) and assert on traces
(`service.name=granary-ops`, actor addresses per ADR 0082) plus fake-infra
state. Seeds (ADR 0087) configure destinations/sinks per test. A manual
clock is not available across processes, so plans in tests use short
intervals (`5s`) and `OPS_WATCHDOG_INTERVAL_MS`.

Scenarios:
1. **Restore drill end-to-end**: seed data via fake-github issues → backup
   → upload → drill: download, decrypt, sha256, `integrity_check`, row counts
   equal the live DB at snapshot time (manifest) → `restore-drill/<dest>` in
   `idle` with `lastResult=ok`.
2. **CLI restore**: `mise run ops:restore -- --dest seed:s3 --latest --out x.sqlite`
   against fake-infra, open result, compare counts.
3. **Upload 5xx ×3** → `upload/*` passes through `retry_wait` → `done`; one
   manifest; no duplicate objects.
4. **Credential rotation**: revoke key in fake-infra → auth alert fires
   (crit) → notification recorded at `/hooks/…` exactly once → set new key in
   UI seam → test connection ok → alert resolves → resolved notification.
5. **Disk full** (object store quota) → run `partial`/`failed`, alert fires,
   retention does not prune ("don't prune when sick").
6. **Local disk low**: spool pointed at a tiny tmpfs-like dir (or statfs
   override hook in test mode) → run refused `disk-insufficient`.
7. **Loki/OTLP down** → sink `backoff`/`open`, drop counters rise, granary
   issue handling unaffected (issue actors still reach `closed`), recovery
   drains buffer.
8. **Crash mid-backup**: SIGKILL app during `snapshotting`/`uploading`
   (latency fault holds the upload) → restart → exactly one committed
   manifest for that run, spool cleaned.
9. **Crash between data PUT and manifest PUT** (fault on manifest PUT +
   kill) → restart → manifest written without re-upload (fake-infra PUT count).
10. **Heartbeat**: pings arrive; a crit alert stops pings; resolution resumes.
11. **Retention**: many runs with a fake clock offset on object timestamps →
    GFS keeps the expected set; newest never deleted.
12. **Secrets never leak**: after all scenarios, grep every OTLP batch the
    collector and fake-infra received, all app logs, and all HTTP responses
    for the plaintext secret values used → zero hits.

Real-infra contract suite (opt-in): scenarios 1, 3 (fault-free subset),
and sink delivery verified by querying Loki/Tempo/Prometheus through Grafana.

## Consequences
Ops tests are slower (seconds-scale schedules); they run in their own test
files so they can be skipped with a filter while iterating on granary.
