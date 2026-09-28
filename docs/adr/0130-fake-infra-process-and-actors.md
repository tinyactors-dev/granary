# 130. fake-infra: process, System and actors

Date: 2026-09-28 · Status: accepted · Implements 90/103 (fake-infra part)

## Decision
`fake-infra/` is a separate Bun process (`fake-infra/server.ts`) with its own
tinyactors System (`system.ts`), one actor per file in `fake-infra/actors/`:

| Address | Role |
|---|---|
| `settings/main` | R2 fidelity toggles, clock skew, exe proxy modes (ADR 132, 137) |
| `credentials/main` | S3 keys, exe.dev VM tokens, OTLP bearer tokens (ADR 133) |
| `faults/main` | injected faults with budgets (ADR 134) |
| `collector/main` | received OTLP batches (ADR 135) |
| `bucket/<name>` | one bucket: object metadata, multipart uploads, quota, write rules (ADR 131) |

HTTP handlers talk to actors with the `reply` I/O processor copied from
fake-github (`ask(system, address, event, data)` → the actor's `reply`), so
the fake stays independent of fake-github. Object bytes are *not* actor data:
they live in `blobs.ts` (in memory, synthetic zero-filled blobs for seeded
objects); actors hold blob ids. Observation (request log, counters, SSE) is
outside the actors (`events.ts`, ADR 136). Traces are exported with
`service.name=fake-infra` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Consequences
Memory-only: large uploads cost RAM (fine for dev/test sizes). `POST
/__control/reset` destroys every actor and blob and re-applies dev seeds.
