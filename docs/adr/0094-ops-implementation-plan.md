# 94. Ops implementation plan and parallelisation

Date: 2026-09-28 · Status: Superseded by 105

## Pin first (one agent, sequential)
M0 — **Contract & schemas**: `src/lib/ops/contract.ts` (OpsHost, OpsModule,
TelemetryBatch/Source/Sink, HostHealthSnapshot, OpsStatus, OpsBackend),
`src/lib/ops/schemas/*` (config rows, runs, uploads, manifest, alerts,
notifications, secrets metadata), `fake-infra/schemas.ts` (control API), the
`check:boundaries` ast-grep rule, seed env schema added to `config.ts`, and
the ops event catalogue (events + data per actor, like ADR 0033). Stubs:
`backend.stub.ts`, `createOps` returning a no-op module. granary wiring in
`boot.ts` + Tracer → `telemetrySink` (behaviour unchanged via the OTLP seed).

## Then in parallel (four agents, disjoint files)
- **A. Backups**: ops.sqlite, secret store, snapshot Worker, object-store
  processor (s3 + local-dir), `backup-plan`, `backup-run`, `upload`,
  `retention`, `restore-drill`, `ops:restore` CLI.
- **B. Telemetry & alerting**: fan-out + redaction, `telemetry-sink`
  (otlp-http, loki-push), metrics generation, `watchdog`, `alert`,
  `notifier`, `heartbeat`, HostHealth provider in granary (the only granary
  file besides boot/tracing: a `health.ts` reading WAL/system counters).
- **C. fake-infra**: S3 fake with SigV4 + multipart, Loki, OTLP, hooks,
  pings, control API, page, pitchfork daemon, `/__dev/infra` area.
- **D. UI**: `/ops/**` pages against `backend.stub.ts`, JsonView for
  manifests/configs, "Can I sleep?" overview.

## Finally (one agent)
- Integration: real OpsBackend wired, harness extended with fake-infra,
  scenarios of ADR 0091, real-infra contract suite (`test:ops-real` under
  pitchfork-managed RustFS + otel-lgtm), runbook `docs/ops/runbook.md`
  (restore from scratch with only 1Password + bucket credentials).

## Milestones
1. M0 contract (day 1).
2. M1 "there is a backup": local-dir destination + hourly plan + manifest +
   CLI restore.
3. M2 "it's off-site": S3 destination, test connection, secrets, retention.
4. M3 "someone wakes me": watchdog, alerts, ntfy/webhook channels, heartbeat.
5. M4 "I can see it": telemetry sinks to Grafana, metrics, `/ops` overview.
6. M5 "I trust it": weekly restore drills, leak test, real-infra contract
   suite, runbook drill done once by a human.
