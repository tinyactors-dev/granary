# Operations system

> The purpose of this system is to let you sleep at night:
> backups and telemetry keep flowing on their own, the system heals what it
> can, and whatever it can't fix waits — explained — for your next visit.
> **Nothing ever wakes you.**

`src/lib/ops/` is a separate domain module inside the granary app process on
an **exe.dev VM in FRA (EU)**. It backs up the SQLite databases (always encrypted) to
**Cloudflare R2 (EU jurisdiction bucket)** with a hard size bound, exports telemetry over OTLP to a
**self-hosted Grafana (otel-lgtm) on a second exe.dev VM, also FRA**, and runs a
watchdog that is a control loop, not an alarm. Everything is configured in
the product (`/ops`); env vars only seed. **Status: planned.**

## Topology

```
 exe.dev VM "granary", region FRA (public proxy port = granary, for GitHub webhooks)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ granary System (issues)            │ ops System (service.name=granary-ops)            │
 │                                    │                                                  │
 │ Tracer ── TelemetryBatch ──────────┼─▶ fan-out · redaction · sampling ─▶ telemetry-sink/<id>
 │                                    │                                         │ OTLP/HTTP  │
 │ WAL/relay/system ── health() ──────┼─▶ watchdog/main ─▶ condition/<id> ─remediate─▶ remediator/main
 │                                    │                         │ attention → banner, /ops, Grafana
 │ granary.sqlite ◀─ VACUUM INTO ─────┼── snapshot Worker ◀── backup-run/<run> ◀─tick─ backup-plan/<plan>
 │   (raw snapshot in spool, ~1× DB)  │   └─ zstd → AES-256-GCM, streamed ─▶ upload/<run>.<dest> ─┐
 │ OpsHost ports / OpsModule          │ ops-config/main · retention/<dest> · restore-drill/<dest>  │
 │ /ops UI + banner ─ OpsBackend ─────┼─ ops.sqlite (config, envelope-encrypted secrets, runs,     │
 │                                    │               conditions, ops_events, admin_visits)       │
 └────────────────────────────────────┴───────────────────────────────────────────────────┼────┘
        │ http://grafana-otlp.int.exe.xyz  (exe.dev peer integration: key injected        │ S3 API (billed egress)
        │  at the edge, granary stores no credential; VM↔VM traffic is not billed)        ▼
        ▼                                                          Cloudflare R2, EU jurisdiction
 exe.dev VM "granary-grafana" (FRA): grafana/otel-lgtm              <account>.eu.r2.cloudflarestorage.com
   :4318 OTLP (private) → Loki · Tempo · Prometheus                  region auto, bucket-scoped Object R&W token
   :3000 Grafana UI (private, exe.dev login)                         caps: ≤ 82 backups/db, ≤ 8 GiB
```

## A backup, step by step
1. `backup-plan/<plan>` ticks (hourly, stretched automatically if R2 upload
   egress — the only billed traffic — would exceed 20 GiB/month) → commits a run row → `backup-run/<run>`.
2. Snapshot Worker: `VACUUM INTO` the spool → `integrity_check` → row counts.
3. `retention/<dest>` makes room first (caps always hold).
4. `upload/<run>.<dest>`: stream zstd → AES-256-GCM (per-artifact key wrapped
   by `OPS_MASTER_KEY`) straight into an R2 multipart upload; then PUT the
   manifest with `If-None-Match: *` — the manifest is the create-once commit
   marker. Crashes resume idempotently.
5. Raw snapshot deleted; at most one local copy kept if the disk allows.
6. Weekly `restore-drill/<dest>` proves the newest backup restores.

## When something goes wrong
The watchdog tries a fix first (clean spool, drop local copy, WAL
checkpoint, postpone, retry, stretch interval, re-run drill, reset sink
circuit). Only if the problem persists past its grace period does it become
an **attention** item: a banner on your next visit to the admin UI, a line on
`/ops`, and a metric/log in Grafana. No email, no push, no heartbeat.

