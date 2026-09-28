# ops — the operations domain module

Backups to Cloudflare R2 (EU), telemetry to self-hosted Grafana on exe.dev,
and a self-healing watchdog. Plan: [docs/ops/README.md](../../../docs/ops/README.md),
ADRs 0080–0110.

**Boundary** (enforced by `mise run check:boundaries`): granary imports only
`$lib/ops/contract`; `src/lib/server/boot.ts` and `src/hooks.server.ts` may
also import `$lib/ops/index`. Ops imports no granary internals (only
`src/lib/schemas/standard.ts`), no SvelteKit.

| Path | What |
|---|---|
| `contract.ts` | the granary↔ops seam: OpsHost, OpsModule, TelemetrySink/Source, OpsBackend (+ registry), re-exports all DTO schemas |
| `schemas/*` | TypeBox: common, env, destinations (r2/s3/local-dir), plans, sinks, budgets, secrets, manifest, runs, conditions, host, status, api, events (actor catalogue) |
| `db/ddl.ts`, `db/open.ts` | ops.sqlite baseline migration, row schemas, opener |
| `feature.ts` | ops-internal composition seam (OpsFeature, SecretReader, Redactor) |
| `index.ts` | `createOps` (composes the features) + `createStubOpsBackend` |
| `backend.stub.ts` | realistic in-memory OpsBackend for UI work |
| `features/backups.ts`, `actors/{ops-config,backup-plan,backup-run,upload,retention,restore-drill}.ts`, `io/{snapshot,object-store}.ts`, `secrets/`, `backend/backups.ts`, `cli/` | backups |
| `backups/` | backups internals: repo, runtime, seal (zstd + AES-GCM), stores, retention planner, restore, worker client, disk rule, test connection, remediations (ADR 0111–0118) |
| `features/health.ts`, `actors/{telemetry-sink,watchdog,condition,remediator}.ts`, `io/{otlp,remediate}.ts`, `telemetry/`, `backend/{health,index}.ts`, `system.ts` | telemetry & self-healing |

One file per actor in `actors/`; side effects only in `io/`.
