# Operations system

> The purpose of this system is to let you sleep at night.

`src/lib/ops/` is a separate domain module inside the granary app process.
It backs up the SQLite databases, ships the backups off-site, exports
telemetry to Grafana (Loki / Tempo / Prometheus), watches everything that can
go wrong, and wakes a human — or, if the whole box is gone, lets an external
dead-man's switch do it. Everything is configured in the product (`/ops`);
env vars only seed. **Status: planned** — see the ADRs below.

## Topology

```
                      granary process
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │  granary System (issues)             │  ops System (service.name=granary-ops)  │
 │                                      │                                         │
 │  Tracer ── TelemetryBatch ───────────┼──▶ fan-out + redaction ──▶ telemetry-sink/<id> ──(otlp|loki)──▶ Grafana / Alloy / Loki
 │  WAL/relay/system ── health() ───────┼──▶ watchdog/main ──signal.sample──▶ alert/<rule>              │
 │  granary.sqlite ◀── VACUUM INTO ─────┼── snapshot Worker ◀─(snapshot)── backup-run/<run>           │  notifier/<ch> ──(notify)──▶ ntfy/Slack/webhook
 │                                      │        ▲                    │ invoke per dest             │  heartbeat/main ─(heartbeat)─▶ healthchecks.io
 │        OpsHost ports ────────────────┼▶ backup-plan/<plan> (tick) │                             │
 │        OpsModule.status()/backend ◀──┼── ops-config/main           ▼                             │
 │                                      │                     upload/<run>.<dest> ──(object-store)──▶ S3 / R2 / B2 / local-dir
 │  /ops UI ── ops.remote.ts ── OpsBackend (writes ops.sqlite, then config.changed)                  │
 │                                      │  retention/<dest>, restore-drill/<dest> ──(object-store)──▶ same │
 └───────────────────────────────────────────────────────────────────────────────┘
      ops.sqlite: config, secrets (envelope-encrypted, KEK = OPS_MASTER_KEY from fnox),
                  runs, uploads, drills, alert state, notification outbox
```

## A backup, step by step
1. `backup-plan/<plan>` ticks → commits a `backup_runs` row → mails
   `backup-run/<run>` (virtual actor, loader-backed).
2. `snapshot` processor → Worker: `VACUUM INTO` spool → `integrity_check` →
   row counts → zstd → AES-256-GCM (per-artifact DEK wrapped by the KEK) →
   sha256s → manifest.
3. One `upload/<run>.<dest>` per destination: PUT data (multipart via
   `Bun.S3Client`) → `stat` → PUT `…manifest.json` (**the commit marker**)
   → done. Crash anywhere resumes idempotently (ADR 0082).
4. Weekly `restore-drill/<dest>` proves the newest backup restores.

## Restoring (runbook sketch)
You need: `OPS_MASTER_KEY` (1Password item `granary`) and bucket credentials.
`mise run ops:restore -- --dest <id|s3-url> --latest --out granary.sqlite`
downloads the newest manifest+artifact, verifies, decrypts, decompresses and
runs `integrity_check`. Full runbook: `docs/ops/runbook.md` (milestone M5).

## Decisions
- [0080 Module boundary & contract](../adr/0080-ops-domain-module-boundary.md)
- [0081 Process & System placement](../adr/0081-ops-process-and-system-placement.md)
- [0082 Actor & I/O topology, crash semantics](../adr/0082-ops-actor-and-io-topology.md)
- [0083 Backup method: VACUUM INTO in a Worker](../adr/0083-backup-method-vacuum-into-in-a-worker.md)
- [0084 Object storage destinations](../adr/0084-object-storage-destinations.md)
- [0085 Telemetry sinks: OTLP first](../adr/0085-telemetry-sinks-otlp-first.md)
- [0086 Secret store](../adr/0086-ops-secret-store.md)
- [0087 In-product configuration & seed env](../adr/0087-in-product-configuration-and-seed-env.md)
- [0088 Watchdog signals & alerting](../adr/0088-watchdog-signals-and-alerting.md)
- [0089 Ops durable state](../adr/0089-ops-durable-state.md)
- [0090 fake-infra](../adr/0090-fake-infra.md)
- [0091 Test strategy](../adr/0091-ops-test-strategy.md)
- [0092 UI & OpsBackend seam](../adr/0092-ops-ui-and-backend-seam.md)
- [0093 Feedback loops & redaction](../adr/0093-telemetry-feedback-loops-and-redaction.md)
- [0094 Implementation plan](../adr/0094-ops-implementation-plan.md)

## Open questions
- Which object store (R2 / B2 / S3 / Hetzner) and which Grafana (Cloud or self-hosted)?
- Which phone-waking channel: ntfy, Pushover, Slack, Grafana OnCall?
- RPO target (default hourly backups) and retention defaults — OK?
- Should backup encryption be mandatory (proposed: yes)?
- Where does granary run in production (volume size informs disk thresholds)?
