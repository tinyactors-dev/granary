# 153. Ops scenario tests against fake-infra

Date: 2026-09-28 · Status: accepted

## Decision
- `useHarness({ infra: true })` also starts fake-infra (free ports for the
  main listener and both exe.dev fronts, seeds matching the app's ops seeds)
  and gives the app `GRANARY_DEV=1`, a test master key, the R2 seed, and fast
  timings (`OPS_WATCHDOG_INTERVAL_MS=300`, `OPS_TEST_GRACE_SCALE=0.0001`,
  `OPS_TEST_RETRY_BASE_MS=150`, `OPS_TEST_RETENTION_INTERVAL_MS=2000`).
  `opsSink` sends the seeded OTLP sink to the harness collector (default) or
  through the exe.dev token front. `prepare` runs before the app starts. The
  harness strips `OPS_*`/`FAKE_INFRA_*` from the inherited env.
- The collector accepts OTLP/JSON logs (ops' event log) and keeps raw
  payloads for leak checks.
- Scenarios (`tests/ops-*.test.ts`): boot backup → R2 + local, one manifest
  per run, drill ok, `granary-ops` spans; `ops:restore` round trip
  (integrity_check, row counts = manifest); upload 500s ×5 → retried →
  done; bad credentials → partial, `destination-auth` escalates, recovers
  after the fix; unencrypted planted backup refused (exit 2,
  `not-encrypted`); SIGKILL mid-upload and between artifact and manifest →
  one manifest, artifact not re-uploaded; retention of 200 synthetic 400 MB
  backups converges under 82 / 8 GiB keeping the real ones; 1 GiB budget →
  interval stretched + `handled` event; exe.dev proxy down → buffering,
  condition escalates, recovers; no secret in pages, OTLP, logs, ops.sqlite.
- `mise run test` runs files in parallel (`bun test --parallel=4`).