## Restoring (runbook sketch)
You need: `OPS_MASTER_KEY` (1Password item `granary`) and an R2 token.
`mise run ops:restore -- --dest seed:r2 --latest --out granary.sqlite`.
Full runbook: `docs/ops/runbook.md`; exe.dev setup: `docs/ops/exe-dev.md`
(both milestone M5).

## Decisions
Current:
- [0080 Module boundary & contract](../adr/0080-ops-domain-module-boundary.md)
- [0081 Process & System placement](../adr/0081-ops-process-and-system-placement.md) (heartbeat part superseded by 0100)
- [0082 Actor & I/O topology, crash semantics](../adr/0082-ops-actor-and-io-topology.md) + [0101 revision: self-healing](../adr/0101-ops-topology-revision-self-healing.md)
- [0083 Backup method: VACUUM INTO in a Worker](../adr/0083-backup-method-vacuum-into-in-a-worker.md) + [0098 exe.dev resources & staging](../adr/0098-production-on-exe-dev-resources-and-staging.md)
- [0084 Object storage](../adr/0084-object-storage-destinations.md) + [0095 R2](../adr/0095-r2-backup-destination.md) + [0096 Bounded retention](../adr/0096-bounded-retention.md)
- [0085 Telemetry: OTLP first](../adr/0085-telemetry-sinks-otlp-first.md) + [0099 Grafana on exe.dev](../adr/0099-telemetry-to-self-hosted-grafana-on-exe-dev.md)
- [0086 Secret store](../adr/0086-ops-secret-store.md) + [0097 Encryption is mandatory](../adr/0097-backup-encryption-mandatory.md)
- [0089 Durable state](../adr/0089-ops-durable-state.md) (tables revised in 0101)
- [0090 fake-infra](../adr/0090-fake-infra.md) + [0091 Test strategy](../adr/0091-ops-test-strategy.md) + [0103 revision](../adr/0103-ops-tests-and-fake-infra-revision.md)
- [0092 UI & OpsBackend seam](../adr/0092-ops-ui-and-backend-seam.md) + [0104 revision](../adr/0104-ops-ui-revision.md)
- [0093 Feedback loops & redaction](../adr/0093-telemetry-feedback-loops-and-redaction.md)
- [0100 No paging: self-heal, wait until morning](../adr/0100-no-paging-problems-wait-until-morning.md)
- [0102 Configuration & seeds](../adr/0102-ops-configuration-and-seeds-revision.md)
- [0105 Implementation plan](../adr/0105-ops-implementation-plan-revision.md) + [0109 M0 scope](../adr/0109-m0-scope-clarifications.md) + [0110 composition seam & ownership](../adr/0110-m0-composition-seam-and-ownership.md)
- [0106 EU region & R2 jurisdiction](../adr/0106-eu-region-and-r2-jurisdiction.md)
- [0107 Egress accounting](../adr/0107-egress-accounting.md)
- [0108 Confirmed defaults & contract tests](../adr/0108-confirmed-defaults-and-contract-tests.md)

Superseded: [0087](../adr/0087-in-product-configuration-and-seed-env.md) → 0102,
[0088](../adr/0088-watchdog-signals-and-alerting.md) → 0100,
[0094](../adr/0094-ops-implementation-plan.md) → 0105.

## Budgets (confirmed, ADR 0108)
| Budget | Default | Counts |
|---|---|---|
| R2 retention per destination | 8 GiB, 82 backups per database | sealed artifacts + manifests |
| R2 upload egress (billed by exe.dev) | 20 GiB / month | every byte uploaded to R2 |
| Telemetry volume (Grafana VM disk) | 5 GiB / month | OTLP bytes to the Grafana VM (VM↔VM, not billed) |

Region: both VMs in exe.dev **FRA**; R2 bucket in the **EU jurisdiction**
(ADR 0106). Contract tests for the exe.dev proxy and R2 conditional
presigned PUT are agreed (ADR 0108).

## Open questions
None blocking. Contract-test results (ADR 0108) may flip the manifest write
to HEAD-then-PUT or the telemetry auth to the VM-token mode.
